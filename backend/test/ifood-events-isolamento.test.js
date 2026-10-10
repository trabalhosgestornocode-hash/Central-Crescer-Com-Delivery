// Events do iFood — uma loja NUNCA impede o polling das outras (multi-tenant).
//
// Cenário base (modo distribuído, um grupo por conexão): A saudável, B com problema, C saudável.
// Defesa 1 (seleção): só conexões com credencial `order`; `reauth_required` é pulada sem chamar o iFood.
// Defesa 2 (isolamento): falha de B vira `conexoesComFalha` e A e C são processadas e reconhecidas.
// Globais de propósito: 429 (throttling do app) e lease perdido. Todas falharem -> o erro sobe (backoff).
// Sem rede e sem banco.
import test from "node:test";
import assert from "node:assert/strict";

import * as clienteReal from "../src/modules/ifood/ifoodEvents.client.js";
import { criarPoller, criarLoopDoPoller } from "../src/modules/ifood/ifoodEvents.poller.js";
import { listarConexoesElegiveisParaEvents } from "../src/modules/ifood/ifoodEvents.repository.js";
import * as tokenService from "../src/modules/ifood/ifoodToken.service.js";
import { IFOOD_EVENTS } from "../src/modules/ifood/ifood.constants.js";
import { IFOOD_ERROS } from "../src/modules/ifood/ifood.errors.js";
import { mascararId } from "../src/modules/ifood/ifood.logsafe.js";
import {
  criarRepoEmMemoria, criarRelogio, criarClienteFake, erroIfood, ev, M_A, M_B, CONEXAO_A, CONEXAO_B, pilotoDe
} from "./helpers/ifood-events-fakes.js";

const M_C = "cccccccc-0000-4000-8000-00000000000c";
const CONEXAO_C = { id: "con-c", organizacao_id: "org-c", unidade_id: "un-c", merchant_id: M_C };
const TOKEN_SECRETO = "tok-super-secreto-nao-logar";

// Resposta do polling por merchant (a fila do fake é consumida na ordem A, B, C).
const porMerchant = (mapa) => Array.from({ length: 10 }, () => ({ merchantIds }) => {
  const r = mapa[merchantIds[0]];
  return typeof r === "function" ? r() : (r ?? []);
});
const eventosPadrao = () => ({
  [M_A]: [ev("ea", "PLC", { orderId: "oa", merchantId: M_A, min: 1 })],
  [M_B]: [ev("eb", "PLC", { orderId: "ob", merchantId: M_B, min: 1 })],
  [M_C]: [ev("ec", "PLC", { orderId: "oc", merchantId: M_C, min: 1 })],
});

/** Token de escopo 'conexao'; `porConexao[conexaoId]` pode ser um Error (lançado antes do polling). */
function tokenPorConexao(porConexao = {}) {
  const chamadas = [];
  return {
    chamadas,
    escopoDoToken: () => "conexao",
    async comAccessTokenValido({ conexaoId, appType, fn }) {
      chamadas.push({ conexaoId, appType });
      if (porConexao[conexaoId] instanceof Error) throw porConexao[conexaoId];
      return fn(TOKEN_SECRETO);
    },
  };
}

function montar({ conexoes = [CONEXAO_A, CONEXAO_B, CONEXAO_C], respostas, token = tokenPorConexao(), relogio = criarRelogio() } = {}) {
  const repo = criarRepoEmMemoria({ relogio, conexoes });
  const client = criarClienteFake(clienteReal, { respostasPolling: respostas ?? porMerchant(eventosPadrao()) });
  const logs = [];
  const log = (nivel, evento, dados) => logs.push({ nivel, evento, dados });
  const poller = criarPoller({ repo, token, client, holder: "worker-1", agora: relogio.agora, log, leaseTtlS: 90, unidadesPiloto: pilotoDe(repo) });
  return { repo, client, token, poller, logs };
}
const merchantsPollados = (client) => client.polls.map((p) => p.merchantIds[0]);
const idsReconhecidos = (client) => client.acks.flatMap((a) => a.eventIds).sort();

// ===========================================================================
// DEFESA 1 — seleção das conexões
// ===========================================================================
test("B só com analytics/financial (sem credencial order): nem entra no ciclo; A e C processadas", async () => {
  const { poller, client, token, repo } = montar({ conexoes: [CONEXAO_A, { ...CONEXAO_B, credOrder: null }, CONEXAO_C] });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.deepEqual(merchantsPollados(client), [M_A, M_C]);
  assert.ok(!token.chamadas.some((c) => c.conexaoId === "con-b"), "nenhum token pedido para B");
  assert.deepEqual(idsReconhecidos(client), ["ea", "ec"]);
  assert.ok(repo.chamadas.includes("listarConexoesElegiveisParaEvents"));
  assert.ok(!repo.chamadas.includes("listarConexoesComMerchant"), "distribuído não usa a lista sem filtro");
});

test("B em reauth_required: pulada SEM chamar o iFood, monitorável no resultado; A e C processadas", async () => {
  const { poller, client, token, logs } = montar({ conexoes: [CONEXAO_A, { ...CONEXAO_B, credOrder: "reauth_required" }, CONEXAO_C] });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.deepEqual(merchantsPollados(client), [M_A, M_C]);
  assert.ok(!token.chamadas.some((c) => c.conexaoId === "con-b"));
  assert.deepEqual(idsReconhecidos(client), ["ea", "ec"]);
  assert.equal(r.conexoesIgnoradas.length, 1);
  assert.deepEqual({ ...r.conexoesIgnoradas[0], em: "x" }, { conexaoId: "con-b", merchant: mascararId(M_B), motivo: "reauth_required", em: "x" });
  assert.ok(logs.some((l) => l.evento === "events.conexao_ignorada" && l.nivel === "warn"));
});

// ===========================================================================
// DEFESA 2 — isolamento por conexão
// ===========================================================================
test("B listada mas sem credencial no momento do token: B isolada (autenticacao); A e C processadas e reconhecidas", async () => {
  const token = tokenPorConexao({ "con-b": erroIfood("IFOOD_CREDENCIAL_NAO_ENCONTRADA") });
  const { poller, client, repo } = montar({ token });
  const r = await poller.executarCiclo();   // NÃO lança
  assert.equal(r.estado, "PARCIAL");
  assert.deepEqual(merchantsPollados(client), [M_A, M_C]);
  assert.deepEqual(idsReconhecidos(client), ["ea", "ec"]);
  assert.ok(repo.eventos.get("ea").acknowledged_at && repo.eventos.get("ec").acknowledged_at);
  assert.equal(r.conexoesComFalha.length, 1);
  const f = r.conexoesComFalha[0];
  assert.equal(f.conexaoId, "con-b");
  assert.equal(f.merchant, mascararId(M_B));
  assert.equal(f.codigo, IFOOD_ERROS.IFOOD_CREDENCIAL_NAO_ENCONTRADA);
  assert.equal(f.etapa, "autenticacao");
  assert.match(f.em, /^\d{4}-\d{2}-\d{2}T/);
});

test("401 SÓ em B, com o refresh falhando (comAccessTokenValido REAL): B isolada; A e C seguem; refresh só de B, uma vez", async () => {
  const renovacoes = [];
  const provider = {
    modo: "distributed",
    escopoDoToken: "conexao",
    async getAccessToken({ conexaoId }) { return `tok-${conexaoId}`; },
    async renovarAposRejeicao({ conexaoId }) { renovacoes.push(conexaoId); throw erroIfood("IFOOD_REFRESH_FALHOU"); },
  };
  const token = {
    escopoDoToken: () => "conexao",
    comAccessTokenValido: (a) => tokenService.comAccessTokenValido({ ...a, deps: { ...(a.deps ?? {}), provider } }),
  };
  const { poller, client } = montar({ token });
  // o iFood responde 401 SÓ para o token de B (os de A e C seguem normais)
  const buscar = client.buscarEventos;
  const tokensUsados = [];
  client.buscarEventos = async (a) => {
    tokensUsados.push(a.accessToken);
    if (a.accessToken === "tok-con-b") throw erroIfood("IFOOD_TOKEN_EXPIRADO");
    return buscar(a);
  };
  const r = await poller.executarCiclo();
  assert.deepEqual(tokensUsados, ["tok-con-a", "tok-con-b", "tok-con-c"], "cada loja com o SEU token; B não repete o polling");
  assert.equal(r.estado, "PARCIAL");
  assert.deepEqual(renovacoes, ["con-b"], "refresh tentado só para B, uma vez");
  assert.deepEqual(idsReconhecidos(client), ["ea", "ec"]);
  assert.equal(r.conexoesComFalha.length, 1);
  assert.equal(r.conexoesComFalha[0].conexaoId, "con-b");
  assert.equal(r.conexoesComFalha[0].codigo, IFOOD_ERROS.IFOOD_REFRESH_FALHOU);
  assert.equal(r.conexoesComFalha[0].etapa, "autenticacao");
});

test("5xx no polling de B: B isolada (polling), nada de B reconhecido; A e C processadas", async () => {
  const mapa = eventosPadrao();
  mapa[M_B] = () => erroIfood("IFOOD_INDISPONIVEL", { status: 503 });
  const { poller, client } = montar({ respostas: porMerchant(mapa) });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "PARCIAL");
  assert.deepEqual(idsReconhecidos(client), ["ea", "ec"]);
  assert.deepEqual(r.conexoesComFalha.map((f) => [f.conexaoId, f.codigo, f.etapa]), [["con-b", IFOOD_ERROS.IFOOD_INDISPONIVEL, "polling"]]);
});

test("falha ao PERSISTIR o lote de B: B isolada (persistir), o evento de B NÃO é reconhecido e volta; C processada", async () => {
  const mapa = eventosPadrao();
  let repoRef;
  const eventosB = mapa[M_B];
  mapa[M_B] = () => { repoRef.falhar.inserirEventos = 1; return eventosB; };
  const m = montar({ respostas: porMerchant(mapa) });
  repoRef = m.repo;
  const r = await m.poller.executarCiclo();
  assert.equal(r.estado, "PARCIAL");
  assert.deepEqual(idsReconhecidos(m.client), ["ea", "ec"]);
  assert.equal(m.repo.eventos.has("eb"), false);
  assert.deepEqual(r.conexoesComFalha.map((f) => [f.conexaoId, f.etapa]), [["con-b", "persistir"]]);
});

test("TODAS as conexões falham: o erro sobe (o loop aplica backoff) — mesmo comportamento de antes com uma loja", async () => {
  const falha = () => erroIfood("IFOOD_INDISPONIVEL");
  const { poller, client } = montar({ respostas: porMerchant({ [M_A]: falha, [M_B]: falha, [M_C]: falha }) });
  await assert.rejects(poller.executarCiclo(), (e) => e.codigo === IFOOD_ERROS.IFOOD_INDISPONIVEL);
  assert.equal(client.acks.length, 0);
  assert.equal(client.polls.length, 3, "tentou as três antes de desistir do ciclo");
});

test("429 em B: throttling é do APP — o ciclo para (RATE_LIMITED) sem tentar C; o que já foi de A fica reconhecido", async () => {
  const mapa = eventosPadrao();
  mapa[M_B] = () => erroIfood("IFOOD_RATE_LIMITED");
  const { poller, client } = montar({ respostas: porMerchant(mapa) });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "RATE_LIMITED");
  assert.deepEqual(merchantsPollados(client), [M_A, M_B]);
  assert.deepEqual(idsReconhecidos(client), ["ea"]);
});

test("logs da falha: conexão, merchant MASCARADO, código, etapa e horário — nunca token, merchant completo ou header", async () => {
  const erroComHeader = erroIfood("IFOOD_REFRESH_FALHOU");
  erroComHeader.message = `Authorization: Bearer ${TOKEN_SECRETO} rejeitado`;   // pior caso: mensagem com o header
  const token = tokenPorConexao({ "con-b": erroComHeader });
  const { poller, logs } = montar({ token });
  await poller.executarCiclo();
  const falha = logs.find((l) => l.evento === "events.conexao_falhou");
  assert.ok(falha);
  assert.equal(falha.nivel, "error");
  for (const campo of ["conexaoId", "merchant", "codigo", "etapa", "em"]) assert.ok(falha.dados[campo], campo);
  const tudo = JSON.stringify(logs);
  assert.ok(!tudo.includes(TOKEN_SECRETO), "token vazou no log");
  assert.ok(!tudo.includes(M_B), "merchant completo vazou no log");
  assert.doesNotMatch(tudo, /authorization/i);
});

test("modo centralizado (escopo 'app'): continua com TODAS as conexões com merchant, num grupo só", async () => {
  const token = { escopoDoToken: () => "app", comAccessTokenValido: async ({ fn }) => fn(TOKEN_SECRETO) };
  const { poller, client, repo } = montar({ token, conexoes: [CONEXAO_A, { ...CONEXAO_B, credOrder: null }], respostas: [[]] });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.deepEqual(client.polls[0].merchantIds, [M_A, M_B]);
  assert.ok(repo.chamadas.includes("listarConexoesComMerchant"));
});

test("só conexões em reauth_required: nada é chamado no iFood e o ciclo não falha (SEM_CONEXOES_APTAS)", async () => {
  const { poller, client } = montar({ conexoes: [{ ...CONEXAO_A, credOrder: "reauth_required" }] });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "SEM_CONEXOES_APTAS");
  assert.equal(client.polls.length, 0);
  assert.equal(r.conexoesIgnoradas.length, 1);
});

test("loop: ciclo PARCIAL segue no intervalo normal (sem backoff) — falha de uma loja não atrasa as outras", async () => {
  const esperas = [];
  let loop;
  const poller = { executarCiclo: async () => ({ estado: "PARCIAL" }), encerrar: async () => true };
  loop = criarLoopDoPoller({ poller, log: () => {}, agora: () => 0, sleep: async (ms) => { esperas.push(ms); if (esperas.length >= 3) void loop.parar(); } });
  await loop.iniciar();
  assert.deepEqual(esperas, [IFOOD_EVENTS.intervaloMinimoMs, IFOOD_EVENTS.intervaloMinimoMs, IFOOD_EVENTS.intervaloMinimoMs]);
});

// ===========================================================================
// Repositório — a consulta de conexões elegíveis (builder do supabase gravado, sem banco)
// ===========================================================================
function dbGravado(resposta) {
  const chamadas = [];
  const builder = {
    select(s) { chamadas.push(["select", s]); return builder; },
    eq(c, v) { chamadas.push(["eq", c, v]); return builder; },
    not(c, op, v) { chamadas.push(["not", c, op, v]); return builder; },
    then(res, rej) { return Promise.resolve(resposta).then(res, rej); },
  };
  return { chamadas, from(t) { chamadas.push(["from", t]); return builder; } };
}

test("repositório: só ativas, com merchant e com credencial ORDER (inner join); devolve o status da credencial", async () => {
  const db = dbGravado({ data: [
    { id: "c1", organizacao_id: "o", unidade_id: "u", merchant_id: "m1", ifood_credenciais: [{ app_type: "order", status: "ativa" }] },
    { id: "c2", organizacao_id: "o", unidade_id: "u", merchant_id: "m2", ifood_credenciais: [{ app_type: "order", status: "reauth_required" }] },
  ], error: null });
  const r = await listarConexoesElegiveisParaEvents({ db });
  assert.deepEqual(r, [
    { id: "c1", organizacao_id: "o", unidade_id: "u", merchant_id: "m1", credencial_order_status: "ativa" },
    { id: "c2", organizacao_id: "o", unidade_id: "u", merchant_id: "m2", credencial_order_status: "reauth_required" },
  ]);
  const c = db.chamadas;
  assert.deepEqual(c[0], ["from", "ifood_conexoes"]);
  assert.match(c.find((x) => x[0] === "select")[1], /ifood_credenciais!inner\(app_type, status\)/);
  assert.ok(c.some((x) => x[0] === "eq" && x[1] === "status" && x[2] === "ativa"));
  assert.ok(c.some((x) => x[0] === "not" && x[1] === "merchant_id" && x[2] === "is" && x[3] === null));
  assert.ok(c.some((x) => x[0] === "eq" && x[1] === "ifood_credenciais.app_type" && x[2] === "order"));
  assert.ok(!r.some((x) => "ifood_credenciais" in x), "não devolve a linha de credencial");
});

test("repositório: erro do banco sobe (o poller trata como falha do ciclo, com backoff)", async () => {
  await assert.rejects(listarConexoesElegiveisParaEvents({ db: dbGravado({ data: null, error: { message: "db fora" } }) }), /db fora/);
});
