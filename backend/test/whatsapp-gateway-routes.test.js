// Testes de integração das rotas Gateway -> Backend
// (whatsappGateway.routes.js), com o repo em memória (a tabela real —
// whatsapp_conexoes — ainda não existe; migration 083 não foi aplicada em
// nenhum banco neste checkpoint) e o provider real fazendo o papel de
// receptor de "mensagem recebida".
import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { createServer } from "node:http";
import { exigirHmac, assinarRequisicao, _resetarNonces } from "../src/modules/comunicacao/gateway/whatsappGateway.hmac.js";
import { criarWhatsappGatewayRouter } from "../src/modules/comunicacao/gateway/whatsappGateway.routes.js";
import { criarRepoEmMemoria } from "../src/modules/comunicacao/gateway/whatsappGateway.repo.js";
import { criarBaileysGatewayProvider } from "../src/modules/comunicacao/providers/baileysGateway.provider.js";

const SEGREDO = "s".repeat(32);
const ORG_ID = "org-teste-1";

describe("whatsappGateway.routes — eventos Gateway -> Backend", () => {
  let servidor, baseUrl, repo, provider;

  before(async () => {
    repo = criarRepoEmMemoria();
    provider = criarBaileysGatewayProvider({ gatewayUrl: "http://unused.invalid", segredoHmac: SEGREDO });
    const app = express();
    app.use("/internal/comunicacao", express.raw({ type: "*/*", limit: 256 * 1024 }), exigirHmac(SEGREDO), criarWhatsappGatewayRouter({ repo, organizacaoId: ORG_ID, provider }));
    await new Promise((resolve) => { servidor = createServer(app).listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  });
  after(() => servidor.close());

  async function chamarAssinado(metodo, caminho, corpoObj) {
    const corpo = corpoObj === undefined ? "" : JSON.stringify(corpoObj);
    const headers = assinarRequisicao({ segredo: SEGREDO, metodo, caminho, corpo });
    if (corpo) headers["Content-Type"] = "application/json";
    return fetch(`${baseUrl}${caminho}`, { method: metodo, headers, body: corpo || undefined });
  }

  // Este describe compartilha UM `repo`/servidor entre todos os testes (ao
  // contrário de whatsapp-gateway-lease.test.js, que isola um repo por
  // teste) — então cada `adquirirLeaseDeTeste()` libera antes o que o
  // teste anterior deixou preso, senão o mecanismo de exclusão mútua
  // (correto, por desenho) bloquearia o setup dos testes seguintes.
  let leaseAtual = null;

  /** Adquire uma lease com um gatewayProcessId novo e devolve {gatewayProcessId, leaseEpoch} pronto para spread nas gravações fenced. */
  async function adquirirLeaseDeTeste() {
    if (leaseAtual) await liberarLeaseDeTeste(leaseAtual);
    const gatewayProcessId = randomUUID();
    _resetarNonces();
    const r = await chamarAssinado("POST", "/internal/comunicacao/lease/acquire", { gatewayProcessId, ttlMs: 45_000 });
    const corpo = await r.json();
    if (!corpo.acquired) throw new Error("adquirirLeaseDeTeste: falha ao adquirir lease no setup do teste");
    leaseAtual = { gatewayProcessId, leaseEpoch: corpo.leaseEpoch };
    return leaseAtual;
  }

  /** Libera uma lease adquirida por adquirirLeaseDeTeste — deixa o recurso livre para o próximo acquire. */
  async function liberarLeaseDeTeste(lease) {
    _resetarNonces();
    await chamarAssinado("POST", "/internal/comunicacao/lease/release", lease);
    if (leaseAtual?.gatewayProcessId === lease.gatewayProcessId) leaseAtual = null;
  }

  test("sem HMAC, tudo recusado com 401 (rota não vira API pública)", async () => {
    const r = await fetch(`${baseUrl}/internal/comunicacao/eventos/heartbeat`, { method: "POST" });
    assert.equal(r.status, 401);
  });

  test("lease/acquire com ttlMs fora da faixa permitida (Checkpoint C3.5-A) é rejeitado com 400 — nunca chega a chamar o repo", async () => {
    const casosInvalidos = [0, -1, 300_001, 999_999_999, Number.NaN, Number.POSITIVE_INFINITY];
    for (const ttlMs of casosInvalidos) {
      _resetarNonces();
      const r = await chamarAssinado("POST", "/internal/comunicacao/lease/acquire", { gatewayProcessId: "11111111-1111-1111-1111-111111111111", ttlMs });
      assert.equal(r.status, 400, `ttlMs=${ttlMs} deveria ter sido rejeitado`);
    }
  });

  test("lease/acquire com ttlMs nos limites da faixa (1 e 300000) é aceito", async () => {
    _resetarNonces();
    const r1 = await chamarAssinado("POST", "/internal/comunicacao/lease/acquire", { gatewayProcessId: "22222222-2222-2222-2222-222222222222", ttlMs: 1 });
    assert.equal(r1.status, 200);
    const corpo1 = await r1.json();
    assert.equal(corpo1.acquired, true);
    leaseAtual = { gatewayProcessId: "22222222-2222-2222-2222-222222222222", leaseEpoch: corpo1.leaseEpoch };

    _resetarNonces();
    const r2 = await chamarAssinado("POST", "/internal/comunicacao/lease/acquire", { gatewayProcessId: "33333333-3333-3333-3333-333333333333", ttlMs: 300_000 });
    assert.equal(r2.status, 200);
    const corpo2 = await r2.json();
    assert.equal(corpo2.acquired, true);
    leaseAtual = { gatewayProcessId: "33333333-3333-3333-3333-333333333333", leaseEpoch: corpo2.leaseEpoch };
  });

  test("lease/renew com ttlMs fora da faixa é rejeitado com 400", async () => {
    _resetarNonces();
    const lease = await adquirirLeaseDeTeste();
    _resetarNonces();
    const r = await chamarAssinado("POST", "/internal/comunicacao/lease/renew", { ...lease, ttlMs: 300_001 });
    assert.equal(r.status, 400);
  });

  test("heartbeat assinado é registrado no repo (last_seen_at observável)", async () => {
    _resetarNonces();
    const lease = await adquirirLeaseDeTeste();
    _resetarNonces();
    const r = await chamarAssinado("POST", "/internal/comunicacao/eventos/heartbeat", {
      status: "CONNECTED", telefone: "+5511999990000", gatewayVersion: "0.1.0", ...lease,
    });
    assert.equal(r.status, 200);
    const snap = repo._snapshot(ORG_ID);
    assert.equal(snap.status, "CONNECTED");
    assert.ok(snap.lastSeenAt);
  });

  test("heartbeat sem gatewayProcessId/leaseEpoch é rejeitado com 400 (fencing obrigatório, Checkpoint C3.5)", async () => {
    _resetarNonces();
    const r = await chamarAssinado("POST", "/internal/comunicacao/eventos/heartbeat", { status: "CONNECTED" });
    assert.equal(r.status, 400);
  });

  test("heartbeat com leaseEpoch stale é rejeitado com 409, sem sobrescrever o estado atual (Checkpoint C3.5)", async () => {
    _resetarNonces();
    const leaseA = await adquirirLeaseDeTeste();
    _resetarNonces();
    // A grava CONNECTED com o epoch válido.
    await chamarAssinado("POST", "/internal/comunicacao/eventos/heartbeat", { status: "CONNECTED", gatewayVersion: "vA", ...leaseA });

    // A libera (shutdown gracioso) — só assim B consegue assumir uma lease
    // ainda dentro do TTL; enquanto válida e de outro dono, ninguém mais
    // pode adquiri-la (é exatamente essa exclusão mútua que este checkpoint
    // constrói).
    _resetarNonces();
    await liberarLeaseDeTeste(leaseA);

    // B assume a lease (epoch mais novo) e também grava.
    _resetarNonces();
    const leaseB = await adquirirLeaseDeTeste();
    _resetarNonces();
    await chamarAssinado("POST", "/internal/comunicacao/eventos/heartbeat", { status: "CONNECTED", gatewayVersion: "vB", ...leaseB });

    // A (epoch velho) tenta escrever DISCONNECTED — precisa ser rejeitado.
    _resetarNonces();
    const rStale = await chamarAssinado("POST", "/internal/comunicacao/eventos/heartbeat", { status: "DISCONNECTED", ...leaseA });
    assert.equal(rStale.status, 409);
    assert.deepEqual(await rStale.json(), { error: "WHATSAPP_GATEWAY_LEASE_STALE" });

    const snap = repo._snapshot(ORG_ID);
    assert.equal(snap.status, "CONNECTED", "o estado de B não pode ter sido sobrescrito pelo A stale");
    assert.equal(snap.gatewayVersion, "vB");
  });

  test("auth-state: POST grava só o ciphertext, GET devolve exatamente o que foi salvo", async () => {
    _resetarNonces();
    const lease = await adquirirLeaseDeTeste();
    const blob = "v1:aWY=:YWJj:ZGVm";
    _resetarNonces();
    const rPost = await chamarAssinado("POST", "/internal/comunicacao/eventos/auth-state", { authStateEncrypted: blob, authStateVersion: "v1", ...lease });
    assert.equal(rPost.status, 200);

    _resetarNonces();
    const rGet = await chamarAssinado("GET", "/internal/comunicacao/auth-state");
    assert.equal(rGet.status, 200);
    const corpo = await rGet.json();
    assert.equal(corpo.status, "present");
    assert.equal(corpo.authStateEncrypted, blob);
    assert.equal(corpo.authConfirmado, false);
    assert.equal(typeof corpo.authSessionId, "string");
  });

  test("auth-state: POST sem authStateEncrypted é rejeitado com 400 (nunca grava lixo)", async () => {
    _resetarNonces();
    const lease = await adquirirLeaseDeTeste();
    _resetarNonces();
    const r = await chamarAssinado("POST", "/internal/comunicacao/eventos/auth-state", { authStateVersion: "v1", ...lease });
    assert.equal(r.status, 400);
  });

  test("auth-state: POST com fencing stale é rejeitado com 409, sem sobrescrever o auth state atual (Checkpoint C3.5)", async () => {
    _resetarNonces();
    const leaseA = await adquirirLeaseDeTeste();
    _resetarNonces();
    await chamarAssinado("POST", "/internal/comunicacao/eventos/auth-state", { authStateEncrypted: "v1:de-A", authStateVersion: "v1", ...leaseA });

    _resetarNonces();
    await liberarLeaseDeTeste(leaseA);
    _resetarNonces();
    const leaseB = await adquirirLeaseDeTeste();
    _resetarNonces();
    await chamarAssinado("POST", "/internal/comunicacao/eventos/auth-state", { authStateEncrypted: "v1:de-B", authStateVersion: "v1", ...leaseB });

    _resetarNonces();
    const rStale = await chamarAssinado("POST", "/internal/comunicacao/eventos/auth-state", { authStateEncrypted: "v1:de-A-atrasado", authStateVersion: "v1", ...leaseA });
    assert.equal(rStale.status, 409);

    _resetarNonces();
    const rGet = await chamarAssinado("GET", "/internal/comunicacao/auth-state");
    const corpo = await rGet.json();
    assert.equal(corpo.status, "present");
    assert.equal(corpo.authStateEncrypted, "v1:de-B");
  });

  test("auth-state/reset: fenced, limpa o ciphertext (GET auth-state volta a absent), heartbeat/lease intocados", async () => {
    _resetarNonces();
    const lease = await adquirirLeaseDeTeste();
    _resetarNonces();
    await chamarAssinado("POST", "/internal/comunicacao/eventos/auth-state", { authStateEncrypted: "v1:antes-do-reset", authStateVersion: "v1", ...lease });

    _resetarNonces();
    const rReset = await chamarAssinado("POST", "/internal/comunicacao/eventos/auth-state/reset", lease);
    assert.equal(rReset.status, 200);

    _resetarNonces();
    const rGet = await chamarAssinado("GET", "/internal/comunicacao/auth-state");
    assert.deepEqual(await rGet.json(), { status: "absent" }, "depois do reset, GET precisa voltar a absent — nunca o ciphertext antigo");
  });

  test("auth-state/reset: sem gatewayProcessId/leaseEpoch é rejeitado com 400 (fencing sempre obrigatório aqui, nunca opcional)", async () => {
    _resetarNonces();
    const r = await chamarAssinado("POST", "/internal/comunicacao/eventos/auth-state/reset", {});
    assert.equal(r.status, 400);
  });

  test("auth-state/reset: fencing stale é rejeitado com 409, e o ciphertext atual (de um owner mais novo) NÃO é apagado", async () => {
    _resetarNonces();
    const leaseA = await adquirirLeaseDeTeste();
    _resetarNonces();
    await chamarAssinado("POST", "/internal/comunicacao/eventos/auth-state", { authStateEncrypted: "v1:de-A-para-reset-stale", authStateVersion: "v1", ...leaseA });

    _resetarNonces();
    await liberarLeaseDeTeste(leaseA);
    _resetarNonces();
    const leaseB = await adquirirLeaseDeTeste();
    _resetarNonces();
    await chamarAssinado("POST", "/internal/comunicacao/eventos/auth-state", { authStateEncrypted: "v1:de-B-para-reset-stale", authStateVersion: "v1", ...leaseB });

    _resetarNonces();
    const rStaleReset = await chamarAssinado("POST", "/internal/comunicacao/eventos/auth-state/reset", leaseA);
    assert.equal(rStaleReset.status, 409);
    assert.deepEqual(await rStaleReset.json(), { error: "WHATSAPP_GATEWAY_LEASE_STALE" });

    _resetarNonces();
    const rGet = await chamarAssinado("GET", "/internal/comunicacao/auth-state");
    const corpo = await rGet.json();
    assert.equal(corpo.status, "present", "o reset stale (A) não pode ter apagado o ciphertext atual, gravado por B");
    assert.equal(corpo.authStateEncrypted, "v1:de-B-para-reset-stale");
  });

  test("GET auth-state sem nada salvo ainda devolve status absent, não erro", async () => {
    const repoVazio = criarRepoEmMemoria();
    const app = express();
    app.use("/internal/comunicacao", express.raw({ type: "*/*", limit: 256 * 1024 }), exigirHmac(SEGREDO), criarWhatsappGatewayRouter({ repo: repoVazio, organizacaoId: "outra-org" }));
    const srv = await new Promise((resolve) => { const s = createServer(app).listen(0, () => resolve(s)); });
    // try/finally (correção de qualidade, mesmo padrão do resto da suíte
    // deste checkpoint) — sem isto, uma falha de assertion deixava o
    // servidor local aberto e travava o processo inteiro (achado ao vivo
    // rodando esta correção: exit 124 por timeout, não uma falha normal).
    try {
      const url = `http://127.0.0.1:${srv.address().port}`;
      const headers = assinarRequisicao({ segredo: SEGREDO, metodo: "GET", caminho: "/internal/comunicacao/auth-state", corpo: "" });
      const r = await fetch(`${url}/internal/comunicacao/auth-state`, { headers });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { status: "absent" });
    } finally {
      srv.close();
    }
  });

  test("mensagem-recebida assinada (contrato do Checkpoint F, LIVE de cliente direto) repassa o evento para o provider (onMessage)", async () => {
    _resetarNonces();
    const recebidos = [];
    provider.onMessage((m) => recebidos.push(m));
    const r = await chamarAssinado("POST", "/internal/comunicacao/eventos/mensagem-recebida", {
      contratoInbound: 1, providerMessageId: "m1", origemTipo: "LIVE", origemJidTipo: "direct_pn", fromMe: false, telefoneE164: "+5511999990000", telefoneOrigem: "JID_PN",
      falhaDecrypt: false, motivoFalhaDecrypt: null, stubSistema: false, recebidoEm: new Date().toISOString(),
    });
    assert.equal(r.status, 200);
    assert.equal(recebidos.length, 1);
    assert.equal(recebidos[0].providerMessageId, "m1");
  });

  test("mensagem-recebida no formato ANTIGO (só providerMessageId + telefone) é recusada com 400: o contrato é obrigatório", async () => {
    _resetarNonces();
    const r = await chamarAssinado("POST", "/internal/comunicacao/eventos/mensagem-recebida", { providerMessageId: "m2", telefoneE164: "+5511999990000" });
    assert.equal(r.status, 400);
  });

  // ---- H.4-B.4 — confirmações de entrega do provider (mesmo canal HMAC; nenhuma rota pública) ----
  const STATUS_URL = "/internal/comunicacao/eventos/status-provider";
  const evento = (extra = {}) => ({ contratoStatus: 1, providerMessageId: "WAID1", status: "DELIVERED", ...extra });

  test("status-provider: sem assinatura => 401; replay do MESMO pedido assinado => recusado (anti-replay do padrão do projeto)", async () => {
    const sem = await fetch(`${baseUrl}${STATUS_URL}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(evento()) });
    assert.equal(sem.status, 401);
    _resetarNonces();
    const corpo = JSON.stringify(evento());
    const headers = { ...assinarRequisicao({ segredo: SEGREDO, metodo: "POST", caminho: STATUS_URL, corpo }), "Content-Type": "application/json" };
    const a = await fetch(`${baseUrl}${STATUS_URL}`, { method: "POST", headers, body: corpo });
    const b = await fetch(`${baseUrl}${STATUS_URL}`, { method: "POST", headers, body: corpo });
    assert.equal(a.status, 200);
    assert.ok([401, 409].includes(b.status), `replay deveria ser recusado, veio ${b.status}`);
  });

  test("status-provider: id desconhecido => 200 com resultado NAO_ENCONTRADA (não é erro: o receipt pode ganhar da finalização do envio)", async () => {
    _resetarNonces();
    const r = await chamarAssinado("POST", STATUS_URL, evento({ providerMessageId: "NUNCAEXISTIU" }));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, resultado: "NAO_ENCONTRADA" });
  });

  test("status-provider: SENT -> DELIVERED -> READ, duplicado idempotente, atrasado não regride, id de outra mensagem não é tocado", async () => {
    repo._semearMensagem(ORG_ID, { providerMessageId: "WAID1", status: "SENT" });
    repo._semearMensagem(ORG_ID, { providerMessageId: "WAOUTRA", status: "SENT" });
    const enviar = async (extra) => { _resetarNonces(); const r = await chamarAssinado("POST", STATUS_URL, evento(extra)); assert.equal(r.status, 200); return (await r.json()).resultado; };
    assert.equal(await enviar({ status: "DELIVERED" }), "APLICADO");
    assert.equal(repo._mensagem(ORG_ID, "WAID1").status, "DELIVERED");
    assert.equal(await enviar({ status: "DELIVERED" }), "DUPLICADO");
    assert.equal(await enviar({ status: "READ" }), "APLICADO");
    assert.equal(await enviar({ status: "DELIVERED" }), "DUPLICADO", "DELIVERED atrasado depois de READ");
    assert.equal(await enviar({ status: "READ" }), "DUPLICADO");
    assert.equal(repo._mensagem(ORG_ID, "WAID1").status, "READ");
    assert.equal(repo._mensagem(ORG_ID, "WAOUTRA").status, "SENT", "receipt de um id nunca altera outra mensagem");
  });

  test("status-provider: SENT -> READ direto (READ implica entrega); SERVER_ACK e PROVIDER_ERROR não mudam o status", async () => {
    repo._semearMensagem(ORG_ID, { providerMessageId: "WAID2", status: "SENT" });
    const enviar = async (extra) => { _resetarNonces(); const r = await chamarAssinado("POST", STATUS_URL, evento({ providerMessageId: "WAID2", ...extra })); return (await r.json()).resultado; };
    assert.equal(await enviar({ status: "SERVER_ACK" }), "ACK_REGISTRADO");
    assert.equal(await enviar({ status: "SERVER_ACK" }), "DUPLICADO");
    assert.equal(await enviar({ status: "PROVIDER_ERROR", erroCodigo: "479" }), "ERRO_REGISTRADO");
    assert.equal(repo._mensagem(ORG_ID, "WAID2").status, "SENT");
    assert.equal(await enviar({ status: "READ" }), "APLICADO");
    const m = repo._mensagem(ORG_ID, "WAID2");
    assert.equal(m.status, "READ"); assert.ok(m.entregueEm && m.lidoEm);
  });

  test("status-provider: estado que um receipt nunca toca (SENDING/FAILED/CANCELLED/DELIVERY_UNKNOWN...) => ESTADO_NAO_ELEGIVEL, inalterado", async () => {
    for (const st of ["SENDING", "FAILED", "CANCELLED", "DELIVERY_UNKNOWN", "SCHEDULED"]) {
      repo._semearMensagem(ORG_ID, { providerMessageId: `WA-${st}`, status: st });
      _resetarNonces();
      const r = await chamarAssinado("POST", STATUS_URL, evento({ providerMessageId: `WA-${st}`, status: "READ" }));
      assert.equal((await r.json()).resultado, "ESTADO_NAO_ELEGIVEL", st);
      assert.equal(repo._mensagem(ORG_ID, `WA-${st}`).status, st);
    }
  });

  test("status-provider: contrato estrito — 400 com código fechado (formato antigo/numérico, chave desconhecida, organizacao_id injetado, status inválido)", async () => {
    const invalidos = [
      [{ providerMessageId: "m1", status: "DELIVERED" }, "contratoStatus_ausente"],
      [{ providerMessageId: "m1", status: 3 }, "contratoStatus_ausente"],
      [evento({ status: 3 }), "status"],
      [evento({ status: "SENT" }), "status"],
      [evento({ organizacao_id: "outra-org" }), "campo_desconhecido"],
      [evento({ providerMessageId: "id com espaço" }), "providerMessageId"],
      [evento({ status: "PROVIDER_ERROR" }), "erroCodigo_ausente"],
      [evento({ erroCodigo: "479" }), "erroCodigo_incoerente"],
      [evento({ ocorridoEm: "ontem" }), "ocorridoEm"],
      [evento({ contratoStatus: 3 }), "contratoStatus"],
      [evento({ providerInstanceId: "default" }), "campo_desconhecido"],                                        // v1 nunca carrega os campos do v2
      [evento({ contratoStatus: 2 }), "providerInstanceId_ausente"],
      [evento({ contratoStatus: 2, providerInstanceId: "default" }), "correlationId_ausente"],
      [evento({ contratoStatus: 2, providerInstanceId: "com espaço", correlationId: "wa:x:v1" }), "providerInstanceId"],
      [evento({ contratoStatus: 2, providerInstanceId: "default", correlationId: "chave inválida" }), "correlationId"],
    ];
    for (const [corpo, campo] of invalidos) {
      _resetarNonces();
      const r = await chamarAssinado("POST", STATUS_URL, corpo);
      assert.equal(r.status, 400, campo);
      assert.deepEqual(await r.json(), { error: "status_provider_invalido", campo });
    }
  });

  // ---- CONTRATO v2 (VINCULADO) — endurecimento de tenant, 25/09/2026 ------------------------------------------------------------------------------
  // O envio manual do Central fica na empresa do responsável (≠ org da conexão). O receipt v2 prova a origem do envio: instância emissora (conferida contra
  // a configurada) + correlationId (a idempotencyKey do pedido de envio, guardada só pelo Gateway que enviou) + providerMessageId — os TRÊS têm de apontar
  // para o MESMO registro. A org sai desse registro (servidor), nunca do payload. v1 (Gateway antigo) continua só na org da conexão.
  const ORG_EMPRESA = "b1448c7b-empresa-do-responsavel";
  const CHAVE_MANUAL = "wa:manual:11111111-1111-4111-8111-111111111111:v1";
  const CHAVE_AUTO = "wa:alerta:22222222-2222-4222-8222-222222222222:v1";
  const ev2 = (extra = {}) => ({ contratoStatus: 2, providerMessageId: "WAM1", status: "DELIVERED", providerInstanceId: "default", correlationId: CHAVE_MANUAL, ...extra });
  const enviar2 = async (extra) => { _resetarNonces(); const r = await chamarAssinado("POST", STATUS_URL, ev2(extra)); assert.equal(r.status, 200); return (await r.json()).resultado; };
  const semear2 = () => {
    repo._semearMensagem(ORG_EMPRESA, { providerMessageId: "WAM1", status: "SENT", idempotencyKey: CHAVE_MANUAL });   // manual do Central: org ≠ conexão
    repo._semearMensagem(ORG_ID, { providerMessageId: "WAA1", status: "SENT", idempotencyKey: CHAVE_AUTO });          // automático: org = conexão
  };

  test("v2: receipt correto + instância correta => ATUALIZA a mensagem manual da OUTRA org (e só ela); manual e automático funcionam", async () => {
    semear2();
    assert.equal(await enviar2({}), "APLICADO");
    assert.equal(repo._mensagem(ORG_EMPRESA, "WAM1").status, "DELIVERED");
    assert.equal(repo._mensagem(ORG_ID, "WAA1").status, "SENT", "receipt de uma mensagem não altera a outra");
    assert.equal(await enviar2({ providerMessageId: "WAA1", correlationId: CHAVE_AUTO, status: "READ" }), "APLICADO");
    assert.equal(repo._mensagem(ORG_ID, "WAA1").status, "READ");
    assert.equal(repo._mensagem(ORG_EMPRESA, "WAM1").status, "DELIVERED", "DELIVERED do manual não é tocado pelo READ do automático");
  });

  test("v2: receipt correto + INSTÂNCIA ERRADA => rejeitado (NAO_ENCONTRADA, indistinguível de 'não existe'), nada muda", async () => {
    semear2();
    assert.equal(await enviar2({ providerInstanceId: "outra-instancia" }), "NAO_ENCONTRADA");
    assert.equal(repo._mensagem(ORG_EMPRESA, "WAM1").status, "SENT");
    assert.equal(await enviar2({ providerInstanceId: "DEFAULT" }), "NAO_ENCONTRADA", "comparação exata (sem normalizar caixa)");
    assert.equal(repo._mensagem(ORG_EMPRESA, "WAM1").status, "SENT");
  });

  test("v2: id de OUTRA org + instância errada => rejeitado; instância certa mas correlationId de outra mensagem => rejeitado", async () => {
    semear2();
    assert.equal(await enviar2({ providerMessageId: "WAA1", correlationId: CHAVE_AUTO, providerInstanceId: "x" }), "NAO_ENCONTRADA");
    assert.equal(await enviar2({ providerMessageId: "WAM1", correlationId: CHAVE_AUTO }), "NAO_ENCONTRADA", "id do manual + chave do automático: pares que não são do mesmo registro");
    assert.equal(await enviar2({ providerMessageId: "WAA1", correlationId: CHAVE_MANUAL }), "NAO_ENCONTRADA");
    assert.equal(repo._mensagem(ORG_EMPRESA, "WAM1").status, "SENT"); assert.equal(repo._mensagem(ORG_ID, "WAA1").status, "SENT");
  });

  test("v2: id desconhecido => NAO_ENCONTRADA; correlationId errado para um id existente => NAO_ENCONTRADA; registro sem idempotencyKey nunca casa", async () => {
    semear2();
    repo._semearMensagem("org-sem-chave", { providerMessageId: "WASEMCHAVE", status: "SENT" });
    assert.equal(await enviar2({ providerMessageId: "NUNCAEXISTIU" }), "NAO_ENCONTRADA");
    assert.equal(await enviar2({ correlationId: "wa:manual:99999999-9999-4999-8999-999999999999:v1" }), "NAO_ENCONTRADA");
    assert.equal(await enviar2({ providerMessageId: "WASEMCHAVE", correlationId: "wa:x:v1" }), "NAO_ENCONTRADA");
    assert.equal(repo._mensagem("org-sem-chave", "WASEMCHAVE").status, "SENT");
  });

  test("v2: duplicado é idempotente; READ nunca regride para DELIVERED; SENT->READ direto preenche entrega e leitura", async () => {
    semear2();
    assert.equal(await enviar2({ status: "DELIVERED" }), "APLICADO");
    assert.equal(await enviar2({ status: "DELIVERED" }), "DUPLICADO");
    assert.equal(await enviar2({ status: "READ" }), "APLICADO");
    assert.equal(await enviar2({ status: "DELIVERED" }), "DUPLICADO", "DELIVERED atrasado depois de READ");
    assert.equal(await enviar2({ status: "READ" }), "DUPLICADO");
    assert.equal(repo._mensagem(ORG_EMPRESA, "WAM1").status, "READ");
    assert.equal(repo._mensagem(ORG_ID, "WAA1").status, "SENT");
    assert.equal(await enviar2({ providerMessageId: "WAA1", correlationId: CHAVE_AUTO, status: "READ" }), "APLICADO");
    const a = repo._mensagem(ORG_ID, "WAA1"); assert.ok(a.entregueEm && a.lidoEm);
  });

  test("v2: DELIVERED não cruza tenant — o MESMO id em duas orgs só é alcançado pelo par (id + correlationId) do registro certo", async () => {
    repo._semearMensagem("org-a", { providerMessageId: "WADUPLO", status: "SENT", idempotencyKey: "wa:manual:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:v1" });
    repo._semearMensagem("org-b", { providerMessageId: "WADUPLO", status: "SENT", idempotencyKey: "wa:manual:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:v1" });
    assert.equal(await enviar2({ providerMessageId: "WADUPLO", correlationId: "wa:manual:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:v1" }), "APLICADO");
    assert.equal(repo._mensagem("org-b", "WADUPLO").status, "DELIVERED");
    assert.equal(repo._mensagem("org-a", "WADUPLO").status, "SENT", "a mensagem de outra org com o MESMO id do provider não é tocada");
    assert.equal(await enviar2({ providerMessageId: "WADUPLO", correlationId: "wa:manual:cccccccc-cccc-4ccc-8ccc-cccccccccccc:v1" }), "NAO_ENCONTRADA");
  });

  test("v2: organizacao_id/mensagem_id no payload continuam 400 (a org nunca vem do corpo)", async () => {
    for (const extra of [{ organizacao_id: "outra" }, { organizacaoId: "outra" }, { mensagem_id: "x" }, { providerInstanceId2: "x" }]) {
      _resetarNonces(); const r = await chamarAssinado("POST", STATUS_URL, ev2(extra));
      assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: "status_provider_invalido", campo: "campo_desconhecido" });
    }
  });

  test("v1 (Gateway antigo): continua SÓ na org da conexão — a mensagem manual de outra org NÃO é alcançada (precisa do Gateway v2)", async () => {
    semear2();
    _resetarNonces();
    const r = await chamarAssinado("POST", STATUS_URL, evento({ providerMessageId: "WAM1" }));
    assert.equal((await r.json()).resultado, "NAO_ENCONTRADA");
    assert.equal(repo._mensagem(ORG_EMPRESA, "WAM1").status, "SENT");
    _resetarNonces();
    const auto = await chamarAssinado("POST", STATUS_URL, evento({ providerMessageId: "WAA1" }));
    assert.equal((await auto.json()).resultado, "APLICADO", "automático (org = conexão) segue funcionando em v1");
  });
});
