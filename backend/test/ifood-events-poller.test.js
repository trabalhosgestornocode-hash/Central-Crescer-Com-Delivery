// Events do iFood — poller (ciclo), loop serial, worker, lease/concorrência, restart
// e a migration 101 (verificação estática). Sem rede e sem banco.
//
// Cobre: evento novo/duplicado/desconhecido, ACK só depois de persistir, falha antes e
// depois do ACK, restart, concorrência de pollers, merchant desconhecido, cross-tenant,
// 403/429/5xx, escopo de token (app x conexão), 100 merchants por polling, piso de 30 s,
// loop sem sobreposição, backoff e shutdown gracioso.
//
// Rodar: node --experimental-vm-modules --test test/ifood-events-poller.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as clienteReal from "../src/modules/ifood/ifoodEvents.client.js";
import { criarPoller, criarLoopDoPoller, montarGrupos } from "../src/modules/ifood/ifoodEvents.poller.js";
import { carregarConfigWorkerIfood } from "../src/worker-ifood/config.js";
import { IFOOD_EVENTS } from "../src/modules/ifood/ifood.constants.js";
import { IFOOD_ERROS } from "../src/modules/ifood/ifood.errors.js";
import {
  criarRepoEmMemoria, criarRelogio, criarClienteFake, criarTokenFake, erroIfood,
  ev, M_A, M_B, ORG_A, ORG_B, CONEXAO_A, CONEXAO_B,
} from "./helpers/ifood-events-fakes.js";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(AQUI, "..", "..");
const ler = (p) => readFileSync(path.join(RAIZ, p), "utf8");
const silencio = () => {};

function montar({ escopo = "app", conexoes, respostas = [], falhasAck = [], holder = "worker-1", repo, relogio = repo?.relogio ?? criarRelogio() } = {}) {
  repo ??= criarRepoEmMemoria({ relogio, conexoes });
  const client = criarClienteFake(clienteReal, { respostasPolling: respostas, falhasAck });
  const original = client.confirmarEventos;
  client.confirmarEventos = async (a) => { repo.chamadas.push("ACK"); return original(a); };   // marca a ordem
  const token = criarTokenFake({ escopo });
  const poller = criarPoller({ repo, token, client, holder, agora: relogio.agora, log: silencio, leaseTtlS: 90 });
  return { repo, client, token, poller, relogio };
}
const conexoesGeradas = (n) => Array.from({ length: n }, (_, i) => ({ id: `con-${i}`, organizacao_id: `org-${i}`, unidade_id: `un-${i}`, merchant_id: `merchant-${String(i).padStart(4, "0")}` }));

// ===========================================================================
// CICLO
// ===========================================================================
test("ciclo feliz: polling -> persiste -> processa -> ACK; acknowledged_at só depois do 202", async () => {
  const { repo, client, poller } = montar({ respostas: [[ev("e1", "PLC", { min: 1 }), ev("e2", "PLC", { orderId: "o2", merchantId: M_B, min: 1 })]] });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.equal(client.polls.length, 1);
  assert.deepEqual(client.polls[0].merchantIds, [M_A, M_B]);
  assert.deepEqual(client.acks[0].eventIds.sort(), ["e1", "e2"]);
  assert.ok(repo.eventos.get("e1").acknowledged_at && repo.eventos.get("e2").acknowledged_at);
  assert.equal(repo.pedidos.get("order-1").organizacao_id, ORG_A);
  assert.equal(repo.pedidos.get("o2").organizacao_id, ORG_B);
});

test("ACK SÓ DEPOIS de persistir e processar (ordem das chamadas)", async () => {
  const { repo, poller } = montar({ respostas: [[ev("e1", "PLC", { min: 1 })]] });
  await poller.executarCiclo();
  const c = repo.chamadas;
  const iAck = c.indexOf("ACK");
  assert.ok(iAck > -1);
  assert.ok(c.indexOf("inserirEventos") < iAck, "persistiu antes do ACK");
  assert.ok(c.lastIndexOf("atualizarEvento", iAck) > -1 && c.indexOf("atualizarEvento") < iAck, "processou antes do ACK");
  assert.ok(c.indexOf("garantirPedido") < iAck);
  assert.ok(c.indexOf("adquirirLease", c.indexOf("inserirEventos")) < iAck, "renovou o lease imediatamente antes do ACK");
});

test("204 (nenhum evento): não persiste e NÃO envia ACK", async () => {
  const { repo, client, poller } = montar({ respostas: [[]] });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.equal(client.polls.length, 1);
  assert.equal(client.acks.length, 0);
  assert.equal(repo.eventos.size, 0);
});

test("evento DESCONHECIDO e merchant desconhecido são reconhecidos no ciclo (não travam o worker)", async () => {
  const { repo, client, poller } = montar({ respostas: [[ev("e1", "ZZZ"), ev("e2", "PLC", { merchantId: "loja-fantasma" })]] });
  await poller.executarCiclo();
  assert.equal(repo.eventos.get("e1").processing_status, "DESCONHECIDO");
  assert.equal(repo.eventos.get("e2").processing_status, "MERCHANT_DESCONHECIDO");
  assert.deepEqual(client.acks[0].eventIds.sort(), ["e1", "e2"]);
});

test("duplicidade entre ciclos: o iFood devolve o mesmo evento -> sem efeito duplicado, ACK de novo", async () => {
  const e = ev("e1", "PLC", { min: 1 });
  const { repo, client, poller } = montar({ respostas: [[e], [e]] });
  await poller.executarCiclo();
  const pedido = structuredClone(repo.pedidos.get("order-1"));
  await poller.executarCiclo();
  assert.equal(repo.eventos.size, 1);
  assert.equal(repo.eventos.get("e1").reentregas, 1);
  assert.deepEqual(repo.pedidos.get("order-1"), pedido);
  assert.equal(client.acks.length, 2, "reconhece também o repetido");
});

// ===========================================================================
// FALHAS ANTES/DEPOIS DO ACK
// ===========================================================================
test("FALHA NO ACK: evento fica persistido sem acknowledged_at; o próximo ciclo reconhece SEM efeito duplicado", async () => {
  const e = ev("e1", "PLC", { min: 1 });
  const { repo, client, poller } = montar({ respostas: [[e], [e]], falhasAck: [erroIfood("IFOOD_INDISPONIVEL")] });
  await assert.rejects(poller.executarCiclo(), (x) => x.codigo === IFOOD_ERROS.IFOOD_INDISPONIVEL);
  assert.equal(repo.eventos.get("e1").acknowledged_at, null);
  assert.equal(repo.eventos.get("e1").processing_status, "PROCESSADO");
  assert.equal(client.acks.length, 0);

  const r = await poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.equal(repo.eventos.size, 1);
  assert.equal(repo.pedidos.get("order-1").status_oficial, "PLACED");
  assert.ok(repo.eventos.get("e1").acknowledged_at);
  assert.equal(client.acks.length, 1);
});

test("FALHA ANTES DO ACK (persistência): nada é reconhecido; o evento volta e é processado UMA vez", async () => {
  const e = ev("e1", "PLC", { min: 1 });
  const { repo, client, poller } = montar({ respostas: [[e], [e]] });
  repo.falhar.inserirEventos = 1;
  await assert.rejects(poller.executarCiclo(), /falha injetada em inserirEventos/);
  assert.equal(client.acks.length, 0);
  assert.equal(repo.eventos.size, 0);

  await poller.executarCiclo();
  assert.equal(repo.eventos.get("e1").processing_status, "PROCESSADO");
  assert.equal(client.acks.length, 1);
  assert.equal(repo.pedidos.size, 1);
});

test("erro de processamento após persistir: ACK acontece e o reprocessamento do próximo ciclo recupera o evento", async () => {
  const { repo, client, poller } = montar({ respostas: [[ev("e1", "PLC", { min: 1 })], []] });
  repo.falhar.garantirPedido = 1;
  await poller.executarCiclo();
  assert.equal(repo.eventos.get("e1").processing_status, "FALHOU");
  assert.equal(client.acks.length, 1, "persistido = seguro = reconhecido");
  await poller.executarCiclo();                      // 204 — mas reprocessa pendentes no início
  assert.equal(repo.eventos.get("e1").processing_status, "PROCESSADO");
  assert.equal(repo.pedidos.get("order-1").status_oficial, "PLACED");
});

test("LEASE PERDIDO entre persistir e ACK: NÃO reconhece (outro poller cuida)", async () => {
  const { repo, client, poller } = montar({ respostas: [[ev("e1", "PLC", { min: 1 })]] });
  const real = repo.adquirirLease;
  let n = 0;
  repo.adquirirLease = async (a) => (++n === 1 ? real(a) : { adquirido: false, holder: "outro", leaseAte: null, geracao: 9 });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "LEASE_PERDIDO");
  assert.equal(client.acks.length, 0);
  assert.equal(repo.eventos.get("e1").acknowledged_at, null);
  assert.equal(repo.eventos.get("e1").processing_status, "PROCESSADO", "o que foi persistido fica");
});

// ===========================================================================
// LEASE / CONCORRÊNCIA / RESTART
// ===========================================================================
test("lease de OUTRO poller: este NÃO faz polling (nem toca no iFood)", async () => {
  const { repo, client, poller } = montar({ respostas: [[ev("e1", "PLC")]] });
  await repo.adquirirLease({ nome: IFOOD_EVENTS.leaseNome, holder: "outro-worker", ttlS: 90 });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "LEASE_DE_OUTRO");
  assert.equal(client.polls.length, 0);
  assert.equal(repo.eventos.size, 0);
});

test("CONCORRÊNCIA: dois pollers ao mesmo tempo -> só UM faz polling; o outro vê o lease ocupado", async () => {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio });
  const a = montar({ repo, relogio, holder: "A", respostas: [[ev("e1", "PLC", { min: 1 })]] });
  const b = montar({ repo, relogio, holder: "B", respostas: [[ev("e1", "PLC", { min: 1 })]] });
  const [ra, rb] = await Promise.all([a.poller.executarCiclo(), b.poller.executarCiclo()]);
  const estados = [ra.estado, rb.estado].sort();
  assert.deepEqual(estados, ["LEASE_DE_OUTRO", "OK"]);
  assert.equal(a.client.polls.length + b.client.polls.length, 1);
  assert.equal(repo.eventos.size, 1);
});

test("CONCORRÊNCIA repetida: 10 pollers, sempre exatamente um titular por rodada", async () => {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio });
  const workers = Array.from({ length: 10 }, (_, i) => montar({ repo, relogio, holder: `W${i}`, respostas: [[], [], []] }));
  for (let rodada = 0; rodada < 3; rodada += 1) {
    const rs = await Promise.all(workers.map((w) => w.poller.executarCiclo()));
    assert.equal(rs.filter((r) => r.estado === "OK").length, 1, `rodada ${rodada}`);
    assert.equal(rs.filter((r) => r.estado === "LEASE_DE_OUTRO").length, 9);
  }
});

test("o titular renova o lease a cada ciclo (mesma geração) e não perde para os outros", async () => {
  const { repo, poller } = montar({ respostas: [[], [], []] });
  await poller.executarCiclo();
  const g1 = repo.lease.geracao;
  repo.relogio.avancarS(30);
  await poller.executarCiclo();
  repo.relogio.avancarS(30);
  await poller.executarCiclo();
  assert.equal(repo.lease.geracao, g1);
  assert.equal(repo.lease.holder, "worker-1");
});

test("RESTART limpo: shutdown libera o lease e o novo processo assume NA HORA; reentrega não duplica efeito", async () => {
  const e = ev("e1", "PLC", { min: 1 });
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio });
  const p1 = montar({ repo, relogio, holder: "proc-1", respostas: [[e]] });
  await p1.poller.executarCiclo();
  const pedido = structuredClone(repo.pedidos.get("order-1"));
  assert.equal(await p1.poller.encerrar(), true);

  const p2 = montar({ repo, relogio, holder: "proc-2", respostas: [[e]] });
  const r = await p2.poller.executarCiclo();
  assert.equal(r.estado, "OK", "sem esperar o TTL");
  assert.deepEqual(repo.pedidos.get("order-1"), pedido);
  assert.equal(repo.eventos.size, 1);
  assert.equal(repo.lease.geracao, 2);
});

test("RESTART por QUEDA (sem liberar): o novo processo espera o TTL vencer e então assume", async () => {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio });
  const p1 = montar({ repo, relogio, holder: "caiu", respostas: [[]] });
  await p1.poller.executarCiclo();                                   // ... e o processo morre aqui

  const p2 = montar({ repo, relogio, holder: "novo", respostas: [[]] });
  assert.equal((await p2.poller.executarCiclo()).estado, "LEASE_DE_OUTRO");
  relogio.avancarS(60);
  assert.equal((await p2.poller.executarCiclo()).estado, "LEASE_DE_OUTRO", "90 s ainda não venceram");
  relogio.avancarS(31);
  assert.equal((await p2.poller.executarCiclo()).estado, "OK");
  assert.equal(repo.lease.holder, "novo");
});

test("restart no meio: evento persistido mas NÃO processado (queda entre persistir e processar) é recuperado", async () => {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio });
  await repo.inserirEventos([{
    event_id: "e1", merchant_id: M_A, order_id: "order-1", event_code: "PLC", event_full_code: "PLACED",
    event_created_at: "2026-09-27T12:01:00.000Z", organizacao_id: ORG_A, unidade_id: "un-a", conexao_id: "con-a",
    received_at: relogio.agora().toISOString(), processing_status: "RECEBIDO", payload: { id: "e1" }, payload_hash: "h",
  }]);
  const { poller } = montar({ repo, relogio, holder: "apos-queda", respostas: [[]] });
  await poller.executarCiclo();
  assert.equal(repo.eventos.get("e1").processing_status, "PROCESSADO");
  assert.equal(repo.pedidos.get("order-1").status_oficial, "PLACED");
});

test("encerrar() só libera o lease de quem o detém", async () => {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio });
  const a = montar({ repo, relogio, holder: "A", respostas: [[]] });
  const b = montar({ repo, relogio, holder: "B", respostas: [[]] });
  await a.poller.executarCiclo();
  await b.poller.executarCiclo();                                    // B não adquiriu
  assert.equal(await b.poller.encerrar(), false);
  assert.equal(repo.lease.holder, "A");
  assert.equal(await a.poller.encerrar(), true);
});

// ===========================================================================
// SEM MERCHANTS / ESCOPO DO TOKEN / LOTES
// ===========================================================================
test("sem conexão com merchant: não há o que pollar", async () => {
  const { client, poller } = montar({ conexoes: [], respostas: [[ev("e1", "PLC")]] });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "SEM_MERCHANTS");
  assert.equal(client.polls.length, 0);
});

test("token do APP (centralizado): UM grupo com todos os merchants; conexaoId nulo; só a interface comum de token", async () => {
  const { client, token, poller } = montar({ escopo: "app", respostas: [[]] });
  await poller.executarCiclo();
  assert.equal(client.polls.length, 1);
  assert.deepEqual(token.chamadas, [{ conexaoId: null, appType: "order" }]);
});

test("token por CONEXÃO (distribuído): um polling por conexão, cada um com o SEU merchant e a SUA conexão", async () => {
  const { client, token, poller } = montar({ escopo: "conexao", respostas: [[], []] });
  await poller.executarCiclo();
  assert.deepEqual(client.polls.map((p) => p.merchantIds), [[M_A], [M_B]]);
  assert.deepEqual(token.chamadas, [{ conexaoId: "con-a", appType: "order" }, { conexaoId: "con-b", appType: "order" }]);
});

test("250 merchants: 3 pollings de no máximo 100 (limite do header x-polling-merchants)", async () => {
  const { client, poller } = montar({ conexoes: conexoesGeradas(250), respostas: [[], [], []] });
  await poller.executarCiclo();
  assert.deepEqual(client.polls.map((p) => p.merchantIds.length), [100, 100, 50]);
  assert.equal(new Set(client.polls.flatMap((p) => p.merchantIds)).size, 250, "nenhum merchant repetido nem esquecido");
});

test("montarGrupos respeita o escopo", () => {
  const cs = conexoesGeradas(3);
  assert.equal(montarGrupos(cs, "app").length, 1);
  assert.equal(montarGrupos(cs, "conexao").length, 3);
  assert.deepEqual(montarGrupos(cs, "conexao")[1], { conexaoId: "con-1", merchantIds: ["merchant-0001"] });
});

// ===========================================================================
// ERROS DO IFOOD
// ===========================================================================
test("403 com unauthorizedMerchants: tira SÓ eles e repete UMA vez; segue o ciclo", async () => {
  const { client, poller, repo } = montar({
    respostas: [erroIfood("IFOOD_MERCHANT_SEM_PERMISSAO", { unauthorizedMerchants: [M_B] }), [ev("e1", "PLC", { min: 1 })]],
  });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.deepEqual(client.polls.map((p) => p.merchantIds), [[M_A, M_B], [M_A]]);
  assert.equal(repo.eventos.get("e1").processing_status, "PROCESSADO");
});

test("403 em TODOS os merchants: sem erro e sem novo polling", async () => {
  const { client, poller } = montar({ respostas: [erroIfood("IFOOD_MERCHANT_SEM_PERMISSAO", { unauthorizedMerchants: [M_A, M_B] })] });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.equal(client.polls.length, 1);
});

test("403 sem a lista, ou persistente na 2ª tentativa: o erro sobe (não fica em loop)", async () => {
  await assert.rejects(montar({ respostas: [erroIfood("IFOOD_MERCHANT_SEM_PERMISSAO")] }).poller.executarCiclo(), (e) => e.codigo === IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO);
  const m = montar({ respostas: [erroIfood("IFOOD_MERCHANT_SEM_PERMISSAO", { unauthorizedMerchants: [M_B] }), erroIfood("IFOOD_MERCHANT_SEM_PERMISSAO", { unauthorizedMerchants: [M_A] })] });
  await assert.rejects(m.poller.executarCiclo(), (e) => e.codigo === IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO);
  assert.equal(m.client.polls.length, 2);
});

test("429 (rate limit/throttling): ciclo termina como RATE_LIMITED, sem ACK e sem insistir", async () => {
  const { client, poller } = montar({ respostas: [erroIfood("IFOOD_RATE_LIMITED")] });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "RATE_LIMITED");
  assert.equal(client.polls.length, 1);
  assert.equal(client.acks.length, 0);
});

test("5xx/timeout no polling: o erro sobe para o loop aplicar backoff (nada é reconhecido)", async () => {
  const { client, poller } = montar({ respostas: [erroIfood("IFOOD_INDISPONIVEL", { motivo: "timeout" })] });
  await assert.rejects(poller.executarCiclo(), (e) => e.codigo === IFOOD_ERROS.IFOOD_INDISPONIVEL);
  assert.equal(client.acks.length, 0);
});

test("401: a renovação do token é da interface comum; o poller só repassa (erro de token sobe)", async () => {
  const { poller } = montar({ respostas: [erroIfood("IFOOD_TOKEN_EXPIRADO")] });
  await assert.rejects(poller.executarCiclo(), (e) => e.codigo === IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO);
});

// ===========================================================================
// LOGS
// ===========================================================================
test("logs: nunca o token; merchant sempre mascarado", async () => {
  const linhas = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => linhas.push(a.join(" ")); console.warn = console.log; console.error = console.log;
  try {
    const relogio = criarRelogio();
    const repo = criarRepoEmMemoria({ relogio });
    const client = criarClienteFake(clienteReal, { respostasPolling: [[ev("e1", "PLC", { min: 1 }), ev("e2", "PLC", { merchantId: "loja-fantasma-muito-longa-123456" })]] });
    const token = criarTokenFake({ token: "TOKEN-SECRETO-QUE-NAO-PODE-VAZAR" });
    const poller = criarPoller({ repo, token, client, holder: "w", agora: relogio.agora });   // log padrão (ifoodLog)
    await poller.executarCiclo();
  } finally { Object.assign(console, orig); }
  const saida = linhas.join("\n");
  assert.ok(saida.includes("events.recebido") && saida.includes("events.ack"), "os logs esperados existem");
  assert.ok(!saida.includes("TOKEN-SECRETO-QUE-NAO-PODE-VAZAR"));
  assert.ok(!saida.includes(M_A) && !saida.includes("loja-fantasma-muito-longa-123456"), "merchantId completo nunca vai para o log");
});

// ===========================================================================
// LOOP SERIAL
// ===========================================================================
const pollerFake = (fn) => ({ executarCiclo: fn, encerrar: async () => { pollerFake.encerrados += 1; return true; } });
pollerFake.encerrados = 0;

function rodarNCiclos(loopFactory, n) {
  const esperas = [];
  let loop;
  const sleep = async (ms) => { esperas.push(ms); if (esperas.length >= n) void loop.parar(); };
  loop = loopFactory(sleep);
  return loop.iniciar().then(() => ({ esperas, loop }));
}

test("intervalo: NUNCA abaixo de 30 s, mesmo se pedirem menos", async () => {
  const p = pollerFake(async () => ({ estado: "OK" }));
  const { esperas, loop } = await rodarNCiclos((sleep) => criarLoopDoPoller({ poller: p, intervaloMs: 1000, sleep, log: silencio, agora: () => 0 }), 3);
  assert.equal(loop.intervaloMs, 30_000);
  assert.ok(esperas.every((ms) => ms >= 30_000), JSON.stringify(esperas));
  assert.equal(criarLoopDoPoller({ poller: p, intervaloMs: 0, log: silencio }).intervaloMs, 30_000);
  assert.equal(criarLoopDoPoller({ poller: p, intervaloMs: 45_000, log: silencio }).intervaloMs, 45_000);
});

test("o intervalo é de INÍCIO a início: ciclo lento desconta o tempo já gasto", async () => {
  let agora = 0;
  const p = pollerFake(async () => { agora += 8_000; return { estado: "OK" }; });
  const { esperas } = await rodarNCiclos((sleep) => criarLoopDoPoller({ poller: p, sleep, log: silencio, agora: () => agora }), 2);
  assert.equal(esperas[0], 22_000);
});

test("SERIAL: nunca dois ciclos ao mesmo tempo (ciclo mais lento que o intervalo)", async () => {
  let ativos = 0, maximo = 0, total = 0;
  const p = pollerFake(async () => {
    ativos += 1; maximo = Math.max(maximo, ativos); total += 1;
    await new Promise((r) => setTimeout(r, 15));
    ativos -= 1; return { estado: "OK" };
  });
  await rodarNCiclos((sleep) => criarLoopDoPoller({ poller: p, sleep, log: silencio }), 5);
  assert.ok(total >= 5);
  assert.equal(maximo, 1);
});

test("erro no ciclo: backoff crescente (teto 5 min) e volta ao normal depois de um sucesso", async () => {
  const seq = ["erro", "erro", "erro", "ok", "erro"];
  let i = 0;
  const p = pollerFake(async () => { if (seq[i++] === "erro") throw new Error("iFood caiu"); return { estado: "OK" }; });
  const { esperas } = await rodarNCiclos((sleep) => criarLoopDoPoller({ poller: p, sleep, log: silencio, agora: () => 0 }), 5);
  assert.deepEqual(esperas, [32_000, 34_000, 38_000, 30_000, 32_000]);
  const teto = pollerFake(async () => { throw new Error("x"); });
  const r = await rodarNCiclos((sleep) => criarLoopDoPoller({ poller: teto, sleep, log: silencio, agora: () => 0 }), 14);
  assert.equal(Math.max(...r.esperas), 30_000 + IFOOD_EVENTS.backoffMaxMs);
});

test("RATE_LIMITED: espera extra de 60 s", async () => {
  const p = pollerFake(async () => ({ estado: "RATE_LIMITED" }));
  const { esperas } = await rodarNCiclos((sleep) => criarLoopDoPoller({ poller: p, sleep, log: silencio, agora: () => 0 }), 2);
  assert.equal(esperas[0], 30_000 + IFOOD_EVENTS.espera429Ms);
});

test("SHUTDOWN: parar() acorda o sono na hora, não inicia outro ciclo e libera o lease", async () => {
  pollerFake.encerrados = 0;
  let ciclos = 0;
  const p = pollerFake(async () => { ciclos += 1; return { estado: "OK" }; });
  const loop = criarLoopDoPoller({ poller: p, log: silencio });          // sleep REAL de 30 s
  const fim = loop.iniciar();
  await new Promise((r) => setTimeout(r, 30));
  const t0 = Date.now();
  await loop.parar();
  await fim;
  assert.ok(Date.now() - t0 < 1000, "não esperou os 30 s");
  assert.equal(ciclos, 1);
  assert.equal(pollerFake.encerrados, 1);
});

test("SHUTDOWN no meio de um ciclo: espera o ciclo terminar e só então libera o lease", async () => {
  const ordem = [];
  const p = {
    executarCiclo: async () => { ordem.push("ciclo-inicio"); await new Promise((r) => setTimeout(r, 40)); ordem.push("ciclo-fim"); return { estado: "OK" }; },
    encerrar: async () => { ordem.push("lease-liberado"); return true; },
  };
  const loop = criarLoopDoPoller({ poller: p, log: silencio });
  const fim = loop.iniciar();
  await new Promise((r) => setTimeout(r, 10));
  await loop.parar();
  await fim;
  assert.deepEqual(ordem, ["ciclo-inicio", "ciclo-fim", "lease-liberado"]);
});

test("iniciar() é idempotente (um único laço)", async () => {
  let ciclos = 0;
  const p = pollerFake(async () => { ciclos += 1; return { estado: "OK" }; });
  const loop = criarLoopDoPoller({ poller: p, log: silencio });
  const a = loop.iniciar();
  const b = loop.iniciar();
  assert.equal(a, b);
  await new Promise((r) => setTimeout(r, 20));
  await loop.parar();
  assert.equal(ciclos, 1);
});

test("SEM setInterval: o polling é um laço serial com espera calculada", () => {
  for (const f of ["backend/src/modules/ifood/ifoodEvents.poller.js", "backend/src/worker-ifood/index.js", "backend/src/worker-ifood/config.js"]) {
    const src = ler(f).split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    assert.doesNotMatch(src, /setInterval\s*\(/, f);
  }
});

// ===========================================================================
// WORKER (config e infra)
// ===========================================================================
test("worker: DESLIGADO por padrão (fail-closed)", () => {
  assert.equal(carregarConfigWorkerIfood({}).habilitado, false);
  assert.equal(carregarConfigWorkerIfood({ IFOOD_EVENTS_WORKER_ENABLED: "1" }).habilitado, false);
  assert.equal(carregarConfigWorkerIfood({ IFOOD_EVENTS_WORKER_ENABLED: "true" }).habilitado, true);
});

test("worker: intervalo padrão 30 s e NUNCA abaixo disso (piso da documentação)", () => {
  assert.equal(carregarConfigWorkerIfood({}).intervaloMs, 30_000);
  const c = carregarConfigWorkerIfood({ IFOOD_EVENTS_POLL_INTERVAL_MS: "5000" });
  assert.equal(c.intervaloMs, 30_000);
  assert.ok(c.avisos.some((a) => /abaixo do piso/.test(a)));
  assert.equal(carregarConfigWorkerIfood({ IFOOD_EVENTS_POLL_INTERVAL_MS: "60000" }).intervaloMs, 60_000);
  const inv = carregarConfigWorkerIfood({ IFOOD_EVENTS_POLL_INTERVAL_MS: "abc" });
  assert.equal(inv.intervaloMs, 30_000);
  assert.ok(inv.avisos.length > 0);
});

test("worker: lease TTL seguro (mínimo 45 s e >= 2,5x o intervalo; teto 600 s)", () => {
  assert.equal(carregarConfigWorkerIfood({}).leaseTtlS, 90);
  assert.equal(carregarConfigWorkerIfood({ IFOOD_EVENTS_LEASE_TTL_S: "10" }).leaseTtlS, 75, "10 s subiria para o mínimo 2,5 x 30 s = 75 s");
  assert.equal(carregarConfigWorkerIfood({ IFOOD_EVENTS_POLL_INTERVAL_MS: "120000" }).leaseTtlS, 300);
  assert.equal(carregarConfigWorkerIfood({ IFOOD_EVENTS_LEASE_TTL_S: "9999" }).leaseTtlS, 600);
});

test("worker: porta de health opcional e validada", () => {
  assert.equal(carregarConfigWorkerIfood({}).healthPort, null);
  assert.equal(carregarConfigWorkerIfood({ IFOOD_EVENTS_HEALTH_PORT: "8081" }).healthPort, 8081);
  assert.equal(carregarConfigWorkerIfood({ IFOOD_EVENTS_HEALTH_PORT: "99999" }).healthPort, null);
});

test("worker: processo SEPARADO — o servidor HTTP não o importa; sai sem fazer nada se desligado", () => {
  const server = ler("backend/src/server.js") + ler("backend/src/app.js") + ler("backend/src/routes.js");
  assert.doesNotMatch(server, /worker-ifood|ifoodEvents\.poller/);
  const w = ler("backend/src/worker-ifood/index.js");
  assert.ok(w.indexOf("if (!cfg.habilitado)") > -1);
  // o gate vem antes de carregar a config do backend e de iniciar o laço (que acontece no ciclo de vida)
  // A montagem (token, repositórios, poller) mora em runtime.js, compartilhada com o modo embarcado.
  assert.ok(w.indexOf("./runtime.js") > -1, "o worker dedicado usa a montagem compartilhada");
  assert.ok(w.indexOf("process.exit(0)") < w.indexOf("./runtime.js"), "desligado sai antes de carregar o resto");
  assert.match(ler("backend/src/worker-ifood/runtime.js"), /ifoodToken\.service\.js/, "o runtime é quem carrega o token");
  assert.ok(w.indexOf("process.exit(0)") < w.indexOf("executarWorker("), "o gate de habilitação vem antes de iniciar o laço");
  const ciclo = ler("backend/src/worker-ifood/lifecycle.js");
  assert.match(ciclo, /SIGTERM/); assert.match(ciclo, /SIGINT/);
  assert.match(ciclo, /loop\.parar\(\)/);
  assert.match(ciclo, /loop\.iniciar\(\)/);
});

test("worker: comandos npm e SEM deploy (render.yaml intocado)", () => {
  const pkg = JSON.parse(ler("backend/package.json"));
  assert.match(pkg.scripts["worker:ifood"], /worker-ifood\/index\.js/);
  assert.match(pkg.scripts["worker:ifood:centralized-test"], /--env-file=\.env\.test-integracao --env-file=\.env\.ifood-centralized-test/);
  assert.doesNotMatch(pkg.scripts["worker:ifood:centralized-test"], /--env-file=\.env(\s|$)/);
  const render = ler("render.yaml");
  assert.doesNotMatch(render, /worker-ifood|IFOOD_EVENTS|worker:ifood/, "nenhuma configuração de deploy do worker foi feita");
});

test("worker centralizado de teste: só sobe depois da trava de ambiente", () => {
  const s = ler("backend/scripts/worker-ifood-centralized-test.mjs");
  const iVal = s.indexOf("validarAmbienteCentralizadoTesteIfood(process.env)");
  const iProva = s.indexOf("provarChavesNoProjetoTeste(process.env");
  const iWorker = s.indexOf('import("../src/worker-ifood/index.js")');
  assert.ok(iVal > -1 && iProva > iVal && iWorker > iProva);
  assert.match(s, /process\.exit\(1\)/);
});

// ===========================================================================
// MIGRATION 101 + repository (verificação estática; a semântica foi validada num Postgres local)
// ===========================================================================
test("migration 101: tabelas, colunas exigidas, UNIQUE(event_id), RLS deny-all e nenhuma alteração da 056", () => {
  const sql = ler("database/migrations/101_ifood_eventos.sql").toLowerCase();
  for (const t of ["ifood_eventos", "ifood_pedidos", "ifood_poller_lease"]) assert.match(sql, new RegExp(`create table if not exists ${t}`));
  for (const c of ["event_id", "merchant_id", "order_id", "event_code", "event_full_code", "event_created_at",
    "received_at", "processed_at", "acknowledged_at", "processing_status", "retry_count", "payload", "payload_hash"]) {
    assert.match(sql, new RegExp(`\\b${c}\\b`), `coluna ${c}`);
  }
  assert.match(sql, /constraint uq_ifood_eventos_event_id unique \(event_id\)/);
  assert.match(sql, /constraint uq_ifood_pedidos_order_id unique \(order_id\)/);
  assert.equal((sql.match(/enable row level security/g) ?? []).length, 3);
  assert.doesNotMatch(sql, /create policy/, "backend-only: sem policy para authenticated");
  // 056: só os DOIS CHECKs de app_type são ampliados (para incluir 'order'); nada mais.
  assert.doesNotMatch(sql, /alter table\s+ifood_conexoes/);
  const alteres = [...sql.matchAll(/alter table\s+(ifood_\w+)\s+(\w+)\s+(\w+)/g)]
    .filter((m) => ["ifood_conexoes", "ifood_credenciais", "ifood_oauth_sessoes"].includes(m[1]))   // só as tabelas da 056
    .map((m) => `${m[1]} ${m[2]} ${m[3]}`);
  assert.ok(alteres.length > 0 && alteres.every((a) => /^ifood_(credenciais|oauth_sessoes) (drop|add) constraint$/.test(a)), JSON.stringify(alteres));
  const codigoSql = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(codigoSql, /add column|drop column|update\s+ifood_(conexoes|credenciais|oauth_sessoes)|delete\s+from\s+ifood_(conexoes|credenciais|oauth_sessoes)/);
  assert.match(sql, /ifood_credenciais_app_type_check\s+check \(app_type in \('analytics', 'financial', 'order'\)\)/);
  assert.match(sql, /ifood_oauth_sessoes_app_type_check\s+check \(app_type in \('analytics', 'financial', 'order'\)\)/);
  assert.doesNotMatch(sql, /drop table/);
  assert.match(sql, /organizacao_id uuid not null references organizacoes/);
  assert.match(sql, /unidade_id uuid not null references unidades/);
  assert.match(sql, /processing_status = 'merchant_desconhecido'\) = \(organizacao_id is null\)/);
});

test("migration 101: o rollback remove SÓ o que a 101 criou (056 intacta)", () => {
  const rb = ler("database/migrations/101_rollback.sql").toLowerCase().split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const dropTables = [...rb.matchAll(/drop table if exists (\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(dropTables, ["ifood_eventos", "ifood_pedidos", "ifood_poller_lease"]);
  assert.doesNotMatch(rb, /ifood_conexoes|ifood_touch_atualizado_em/);
  assert.doesNotMatch(rb, /drop table if exists ifood_(credenciais|oauth_sessoes)|delete\s+from|truncate/, "não apaga tabelas nem dados da 056");
  // devolve os CHECKs originais e ABORTA (antes de qualquer DROP) se houver linhas 'order'
  assert.match(rb, /check \(app_type in \('analytics', 'financial'\)\)/);
  assert.ok(rb.indexOf("raise exception") > -1 && rb.indexOf("raise exception") < rb.indexOf("drop function"), "a trava vem antes dos DROP");
  assert.ok(rb.indexOf("raise exception") < rb.indexOf("drop table"));
  assert.equal((rb.match(/drop function if exists/g) ?? []).length, 3);
});

test("repository: dedupe atômico por event_id, lease via função do banco, pedidos sempre filtrados por tenant, sem DELETE", () => {
  const src = ler("backend/src/modules/ifood/ifoodEvents.repository.js");
  assert.match(src, /onConflict: "event_id", ignoreDuplicates: true/);
  assert.match(src, /rpc\("ifood_lease_adquirir"/);
  assert.match(src, /rpc\("ifood_lease_liberar"/);
  assert.match(src, /rpc\("ifood_eventos_marcar_reentrega"/);
  assert.doesNotMatch(src, /\.delete\(/);
  const aplicar = src.slice(src.indexOf("export async function aplicarStatusPedido"), src.indexOf("export async function registrarEventoNoPedido"));
  assert.match(aplicar, /\.eq\("organizacao_id"/); assert.match(aplicar, /\.eq\("unidade_id"/);
  const registrar = src.slice(src.indexOf("export async function registrarEventoNoPedido"), src.indexOf("// LEASE"));
  assert.match(registrar, /\.eq\("organizacao_id"/); assert.match(registrar, /\.eq\("unidade_id"/);
});

test("poller: só fala com token pela interface comum (não conhece client_credentials nem refresh)", () => {
  const src = ler("backend/src/modules/ifood/ifoodEvents.poller.js") + ler("backend/src/modules/ifood/ifoodEvents.service.js") + ler("backend/src/modules/ifood/ifoodEvents.client.js");
  const codigo = src.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  assert.doesNotMatch(codigo, /client_credentials|CLIENT_CREDENTIALS|refresh_token|authorization_code|authorizationCode|centralized|distributed/i);
  assert.match(codigo, /comAccessTokenValido/);
});

test("escopo do Checkpoint D: nenhuma rota HTTP/controller/UI de pedido; constants só com os endpoints autorizados", () => {
  const rotas = ler("backend/src/modules/ifood/ifood.routes.js");
  const semComentarios = (src) => src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  const padrao = /\/confirm|confirmarPedido|dispatch|readyToPickup|orders?\/|disputes?\/|requestCancellation/i;
  assert.doesNotMatch(semComentarios(rotas), padrao);
  assert.doesNotMatch(semComentarios(ler("backend/src/modules/ifood/ifood.controller.js")), padrao);
  const constantes = ler("backend/src/modules/ifood/ifood.constants.js");
  for (const re of [/\/confirm`/, /\/readyToPickup`/, /\/dispatch`/, /\/cancellationReasons`/, /\/requestCancellation`/, /\/disputes\//]) assert.match(constantes, re);
  // Fora do escopo: startPreparation, rastreamento, validação de códigos, receitas.
  assert.doesNotMatch(semComentarios(constantes), /startPreparation|\/tracking|validatePickupCode|verifyDeliveryCode|prescriptions/i);
});
