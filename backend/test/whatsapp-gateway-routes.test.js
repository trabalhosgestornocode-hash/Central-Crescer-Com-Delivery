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
    assert.deepEqual(await rGet.json(), { status: "present", authStateEncrypted: blob });
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
    assert.deepEqual(await rGet.json(), { status: "present", authStateEncrypted: "v1:de-B" });
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

  test("mensagem-recebida assinada repassa o evento para o provider (onMessage)", async () => {
    _resetarNonces();
    const recebidos = [];
    provider.onMessage((m) => recebidos.push(m));
    const r = await chamarAssinado("POST", "/internal/comunicacao/eventos/mensagem-recebida", { providerMessageId: "m1", telefoneE164: "+5511999990000" });
    assert.equal(r.status, 200);
    assert.equal(recebidos.length, 1);
    assert.equal(recebidos[0].providerMessageId, "m1");
  });

  test("status-provider assinado é aceito", async () => {
    _resetarNonces();
    const r = await chamarAssinado("POST", "/internal/comunicacao/eventos/status-provider", { providerMessageId: "m1", status: "DELIVERED" });
    assert.equal(r.status, 200);
  });
});
