// RealtimeManager (frontend/src/realtime/realtimeManager.js) — infraestrutura
// central de conexão/autorização/troca de contexto/reconexão do Realtime.
//
// Arquitetura final: JWT normal da sessão Supabase Auth (setAuth com o
// access_token de sempre) + grant efêmero gravado pelo backend em
// public.realtime_channel_grants. Nenhum token customizado — ver a decisão
// registrada em database/migrations/080_realtime_channel_grants.sql.
//
// Sem jsdom no projeto: usa o EventTarget/CustomEvent nativos do Node como
// `document` (suficiente para addEventListener/dispatchEvent). Substitui o
// cliente Supabase e a chamada ao backend por fakes injetados
// (`_injetarDependenciasParaTeste`) — nunca toca rede.
//
// Rodar: node --test frontend/test/realtimeManager.test.js
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

globalThis.document = new EventTarget();
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };

const { state } = await import("../src/state.js");
const { resetarEscopoDeContexto, geracaoContexto } = await import("../src/contextoEscopo.js");
const M = await import("../src/realtime/realtimeManager.js");
const { registrarInteresse, _resetParaTeste: resetBus } = await import("../src/realtime/realtimeBus.js");
const { RESINCRONIZACAO } = await import("../src/realtime/realtimeEvents.js");

// --- fake do cliente Supabase (Auth + Realtime) -----------------------------
function criarClienteFake() {
  const canaisCriados = [];
  const removidos = [];
  const cliente = {
    ultimoAuth: null,
    auth: { onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; } },
    realtime: { setAuth(token) { cliente.ultimoAuth = token; } },
    channel(topico, opts) {
      const handlers = {};
      let statusCb = null;
      const canal = {
        topico, opts,
        on(tipo, _filtro, cb) { handlers[tipo] = cb; return canal; },
        subscribe(cb) { statusCb = cb; canaisCriados.push(canal); statusCb("SUBSCRIBED"); return canal; },
        _emitirBroadcast(payload) { handlers.broadcast?.({ payload }); },
        _emitirStatus(status) { statusCb?.(status); },
      };
      return canal;
    },
    removeChannel(canal) { removidos.push(canal); },
  };
  return { cliente, canaisCriados, removidos };
}

/** Promise controlável de fora — pra testar a corrida "contexto mudou no meio do await". */
function deferido() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

let fakeSb;
let respostaCredencial;
/** Token da sessão Supabase Auth NORMAL — o que setAuth() de fato repassa agora (nunca mais um token do grant). */
let tokenAuthAtual;

before(() => {
  // iniciar() só pode ser chamado UMA vez por processo — contextoEscopo.js
  // não tem "desregistrar" (ver comentário em realtimeManager.js#_resetParaTeste).
  M._injetarDependenciasParaTeste({
    obterCliente: async () => fakeSb?.cliente,
    solicitarCredencial: async () => respostaCredencial,
    obterTokenAuth: async () => tokenAuthAtual,
    setTimeout: () => 1, // cada teste que precisa controlar o timer injeta o próprio
    clearTimeout: () => {},
  });
  M.iniciar();
});

beforeEach(async () => {
  await M._resetParaTeste();
  resetBus();
  fakeSb = criarClienteFake();
  respostaCredencial = { validadeS: 300, topicos: [] };
  tokenAuthAtual = "auth-tok-1";
  state.sessao.empresa = null;
  state.sessao.unidade = null;
  // Timer "burro" por padrão (a maioria dos testes não precisa de renovação).
  M._injetarDependenciasParaTeste({
    obterCliente: async () => fakeSb.cliente,
    solicitarCredencial: async () => respostaCredencial,
    obterTokenAuth: async () => tokenAuthAtual,
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
});

describe("conectarParaContextoAtual — caminho feliz", () => {
  test("sem contexto (empresa nula), fica desconectado sem lançar", async () => {
    await assert.doesNotReject(() => M.conectarParaContextoAtual());
    assert.deepEqual(M._topicosAtivos(), []);
  });

  test("contexto válido com unidade: assina exatamente os tópicos que o backend devolveu, com o JWT normal da sessão", async () => {
    state.sessao.empresa = { id: "org-1" };
    state.sessao.unidade = { id: "uni-1" };
    respostaCredencial = { validadeS: 300, topicos: ["empresa:org-1", "unidade:uni-1"] };

    await M.conectarParaContextoAtual();

    assert.deepEqual(M._topicosAtivos().sort(), ["empresa:org-1", "unidade:uni-1"]);
    assert.equal(fakeSb.cliente.ultimoAuth, "auth-tok-1", "setAuth tem que usar o JWT normal da sessão, nunca um token customizado");
    assert.equal(fakeSb.canaisCriados.length, 2);
    for (const c of fakeSb.canaisCriados) assert.equal(c.opts.config.private, true, "canal tem que ser privado");
  });

  test("'Todas as unidades' (unidadeId nulo): só assina o que o backend autorizou (empresa)", async () => {
    state.sessao.empresa = { id: "org-1" };
    state.sessao.unidade = null;
    respostaCredencial = { validadeS: 300, topicos: ["empresa:org-1"] };

    await M.conectarParaContextoAtual();
    assert.deepEqual(M._topicosAtivos(), ["empresa:org-1"]);
  });

  test("nunca assina um tópico que o backend não devolveu, mesmo que o cliente 'ache' que devia (confia só no grant)", async () => {
    state.sessao.empresa = { id: "org-1" };
    state.sessao.unidade = { id: "uni-1" };
    // Backend, por algum motivo, só autorizou a unidade — não a empresa.
    respostaCredencial = { validadeS: 300, topicos: ["unidade:uni-1"] };

    await M.conectarParaContextoAtual();
    assert.deepEqual(M._topicosAtivos(), ["unidade:uni-1"]);
  });

  test("grant recusado (contexto revogado/expirado no servidor): fica desconectado, não lança", async () => {
    state.sessao.empresa = { id: "org-1" };
    respostaCredencial = null;
    await assert.doesNotReject(() => M.conectarParaContextoAtual());
    assert.deepEqual(M._topicosAtivos(), []);
  });
});

describe("troca de contexto — via contextoEscopo.js (nenhum mecanismo paralelo)", () => {
  test("troca de unidade: desliga os canais antigos e assina só os novos", async () => {
    state.sessao.empresa = { id: "org-1" };
    state.sessao.unidade = { id: "uni-A" };
    respostaCredencial = { validadeS: 300, topicos: ["empresa:org-1", "unidade:uni-A"] };
    resetarEscopoDeContexto(); // dispara o callback registrado por iniciar()
    await new Promise((r) => setImmediate(r)); // deixa a promise interna assentar

    assert.deepEqual(M._topicosAtivos().sort(), ["empresa:org-1", "unidade:uni-A"]);

    state.sessao.unidade = { id: "uni-B" };
    respostaCredencial = { validadeS: 300, topicos: ["empresa:org-1", "unidade:uni-B"] };
    resetarEscopoDeContexto();
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(M._topicosAtivos().sort(), ["empresa:org-1", "unidade:uni-B"]);
    assert.ok(fakeSb.removidos.length >= 2, "os 2 canais da unidade A tinham que ser removidos");
  });

  test("troca de empresa: não continua ouvindo a empresa anterior", async () => {
    state.sessao.empresa = { id: "org-A" };
    state.sessao.unidade = null;
    respostaCredencial = { validadeS: 300, topicos: ["empresa:org-A"] };
    resetarEscopoDeContexto();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(M._topicosAtivos(), ["empresa:org-A"]);

    state.sessao.empresa = { id: "org-B" };
    respostaCredencial = { validadeS: 300, topicos: ["empresa:org-B"] };
    resetarEscopoDeContexto();
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(M._topicosAtivos(), ["empresa:org-B"]);
    assert.ok(!M._topicosAtivos().includes("empresa:org-A"));
  });

  test("troca de perfil (mesma empresa/unidade, grant novo) reconecta do zero", async () => {
    state.sessao.empresa = { id: "org-1" };
    state.sessao.unidade = { id: "uni-1" };
    respostaCredencial = { validadeS: 300, topicos: ["empresa:org-1", "unidade:uni-1"] };
    resetarEscopoDeContexto();
    await new Promise((r) => setImmediate(r));
    const canalAntes = fakeSb.canaisCriados[0];

    respostaCredencial = { validadeS: 300, topicos: ["empresa:org-1", "unidade:uni-1"] };
    resetarEscopoDeContexto(); // troca de perfil também passa por aqui (Fase I é parte do mesmo contexto)
    await new Promise((r) => setImmediate(r));

    assert.ok(fakeSb.removidos.includes(canalAntes), "o canal do perfil anterior tem que ter sido removido");
  });

  test("evento que chega de uma geração de contexto anterior é ignorado (nunca altera a tela nova)", async () => {
    let recebidos = [];
    registrarInteresse({ eventos: null, aoReceber: (ev) => recebidos.push(ev) });

    state.sessao.empresa = { id: "org-1" };
    state.sessao.unidade = { id: "uni-A" };
    respostaCredencial = { validadeS: 300, topicos: ["unidade:uni-A"] };
    resetarEscopoDeContexto();
    await new Promise((r) => setImmediate(r));
    const canalAntigo = fakeSb.canaisCriados.find((c) => c.topico === "unidade:uni-A");

    // Troca de contexto — a geração sobe, uma nova conexão é aberta.
    state.sessao.unidade = { id: "uni-B" };
    respostaCredencial = { validadeS: 300, topicos: ["unidade:uni-B"] };
    resetarEscopoDeContexto();
    await new Promise((r) => setImmediate(r));

    // Um broadcast atrasado chega no canal ANTIGO (já removido de verdade num
    // Supabase real, mas simula uma mensagem em voo/callback tardio).
    canalAntigo._emitirBroadcast({ tipo: "dashboard_ifood.lancamento_atualizado", organizacaoId: "org-1", unidadeId: "uni-A" });

    assert.equal(recebidos.length, 0, "evento da geração antiga não pode chegar ao bus");
  });
});

describe("reconexão (Fase S/T) — resincronização, nunca confia que os eventos perdidos chegaram", () => {
  test("canal reconectando (SUBSCRIBED de novo) emite um sinal de resincronização pro bus", async () => {
    let recebidos = [];
    registrarInteresse({ eventos: [RESINCRONIZACAO], aoReceber: (ev) => recebidos.push(ev) });

    state.sessao.empresa = { id: "org-1" };
    state.sessao.unidade = { id: "uni-1" };
    respostaCredencial = { validadeS: 300, topicos: ["unidade:uni-1"] };
    await M.conectarParaContextoAtual();

    const canal = fakeSb.canaisCriados[0];
    // primeira subscrição já aconteceu dentro de connect (não conta);
    // simula uma queda + reconexão de verdade:
    canal._emitirStatus("CLOSED");
    canal._emitirStatus("SUBSCRIBED");

    assert.equal(recebidos.length, 1);
    assert.equal(recebidos[0].unidadeId, "uni-1");
  });

  test("a PRIMEIRA subscrição nunca dispara resincronização (não é uma reconexão)", async () => {
    let recebidos = [];
    registrarInteresse({ eventos: [RESINCRONIZACAO], aoReceber: (ev) => recebidos.push(ev) });
    state.sessao.empresa = { id: "org-1" };
    respostaCredencial = { validadeS: 300, topicos: ["empresa:org-1"] };
    await M.conectarParaContextoAtual();
    assert.equal(recebidos.length, 0);
  });
});

describe("logout e contexto inválido — desligam tudo", () => {
  test("app:logout desliga todos os canais", async () => {
    state.sessao.empresa = { id: "org-1" };
    respostaCredencial = { validadeS: 300, topicos: ["empresa:org-1"] };
    await M.conectarParaContextoAtual();
    assert.equal(M._topicosAtivos().length, 1);

    document.dispatchEvent(new CustomEvent("app:logout"));
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(M._topicosAtivos(), []);
  });

  test("app:contexto-invalido desliga todos os canais", async () => {
    state.sessao.empresa = { id: "org-1" };
    respostaCredencial = { validadeS: 300, topicos: ["empresa:org-1"] };
    await M.conectarParaContextoAtual();

    document.dispatchEvent(new CustomEvent("app:contexto-invalido", { detail: "encerrado" }));
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(M._topicosAtivos(), []);
  });
});

describe("renovação — falha desliga tudo, sucesso mantém e reagenda", () => {
  test("renovação bem-sucedida reaplica o JWT normal (mesmo se ele renovou) sem derrubar os canais", async () => {
    let capturado;
    M._injetarDependenciasParaTeste({ setTimeout: (fn) => { capturado = fn; return 1; } });

    state.sessao.empresa = { id: "org-1" };
    respostaCredencial = { validadeS: 300, topicos: ["empresa:org-1"] };
    await M.conectarParaContextoAtual();

    tokenAuthAtual = "auth-tok-2"; // a sessão Auth normal renovou nesse meio-tempo
    respostaCredencial = { validadeS: 300, topicos: ["empresa:org-1"] };
    await capturado(); // simula o timer de renovação disparando
    assert.equal(fakeSb.cliente.ultimoAuth, "auth-tok-2");
    assert.equal(M._topicosAtivos().length, 1, "canais continuam de pé — renovação não é reconexão");
  });

  test("renovação recusada (contexto revogado/expirado/trocado no servidor) desliga tudo", async () => {
    let capturado;
    M._injetarDependenciasParaTeste({ setTimeout: (fn) => { capturado = fn; return 1; } });

    state.sessao.empresa = { id: "org-1" };
    respostaCredencial = { validadeS: 300, topicos: ["empresa:org-1"] };
    await M.conectarParaContextoAtual();
    assert.equal(M._topicosAtivos().length, 1);

    respostaCredencial = null; // servidor recusou a renovação
    await capturado();

    assert.deepEqual(M._topicosAtivos(), [], "sem grant novo, o Realtime deste contexto tem que cair");
  });

  test("corrida: 2 trocas de contexto seguidas — a resposta tardia da PRIMEIRA nunca sobrescreve a da segunda", async () => {
    // Reproduz o caminho real: quem dispara conectarParaContextoAtual() é
    // sempre o callback de resetarEscopoDeContexto() (nunca uma chamada
    // direta) — é a geração que ele bumpa a cada disparo que protege a
    // corrida, exatamente como em app.js#mostrarApp/sessao.js.
    const { promise, resolve } = deferido();
    let chamouSolicitar = 0;
    M._injetarDependenciasParaTeste({
      solicitarCredencial: async () => {
        chamouSolicitar++;
        if (chamouSolicitar === 1) return promise; // a primeira fica pendurada
        return { validadeS: 300, topicos: ["empresa:org-2"] };
      },
    });

    state.sessao.empresa = { id: "org-1" };
    resetarEscopoDeContexto(); // dispara a 1ª conexão (fica pendurada no grant)

    state.sessao.empresa = { id: "org-2" };
    resetarEscopoDeContexto(); // geração sobe de novo — dispara a 2ª conexão
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(M._topicosAtivos(), ["empresa:org-2"]);

    // Só agora o grant da conexão ANTIGA chega — tem que ser descartado.
    resolve({ validadeS: 300, topicos: ["empresa:org-1"] });
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(M._topicosAtivos(), ["empresa:org-2"], "a resposta tardia da conexão antiga não pode substituir a atual");
  });
});
