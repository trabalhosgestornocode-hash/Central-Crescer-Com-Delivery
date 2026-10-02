// iFood Events EMBARCADO no Web Service — lifecycle, isolamento de falhas e failover por lease.
//
// Princípio testado: WEB saudável / EVENTS degradado é aceitável; EVENTS falhou / WEB caiu, nunca.
//
//   flag            desligada = nada roda (nem o runtime é montado); ligada = supervisor ativo
//   boot            o HTTP responde ANTES do Events terminar de subir (montagem pendurada não bloqueia)
//   lease           livre -> active; ocupado -> waiting_lease (normal em deploy), API saudável
//   failover        deploy com 2 instâncias: A ativa, B esperando; A recebe SIGTERM, libera; B assume.
//                   Prova: TODO ACK saiu do titular vivo do lease e nunca houve ACK em voo das duas
//   SIGTERM         um handler; para o Events, libera o lease, fecha o HTTP, exit 0 uma vez só
//   prazo           ciclo pendurado além do prazo: NÃO libera o lease (ninguém reconhece em paralelo)
//   falhas          iFood 500, 429, refresh de uma loja, Supabase fora, loop que quebra: degraded/backoff,
//                   o HTTP continua 200 e process.exit NUNCA é chamado pelo Events
//   processo real   server.js sobe com Supabase inalcançável: /health 200, Events degraded
//
// Sem rede externa e sem banco: poller REAL com repositório/cliente/token falsos (test/helpers).
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import * as clienteReal from "../src/modules/ifood/ifoodEvents.client.js";
import { criarPoller, criarLoopDoPoller } from "../src/modules/ifood/ifoodEvents.poller.js";
import { criarSupervisorEvents, ESTADOS_EVENTS, estadoDoCiclo } from "../src/worker-ifood/supervisor.js";
import { iniciarEventsIfoodEmbutido, pararEventsIfoodEmbutido } from "../src/worker-ifood/embedded.js";
import { lerEstadoEvents, resumoEventsParaStatus } from "../src/modules/ifood/ifoodEventsEstado.js";
import { iniciarServidorHttp } from "../src/servidor.lifecycle.js";
import { IFOOD_EVENTS } from "../src/modules/ifood/ifood.constants.js";
import {
  criarRepoEmMemoria, criarClienteFake, criarTokenFake, erroIfood, ev, CONEXAO_A, CONEXAO_B, M_A,
} from "./helpers/ifood-events-fakes.js";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(AQUI, "..");
const silencio = () => {};
const LIGADO = { IFOOD_EVENTS_EMBEDDED_ENABLED: "true" };

// Relógio REAL compartilhado: o lease do repositório falso usa o mesmo tempo que os supervisores.
const relogioReal = () => ({ agoraMs: () => Date.now(), agora: () => new Date(), avancarS() {} });
// Espera curta entre ciclos (o intervalo "lógico" continua 30 s; só o sono do teste é curto).
const sonoRapido = () => new Promise((r) => setTimeout(r, 3));

async function aguardar(cond, { ms = 4_000, msg = "condição não atingida a tempo" } = {}) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(msg);
}

/** Uma "instância" do Web Service: poller real + loop real + dependências falsas. */
function instancia({ holder, repo, relogio, client, token = criarTokenFake({ escopo: "app" }), leaseTtlS = 90 }) {
  client ??= criarClienteFake(clienteReal);
  const poller = criarPoller({ repo, token, client, holder, agora: relogio.agora, log: silencio, leaseTtlS });
  const criarLoop = (extras = {}) => criarLoopDoPoller({ poller, intervaloMs: 30_000, sleep: sonoRapido, log: silencio, ...extras });
  const runtime = { ok: true, modo: "distributed", holder, poller, criarLoop, intervaloMs: 30_000, leaseTtlS };
  return { poller, client, criarLoop, runtime };
}

function supervisor(inst, extras = {}) {
  return criarSupervisorEvents({ poller: inst.poller, criarLoop: inst.criarLoop, log: silencio, reinicioBaseMs: 5, reinicioMaxMs: 20, ...extras });
}

/** App mínimo com o mesmo contrato do /health real (sempre 200; só o estado do Events). */
function appComHealth() {
  const app = express();
  app.get("/health", (_req, res) => res.json({ ok: true, ifoodEvents: lerEstadoEvents().estado }));
  return app;
}
const urlDe = (servidor, p = "/health") => `http://127.0.0.1:${servidor.address().port}${p}`;
const getHealth = async (servidor) => { const r = await fetch(urlDe(servidor)); return { status: r.status, corpo: await r.json() }; };

function procFalso() {
  const proc = new EventEmitter();
  proc.saidas = [];
  proc.exit = (c) => { proc.saidas.push(c); };
  return proc;
}

/** Durante o teste, qualquer process.exit vira falha (o Events nunca pode chamá-lo). */
function proibirProcessExit(t) {
  const original = process.exit;
  const chamadas = [];
  process.exit = (c) => { chamadas.push(c); throw new Error(`process.exit(${c}) chamado pelo Events`); };
  t.after(() => { process.exit = original; });
  return chamadas;
}

// ===========================================================================
// FLAG
// ===========================================================================
test("flag DESLIGADA: nada é montado, estado disabled, parada é no-op", async () => {
  let montou = 0;
  const r = await iniciarEventsIfoodEmbutido({ env: {}, log: silencio, montarRuntime: async () => { montou += 1; return { ok: false }; } });
  assert.equal(r.habilitado, false);
  assert.equal(r.estado, "disabled");
  assert.equal(montou, 0, "sem a flag o runtime (token/repositórios/poller) nem é montado");
  assert.equal(lerEstadoEvents().estado, "disabled");
  assert.equal(await pararEventsIfoodEmbutido("SIGTERM", { log: silencio }), null);
  // A flag do worker dedicado NÃO liga o embarcado.
  const r2 = await iniciarEventsIfoodEmbutido({ env: { IFOOD_EVENTS_WORKER_ENABLED: "true" }, log: silencio, montarRuntime: async () => { montou += 1; } });
  assert.equal(r2.habilitado, false);
  assert.equal(montou, 0);
});

test("flag LIGADA: supervisor ativo; parada libera o lease e para em `stopped`", async (t) => {
  proibirProcessExit(t);
  const relogio = relogioReal();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [CONEXAO_A] });
  const a = instancia({ holder: "inst-A", repo, relogio });
  const sinaisAntes = process.listenerCount("SIGTERM");

  const r = await iniciarEventsIfoodEmbutido({ env: LIGADO, log: silencio, montarRuntime: async () => a.runtime });
  assert.equal(r.habilitado, true);
  await aguardar(() => lerEstadoEvents().estado === ESTADOS_EVENTS.ACTIVE, { msg: "deveria ficar active" });
  assert.equal(repo.lease.holder, "inst-A");
  assert.equal(process.listenerCount("SIGTERM"), sinaisAntes, "o host embarcado não registra handler de sinal");

  const parada = await pararEventsIfoodEmbutido("SIGTERM", { log: silencio });
  assert.deepEqual(parada, { drenado: true, leaseLiberado: true });
  assert.ok(repo.lease.ate < Date.now(), "lease liberado no shutdown");
  assert.equal(lerEstadoEvents().estado, ESTADOS_EVENTS.STOPPED);
  assert.equal(await pararEventsIfoodEmbutido("SIGTERM", { log: silencio }), null, "parada idempotente");
});

test("config recusada (ex.: centralized_test fora do ambiente permitido): degraded, sem exceção, sem exit", async (t) => {
  proibirProcessExit(t);
  const r = await iniciarEventsIfoodEmbutido({ env: LIGADO, log: silencio, montarRuntime: async () => ({ ok: false, motivo: "modo centralized_test não permitido (teste)" }) });
  assert.equal(r.habilitado, false);
  assert.equal(r.estado, "degraded");
  assert.equal(lerEstadoEvents().estado, "degraded");
  const r2 = await iniciarEventsIfoodEmbutido({ env: LIGADO, log: silencio, montarRuntime: async () => { throw new Error("import quebrou"); } });
  assert.equal(r2.estado, "degraded", "erro inesperado na montagem também não sobe");
});

// ===========================================================================
// BOOT
// ===========================================================================
test("boot: o HTTP responde ANTES do Events subir; montagem pendurada não bloqueia o /health", async (t) => {
  proibirProcessExit(t);
  const relogio = relogioReal();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [CONEXAO_A] });
  const a = instancia({ holder: "inst-A", repo, relogio });
  const ordem = [];
  let liberarMontagem;
  const montagem = new Promise((r) => { liberarMontagem = r; });
  const proc = procFalso();

  const { servidor } = iniciarServidorHttp({
    app: appComHealth(), porta: 0, proc, prazoFinalMs: 60_000, log: silencio,
    aoEscutar: () => {
      ordem.push("http_ouvindo");
      iniciarEventsIfoodEmbutido({ env: LIGADO, log: silencio, montarRuntime: async () => { ordem.push("events_montando"); await montagem; return a.runtime; } });
    },
    antesDeFechar: [(s) => pararEventsIfoodEmbutido(s, { log: silencio })],
  });
  await aguardar(() => ordem.includes("events_montando"));
  assert.deepEqual(ordem, ["http_ouvindo", "events_montando"], "Events só começa depois do listen()");

  const h = await getHealth(servidor);
  assert.equal(h.status, 200, "o Web responde enquanto o Events ainda sobe");
  assert.equal(h.corpo.ifoodEvents, "starting");

  liberarMontagem();
  await aguardar(() => lerEstadoEvents().estado === ESTADOS_EVENTS.ACTIVE);
  assert.equal((await getHealth(servidor)).corpo.ifoodEvents, "active");

  proc.emit("SIGTERM");
  await aguardar(() => proc.saidas.length === 1);
  assert.deepEqual(proc.saidas, [0]);
});

// ===========================================================================
// LEASE
// ===========================================================================
test("lease livre -> active; lease ocupado por outra instância -> waiting_lease, e o HTTP segue 200", async (t) => {
  proibirProcessExit(t);
  const relogio = relogioReal();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [CONEXAO_A] });
  // Outra instância segura o lease.
  await repo.adquirirLease({ nome: IFOOD_EVENTS.leaseNome, holder: "inst-ANTIGA", ttlS: 90 });
  const b = instancia({ holder: "inst-B", repo, relogio });
  const proc = procFalso();
  const { servidor } = iniciarServidorHttp({
    app: appComHealth(), porta: 0, proc, prazoFinalMs: 60_000, log: silencio,
    aoEscutar: () => { iniciarEventsIfoodEmbutido({ env: LIGADO, log: silencio, montarRuntime: async () => b.runtime }); },
    antesDeFechar: [(s) => pararEventsIfoodEmbutido(s, { log: silencio })],
  });
  await aguardar(() => lerEstadoEvents().estado === ESTADOS_EVENTS.WAITING_LEASE, { msg: "deveria esperar o lease" });
  assert.equal(b.client.polls.length, 0, "sem lease: nenhum polling");
  assert.equal((await getHealth(servidor)).status, 200);
  const e = lerEstadoEvents();
  assert.equal(e.lease.souTitular, false);
  assert.notEqual(e.lease.titular, "inst-ANTIGA", "titular do lease mascarado");

  // O lease da antiga é liberado: B assume no próximo ciclo.
  await repo.liberarLease({ holder: "inst-ANTIGA" });
  await aguardar(() => lerEstadoEvents().estado === ESTADOS_EVENTS.ACTIVE, { msg: "B deveria assumir" });
  assert.equal(repo.lease.holder, "inst-B");
  assert.ok(b.client.polls.length > 0);

  proc.emit("SIGTERM");
  await aguardar(() => proc.saidas.length === 1);
});

test("deploy com DUAS instâncias: A ativa, B esperando; A para e libera; B assume — nunca ACK das duas ao mesmo tempo", async (t) => {
  proibirProcessExit(t);
  const relogio = relogioReal();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [CONEXAO_A] });
  const linha = [];            // cada ACK: quem enviou, titular e validade do lease no instante do envio
  const emVoo = new Map();     // holder -> ACKs em voo
  let maxInstanciasEmVoo = 0;
  let seq = 0;

  function clienteDe(holder) {
    const c = criarClienteFake(clienteReal);
    c.buscarEventos = async ({ merchantIds }) => {
      c.polls.push({ merchantIds });
      seq += 1;
      return [ev(`ev-${seq}`, "PLC", { orderId: `o-${seq}`, merchantId: M_A })];   // um evento novo por polling
    };
    c.confirmarEventos = async ({ eventIds, sinal }) => {
      const l = repo.lease;
      linha.push({ holder, em: Date.now(), titular: l?.holder, leaseAte: l?.ate, abortado: sinal?.aborted === true });
      emVoo.set(holder, (emVoo.get(holder) ?? 0) + 1);
      maxInstanciasEmVoo = Math.max(maxInstanciasEmVoo, [...emVoo.values()].filter((n) => n > 0).length);
      await new Promise((r) => setTimeout(r, 2));   // ACK leva um tempo: dá chance real de sobreposição
      emVoo.set(holder, emVoo.get(holder) - 1);
      c.acks.push({ eventIds });
      return { enviados: eventIds.length };
    };
    return c;
  }

  const A = instancia({ holder: "inst-A", repo, relogio, client: clienteDe("inst-A") });
  const B = instancia({ holder: "inst-B", repo, relogio, client: clienteDe("inst-B") });
  const supA = supervisor(A);
  const supB = supervisor(B);

  void supA.iniciar();
  await aguardar(() => supA.obterEstado().estado === ESTADOS_EVENTS.ACTIVE && A.client.acks.length >= 2);
  void supB.iniciar();   // instância nova do deploy
  await aguardar(() => supB.obterEstado().estado === ESTADOS_EVENTS.WAITING_LEASE);
  await aguardar(() => A.client.acks.length >= 5, { msg: "A segue reconhecendo enquanto B espera" });
  assert.equal(B.client.acks.length, 0, "B não reconhece nada sem o lease");

  const paradaA = await supA.parar({ prazoMs: 2_000 });   // SIGTERM na antiga
  const liberadoEm = Date.now();
  assert.deepEqual(paradaA, { drenado: true, leaseLiberado: true });
  await aguardar(() => supB.obterEstado().estado === ESTADOS_EVENTS.ACTIVE && B.client.acks.length >= 2, { msg: "B deveria assumir" });
  await supB.parar({ prazoMs: 2_000 });

  assert.ok(linha.length >= 7);
  for (const a of linha) {
    assert.equal(a.titular, a.holder, `ACK de ${a.holder} com o lease de ${a.titular}`);
    assert.ok(a.leaseAte > a.em, "ACK só com lease válido");
    assert.equal(a.abortado, false);
  }
  assert.ok(linha.filter((a) => a.holder === "inst-A").every((a) => a.em <= liberadoEm), "A não reconhece depois de liberar");
  assert.ok(linha.filter((a) => a.holder === "inst-B").every((a) => a.em >= liberadoEm), "B só reconhece depois que A liberou");
  assert.equal(maxInstanciasEmVoo, 1, "nunca houve ACK em voo das duas instâncias ao mesmo tempo");
});

// ===========================================================================
// SHUTDOWN
// ===========================================================================
test("SIGTERM: para o Events, libera o lease, fecha o HTTP e sai com 0 — uma vez só, mesmo com sinal repetido", async (t) => {
  proibirProcessExit(t);
  const relogio = relogioReal();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [CONEXAO_A] });
  const a = instancia({ holder: "inst-A", repo, relogio });
  const proc = procFalso();
  const ordem = [];
  const { servidor } = iniciarServidorHttp({
    app: appComHealth(), porta: 0, proc, prazoFinalMs: 60_000, log: silencio,
    aoEscutar: () => { iniciarEventsIfoodEmbutido({ env: LIGADO, log: silencio, montarRuntime: async () => a.runtime }); },
    antesDeFechar: [async (s) => { const r = await pararEventsIfoodEmbutido(s, { log: silencio }); ordem.push(["events_parado", r]); }],
  });
  servidor.on("close", () => ordem.push(["http_fechado"]));
  await aguardar(() => lerEstadoEvents().estado === ESTADOS_EVENTS.ACTIVE);

  proc.emit("SIGTERM");
  proc.emit("SIGTERM");   // Render pode repetir; não pode haver dois encerramentos concorrentes
  proc.emit("SIGINT");
  await aguardar(() => proc.saidas.length >= 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(proc.saidas, [0], "exit(0) exatamente uma vez");
  assert.deepEqual(ordem.map((o) => o[0]), ["events_parado", "http_fechado"], "Events para ANTES do HTTP fechar");
  assert.deepEqual(ordem[0][1], { drenado: true, leaseLiberado: true });
  assert.equal(servidor.listening, false);
  assert.ok(repo.lease.ate < Date.now(), "lease liberado");
  assert.equal(lerEstadoEvents().estado, ESTADOS_EVENTS.STOPPED);
});

test("lifecycle: uma parada que FALHA não impede as outras, o HTTP fecha e a saída é 0", async () => {
  const proc = procFalso();
  const rodaram = [];
  const { servidor } = iniciarServidorHttp({
    app: appComHealth(), porta: 0, proc, prazoFinalMs: 60_000, log: silencio,
    antesDeFechar: [
      async () => { rodaram.push("a"); throw new Error("parada quebrou"); },
      () => { rodaram.push("b-sync"); throw new Error("síncrona também"); },
      async () => { rodaram.push("c"); },
    ],
  });
  await new Promise((r) => (servidor.listening ? r() : servidor.once("listening", r)));
  proc.emit("SIGTERM");
  await aguardar(() => proc.saidas.length === 1);
  assert.deepEqual(rodaram.sort(), ["a", "b-sync", "c"]);
  assert.deepEqual(proc.saidas, [0]);
  assert.equal(servidor.listening, false);
});

test("lifecycle: parada PENDURADA — o prazo final força exit(0); o HTTP não fica preso esperando", async () => {
  const proc = procFalso();
  const { servidor } = iniciarServidorHttp({
    app: appComHealth(), porta: 0, proc, prazoFinalMs: 80, log: silencio,
    antesDeFechar: [() => new Promise(() => {})],   // nunca termina
  });
  await new Promise((r) => (servidor.listening ? r() : servidor.once("listening", r)));
  const t0 = Date.now();
  proc.emit("SIGTERM");
  // o prazo final é unref (não segura o processo); aqui um timer de teste segura até ele disparar
  const vivo = setTimeout(() => {}, 2_000);
  await aguardar(() => proc.saidas.length === 1, { ms: 1_500 });
  clearTimeout(vivo);
  assert.deepEqual(proc.saidas, [0]);
  assert.ok(Date.now() - t0 >= 70, "saiu pelo prazo final");
  servidor.close();
});

test("ciclo pendurado além do prazo de parada: o lease NÃO é liberado (ninguém reconhece em paralelo)", async (t) => {
  proibirProcessExit(t);
  const relogio = relogioReal();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [CONEXAO_A] });
  const client = criarClienteFake(clienteReal);
  let soltar;
  let pollsFeitos = 0;
  client.buscarEventos = () => { pollsFeitos += 1; return new Promise((r) => { soltar = () => r([]); }); };   // iFood não responde
  const a = instancia({ holder: "inst-A", repo, relogio, client });
  const sup = supervisor(a);
  void sup.iniciar();
  await aguardar(() => pollsFeitos === 1);

  const r = await sup.parar({ prazoMs: 30 });
  assert.deepEqual(r, { drenado: false, leaseLiberado: false });
  assert.equal(repo.lease.holder, "inst-A");
  assert.ok(repo.lease.ate > Date.now(), "lease mantido: vence sozinho pelo TTL");
  const b = await repo.adquirirLease({ nome: IFOOD_EVENTS.leaseNome, holder: "inst-B", ttlS: 90 });
  assert.equal(b.adquirido, false, "a outra instância não assume enquanto o ciclo da primeira pode reconhecer");
  soltar();   // limpeza
});

// ===========================================================================
// ISOLAMENTO DE FALHAS — o HTTP continua 200 em todas
// ===========================================================================
async function comServidor(t, inst, fn) {
  proibirProcessExit(t);
  const proc = procFalso();
  const { servidor } = iniciarServidorHttp({
    app: appComHealth(), porta: 0, proc, prazoFinalMs: 60_000, log: silencio,
    aoEscutar: () => { iniciarEventsIfoodEmbutido({ env: LIGADO, log: silencio, montarRuntime: async () => inst.runtime }); },
    antesDeFechar: [(s) => pararEventsIfoodEmbutido(s, { log: silencio })],
  });
  try {
    await fn(servidor);
  } finally {
    proc.emit("SIGTERM");
    await aguardar(() => proc.saidas.length === 1);
  }
}

test("caso 1 — iFood 500: Events degraded com backoff; HTTP 200", async (t) => {
  const relogio = relogioReal();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [CONEXAO_A] });
  const client = criarClienteFake(clienteReal);
  client.buscarEventos = async () => { throw erroIfood("IFOOD_INDISPONIVEL", { status: 500 }); };
  const a = instancia({ holder: "inst-A", repo, relogio, client });
  await comServidor(t, a, async (servidor) => {
    await aguardar(() => lerEstadoEvents().estado === ESTADOS_EVENTS.DEGRADED);
    const e = lerEstadoEvents();
    assert.equal(e.ultimoErro.codigo, "IFOOD_INDISPONIVEL");
    assert.ok(Date.parse(e.proximaTentativaEm) > Date.now() + 30_000, "backoff: próximo ciclo depois do intervalo + espera extra");
    assert.equal((await getHealth(servidor)).status, 200);
  });
});

test("caso 2 — 429: espera extra de 60 s (throttling), degraded; HTTP 200", async (t) => {
  const relogio = relogioReal();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [CONEXAO_A] });
  const client = criarClienteFake(clienteReal);
  client.buscarEventos = async () => { throw erroIfood("IFOOD_RATE_LIMITED", { status: 429 }); };
  const a = instancia({ holder: "inst-A", repo, relogio, client });
  await comServidor(t, a, async (servidor) => {
    await aguardar(() => lerEstadoEvents().motivo === "rate_limited");
    const e = lerEstadoEvents();
    assert.equal(e.estado, ESTADOS_EVENTS.DEGRADED);
    assert.ok(Date.parse(e.proximaTentativaEm) - Date.now() >= IFOOD_EVENTS.espera429Ms, "429 respeita a espera de 60 s");
    assert.equal((await getHealth(servidor)).status, 200);
  });
});

test("caso 3 — refresh falha numa loja: só ela falha, as outras seguem; reauth_required é ignorada sem chamar o iFood", async (t) => {
  const relogio = relogioReal();
  const conexaoC = { id: "con-c", organizacao_id: "org-c", unidade_id: "un-c", merchant_id: "cccccccc-0000-4000-8000-00000000000c", credOrder: "reauth_required" };
  const repo = criarRepoEmMemoria({ relogio, conexoes: [CONEXAO_A, CONEXAO_B, conexaoC] });
  const token = criarTokenFake({ escopo: "conexao" });
  const tokenReal = token.comAccessTokenValido;
  token.comAccessTokenValido = async (p) => {
    if (p.conexaoId === CONEXAO_B.id) throw erroIfood("IFOOD_REFRESH_FALHOU");
    return tokenReal(p);
  };
  const a = instancia({ holder: "inst-A", repo, relogio, token });
  await comServidor(t, a, async (servidor) => {
    await aguardar(() => lerEstadoEvents().ultimoResultado === "PARCIAL");
    const e = lerEstadoEvents();
    assert.equal(e.estado, ESTADOS_EVENTS.DEGRADED);
    assert.equal(e.motivo, "conexoes_com_falha");
    assert.deepEqual(e.conexoes, { processadas: 1, ignoradas: 1, comFalha: 1 });
    assert.ok(a.client.polls.some((p) => p.merchantIds.includes(CONEXAO_A.merchant_id)), "a loja saudável foi consultada");
    assert.ok(!a.client.polls.some((p) => p.merchantIds.includes(conexaoC.merchant_id)), "reauth_required não chama o iFood");
    assert.equal((await getHealth(servidor)).status, 200);
  });
});

test("caso 4 — Supabase fora (lease/consulta falham): degraded e depois se recupera sozinho; HTTP 200", async (t) => {
  const relogio = relogioReal();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [CONEXAO_A] });
  repo.falhar.adquirirLease = 2;   // duas falhas seguidas do banco
  const a = instancia({ holder: "inst-A", repo, relogio });
  // backoff do loop entre falhas: 2 s, 4 s... — o sono do teste é curto, então só o estado importa.
  await comServidor(t, a, async (servidor) => {
    await aguardar(() => lerEstadoEvents().ultimoErro !== null);
    assert.equal((await getHealth(servidor)).status, 200);
    await aguardar(() => lerEstadoEvents().estado === ESTADOS_EVENTS.ACTIVE, { msg: "deveria se recuperar quando o banco volta" });
    assert.ok(lerEstadoEvents().ultimoCicloOkEm);
  });
});

test("caso 5 — o LOOP quebra (erro que ele não captura): supervisor registra, reinicia com backoff; nenhum process.exit", async (t) => {
  const exits = proibirProcessExit(t);
  const relogio = relogioReal();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [CONEXAO_A] });
  const a = instancia({ holder: "inst-A", repo, relogio });
  let criados = 0;
  const logs = [];
  const sup = criarSupervisorEvents({
    poller: a.poller, log: (nivel, evento, dados) => logs.push({ nivel, evento, dados }), reinicioBaseMs: 5, reinicioMaxMs: 20,
    criarLoop: (cb) => {
      criados += 1;
      if (criados <= 2) return { iniciar: async () => { throw new Error(`loop quebrou #${criados}`); }, parar: async () => ({ drenado: true, leaseLiberado: false }) };
      return a.criarLoop(cb);
    },
  });
  void sup.iniciar();
  await aguardar(() => sup.obterEstado().estado === ESTADOS_EVENTS.ACTIVE, { msg: "deveria voltar a active após reinícios" });
  const e = sup.obterEstado();
  assert.equal(e.reinicios, 2);
  assert.equal(criados, 3);
  assert.equal(logs.filter((l) => l.evento === "events.supervisor_loop_terminou").length, 2);
  assert.ok(logs.some((l) => l.evento === "events.supervisor_estado" && l.dados.para === "degraded"));
  assert.deepEqual(exits, []);
  assert.deepEqual(await sup.parar({ prazoMs: 1_000 }), { drenado: true, leaseLiberado: true });
});

test("loop que RETORNA sozinho também é reiniciado (no worker dedicado isso seria exit 1)", async (t) => {
  const exits = proibirProcessExit(t);
  const relogio = relogioReal();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [CONEXAO_A] });
  const a = instancia({ holder: "inst-A", repo, relogio });
  let criados = 0;
  const sup = criarSupervisorEvents({
    poller: a.poller, log: silencio, reinicioBaseMs: 5,
    criarLoop: (cb) => ((criados += 1) === 1 ? { iniciar: async () => {}, parar: async () => ({}) } : a.criarLoop(cb)),
  });
  void sup.iniciar();
  await aguardar(() => sup.obterEstado().estado === ESTADOS_EVENTS.ACTIVE);
  assert.equal(sup.obterEstado().reinicios, 1);
  assert.deepEqual(exits, []);
  await sup.parar({ prazoMs: 1_000 });
});

test("parada durante a espera entre reinícios: acorda na hora e libera o lease", async (t) => {
  proibirProcessExit(t);
  const relogio = relogioReal();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [CONEXAO_A] });
  const a = instancia({ holder: "inst-A", repo, relogio });
  let criados = 0;
  const sup = criarSupervisorEvents({
    poller: a.poller, log: silencio, reinicioBaseMs: 60_000,   // espera longa: a parada precisa acordar
    criarLoop: (cb) => {
      criados += 1;
      const loop = a.criarLoop(cb);
      // 1º loop: faz um ciclo (pega o lease) e então quebra.
      return { iniciar: async () => { await a.poller.executarCiclo(); throw new Error("quebrou"); }, parar: loop.parar };
    },
  });
  void sup.iniciar();
  await aguardar(() => sup.obterEstado().estado === ESTADOS_EVENTS.DEGRADED);
  assert.equal(repo.lease.holder, "inst-A");
  const t0 = Date.now();
  const r = await sup.parar({ prazoMs: 1_000 });
  assert.ok(Date.now() - t0 < 500, "a parada não espera o backoff de 60 s");
  assert.deepEqual(r, { drenado: true, leaseLiberado: true });
  assert.ok(repo.lease.ate < Date.now());
  assert.equal(criados, 1, "nenhum loop novo depois da parada");
});

// ===========================================================================
// ESTADO / OBSERVABILIDADE / SEGURANÇA
// ===========================================================================
test("estadoDoCiclo: tradução de cada resultado do poller", () => {
  assert.equal(estadoDoCiclo({ estado: "OK" }).estado, "active");
  assert.equal(estadoDoCiclo({ estado: "SEM_MERCHANTS" }).estado, "active");
  assert.equal(estadoDoCiclo({ estado: "SEM_CONEXOES_APTAS" }).estado, "active");
  assert.equal(estadoDoCiclo({ estado: "LEASE_DE_OUTRO" }).estado, "waiting_lease");
  assert.equal(estadoDoCiclo({ estado: "LEASE_PERDIDO" }).estado, "waiting_lease");
  assert.deepEqual(estadoDoCiclo({ estado: "PARCIAL" }), { estado: "degraded", motivo: "conexoes_com_falha" });
  assert.deepEqual(estadoDoCiclo({ estado: "RATE_LIMITED" }), { estado: "degraded", motivo: "rate_limited" });
  assert.deepEqual(estadoDoCiclo({ estado: "ERRO", codigo: "X" }), { estado: "degraded", motivo: "erro:X" });
});

test("estado observável sem segredo: sem token, titular mascarado; o status da unidade só leva estado e horários", async (t) => {
  proibirProcessExit(t);
  const relogio = relogioReal();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [CONEXAO_A] });
  const token = criarTokenFake({ escopo: "app", token: "tok-super-secreto-nao-logar" });
  const a = instancia({ holder: "host-render-1234:99:abcd", repo, relogio, token });
  const logs = [];
  await iniciarEventsIfoodEmbutido({ env: LIGADO, log: (...l) => logs.push(l), montarRuntime: async () => a.runtime,
    criarSupervisor: (p) => criarSupervisorEvents({ ...p, log: (...l) => logs.push(l) }) });
  await aguardar(() => lerEstadoEvents().estado === ESTADOS_EVENTS.ACTIVE);
  const e = lerEstadoEvents();
  const tudo = JSON.stringify(e) + JSON.stringify(logs);
  assert.doesNotMatch(tudo, /tok-super-secreto/);
  assert.doesNotMatch(tudo, /host-render-1234:99:abcd/, "holder nunca aparece inteiro");
  assert.equal(e.lease.souTitular, true);
  for (const campo of ["ultimoCicloEm", "ultimoCicloOkEm", "proximaTentativaEm", "conexoes", "ultimoErro", "reinicios", "lease"]) assert.ok(campo in e, campo);
  assert.deepEqual(Object.keys(resumoEventsParaStatus()).sort(), ["estado", "proximaTentativaEm", "ultimoCicloEm", "ultimoCicloOkEm"]);
  assert.ok(logs.some(([, evento]) => evento === "events.ciclo_resumo"));
  await pararEventsIfoodEmbutido("SIGTERM", { log: silencio });
});

// ===========================================================================
// PROCESSO REAL — server.js com Supabase inalcançável
// ===========================================================================
test("processo real: server.js sobe, /health 200 com Events DEGRADED (Supabase fora); flag desligada = disabled", async () => {
  async function subir(flag) {
    const porta = 41000 + Math.floor(Math.random() * 8000);
    const filho = spawn(process.execPath, ["src/server.js"], {
      cwd: BACKEND,
      // ambiente mínimo e explícito: Supabase em porta fechada local (nenhuma rede externa), nada de .env
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(porta),
        SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40), SUPABASE_ANON_KEY: "y".repeat(40),
        IFOOD_TOKEN_SECRET: "z".repeat(40), ...(flag ? { IFOOD_EVENTS_EMBEDDED_ENABLED: "true" } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let saida = "";
    filho.stdout.on("data", (b) => { saida += b; });
    filho.stderr.on("data", (b) => { saida += b; });
    try {
      let h = null;
      await aguardar(async () => {
        try { const r = await fetch(`http://127.0.0.1:${porta}/health`); h = { status: r.status, corpo: await r.json() }; } catch { /* subindo */ }
        return h && h.corpo.ifoodEvents === (flag ? "degraded" : "disabled");
      }, { ms: 15_000, msg: `server.js não chegou no estado esperado:\n${saida.slice(-1500)}` });
      assert.equal(h.status, 200);
      assert.ok(saida.indexOf("rodando em") > -1);
      if (flag) assert.ok(saida.indexOf("rodando em") < saida.indexOf("events.embutido_iniciado"), "HTTP antes do Events");
      assert.equal(filho.exitCode, null, "o processo continua vivo");
    } finally {
      filho.kill();
    }
  }
  await subir(true);
  await subir(false);
});
