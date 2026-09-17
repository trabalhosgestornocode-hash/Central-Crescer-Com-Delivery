// Testes de lifecycle/reconexão/heartbeat da sessão Baileys — SEM rede,
// SEM QR real, SEM conectar nenhuma conta. `fabricaSocket` é um fake
// determinístico injetado (mesmo mecanismo de dependência que server.js usa
// para injetar o `makeWASocket` real em produção).
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { criarSessaoBaileys, STATUS_CONEXAO, paraJid, deJid } from "../src/baileysSession.js";

const DISCONNECT_REASON_LOGGED_OUT = 401; // mesmo valor real do Baileys (DisconnectReason.loggedOut)
const DISCONNECT_REASON_CONNECTION_LOST = 408;

function socketFalsoFabrica() {
  const criados = [];
  const opcoesRecebidas = [];
  function fabrica(opcoes) {
    opcoesRecebidas.push(opcoes);
    const ev = new EventEmitter();
    const socket = {
      ev,
      user: null,
      sendMessage: mock.fn(async (_jid, _conteudo) => ({ key: { id: `wa-${criados.length}-${Date.now()}` } })),
      readMessages: mock.fn(async () => {}),
      end: mock.fn(async () => {}),
    };
    criados.push(socket);
    return socket;
  }
  fabrica.criados = criados;
  fabrica.opcoesRecebidas = opcoesRecebidas;
  return fabrica;
}

function authAdapterFalso() {
  return {
    async carregar() { return false; },
    inicializarCreds() {},
    comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
    async aoAtualizarCreds() {},
  };
}

function backendClientFalso() {
  return {
    notificarHeartbeat: mock.fn(async () => {}),
    notificarMensagemRecebida: mock.fn(async () => {}),
    notificarStatusProvider: mock.fn(async () => {}),
  };
}

function configFalso() {
  return {
    reconnect: { baseMs: 10, tetoMs: 40 },
    heartbeatMs: 1_000_000, // não dispara sozinho durante o teste
    providerInstanceId: "teste",
    gatewayVersion: "0.0.0-test",
  };
}

describe("baileysSession — helpers de JID", () => {
  test("paraJid/deJid são inversas para um E.164 simples", () => {
    assert.equal(paraJid("+5511999990000"), "5511999990000@s.whatsapp.net");
    assert.equal(deJid("5511999990000@s.whatsapp.net"), "+5511999990000");
  });
});

describe("baileysSession — logger do Baileys é sempre silenciado", () => {
  test("conectar() passa um logger com o contrato ILogger (level/child/trace/debug/info/warn/error) para fabricaSocket", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar();

    const opcoes = fabricaSocket.opcoesRecebidas[0];
    assert.ok(opcoes.logger, "esperava um logger explícito — nunca o default do Baileys");
    assert.equal(typeof opcoes.logger.level, "string");
    assert.equal(typeof opcoes.logger.child, "function");
    for (const nivel of ["trace", "debug", "info", "warn", "error"]) {
      assert.equal(typeof opcoes.logger[nivel], "function");
    }
    // encadeável, como o Baileys faz internamente (logger.child({class:'baileys'}))
    const filho = opcoes.logger.child({ class: "baileys" });
    assert.equal(typeof filho.info, "function");
  });
});

describe("baileysSession — diagnóstico do close (Checkpoint C3, investigação read-only)", () => {
  function capturarLogs(t) {
    const linhas = [];
    t.mock.method(console, "log", (s) => linhas.push(s));
    t.mock.method(console, "error", (s) => linhas.push(s));
    return linhas;
  }

  test("close loga codigoDesconexao SEM mascarar (não usa a chave ambígua 'codigo') e razaoDesconexao com o nome certo do DisconnectReason", async (t) => {
    const linhas = capturarLogs(t);
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar: () => {},
    });

    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_CONNECTION_LOST } } },
    });

    const linha = linhas.map((s) => JSON.parse(s)).find((l) => l.evento === "conexao.fechada_transitoria");
    assert.ok(linha, "esperava o evento conexao.fechada_transitoria");
    assert.equal(linha.codigoDesconexao, DISCONNECT_REASON_CONNECTION_LOST, "código não pode vir mascarado");
    assert.equal(linha.razaoDesconexao, "connectionLost_ou_timedOut");
  });

  test("close loga registradoNoFechamento refletindo creds.registered NO INSTANTE do close (não o valor de antes de conectar())", async (t) => {
    const linhas = capturarLogs(t);
    const fabricaSocket = socketFalsoFabrica();
    let registradoAgora = false;
    const authAdapterDinamico = {
      async carregar() { return false; },
      inicializarCreds() {},
      comoAuthState() { return { creds: { registered: registradoAgora }, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
    };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterDinamico, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar: () => {},
    });

    await sessao.conectar();
    registradoAgora = true; // simula o Baileys tendo confirmado o registro entre o connect() e o close
    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_CONNECTION_LOST } } },
    });

    const linha = linhas.map((s) => JSON.parse(s)).find((l) => l.evento === "conexao.fechada_transitoria");
    assert.equal(linha.registradoNoFechamento, true, "deveria refletir o valor NO MOMENTO do close, não o de antes de conectar()");
  });

  test("creds.update loga só um booleano ('registrado') — NUNCA o objeto de creds real, mesmo com campos no formato de segredos", async (t) => {
    const linhas = capturarLogs(t);
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });

    await sessao.conectar();
    const credsFalsosComSegredos = {
      registered: true,
      noiseKey: { private: "NUNCA-PODE-VAZAR-ISTO" },
      signedIdentityKey: { private: "NEM-ISTO" },
    };
    fabricaSocket.criados[0].ev.emit("creds.update", credsFalsosComSegredos);

    const linha = linhas.map((s) => JSON.parse(s)).find((l) => l.evento === "creds_update.recebido");
    assert.ok(linha);
    assert.equal(linha.registrado, true);
    assert.equal(Object.keys(linha).filter((k) => k !== "severity" && k !== "servico" && k !== "evento").length, 1, "só o campo 'registrado' além dos padrões");
    for (const s of linhas) assert.ok(!s.includes("NUNCA-PODE-VAZAR-ISTO") && !s.includes("NEM-ISTO"));
  });
});

describe("baileysSession — 515/restartRequired: reconecta reaproveitando creds (achado ao vivo, Checkpoint C3)", () => {
  const CODIGO_RESTART_REQUIRED = 515;

  test("close com 515 reconecta AUTOMATICAMENTE reaproveitando os creds parciais recém-recebidos, mesmo sem autenticadaAlgumaVez", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const inicializarCreds = mock.fn();
    const chamadasAgendar = [];
    const agendar = (fn, ms) => { chamadasAgendar.push(ms); fn(); };
    const authAdapterComCredsParciais = {
      async carregar() { return true; }, // creds parciais salvas pelo creds.update que acabou de rodar
      inicializarCreds,
      comoAuthState() { return { creds: { registered: false }, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
    };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComCredsParciais, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar,
    });

    await sessao.conectar();
    const chamadasInicializarAntesDoClose = inicializarCreds.mock.calls.length;
    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: CODIGO_RESTART_REQUIRED } } },
    });

    assert.equal(chamadasAgendar.length, 1, "515 precisa reconectar sozinho — é o passo esperado do handshake, não uma falha");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fabricaSocket.criados.length, 2, "reconectou de fato — um segundo socket foi criado");
    assert.equal(
      inicializarCreds.mock.calls.length, chamadasInicializarAntesDoClose,
      "a RECONEXÃO pós-515 não pode descartar os creds de novo — precisa reaproveitar os mesmos, sem QR novo",
    );
  });

  test("depois da reconexão pós-515, autenticadaAlgumaVez continua false (ainda não é sessão estabelecida) até 'open' de verdade ou registered:true", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const authAdapterComCredsParciais = {
      async carregar() { return true; },
      inicializarCreds() {},
      comoAuthState() { return { creds: { registered: false }, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
    };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComCredsParciais, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar: (fn) => fn(),
    });

    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: CODIGO_RESTART_REQUIRED } } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(sessao._autenticadaAlgumaVez(), false);
  });

  test("close com 515 mas sem NENHUM creds salvo ainda (carregar()=false) não tenta reaproveitar nada — comportamento normal de pareamento do zero", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const inicializarCreds = mock.fn();
    const chamadasAgendar = [];
    const agendar = (fn, ms) => { chamadasAgendar.push(ms); fn(); };
    const authAdapterSemNada = {
      async carregar() { return false; },
      inicializarCreds,
      comoAuthState() { return { creds: { registered: false }, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
    };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterSemNada, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar,
    });

    await sessao.conectar();
    assert.equal(inicializarCreds.mock.calls.length, 1);
    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: CODIGO_RESTART_REQUIRED } } },
    });

    assert.equal(chamadasAgendar.length, 1, "515 sempre reconecta, mesmo neste caso raro");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(inicializarCreds.mock.calls.length, 2, "sem creds nenhum salvo, a reconexão gera identidade nova de novo (não tem o que reaproveitar)");
  });
});

describe("baileysSession — lifecycle", () => {
  test("conectar() sem QR/rede real: vai para CONNECTING, depois 'open' vira CONNECTED", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });

    await sessao.conectar();
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTING);

    fabricaSocket.criados[0].user = { id: "5511999990000:1@s.whatsapp.net" };
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });

    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTED);
    assert.equal((await sessao.getStatus()).telefone, "+5511999990000");
  });

  test("obterQrAtual(): null antes de qualquer QR, string após o evento, null de novo após 'open'", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });

    assert.equal(sessao.obterQrAtual(), null);

    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { qr: "2@qr-de-teste-fake==" });
    assert.equal(sessao.obterQrAtual(), "2@qr-de-teste-fake==");

    fabricaSocket.criados[0].user = { id: "5511999990000:1@s.whatsapp.net" };
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    assert.equal(sessao.obterQrAtual(), null, "QR precisa sumir assim que conecta — nunca reaproveitável");
  });

  test("obterQrAtual(): some também quando o socket fecha antes de conectar (expira, não fica preso em memória)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar: () => {},
    });

    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { qr: "2@qr-que-vai-expirar==" });
    assert.equal(sessao.obterQrAtual(), "2@qr-que-vai-expirar==");

    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_CONNECTION_LOST } } },
    });
    assert.equal(sessao.obterQrAtual(), null);
  });

  test("PAREAMENTO INICIAL: QR expira sem nunca ter autenticado -> DISCONNECTED e PARA (sem reconectar sozinho)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const chamadasAgendar = [];
    const agendar = (fn, ms) => { chamadasAgendar.push(ms); fn(); };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar,
    });

    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { qr: "2@qr-do-pareamento-inicial==" });
    assert.equal(sessao._autenticadaAlgumaVez(), false);

    // QR expira (Baileys fecha o socket) — nunca chegou a CONNECTED nesta sessão.
    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_CONNECTION_LOST } } },
    });

    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(chamadasAgendar.length, 0, "pareamento inicial nunca reconecta sozinho");
    assert.equal(fabricaSocket.criados.length, 1, "nenhum novo socket deveria ter sido criado");
  });

  test("PAREAMENTO INICIAL: close antes de qualquer QR/CONNECTED -> também não reconecta sozinho", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const chamadasAgendar = [];
    const agendar = (fn, ms) => { chamadasAgendar.push(ms); fn(); };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar,
    });

    await sessao.conectar();
    // close direto, sem QR nenhum ter sido emitido ainda.
    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_CONNECTION_LOST } } },
    });

    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(chamadasAgendar.length, 0);
    assert.equal(fabricaSocket.criados.length, 1);
  });

  test("SESSÃO JÁ AUTENTICADA (chegou a CONNECTED): queda transitória agenda reconexão com backoff", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const chamadasAgendar = [];
    const agendar = (fn, ms) => { chamadasAgendar.push(ms); fn(); }; // executa na hora, só registra o atraso pedido
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar,
    });

    await sessao.conectar();
    fabricaSocket.criados[0].user = { id: "5511999990000:1@s.whatsapp.net" };
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    assert.equal(sessao._autenticadaAlgumaVez(), true);

    // AGORA sim uma queda é transitória — a sessão já foi autenticada de verdade.
    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_CONNECTION_LOST } } },
    });

    assert.equal(chamadasAgendar.length, 1);
    assert.ok(chamadasAgendar[0] > 0);
    // `conectar()` é assíncrono (aguarda authAdapter.carregar() e o import
    // dinâmico do Baileys antes de criar o socket) — dar um respiro real
    // para essa cadeia terminar antes de checar quantos sockets existem.
    await new Promise((resolve) => setTimeout(resolve, 20));
    // reconectou de fato — uma segunda instância de socket foi criada.
    assert.equal(fabricaSocket.criados.length, 2);
  });

  test("SESSÃO RESTAURADA (authAdapter.carregar() devolve creds.registered=true): queda transitória também reconecta, mesmo sem 'open' nesta execução", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const chamadasAgendar = [];
    const agendar = (fn, ms) => { chamadasAgendar.push(ms); fn(); };
    const authAdapterComSessaoSalva = {
      async carregar() { return true; },
      inicializarCreds() {},
      comoAuthState() { return { creds: { registered: true }, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
    };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComSessaoSalva, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar,
    });

    await sessao.conectar();
    assert.equal(sessao._autenticadaAlgumaVez(), true, "creds.registered:true carregado do backend já conta como sessão real preexistente");

    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_CONNECTION_LOST } } },
    });
    assert.equal(chamadasAgendar.length, 1, "restaurar uma sessão registrada e cair depois é transitório, não pareamento inicial");
  });

  test("BUG #1 ENCONTRADO AO VIVO NO CHECKPOINT C3 — CORRIGIDO: carregar() devolve true mas creds.registered é false (creds PARCIAIS de um pareamento interrompido, salvas via creds.update antes do QR completar) -> NÃO conta como autenticada, close subsequente NÃO reconecta sozinho", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const chamadasAgendar = [];
    const agendar = (fn, ms) => { chamadasAgendar.push(ms); fn(); };
    const authAdapterComCredsParciais = {
      async carregar() { return true; }, // existe auth_state_encrypted no backend...
      inicializarCreds: mock.fn(),
      comoAuthState() { return { creds: { registered: false }, keys: { get: async () => ({}), set: async () => {} } }; }, // ...mas o pareamento nunca completou
      async aoAtualizarCreds() {},
    };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComCredsParciais, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar,
    });

    await sessao.conectar();
    assert.equal(sessao._autenticadaAlgumaVez(), false, "creds parciais (registered:false) NUNCA contam como autenticação real, mesmo com carregar()=true");

    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_CONNECTION_LOST } } },
    });
    assert.equal(chamadasAgendar.length, 0, "não pode reconectar sozinho — o pareamento nunca completou de verdade, mesmo havendo auth state parcial salvo");
  });

  test("BUG #2 ENCONTRADO AO VIVO NO CHECKPOINT C3 — CORRIGIDO: creds parciais (registered:false) são DESCARTADAS, não reaproveitadas — conectar() gera creds novas via initAuthCreds()", async () => {
    // Reprodução do sintoma real: com o BUG #2, o Gateway tentava RETOMAR
    // creds parciais/inconsistentes e o socket fechava quase instantaneamente
    // sem nunca emitir um QR — o script de visualização ficava esperando
    // para sempre. A correção: creds sem registered:true nunca são passadas
    // ao Baileys — sempre um initAuthCreds() novo, que sim gera QR.
    const fabricaSocket = socketFalsoFabrica();
    const inicializarCreds = mock.fn();
    const authAdapterComCredsParciais = {
      async carregar() { return true; },
      inicializarCreds,
      comoAuthState() { return { creds: { registered: false }, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
    };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComCredsParciais, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });

    await sessao.conectar();

    assert.equal(inicializarCreds.mock.calls.length, 1, "creds parciais precisam ser descartadas — um initAuthCreds() novo tinha que ter sido chamado");
  });

  test("pareamento inicial interrompido também PARA o heartbeat periódico (não fica reportando DISCONNECTED para sempre)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: { ...configFalso(), heartbeatMs: 5 },
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });

    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_CONNECTION_LOST } } },
    });

    const chamadasLogoApos = backendClient.notificarHeartbeat.mock.calls.length;
    // heartbeatMs=5: se o timer não tivesse sido parado, várias batidas caberiam aqui.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const chamadasDepoisDeEsperar = backendClient.notificarHeartbeat.mock.calls.length;

    assert.equal(chamadasDepoisDeEsperar, chamadasLogoApos, "heartbeat periódico deveria ter parado — nenhuma chamada nova após o pareamento inicial ser interrompido");
  });

  test("backoff cresce exponencialmente e respeita o teto configurado (sessão já autenticada)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const chamadasAgendar = [];
    const agendar = (fn, ms) => { chamadasAgendar.push(ms); fn(); };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(),
      config: { ...configFalso(), reconnect: { baseMs: 10, tetoMs: 25 } },
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar,
    });

    await sessao.conectar();
    fabricaSocket.criados[0].user = { id: "5511999990000:1@s.whatsapp.net" };
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" }); // autentica antes de testar backoff
    const fechar = () => fabricaSocket.criados.at(-1).ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_CONNECTION_LOST } } },
    });
    fechar(); // tentativa 1: base*2^0=10
    fechar(); // tentativa 2: base*2^1=20
    fechar(); // tentativa 3: base*2^2=40 -> capado em 25 (teto)

    assert.ok(chamadasAgendar[0] <= 12); // 10 + até 20% de jitter
    assert.ok(chamadasAgendar[2] <= 25 + 0.01); // nunca ultrapassa o teto
  });

  test("LOGGED_OUT é terminal: NUNCA agenda reconexão automática", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const chamadasAgendar = [];
    const agendar = (fn, ms) => { chamadasAgendar.push(ms); fn(); };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar,
    });

    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_LOGGED_OUT } } },
    });

    assert.equal(sessao._status(), STATUS_CONEXAO.LOGGED_OUT);
    assert.equal(chamadasAgendar.length, 0);
    assert.equal(fabricaSocket.criados.length, 1); // nenhum novo socket foi criado
  });

  test("QR recebido não muda o status para CONNECTED e dispara heartbeat com o qr", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });

    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { qr: "QR-STRING-FAKE-DE-TESTE" });

    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTING);
    assert.equal(backendClient.notificarHeartbeat.mock.calls.length, 1);
    assert.equal(backendClient.notificarHeartbeat.mock.calls[0].arguments[0].qr, "QR-STRING-FAKE-DE-TESTE");
  });
});

describe("baileysSession — envio", () => {
  async function sessaoConectada() {
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    return { sessao, socket: fabricaSocket.criados[0] };
  }

  test("enviar() chama sock.sendMessage com o JID correto e devolve providerMessageId", async () => {
    const { sessao, socket } = await sessaoConectada();
    const r = await sessao.enviar({ tipo: "text", telefoneE164: "+5511999990000", conteudo: { text: "oi" } });
    assert.equal(socket.sendMessage.mock.calls.length, 1);
    assert.equal(socket.sendMessage.mock.calls[0].arguments[0], "5511999990000@s.whatsapp.net");
    assert.ok(r.providerMessageId);
    assert.ok(r.enviadoEm);
  });

  test("enviar() sem estar conectado lança erro com preEnvio=true (retryável, nada saiu)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await assert.rejects(
      () => sessao.enviar({ tipo: "text", telefoneE164: "+5511999990000", conteudo: { text: "oi" } }),
      (e) => { assert.equal(e.preEnvio, true); return true; },
    );
  });

  test("markAsRead chama sock.readMessages com o JID correto", async () => {
    const { sessao, socket } = await sessaoConectada();
    await sessao.markAsRead({ providerMessageId: "abc", telefoneE164: "+5511999990000" });
    assert.equal(socket.readMessages.mock.calls.length, 1);
    assert.equal(socket.readMessages.mock.calls[0].arguments[0][0].remoteJid, "5511999990000@s.whatsapp.net");
  });
});

describe("baileysSession — eventos de mensagem", () => {
  test("messages.upsert ignora mensagens fromMe (eco do próprio envio)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar();

    fabricaSocket.criados[0].ev.emit("messages.upsert", {
      messages: [{ key: { fromMe: true, id: "x" } }],
    });
    assert.equal(backendClient.notificarMensagemRecebida.mock.calls.length, 0);
  });

  test("messages.upsert notifica o backend para mensagem recebida de terceiro", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar();

    fabricaSocket.criados[0].ev.emit("messages.upsert", {
      messages: [{ key: { fromMe: false, id: "m1", remoteJid: "5511999990000@s.whatsapp.net" } }],
    });
    assert.equal(backendClient.notificarMensagemRecebida.mock.calls.length, 1);
    assert.equal(backendClient.notificarMensagemRecebida.mock.calls[0].arguments[0].telefoneE164, "+5511999990000");
  });

  test("onMessage registra handler chamado para mensagem de terceiro", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar();

    const handler = mock.fn();
    sessao.onMessage(handler);
    fabricaSocket.criados[0].ev.emit("messages.upsert", {
      messages: [{ key: { fromMe: false, id: "m1", remoteJid: "5511999990000@s.whatsapp.net" } }],
    });
    assert.equal(handler.mock.calls.length, 1);
  });

  test("messages.update alimenta getMessageStatus e notifica o backend", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar();

    fabricaSocket.criados[0].ev.emit("messages.update", [{ key: { id: "m1" }, update: { status: 3 } }]);
    assert.deepEqual(await sessao.getMessageStatus("m1"), { status: 3 });
    assert.equal(backendClient.notificarStatusProvider.mock.calls.length, 1);
  });

  test("getMessageStatus para id desconhecido devolve UNKNOWN", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    assert.deepEqual(await sessao.getMessageStatus("nunca-existiu"), { status: "UNKNOWN" });
  });
});

describe("baileysSession — creds.update persiste via authAdapter", () => {
  test("emitir creds.update chama authAdapter.aoAtualizarCreds", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const authAdapter = authAdapterFalso();
    authAdapter.aoAtualizarCreds = mock.fn(authAdapter.aoAtualizarCreds);
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("creds.update", { fake: "creds" });
    assert.equal(authAdapter.aoAtualizarCreds.mock.calls.length, 1);
  });
});
