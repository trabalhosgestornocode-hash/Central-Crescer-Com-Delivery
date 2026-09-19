// Checkpoint C3.5-C.8.2 — reconexão/recuperação da SESSÃO depois de uma falha transitória de persistência.
//
// Reproduz o incidente de 2026-09-19 PONTA A PONTA: o adapter REAL (fila serial, cifra AES-GCM real, creds
// reais do Baileys) + a máquina de estados REAL da sessão + um socket falso determinístico + um backend
// falso com falha injetável. Nenhum tempo real (agendas falsas), nenhuma rede, nenhum auth real.
//
// Antes: persistência falha -> socket fecha (428) -> conectar() -> o drain relançava o erro antigo ->
// `reconexao.abortada_persistencia_pendente_falhou` -> processo vivo, lease saudável, desired=CONNECTED e
// NUNCA mais uma tentativa. Agora: a falha é classificada, o snapshot mais novo é regravado assim que o
// backend volta, e a reconexão é reagendada com backoff (timer único e cancelável).
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { initAuthCreds } from "baileys";
import { criarSessaoBaileys, STATUS_CONEXAO } from "../src/baileysSession.js";
import { criarAuthStateAdapter, AuthStateLoadError } from "../src/authState.js";
import { AuthPersistenciaError } from "../src/classificacaoFalhas.js";
import { decriptar, normalizarChave } from "../src/crypto.js";
import { erro, CODIGOS } from "../src/errors.js";

const LOGGED_OUT = 401;
const CONEXAO_PERDIDA = 408;
const CONNECTION_CLOSED = 428;
const CHAVE_ENV = randomBytes(32).toString("base64");
const CHAVE = normalizarChave(CHAVE_ENV);
const AUTH_SESSION_ID = "22222222-2222-4222-8222-222222222222";

const http = (status, extra = {}) => Object.assign(erro(CODIGOS.INDISPONIVEL, { status, corpo: {} }), extra);
const assentar = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const marcaDe = (cifrado) => JSON.parse(decriptar(cifrado, CHAVE)).creds.nextPreKeyId;

function socketFalsoFabrica() {
  const criados = [];
  function fabrica() {
    const ev = new EventEmitter();
    const socket = {
      ev, user: null,
      sendMessage: mock.fn(async () => ({ key: { id: "wa-1" } })),
      readMessages: mock.fn(async () => {}),
      end: mock.fn(async () => {}),
    };
    criados.push(socket);
    return socket;
  }
  fabrica.criados = criados;
  return fabrica;
}

/** Agenda falsa: nada dispara sozinho. `cancelar` invalida; `disparar` executa como o setTimeout faria. */
function agendaFalsa() {
  const itens = [];
  return {
    agendar: (fn, ms) => { itens.push({ fn, ms, cancelado: false, disparado: false }); return itens.length - 1; },
    cancelar: (id) => { if (itens[id]) itens[id].cancelado = true; },
    todos: () => itens,
    pendentes: () => itens.filter((t) => !t.cancelado && !t.disparado),
    async dispararUltimo() {
      const t = itens.at(-1);
      assert.ok(t && !t.cancelado && !t.disparado, "o último timer não está pendente");
      t.disparado = true;
      t.fn();
      await assentar();
    },
    /** Dispara um timer JÁ cancelado/disparado (callback tardio que escapou) — nunca pode ter efeito. */
    async dispararCru(i) { itens[i].fn(); await assentar(); },
  };
}

/**
 * Backend falso. `modoSalvar`: 'ok' | 'http500' | 'http413' | 'pendurar' (nunca responde). Guarda o último
 * estado persistido (com a marca decodificada) e serve carregarAuthState() com ele.
 */
function criarBackend() {
  const b = {
    modoSalvar: "ok",
    modoCarregar: "ok",
    salvo: null,
    chamadasSalvar: [],
    carregarTravado: null,
    definirEstadoDesejado: mock.fn(async () => ({ ok: true })),
    notificarHeartbeat: mock.fn(async () => {}),
    notificarMensagemRecebida: mock.fn(async () => {}),
    notificarStatusProvider: mock.fn(async () => {}),
    obterEstadoSessao: mock.fn(async () => ({ status: "DISCONNECTED", desiredConnectionState: "CONNECTED" })),
    resetarAuthState: mock.fn(async () => ({ ok: true })),
    confirmarAuthState: mock.fn(async () => ({})),
    async salvarAuthState(payload) {
      b.chamadasSalvar.push(marcaDe(payload.authStateEncrypted));
      if (b.modoSalvar === "http500") throw http(500);
      if (b.modoSalvar === "http413") throw http(413);
      if (b.modoSalvar === "pendurar") await new Promise(() => {});
      // 'gate': espera o teste liberar `portaoSalvar` e então FALHA (500) — permite provar o que
      // acontece DURANTE uma gravação em voo (ex.: o flush do shutdown).
      if (b.modoSalvar === "gate") { await b.portaoSalvar; throw http(500); }
      b.salvo = { authStateEncrypted: payload.authStateEncrypted, marca: marcaDe(payload.authStateEncrypted) };
      return { authSessionId: AUTH_SESSION_ID };
    },
    async carregarAuthState() {
      if (b.carregarTravado) await b.carregarTravado;
      if (b.modoCarregar === "http503") throw http(503);
      return b.salvo
        ? { authStateEncrypted: b.salvo.authStateEncrypted, authSessionId: AUTH_SESSION_ID, authConfirmado: true }
        : { status: "absent" };
    },
  };
  return b;
}

function leaseManagerFalso({ leader = true, leaseEpoch = 1 } = {}) {
  let atual = leader ? { gatewayProcessId: "proc-fake", leaseEpoch } : null;
  return {
    souLeader: () => atual != null,
    contexto: () => atual,
    notificarPerdaExterna: mock.fn(async () => { atual = null; }),
    _definirContexto(c) { atual = c; },
  };
}

/** Sessão + adapter REAIS, com agendas falsas independentes (uma p/ o retry do adapter, outra p/ a reconexão da sessão). */
async function montar({ backend = criarBackend(), leaseManager, config } = {}) {
  const lm = leaseManager ?? leaseManagerFalso();
  const agendaAuth = agendaFalsa();
  const agendaSessao = agendaFalsa();

  // Semeia um auth JÁ CONFIRMADO no backend (uma sessão real que já existia antes do incidente).
  const semeador = criarAuthStateAdapter({
    backendClient: backend, chaveEncriptacaoEnv: CHAVE_ENV, agendar: agendaFalsa().agendar, cancelar: () => {},
  });
  semeador.inicializarCreds(initAuthCreds());
  await semeador.aoAtualizarCreds({ nextPreKeyId: 1, registered: false });

  const adapter = criarAuthStateAdapter({
    backendClient: backend, chaveEncriptacaoEnv: CHAVE_ENV,
    obterContextoLease: () => lm.contexto(),
    aoLeaseStale: (m) => lm.notificarPerdaExterna(m),
    agendar: agendaAuth.agendar, cancelar: agendaAuth.cancelar,
  });
  const fabricaSocket = socketFalsoFabrica();
  const sessao = criarSessaoBaileys({
    authAdapter: adapter, backendClient: backend, fabricaSocket, DisconnectReasonLoggedOut: LOGGED_OUT,
    config: { reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "teste", gatewayVersion: "0.0.0-test", ...config },
    agendar: agendaSessao.agendar, cancelar: agendaSessao.cancelar, leaseManager: lm,
  });
  return { sessao, adapter, backend, fabricaSocket, agendaAuth, agendaSessao, lm };
}

/** Conecta e leva a sessão a CONNECTED (auth já confirmado no backend -> 'open' basta). */
async function conectarAteConnected(ctx) {
  await ctx.sessao.conectar();
  const s = ctx.fabricaSocket.criados.at(-1);
  s.user = { id: "5511999990000:1@s.whatsapp.net" };
  s.ev.emit("connection.update", { connection: "open" });
  await assentar();
  assert.equal(ctx.sessao._status(), STATUS_CONEXAO.CONNECTED, "premissa: sessão CONNECTED");
  return s;
}
const fechar = (socket, codigo = CONNECTION_CLOSED) => socket.ev.emit("connection.update", {
  connection: "close", lastDisconnect: { error: { output: { statusCode: codigo } } },
});

describe("O INCIDENTE, ponta a ponta: persistência falha -> socket fecha (428) -> a sessão NÃO fica DISCONNECTED para sempre", () => {
  test("falha de persistência com o socket vivo, close 428, backend ainda fora (reagenda, sem carregar/socket), backend volta -> regrava o estado MAIS NOVO e reconecta SOZINHA", async (t) => {
    const linhas = [];
    t.mock.method(console, "log", (s) => linhas.push(s));
    t.mock.method(console, "error", (s) => linhas.push(s));
    const ctx = await montar();
    const { sessao, adapter, backend, fabricaSocket, agendaSessao, agendaAuth } = ctx;
    const socket1 = await conectarAteConnected(ctx);
    assert.equal(backend.salvo.marca, 1);

    // 1. o backend começa a falhar (deploy do backend/5xx) e o Baileys emite um creds.update
    backend.modoSalvar = "http500";
    socket1.ev.emit("creds.update", { nextPreKeyId: 99 });
    await assentar();
    assert.equal(adapter.estadoPersistencia().sujo, true, "memória mais nova que o backend");
    assert.equal(backend.salvo.marca, 1, "o backend continua com o estado antigo");
    assert.equal(agendaAuth.pendentes().length, 1, "retry de persistência em segundo plano armado");

    // 2. o socket fecha (428) — exatamente como no incidente
    fechar(socket1);
    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(agendaSessao.pendentes().length, 1, "reconexão agendada");

    // 3. a reconexão dispara com o backend AINDA fora do ar: nada de carregar()/socket, e REAGENDA
    await agendaSessao.dispararUltimo();
    assert.equal(fabricaSocket.criados.length, 1, "nenhum socket novo com estado obsoleto");
    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(agendaSessao.pendentes().length, 1, "reagendou — ANTES abortava aqui e nunca mais tentava");
    assert.equal(adapter._snapshot().creds.nextPreKeyId, 99, "a memória mais nova NÃO foi sobrescrita");

    // 4. o backend volta
    backend.modoSalvar = "ok";
    await agendaSessao.dispararUltimo();
    assert.equal(backend.salvo.marca, 99, "o estado mais novo foi persistido ANTES do reload");
    assert.equal(fabricaSocket.criados.length, 2, "reconectou sozinha");
    assert.equal(adapter._snapshot().creds.nextPreKeyId, 99, "e o reload devolveu exatamente o estado mais novo");
    assert.equal(adapter.estadoPersistencia().sujo, false);
    assert.equal(agendaAuth.pendentes().length, 0, "o retry em segundo plano foi cancelado pelo sucesso");

    // 5. o socket novo abre e a sessão volta a CONNECTED
    const socket2 = fabricaSocket.criados[1];
    socket2.user = { id: "5511999990000:1@s.whatsapp.net" };
    socket2.ev.emit("connection.update", { connection: "open" });
    await assentar();
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTED);

    const eventos = linhas.map((s) => JSON.parse(s).evento);
    assert.ok(!eventos.includes("reconexao.abortada_persistencia_pendente_falhou"), "o beco sem saída não existe mais");
    assert.ok(eventos.includes("reconexao.persistencia_pendente_falhou"));
  });

  test("desired=CONNECTED NUNCA é tocado durante toda a recuperação automática", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    ctx.backend.modoSalvar = "http500";
    socket1.ev.emit("creds.update", { nextPreKeyId: 5 });
    await assentar();
    fechar(socket1);
    await ctx.agendaSessao.dispararUltimo();
    ctx.backend.modoSalvar = "ok";
    await ctx.agendaSessao.dispararUltimo();
    assert.equal(ctx.backend.definirEstadoDesejado.mock.calls.length, 0);
  });

  test("413 ESTRUTURAL (payload acima do teto): a reconexão PARA (permanente) — sem loop, sem socket, desired intocado", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    ctx.backend.modoSalvar = "http413";
    socket1.ev.emit("creds.update", { nextPreKeyId: 5 });
    await assentar();
    fechar(socket1);
    await ctx.agendaSessao.dispararUltimo();
    assert.equal(ctx.fabricaSocket.criados.length, 1);
    assert.equal(ctx.sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(ctx.agendaSessao.pendentes().length, 0, "permanente: nenhuma nova tentativa agendada");
    assert.equal(ctx.backend.definirEstadoDesejado.mock.calls.length, 0);
    const antes = ctx.backend.chamadasSalvar.length;
    await assentar(20);
    assert.equal(ctx.backend.chamadasSalvar.length, antes, "e nada tenta sozinho em loop");
  });
});

describe("reconexão: timer ÚNICO, sem tempestade, sem dois sockets", () => {
  test("vários close/eventos em sequência -> UM único timer pendente", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    for (let i = 0; i < 6; i++) fechar(socket1);
    assert.equal(ctx.agendaSessao.todos().length, 1, "6 close, 1 timer");
    assert.equal(ctx.agendaSessao.pendentes().length, 1);
  });

  test("disparar o MESMO callback duas vezes (duplicata) -> no máximo UM socket novo", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    fechar(socket1);
    const t = ctx.agendaSessao.todos()[0];
    t.disparado = true;
    t.fn(); t.fn(); t.fn();
    await assentar(20);
    assert.equal(ctx.fabricaSocket.criados.length, 2, "1 original + exatamente 1 reconexão");
  });

  test("conectar() em voo (carregar lento) + novo close + novo timer disparando -> ainda UM socket só", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    let liberar;
    ctx.backend.carregarTravado = new Promise((r) => { liberar = r; });
    fechar(socket1);
    await ctx.agendaSessao.dispararUltimo(); // conectar() automático fica preso no carregar()
    assert.equal(ctx.sessao._conectandoAgora(), true);

    fechar(socket1); // close duplicado enquanto a reconexão está em voo -> agenda outro timer
    assert.equal(ctx.agendaSessao.pendentes().length, 1);
    await ctx.agendaSessao.dispararUltimo(); // dispara com conectar() ainda em voo -> desiste em silêncio
    assert.equal(ctx.fabricaSocket.criados.length, 1, "ainda nenhum socket novo, e nenhum 2º conectar concorrente");

    liberar();
    await assentar(20);
    assert.equal(ctx.fabricaSocket.criados.length, 2, "exatamente UM socket novo no fim");
  });

  test("close TARDIO de um socket JÁ substituído não derruba o socket novo nem agenda reconexão por cima", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    fechar(socket1);
    await ctx.agendaSessao.dispararUltimo();
    assert.equal(ctx.fabricaSocket.criados.length, 2);
    const socket2 = ctx.fabricaSocket.criados[1];
    socket2.user = { id: "5511999990000:1@s.whatsapp.net" };
    socket2.ev.emit("connection.update", { connection: "open" });
    await assentar();
    assert.equal(ctx.sessao._status(), STATUS_CONEXAO.CONNECTED);
    const timersAntes = ctx.agendaSessao.todos().length;

    fechar(socket1, CONEXAO_PERDIDA); // evento tardio do socket VELHO
    assert.equal(ctx.sessao._status(), STATUS_CONEXAO.CONNECTED, "o socket novo continua CONNECTED");
    assert.equal(ctx.agendaSessao.todos().length, timersAntes, "nenhuma reconexão agendada por cima do socket novo");
  });

  test("reconexão TRANSITÓRIA repetida: backoff sempre <= teto configurado, sem nunca desistir (sem limite de tentativas, sem agressividade)", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    ctx.backend.modoSalvar = "http500";
    socket1.ev.emit("creds.update", { nextPreKeyId: 7 });
    await assentar();
    fechar(socket1);
    for (let i = 0; i < 15; i++) await ctx.agendaSessao.dispararUltimo();
    const esperas = ctx.agendaSessao.todos().map((t) => t.ms);
    assert.equal(esperas.length, 16, "cada falha transitória reagenda a próxima");
    for (const ms of esperas) assert.ok(ms <= 40 + 0.001, `atraso ${ms} passou do teto`);
    assert.ok(esperas[0] < esperas[3], "cresce exponencialmente até o teto");
    assert.equal(ctx.fabricaSocket.criados.length, 1, "nenhum socket enquanto o backend está fora");
  });

  test("EXCEÇÃO INESPERADA é LIMITADA: um bug determinístico não reagenda para sempre (10 tentativas, depois log de esgotado)", async (t) => {
    const linhas = [];
    t.mock.method(console, "log", (s) => linhas.push(s));
    t.mock.method(console, "error", (s) => linhas.push(s));
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    // a fábrica de socket passa a lançar (bug determinístico): a exceção sai de conectar()
    const fabricaOriginal = ctx.fabricaSocket;
    const sessaoQuebrada = criarSessaoBaileys({
      authAdapter: ctx.adapter, backendClient: ctx.backend, DisconnectReasonLoggedOut: LOGGED_OUT,
      config: { reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "t", gatewayVersion: "x" },
      fabricaSocket: (...a) => { if (fabricaOriginal.criados.length >= 1 && globalThis.__quebrar) throw new Error("bug"); return fabricaOriginal(...a); },
      agendar: ctx.agendaSessao.agendar, cancelar: ctx.agendaSessao.cancelar, leaseManager: ctx.lm,
    });
    await sessaoQuebrada.conectar();
    const sock = fabricaOriginal.criados.at(-1);
    sock.user = { id: "5511999990000:1@s.whatsapp.net" };
    sock.ev.emit("connection.update", { connection: "open" });
    await assentar();
    globalThis.__quebrar = true;
    try {
      fechar(sock);
      for (let i = 0; i < 30 && ctx.agendaSessao.pendentes().length; i++) await ctx.agendaSessao.dispararUltimo();
    } finally { delete globalThis.__quebrar; }
    assert.ok(ctx.agendaSessao.todos().length <= 12, `reagendou ${ctx.agendaSessao.todos().length}x: deveria parar em ~10`);
    assert.ok(linhas.map((s) => JSON.parse(s)).some((l) => l.evento === "reconexao.esgotada_falhas_inesperadas"));
    assert.equal(ctx.agendaSessao.pendentes().length, 0);
    void socket1;
  });
});

describe("cancelamento: lease perdida, desired DISCONNECTED, LOGGED_OUT, reset, shutdown", () => {
  test("lease perdida enquanto o timer espera (sem passar por _forcarFailSafe): o timer dispara e NÃO abre socket, nem reagenda", async (t) => {
    const linhas = [];
    t.mock.method(console, "log", (s) => linhas.push(s));
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    fechar(socket1);
    assert.equal(ctx.agendaSessao.pendentes().length, 1);
    ctx.lm._definirContexto(null); // perdeu a lease
    await ctx.agendaSessao.dispararUltimo();
    assert.equal(ctx.fabricaSocket.criados.length, 1, "sem lease nenhum socket");
    assert.equal(ctx.agendaSessao.pendentes().length, 0, "e sem reagendar (quem decide é o restore do próximo epoch)");
    assert.ok(linhas.map((s) => JSON.parse(s)).some((l) => l.evento === "reconexao.cancelada" && l.causa === "sem_lease"));
  });

  test("perda de lease via _forcarFailSafe(): o timer é CANCELADO (agenda.cancelar), um callback tardio não abre socket, o pendente é descartado", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    ctx.backend.modoSalvar = "http500";
    socket1.ev.emit("creds.update", { nextPreKeyId: 3 });
    await assentar();
    fechar(socket1);
    assert.equal(ctx.agendaSessao.pendentes().length, 1);

    await ctx.sessao._forcarFailSafe();
    assert.equal(ctx.agendaSessao.todos()[0].cancelado, true, "cancelarReconexao() cancelou o timer");
    assert.equal(ctx.agendaAuth.pendentes().length, 0, "e o retry de persistência também");
    assert.equal(ctx.adapter.estadoPersistencia().sujo, false, "memória obsoleta descartada: o backend é a verdade no próximo epoch");

    ctx.lm._definirContexto({ gatewayProcessId: "proc-fake", leaseEpoch: 2 }); // até voltando a ser leader...
    await ctx.agendaSessao.dispararCru(0); // ...um callback tardio do timer cancelado não faz nada
    assert.equal(ctx.fabricaSocket.criados.length, 1);
  });

  test("desired=DISCONNECTED (/disconnect do operador) com reconexão pendente: cancela o timer; um callback tardio não reconecta", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    fechar(socket1);
    assert.equal(ctx.agendaSessao.pendentes().length, 1);

    await ctx.sessao.desconectar({ persistirIntencao: true });
    assert.equal(ctx.backend.definirEstadoDesejado.mock.calls.at(-1).arguments[0].desiredConnectionState, "DISCONNECTED");
    assert.equal(ctx.agendaSessao.todos()[0].cancelado, true);
    await ctx.agendaSessao.dispararCru(0);
    assert.equal(ctx.fabricaSocket.criados.length, 1, "nada reconectou depois do DISCONNECTED");
    assert.equal(ctx.sessao._status(), STATUS_CONEXAO.DISCONNECTED);
  });

  test("conectar() EM VOO quando desconectar() chega: NUNCA abre o socket depois do cancelamento", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    let liberar;
    ctx.backend.carregarTravado = new Promise((r) => { liberar = r; });
    fechar(socket1);
    await ctx.agendaSessao.dispararUltimo(); // reconexão em voo, presa no carregar()
    await ctx.sessao.desconectar({ persistirIntencao: true });
    liberar();
    await assentar(20);
    assert.equal(ctx.fabricaSocket.criados.length, 1, "a tentativa em voo detectou o cancelamento antes de abrir o socket");
  });

  test("LOGGED_OUT cancela a reconexão pendente e ela nunca reabre socket", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    fechar(socket1, CONEXAO_PERDIDA);
    assert.equal(ctx.agendaSessao.pendentes().length, 1);
    fechar(socket1, LOGGED_OUT); // o WhatsApp invalidou a sessão
    assert.equal(ctx.sessao._status(), STATUS_CONEXAO.LOGGED_OUT);
    assert.equal(ctx.agendaSessao.todos()[0].cancelado, true);
    await ctx.agendaSessao.dispararCru(0);
    assert.equal(ctx.fabricaSocket.criados.length, 1);
    assert.equal(ctx.sessao._status(), STATUS_CONEXAO.LOGGED_OUT, "LOGGED_OUT continua terminal");
  });

  test("reset explícito cancela a reconexão pendente", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    fechar(socket1);
    await ctx.sessao.resetarSessao();
    assert.equal(ctx.agendaSessao.todos()[0].cancelado, true);
    await ctx.agendaSessao.dispararCru(0);
    assert.equal(ctx.fabricaSocket.criados.length, 1);
  });

  test("SHUTDOWN (SIGTERM -> desconectar() sem persistirIntencao): cancela reconexão e retries, faz o flush FINAL do estado mais novo e nunca reconecta", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    ctx.backend.modoSalvar = "http500";
    socket1.ev.emit("creds.update", { nextPreKeyId: 77 });
    await assentar();
    fechar(socket1);
    assert.equal(ctx.adapter.estadoPersistencia().sujo, true);
    assert.equal(ctx.backend.salvo.marca, 1);

    ctx.backend.modoSalvar = "ok"; // o backend voltou bem no momento do shutdown
    await ctx.sessao.desconectar(); // shutdown técnico: NÃO persiste intenção
    assert.equal(ctx.backend.definirEstadoDesejado.mock.calls.length, 0, "shutdown técnico nunca mexe no desired");
    assert.equal(ctx.agendaSessao.todos()[0].cancelado, true, "reconexão cancelada");
    assert.equal(ctx.agendaAuth.pendentes().length, 0, "retry em segundo plano cancelado");
    assert.equal(ctx.backend.salvo.marca, 77, "flush FINAL: o estado mais novo chegou ao backend antes de a memória sumir");
    await ctx.agendaSessao.dispararCru(0);
    assert.equal(ctx.fabricaSocket.criados.length, 1, "nenhuma nova conexão depois do shutdown");
  });

  test("shutdown com o backend PENDURADO: o flush final tem TETO de tempo — o encerramento nunca fica preso", async () => {
    const ctx = await montar({ config: { flushFinalAuthTimeoutMs: 30 } });
    const socket1 = await conectarAteConnected(ctx);
    ctx.backend.modoSalvar = "http500";
    socket1.ev.emit("creds.update", { nextPreKeyId: 8 });
    await assentar();
    ctx.backend.modoSalvar = "pendurar"; // o backend nunca responde
    const t0 = Date.now();
    await ctx.sessao.desconectar();
    assert.ok(Date.now() - t0 < 2000, "desconectar() não pode esperar o backend pendurado");
  });

  test("shutdown sem lease: nenhum flush (o fencing recusaria) e nenhuma chamada ao backend", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    ctx.backend.modoSalvar = "http500";
    socket1.ev.emit("creds.update", { nextPreKeyId: 8 });
    await assentar();
    ctx.lm._definirContexto(null);
    const antes = ctx.backend.chamadasSalvar.length;
    await ctx.sessao.desconectar();
    assert.equal(ctx.backend.chamadasSalvar.length, antes);
  });
});

describe("/connect manual: nunca destrói a intenção por uma falha TRANSITÓRIA", () => {
  test("carregar() com backend fora (http_error): fail-closed (sem QR/socket) e desired=CONNECTED PRESERVADO — nenhum rollback", async () => {
    const ctx = await montar();
    ctx.backend.modoCarregar = "http503";
    await ctx.sessao.conectar({ persistirIntencaoConectada: true });
    assert.equal(ctx.fabricaSocket.criados.length, 0);
    assert.equal(ctx.sessao.obterQrAtual(), null);
    const escritas = ctx.backend.definirEstadoDesejado.mock.calls.map((c) => c.arguments[0].desiredConnectionState);
    assert.deepEqual(escritas, ["CONNECTED"], "só gravou CONNECTED — NUNCA reverteu para DISCONNECTED por causa de uma falha transitória");
  });

  test("persistência pendente TRANSITÓRIA (500) no /connect: DISCONNECTED, sem socket, desired=CONNECTED preservado", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    ctx.backend.modoSalvar = "http500";
    socket1.ev.emit("creds.update", { nextPreKeyId: 4 });
    await assentar();
    fechar(socket1);
    ctx.agendaSessao.todos().forEach((t) => { t.cancelado = true; }); // isola: só o /connect manual

    await ctx.sessao.conectar({ persistirIntencaoConectada: true });
    assert.equal(ctx.fabricaSocket.criados.length, 1, "nenhum socket novo");
    assert.equal(ctx.adapter._snapshot().creds.nextPreKeyId, 4, "memória mais nova intacta");
    const escritas = ctx.backend.definirEstadoDesejado.mock.calls.map((c) => c.arguments[0].desiredConnectionState);
    assert.deepEqual(escritas, ["CONNECTED"], "sem rollback");
    assert.equal(ctx.agendaSessao.pendentes().length, 1, "sessão já autenticada: reagenda a reconexão com backoff");
  });

  test("falha PERMANENTE no /connect (413): mantém o comportamento de sempre — rollback do desired para DISCONNECTED", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    ctx.backend.modoSalvar = "http413";
    socket1.ev.emit("creds.update", { nextPreKeyId: 4 });
    await assentar();
    fechar(socket1);
    ctx.agendaSessao.todos().forEach((t) => { t.cancelado = true; });
    await ctx.sessao.conectar({ persistirIntencaoConectada: true });
    const escritas = ctx.backend.definirEstadoDesejado.mock.calls.map((c) => c.arguments[0].desiredConnectionState);
    assert.deepEqual(escritas, ["CONNECTED", "DISCONNECTED"]);
    assert.equal(ctx.fabricaSocket.criados.length, 1);
  });

  test("/connect manual substitui uma reconexão automática pendente, e um 2º /connect concorrente recebe erro claro (nunca dois sockets)", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    fechar(socket1);
    assert.equal(ctx.agendaSessao.pendentes().length, 1);

    let liberar;
    ctx.backend.carregarTravado = new Promise((r) => { liberar = r; });
    const p1 = ctx.sessao.conectar({ persistirIntencaoConectada: true });
    await assentar();
    assert.equal(ctx.agendaSessao.todos()[0].cancelado, true, "a decisão do operador substituiu o timer automático");
    await assert.rejects(ctx.sessao.conectar({ persistirIntencaoConectada: true }), (e) => e.codigo === CODIGOS.JA_CONECTADO);
    liberar();
    await p1;
    assert.equal(ctx.fabricaSocket.criados.length, 2, "exatamente um socket novo");
  });
});

describe("confirmação durável: falha transitória reagenda, permanente é fail-safe terminal", () => {
  async function abrirSemConfirmacao(ctx) {
    // Auth existente mas NUNCA confirmado (authConfirmado=false): o 'open' exige o dance de confirmação.
    ctx.backend.carregarAuthState = async () => ({
      authStateEncrypted: ctx.backend.salvo.authStateEncrypted, authSessionId: AUTH_SESSION_ID, authConfirmado: false,
    });
    await ctx.sessao.conectar();
    const s = ctx.fabricaSocket.criados.at(-1);
    s.user = { id: "5511999990000:1@s.whatsapp.net" };
    return s;
  }

  test("confirmarAuthState com 503 (transitório): socket fechado, NUNCA CONNECTED, reconexão REAGENDADA", async () => {
    const ctx = await montar();
    ctx.backend.confirmarAuthState = mock.fn(async () => { throw http(503); });
    const s = await abrirSemConfirmacao(ctx);
    s.ev.emit("connection.update", { connection: "open" });
    await assentar();
    assert.equal(ctx.sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(s.end.mock.calls.length, 1);
    assert.equal(ctx.sessao._authConfirmado(), false);
    assert.equal(ctx.agendaSessao.pendentes().length, 1, "reagendou em vez de fail-safe terminal");
  });

  test("confirmarAuthState com 403 (o backend RECUSOU): fail-safe terminal — sem reagendar", async () => {
    const ctx = await montar();
    ctx.backend.confirmarAuthState = mock.fn(async () => { throw http(403); });
    const s = await abrirSemConfirmacao(ctx);
    s.ev.emit("connection.update", { connection: "open" });
    await assentar();
    assert.equal(ctx.sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(ctx.agendaSessao.pendentes().length, 0);
  });

  test("confirmação com persistência pendente transitória: fecha o socket, reagenda; o reconnect seguinte flusha e CONFIRMA", async () => {
    const ctx = await montar();
    const socketPrimeiro = await abrirSemConfirmacao(ctx);
    ctx.backend.modoSalvar = "http500";
    socketPrimeiro.ev.emit("creds.update", { nextPreKeyId: 55 }); // sujo, backend falhando
    await assentar();
    socketPrimeiro.ev.emit("connection.update", { connection: "open" });
    await assentar();
    assert.equal(ctx.backend.confirmarAuthState.mock.calls.length, 0, "não confirma uma geração cujo estado mais novo só existe em memória");
    assert.equal(ctx.sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(ctx.agendaSessao.pendentes().length, 1);

    ctx.backend.modoSalvar = "ok"; // backend voltou
    await ctx.agendaSessao.dispararUltimo();
    assert.equal(ctx.backend.salvo.marca, 55);
    assert.equal(ctx.fabricaSocket.criados.length, 2);
    const s2 = ctx.fabricaSocket.criados[1];
    s2.user = { id: "5511999990000:1@s.whatsapp.net" };
    s2.ev.emit("connection.update", { connection: "open" });
    await assentar();
    assert.equal(ctx.backend.confirmarAuthState.mock.calls.length, 1);
    assert.equal(ctx.sessao._status(), STATUS_CONEXAO.CONNECTED);
  });
});

describe("restore automático (por epoch): falha transitória do backend não é mais 'desistir'", () => {
  function adapterRestore({ carregar }) {
    return {
      carregar,
      inicializarCreds() {},
      comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
      obterAuthSessionIdAtual() { return AUTH_SESSION_ID; },
    };
  }
  function montarRestore({ carregar, obterEstadoSessao }) {
    const backend = criarBackend();
    if (obterEstadoSessao) backend.obterEstadoSessao = obterEstadoSessao;
    const agenda = agendaFalsa();
    const lm = leaseManagerFalso({ leaseEpoch: 4 });
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: adapterRestore({ carregar }), backendClient: backend, fabricaSocket, DisconnectReasonLoggedOut: LOGGED_OUT,
      config: { reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "t", gatewayVersion: "x" },
      agendar: agenda.agendar, cancelar: agenda.cancelar, leaseManager: lm,
    });
    return { sessao, agenda, lm, fabricaSocket, backend };
  }

  test("http_error ao LER o auth no restore (ex.: deploy do backend): reagenda em vez de marcar o epoch como 'corrompido' — e restaura quando volta", async () => {
    let n = 0;
    const carregar = async () => {
      if (++n <= 2) throw new AuthStateLoadError("http_error");
      return { status: "loaded", authConfirmado: true, authSessionId: AUTH_SESSION_ID };
    };
    const { sessao, agenda, fabricaSocket } = montarRestore({ carregar });
    await sessao._restaurarSessaoSePossivel();
    assert.equal(fabricaSocket.criados.length, 0);
    assert.equal(agenda.pendentes().length, 1, "retry agendado");
    assert.equal(sessao._epochRestoreAvaliado(), null, "o epoch NÃO foi dado como avaliado");
    await agenda.dispararUltimo();
    assert.equal(agenda.pendentes().length, 1);
    await agenda.dispararUltimo();
    assert.equal(fabricaSocket.criados.length, 1, "restaurou assim que o backend voltou");
    assert.equal(sessao._epochRestoreAvaliado(), 4);
  });

  test("falhas transitórias além do antigo orçamento (6 tentativas / ~1 min): continua tentando com atraso <= teto, e restaura depois", async (t) => {
    const linhas = [];
    t.mock.method(console, "log", (s) => linhas.push(s));
    t.mock.method(console, "error", (s) => linhas.push(s));
    let n = 0;
    const { sessao, agenda, fabricaSocket } = montarRestore({
      carregar: async () => ({ status: "loaded", authConfirmado: true, authSessionId: AUTH_SESSION_ID }),
      obterEstadoSessao: mock.fn(async () => {
        if (++n <= 9) throw new Error("backend indisponível");
        return { status: "DISCONNECTED", desiredConnectionState: "CONNECTED" };
      }),
    });
    await sessao._restaurarSessaoSePossivel();
    for (let i = 0; i < 9; i++) await agenda.dispararUltimo();
    assert.equal(fabricaSocket.criados.length, 1, "antes: desistia na 6ª falha e ficava sem restore até o epoch mudar");
    for (const it of agenda.todos()) assert.ok(it.ms <= 30_000, "atraso limitado pelo teto do restore");
    assert.ok(linhas.map((s) => JSON.parse(s)).some((l) => l.evento === "restore.falhas_transitorias_persistentes"), "avisa em ERROR (uma vez) que passou do orçamento antigo");
    assert.ok(!linhas.map((s) => JSON.parse(s)).some((l) => l.evento === "restore.desistiu_apos_falhas_transitorias"));
  });

  test("o retry do restore continua cancelável: perder a lease para de tentar", async () => {
    const { sessao, agenda, lm, fabricaSocket, backend } = montarRestore({
      carregar: async () => ({ status: "loaded", authConfirmado: true, authSessionId: AUTH_SESSION_ID }),
      obterEstadoSessao: mock.fn(async () => { throw new Error("fora"); }),
    });
    await sessao._restaurarSessaoSePossivel();
    const antes = backend.obterEstadoSessao.mock.calls.length;
    lm._definirContexto(null);
    await agenda.dispararUltimo();
    assert.equal(backend.obterEstadoSessao.mock.calls.length, antes);
    assert.equal(fabricaSocket.criados.length, 0);
  });

  test("decrypt_error no restore continua sendo NOOP definitivo (fail-safe: nunca em loop)", async () => {
    const { sessao, agenda, fabricaSocket } = montarRestore({ carregar: async () => { throw new AuthStateLoadError("decrypt_error"); } });
    await sessao._restaurarSessaoSePossivel();
    assert.equal(agenda.pendentes().length, 0);
    assert.equal(fabricaSocket.criados.length, 0);
    assert.equal(sessao._epochRestoreAvaliado(), 4);
  });

  test("restore não abre um 2º socket enquanto um conectar() está em voo", async () => {
    const carregar = mock.fn(async () => ({ status: "loaded", authConfirmado: true, authSessionId: AUTH_SESSION_ID }));
    const ctx = montarRestore({ carregar });
    let liberar;
    const travado = new Promise((r) => { liberar = r; });
    ctx.backend.carregarAuthState = async () => { await travado; return { status: "absent" }; };
    // conectar() manual em voo com adapter fake que trava o carregar
    const adapterLento = adapterRestore({ carregar: async () => { await travado; return { status: "loaded", authConfirmado: true, authSessionId: AUTH_SESSION_ID }; } });
    const sessao = criarSessaoBaileys({
      authAdapter: adapterLento, backendClient: ctx.backend, fabricaSocket: ctx.fabricaSocket, DisconnectReasonLoggedOut: LOGGED_OUT,
      config: { reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "t", gatewayVersion: "x" },
      agendar: ctx.agenda.agendar, cancelar: ctx.agenda.cancelar, leaseManager: ctx.lm,
    });
    const p = sessao.conectar();
    await assentar();
    await sessao._restaurarSessaoSePossivel();
    liberar();
    await p;
    await assentar();
    assert.equal(ctx.fabricaSocket.criados.length, 1, "só o conectar() em voo abriu socket");
  });
});

describe("guardas defensivas (lacunas apontadas pela mutação)", () => {
  test("cancelamento DURANTE o caminho AUTH_ABSENT (import dinâmico do Baileys): a tentativa em voo NUNCA abre o socket", async () => {
    const fabricaSocket = socketFalsoFabrica();
    let sessao;
    const adapter = {
      async carregar() { return { status: "absent" }; },
      // chamado DEPOIS do `await import("baileys")` e ANTES da reconferência final: um desconectar() chega bem aqui
      inicializarCreds() { sessao.desconectar().catch(() => {}); },
      comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
      async garantirPersistido() { return { status: "limpo" }; },
      obterAuthSessionIdAtual() { return AUTH_SESSION_ID; },
    };
    sessao = criarSessaoBaileys({
      authAdapter: adapter, backendClient: criarBackend(), fabricaSocket, DisconnectReasonLoggedOut: LOGGED_OUT,
      config: { reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "t", gatewayVersion: "x" },
      agendar: agendaFalsa().agendar, cancelar: () => {}, leaseManager: leaseManagerFalso(),
    });
    await sessao.conectar();
    await assentar(20);
    assert.equal(fabricaSocket.criados.length, 0, "cancelado em voo: nenhum socket");
  });

  test("shutdown com o backend AINDA FORA: o flush final falha, mas NENHUM timer de retry sobrevive ao encerramento", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    ctx.backend.modoSalvar = "http500"; // continua fora durante o shutdown
    socket1.ev.emit("creds.update", { nextPreKeyId: 31 });
    await assentar();
    assert.equal(ctx.agendaAuth.pendentes().length, 1, "premissa: retry armado antes do shutdown");

    await ctx.sessao.desconectar();
    assert.equal(ctx.agendaAuth.pendentes().length, 0, "o flush que falhou REARMOU um retry — o shutdown precisa cancelá-lo de novo");
    assert.equal(ctx.agendaSessao.pendentes().length, 0);
  });

  test("restore NÃO abre socket enquanto um conectar() está em voo, mesmo que o carregar() do restore resolva ANTES (ordem inversa)", async () => {
    let n = 0;
    const portoes = [];
    const gate = () => new Promise((r) => { portoes.push(r); });
    const adapter = {
      async carregar() {
        n += 1;
        await gate();
        return { status: "loaded", authConfirmado: true, authSessionId: AUTH_SESSION_ID };
      },
      inicializarCreds() {},
      comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
      async garantirPersistido() { return { status: "limpo" }; },
      obterAuthSessionIdAtual() { return AUTH_SESSION_ID; },
    };
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: adapter, backendClient: criarBackend(), fabricaSocket, DisconnectReasonLoggedOut: LOGGED_OUT,
      config: { reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "t", gatewayVersion: "x" },
      agendar: agendaFalsa().agendar, cancelar: () => {}, leaseManager: leaseManagerFalso({ leaseEpoch: 4 }),
    });
    const pConectar = sessao.conectar(); // carregar #1 fica preso no portão 0
    await assentar();
    const pRestore = sessao._restaurarSessaoSePossivel(); // sem a guarda, carregar #2 ficaria preso no portão 1
    await assentar();
    // libera na ORDEM INVERSA: o carregar do restore (se existir) termina primeiro
    for (let i = portoes.length - 1; i >= 0; i--) { portoes[i](); await assentar(); }
    await Promise.all([pConectar, pRestore]);
    await assentar(20);
    assert.equal(fabricaSocket.criados.length, 1, "exatamente um socket — nunca dois");
    assert.equal(n, 1, "o restore nem chegou a carregar: um conectar() já estava em voo");
  });

  test("timer de reconexão que dispara com um socket JÁ em curso (aberto pelo restore) desiste ANTES de qualquer trabalho — nem tenta persistir/carregar", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    fechar(socket1);
    assert.equal(ctx.agendaSessao.pendentes().length, 1);

    // o restore por epoch abre um socket ('restore') enquanto o timer automático ainda espera
    await ctx.sessao._restaurarSessaoSePossivel();
    assert.equal(ctx.fabricaSocket.criados.length, 2);
    assert.equal(ctx.sessao._status(), STATUS_CONEXAO.CONNECTING);

    const garantir = mock.method(ctx.adapter, "garantirPersistido");
    await ctx.agendaSessao.dispararUltimo();
    assert.equal(garantir.mock.calls.length, 0, "com um socket em curso o timer sai cedo — sem flush, sem carregar");
    assert.equal(ctx.fabricaSocket.criados.length, 2);
  });
});

describe("INVARIANTE de lease perdida, ponta a ponta (C3.5-C.8.2-R)", () => {
  test("lease perdida com memória suja: pendente descartado, retries/reconexão/sockets cancelados; ao adquirir NOVA lease o processo parte do estado do BACKEND — a memória descartada nunca é reutilizada nem gravada", async () => {
    const ctx = await montar();
    const { sessao, adapter, backend, fabricaSocket, agendaAuth, agendaSessao, lm } = ctx;
    const socket1 = await conectarAteConnected(ctx);
    assert.equal(backend.salvo.marca, 1);

    backend.modoSalvar = "http500";
    socket1.ev.emit("creds.update", { nextPreKeyId: 99 }); // memória: 99, backend: 1
    await assentar();
    fechar(socket1);
    assert.equal(adapter.estadoPersistencia().sujo, true);
    assert.equal(agendaAuth.pendentes().length, 1);
    assert.equal(agendaSessao.pendentes().length, 1);

    // --- a lease é perdida (o leaseManager real zera o contexto e chama aoPerderLease -> _forcarFailSafe) ---
    lm._definirContexto(null);
    await sessao._forcarFailSafe();
    assert.equal(adapter.estadoPersistencia().sujo, false, "estado dirty da lease antiga invalidado");
    assert.equal(adapter.estadoPersistencia().memoriaObsoleta, true);
    assert.equal(agendaAuth.pendentes().length, 0, "retries cancelados");
    assert.equal(agendaSessao.pendentes().length, 0, "reconexão cancelada");
    assert.equal(fabricaSocket.criados.length, 1, "nenhum socket novo");

    // --- o MESMO processo adquire uma NOVA lease (epoch 2). Eventos tardios do socket velho NÃO gravam nada ---
    lm._definirContexto({ gatewayProcessId: "proc-fake", leaseEpoch: 2 });
    backend.modoSalvar = "ok";
    const antes = backend.chamadasSalvar.length;
    socket1.ev.emit("creds.update", { nextPreKeyId: 101 });
    await assentar();
    assert.equal(backend.chamadasSalvar.length, antes, "a memória descartada não vira snapshot sob o epoch novo");

    // --- restore do epoch novo: carrega o estado AUTORIZADO pelo backend (marca 1), não a memória (99/101) ---
    await sessao._restaurarSessaoSePossivel();
    assert.equal(fabricaSocket.criados.length, 2);
    assert.equal(adapter._snapshot().creds.nextPreKeyId, 1, "partiu do estado do backend — a memória descartada (99/101) sumiu");
    assert.equal(adapter.estadoPersistencia().memoriaObsoleta, false);

    // e a partir daí as gravações voltam ao normal, sob o epoch novo
    fabricaSocket.criados[1].ev.emit("creds.update", { nextPreKeyId: 7 });
    await assentar();
    assert.equal(backend.salvo.marca, 7);
  });

  test("lease perdida com a memória LIMPA também invalida: /connect posterior recarrega do backend e ignora eventos tardios", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    ctx.lm._definirContexto(null);
    await ctx.sessao._forcarFailSafe();
    assert.equal(ctx.adapter.estadoPersistencia().memoriaObsoleta, true);
    ctx.lm._definirContexto({ gatewayProcessId: "proc-fake", leaseEpoch: 2 });
    const antes = ctx.backend.chamadasSalvar.length;
    socket1.ev.emit("creds.update", { nextPreKeyId: 55 });
    await assentar();
    assert.equal(ctx.backend.chamadasSalvar.length, antes);
    await ctx.sessao.conectar({ persistirIntencaoConectada: true });
    assert.equal(ctx.adapter.estadoPersistencia().memoriaObsoleta, false, "carregar() do /connect trouxe o estado do backend");
    assert.equal(ctx.adapter._snapshot().creds.nextPreKeyId, 1);
  });
});

describe("garantirPersistido(): o chamador sabe quando RECONECTAR, AGUARDAR ou PARAR (sem parsing de mensagem)", () => {
  async function reconectarCom(resultado) {
    let n = 0;
    const carregar = mock.fn(async () => ({ status: "loaded", authConfirmado: true, authSessionId: AUTH_SESSION_ID }));
    const adapter = {
      carregar,
      inicializarCreds() {},
      comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
      async garantirPersistido() {
        n += 1;
        if (n === 1) return { status: "limpo" }; // 1ª conexão
        if (resultado instanceof Error) throw resultado;
        return resultado;
      },
      obterAuthSessionIdAtual() { return AUTH_SESSION_ID; },
    };
    const agenda = agendaFalsa();
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: adapter, backendClient: criarBackend(), fabricaSocket, DisconnectReasonLoggedOut: LOGGED_OUT,
      config: { reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "t", gatewayVersion: "x" },
      agendar: agenda.agendar, cancelar: agenda.cancelar, leaseManager: leaseManagerFalso(),
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    await assentar();
    fechar(fabricaSocket.criados[0], CONEXAO_PERDIDA);
    await agenda.dispararUltimo();
    return { sockets: fabricaSocket.criados.length, pendentes: agenda.pendentes().length, carregar };
  }

  for (const status of ["limpo", "persistido", "descartado"]) {
    test(`resultado '${status}' -> RECONECTA (carrega do backend e abre o socket)`, async () => {
      const r = await reconectarCom({ status });
      assert.equal(r.sockets, 2);
      assert.equal(r.carregar.mock.calls.length, 2);
      assert.equal(r.pendentes, 0);
    });
  }

  test("AuthPersistenciaError TRANSITÓRIA -> AGUARDA: sem socket, sem carregar(), reagenda", async () => {
    const r = await reconectarCom(new AuthPersistenciaError("transitoria", "http_5xx", { status: 503 }));
    assert.equal(r.sockets, 1);
    assert.equal(r.carregar.mock.calls.length, 1);
    assert.equal(r.pendentes, 1);
  });

  test("AuthPersistenciaError PERMANENTE -> PARA: sem socket, sem carregar(), sem reagendar", async () => {
    const r = await reconectarCom(new AuthPersistenciaError("permanente", "payload_grande_demais", { status: 413 }));
    assert.equal(r.sockets, 1);
    assert.equal(r.carregar.mock.calls.length, 1);
    assert.equal(r.pendentes, 0);
  });

  test("a decisão vem da CLASSE estruturada, nunca do texto: mensagem enganosa não muda o resultado", async () => {
    const e = new AuthPersistenciaError("transitoria", "http_5xx");
    e.message = "payload_grande_demais 413 permanente"; // texto enganoso
    const r = await reconectarCom(e);
    assert.equal(r.pendentes, 1, "continua sendo tratada como transitória");
  });
});

describe("413 não é 'poison' global do processo", () => {
  test("413 para o reconnect automático; depois que o backend aceita, um /connect explícito faz o flush do estado mais novo e reconecta", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    ctx.backend.modoSalvar = "http413";
    socket1.ev.emit("creds.update", { nextPreKeyId: 5 });
    await assentar();
    fechar(socket1);
    await ctx.agendaSessao.dispararUltimo();
    assert.equal(ctx.agendaSessao.pendentes().length, 0, "permanente: o automático PARA");
    assert.equal(ctx.fabricaSocket.criados.length, 1);
    const chamadas413 = ctx.backend.chamadasSalvar.length;
    await assentar(20);
    assert.equal(ctx.backend.chamadasSalvar.length, chamadas413, "sem nenhum loop automático");

    ctx.backend.modoSalvar = "ok"; // o limite do backend foi corrigido
    await ctx.sessao.conectar({ persistirIntencaoConectada: true });
    assert.equal(ctx.backend.salvo.marca, 5, "o snapshot que tinha dado 413 foi persistido agora");
    assert.equal(ctx.fabricaSocket.criados.length, 2);
    assert.equal(ctx.adapter.estadoPersistencia().sujo, false);
  });
});

describe("close de socket ANTIGO (geração A) não altera a geração B", () => {
  test("A cai, B assume e conecta; close/open/QR tardios de A NÃO alteram socket, status, confirmação, QR nem timers de B", async () => {
    const ctx = await montar();
    const socketA = await conectarAteConnected(ctx);
    fechar(socketA);
    await ctx.agendaSessao.dispararUltimo();
    const socketB = ctx.fabricaSocket.criados[1];
    socketB.user = { id: "5511999990000:1@s.whatsapp.net" };
    socketB.ev.emit("connection.update", { connection: "open" });
    await assentar();
    assert.equal(ctx.sessao._status(), STATUS_CONEXAO.CONNECTED);
    const timersAntes = ctx.agendaSessao.todos().length;
    const heartbeatsAntes = ctx.backend.notificarHeartbeat.mock.calls.length;
    const confirmarAntes = ctx.backend.confirmarAuthState.mock.calls.length;

    fechar(socketA, CONEXAO_PERDIDA);            // close tardio de A
    fechar(socketA, LOGGED_OUT);                  // até um logged_out tardio de A
    socketA.ev.emit("connection.update", { connection: "open" });   // open tardio de A
    socketA.ev.emit("connection.update", { qr: "QR-TARDIO-DE-A" }); // QR tardio de A
    await assentar();

    assert.equal(ctx.sessao._status(), STATUS_CONEXAO.CONNECTED, "status de B intacto (nem LOGGED_OUT, nem DISCONNECTED)");
    assert.equal(ctx.sessao._socketOpen(), true);
    assert.equal(ctx.sessao._authConfirmado(), true);
    assert.equal(ctx.sessao.obterQrAtual(), null, "QR de A ignorado");
    assert.equal(socketB.end.mock.calls.length, 0, "B nunca foi encerrado");
    assert.equal(ctx.agendaSessao.todos().length, timersAntes, "nenhum timer novo");
    assert.equal(ctx.sessao._reconexaoPendente(), false);
    assert.equal(ctx.backend.notificarHeartbeat.mock.calls.length, heartbeatsAntes, "nenhum heartbeat/efeito colateral do evento tardio");
    assert.equal(ctx.backend.confirmarAuthState.mock.calls.length, confirmarAntes, "o 'open' de A não confirma geração nenhuma");
    assert.equal(ctx.backend.definirEstadoDesejado.mock.calls.length, 0, "LOGGED_OUT tardio de A não grava desired");
  });
});

describe("reconnect: ordem exata persistência -> carregar -> socket", () => {
  test("erro transitório -> DISCONNECTED -> backoff -> guardas -> garantirPersistido -> carregar -> socket (nessa ordem)", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    const ordem = [];
    const garantirOriginal = ctx.adapter.garantirPersistido;
    const carregarOriginal = ctx.adapter.carregar;
    ctx.adapter.garantirPersistido = async (...a) => { ordem.push("garantirPersistido"); return garantirOriginal(...a); };
    ctx.adapter.carregar = async (...a) => { ordem.push(`carregar(sockets=${ctx.fabricaSocket.criados.length})`); return carregarOriginal(...a); };

    ctx.backend.modoSalvar = "http500";
    socket1.ev.emit("creds.update", { nextPreKeyId: 12 });
    await assentar();
    fechar(socket1);
    assert.equal(ctx.sessao._status(), STATUS_CONEXAO.DISCONNECTED, "DISCONNECTED");
    assert.equal(ctx.agendaSessao.pendentes().length, 1, "backoff agendado");
    await ctx.agendaSessao.dispararUltimo(); // falha transitória: só garantirPersistido, nada de carregar
    assert.deepEqual(ordem, ["garantirPersistido"]);
    ctx.backend.modoSalvar = "ok";
    await ctx.agendaSessao.dispararUltimo();
    assert.deepEqual(ordem, ["garantirPersistido", "garantirPersistido", "carregar(sockets=1)"], "carregar só depois do flush e ANTES de existir o socket novo");
    assert.equal(ctx.fabricaSocket.criados.length, 2);
  });
});

describe("shutdown: nenhum timer novo, nem por caminhos tardios", () => {
  test("depois de desconectar(): close tardio do socket e falha transitória de confirmação em voo NÃO criam timer de reconexão", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    await ctx.sessao.desconectar();
    fechar(socket1); // close tardio do socket já encerrado
    await assentar();
    assert.equal(ctx.sessao._reconexaoPendente(), false);
    assert.equal(ctx.agendaSessao.pendentes().length, 0);
  });

  test("falha transitória da confirmação chegando DURANTE o fail-safe por perda de lease: NÃO agenda reconexão (shutdown já solicitado)", async () => {
    const ctx = await montar();
    ctx.backend.carregarAuthState = async () => ({ authStateEncrypted: ctx.backend.salvo.authStateEncrypted, authSessionId: AUTH_SESSION_ID, authConfirmado: false });
    await ctx.sessao.conectar();
    const s = ctx.fabricaSocket.criados.at(-1);
    s.user = { id: "5511999990000:1@s.whatsapp.net" };
    let rejeitarGarantir;
    ctx.adapter.garantirPersistido = () => new Promise((_, rej) => { rejeitarGarantir = rej; }); // a confirmação fica presa aqui
    s.ev.emit("connection.update", { connection: "open" });
    await assentar();
    let liberarEnd;
    const endPendente = new Promise((r) => { liberarEnd = r; });
    s.end = mock.fn(() => endPendente); // fechar o socket demora

    ctx.lm._definirContexto(null);
    const pFail = ctx.sessao._forcarFailSafe(); // shutdown=true; agora espera o socket fechar
    await assentar();
    rejeitarGarantir(new AuthPersistenciaError("transitoria", "http_5xx")); // a confirmação falha de forma transitória NESTA janela
    await assentar();
    liberarEnd();
    await pFail;
    await assentar();

    assert.equal(ctx.sessao._reconexaoPendente(), false, "sem lease/shutdown, nenhum timer pode ser criado");
    assert.equal(ctx.agendaSessao.pendentes().length, 0);
  });

  test("shutdown com um flush final EM VOO: um callback de retry tardio NÃO enfileira uma gravação extra durante o encerramento", async () => {
    const ctx = await montar();
    const socket1 = await conectarAteConnected(ctx);
    ctx.backend.modoSalvar = "http500";
    socket1.ev.emit("creds.update", { nextPreKeyId: 31 });
    await assentar();
    const idxRetry = ctx.agendaAuth.todos().length - 1;
    assert.equal(ctx.agendaAuth.pendentes().length, 1, "premissa: retry armado");
    const gravacoesAntes = ctx.backend.chamadasSalvar.length; // (inclui a semeadura do auth inicial)

    let liberar;
    ctx.backend.portaoSalvar = new Promise((r) => { liberar = r; });
    ctx.backend.modoSalvar = "gate";
    const pDesc = ctx.sessao.desconectar(); // o flush final fica em voo no portão
    await assentar();
    await ctx.agendaAuth.dispararCru(idxRetry); // o timer do retry "dispara" no meio do flush
    liberar();
    await pDesc;
    await assentar();
    assert.equal(ctx.backend.chamadasSalvar.length, gravacoesAntes + 1, "só o flush final gravou (1); o retry cancelado não fez nenhuma gravação extra");
    assert.equal(ctx.agendaAuth.pendentes().length, 0);
  });
});

describe("compatibilidade: adapters sem a API nova (fakes antigos) continuam funcionando", () => {
  test("authAdapter sem garantirPersistido/cancelarRetries/descartarPendente: conectar/desconectar/failsafe não quebram", async () => {
    const adapter = {
      async carregar() { return { status: "absent" }; },
      inicializarCreds() {},
      comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
      obterAuthSessionIdAtual() { return AUTH_SESSION_ID; },
    };
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: adapter, backendClient: criarBackend(), fabricaSocket, DisconnectReasonLoggedOut: LOGGED_OUT,
      config: { reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "t", gatewayVersion: "x" },
      agendar: agendaFalsa().agendar, cancelar: () => {},
    });
    await sessao.conectar();
    await sessao._forcarFailSafe();
    await sessao.desconectar();
    assert.equal(fabricaSocket.criados.length, 1);
  });

  test("AuthPersistenciaError é reconhecido pela sessão como classificação pronta (não reclassificado)", async () => {
    const adapter = {
      async carregar() { return { status: "absent" }; },
      inicializarCreds() {},
      comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
      async garantirPersistido() { throw new AuthPersistenciaError("permanente", "cripto"); },
      obterAuthSessionIdAtual() { return AUTH_SESSION_ID; },
    };
    const agenda = agendaFalsa();
    const fabricaSocket = socketFalsoFabrica();
    const backend = criarBackend();
    const sessao = criarSessaoBaileys({
      authAdapter: adapter, backendClient: backend, fabricaSocket, DisconnectReasonLoggedOut: LOGGED_OUT,
      config: { reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "t", gatewayVersion: "x" },
      agendar: agenda.agendar, cancelar: agenda.cancelar, leaseManager: leaseManagerFalso(),
    });
    await sessao.conectar({ persistirIntencaoConectada: true });
    assert.equal(fabricaSocket.criados.length, 0);
    assert.equal(agenda.todos().length, 0, "permanente: nenhuma nova tentativa");
    const escritas = backend.definirEstadoDesejado.mock.calls.map((c) => c.arguments[0].desiredConnectionState);
    assert.deepEqual(escritas, ["CONNECTED", "DISCONNECTED"], "permanente no /connect: rollback do desired, como todo fail-closed terminal");
  });
});
