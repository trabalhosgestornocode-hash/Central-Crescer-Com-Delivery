// Testes de lifecycle/reconexão/heartbeat da sessão Baileys — SEM rede,
// SEM QR real, SEM conectar nenhuma conta. `fabricaSocket` é um fake
// determinístico injetado (mesmo mecanismo de dependência que server.js usa
// para injetar o `makeWASocket` real em produção).
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { criarSessaoBaileys, STATUS_CONEXAO, paraJid, deJid } from "../src/baileysSession.js";
import { criarLeaseManager } from "../src/leaseManager.js";

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

describe("baileysSession — diagnóstico do 2º close (codigoDesconexao null, Checkpoint C3, autorizado)", () => {
  function capturarLogs(t) {
    const linhas = [];
    t.mock.method(console, "log", (s) => linhas.push(s));
    t.mock.method(console, "error", (s) => linhas.push(s));
    return linhas;
  }

  async function fecharComErro(t, erro) {
    const linhas = capturarLogs(t);
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar: () => {},
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "close", lastDisconnect: { error: erro } });
    const linha = linhas.map((s) => JSON.parse(s)).find((l) => l.evento === "conexao.fechada_transitoria");
    return { linha, linhas };
  }

  test("Boom tradicional com output.statusCode: codigoDesconexao normal, SEM os campos de diagnóstico extra (só é para o 2º close)", async (t) => {
    const { linha } = await fecharComErro(t, { output: { statusCode: DISCONNECT_REASON_CONNECTION_LOST } });
    assert.equal(linha.codigoDesconexao, DISCONNECT_REASON_CONNECTION_LOST);
    assert.equal(linha.razaoDesconexao, "connectionLost_ou_timedOut");
    for (const campo of ["erroTipo", "erroCodigoRede", "erroErrno", "erroSyscall", "isBoom", "temOutput", "temData", "erroCampos", "outputCampos", "dataCampos"]) {
      assert.equal(linha[campo], undefined, `${campo} não deveria aparecer quando o close já tem um statusCode conhecido`);
    }
  });

  test("Error simples com code=ECONNRESET (sem output.statusCode): erroCodigoRede/erroTipo classificados, codigoDesconexao null", async (t) => {
    const erro = new Error("connect ECONNRESET");
    erro.code = "ECONNRESET";
    const { linha } = await fecharComErro(t, erro);
    assert.equal(linha.codigoDesconexao, null);
    assert.equal(linha.razaoDesconexao, "desconhecido");
    assert.equal(linha.erroTipo, "Error");
    assert.equal(linha.erroCodigoRede, "ECONNRESET");
    assert.equal(linha.isBoom, false);
    assert.equal(linha.temOutput, false);
    assert.equal(linha.temData, false);
  });

  test("erro com errno/syscall: os dois classificados como primitivos seguros", async (t) => {
    const erro = new Error("read ETIMEDOUT");
    erro.errno = -110;
    erro.syscall = "read";
    const { linha } = await fecharComErro(t, erro);
    assert.equal(linha.erroErrno, -110);
    assert.equal(linha.erroSyscall, "read");
  });

  test("erro não-Boom com propriedades customizadas: erroCampos lista só os NOMES, erroTipo é o name customizado", async (t) => {
    const erro = new Error("mensagem interna qualquer");
    erro.name = "MeuErroCustom";
    erro.campoCustom1 = "abc";
    erro.campoCustom2 = 123;
    const { linha } = await fecharComErro(t, erro);
    assert.equal(linha.erroTipo, "MeuErroCustom");
    assert.equal(linha.isBoom, false);
    assert.ok(linha.erroCampos.includes("campoCustom1"));
    assert.ok(linha.erroCampos.includes("campoCustom2"));
  });

  test("valores sensíveis dentro de data/output/message/stack NUNCA aparecem no log — só os nomes das propriedades", async (t) => {
    const segredo1 = "SEGREDO-CHAVE-PRIVADA-XYZ";
    const segredo2 = "OUTRO-VALOR-SENSIVEL-987";
    const erro = new Error(`mensagem com ${segredo1} dentro`);
    erro.data = { chavePrivada: segredo1, outraColuna: "valor-irrelevante" };
    erro.output = { algumCampo: segredo2, payload: "mais-um-valor" };
    const { linha, linhas } = await fecharComErro(t, erro);

    assert.equal(linha.temData, true);
    assert.equal(linha.temOutput, true);
    assert.deepEqual([...linha.dataCampos].sort(), ["chavePrivada", "outraColuna"]);
    assert.deepEqual([...linha.outputCampos].sort(), ["algumCampo", "payload"]);
    assert.equal(linha.message, undefined, "message nunca deve ser logada");
    assert.equal(linha.stack, undefined, "stack nunca deve ser logada");
    assert.equal(linha.data, undefined, "objeto data inteiro nunca deve ser logado");
    assert.equal(linha.output, undefined, "objeto output inteiro nunca deve ser logado");

    for (const s of linhas) {
      assert.ok(!s.includes(segredo1), "segredo1 (de message/data) não pode vazar em NENHUMA linha de log");
      assert.ok(!s.includes(segredo2), "segredo2 (de output) não pode vazar em NENHUMA linha de log");
      assert.ok(!s.includes("valor-irrelevante") && !s.includes("mais-um-valor"), "valores de propriedades não podem vazar, só os nomes");
    }
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

  test("reconexão pós-515 aguarda authAdapter.aguardarPersistenciasPendentes() ANTES de chamar carregar() de novo — nunca recarrega com uma gravação (ex.: pair-success) ainda em voo", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const ordem = [];
    let chamadasDrain = 0;
    let liberarSegundoDrain;
    const segundoDrainBloqueado = new Promise((resolve) => { liberarSegundoDrain = resolve; });
    const authAdapterComDrainControlavel = {
      async aguardarPersistenciasPendentes() {
        chamadasDrain += 1;
        const numero = chamadasDrain;
        ordem.push(`drain-inicio-${numero}`);
        if (numero === 2) await segundoDrainBloqueado; // só a reconexão pós-515 fica pendente
        ordem.push(`drain-fim-${numero}`);
      },
      async carregar() {
        ordem.push(`carregar-${chamadasDrain}`);
        return chamadasDrain > 1; // 1ª vez: pareamento do zero; 2ª vez em diante: creds parciais já salvos
      },
      inicializarCreds() {},
      comoAuthState() { return { creds: { registered: false }, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
    };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComDrainControlavel, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar: (fn) => fn(),
    });

    await sessao.conectar();
    assert.deepEqual(ordem, ["drain-inicio-1", "drain-fim-1", "carregar-1"], "1ª conexão: drain resolve na hora, carregar roda normalmente");

    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: CODIGO_RESTART_REQUIRED } } },
    });

    // A reconexão pós-515 já deve ter começado a drenar, mas carregar() NÃO
    // pode ter rodado ainda — o drain (2ª chamada) está bloqueado de propósito.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(ordem.includes("drain-inicio-2"), "reconexão pós-515 precisa chamar aguardarPersistenciasPendentes()");
    assert.ok(!ordem.includes("carregar-2"), "carregar() não pode rodar enquanto o drain ainda está pendente");
    assert.equal(fabricaSocket.criados.length, 1, "novo socket ainda não pode ter sido criado — a reconexão está presa no drain");

    liberarSegundoDrain();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(
      ordem, ["drain-inicio-1", "drain-fim-1", "carregar-1", "drain-inicio-2", "drain-fim-2", "carregar-2"],
      "depois que o drain libera, carregar() roda e a ordem drain->carregar é respeitada nas duas conexões",
    );
    assert.equal(fabricaSocket.criados.length, 2, "só depois do drain terminar é que a reconexão de fato cria o novo socket");
  });

  test("se a persistência pendente (ex.: SAVE do pair-success) FALHOU, a reconexão pós-515 aborta com segurança: nunca chama carregar(), nunca cria socket novo, fica DISCONNECTED, loga só a classe do erro", async (t) => {
    const fabricaSocket = socketFalsoFabrica();
    const carregar = mock.fn(async () => true);
    const erroSensivel = new Error("detalhe interno do backend, NUNCA deveria aparecer no log (token/host/etc.)");
    let chamadasDrain = 0;
    const authAdapterComFalhaDePersistencia = {
      async aguardarPersistenciasPendentes() {
        chamadasDrain += 1;
        // 1ª chamada (conexão inicial): nada pendente, resolve normalmente.
        // 2ª chamada (reconexão pós-515): a gravação do pair-success falhou.
        if (chamadasDrain === 2) throw erroSensivel;
      },
      carregar,
      inicializarCreds() {},
      comoAuthState() { return { creds: { registered: false }, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
    };
    const linhas = [];
    t.mock.method(console, "log", (s) => linhas.push(s));
    t.mock.method(console, "error", (s) => linhas.push(s));

    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComFalhaDePersistencia, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar: (fn) => fn(),
    });

    await sessao.conectar();
    assert.equal(carregar.mock.calls.length, 1, "1ª conexão: nada pendente, carregar() roda normalmente");
    assert.equal(fabricaSocket.criados.length, 1);

    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: CODIGO_RESTART_REQUIRED } } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(carregar.mock.calls.length, 1, "carregar() NÃO pode ter sido chamado de novo — a reconexão abortou antes disso");
    assert.equal(fabricaSocket.criados.length, 1, "nenhum socket novo pode ter sido criado com auth state potencialmente obsoleto");
    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED, "a sessão precisa terminar de forma segura, DISCONNECTED — nunca CONNECTED/CONNECTING com estado obsoleto");

    for (const s of linhas) {
      assert.ok(!s.includes(erroSensivel.message), "a mensagem do erro (potencialmente sensível) nunca pode ir para o log — só a classe sanitizada");
    }
    const linhaAborto = linhas.map((s) => JSON.parse(s)).find((l) => l.evento === "reconexao.abortada_persistencia_pendente_falhou");
    assert.ok(linhaAborto, "precisa existir um log explícito do abort, para operação/observabilidade");
    assert.equal(linhaAborto.erroTipo, "Error", "só o NOME/classe do erro, nunca message/stack");
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

describe("baileysSession — lease/fencing (Checkpoint C3.5)", () => {
  test("conectar() sem lease (leaseManager.souLeader()===false) recusa com WHATSAPP_GATEWAY_NOT_LEADER/423 — nunca abre socket", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const leaseManagerStandby = { souLeader: () => false, contexto: () => null };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager: leaseManagerStandby,
    });

    try {
      await sessao.conectar();
      assert.fail("conectar() deveria ter recusado sem lease");
    } catch (e) {
      assert.equal(e.codigo, "WHATSAPP_GATEWAY_NOT_LEADER");
      assert.equal(e.status, 423);
    }
    assert.equal(fabricaSocket.criados.length, 0, "nenhum socket pode ter sido criado");
  });

  test("heartbeat nunca é enviado sem lease válida — standby não grava status/DISCONNECTED nenhum (reproduz o caso real de j4jv6)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    // Começa como leader (conectar() precisa passar), mas o contexto vira
    // null a partir daí — simula perder a lease bem no meio da sessão.
    const leaseManagerQuePerdeu = { souLeader: () => true, contexto: () => null };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager: leaseManagerQuePerdeu,
    });

    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });

    assert.equal(backendClient.notificarHeartbeat.mock.calls.length, 0, "sem contexto() válido, heartbeat() precisa pular o envio inteiramente");
  });

  test("STANDBY recebe SIGTERM (nunca teve lease/socket): reproduz EXATAMENTE a ordem de server.js#encerrar() — zero chamadas ao backend, banco não muda (caso real de j4jv6)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const semTimers = { agendarIntervalo: () => null, cancelarIntervalo: () => {} };
    // Nunca ganha o acquire — fica standby a sessão inteira.
    const backendClientLease = { adquirirLease: async () => ({ acquired: false, leaseEpoch: 0, expiresAt: null }) };
    const leaseManager = criarLeaseManager({ backendClient: backendClientLease, gatewayProcessId: "proc-standby", ttlMs: 5000, renewMs: 1000, ...semTimers });
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    assert.equal(await leaseManager.iniciar(), false);
    assert.equal(leaseManager.souLeader(), false);

    // server.js#encerrar(), exatamente na mesma ordem:
    leaseManager.pararTemporizadores();
    if (leaseManager.souLeader()) {
      await sessao.desconectar(); // nunca deveria rodar aqui
    }

    assert.equal(fabricaSocket.criados.length, 0, "standby nunca teve socket — nada para fechar");
    assert.equal(backendClient.notificarHeartbeat.mock.calls.length, 0, "SIGTERM num standby não pode gerar NENHUM heartbeat — nem DISCONNECTED, nem qualquer outro");
  });

  test("rolling deploy real: A conectado (leader) -> B sobe e NÃO consegue conectar (standby) -> A faz shutdown gracioso (para timers -> fecha socket -> libera lease) -> só então B adquire e conecta — nunca coexistem dois sockets", async () => {
    // Fake mínimo do backend, com a MESMA semântica atômica de owner+epoch
    // do repo real (whatsappGateway.repo.js) — o suficiente para provar a
    // exclusão mútua fim a fim, sem depender de rede nem de Supabase.
    function backendClientComLeaseCompartilhada() {
      let owner = null, epoch = 0, expiresAt = null;
      return {
        async adquirirLease({ gatewayProcessId, ttlMs }) {
          const agora = Date.now();
          const expirada = !expiresAt || expiresAt <= agora;
          const elegivel = !owner || owner === gatewayProcessId || expirada;
          if (!elegivel) return { acquired: false, leaseEpoch: epoch, expiresAt };
          owner = gatewayProcessId; epoch += 1; expiresAt = agora + ttlMs;
          return { acquired: true, leaseEpoch: epoch, expiresAt };
        },
        async renovarLease({ gatewayProcessId, leaseEpoch, ttlMs }) {
          if (owner !== gatewayProcessId || epoch !== leaseEpoch) return { renewed: false };
          expiresAt = Date.now() + ttlMs;
          return { renewed: true, leaseEpoch: epoch, expiresAt };
        },
        async liberarLease({ gatewayProcessId, leaseEpoch }) {
          if (owner !== gatewayProcessId || epoch !== leaseEpoch) return { released: false };
          owner = null; expiresAt = null;
          return { released: true };
        },
        notificarHeartbeat: mock.fn(async () => {}),
        notificarMensagemRecebida: mock.fn(async () => {}),
        notificarStatusProvider: mock.fn(async () => {}),
      };
    }
    // Timers no-op: este teste dirige toda transição explicitamente
    // (iniciar()/pararTemporizadores()/liberar()), nunca depende de um
    // timer de verdade disparar sozinho.
    const semTimers = { agendarIntervalo: () => null, cancelarIntervalo: () => {} };

    const backendClient = backendClientComLeaseCompartilhada();
    const fabricaSocketA = socketFalsoFabrica();
    const fabricaSocketB = socketFalsoFabrica();
    const leaseA = criarLeaseManager({ backendClient, gatewayProcessId: "proc-A", ttlMs: 5000, renewMs: 1000, ...semTimers });
    const leaseB = criarLeaseManager({ backendClient, gatewayProcessId: "proc-B", ttlMs: 5000, renewMs: 1000, ...semTimers });
    const sessaoA = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket: fabricaSocketA, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager: leaseA,
    });
    const sessaoB = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket: fabricaSocketB, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager: leaseB,
    });

    // A sobe primeiro, ganha a lease, conecta.
    assert.equal(await leaseA.iniciar(), true);
    await sessaoA.conectar();
    assert.equal(fabricaSocketA.criados.length, 1, "A é leader — precisa ter aberto socket");

    // B sobe depois — a lease de A ainda é válida, B fica STANDBY.
    assert.equal(await leaseB.iniciar(), false);
    try {
      await sessaoB.conectar();
      assert.fail("B não pode conseguir conectar enquanto A ainda detém a lease");
    } catch (e) {
      assert.equal(e.codigo, "WHATSAPP_GATEWAY_NOT_LEADER");
    }
    assert.equal(fabricaSocketB.criados.length, 0, "B não pode ter aberto socket nenhum ainda");

    // A recebe SIGTERM — reproduz EXATAMENTE a ordem de server.js#encerrar()
    // para quem é leader: para timers -> fecha socket -> só DEPOIS libera.
    leaseA.pararTemporizadores();
    assert.equal(leaseA.souLeader(), true, "ainda é leader — só os timers pararam, a lease continua com A até o release explícito");
    await sessaoA.desconectar();
    assert.equal(fabricaSocketA.criados[0].end.mock.calls.length, 1, "o socket de A precisa ter sido fechado ANTES do release");
    assert.equal(fabricaSocketB.criados.length, 0, "no instante em que A fechou o socket, B AINDA não tinha aberto nada — sem overlap");
    await leaseA.liberar();
    assert.equal(leaseA.souLeader(), false);

    // Só agora, com a lease livre, B consegue adquirir e conectar de fato.
    assert.equal(await leaseB.iniciar(), true);
    await sessaoB.conectar();
    assert.equal(fabricaSocketB.criados.length, 1, "só depois do release de A é que B consegue abrir socket");

    // Em nenhum instante os dois tiveram socket simultaneamente ativo: o
    // socket de A já estava fechado (end() chamado, verificado acima) antes
    // de B sequer tentar de novo.
  });
});
