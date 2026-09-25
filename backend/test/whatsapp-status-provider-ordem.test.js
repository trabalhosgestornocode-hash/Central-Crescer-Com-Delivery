// Recibos de entrega pela ROTA ASSINADA (HMAC) com o repo em memória — ordem, idempotência, isolamento, 400 sem eco e resposta sem segredo.
// Complementa (não repete) whatsapp-gateway-routes.test.js (fluxo básico SENT->DELIVERED->READ, 400 por código, cross-tenant) e
// whatsapp-status-provider-org.test.js (org do registro). Aqui: garantias de TIMESTAMP da 095, eco/segredo e SERVER_ACK em todos os estados.
// O que a 095 garante (database/migrations/095, espelhado no repo em memória): entregue_em = coalesce(entregue_em, ts) — READ direto preenche os DOIS
// com o mesmo ts; evento repetido/atrasado NUNCA altera status nem timestamps já gravados. Não se afirma mais que isso.
import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { exigirHmac, assinarRequisicao, _resetarNonces } from "../src/modules/comunicacao/gateway/whatsappGateway.hmac.js";
import { criarWhatsappGatewayRouter } from "../src/modules/comunicacao/gateway/whatsappGateway.routes.js";
import { criarRepoEmMemoria } from "../src/modules/comunicacao/gateway/whatsappGateway.repo.js";

const SEGREDO = "s3gred0-hmac-".padEnd(40, "x");
const ORG = "org-conexao";
const URL_STATUS = "/internal/comunicacao/eventos/status-provider";
const T1 = "2026-09-25T10:00:00.000Z";
const T2 = "2026-09-25T10:05:00.000Z";
const T3 = "2026-09-25T10:10:00.000Z";

describe("status-provider — ordem, idempotência e isolamento pela rota assinada", () => {
  let servidor, base, repo;
  before(async () => {
    repo = criarRepoEmMemoria();
    const app = express();
    app.use("/internal/comunicacao", express.raw({ type: "*/*", limit: 256 * 1024 }), exigirHmac(SEGREDO), criarWhatsappGatewayRouter({ repo, organizacaoId: ORG }));
    await new Promise((r) => { servidor = createServer(app).listen(0, r); });
    base = `http://127.0.0.1:${servidor.address().port}`;
  });
  after(() => servidor.close());

  async function post(corpoObj) {
    _resetarNonces();
    const corpo = JSON.stringify(corpoObj);
    const headers = { ...assinarRequisicao({ segredo: SEGREDO, metodo: "POST", caminho: URL_STATUS, corpo }), "Content-Type": "application/json" };
    return fetch(`${base}${URL_STATUS}`, { method: "POST", headers, body: corpo });
  }
  const ev = (id, status, extra = {}) => ({ contratoStatus: 1, providerMessageId: id, status, ...extra });
  const enviar = async (id, status, extra) => { const r = await post(ev(id, status, extra)); assert.equal(r.status, 200); return (await r.json()).resultado; };
  const msg = (id, org = ORG) => repo._mensagem(org, id);

  test("SENT -> DELIVERED -> READ: cada passo grava SÓ o seu timestamp (entregue_em no DELIVERED, lido_em no READ) e preserva o anterior", async () => {
    repo._semearMensagem(ORG, { providerMessageId: "O1", status: "SENT" });
    assert.equal(await enviar("O1", "DELIVERED", { ocorridoEm: T1 }), "APLICADO");
    assert.deepEqual([msg("O1").status, msg("O1").entregueEm, msg("O1").lidoEm], ["DELIVERED", T1, null]);
    assert.equal(await enviar("O1", "READ", { ocorridoEm: T2 }), "APLICADO");
    assert.deepEqual([msg("O1").status, msg("O1").entregueEm, msg("O1").lidoEm], ["READ", T1, T2]);
    assert.ok(Date.parse(msg("O1").entregueEm) <= Date.parse(msg("O1").lidoEm));
  });

  test("READ ANTES de DELIVERED, DELIVERED tardio: continua READ; READ direto preenche entregue_em = lido_em (nunca entregue_em > lido_em); o tardio não altera timestamps", async () => {
    repo._semearMensagem(ORG, { providerMessageId: "O2", status: "SENT" });
    assert.equal(await enviar("O2", "READ", { ocorridoEm: T2 }), "APLICADO");
    assert.deepEqual([msg("O2").status, msg("O2").entregueEm, msg("O2").lidoEm], ["READ", T2, T2]);
    // DELIVERED atrasado, com carimbo ANTERIOR e depois com carimbo POSTERIOR: nada muda
    assert.equal(await enviar("O2", "DELIVERED", { ocorridoEm: T1 }), "DUPLICADO");
    assert.equal(await enviar("O2", "DELIVERED", { ocorridoEm: T3 }), "DUPLICADO");
    assert.deepEqual([msg("O2").status, msg("O2").entregueEm, msg("O2").lidoEm], ["READ", T2, T2]);
    assert.ok(Date.parse(msg("O2").entregueEm) <= Date.parse(msg("O2").lidoEm));
  });

  test("eventos duplicados são idempotentes: repetir DELIVERED/READ com OUTRO carimbo não muda status nem timestamps", async () => {
    repo._semearMensagem(ORG, { providerMessageId: "O3", status: "SENT" });
    await enviar("O3", "DELIVERED", { ocorridoEm: T1 }); await enviar("O3", "READ", { ocorridoEm: T2 });
    const antes = { ...msg("O3") };
    for (let i = 0; i < 3; i++) {
      assert.equal(await enviar("O3", "DELIVERED", { ocorridoEm: T3 }), "DUPLICADO");
      assert.equal(await enviar("O3", "READ", { ocorridoEm: T3 }), "DUPLICADO");
    }
    assert.deepEqual(msg("O3"), antes);
  });

  test("id desconhecido nunca altera outra mensagem (mesmo com id parecido/prefixo/sufixo), em nenhuma org", async () => {
    repo._semearMensagem(ORG, { providerMessageId: "REAL1", status: "SENT" });
    repo._semearMensagem("outra-org", { providerMessageId: "REAL1-OUTRA", status: "SENT" });
    for (const id of ["REAL", "REAL12", "real1", "XREAL1", "REAL1-", "REAL1-OUTR"]) for (const st of ["DELIVERED", "READ", "SERVER_ACK"]) assert.equal(await enviar(id, st), "NAO_ENCONTRADA", `${id}/${st}`);
    assert.equal(await enviar("DESCONHECIDO", "PROVIDER_ERROR", { erroCodigo: "479" }), "NAO_ENCONTRADA");
    assert.deepEqual(msg("REAL1"), { status: "SENT", entregueEm: null, lidoEm: null, servidorEm: null, erroCodigo: null });
    assert.deepEqual(msg("REAL1-OUTRA", "outra-org"), { status: "SENT", entregueEm: null, lidoEm: null, servidorEm: null, erroCodigo: null });
  });

  test("SERVER_ACK NUNCA muda o status (SENT/DELIVERED/READ) nem entregue_em/lido_em; só registra servidor_em, uma vez; estados fora da cadeia => ESTADO_NAO_ELEGIVEL", async () => {
    for (const st of ["SENT", "DELIVERED", "READ"]) {
      const id = `ACK-${st}`;
      repo._semearMensagem(ORG, { providerMessageId: id, status: st });
      assert.equal(await enviar(id, "SERVER_ACK", { ocorridoEm: T1 }), "ACK_REGISTRADO", st);
      assert.equal(await enviar(id, "SERVER_ACK", { ocorridoEm: T2 }), "DUPLICADO", st);
      assert.deepEqual(msg(id), { status: st, entregueEm: null, lidoEm: null, servidorEm: T1, erroCodigo: null }, st);
    }
    for (const st of ["SENDING", "FAILED", "CANCELLED", "DELIVERY_UNKNOWN"]) {
      const id = `ACK-${st}`;
      repo._semearMensagem(ORG, { providerMessageId: id, status: st });
      assert.equal(await enviar(id, "SERVER_ACK"), "ESTADO_NAO_ELEGIVEL", st);
      assert.equal(msg(id).status, st);
    }
  });

  test("SERVER_ACK depois de READ (e PROVIDER_ERROR depois de DELIVERED) não regride nem avança o status", async () => {
    repo._semearMensagem(ORG, { providerMessageId: "O4", status: "SENT" });
    await enviar("O4", "READ", { ocorridoEm: T2 });
    await enviar("O4", "SERVER_ACK", { ocorridoEm: T3 });
    assert.equal(msg("O4").status, "READ");
    repo._semearMensagem(ORG, { providerMessageId: "O5", status: "DELIVERED" });
    assert.equal(await enviar("O5", "PROVIDER_ERROR", { erroCodigo: "479" }), "ERRO_REGISTRADO");
    assert.equal(msg("O5").status, "DELIVERED"); assert.equal(msg("O5").erroCodigo, "479");
  });

  test("dois ids da mesma conversa avançam de forma independente (um READ não contamina o vizinho)", async () => {
    repo._semearMensagem(ORG, { providerMessageId: "V1", status: "SENT" }); repo._semearMensagem(ORG, { providerMessageId: "V2", status: "SENT" });
    await enviar("V1", "READ", { ocorridoEm: T2 });
    assert.equal(msg("V2").status, "SENT");
    await enviar("V2", "DELIVERED", { ocorridoEm: T1 });
    assert.deepEqual([msg("V1").status, msg("V2").status, msg("V2").lidoEm], ["READ", "DELIVERED", null]);
  });
});

describe("status-provider — 400 sem eco e resposta sem segredo", () => {
  let servidor, base, repo;
  before(async () => {
    repo = criarRepoEmMemoria();
    const app = express();
    app.use("/internal/comunicacao", express.raw({ type: "*/*", limit: 256 * 1024 }), exigirHmac(SEGREDO), criarWhatsappGatewayRouter({ repo, organizacaoId: ORG }));
    await new Promise((r) => { servidor = createServer(app).listen(0, r); });
    base = `http://127.0.0.1:${servidor.address().port}`;
  });
  after(() => servidor.close());
  async function post(corpoObj) {
    _resetarNonces();
    const corpo = JSON.stringify(corpoObj);
    const headers = { ...assinarRequisicao({ segredo: SEGREDO, metodo: "POST", caminho: URL_STATUS, corpo }), "Content-Type": "application/json" };
    return fetch(`${base}${URL_STATUS}`, { method: "POST", headers, body: corpo });
  }

  test("400: a resposta é exatamente {error, campo} com campo de vocabulário fechado e NUNCA contém o valor malformado enviado", async () => {
    const ISCA = "ISCA_SECRETA_9f3a 55511999990000 <script>";
    const ok = { contratoStatus: 1, providerMessageId: "M1", status: "DELIVERED" };
    const corpos = [
      { ...ok, providerMessageId: ISCA }, { ...ok, status: ISCA }, { ...ok, ocorridoEm: ISCA }, { ...ok, ackTipo: ISCA },
      { ...ok, status: "PROVIDER_ERROR", erroCodigo: ISCA }, { ...ok, contratoStatus: ISCA }, { ...ok, erroCodigo: ISCA },
      { ...ok, [ISCA]: "x" }, { ...ok, organizacao_id: ISCA },
    ];
    const CAMPOS = new Set(["providerMessageId", "status", "ocorridoEm", "ackTipo", "erroCodigo", "contratoStatus", "campo_desconhecido", "erroCodigo_incoerente", "erroCodigo_ausente"]);
    for (const c of corpos) {
      const r = await post(c);
      const texto = await r.text();
      assert.equal(r.status, 400, texto);
      assert.equal(texto.includes("ISCA_SECRETA"), false, "não ecoa o valor");
      assert.equal(texto.includes("55511999990000"), false);
      assert.equal(texto.includes("script"), false);
      const j = JSON.parse(texto);
      assert.deepEqual(Object.keys(j).sort(), ["campo", "error"]);
      assert.equal(j.error, "status_provider_invalido");
      assert.ok(CAMPOS.has(j.campo), j.campo);
    }
  });

  test("400 para corpo que não é objeto (array/string/número/null) também sem eco, e nada é gravado", async () => {
    repo._semearMensagem(ORG, { providerMessageId: "M1", status: "SENT" });
    for (const c of [["ISCA_SECRETA"], "ISCA_SECRETA", 42, null]) {
      const r = await post(c);
      const texto = await r.text();
      assert.equal(r.status, 400, JSON.stringify(c));
      assert.equal(texto.includes("ISCA_SECRETA"), false);
      assert.deepEqual(JSON.parse(texto), { error: "status_provider_invalido", campo: "corpo_invalido" });
    }
    assert.equal(repo._mensagem(ORG, "M1").status, "SENT");
  });

  test("resposta de sucesso é exatamente {ok, resultado}: sem segredo HMAC, assinatura, organizacaoId, providerMessageId ou dados da mensagem", async () => {
    repo._semearMensagem(ORG, { providerMessageId: "M2", status: "SENT" });
    for (const [id, st] of [["M2", "DELIVERED"], ["M2", "DELIVERED"], ["NAO_EXISTE", "READ"]]) {
      const corpo = JSON.stringify({ contratoStatus: 1, providerMessageId: id, status: st });
      _resetarNonces();
      const headers = { ...assinarRequisicao({ segredo: SEGREDO, metodo: "POST", caminho: URL_STATUS, corpo }), "Content-Type": "application/json" };
      const r = await fetch(`${base}${URL_STATUS}`, { method: "POST", headers, body: corpo });
      const texto = await r.text();
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(JSON.parse(texto)).sort(), ["ok", "resultado"]);
      const tudo = texto + JSON.stringify([...r.headers.entries()]);
      assert.equal(tudo.includes(SEGREDO), false, "segredo HMAC");
      for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() !== "content-type" && String(v).length >= 16) assert.equal(tudo.includes(String(v)), false, "assinatura/nonce não voltam na resposta");
      assert.equal(texto.includes(ORG), false, "organizacaoId");
      assert.equal(texto.includes("M2"), false, "providerMessageId");
    }
  });

  test("sem assinatura ou com assinatura de OUTRO segredo => 401 e a mensagem NÃO muda", async () => {
    repo._semearMensagem(ORG, { providerMessageId: "M3", status: "SENT" });
    const corpo = JSON.stringify({ contratoStatus: 1, providerMessageId: "M3", status: "READ" });
    const sem = await fetch(`${base}${URL_STATUS}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: corpo });
    _resetarNonces();
    const errada = await fetch(`${base}${URL_STATUS}`, { method: "POST", headers: { ...assinarRequisicao({ segredo: "outro-segredo".padEnd(40, "y"), metodo: "POST", caminho: URL_STATUS, corpo }), "Content-Type": "application/json" }, body: corpo });
    assert.equal(sem.status, 401); assert.equal(errada.status, 401);
    assert.equal((await errada.text()).includes(SEGREDO), false);
    assert.equal(repo._mensagem(ORG, "M3").status, "SENT");
  });
});
