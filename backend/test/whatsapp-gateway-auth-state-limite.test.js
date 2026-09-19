// C3.5-C.8 — HTTP 413 no auth-state. O blob de auth do Baileys (creds + chaves Signal, cifrado, base64) cresceu para ~253 KB de
// body e o teto ÚNICO de 256 KiB do parser das rotas internas do Gateway passou a responder 413: a persistência falhou e o
// Gateway ficou preso em DISCONNECTED. Correção: parser DEDICADO (finito) só para `POST /eventos/auth-state`, montado ANTES do
// genérico; as demais rotas internas seguem em 256 KiB; HMAC intacto. NENHUM auth real aqui: só bytes/valores fictícios.
//
// Partes:
//   1. unitário — leitura robusta das envs e limites finitos;
//   2. router REAL (montarWhatsappGatewayRouter) num servidor local, repo em memória — fronteiras exatas de tamanho, ordem
//      dos middlewares, demais rotas, HMAC;
//   3. ponta a ponta — cliente REAL do Gateway + adaptador de auth REAL (cripto real) -> router REAL -> repo em memória;
//   4. integração (banco de TESTE) — a mesma cadeia até o Supabase real (PULA se o ambiente não for descartável).
// Rodar: node --env-file=.env.test-integracao --test test/whatsapp-gateway-auth-state-limite.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  montarWhatsappGatewayRouter, lerLimiteBytes,
  LIMITE_CORPO_PADRAO_BYTES, LIMITE_AUTH_STATE_PADRAO_BYTES, LIMITE_AUTH_STATE_TETO_BYTES,
} from "../src/modules/comunicacao/gateway/whatsappGateway.bootstrap.js";
import { assinarRequisicao, _resetarNonces } from "../src/modules/comunicacao/gateway/whatsappGateway.hmac.js";
import { criarRepoEmMemoria, criarRepoSupabase } from "../src/modules/comunicacao/gateway/whatsappGateway.repo.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import { criarOrganizacao, apagarOrganizacao, migracao083Aplicada, migracao084Aplicada } from "./helpers/comunicacao-fixtures.js";
// Cliente e adaptador REAIS do Gateway (cross-package por caminho relativo, como os demais testes do módulo).
import { criarBackendClient } from "../../gateway-whatsapp/src/backendClient.js";
import { criarAuthStateAdapter } from "../../gateway-whatsapp/src/authState.js";

const KiB = 1024;
const MiB = 1024 * KiB;
const SEGREDO = "segredo-ficticio-de-teste-c38-0123456789abcdef";
const ORG = "00000000-0000-0000-0000-0000000000c8";
const AUTH = "/internal/comunicacao/eventos/auth-state";
const CHAVE_CRIPTO = randomBytes(32).toString("base64"); // chave FICTÍCIA de teste (AES-256-GCM real)

// ---------------------------------------------------------------------------------------------------------------------
// infra
// ---------------------------------------------------------------------------------------------------------------------
const ENVS_DO_TESTE = ["WHATSAPP_GATEWAY_SECRET", "WHATSAPP_GATEWAY_ORGANIZACAO_ID", "WHATSAPP_GATEWAY_MAX_BODY_BYTES", "WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES"];
const envOriginal = Object.fromEntries(ENVS_DO_TESTE.map((k) => [k, process.env[k]]));
function restaurarEnv() { for (const k of ENVS_DO_TESTE) { if (envOriginal[k] === undefined) delete process.env[k]; else process.env[k] = envOriginal[k]; } }

/** Sobe o router REAL (bootstrap) num servidor local, na ordem do app.js: gateway ANTES do express.json global. */
async function subir({ env = {}, repo, organizacaoId = ORG } = {}) {
  process.env.WHATSAPP_GATEWAY_SECRET = SEGREDO;
  process.env.WHATSAPP_GATEWAY_ORGANIZACAO_ID = organizacaoId;
  delete process.env.WHATSAPP_GATEWAY_MAX_BODY_BYTES;
  delete process.env.WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  let gw;
  try { gw = montarWhatsappGatewayRouter({ repo: repo ?? criarRepoEmMemoria() }); } finally { restaurarEnv(); }
  const app = express();
  app.use(gw.path, gw.router);
  app.use(express.json({ limit: "1mb" })); // parser GLOBAL, depois (como no app.js real)
  app.use(errorHandler);
  const servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${servidor.address().port}`, gw, repo: gw.repo, fechar: () => new Promise((r) => servidor.close(r)) };
}

/** POST/PUT com http.request (um servidor que responde 413/401 antes de ler o corpo não pode derrubar o cliente de teste). */
function enviar(url, metodo, caminho, corpo, headers) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: caminho, method: metodo, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(corpo), ...headers } }, (res) => {
      let d = ""; res.on("data", (c) => { d += c; });
      res.on("end", () => resolve({ status: res.statusCode, corpo: d }));
    });
    req.on("error", (e) => resolve({ status: `ERR:${e.code}`, corpo: "" }));
    req.end(corpo);
  });
}
const assinado = (srv, metodo, caminho, corpo) => enviar(srv.url, metodo, caminho, corpo, assinarRequisicao({ segredo: SEGREDO, metodo, caminho, corpo }));

/** Corpo JSON com tamanho TOTAL exato (bytes), no formato real do Gateway; o "cifrado" é só repetição de 'A'. */
function corpoAuth(totalBytes, fencing = { gatewayProcessId: "11111111-1111-4111-8111-111111111111", leaseEpoch: 1 }) {
  const montar = (s) => JSON.stringify({ authStateEncrypted: s, authStateVersion: "v1", ...fencing });
  const vazio = Buffer.byteLength(montar(""));
  return montar("A".repeat(Math.max(1, totalBytes - vazio)));
}
const corpoGenerico = (totalBytes) => {
  const montar = (s) => JSON.stringify({ padding: s, gatewayProcessId: "11111111-1111-4111-8111-111111111111", leaseEpoch: 1 });
  return montar("A".repeat(Math.max(0, totalBytes - Buffer.byteLength(montar("")))));
};

/** Libera a lease que um teste anterior deixou presa neste servidor (exclusão mútua correta por desenho). */
async function liberarLeaseAtual(srv) {
  if (!srv.leaseAtual) return;
  await assinado(srv, "POST", "/internal/comunicacao/lease/release", JSON.stringify(srv.leaseAtual));
  srv.leaseAtual = null;
}

async function adquirirLease(srv) {
  await liberarLeaseAtual(srv);
  const gatewayProcessId = randomUUID();
  const r = await assinado(srv, "POST", "/internal/comunicacao/lease/acquire", JSON.stringify({ gatewayProcessId, ttlMs: 45_000 }));
  const j = JSON.parse(r.corpo);
  assert.equal(j.acquired, true, `lease não adquirida: ${r.status} ${r.corpo}`);
  srv.leaseAtual = { gatewayProcessId, leaseEpoch: j.leaseEpoch };
  return srv.leaseAtual;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. unitário — envs e limites finitos
// ---------------------------------------------------------------------------------------------------------------------
describe("limites de corpo — leitura robusta e SEMPRE finita", () => {
  test("constantes: genérico 256 KiB, auth-state 1 MiB, teto absoluto 4 MiB", () => {
    assert.equal(LIMITE_CORPO_PADRAO_BYTES, 256 * KiB);
    assert.equal(LIMITE_AUTH_STATE_PADRAO_BYTES, 1 * MiB);
    assert.equal(LIMITE_AUTH_STATE_TETO_BYTES, 4 * MiB);
    assert.ok(Number.isFinite(LIMITE_AUTH_STATE_TETO_BYTES));
  });

  test("lerLimiteBytes: env ausente/vazia/lixo/zero/negativa/fracionária/Infinity/enorme -> padrão; inteiro seguro positivo -> ele mesmo", () => {
    for (const ruim of [undefined, null, "", "   ", "abc", "0", "-5", "1.5", "Infinity", "-Infinity", "NaN", "1e400", "99999999999999999999", {}, []]) {
      assert.equal(lerLimiteBytes(ruim, 777), 777, `valor ${JSON.stringify(ruim)} deveria cair no padrão`);
    }
    assert.equal(lerLimiteBytes("1048576", 777), 1048576);
    assert.equal(lerLimiteBytes(2097152, 777), 2097152);
  });

  test("o parser genérico com env corrompida NÃO vira NaN/ilimitado (bug anterior: Number('abc') -> NaN)", () => {
    process.env.WHATSAPP_GATEWAY_SECRET = SEGREDO; process.env.WHATSAPP_GATEWAY_ORGANIZACAO_ID = ORG;
    try {
      for (const ruim of ["abc", "0", "-1", "Infinity", ""]) {
        process.env.WHATSAPP_GATEWAY_MAX_BODY_BYTES = ruim;
        const gw = montarWhatsappGatewayRouter({ repo: criarRepoEmMemoria() });
        assert.equal(gw.limiteCorpoBytes, 256 * KiB, `MAX_BODY_BYTES=${JSON.stringify(ruim)}`);
      }
    } finally { restaurarEnv(); }
  });

  test("limite do auth-state: padrão 1 MiB; env lixo -> padrão; env grande é CAPADA no teto; nunca menor que o genérico", () => {
    process.env.WHATSAPP_GATEWAY_SECRET = SEGREDO; process.env.WHATSAPP_GATEWAY_ORGANIZACAO_ID = ORG;
    const montar = (envs) => {
      delete process.env.WHATSAPP_GATEWAY_MAX_BODY_BYTES; delete process.env.WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES;
      Object.assign(process.env, envs);
      return montarWhatsappGatewayRouter({ repo: criarRepoEmMemoria() });
    };
    try {
      assert.equal(montar({}).limiteAuthStateBytes, 1 * MiB);
      assert.equal(montar({}).limiteCorpoBytes, 256 * KiB);
      for (const ruim of ["abc", "0", "-3", "Infinity", "", "1.5"]) assert.equal(montar({ WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES: ruim }).limiteAuthStateBytes, 1 * MiB, ruim);
      assert.equal(montar({ WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES: String(2 * MiB) }).limiteAuthStateBytes, 2 * MiB);
      assert.equal(montar({ WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES: "1000000000000" }).limiteAuthStateBytes, 4 * MiB, "env enorme precisa ser capada — nunca 'ilimitado'");
      assert.equal(montar({ WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES: "1000" }).limiteAuthStateBytes, 256 * KiB, "nunca menor que o genérico");
      assert.equal(montar({ WHATSAPP_GATEWAY_MAX_BODY_BYTES: String(2 * MiB) }).limiteAuthStateBytes, 2 * MiB, "genérico maior que o padrão do auth-state -> auth-state acompanha");
    } finally { restaurarEnv(); }
  });

  test("estático: nenhum limite infinito no bootstrap e o parser DEDICADO vem ANTES do genérico", () => {
    const bruto = readFileSync(fileURLToPath(new URL("../src/modules/comunicacao/gateway/whatsappGateway.bootstrap.js", import.meta.url)), "utf8");
    // remove só JSDoc e comentários de linha INTEIRA — o "*/*" do código NÃO é comentário (o regex ingênuo o engolia)
    const src = bruto.replace(/^\s*\/\*\*[\s\S]*?\*\/\s*$/gm, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src, /Infinity|Number\.MAX|limit\s*:\s*(null|undefined|0)\b/);
    const dedicado = src.indexOf("rawAuthState(req, res, next)");
    const generico = src.indexOf("router.use(express.raw({ type: \"*/*\", limit: limiteCorpoBytes }))");
    const hmac = src.indexOf("router.use(exigirHmac(segredo))");
    assert.ok(dedicado > 0 && generico > 0 && hmac > 0);
    assert.ok(dedicado < generico, "o dedicado precisa vir ANTES do genérico (senão o genérico rejeita com 413 primeiro)");
    assert.ok(generico < hmac, "o HMAC continua depois dos parsers");
  });

  test("estático: app.js monta o gateway ANTES do express.json global (o limite global nunca participa das rotas internas)", () => {
    const app = readFileSync(fileURLToPath(new URL("../src/app.js", import.meta.url)), "utf8");
    assert.ok(app.indexOf("montarWhatsappGatewayRouter()") < app.indexOf("express.json({ limit: LIMITES_CORPO.padrao })"));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. router REAL — fronteiras exatas, ordem, demais rotas, HMAC
// ---------------------------------------------------------------------------------------------------------------------
describe("router REAL do backend — POST /eventos/auth-state (parser dedicado)", () => {
  let srv;
  before(async () => { _resetarNonces(); srv = await subir(); });
  after(async () => { await srv.fechar(); restaurarEnv(); });

  test("limites efetivos reportados pelo bootstrap", () => {
    assert.equal(srv.gw.limiteCorpoBytes, 256 * KiB);
    assert.equal(srv.gw.limiteAuthStateBytes, 1 * MiB);
  });

  test("REPRODUÇÃO DO INCIDENTE: body do tamanho do snapshot real (~253 KB) e o que o SEGUIA (> 262.144 B, antes 413) agora são ACEITOS e persistidos (200)", async () => {
    const lease = await adquirirLease(srv);
    for (const total of [100 * KiB, 252_925, 262_144, 262_145, 300 * KiB, 700 * KiB, 1 * MiB]) {
      const c = corpoAuth(total, lease);
      const r = await assinado(srv, "POST", AUTH, c);
      assert.equal(r.status, 200, `body de ${Buffer.byteLength(c)} B -> ${r.status} ${r.corpo.slice(0, 80)}`);
    }
    const guardado = await srv.repo.obterAuthState(ORG, lease);
    assert.equal(guardado.authStateEncrypted.length, (1 * MiB) - Buffer.byteLength(corpoAuth(1 * MiB, lease)) + guardado.authStateEncrypted.length, "sanidade do cálculo");
    assert.equal(Buffer.byteLength(corpoAuth(1 * MiB, lease)), 1 * MiB, "o último body enviado tinha EXATAMENTE 1 MiB");
  });

  test("acima do novo limite continua 413 (finito): 1 MiB + 1 e 2 MiB", async () => {
    const lease = await adquirirLease(srv);
    for (const total of [1 * MiB + 1, 2 * MiB, 3 * MiB]) {
      const r = await assinado(srv, "POST", AUTH, corpoAuth(total, lease));
      assert.equal(r.status, 413, `body de ${total} B deveria ser 413, veio ${r.status}`);
    }
  });

  test("o 413 acima do limite é a resposta do errorHandler (mensagem estável), nunca 500", async () => {
    const lease = await adquirirLease(srv);
    const r = await assinado(srv, "POST", AUTH, corpoAuth(2 * MiB, lease));
    assert.equal(r.status, 413);
    assert.match(r.corpo, /grande/i);
  });

  test("variações de caminho da MESMA rota (barra final, caixa) usam o parser dedicado; outras rotas de auth-state NÃO", async () => {
    const lease = await adquirirLease(srv);
    for (const cam of [`${AUTH}/`, "/internal/comunicacao/EVENTOS/AUTH-STATE"]) {
      const r = await assinado(srv, "POST", cam, corpoAuth(400 * KiB, lease));
      assert.notEqual(r.status, 413, `${cam} deveria ter passado pelo parser dedicado`);
    }
    for (const cam of [`${AUTH}/reset`, `${AUTH}/confirmar`]) {
      const r = await assinado(srv, "POST", cam, corpoGenerico(300 * KiB));
      assert.equal(r.status, 413, `${cam} NÃO pode ganhar o limite grande`);
    }
  });

  test("só o MÉTODO POST ganha o parser dedicado (PUT/PATCH com 400 KiB na mesma rota seguem em 256 KiB)", async () => {
    for (const metodo of ["PUT", "PATCH", "DELETE"]) {
      const r = await assinado(srv, metodo, AUTH, corpoAuth(400 * KiB));
      assert.equal(r.status, 413, metodo);
    }
  });
});

describe("as DEMAIS rotas internas continuam em 256 KiB (fronteira exata) — o limite grande NÃO vazou", () => {
  let srv;
  before(async () => { _resetarNonces(); srv = await subir(); });
  after(async () => { await srv.fechar(); restaurarEnv(); });

  for (const cam of ["/eventos/heartbeat", "/lease/acquire", "/lease/renew", "/lease/release", "/eventos/auth-state/reset", "/eventos/auth-state/confirmar", "/eventos/mensagem-recebida", "/eventos/status-mensagem", "/estado-conexao"]) {
    test(`POST ${cam}: 262.144 B passa pelo parser; 262.145 B -> 413`, async () => {
      const dentro = await assinado(srv, "POST", `/internal/comunicacao${cam}`, corpoGenerico(256 * KiB));
      assert.notEqual(dentro.status, 413, `${cam}: 256 KiB exatos foram rejeitados`);
      const fora = await assinado(srv, "POST", `/internal/comunicacao${cam}`, corpoGenerico(256 * KiB + 1));
      assert.equal(fora.status, 413, `${cam}: 256 KiB + 1 deveria ser 413, veio ${fora.status}`);
    });
  }

  test("o parser global (express.json, 1 MB) nunca participa: um body de 900 KiB numa rota genérica é 413 pelo parser da rota, não passa", async () => {
    const r = await assinado(srv, "POST", "/internal/comunicacao/eventos/heartbeat", corpoGenerico(900 * KiB));
    assert.equal(r.status, 413);
  });
});

describe("HMAC e anti-replay INTACTOS com o parser dedicado", () => {
  let srv;
  before(async () => { _resetarNonces(); srv = await subir(); });
  after(async () => { await srv.fechar(); restaurarEnv(); });

  test("sem NENHUM header de assinatura: 401 (a rota não vira API pública), mesmo com body enorme — sem ler o corpo grande", async () => {
    for (const total of [1 * KiB, 400 * KiB]) {
      const r = await enviar(srv.url, "POST", AUTH, corpoAuth(total), {});
      assert.equal(r.status, 401, `sem assinatura (${total} B)`);
    }
    // 2 MiB sem assinatura: ou 401, ou a conexão é encerrada pelo servidor antes de ler — NUNCA 200 e NUNCA processado
    const r2 = await enviar(srv.url, "POST", AUTH, corpoAuth(2 * MiB), {});
    assert.ok(r2.status === 401 || String(r2.status).startsWith("ERR:"), `2 MiB sem assinatura -> ${r2.status}`);
  });

  test("headers de assinatura INCOMPLETOS (falta 1 dos 3): 401 antes de ler o corpo", async () => {
    const completo = assinarRequisicao({ segredo: SEGREDO, metodo: "POST", caminho: AUTH, corpo: corpoAuth(400 * KiB) });
    for (const falta of Object.keys(completo)) {
      const h = { ...completo }; delete h[falta];
      const r = await enviar(srv.url, "POST", AUTH, corpoAuth(400 * KiB), h);
      assert.equal(r.status, 401, `sem ${falta}`);
    }
  });

  test("assinatura errada / corpo adulterado / timestamp fora da janela: 401 (o corpo grande é lido, mas o HMAC decide)", async () => {
    const c = corpoAuth(400 * KiB);
    const h = assinarRequisicao({ segredo: SEGREDO, metodo: "POST", caminho: AUTH, corpo: c });
    assert.equal((await enviar(srv.url, "POST", AUTH, c, { ...h, "X-Gateway-Signature": "0".repeat(64) })).status, 401, "assinatura errada");
    const h2 = assinarRequisicao({ segredo: SEGREDO, metodo: "POST", caminho: AUTH, corpo: c });
    assert.equal((await enviar(srv.url, "POST", AUTH, c.replace("AAAA", "AAAB"), h2)).status, 401, "corpo adulterado");
    const velho = { ...assinarRequisicao({ segredo: SEGREDO, metodo: "POST", caminho: AUTH, corpo: c }), "X-Gateway-Timestamp": String(Date.now() - 3_600_000) };
    assert.equal((await enviar(srv.url, "POST", AUTH, c, velho)).status, 401, "timestamp antigo");
  });

  test("anti-replay: reenviar a MESMA requisição assinada (body grande) é recusado na 2ª vez", async () => {
    const lease = await adquirirLease(srv);
    const c = corpoAuth(400 * KiB, lease);
    const h = assinarRequisicao({ segredo: SEGREDO, metodo: "POST", caminho: AUTH, corpo: c });
    assert.equal((await enviar(srv.url, "POST", AUTH, c, h)).status, 200);
    assert.equal((await enviar(srv.url, "POST", AUTH, c, h)).status, 401, "replay aceito");
  });

  test("fencing continua exigido (body grande, lease/epoch errados -> 409, nada é gravado)", async () => {
    const lease = await adquirirLease(srv);
    const r = await assinado(srv, "POST", AUTH, corpoAuth(400 * KiB, { gatewayProcessId: randomUUID(), leaseEpoch: lease.leaseEpoch }));
    assert.equal(r.status, 409);
    const r2 = await assinado(srv, "POST", AUTH, JSON.stringify({ authStateEncrypted: "x".repeat(400 * KiB), authStateVersion: "v1" }));
    assert.equal(r2.status, 400, "sem gatewayProcessId/leaseEpoch");
  });
});

describe("env: o limite do auth-state é configurável, mas FINITO", () => {
  test("WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES=2 MiB: 2 MiB passa, 2 MiB + 1 -> 413; genérico intacto", async () => {
    const srv = await subir({ env: { WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES: String(2 * MiB) } });
    try {
      assert.equal(srv.gw.limiteAuthStateBytes, 2 * MiB);
      const lease = await adquirirLease(srv);
      assert.equal((await assinado(srv, "POST", AUTH, corpoAuth(2 * MiB, lease))).status, 200);
      assert.equal((await assinado(srv, "POST", AUTH, corpoAuth(2 * MiB + 1, lease))).status, 413);
      assert.equal((await assinado(srv, "POST", "/internal/comunicacao/eventos/heartbeat", corpoGenerico(256 * KiB + 1))).status, 413);
    } finally { await srv.fechar(); }
  });

  test("env absurda é capada no teto de 4 MiB: 4 MiB passa, 4 MiB + 1 -> 413", async () => {
    const srv = await subir({ env: { WHATSAPP_GATEWAY_AUTH_STATE_MAX_BODY_BYTES: "9007199254740991" } });
    try {
      assert.equal(srv.gw.limiteAuthStateBytes, 4 * MiB);
      const lease = await adquirirLease(srv);
      assert.equal((await assinado(srv, "POST", AUTH, corpoAuth(4 * MiB, lease))).status, 200);
      assert.equal((await assinado(srv, "POST", AUTH, corpoAuth(4 * MiB + 1, lease))).status, 413);
    } finally { await srv.fechar(); }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. ponta a ponta: Gateway REAL (cliente + adaptador de auth + cripto) -> backend REAL -> repo
// ---------------------------------------------------------------------------------------------------------------------
/** Chaves/creds FICTÍCIOS (bytes aleatórios): ~`nSessoes` entradas "session" de ~1,5 KB cada. */
function popularAuthFicticio(adapter, nSessoes) {
  adapter.inicializarCreds({ noiseKey: { private: randomBytes(32), public: randomBytes(32) }, registrationId: 4242, advSecretKey: randomBytes(32).toString("base64"), nextPreKeyId: 31 });
  const dados = { session: {}, "app-state-sync-version": {} };
  for (let i = 0; i < nSessoes; i++) dados.session[`5511${String(i).padStart(9, "0")}.0`] = randomBytes(1500);
  dados["app-state-sync-version"].regular = { version: 7, hash: randomBytes(128), indexValueMap: { a: { valueMac: randomBytes(32) } } };
  return dados;
}
const digest = (o) => createHash("sha256").update(JSON.stringify(o, (_k, v) => (v && v.type === "Buffer" ? Buffer.from(v.data).toString("hex") : (Buffer.isBuffer(v) ? v.toString("hex") : v)))).digest("hex");

async function montarGateway(srv) {
  await liberarLeaseAtual(srv);
  const backendClient = criarBackendClient({ backendUrl: srv.url, segredoHmac: SEGREDO, timeoutMs: 30_000 });
  const gatewayProcessId = randomUUID();
  const lease = await backendClient.adquirirLease({ gatewayProcessId, ttlMs: 45_000 });
  assert.equal(lease.acquired, true);
  const contexto = { gatewayProcessId, leaseEpoch: lease.leaseEpoch };
  srv.leaseAtual = contexto;
  const novo = () => criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_CRIPTO, obterContextoLease: () => contexto, aoLeaseStale: () => {} });
  return { backendClient, contexto, novo };
}

describe("PONTA A PONTA (cliente e adaptador REAIS do Gateway -> router REAL -> repo em memória): auth-state grande NÃO dá 413", () => {
  let srv;
  before(async () => { _resetarNonces(); srv = await subir(); });
  after(async () => { await srv.fechar(); restaurarEnv(); });

  test("blob ~800 KB (3x o limite antigo): persiste SEM 413 e um 'restart' (adaptador novo) recarrega IDÊNTICO — cripto real, ida e volta", async () => {
    const { novo } = await montarGateway(srv);
    const a1 = novo();
    const dados = popularAuthFicticio(a1, 380); // ~380 x 1,5 KB (em base64 no JSON ≈ 2 KB) -> > 700 KB em claro
    await a1.comoAuthState().keys.set(dados); // dispara persistir() -> POST real assinado
    const antes = { creds: a1.comoAuthState().creds, sessoes: Object.keys(dados.session).length };

    const a2 = novo(); // "restart do processo": memória zerada, só o que o backend guardou
    const r = await a2.carregar();
    assert.equal(r.status, "loaded");
    const s2 = a2.comoAuthState();
    assert.equal(digest(s2.creds), digest(antes.creds), "creds diferentes após ida e volta");
    const ids = Object.keys(dados.session);
    const lidas = await s2.keys.get("session", ids);
    assert.equal(Object.keys(lidas).length, antes.sessoes);
    for (const id of [ids[0], ids[190], ids[379]]) assert.ok(Buffer.compare(Buffer.from(lidas[id]), dados.session[id]) === 0, `sessão ${id} adulterada`);
  });

  test("o backend guardou um blob MAIOR que o limite antigo (prova de que o caso do incidente está coberto)", async () => {
    const { novo, contexto } = await montarGateway(srv);
    const a = novo();
    await a.comoAuthState().keys.set(popularAuthFicticio(a, 300));
    const guardado = await srv.repo.obterAuthState(ORG, contexto);
    assert.equal(guardado.status, "present");
    assert.ok(guardado.authStateEncrypted.length > 256 * KiB, `cifrado de ${guardado.authStateEncrypted.length} chars não ultrapassou o limite antigo`);
    assert.ok(guardado.authStateEncrypted.startsWith("v1:"), "formato cifrado v1 (AES-GCM real)");
  });

  test("REGRESSÃO CONTROLADA: acima do limite finito o Gateway recebe erro de status 413 (e a persistência REJEITA — não é aceita em silêncio)", async () => {
    const { novo } = await montarGateway(srv);
    const a = novo();
    const dados = popularAuthFicticio(a, 700); // > 1 MiB de body
    await assert.rejects(() => a.comoAuthState().keys.set(dados), (e) => {
      // o Gateway mapeia para WHATSAPP_GATEWAY_UNAVAILABLE (503); o status REAL do backend fica em `detalheInterno.status`
      assert.equal(e?.codigo, "WHATSAPP_GATEWAY_UNAVAILABLE");
      assert.equal(e?.detalheInterno?.status, 413, JSON.stringify({ codigo: e?.codigo, detalheInterno: e?.detalheInterno }).slice(0, 200));
      return true;
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. integração — até o Supabase REAL de TESTE (PostgREST/RPC aceitam o payload grande?)
// ---------------------------------------------------------------------------------------------------------------------
const PULAR_INTEGRACAO = motivoPularIntegracao();
describe("INTEGRAÇÃO (banco de TESTE): Gateway -> backend -> Supabase com blob grande", { skip: PULAR_INTEGRACAO }, () => {
  let orgId = null; let ok083 = true; let ok084 = true;
  before(async () => {
    ok083 = await migracao083Aplicada(); ok084 = await migracao084Aplicada();
    if (ok083 && ok084) orgId = await criarOrganizacao("TESTE gateway auth-state grande — descartável");
  });
  after(async () => { await apagarOrganizacao(orgId); restaurarEnv(); });

  test("blob de ~800 KB cifrado real: persiste no Supabase (sem 413 e sem erro do PostgREST) e o 'restart' recarrega idêntico", async (t) => {
    if (!ok083 || !ok084) return t.skip("migrations 083/084 ainda não aplicadas no banco de teste");
    _resetarNonces();
    const srv = await subir({ repo: criarRepoSupabase(), organizacaoId: orgId });
    try {
      const { novo, contexto } = await montarGateway(srv);
      const a1 = novo();
      const dados = popularAuthFicticio(a1, 380);
      await a1.comoAuthState().keys.set(dados);
      const linha = await srv.repo.obterAuthState(orgId, contexto);
      assert.equal(linha.status, "present");
      assert.ok(linha.authStateEncrypted.length > 700 * KiB, `só ${linha.authStateEncrypted.length} chars foram guardados`);

      const a2 = novo();
      assert.equal((await a2.carregar()).status, "loaded");
      assert.equal(digest(a2.comoAuthState().creds), digest(a1.comoAuthState().creds));
      const lidas = await a2.comoAuthState().keys.get("session", Object.keys(dados.session));
      assert.equal(Object.keys(lidas).length, 380);
    } finally { await srv.fechar(); }
  });
});
