// doc 37 — importação pela plataforma SEM GUARDAR o arquivo: cofre temporário em memória (prévia → confirmação), base64
// estrito, lista fechada de relatórios, expiração com reenvio idempotente. Dados SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { CONSULTAS } from "../../src/modules/fv2-integracao/consultas.js";
import { criarCofreTemporario } from "../../src/modules/fv2-integracao/cofreTemporario.js";
import { ORG_A, UNI_A, UNI_A2, ctx, montar, rejeita } from "./helpers/cenario.js";
import { unicredExtrato } from "./helpers/arquivos.js";

const c = ctx();
const base64 = (bytes) => Buffer.from(bytes).toString("base64");

test("cofre temporário: só memória, por escopo, com validade e limite; nada é listado nem sobrevive à validade", async () => {
  let agora = 0;
  const cofre = criarCofreTemporario({ validadeMs: 1000, limitePorArquivo: 10, limiteTotal: 20, agora: () => agora });
  const A = { organizacaoId: ORG_A, unidadeId: UNI_A };
  const B = { organizacaoId: ORG_A, unidadeId: UNI_A2 };
  const g = await cofre.guardar(A, { conteudo: new Uint8Array([1, 2, 3]), tipoMime: "text/csv" });
  assert.equal(g.semGuarda, true);
  assert.deepEqual([...(await cofre.ler(A, g.arquivoId)).conteudo], [1, 2, 3]);
  await rejeita(cofre.ler(B, g.arquivoId), CODIGO.NAO_ENCONTRADO); // outro escopo: não existe
  assert.deepEqual(await cofre.inventario(A), []);
  await rejeita(cofre.guardar(A, { conteudo: new Uint8Array(11), tipoMime: "text/csv" }), CODIGO.DOCUMENTO_INVALIDO);
  agora = 1001;
  await rejeita(cofre.ler(A, g.arquivoId), CODIGO.NAO_ENCONTRADO); // expirou
  // Limite total: o mais antigo sai primeiro.
  const x = await cofre.guardar(A, { conteudo: new Uint8Array(10).fill(1), tipoMime: "text/csv" });
  await cofre.guardar(A, { conteudo: new Uint8Array(10).fill(2), tipoMime: "text/csv" });
  await cofre.guardar(A, { conteudo: new Uint8Array(10).fill(3), tipoMime: "text/csv" });
  assert.equal(await cofre.existe(A, x.arquivoId), false);
});

test("importar pela rota sem guarda: prévia → confirmação; expirado pede reenvio, que cai na MESMA importação; relatório fora da lista é recusado", async () => {
  let agora = 0;
  const cofre = criarCofreTemporario({ validadeMs: 60000, agora: () => agora });
  const { nucleo: n } = montar({ cofre });
  const W = async (k, b) => ESCRITAS[k].fazer(n, c, b);
  const arquivo = unicredExtrato({ saldoInicial: 10000, lancamentos: [{ data: "02/09/2026", historico: "PIX RECEBIDO SINTETICO", valor: 5000 }, { data: "03/09/2026", historico: "TARIFA SINTETICA", valor: -1000 }] });
  const corpo = { tipoRelatorio: "UNICRED_EXTRATO", periodoInicio: "2026-09-01", periodoFim: "2026-09-30", arquivoBase64: base64(arquivo), nomeArquivo: "extrato.csv", tipoMime: "text/csv" };
  await rejeita(W("/importacao/receber", { ...corpo, tipoRelatorio: "IFOOD_APURACAO" }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(W("/importacao/receber", { ...corpo, arquivoBase64: "não é base64!" }), CODIGO.ENTRADA_INVALIDA);
  const r = await W("/importacao/receber", corpo);
  assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR");
  assert.equal(r.importacao.documentoId !== null, true);
  agora = 61000; // passou da validade: a confirmação pede o reenvio
  await rejeita(W("/importacao/confirmar", { importacao: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia }), CODIGO.NAO_ENCONTRADO);
  const de_novo = await W("/importacao/receber", corpo);
  assert.deepEqual([de_novo.repetido, de_novo.importacao.id], [true, r.importacao.id], "o mesmo arquivo é a mesma importação");
  const conf = await W("/importacao/confirmar", { importacao: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? { aceitarPendencias: true, justificativa: "Sintético." } : {}) });
  assert.equal(conf.importacao.estado, "IMPORTADO");
  assert.equal((await n.listarRegistrosImportados(c, { importacaoId: r.importacao.id })).length, 2);
  // O catálogo da plataforma anuncia o envio real, sem guarda, só com os relatórios conferidos com arquivo real.
  const cat = CONSULTAS["/conferencias/catalogo"]();
  assert.equal(cat.envioReal, true);
  assert.deepEqual(cat.relatorios.map((x) => x.tipoRelatorio).sort(), ["SAIPOS_DESEMPENHO_POR_ATENDENTE", "SAIPOS_FATURAMENTO_POR_DIA", "SAIPOS_FORMAS_PAGAMENTO", "SAIPOS_VENDAS", "STONE_VENDAS", "UNICRED_EXTRATO"]);
  // Envio de documento avulso e verificação continuam indisponíveis (o cofre documental segue desligado).
  assert.throws(() => ESCRITAS["/documentos/enviar"].fazer(n, c, {}), (e) => e.codigoHttp === 503);
});

test("doc 38 — gerar propostas do extrato pela rota: a conta Unicred vem da unidade quando é única; sem ela, recusa; com ela, as movimentações são aplicáveis", async () => {
  const { nucleo: n } = montar({ cofre: criarCofreTemporario() });
  const W = async (k, b) => ESCRITAS[k].fazer(n, c, b);
  const arquivo = unicredExtrato({ saldoInicial: 10000, lancamentos: [{ data: "02/09/2026", historico: "PIX RECEBIDO SINTETICO", valor: 5000 }, { data: "03/09/2026", historico: "TARIFA SINTETICA", valor: -1000 }] });
  const r = await W("/importacao/receber", { tipoRelatorio: "UNICRED_EXTRATO", periodoInicio: "2026-09-01", periodoFim: "2026-09-30", arquivoBase64: base64(arquivo), nomeArquivo: "extrato.csv" });
  await W("/importacao/confirmar", { importacao: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? { aceitarPendencias: true, justificativa: "Sintético." } : {}) });
  await rejeita(W("/propostas/gerar", { importacao: r.importacao.id }), CODIGO.OPERACAO_INVALIDA); // sem conta Unicred
  const conta = await W("/configuracoes/conta/criar", { tipo: "BANCARIA", nome: "Unicred AF" });
  await W("/propostas/gerar", { importacao: r.importacao.id });
  const ps = await n.listarPropostas(c, { operacao: "MOVIMENTACAO_BANCARIA" });
  assert.equal(ps.length, 2);
  assert.ok(ps.every((p) => p.comando.contaId === conta.id));
  for (const p of ps) { await W("/propostas/aprovar", { proposta: p.id, justificativa: "Sintético." }); await W("/propostas/aplicar", { proposta: p.id }); }
  assert.equal((await n.consultarResumoFinanceiro(c, { competencia: "2026-09" })).fluxoDeCaixa.realizadoNaCompetencia.saidasCentavos, 1000);
});
