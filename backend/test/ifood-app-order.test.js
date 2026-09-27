// appType = "order" — Events/Order falam com o AUTH PROVIDER, nunca com o `financial`.
//
//   Events / Order  ─▶  Auth Provider (comAccessTokenValido, appType = 'order')
//                          ├─ centralized_test: token do app centralizado (Teste (C)), sem credencial por unidade
//                          └─ distributed:      credencial `order` da conexão (quando o app real existir)
//
// Rodar: node --experimental-vm-modules --test test/ifood-app-order.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";

import {
  IFOOD_APPS, IFOOD_APP_TYPES, IFOOD_APP_ORDER, IFOOD_APP_TYPES_PERSISTIVEIS,
} from "../src/modules/ifood/ifood.constants.js";
import { IFOOD_ERROS, IfoodError } from "../src/modules/ifood/ifood.errors.js";
import { validarAppType } from "../src/modules/ifood/ifood.validators.js";
import { criarProviderCentralizadoTeste } from "../src/modules/ifood/ifoodAuthProvider.js";
import * as tokenService from "../src/modules/ifood/ifoodToken.service.js";
import { criarPoller } from "../src/modules/ifood/ifoodEvents.poller.js";
import * as clienteReal from "../src/modules/ifood/ifoodEvents.client.js";
import { PROJETO_TESTE_REF } from "../src/modules/ifood/ifood.ambienteTeste.js";
import { criarRepoEmMemoria, criarClienteFake, criarRelogio, ev } from "./helpers/ifood-events-fakes.js";

const { cifrar } = await import("../src/shared/cripto.js");
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(path.join(AQUI, "..", f), "utf8");
const semComentarios = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const rejeita = (p, codigo) => assert.rejects(p, (e) => e instanceof IfoodError && e.codigo === codigo, `esperava ${codigo}`);

test("constantes: 'order' existe como app persistível, mas NÃO é exposto ao OAuth/UI/status (nada do produto distribuído mudou)", () => {
  assert.equal(IFOOD_APP_ORDER, "order");
  assert.deepEqual([...IFOOD_APP_TYPES], ["analytics", "financial"], "apps de OAuth da UI seguem os mesmos");
  assert.deepEqual([...IFOOD_APP_TYPES_PERSISTIVEIS], ["analytics", "financial", "order"], "espelha o CHECK do banco (migration 101)");
  assert.equal(IFOOD_APPS.ORDER, undefined);
  assert.throws(() => validarAppType("order"), (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_TYPE_INVALIDO, "não dá para iniciar OAuth de 'order' pela API ainda");
  assert.throws(() => tokenService.credenciaisDoApp("order"), (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_TYPE_INVALIDO);
});

test("o poller de Events pede o token como appType = 'order' (nunca 'financial')", async () => {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio });
  const chamadas = [];
  const token = { escopoDoToken: () => "app", comAccessTokenValido: async ({ conexaoId, appType, fn }) => { chamadas.push({ conexaoId, appType }); return fn("tok"); } };
  const client = criarClienteFake(clienteReal, { respostasPolling: [[ev("e1", "PLC", { min: 1 })]] });
  const poller = criarPoller({ repo, token, client, holder: "w", agora: relogio.agora, log: () => {} });
  await poller.executarCiclo();
  assert.ok(chamadas.length >= 2, "poll + ACK");
  assert.ok(chamadas.every((c) => c.appType === "order"), JSON.stringify(chamadas));
});

test("Events/Order (poller, serviço, cliente, repositório, worker) NÃO referenciam o app financial no código", () => {
  for (const f of [
    "src/modules/ifood/ifoodEvents.poller.js", "src/modules/ifood/ifoodEvents.service.js", "src/modules/ifood/ifoodEvents.client.js",
    "src/modules/ifood/ifoodEvents.repository.js", "src/modules/ifood/ifoodEvents.parser.js", "src/worker-ifood/index.js", "src/worker-ifood/config.js",
  ]) {
    const codigo = semComentarios(src(f));
    assert.doesNotMatch(codigo, /IFOOD_APPS\b|FINANCIAL|["']financial["']/i, `${f} não pode depender do financial`);
  }
  assert.match(semComentarios(src("src/modules/ifood/ifoodEvents.poller.js")), /appType = IFOOD_APP_ORDER/);
});

test("Merchant continua com o app financial (a API de Merchant vive nele) — só Events/Order mudaram", () => {
  const m = semComentarios(src("src/modules/ifood/ifoodMerchant.service.js"));
  assert.match(m, /appType: IFOOD_APPS\.FINANCIAL/);
});

// --- centralized_test -----------------------------------------------------------------------
test("centralized_test + appType 'order': usa o token do app centralizado (Teste C), sem credencial e sem tocar no banco", async () => {
  const repoQueNaoPodeSerUsado = new Proxy({}, { get: (_, k) => () => { throw new Error(`repo.${String(k)} não deveria ser chamado`); } });
  const http = { postForm: async () => ({ accessToken: "TOKEN-CENTRALIZADO-C", expiresIn: 21600 }) };
  const provider = criarProviderCentralizadoTeste({
    cfg: { ifood: { centralizedTest: { modo: true, clientId: "id-c", clientSecret: "secret-c" } } },
    env: { SUPABASE_URL: `https://${PROJETO_TESTE_REF}.supabase.co` },
  });
  const r = await tokenService.comAccessTokenValido({
    conexaoId: null, appType: "order", deps: { repo: repoQueNaoPodeSerUsado, http, provider },
    fn: async (t) => t,
  });
  assert.equal(r, "TOKEN-CENTRALIZADO-C");
  assert.equal(provider.escopoDoToken, "app");
});

// --- distributed ---------------------------------------------------------------------------------
function repoDistribuido(credenciais) {
  const consultas = [];
  return {
    consultas,
    obterCredencial: async ({ conexaoId, appType }) => { consultas.push({ conexaoId, appType }); return credenciais[appType] ?? null; },
    atualizarCredencial: async () => ({}),
  };
}
const daquiA = (ms) => new Date(Date.now() + ms).toISOString();

test("distributed + appType 'order' SEM credencial 'order': erro claro — NÃO usa a credencial do financial", async () => {
  const repo = repoDistribuido({ financial: { access_token_cifrado: cifrar("TOKEN-DO-FINANCIAL"), refresh_token_cifrado: cifrar("rt"), expira_em: daquiA(3600_000), status: "ativa" } });
  let fnChamada = false;
  await rejeita(tokenService.comAccessTokenValido({
    conexaoId: "con-1", appType: "order", deps: { repo, http: {} },
    fn: async () => { fnChamada = true; return "x"; },
  }), IFOOD_ERROS.IFOOD_CREDENCIAL_NAO_ENCONTRADA);
  assert.equal(fnChamada, false);
  assert.deepEqual(repo.consultas, [{ conexaoId: "con-1", appType: "order" }], "consultou SÓ a credencial 'order'");
});

test("distributed + appType 'order' COM credencial 'order': usa o token dela (e não o do financial)", async () => {
  const repo = repoDistribuido({
    financial: { access_token_cifrado: cifrar("TOKEN-DO-FINANCIAL"), refresh_token_cifrado: cifrar("rt"), expira_em: daquiA(3600_000), status: "ativa" },
    order: { access_token_cifrado: cifrar("TOKEN-DO-ORDER"), refresh_token_cifrado: cifrar("rt"), expira_em: daquiA(3600_000), status: "ativa" },
  });
  const usado = await tokenService.comAccessTokenValido({ conexaoId: "con-1", appType: "order", deps: { repo, http: {} }, fn: async (t) => t });
  assert.equal(usado, "TOKEN-DO-ORDER");
});

test("distributed 'order' em reauth_required NÃO cai para outro app", async () => {
  const repo = repoDistribuido({ order: { access_token_cifrado: cifrar("x"), refresh_token_cifrado: cifrar("y"), expira_em: daquiA(3600_000), status: "reauth_required" } });
  await rejeita(tokenService.comAccessTokenValido({ conexaoId: "con-1", appType: "order", deps: { repo, http: {} }, fn: async () => "x" }), IFOOD_ERROS.IFOOD_REFRESH_FALHOU);
});

// --- migration -------------------------------------------------------------------------------------
test("migration 101 amplia os CHECKs de app_type para (analytics, financial, order) sem editar o arquivo da 056", () => {
  const sql = src("../database/migrations/101_ifood_eventos.sql").toLowerCase();
  assert.match(sql, /ifood_credenciais_app_type_check\s+check \(app_type in \('analytics', 'financial', 'order'\)\)/);
  assert.match(sql, /ifood_oauth_sessoes_app_type_check\s+check \(app_type in \('analytics', 'financial', 'order'\)\)/);
  const s056 = src("../database/migrations/056_ifood_integracao.sql");
  assert.match(s056, /app_type text not null check \(app_type in \('analytics', 'financial'\)\)/, "o arquivo da 056 continua exatamente como era");
  assert.doesNotMatch(s056, /'order'/);
});
