// ifoodFinancial.mapper.js — normalização PURA de Reconciliation +
// Reconciliation On Demand + parse do arquivo baixado. Sem rede, sem banco.
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

const {
  mapearRespostaReconciliation, mapearRespostaReconciliationSolicitada, mapearRespostaReconciliationStatus,
  parsearArquivoConciliacao,
} = await import("../src/modules/ifood/ifoodFinancial.mapper.js");

// --- Reconciliation (GET, síncrona) ---------------------------------------

const ENVELOPE_RECONCILIATION = {
  downloadPath: "https://exemplo.s3.amazonaws.com/arquivo.csv?X-Amz-Signature=segredo",
  createdAt: "2024-03-19T17:45:52Z",
  metadata: { total_pedido_associado_ifood: "436", sha256: "abc123", total_linhas: "1836", total_codigo_transacao: "7" },
};

test("mapearRespostaReconciliation: envelope ARRAY (Swagger) é desembrulhado", () => {
  const r = mapearRespostaReconciliation([ENVELOPE_RECONCILIATION]);
  assert.equal(r.downloadPath, ENVELOPE_RECONCILIATION.downloadPath);
  assert.equal(r.criadoEm, "2024-03-19T17:45:52Z");
});

test("mapearRespostaReconciliation: metadata snake_case -> campos PT, números convertidos", () => {
  const r = mapearRespostaReconciliation(ENVELOPE_RECONCILIATION);
  assert.deepEqual(r.metadados, { totalPedidosAssociadosIfood: 436, sha256: "abc123", totalLinhas: 1836, totalCodigoTransacao: 7 });
});

test("mapearRespostaReconciliation: sem metadata -> metadados null, sem lançar", () => {
  const r = mapearRespostaReconciliation({ downloadPath: null, createdAt: null });
  assert.equal(r.metadados, null);
});

// --- Reconciliation On Demand — POST (solicitação) ------------------------

test("mapearRespostaReconciliationSolicitada: extrai requestId e competencia", () => {
  const r = mapearRespostaReconciliationSolicitada({ competence: "2025-07", merchantId: "m1", requestId: "req-1" });
  assert.deepEqual(r, { requestId: "req-1", competencia: "2025-07" });
});

// --- Reconciliation On Demand — GET status (os 4 valores confirmados) -----

test("status 'created': sem downloadPath, sem mensagemErro", () => {
  const r = mapearRespostaReconciliationStatus({ id: "r1", status: "created", merchantId: "m1", competence: "2025-07" });
  assert.equal(r.status, "created");
  assert.equal(r.downloadPath, null);
  assert.equal(r.mensagemErro, null);
});

test("status 'enqueue': sem downloadPath", () => {
  const r = mapearRespostaReconciliationStatus({ id: "r1", status: "enqueue", competence: "2025-07" });
  assert.equal(r.status, "enqueue");
  assert.equal(r.downloadPath, null);
});

test("status 'processed': TEM downloadPath", () => {
  const r = mapearRespostaReconciliationStatus({ id: "r1", status: "processed", competence: "2025-07", downloadPath: "https://s3.../arquivo.csv?X-Amz-Signature=x" });
  assert.equal(r.status, "processed");
  assert.ok(r.downloadPath);
});

test("status 'error': tem mensagemErro, sem downloadPath", () => {
  const r = mapearRespostaReconciliationStatus({ id: "r1", status: "error", competence: "2025-07", message: "No financial entries found." });
  assert.equal(r.status, "error");
  assert.equal(r.mensagemErro, "No financial entries found.");
  assert.equal(r.downloadPath, null);
});

// --- parsearArquivoConciliacao — CSV puro e gzip ---------------------------

test("CSV puro, delimitador vírgula: colunas + linhas corretas", () => {
  const csv = "pedido,valor,tipo\n123,45.00,VENDA\n456,-5.00,CANCELAMENTO\n";
  const r = parsearArquivoConciliacao(Buffer.from(csv, "utf8"));
  assert.deepEqual(r.colunas, ["pedido", "valor", "tipo"]);
  assert.equal(r.linhas.length, 2);
  assert.deepEqual(r.linhas[0], { pedido: "123", valor: "45.00", tipo: "VENDA" });
  assert.equal(r.eraGzip, false);
  assert.equal(r.delimitador, ",");
});

test("CSV com ponto-e-vírgula: delimitador detectado automaticamente", () => {
  const csv = "pedido;valor;tipo\n123;45,00;VENDA\n";
  const r = parsearArquivoConciliacao(Buffer.from(csv, "utf8"));
  assert.deepEqual(r.colunas, ["pedido", "valor", "tipo"]);
  assert.deepEqual(r.linhas[0], { pedido: "123", valor: "45,00", tipo: "VENDA" });
  assert.equal(r.delimitador, ";");
});

test("CSV com campo entre aspas contendo o delimitador: não quebra a coluna", () => {
  const csv = 'pedido,descricao,valor\n123,"Combo, com batata",45.00\n';
  const r = parsearArquivoConciliacao(Buffer.from(csv, "utf8"));
  assert.deepEqual(r.linhas[0], { pedido: "123", descricao: "Combo, com batata", valor: "45.00" });
});

test("gzip: descompactado corretamente, eraGzip=true, magic bytes (não a extensão da URL) decide", () => {
  const csv = "pedido,valor\n1,10.00\n";
  const gz = zlib.gzipSync(Buffer.from(csv, "utf8"));
  const r = parsearArquivoConciliacao(gz);
  assert.equal(r.eraGzip, true);
  assert.deepEqual(r.colunas, ["pedido", "valor"]);
  assert.equal(r.linhas.length, 1);
});

test("arquivo vazio: colunas/linhas vazias, sem lançar", () => {
  const r = parsearArquivoConciliacao(Buffer.from("", "utf8"));
  assert.deepEqual(r, { colunas: [], linhas: [], totalLinhas: 0, truncado: false, eraGzip: false, delimitador: null });
});

test("só cabeçalho, sem linhas de dado: totalLinhas 0", () => {
  const r = parsearArquivoConciliacao(Buffer.from("pedido,valor\n", "utf8"));
  assert.deepEqual(r.colunas, ["pedido", "valor"]);
  assert.equal(r.totalLinhas, 0);
});

test("gzip corrompido (magic bytes sem corpo válido) lança erro claro, não trava", () => {
  const falsoGzip = Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02]);
  assert.throws(() => parsearArquivoConciliacao(falsoGzip), /gzip/i);
});
