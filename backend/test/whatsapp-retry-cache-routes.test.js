// Cache de RETRY (migration 105) — rotas Gateway -> Backend com o repo em memória (espelho das funções SQL; a SQL em si
// é testada contra Postgres real em whatsapp-retry-cache-migration-pg.test.js). Cobre: validação estrita na fronteira,
// fencing pela lease, isolamento entre ORGANIZAÇÕES (item 7 do checkpoint), idempotência (nunca sobrescreve), consumo
// atômico com teto, TTL, limpeza de expirados (item 12), e o CONTRATO REAL Gateway↔Backend (cripto + HMAC + HTTP) usando
// os módulos do próprio gateway-whatsapp (src/retryCache.js + src/backendClient.js).
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import express from "express";
import { createServer } from "node:http";
import { exigirHmac, assinarRequisicao, _resetarNonces } from "../src/modules/comunicacao/gateway/whatsappGateway.hmac.js";
import { criarWhatsappGatewayRouter } from "../src/modules/comunicacao/gateway/whatsappGateway.routes.js";
import { criarRepoEmMemoria, criarRepoSupabase, LeaseStaleError } from "../src/modules/comunicacao/gateway/whatsappGateway.repo.js";
// Módulos REAIS do Gateway (import cross-package, mesmo padrão de whatsapp-gateway-repo-supabase.test.js).
import { criarCacheRetry } from "../../gateway-whatsapp/src/retryCache.js";
import { criarBackendClient } from "../../gateway-whatsapp/src/backendClient.js";

const SEGREDO = "s".repeat(32);
const ORG_A = "org-retry-a";
const ORG_B = "org-retry-b";
const ID = "3EB0ABCDEF0123456789AB";
const HASH = "a".repeat(64);
const PAYLOAD = `r1:${Buffer.alloc(12, 1).toString("base64")}:${Buffer.alloc(16, 2).toString("base64")}:${Buffer.from("ciphertext-opaco").toString("base64")}`;
const DIA = 24 * 3600;

describe("rotas do cache de retry (repo em memória)", () => {
  let servidor, baseUrl, repo, tempo, leaseA, leaseB;

  async function chamar(caminho, corpoObj) {
    const corpo = JSON.stringify(corpoObj);
    _resetarNonces();
    const headers = { ...assinarRequisicao({ segredo: SEGREDO, metodo: "POST", caminho, corpo }), "Content-Type": "application/json" };
    const r = await fetch(`${baseUrl}${caminho}`, { method: "POST", headers, body: corpo });
    return { status: r.status, corpo: await r.json(), cache: r.headers.get("cache-control") };
  }
  const gravar = (org, extra = {}) => chamar(`/${org}/internal/comunicacao/eventos/retry-cache`, {
    providerMessageId: ID, payloadCifrado: PAYLOAD, payloadVersao: "r1", destinoHash: HASH, destinoLidHash: null,
    ttlSegundos: 7 * DIA, maxReenvios: 3, ...(org === ORG_A ? leaseA : leaseB), ...extra,
  });
  const consumir = (org, extra = {}) => chamar(`/${org}/internal/comunicacao/eventos/retry-cache/consumir`, { providerMessageId: ID, ...(org === ORG_A ? leaseA : leaseB), ...extra });

  before(async () => {
    tempo = { t: Date.parse("2026-10-02T12:00:00Z") };
    repo = criarRepoEmMemoria({ agora: () => tempo.t });
    const app = express();
    // DUAS organizações (dois gateways/conexões) sobre o MESMO repo — o organizacaoId vem da CONFIG de cada router.
    for (const org of [ORG_A, ORG_B]) {
      app.use(`/${org}/internal/comunicacao`, express.raw({ type: "*/*", limit: 256 * 1024 }), exigirHmac(SEGREDO), criarWhatsappGatewayRouter({ repo, organizacaoId: org }));
    }
    await new Promise((r) => { servidor = createServer(app).listen(0, r); });
    baseUrl = `http://127.0.0.1:${servidor.address().port}`;
    // uma lease por organização (relógio REAL, como adquirirLease); o relógio injetado só move o TTL do cache
    leaseA = { gatewayProcessId: randomUUID() };
    leaseB = { gatewayProcessId: randomUUID() };
    leaseA.leaseEpoch = (await repo.adquirirLease(ORG_A, { ...leaseA, ttlMs: 3_600_000 })).leaseEpoch;
    leaseB.leaseEpoch = (await repo.adquirirLease(ORG_B, { ...leaseB, ttlMs: 3_600_000 })).leaseEpoch;
  });
  after(() => servidor.close());

  beforeEach(async () => {
    tempo.t += 365 * DIA * 1000; // cada teste começa com as linhas anteriores expiradas (e apagadas)
    await repo.limparRetryCache({ limite: 100_000 });
  });

  test("gravar → consumir: devolve o MESMO ciphertext, conta o reenvio, no-store", async () => {
    const g = await gravar(ORG_A);
    assert.equal(g.status, 200);
    assert.equal(g.corpo.resultado, "GRAVADO");
    const c = await consumir(ORG_A);
    assert.equal(c.status, 200);
    assert.equal(c.cache, "no-store");
    assert.deepEqual({ r: c.corpo.resultado, p: c.corpo.payloadCifrado, v: c.corpo.payloadVersao, h: c.corpo.destinoHash, n: c.corpo.reenvios }, { r: "OK", p: PAYLOAD, v: "r1", h: HASH, n: 1 });
  });

  test("7. organização B NÃO lê (nem sobrescreve) o cache da organização A, mesmo com o mesmo providerMessageId", async () => {
    await gravar(ORG_A);
    const cB = await consumir(ORG_B);
    assert.equal(cB.corpo.resultado, "NAO_ENCONTRADA");
    assert.equal(cB.corpo.payloadCifrado, undefined);
    const gB = await gravar(ORG_B, { payloadCifrado: PAYLOAD.replace("ciphertext", "outro") });
    assert.equal(gB.corpo.resultado, "GRAVADO", "linha PRÓPRIA da B");
    assert.equal((await consumir(ORG_A)).corpo.payloadCifrado, PAYLOAD, "a da A continua intacta");
    // e a lease de UMA organização nunca vale para a outra
    const cruzada = await chamar(`/${ORG_B}/internal/comunicacao/eventos/retry-cache/consumir`, { providerMessageId: ID, ...leaseA });
    assert.equal(cruzada.status, 409);
  });

  test("idempotente: regravar o mesmo id NUNCA sobrescreve o conteúdo", async () => {
    await gravar(ORG_A);
    const de = await gravar(ORG_A, { payloadCifrado: PAYLOAD.replace("ciphertext", "trocado") });
    assert.equal(de.corpo.resultado, "JA_EXISTIA");
    assert.equal((await consumir(ORG_A)).corpo.payloadCifrado, PAYLOAD);
  });

  test("teto de reenvios: depois de maxReenvios, ESGOTADA (sem payload)", async () => {
    await gravar(ORG_A, { maxReenvios: 2 });
    assert.equal((await consumir(ORG_A)).corpo.resultado, "OK");
    assert.equal((await consumir(ORG_A)).corpo.resultado, "OK");
    const r = await consumir(ORG_A);
    assert.equal(r.corpo.resultado, "ESGOTADA");
    assert.equal(r.corpo.payloadCifrado, undefined);
  });

  test("TTL: expirada ⇒ EXPIRADA uma vez (e a linha some) ⇒ depois NAO_ENCONTRADA", async () => {
    await gravar(ORG_A, { ttlSegundos: 3600 });
    tempo.t += 3600 * 1000 + 1;
    assert.equal((await consumir(ORG_A)).corpo.resultado, "EXPIRADA");
    assert.equal((await consumir(ORG_A)).corpo.resultado, "NAO_ENCONTRADA");
  });

  test("12. limpeza: gravar apaga expirados (oportunista) e limparRetryCache apaga o resto", async () => {
    await gravar(ORG_A, { ttlSegundos: 3600, providerMessageId: "3EB0EXPIRA00000000000001" });
    await gravar(ORG_A, { ttlSegundos: 3600, providerMessageId: "3EB0EXPIRA00000000000002" });
    tempo.t += 3600 * 1000 + 1;
    await gravar(ORG_A, { providerMessageId: "3EB0NOVA0000000000000001" });
    assert.deepEqual(repo._retryCache().map((r) => r.providerMessageId), ["3EB0NOVA0000000000000001"]);
    tempo.t += 30 * DIA * 1000;
    assert.equal(await repo.limparRetryCache(), 1);
    assert.equal(repo._retryCache().length, 0);
  });

  test("fencing: processo sem a lease atual ⇒ 409 LEASE_STALE (gravar e consumir), nada gravado", async () => {
    const stale = { gatewayProcessId: randomUUID(), leaseEpoch: leaseA.leaseEpoch };
    assert.equal((await gravar(ORG_A, stale)).status, 409);
    await gravar(ORG_A);
    const r = await consumir(ORG_A, stale);
    assert.equal(r.status, 409);
    assert.equal(r.corpo.error, "WHATSAPP_GATEWAY_LEASE_STALE");
    assert.equal(repo._retryCache()[0].reenvios, 0, "o consumo recusado não conta");
  });

  test("validação estrita: 400 com o CAMPO (nunca ecoa o valor); plaintext/formatos errados nunca chegam ao repo", async () => {
    const casos = [
      [{ providerMessageId: "curto" }, "providerMessageId"],
      [{ providerMessageId: "id com espaço 0000000" }, "providerMessageId"],
      [{ payloadCifrado: "texto em claro do alerta" }, "payloadCifrado"],
      [{ payloadCifrado: `v1:${PAYLOAD.slice(3)}` }, "payloadCifrado"],
      [{ payloadCifrado: `r1:${"A".repeat(140_000)}:a:a` }, "payloadCifrado"],
      [{ payloadVersao: "r2" }, "payloadVersao"],
      [{ destinoHash: "5511987654321" }, "destinoHash"],
      [{ destinoLidHash: "xyz" }, "destinoLidHash"],
      [{ ttlSegundos: 60 }, "ttlSegundos"],
      [{ ttlSegundos: 31 * DIA }, "ttlSegundos"],
      [{ maxReenvios: 0 }, "maxReenvios"],
      [{ maxReenvios: 51 }, "maxReenvios"],
      [{ leaseEpoch: "7" }, "fencing"],
    ];
    for (const [extra, campo] of casos) {
      const r = await gravar(ORG_A, extra);
      assert.equal(r.status, 400, `${campo}: ${JSON.stringify(extra).slice(0, 60)}`);
      assert.deepEqual(r.corpo, { error: "retry_cache_invalido", campo });
    }
    assert.equal(repo._retryCache().length, 0);
  });

  test("sem HMAC válido ⇒ 401 (rota interna, nunca pública)", async () => {
    const r = await fetch(`${baseUrl}/${ORG_A}/internal/comunicacao/eventos/retry-cache/consumir`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerMessageId: ID, ...leaseA }) });
    assert.equal(r.status, 401);
  });

  test("CONTRATO REAL Gateway↔Backend: retryCache + backendClient do gateway, via HTTP+HMAC, com cripto real", async () => {
    // o backendClient do gateway assina `/internal/comunicacao/...` (o caminho de produção, sem prefixo): servidor próprio,
    // montado exatamente como em produção, para a organização A, sobre o MESMO repo.
    const app = express();
    app.use("/internal/comunicacao", express.raw({ type: "*/*", limit: 256 * 1024 }), exigirHmac(SEGREDO), criarWhatsappGatewayRouter({ repo, organizacaoId: ORG_A }));
    const srv = await new Promise((r) => { const s = createServer(app).listen(0, () => r(s)); });
    const backendClient = criarBackendClient({ backendUrl: `http://127.0.0.1:${srv.address().port}`, segredoHmac: SEGREDO, timeoutMs: 5_000 });
    const eventosGw = [];
    const silencioso = (nivel, evento, dados) => { eventosGw.push({ evento, dados }); };
    const chave = randomBytes(32).toString("base64");
    const gw = criarCacheRetry({ backendClient, chaveEncriptacaoEnv: chave, obterContextoLease: () => ({ ...leaseA }), habilitado: true, emitir: silencioso });
    const { proto } = await import("../../gateway-whatsapp/node_modules/baileys/lib/index.js");
    const original = proto.Message.fromObject({ extendedTextMessage: { text: "Alerta Crescer: contrato real" } });
    const logOriginal = console.log; console.log = () => {};
    try {
      const r = await gw.registrarEnvio({ providerMessageId: ID, mensagem: original, destinoJid: "5511987654321@s.whatsapp.net" });
      assert.equal(r.status, "persistido", `o backend ACEITOU o que o gateway manda (formatos batem): ${JSON.stringify(eventosGw.filter((e) => e.evento.includes("falhou")))}`);
      const linha = repo._retryCache().find((l) => l.organizacaoId === ORG_A);
      assert.ok(!JSON.stringify(linha).includes("contrato real"), "o backend só vê ciphertext");
      // processo novo (memória vazia) — o banco é a fonte
      const gw2 = criarCacheRetry({ backendClient, chaveEncriptacaoEnv: chave, obterContextoLease: () => ({ ...leaseA }), habilitado: true, emitir: silencioso });
      const m = await gw2.obterMensagemParaRetry({ remoteJid: "5511987654321:2@s.whatsapp.net", id: ID, fromMe: true, participant: "5511987654321:2@s.whatsapp.net" });
      assert.equal(proto.Message.toObject(m).extendedTextMessage.text, "Alerta Crescer: contrato real");
    } finally { console.log = logOriginal; srv.close(); }
  });
});

describe("repo Supabase — mapeamento das RPCs da migration 105", () => {
  function dbFalso(respostas) {
    const chamadas = [];
    return { chamadas, rpc: async (nome, args) => { chamadas.push({ nome, args }); return { data: respostas[nome], error: null }; } };
  }
  const lease = { gatewayProcessId: randomUUID(), leaseEpoch: 3 };

  test("gravar chama whatsapp_retry_cache_gravar com organização/instância do BACKEND e os p_* exatos", async () => {
    const db = dbFalso({ whatsapp_retry_cache_gravar: [{ resultado: "GRAVADO", expira_em: "2026-10-09T00:00:00Z" }] });
    const r = await criarRepoSupabase().salvarRetryCache("org-x", { providerMessageId: ID, payloadCifrado: PAYLOAD, payloadVersao: "r1", destinoHash: HASH, ttlSegundos: 7 * DIA, maxReenvios: 15, ...lease }, { supabase: db });
    assert.deepEqual(r, { resultado: "GRAVADO", expiraEm: "2026-10-09T00:00:00Z" });
    assert.deepEqual(db.chamadas[0], { nome: "whatsapp_retry_cache_gravar", args: {
      p_organizacao_id: "org-x", p_provider_instance_id: "default", p_process_id: lease.gatewayProcessId, p_epoch: 3,
      p_provider_message_id: ID, p_payload_cifrado: PAYLOAD, p_payload_versao: "r1", p_destino_hash: HASH, p_destino_lid_hash: null,
      p_ttl_segundos: 7 * DIA, p_max_reenvios: 15,
    } });
  });

  test("LEASE_STALE da função vira LeaseStaleError (gravar e consumir); resultado inesperado vira erro interno", async () => {
    const db = dbFalso({ whatsapp_retry_cache_gravar: [{ resultado: "LEASE_STALE" }], whatsapp_retry_cache_consumir: [{ resultado: "LEASE_STALE" }] });
    const repo = criarRepoSupabase();
    await assert.rejects(repo.salvarRetryCache("org-x", { providerMessageId: ID, ttlSegundos: DIA, ...lease }, { supabase: db }), LeaseStaleError);
    await assert.rejects(repo.consumirRetryCache("org-x", { providerMessageId: ID, ...lease }, { supabase: db }), LeaseStaleError);
    await assert.rejects(repo.consumirRetryCache("org-x", { providerMessageId: ID, ...lease }, { supabase: dbFalso({ whatsapp_retry_cache_consumir: [{ resultado: "???" }] }) }));
  });

  test("consumir OK mapeia snake_case → camelCase; ESGOTADA não carrega payload", async () => {
    const ok = dbFalso({ whatsapp_retry_cache_consumir: [{ resultado: "OK", payload_cifrado: PAYLOAD, payload_versao: "r1", destino_hash: HASH, destino_lid_hash: null, reenvios: 2, max_reenvios: 15 }] });
    assert.deepEqual(await criarRepoSupabase().consumirRetryCache("org-x", { providerMessageId: ID, ...lease }, { supabase: ok }),
      { resultado: "OK", payloadCifrado: PAYLOAD, payloadVersao: "r1", destinoHash: HASH, destinoLidHash: null, reenvios: 2, maxReenvios: 15 });
    const esg = dbFalso({ whatsapp_retry_cache_consumir: [{ resultado: "ESGOTADA", payload_cifrado: null, reenvios: 15, max_reenvios: 15 }] });
    assert.deepEqual(await criarRepoSupabase().consumirRetryCache("org-x", { providerMessageId: ID, ...lease }, { supabase: esg }), { resultado: "ESGOTADA", reenvios: 15, maxReenvios: 15 });
  });

  test("sem fencing nem chega ao banco", async () => {
    const db = dbFalso({});
    await assert.rejects(criarRepoSupabase().consumirRetryCache("org-x", { providerMessageId: ID }, { supabase: db }), LeaseStaleError);
    assert.equal(db.chamadas.length, 0);
  });
});
