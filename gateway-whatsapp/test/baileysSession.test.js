// Testes de lifecycle/reconexão/heartbeat da sessão Baileys — SEM rede,
// SEM QR real, SEM conectar nenhuma conta. `fabricaSocket` é um fake
// determinístico injetado (mesmo mecanismo de dependência que server.js usa
// para injetar o `makeWASocket` real em produção).
import { test, describe, mock } from "node:test";
import { proto } from "baileys";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { criarSessaoBaileys, STATUS_CONEXAO, paraJid, deJid } from "../src/baileysSession.js";
import { criarLeaseManager } from "../src/leaseManager.js";
import { AuthStateLoadError } from "../src/authState.js";
import { AuthPersistenciaError } from "../src/classificacaoFalhas.js";
import { erro, CODIGOS } from "../src/errors.js";

const DISCONNECT_REASON_LOGGED_OUT = 401; // mesmo valor real do Baileys (DisconnectReason.loggedOut)
const DISCONNECT_REASON_CONNECTION_LOST = 408;
// Checkpoint G.0.1 — notificarMensagemRecebida agora passa pela fila de concorrência limitada
// (src/filaConcorrenciaLimitada.js): a chamada real acontece alguns microtasks DEPOIS do messages.upsert (antes
// era síncrona) — e mais ainda quando o lote excede a concorrência (o resto só dispara quando um worker libera).
// `tick()` drena vários microtasks — suficiente para as mocks deste arquivo, que resolvem na hora (sem I/O real).
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function socketFalsoFabrica() {
  const criados = [];
  const opcoesRecebidas = [];
  function fabrica(opcoes) {
    opcoesRecebidas.push(opcoes);
    const ev = new EventEmitter();
    const socket = {
      ev,
      ws: new EventEmitter(),   // Checkpoint F: o CB:message alimenta a origem (LIVE/OFFLINE) por mensagem
      user: null,
      // H.4-B.4 — sendMessage recebe {messageId} (id pré-gerado) e ecoa o id, como o Baileys real; onWhatsApp devolve o JID canônico do número pedido.
      sendMessage: mock.fn(async (_jid, _conteudo, opcoes) => ({ key: { id: opcoes?.messageId ?? `wa-${criados.length}-${Date.now()}` } })),
      onWhatsApp: mock.fn(async (digitos) => [{ jid: `${digitos}@s.whatsapp.net`, exists: true }]),
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

// Checkpoint C3.5-C.2/C.3 — UUID fixo devolvido por padrão por
// obterAuthSessionIdAtual() nos fakes abaixo. A máquina de estados real só
// exige um valor NÃO-NULO para prosseguir com a confirmação (a igualdade
// exata com o que o backend espera é responsabilidade do backend/RPC, testada
// em whatsapp-gateway-*.test.js e nas migrations — aqui só precisamos de um
// valor "presente" para exercitar o dance open->drain->confirmar->CONNECTED).
// Testes que precisam exercitar a AUSÊNCIA de geração (ou uma geração
// diferente) sobrescrevem isto explicitamente.
const AUTH_SESSION_ID_FAKE = "11111111-1111-4111-8111-111111111111";

function authAdapterFalso() {
  return {
    async carregar() { return { status: "absent" }; },
    inicializarCreds() {},
    comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
    async aoAtualizarCreds() {},
    async aguardarPersistenciasPendentes() {},
    obterAuthSessionIdAtual() { return AUTH_SESSION_ID_FAKE; },
  };
}

// Checkpoint C3.5-B.2 — diferente de authAdapterFalso() (cujo comoAuthState()
// devolve um `creds` NOVO e sempre vazio a cada chamada — aoAtualizarCreds()
// é um no-op), este fake MANTÉM e faz MERGE real em `creds`, exatamente como
// authState.js#aoAtualizarCreds faz (Object.assign in-place). Útil para
// qualquer teste que precise emitir creds.update() e depois observar o valor
// mesclado via comoAuthState() (ex.: diagnóstico de `registered` em log —
// Checkpoint C3.5-C.1: NUNCA mais controla se a sessão promove a CONNECTED,
// isso agora é `socketOpen && authConfirmado`, ver
// confirmarGeracaoAposOpen()/obterAuthSessionIdAtual() abaixo).
function authAdapterComRegistroFalso(resultadoCarregar = { status: "absent" }) {
  let creds = null;
  return {
    async carregar() { return resultadoCarregar; },
    inicializarCreds(c) { creds = c; },
    invalidarLocal() { creds = null; },
    comoAuthState() { return { creds, keys: { get: async () => ({}), set: async () => {} } }; },
    async aoAtualizarCreds(delta) {
      if (creds) Object.assign(creds, delta);
      else creds = delta;
    },
    async aguardarPersistenciasPendentes() {},
    obterAuthSessionIdAtual() { return AUTH_SESSION_ID_FAKE; },
  };
}

function backendClientFalso() {
  return {
    notificarHeartbeat: mock.fn(async () => {}),
    notificarMensagemRecebida: mock.fn(async () => {}),
    notificarStatusProvider: mock.fn(async () => {}),
    // Checkpoint C3.5-B — defaults inofensivos; testes que precisam de um
    // comportamento específico (falha, resposta customizada) sobrescrevem.
    definirEstadoDesejado: mock.fn(async () => ({ ok: true })),
    obterEstadoSessao: mock.fn(async () => ({ status: "DISCONNECTED", desiredConnectionState: "DISCONNECTED" })),
    // Checkpoint C3.5-B.2 — reset explícito do operador; default inofensivo
    // (sucesso), sobrescrito pelos testes de falha parcial.
    resetarAuthState: mock.fn(async () => ({ ok: true })),
    // Checkpoint C3.5-C.2/C.3 — confirmação durável; default inofensivo
    // (sucesso), sobrescrito pelos testes de LEASE_STALE/AUTH_SESSION_STALE/
    // capacidade ausente/falha genérica.
    confirmarAuthState: mock.fn(async () => ({})),
  };
}

// Checkpoint C3.5-B — fake mínimo de leaseManager com contexto mutável, para
// testar conectar()/desconectar()/restaurarSessaoSePossivel() isolados da
// máquina de estados real de leaseManager.js (essa já tem sua própria
// bateria em test/leaseManager.test.js).
function leaseManagerFalso({ leader = true, leaseEpoch = 1, gatewayProcessId = "proc-fake" } = {}) {
  let atual = leader ? { gatewayProcessId, leaseEpoch } : null;
  return {
    souLeader: () => atual != null,
    contexto: () => atual,
    notificarPerdaExterna: mock.fn(async () => { atual = null; }),
    _definirContexto(c) { atual = c; }, // só para o teste simular perda/mudança de epoch
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
      async carregar() { return { status: "absent" }; },
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
    // 1ª chamada (conectar() inicial): nada pareado ainda -> absent -> QR.
    // 2ª chamada em diante (reconexão pós-515): as creds PARCIAIS que o
    // próprio creds.update acabou de persistir (registered ainda false).
    let chamadasCarregar = 0;
    const authAdapterComCredsParciais = {
      async carregar() {
        chamadasCarregar += 1;
        return chamadasCarregar === 1 ? { status: "absent" } : { status: "loaded", registered: false };
      },
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
    let chamadasCarregar = 0;
    const authAdapterComCredsParciais = {
      async carregar() {
        chamadasCarregar += 1;
        return chamadasCarregar === 1 ? { status: "absent" } : { status: "loaded", registered: false };
      },
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

  test("close com 515 mas sem NENHUM creds salvo ainda (carregar()={status:'absent'}) não tenta reaproveitar nada — comportamento normal de pareamento do zero", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const inicializarCreds = mock.fn();
    const chamadasAgendar = [];
    const agendar = (fn, ms) => { chamadasAgendar.push(ms); fn(); };
    const authAdapterSemNada = {
      async carregar() { return { status: "absent" }; },
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

  test("reconexão pós-515 aguarda authAdapter.garantirPersistido() ANTES de chamar carregar() de novo — nunca recarrega com uma gravação (ex.: pair-success) ainda em voo", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const ordem = [];
    let chamadasDrain = 0;
    let liberarSegundoDrain;
    const segundoDrainBloqueado = new Promise((resolve) => { liberarSegundoDrain = resolve; });
    const authAdapterComDrainControlavel = {
      // Checkpoint C3.5-C.8.2 — a sessão passou a usar `garantirPersistido()` (drena a fila E
      // regrava o snapshot mais novo se ainda estiver sujo); a ordem "persistência -> carregar"
      // é exatamente a mesma que este teste sempre garantiu.
      async garantirPersistido() {
        chamadasDrain += 1;
        const numero = chamadasDrain;
        ordem.push(`drain-inicio-${numero}`);
        if (numero === 2) await segundoDrainBloqueado; // só a reconexão pós-515 fica pendente
        ordem.push(`drain-fim-${numero}`);
      },
      async carregar() {
        ordem.push(`carregar-${chamadasDrain}`);
        // 1ª vez: pareamento do zero; 2ª vez em diante: creds parciais já salvos.
        return chamadasDrain > 1 ? { status: "loaded", registered: false } : { status: "absent" };
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
    assert.ok(ordem.includes("drain-inicio-2"), "reconexão pós-515 precisa chamar garantirPersistido()");
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

  // Checkpoint C3.5-C.8.2 — SUBSTITUI o teste antigo "se a persistência pendente FALHOU, a reconexão
  // pós-515 aborta com segurança ... fica DISCONNECTED" (que só afirmava o aborto, sem nunca
  // reconectar): esse aborto ERA o beco sem saída do incidente de 2026-09-19. As garantias de
  // segurança continuam (nunca carregar(), nunca socket novo, sempre DISCONNECTED, log só com a classe
  // sanitizada); o que muda é que uma falha TRANSITÓRIA agora reagenda e se recupera sozinha, e uma
  // PERMANENTE para em vez de repetir.
  function montarSessao515({ garantirPersistido, carregar }) {
    const fabricaSocket = socketFalsoFabrica();
    const agendadas = [];
    const agendar = (fn, ms) => { agendadas.push({ fn, ms }); return agendadas.length; };
    const authAdapter = {
      garantirPersistido,
      carregar,
      inicializarCreds() {},
      comoAuthState() { return { creds: { registered: false }, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
    };
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar,
    });
    return { sessao, fabricaSocket, agendadas };
  }
  const assentar = () => new Promise((resolve) => setTimeout(resolve, 20));
  const fechar515 = (socket) => socket.ev.emit("connection.update", {
    connection: "close", lastDisconnect: { error: { output: { statusCode: CODIGO_RESTART_REQUIRED } } },
  });

  test("falha TRANSITÓRIA da persistência pendente NÃO é mais beco sem saída: a reconexão pós-515 fica DISCONNECTED sem carregar()/socket novo, loga só a classe, REAGENDA com backoff — e quando o backend volta, reconecta sozinha", async (t) => {
    const erroSensivel = new Error("detalhe interno do backend, NUNCA deveria aparecer no log (token/host/etc.)");
    let chamadas = 0;
    let backendVoltou = false;
    const carregar = mock.fn(async () => ({ status: "absent" }));
    const { sessao, fabricaSocket, agendadas } = montarSessao515({
      carregar,
      async garantirPersistido() {
        chamadas += 1;
        if (chamadas >= 2 && !backendVoltou) throw erroSensivel; // 1ª chamada (conexão inicial): nada pendente
      },
    });
    const linhas = [];
    t.mock.method(console, "log", (s) => linhas.push(s));
    t.mock.method(console, "error", (s) => linhas.push(s));

    await sessao.conectar();
    fechar515(fabricaSocket.criados[0]);
    assert.equal(agendadas.length, 1, "o close 515 agenda a reconexão");

    agendadas[0].fn();
    await assentar();

    assert.equal(carregar.mock.calls.length, 1, "carregar() NÃO pode rodar de novo — nunca sobrescreve a memória mais nova");
    assert.equal(fabricaSocket.criados.length, 1, "nenhum socket novo com auth state potencialmente obsoleto");
    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(agendadas.length, 2, "NOVA tentativa agendada — antes abortava e nunca mais tentava");
    assert.equal(sessao._reconexaoPendente(), true);
    assert.ok(agendadas[1].ms > 0, "com backoff");

    for (const s of linhas) assert.ok(!s.includes(erroSensivel.message), "a mensagem do erro (potencialmente sensível) nunca vai para o log");
    const falha = linhas.map((s) => JSON.parse(s)).find((l) => l.evento === "reconexao.persistencia_pendente_falhou");
    assert.ok(falha, "log explícito da falha, para operação/observabilidade");
    assert.equal(falha.erroTipo, "Error", "só o NOME/classe do erro, nunca message/stack");
    assert.equal(falha.classe, "transitoria");
    assert.ok(!linhas.map((s) => JSON.parse(s)).some((l) => l.evento === "reconexao.abortada_persistencia_pendente_falhou"), "o evento do aborto terminal não existe mais");

    backendVoltou = true; // o backend voltou
    agendadas[1].fn();
    await assentar();
    assert.equal(carregar.mock.calls.length, 2, "agora o carregar() roda");
    assert.equal(fabricaSocket.criados.length, 2, "e a sessão reconectou SOZINHA");
  });

  test("falha PERMANENTE da persistência (HTTP 413 estrutural) PARA: DISCONNECTED, nunca carregar()/socket, SEM reagendar (sem loop)", async (t) => {
    const erro413 = erro(CODIGOS.INDISPONIVEL, { status: 413, corpo: {} });
    let chamadas = 0;
    const carregar = mock.fn(async () => ({ status: "absent" }));
    const { sessao, fabricaSocket, agendadas } = montarSessao515({
      carregar,
      async garantirPersistido() { chamadas += 1; if (chamadas >= 2) throw erro413; },
    });
    const linhas = [];
    t.mock.method(console, "log", (s) => linhas.push(s));
    t.mock.method(console, "error", (s) => linhas.push(s));

    await sessao.conectar();
    fechar515(fabricaSocket.criados[0]);
    agendadas[0].fn();
    await assentar();

    assert.equal(carregar.mock.calls.length, 1);
    assert.equal(fabricaSocket.criados.length, 1);
    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(agendadas.length, 1, "erro permanente: NENHUMA nova tentativa agendada");
    assert.equal(sessao._reconexaoPendente(), false);
    const falha = linhas.map((s) => JSON.parse(s)).find((l) => l.evento === "reconexao.persistencia_pendente_falhou");
    assert.equal(falha.classe, "permanente");
    assert.equal(falha.causa, "payload_grande_demais");
    assert.equal(falha.statusHttp, 413);
  });
});

describe("baileysSession — lifecycle", () => {
  test("conectar() sem QR/rede real: vai para CONNECTING; 'open' sozinho ainda NÃO promove SINCRONAMENTE (a confirmação é assíncrona); só depois do dance de confirmação concluir é que vira CONNECTED", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComRegistroFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });

    await sessao.conectar();
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTING);

    fabricaSocket.criados[0].user = { id: "5511999990000:1@s.whatsapp.net" };
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    // Checkpoint C3.5-C.2/C.3 — `connection.update` é um handler SÍNCRONO;
    // `confirmarGeracaoAposOpen()` é disparado mas suspende no primeiro
    // `await` (drenar persistências pendentes) — a checagem IMEDIATAMENTE
    // após o emit (ainda no mesmo tick) precisa continuar vendo CONNECTING,
    // mesmo que a confirmação vá ter sucesso um instante depois.
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTING, "a confirmação durável é assíncrona — não pode promover no mesmo tick síncrono do 'open'");
    assert.equal(sessao._authConfirmado(), false, "authConfirmado ainda não pode ter sido setado — o dance nem chamou o backend ainda");

    // `registered` (Baileys) é só diagnóstico agora — NUNCA decide nada (ver
    // Checkpoint C3.5-C.1). O que promove para CONNECTED é o dance
    // open->drain->confirmarAuthState(RPC)->authConfirmado, disparado pelo
    // próprio 'open' acima — sem precisar de nenhum creds.update adicional.
    await new Promise((resolve) => setImmediate(resolve)); // deixa o dance de confirmação (assíncrono) concluir

    assert.equal(sessao._authConfirmado(), true);
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
      authAdapter: authAdapterComRegistroFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar,
    });

    await sessao.conectar();
    fabricaSocket.criados[0].user = { id: "5511999990000:1@s.whatsapp.net" };
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    fabricaSocket.criados[0].ev.emit("creds.update", { registered: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTED);
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

  test("SESSÃO RESTAURADA (authAdapter.carregar() devolve authConfirmado=true): queda transitória também reconecta, mesmo sem 'open' nesta execução", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const chamadasAgendar = [];
    const agendar = (fn, ms) => { chamadasAgendar.push(ms); fn(); };
    const authAdapterComSessaoSalva = {
      // Checkpoint C3.5-C.1/C.2/C.3 — `registered` nunca decide mais nada;
      // quem decide se esta geração já é uma sessão real preexistente é o
      // marcador DURÁVEL `authConfirmado` (backend).
      async carregar() { return { status: "loaded", authConfirmado: true, authSessionId: AUTH_SESSION_ID_FAKE }; },
      inicializarCreds() {},
      comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
      async aguardarPersistenciasPendentes() {},
      obterAuthSessionIdAtual() { return AUTH_SESSION_ID_FAKE; },
    };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComSessaoSalva, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar,
    });

    await sessao.conectar();
    assert.equal(sessao._autenticadaAlgumaVez(), true, "authConfirmado:true carregado do backend já conta como sessão real preexistente");

    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_CONNECTION_LOST } } },
    });
    assert.equal(chamadasAgendar.length, 1, "restaurar uma sessão registrada e cair depois é transitório, não pareamento inicial");
  });

  test("BUG #1 (histórico, C3) + FAIL-CLOSED (histórico, C3.5-B.1) — SUPERSEDIDOS no Checkpoint C3.5-C.1/C.3: auth presente com registered=false é o caso NORMAL do fluxo QR, não uma anomalia — sempre abre socket, nunca fail-closed", async () => {
    // Comportamento ORIGINAL (C3): descartava as creds parciais e seguia
    // para um QR novo. Comportamento INTERMEDIÁRIO (C3.5-B.1, pós-auditoria
    // de um QR indevido ao vivo em produção): passou a ser FAIL-CLOSED —
    // premissa de que `registered!==true` com auth presente era sempre uma
    // anomalia. Comportamento ATUAL (C3.5-C.1, investigação read-only contra
    // o Baileys 6.7.24 REALMENTE instalado — ver
    // test/baileys-contrato-real.test.js): `creds.registered` NUNCA vira
    // `true` no fluxo de QR real (só no pairing code numérico) — logo
    // "auth presente + registered=false" é o estado NORMAL de QUALQUER
    // sessão QR real, inclusive uma totalmente autenticada e funcional. O
    // fail-closed baseado nessa premissa travava TODA sessão QR real para
    // sempre (achado ao vivo em produção: sessão autenticada presa em
    // CONNECTING). `conectar()` agora SEMPRE tenta retomar um AUTH_PRESENT,
    // e quem decide se a promoção a CONNECTED é imediata (`authConfirmado`
    // já true) ou exige confirmação nova é o marcador DURÁVEL do backend —
    // nunca `registered`. Ver describe "conectar() manual — contrato
    // explícito de auth state" abaixo para a bateria completa.
    const fabricaSocket = socketFalsoFabrica();
    const authAdapterComCredsParciais = {
      async carregar() { return { status: "loaded", authConfirmado: false, authSessionId: AUTH_SESSION_ID_FAKE }; }, // existe auth_state_encrypted no backend, geração nunca confirmada — normal em QR
      inicializarCreds: mock.fn(),
      comoAuthState() { return { creds: { registered: false }, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
      async aguardarPersistenciasPendentes() {},
      obterAuthSessionIdAtual() { return AUTH_SESSION_ID_FAKE; },
    };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComCredsParciais, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar: () => {},
    });

    await sessao.conectar();

    assert.equal(sessao._autenticadaAlgumaVez(), false, "authConfirmado:false carregado do backend NÃO conta (ainda) como sessão confirmada");
    assert.equal(fabricaSocket.criados.length, 1, "AUTH_PRESENT sempre abre socket agora, mesmo com registered:false/authConfirmado:false — nunca mais fail-closed por causa disso");
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTING);
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
      authAdapter: authAdapterComRegistroFalso(), backendClient: backendClientFalso(),
      config: { ...configFalso(), reconnect: { baseMs: 10, tetoMs: 25 } },
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar,
    });

    await sessao.conectar();
    fabricaSocket.criados[0].user = { id: "5511999990000:1@s.whatsapp.net" };
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    fabricaSocket.criados[0].ev.emit("creds.update", { registered: true }); // autentica antes de testar backoff
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sessao._autenticadaAlgumaVez(), true);
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
      authAdapter: authAdapterComRegistroFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    fabricaSocket.criados[0].ev.emit("creds.update", { registered: true });
    await new Promise((resolve) => setImmediate(resolve));
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
    await tick();
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

  describe("Checkpoint F — contrato do evento inbound (origem por mensagem, telefone só com PN real, falha de decrypt explícita)", () => {
    async function sessaoComSocket() {
      const fabricaSocket = socketFalsoFabrica(); const backendClient = backendClientFalso();
      const sessao = criarSessaoBaileys({ authAdapter: authAdapterFalso(), backendClient, config: configFalso(), fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT });
      await sessao.conectar();
      const sock = fabricaSocket.criados[0]; const handler = mock.fn(); sessao.onMessage(handler);
      const enviados = () => backendClient.notificarMensagemRecebida.mock.calls.map((c) => c.arguments[0]);
      return { sock, handler, enviados, sessao };
    }
    const PN = "5511999990000@s.whatsapp.net";

    test("o evento enviado ao backend tem EXATAMENTE as chaves do contrato; handlers recebem o mesmo evento + conteudo", async () => {
      const { sock, handler, enviados } = await sessaoComSocket();
      sock.ws.emit("CB:message", { attrs: { id: "m1", from: PN } });
      sock.ev.emit("messages.upsert", { messages: [{ key: { fromMe: false, id: "m1", remoteJid: PN }, message: { conversation: "oi" } }], type: "notify" });
      await tick();
      assert.equal(enviados().length, 1);
      const e = enviados()[0];
      assert.deepEqual(Object.keys(e).sort(), ["contratoInbound", "falhaDecrypt", "fromMe", "motivoFalhaDecrypt", "origemJidTipo", "origemTipo", "providerMessageId", "recebidoEm", "stubSistema", "telefoneE164", "telefoneOrigem"]);
      assert.deepEqual([e.contratoInbound, e.providerMessageId, e.origemTipo, e.origemJidTipo, e.fromMe, e.telefoneE164, e.telefoneOrigem, e.falhaDecrypt, e.motivoFalhaDecrypt, e.stubSistema], [1, "m1", "LIVE", "direct_pn", false, "+5511999990000", "JID_PN", false, null, false]);
      assert.ok(!JSON.stringify(e).includes("oi"), "conteúdo nunca vai ao backend");
      assert.equal(handler.mock.calls.length, 1);
      const h = handler.mock.calls[0].arguments[0];
      assert.deepEqual({ ...h, conteudo: undefined }, { ...e, conteudo: undefined }); assert.deepEqual(h.conteudo, { conversation: "oi" });
    });

    test("origem POR MENSAGEM num mesmo messages.upsert (type 'notify' para todas): vivo=LIVE, offline '0'/'1'=OFFLINE_NORMAL, sem stanza=OFFLINE_NORMAL", async () => {
      const { sock, enviados } = await sessaoComSocket();
      sock.ws.emit("CB:message", { attrs: { id: "viva", from: PN } });
      sock.ws.emit("CB:message", { attrs: { id: "off0", from: PN, offline: "0" } });
      sock.ws.emit("CB:message", { attrs: { id: "off1", from: PN, offline: "1" } });
      const m = (id) => ({ key: { fromMe: false, id, remoteJid: PN }, message: {} });
      sock.ev.emit("messages.upsert", { messages: [m("off0"), m("viva"), m("off1"), m("sem-stanza")], type: "notify" });
      await tick();
      assert.deepEqual(enviados().map((e) => [e.providerMessageId, e.origemTipo]), [["off0", "OFFLINE_NORMAL"], ["viva", "LIVE"], ["off1", "OFFLINE_NORMAL"], ["sem-stanza", "OFFLINE_NORMAL"]]);
    });

    test("LID de 15 dígitos NUNCA vira telefone; com senderPn válido o telefone vem SÓ dele; grupo, status, newsletter e broadcast ⇒ null", async () => {
      const { sock, enviados } = await sessaoComSocket();
      const m = (id, remoteJid, extra = {}) => ({ key: { fromMe: false, id, remoteJid, ...extra }, message: {} });
      sock.ev.emit("messages.upsert", { messages: [
        m("a", "100000000000001@lid"), m("b", "100000000000001@lid", { senderPn: "5511999990001@s.whatsapp.net" }), m("c", "120363000000000001@g.us", { participant: "100000000000001@lid" }),
        m("d", "status@broadcast"), m("e", "120363000000000002@newsletter"), m("f", "1726876800@broadcast"),
      ] });
      await tick();
      const por = Object.fromEntries(enviados().map((e) => [e.providerMessageId, e]));
      assert.deepEqual([por.a.origemJidTipo, por.a.telefoneE164, por.a.telefoneOrigem], ["direct_lid_other", null, null]);
      assert.deepEqual([por.b.telefoneE164, por.b.telefoneOrigem], ["+5511999990001", "SENDER_PN"]);
      assert.deepEqual(["c", "d", "e", "f"].map((k) => [por[k].origemJidTipo, por[k].telefoneE164]), [["group", null], ["status", null], ["newsletter", null], ["broadcast", null]]);
    });

    test("LID PRÓPRIO e PN próprio (identidade autenticada) nunca viram telefone de cliente", async () => {
      const { sock, enviados } = await sessaoComSocket();
      sock.user = { id: "5511999990009:7@s.whatsapp.net", lid: "100000000000009:7@lid" };
      const m = (id, remoteJid) => ({ key: { fromMe: false, id, remoteJid }, message: {} });
      sock.ev.emit("messages.upsert", { messages: [m("a", "100000000000009@lid"), m("b", "5511999990009@s.whatsapp.net")] });
      await tick();
      assert.deepEqual(enviados().map((e) => [e.origemJidTipo, e.telefoneE164]), [["direct_lid_self", null], ["direct_pn", null]]);
    });

    test("stub de falha de decrypt ⇒ falhaDecrypt=true + motivo fechado (nunca o texto do erro); outro stub ⇒ stubSistema", async () => {
      const { sock, enviados } = await sessaoComSocket();
      sock.ev.emit("messages.upsert", { messages: [
        { key: { fromMe: false, id: "f1", remoteJid: PN }, messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT, messageStubParameters: ["Bad MAC Error: Bad MAC SEGREDO-XYZ"] },
        { key: { fromMe: false, id: "s1", remoteJid: "120363000000000001@g.us" }, messageStubType: proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD },
      ] });
      await tick();
      const [f, s] = enviados();
      assert.deepEqual([f.falhaDecrypt, f.motivoFalhaDecrypt, f.stubSistema], [true, "bad_mac", false]);
      assert.ok(!JSON.stringify(f).includes("SEGREDO-XYZ"));
      assert.deepEqual([s.falhaDecrypt, s.motivoFalhaDecrypt, s.stubSistema], [false, null, true]);
    });

    test("sem id ⇒ não encaminha (nem ao backend nem aos handlers); fromMe continua sem ser encaminhado; um item ruim não derruba os outros", async () => {
      const { sock, handler, enviados } = await sessaoComSocket();
      sock.ev.emit("messages.upsert", { messages: [
        { key: { fromMe: false, remoteJid: PN } }, { key: { fromMe: false, id: "", remoteJid: PN } }, { key: { fromMe: true, id: "meu", remoteJid: PN } },
        { key: { fromMe: false, id: "ok", remoteJid: PN } },
      ] });
      await tick();
      assert.deepEqual(enviados().map((e) => e.providerMessageId), ["ok"]); assert.equal(handler.mock.calls.length, 1);
    });

    test("a origem é limpa a cada socket novo (o buffer do socket anterior morreu com ele) e não vaza entre sockets", async () => {
      const fabricaSocket = socketFalsoFabrica(); const backendClient = backendClientFalso();
      const sessao = criarSessaoBaileys({ authAdapter: authAdapterFalso(), backendClient, config: configFalso(), fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT });
      await sessao.conectar();
      fabricaSocket.criados[0].ws.emit("CB:message", { attrs: { id: "velha", from: PN } });         // LIVE no socket 1, nunca consumida
      await sessao.desconectar(); await sessao.conectar();
      fabricaSocket.criados[1].ev.emit("messages.upsert", { messages: [{ key: { fromMe: false, id: "velha", remoteJid: PN }, message: {} }] });
      await tick();
      assert.equal(backendClient.notificarMensagemRecebida.mock.calls.at(-1).arguments[0].origemTipo, "OFFLINE_NORMAL", "sem a stanza deste socket ⇒ fail-safe");
    });
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
    // H.4-B.4 — só mensagens que ESTE processo enviou (rastreadas por enviar()) chegam ao backend: "m1" nunca foi enviada aqui.
    assert.equal(backendClient.notificarStatusProvider.mock.calls.length, 0);
  });

  test("H.4-B.4 — recibo de uma mensagem enviada por enviar() chega ao backend no contrato (sem duplicar entre os observadores)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.notificarStatusProvider = mock.fn(async () => ({ ok: true, resultado: "APLICADO" }));
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComRegistroFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar();
    const socket = fabricaSocket.criados[0];
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("creds.update", { registered: true });
    await new Promise((resolve) => setImmediate(resolve));
    const { providerMessageId } = await sessao.enviar({ tipo: "text", telefoneE164: "+5511999990000", conteudo: { text: "oi" }, correlationId: "wa:alerta:x:v1" });
    socket.ws.emit("CB:receipt", { attrs: { id: providerMessageId, from: "5511999990000@s.whatsapp.net", t: "1700000000" } });   // nó cru (sem type = entrega)
    socket.ev.emit("messages.update", [{ key: { id: providerMessageId, fromMe: true, remoteJid: "5511999990000@s.whatsapp.net" }, update: { status: 3 } }]);   // o MESMO evento pelo ev
    await tick();
    const chamadas = backendClient.notificarStatusProvider.mock.calls.map((c) => c.arguments[0]);
    assert.equal(chamadas.length, 1, "dedupe entre ws e ev");
    assert.equal(chamadas[0].providerMessageId, providerMessageId);
    assert.equal(chamadas[0].status, "DELIVERED");
    assert.equal(chamadas[0].contratoStatus, 1);
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

describe("baileysSession — intenção do operador (Checkpoint C3.5-B, item 3)", () => {
  test("POST /connect (persistirIntencaoConectada:true) grava CONNECTED ANTES de abrir o socket", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const leaseManager = leaseManagerFalso({ leaseEpoch: 7 });
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao.conectar({ persistirIntencaoConectada: true });

    assert.equal(backendClient.definirEstadoDesejado.mock.calls.length, 1);
    const arg = backendClient.definirEstadoDesejado.mock.calls[0].arguments[0];
    assert.equal(arg.desiredConnectionState, "CONNECTED");
    assert.equal(arg.leaseEpoch, 7);
    assert.equal(fabricaSocket.criados.length, 1, "só abre o socket DEPOIS de persistir a intenção");
  });

  test("falha ao persistir CONNECTED aborta conectar() SEM abrir socket nenhum", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.definirEstadoDesejado = mock.fn(async () => { throw new Error("backend fora do ar"); });
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await assert.rejects(() => sessao.conectar({ persistirIntencaoConectada: true }));
    assert.equal(fabricaSocket.criados.length, 0, "nenhum socket 'órfão' de uma intenção não gravada");
  });

  test("conectar() SEM persistirIntencaoConectada (reconexão automática pós-515/restore) nunca toca desired_connection_state", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao.conectar(); // como a reconexão automática chama internamente
    assert.equal(backendClient.definirEstadoDesejado.mock.calls.length, 0);
  });

  test("POST /disconnect (persistirIntencao:true) grava DISCONNECTED ANTES de fechar o socket", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const leaseManager = leaseManagerFalso({ leaseEpoch: 3 });
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });
    await sessao.conectar();

    await sessao.desconectar({ persistirIntencao: true });

    assert.equal(backendClient.definirEstadoDesejado.mock.calls.length, 1);
    const arg = backendClient.definirEstadoDesejado.mock.calls[0].arguments[0];
    assert.equal(arg.desiredConnectionState, "DISCONNECTED");
    assert.equal(arg.leaseEpoch, 3);
    assert.equal(fabricaSocket.criados[0].end.mock.calls.length, 1);
  });

  test("falha ao persistir DISCONNECTED (não relacionada a lease) é fail-safe: NÃO fecha o socket, desconectar() lança", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.definirEstadoDesejado = mock.fn(async () => { throw new Error("backend fora do ar"); });
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });
    await sessao.conectar();

    await assert.rejects(() => sessao.desconectar({ persistirIntencao: true }));
    assert.equal(fabricaSocket.criados[0].end.mock.calls.length, 0, "socket precisa continuar aberto — intenção não foi gravada");
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTING, "status não pode ter mudado — desconectar() abortou antes de tocar nele");
  });

  test("desconectar() SEM persistirIntencao (shutdown técnico via SIGTERM, server.js#encerrar) NUNCA grava desired_connection_state", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });
    await sessao.conectar();

    await sessao.desconectar(); // exatamente como server.js#encerrar() chama

    assert.equal(backendClient.definirEstadoDesejado.mock.calls.length, 0, "shutdown técnico não é uma decisão do operador — não pode alterar a intenção persistida");
    assert.equal(fabricaSocket.criados[0].end.mock.calls.length, 1, "mesmo sem persistir intenção, o socket precisa fechar normalmente");
  });

  test("LOGGED_OUT grava desired_connection_state=DISCONNECTED (fenced), fire-and-forget", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const leaseManager = leaseManagerFalso({ leaseEpoch: 9 });
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager, agendar: () => {},
    });
    await sessao.conectar();

    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_LOGGED_OUT } } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0)); // deixa o fire-and-forget resolver

    assert.equal(backendClient.definirEstadoDesejado.mock.calls.length, 1);
    const arg = backendClient.definirEstadoDesejado.mock.calls[0].arguments[0];
    assert.equal(arg.desiredConnectionState, "DISCONNECTED");
    assert.equal(arg.leaseEpoch, 9);
  });

  test("LOGGED_OUT sem leaseManager (testes de lifecycle puro) não lança e não tenta gravar nada", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar: () => {},
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_LOGGED_OUT } } },
    });
    assert.equal(sessao._status(), STATUS_CONEXAO.LOGGED_OUT);
  });
});

describe("baileysSession — restore automático (Checkpoint C3.5-B)", () => {
  // RESTORE NORMAL (Checkpoint C3.5-C.2/C.3, seção 13) — geração já
  // confirmada durável antes; connection:"open" sozinho basta.
  function authAdapterRestoreOk() {
    return {
      async carregar() { return { status: "loaded", authConfirmado: true, authSessionId: AUTH_SESSION_ID_FAKE }; },
      inicializarCreds() {},
      comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
      async aguardarPersistenciasPendentes() {},
      obterAuthSessionIdAtual() { return AUTH_SESSION_ID_FAKE; },
    };
  }
  // RECOVERY LEGADO (Checkpoint C3.5-C.2/C.3, seção 14) — auth presente,
  // authSessionId presente, mas NUNCA confirmado durável (sessão real
  // anterior a este checkpoint, ou backfill da migration 086). Abre socket
  // (origem 'restore', nunca gera QR) e depende do dance de confirmação
  // completo depois do 'open'.
  function authAdapterRestoreLegado() {
    return {
      async carregar() { return { status: "loaded", authConfirmado: false, authSessionId: AUTH_SESSION_ID_FAKE }; },
      inicializarCreds() {},
      comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
      async aguardarPersistenciasPendentes() {},
      obterAuthSessionIdAtual() { return AUTH_SESSION_ID_FAKE; },
    };
  }
  // Defesa em profundidade (seção 14) — auth presente mas SEM authSessionId
  // nenhum (nunca deveria acontecer dado o backfill da migration 086, mas o
  // restore precisa fail-safe mesmo assim: nunca restaura às cegas).
  function authAdapterRestoreSemAuthSessionId() {
    return {
      async carregar() { return { status: "loaded", authConfirmado: false, authSessionId: null }; },
      inicializarCreds() {},
      comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
      async aguardarPersistenciasPendentes() {},
      obterAuthSessionIdAtual() { return null; },
    };
  }
  function authAdapterRestoreSemNada() {
    return {
      async carregar() { return { status: "absent" }; },
      inicializarCreds() {},
      comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
      async aguardarPersistenciasPendentes() {},
      obterAuthSessionIdAtual() { return null; },
    };
  }
  function authAdapterRestoreCorrompido() {
    return {
      async carregar() { throw new AuthStateLoadError("decrypt_error"); },
      inicializarCreds() {},
      comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
      async aguardarPersistenciasPendentes() {},
      obterAuthSessionIdAtual() { return null; },
    };
  }

  test("STANDBY (sem contexto de lease) nunca avalia restore — nenhuma leitura de estado/auth, nenhum socket", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const authAdapter = authAdapterRestoreOk();
    authAdapter.carregar = mock.fn(authAdapter.carregar);
    const leaseManager = leaseManagerFalso({ leader: false });
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao._restaurarSessaoSePossivel();

    assert.equal(backendClient.obterEstadoSessao.mock.calls.length, 0);
    assert.equal(authAdapter.carregar.mock.calls.length, 0);
    assert.equal(fabricaSocket.criados.length, 0);
  });

  test("owner + desired=CONNECTED + authConfirmado=true (RESTORE NORMAL) -> restaura, abre socket com origem 'restore'", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.obterEstadoSessao = mock.fn(async () => ({ status: "DISCONNECTED", desiredConnectionState: "CONNECTED" }));
    const leaseManager = leaseManagerFalso({ leaseEpoch: 5 });
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterRestoreOk(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao._restaurarSessaoSePossivel();

    assert.equal(fabricaSocket.criados.length, 1, "precisa ter aberto socket");
    assert.equal(sessao._origemSocket(), "restore");
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTING);
    assert.equal(sessao.obterQrAtual(), null, "restore nunca expõe QR");
    assert.equal(sessao._epochRestoreAvaliado(), 5);

    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTED);
  });

  test("desired=DISCONNECTED -> NOOP: não carrega auth state, não abre socket", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.obterEstadoSessao = mock.fn(async () => ({ status: "DISCONNECTED", desiredConnectionState: "DISCONNECTED" }));
    const authAdapter = authAdapterRestoreOk();
    authAdapter.carregar = mock.fn(authAdapter.carregar);
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao._restaurarSessaoSePossivel();

    assert.equal(authAdapter.carregar.mock.calls.length, 0, "sem desired=CONNECTED, nem chega a olhar o auth state");
    assert.equal(fabricaSocket.criados.length, 0);
    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
  });

  test("status lido é LOGGED_OUT -> NOOP, mesmo com desired=CONNECTED (linha legada nunca restaura sozinha)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.obterEstadoSessao = mock.fn(async () => ({ status: "LOGGED_OUT", desiredConnectionState: "CONNECTED" }));
    const authAdapter = authAdapterRestoreOk();
    authAdapter.carregar = mock.fn(authAdapter.carregar);
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao._restaurarSessaoSePossivel();

    assert.equal(authAdapter.carregar.mock.calls.length, 0);
    assert.equal(fabricaSocket.criados.length, 0);
  });

  test("sem auth state nenhum salvo (carregar()=false) -> NOOP, nunca gera QR", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.obterEstadoSessao = mock.fn(async () => ({ status: "DISCONNECTED", desiredConnectionState: "CONNECTED" }));
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterRestoreSemNada(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao._restaurarSessaoSePossivel();

    assert.equal(fabricaSocket.criados.length, 0);
    assert.equal(sessao.obterQrAtual(), null);
  });

  test("RECOVERY LEGADO (Checkpoint C3.5-C.2/C.3, seção 14) — auth presente com authConfirmado=false mas authSessionId presente: abre socket (origem 'restore'), UMA tentativa por epoch, nunca gera QR; 'open' + confirmação dão CONNECTED", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.obterEstadoSessao = mock.fn(async () => ({ status: "DISCONNECTED", desiredConnectionState: "CONNECTED" }));
    const leaseManager = leaseManagerFalso({ leaseEpoch: 6 });
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterRestoreLegado(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao._restaurarSessaoSePossivel();

    assert.equal(fabricaSocket.criados.length, 1, "sessão real anterior a este checkpoint (ou backfill) precisa poder ser recuperada, não travar em NOOP");
    assert.equal(sessao._origemSocket(), "restore");
    assert.equal(sessao._authConfirmado(), false, "ainda não confirmado — falta o dance completo depois do 'open'");
    assert.equal(sessao._autenticadaAlgumaVez(), false, "recovery legado só marca autenticadaAlgumaVez depois de confirmar de verdade, não antes");
    assert.equal(sessao._epochRestoreAvaliado(), 6, "UMA tentativa por epoch — já marcado mesmo antes do resultado do 'open' ser conhecido");

    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    await new Promise((resolve) => setImmediate(resolve)); // dance de confirmação assíncrono

    assert.equal(backendClient.confirmarAuthState.mock.calls.length, 1);
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTED);
    assert.equal(sessao._autenticadaAlgumaVez(), true);
  });

  test("defesa em profundidade: auth presente mas SEM authSessionId (nunca deveria acontecer dado o backfill da migration 086) -> NOOP fail-safe, nunca restaura às cegas", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.obterEstadoSessao = mock.fn(async () => ({ status: "DISCONNECTED", desiredConnectionState: "CONNECTED" }));
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterRestoreSemAuthSessionId(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao._restaurarSessaoSePossivel();

    assert.equal(fabricaSocket.criados.length, 0);
  });

  test("auth state corrompido/indecifrável (carregar() lança) -> FAIL-SAFE: NOOP, nunca lança, nunca abre socket", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.obterEstadoSessao = mock.fn(async () => ({ status: "DISCONNECTED", desiredConnectionState: "CONNECTED" }));
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterRestoreCorrompido(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await assert.doesNotReject(() => sessao._restaurarSessaoSePossivel());
    assert.equal(fabricaSocket.criados.length, 0);
  });

  test("já CONNECTED/CONNECTING (socket manual em andamento) -> restore é NOOP, nunca abre um segundo socket", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterRestoreOk(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });
    await sessao.conectar(); // manual — já em CONNECTING

    await sessao._restaurarSessaoSePossivel();

    assert.equal(backendClient.obterEstadoSessao.mock.calls.length, 0, "nem chega a consultar — já há socket em andamento");
    assert.equal(fabricaSocket.criados.length, 1, "nenhum segundo socket");
  });

  test("restore uma vez por epoch: uma 2ª chamada NOOP não reconsulta o backend", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.obterEstadoSessao = mock.fn(async () => ({ status: "DISCONNECTED", desiredConnectionState: "DISCONNECTED" }));
    const leaseManager = leaseManagerFalso({ leaseEpoch: 2 });
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterRestoreOk(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao._restaurarSessaoSePossivel();
    await sessao._restaurarSessaoSePossivel();

    assert.equal(backendClient.obterEstadoSessao.mock.calls.length, 1, "epoch 2 já foi avaliado — a 2ª chamada precisa ser NOOP puro");
  });

  test("QR durante restore é ANOMALIA: aborta, fecha o socket, nunca expõe/loga o QR, nunca reconecta sozinho por aqui", async (t) => {
    const linhas = [];
    t.mock.method(console, "log", (s) => linhas.push(s));
    t.mock.method(console, "error", (s) => linhas.push(s));
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.obterEstadoSessao = mock.fn(async () => ({ status: "DISCONNECTED", desiredConnectionState: "CONNECTED" }));
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterRestoreOk(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager, agendar: () => {},
    });

    await sessao._restaurarSessaoSePossivel();
    assert.equal(sessao._origemSocket(), "restore");

    fabricaSocket.criados[0].ev.emit("connection.update", { qr: "QR-ANOMALO-NUNCA-DEVERIA-EXISTIR" });

    assert.equal(sessao.obterQrAtual(), null, "QR de uma anomalia de restore nunca pode ficar exposto");
    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(sessao._origemSocket(), null);
    assert.equal(fabricaSocket.criados[0].end.mock.calls.length, 1, "o socket anômalo precisa ser fechado");
    for (const s of linhas) assert.ok(!s.includes("QR-ANOMALO-NUNCA-DEVERIA-EXISTIR"));
  });

  test("falha TRANSITÓRIA ao consultar /estado-conexao: retry com backoff, sucesso na 2ª tentativa restaura normalmente", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    let chamadas = 0;
    backendClient.obterEstadoSessao = mock.fn(async () => {
      chamadas += 1;
      if (chamadas === 1) throw new Error("timeout ao chamar o backend");
      return { status: "DISCONNECTED", desiredConnectionState: "CONNECTED" };
    });
    const chamadasAgendar = [];
    const agendar = (fn, ms) => { chamadasAgendar.push(ms); fn(); };
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterRestoreOk(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager, agendar,
    });

    await sessao._restaurarSessaoSePossivel();

    assert.equal(chamadasAgendar.length, 1, "1 retry agendado depois da falha transitória");
    assert.equal(backendClient.obterEstadoSessao.mock.calls.length, 2);
    assert.equal(fabricaSocket.criados.length, 1, "a 2ª tentativa restaurou de verdade");
  });

  test("perder a lease durante o retry cancela: não reconsulta, não abre socket, sem lançar", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.obterEstadoSessao = mock.fn(async () => { throw new Error("backend indisponível"); });
    let fnAgendada = null;
    const agendar = (fn) => { fnAgendada = fn; }; // NÃO executa sozinho — o teste dispara manualmente
    const leaseManager = leaseManagerFalso({ leaseEpoch: 4 });
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterRestoreOk(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager, agendar,
    });

    await sessao._restaurarSessaoSePossivel();
    assert.ok(fnAgendada, "esperava um retry agendado");
    const chamadasAntes = backendClient.obterEstadoSessao.mock.calls.length;

    leaseManager._definirContexto(null); // perdemos a lease enquanto o retry esperava

    assert.doesNotThrow(() => fnAgendada());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(backendClient.obterEstadoSessao.mock.calls.length, chamadasAntes, "não pode ter tentado de novo depois de perder a lease");
    assert.equal(fabricaSocket.criados.length, 0);
  });

  test("epoch mudou durante o retry (nova lease própria, epoch novo) cancela o retry do epoch antigo", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.obterEstadoSessao = mock.fn(async () => { throw new Error("backend indisponível"); });
    let fnAgendada = null;
    const agendar = (fn) => { fnAgendada = fn; };
    const leaseManager = leaseManagerFalso({ leaseEpoch: 4 });
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterRestoreOk(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager, agendar,
    });

    await sessao._restaurarSessaoSePossivel();
    const chamadasAntes = backendClient.obterEstadoSessao.mock.calls.length;
    leaseManager._definirContexto({ gatewayProcessId: "proc-fake", leaseEpoch: 5 }); // reacquire com epoch novo

    await fnAgendada();
    assert.equal(backendClient.obterEstadoSessao.mock.calls.length, chamadasAntes, "retry do epoch 4 não pode agir em nome do epoch 5");
    assert.equal(fabricaSocket.criados.length, 0);
  });
});

describe("baileysSession — LOGGED_OUT é terminal (reforço pós-auditoria, Checkpoint C3.5-B)", () => {
  // Erro no MESMO formato do que backendClient.js#chamar() de fato lança —
  // .message é sempre só o código sanitizado (GatewayError), nunca o
  // detalhe interno (status HTTP/corpo). Simulado aqui com um
  // `detalheInterno` propositalmente "sensível" para provar que ele nunca
  // vaza no log, mesmo quando o código só loga `e?.message`.
  function erroDeBackendFalso() {
    const e = new Error("WHATSAPP_GATEWAY_UNAVAILABLE");
    e.codigo = "WHATSAPP_GATEWAY_UNAVAILABLE";
    e.detalheInterno = { host: "NUNCA-PODE-VAZAR-ISTO-NO-LOG", token: "TAMBEM-NUNCA-PODE-VAZAR" };
    return e;
  }

  // Fake de "banco compartilhado" — duas instâncias de backendClient
  // (uma por sessão/processo) lendo/escrevendo o MESMO estado persistido,
  // exatamente como dois processos reais do Gateway falando com o mesmo
  // Supabase. É o que permite provar fim-a-fim que o que o processo A
  // persiste é o que o processo B (novo owner) de fato lê.
  function bancoCompartilhadoFalso({ desiredInicial = "DISCONNECTED", statusInicial = "DISCONNECTED" } = {}) {
    let statusPersistido = statusInicial;
    let desiredPersistido = desiredInicial;
    let falharProximaPersistenciaDesired = false;
    return {
      statusPersistido: () => statusPersistido,
      desiredPersistido: () => desiredPersistido,
      falharProximaPersistenciaDesired() { falharProximaPersistenciaDesired = true; },
      criarClient() {
        return {
          notificarHeartbeat: mock.fn(async (payload) => { statusPersistido = payload.status; }),
          notificarMensagemRecebida: mock.fn(async () => {}),
          notificarStatusProvider: mock.fn(async () => {}),
          definirEstadoDesejado: mock.fn(async (payload) => {
            if (falharProximaPersistenciaDesired) {
              falharProximaPersistenciaDesired = false;
              throw erroDeBackendFalso();
            }
            desiredPersistido = payload.desiredConnectionState;
            return { ok: true };
          }),
          obterEstadoSessao: mock.fn(async () => ({ status: statusPersistido, desiredConnectionState: desiredPersistido })),
          // Checkpoint C3.5-C.2/C.3 — sucesso inofensivo por padrão; nenhum
          // teste deste describe exercita o dance de confirmação em si (isso
          // é coberto no describe "confirmação durável de auth"), só precisa
          // que 'open' consiga promover normalmente.
          confirmarAuthState: mock.fn(async () => ({})),
        };
      },
    };
  }

  test("CENÁRIO EXATO DA AUDITORIA — CONNECTED -> loggedOut -> falha ao persistir desired=DISCONNECTED -> SIGTERM -> novo owner NÃO restaura, sem QR, sem socket, erro sanitizado", async (t) => {
    const linhas = [];
    t.mock.method(console, "log", (s) => linhas.push(s));
    t.mock.method(console, "error", (s) => linhas.push(s));

    const banco = bancoCompartilhadoFalso({ desiredInicial: "CONNECTED", statusInicial: "DISCONNECTED" });

    // --- processo A: leader, conecta, autentica de verdade (1/2) ---
    const fabricaSocketA = socketFalsoFabrica();
    const leaseManagerA = leaseManagerFalso({ leaseEpoch: 11, gatewayProcessId: "proc-A" });
    const sessaoA = criarSessaoBaileys({
      authAdapter: authAdapterComRegistroFalso(), backendClient: banco.criarClient(), config: configFalso(),
      fabricaSocket: fabricaSocketA, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager: leaseManagerA, agendar: () => {},
    });
    await sessaoA.conectar();
    fabricaSocketA.criados[0].ev.emit("connection.update", { connection: "open" });
    fabricaSocketA.criados[0].ev.emit("creds.update", { registered: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sessaoA._status(), STATUS_CONEXAO.CONNECTED);

    // 5 — a PRÓXIMA gravação de desired (a do close LOGGED_OUT logo abaixo) vai falhar
    banco.falharProximaPersistenciaDesired();

    // 3/4 — WhatsApp produz loggedOut
    fabricaSocketA.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_LOGGED_OUT } } },
    });
    assert.equal(sessaoA._status(), STATUS_CONEXAO.LOGGED_OUT);
    await new Promise((resolve) => setTimeout(resolve, 0)); // deixa heartbeat + persistência (que vai falhar) assentarem

    assert.equal(banco.statusPersistido(), STATUS_CONEXAO.LOGGED_OUT, "o heartbeat do close já persistiu LOGGED_OUT, independente da tentativa de desired ter falhado");
    assert.equal(banco.desiredPersistido(), "CONNECTED", "a gravação de desired=DISCONNECTED falhou de propósito — continua CONNECTED no banco");

    // 6 — SIGTERM: exatamente como server.js#encerrar() chama (sem persistirIntencao)
    await sessaoA.desconectar();

    assert.equal(sessaoA._status(), STATUS_CONEXAO.LOGGED_OUT, "SIGTERM NUNCA pode rebaixar LOGGED_OUT para DISCONNECTED");
    assert.equal(banco.statusPersistido(), STATUS_CONEXAO.LOGGED_OUT, "o heartbeat final do SIGTERM precisa ter mandado status=LOGGED_OUT, não DISCONNECTED");
    assert.equal(fabricaSocketA.criados[0].end.mock.calls.length, 1, "o socket precisa ter sido fechado normalmente");

    for (const s of linhas) {
      assert.ok(!s.includes("NUNCA-PODE-VAZAR-ISTO-NO-LOG") && !s.includes("TAMBEM-NUNCA-PODE-VAZAR"), "detalheInterno do erro de backend nunca pode vazar no log — só o código sanitizado (e?.message)");
    }

    // 7 — novo processo B assume a lease (epoch novo) e avalia restore
    const fabricaSocketB = socketFalsoFabrica();
    const authAdapterB = authAdapterFalso();
    authAdapterB.carregar = mock.fn(authAdapterB.carregar);
    const leaseManagerB = leaseManagerFalso({ leaseEpoch: 12, gatewayProcessId: "proc-B" });
    const sessaoB = criarSessaoBaileys({
      authAdapter: authAdapterB, backendClient: banco.criarClient(), config: configFalso(),
      fabricaSocket: fabricaSocketB, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager: leaseManagerB,
    });

    await sessaoB._restaurarSessaoSePossivel();

    assert.equal(fabricaSocketB.criados.length, 0, "novo owner NÃO pode abrir socket — status persistido continua LOGGED_OUT");
    assert.equal(sessaoB.obterQrAtual(), null, "nenhum QR");
    assert.equal(authAdapterB.carregar.mock.calls.length, 0, "auth state nem é lido — a checagem de status barra antes disso (não é apagado, não é tocado)");
  });

  test("A) LOGGED_OUT + desired=CONNECTED -> restore NOOP (já coberto por 'status lido é LOGGED_OUT -> NOOP, mesmo com desired=CONNECTED', acima) — reafirmado aqui de forma isolada", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.obterEstadoSessao = mock.fn(async () => ({ status: "LOGGED_OUT", desiredConnectionState: "CONNECTED" }));
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao._restaurarSessaoSePossivel();
    assert.equal(fabricaSocket.criados.length, 0);
  });

  test("B) LOGGED_OUT + falha ao persistir desired=DISCONNECTED (desired continua CONNECTED no banco) -> restore ainda assim NOOP, porque status sozinho já barra", async () => {
    // Do ponto de vista de restaurarSessaoSePossivel(), B é indistinguível
    // de A: o que chega da rede é sempre {status, desiredConnectionState}
    // já persistidos — o restore nunca sabe (nem precisa saber) SE a
    // gravação de desired chegou a ser tentada ou por que falhou. É
    // exatamente por isso que status=LOGGED_OUT sozinho é suficiente como
    // trava, sem depender de desired ter sido corrigido.
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.obterEstadoSessao = mock.fn(async () => ({ status: "LOGGED_OUT", desiredConnectionState: "CONNECTED" }));
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao._restaurarSessaoSePossivel();
    assert.equal(fabricaSocket.criados.length, 0);
  });

  test("C) LOGGED_OUT -> SIGTERM (desconectar() sem persistirIntencao): status local E o heartbeat final permanecem LOGGED_OUT", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const banco = bancoCompartilhadoFalso({ desiredInicial: "CONNECTED", statusInicial: "DISCONNECTED" });
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: banco.criarClient(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager, agendar: () => {},
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_LOGGED_OUT } } },
    });
    assert.equal(sessao._status(), STATUS_CONEXAO.LOGGED_OUT);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await sessao.desconectar(); // SIGTERM técnico

    assert.equal(sessao._status(), STATUS_CONEXAO.LOGGED_OUT);
    assert.equal(banco.statusPersistido(), STATUS_CONEXAO.LOGGED_OUT);
  });

  test("C-bis) LOGGED_OUT -> perda de lease (_forcarFailSafe): status local também permanece LOGGED_OUT, nunca DISCONNECTED", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager, agendar: () => {},
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_LOGGED_OUT } } },
    });
    assert.equal(sessao._status(), STATUS_CONEXAO.LOGGED_OUT);

    await sessao._forcarFailSafe();

    assert.equal(sessao._status(), STATUS_CONEXAO.LOGGED_OUT, "perda de lease também não pode rebaixar LOGGED_OUT");
  });

  describe("Checkpoint G.3.0 — fecharSocketBestEffort(): socket.end() pode devolver 5 formatos diferentes, nenhum pode interromper o fail-safe", () => {
    async function sessaoComEndCustomizado(devolverDeEnd) {
      const fabricaSocket = socketFalsoFabrica();
      const leaseManager = leaseManagerFalso();
      const sessao = criarSessaoBaileys({
        authAdapter: authAdapterFalso(), backendClient: backendClientFalso(), config: configFalso(),
        fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager, agendar: () => {},
      });
      await sessao.conectar();
      const socketFalso = fabricaSocket.criados[0];
      socketFalso.end = mock.fn(devolverDeEnd);
      return { sessao, socketFalso };
    }

    test("A) end() devolve Promise RESOLVIDA: sem exceção, cleanup completo (status vira DISCONNECTED)", async () => {
      const { sessao } = await sessaoComEndCustomizado(() => Promise.resolve());
      await assert.doesNotReject(() => sessao._forcarFailSafe());
      assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    });

    test("B) end() devolve Promise REJEITADA: sem exceção secundária (já coberto antes, continua coberto), cleanup completo", async () => {
      const { sessao } = await sessaoComEndCustomizado(() => Promise.reject(new Error("falha ao fechar o socket")));
      await assert.doesNotReject(() => sessao._forcarFailSafe());
      assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    });

    test("C) end() devolve undefined (o bug original do G.2.2 — `.catch` sobre undefined): sem TypeError, cleanup completo", async () => {
      const { sessao, socketFalso } = await sessaoComEndCustomizado(() => undefined);
      await assert.doesNotReject(() => sessao._forcarFailSafe());
      assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
      // prova de que `socket` foi mesmo zerado (não só que não lançou): uma 2ª chamada não tenta fechar de novo.
      await assert.doesNotReject(() => sessao._forcarFailSafe());
      assert.equal(socketFalso.end.mock.calls.length, 1, "socket já era null na 2ª chamada — end() não é chamado de novo");
    });

    test("D) end() LANÇA sincronamente: sem exceção propagada, cleanup completo", async () => {
      const { sessao } = await sessaoComEndCustomizado(() => { throw new Error("end() quebrou de forma síncrona"); });
      await assert.doesNotReject(() => sessao._forcarFailSafe());
      assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    });

    test("E) end() devolve um valor que NÃO é Promise (ex.: true): sem TypeError, cleanup completo", async () => {
      const { sessao } = await sessaoComEndCustomizado(() => true);
      await assert.doesNotReject(() => sessao._forcarFailSafe());
      assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    });

    test("LOGGED_OUT continua soberano em qualquer um dos 5 formatos (aqui: caso C, o mais frágil)", async () => {
      const { sessao, socketFalso } = await sessaoComEndCustomizado(() => undefined);
      socketFalso.ev.emit("connection.update", {
        connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_LOGGED_OUT } } },
      });
      assert.equal(sessao._status(), STATUS_CONEXAO.LOGGED_OUT);
      await assert.doesNotReject(() => sessao._forcarFailSafe());
      assert.equal(sessao._status(), STATUS_CONEXAO.LOGGED_OUT, "mesmo com o formato mais frágil de end(), LOGGED_OUT nunca é rebaixado");
    });
  });

  test("D) shutdown técnico de sessão NÃO-LOGGED_OUT: status vai para DISCONNECTED, desired continua intocado, restore futuro PERMITIDO", async () => {
    const banco = bancoCompartilhadoFalso({ desiredInicial: "CONNECTED", statusInicial: "DISCONNECTED" });

    const fabricaSocketA = socketFalsoFabrica();
    const leaseManagerA = leaseManagerFalso({ leaseEpoch: 20, gatewayProcessId: "proc-A" });
    const sessaoA = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: banco.criarClient(), config: configFalso(),
      fabricaSocket: fabricaSocketA, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager: leaseManagerA,
    });
    await sessaoA.conectar();
    fabricaSocketA.criados[0].ev.emit("connection.update", { connection: "open" });

    await sessaoA.desconectar(); // técnico — SEM persistirIntencao

    assert.equal(sessaoA._status(), STATUS_CONEXAO.DISCONNECTED, "sessão nunca foi LOGGED_OUT — shutdown técnico pode (e deve) marcar DISCONNECTED normalmente");
    assert.equal(banco.statusPersistido(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(banco.desiredPersistido(), "CONNECTED", "shutdown técnico NUNCA mexe em desired_connection_state — continua a intenção original do operador");

    // novo owner: desired continua CONNECTED, status DISCONNECTED (não LOGGED_OUT), auth confirmado -> restaura
    const fabricaSocketB = socketFalsoFabrica();
    const authAdapterOk = {
      async carregar() { return { status: "loaded", authConfirmado: true, authSessionId: AUTH_SESSION_ID_FAKE }; },
      inicializarCreds() {},
      comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
      async aguardarPersistenciasPendentes() {},
      obterAuthSessionIdAtual() { return AUTH_SESSION_ID_FAKE; },
    };
    const leaseManagerB = leaseManagerFalso({ leaseEpoch: 21, gatewayProcessId: "proc-B" });
    const sessaoB = criarSessaoBaileys({
      authAdapter: authAdapterOk, backendClient: banco.criarClient(), config: configFalso(),
      fabricaSocket: fabricaSocketB, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager: leaseManagerB,
    });

    await sessaoB._restaurarSessaoSePossivel();
    assert.equal(fabricaSocketB.criados.length, 1, "restore futuro PERMITIDO — shutdown técnico normal nunca é uma trava");
    assert.equal(sessaoB._origemSocket(), "restore");
  });

  test("E) manual disconnect (/disconnect): desired E status vão para DISCONNECTED, restore futuro PROIBIDO", async () => {
    const banco = bancoCompartilhadoFalso({ desiredInicial: "CONNECTED", statusInicial: "DISCONNECTED" });

    const fabricaSocketA = socketFalsoFabrica();
    const leaseManagerA = leaseManagerFalso({ leaseEpoch: 30, gatewayProcessId: "proc-A" });
    const sessaoA = criarSessaoBaileys({
      authAdapter: authAdapterFalso(), backendClient: banco.criarClient(), config: configFalso(),
      fabricaSocket: fabricaSocketA, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager: leaseManagerA,
    });
    await sessaoA.conectar();
    fabricaSocketA.criados[0].ev.emit("connection.update", { connection: "open" });

    await sessaoA.desconectar({ persistirIntencao: true }); // exatamente como a rota /disconnect chama

    assert.equal(banco.desiredPersistido(), "DISCONNECTED");
    assert.equal(banco.statusPersistido(), STATUS_CONEXAO.DISCONNECTED);

    // novo owner: desired=DISCONNECTED -> NOOP, mesmo com auth registrado válido
    const fabricaSocketB = socketFalsoFabrica();
    const authAdapterOk = {
      async carregar() { return { status: "loaded", registered: true }; },
      inicializarCreds() {},
      comoAuthState() { return { creds: { registered: true }, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
    };
    const leaseManagerB = leaseManagerFalso({ leaseEpoch: 31, gatewayProcessId: "proc-B" });
    const sessaoB = criarSessaoBaileys({
      authAdapter: authAdapterOk, backendClient: banco.criarClient(), config: configFalso(),
      fabricaSocket: fabricaSocketB, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager: leaseManagerB,
    });

    await sessaoB._restaurarSessaoSePossivel();
    assert.equal(fabricaSocketB.criados.length, 0, "desconexão manual proíbe restore futuro até um novo /connect explícito");
  });
});

describe("baileysSession — conectar() manual: contrato explícito de auth state (Checkpoint C3.5-B.1)", () => {
  // Achado ao vivo em produção que motivou este checkpoint: `.catch(() =>
  // false)` tratava QUALQUER falha de authAdapter.carregar() (fencing,
  // decrypt, parse, HTTP) como "nunca pareado", gerando um QR por cima de
  // uma sessão real já pareada. Estes testes provam, um a um, que cada
  // categoria de falha agora é FAIL-CLOSED — nunca mais colapsada em
  // "ausente".
  function authAdapterComResultado(resultadoOuErro) {
    const registered = (resultadoOuErro && resultadoOuErro.status === "loaded") ? resultadoOuErro.registered : undefined;
    return {
      async carregar() {
        if (resultadoOuErro instanceof Error) throw resultadoOuErro;
        return resultadoOuErro;
      },
      inicializarCreds: mock.fn(),
      comoAuthState() { return { creds: registered !== undefined ? { registered } : {}, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
      async aguardarPersistenciasPendentes() {},
      obterAuthSessionIdAtual() { return resultadoOuErro?.authSessionId ?? AUTH_SESSION_ID_FAKE; },
    };
  }

  test("A) nenhuma auth persistida -> pairing permitido: initAuthCreds chamado, socket aberto, QR pode ocorrer", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const authAdapter = authAdapterComResultado({ status: "absent" });
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao.conectar({ persistirIntencaoConectada: true });

    assert.equal(authAdapter.inicializarCreds.mock.calls.length, 1, "única situação em que initAuthCreds() é permitido");
    assert.equal(fabricaSocket.criados.length, 1);
    fabricaSocket.criados[0].ev.emit("connection.update", { qr: "2@qr-novo-pareamento==" });
    assert.equal(sessao.obterQrAtual(), "2@qr-novo-pareamento==", "QR precisa ser permitido neste único caminho");
  });

  test("B) auth válida + authConfirmado=true -> restore: initAuthCreds NÃO chamado, sessão marcada como já autenticada (registered do Baileys é só diagnóstico — NUNCA decide isto, Checkpoint C3.5-C.1)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const authAdapter = authAdapterComResultado({ status: "loaded", registered: false, authConfirmado: true });
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao.conectar({ persistirIntencaoConectada: true });

    assert.equal(authAdapter.inicializarCreds.mock.calls.length, 0, "creds existentes nunca podem ser descartadas quando authConfirmado:true");
    assert.equal(fabricaSocket.criados.length, 1);
    assert.equal(sessao._autenticadaAlgumaVez(), true);
    assert.equal(sessao.obterQrAtual(), null);
  });

  test("C) decrypt AES-GCM falha -> FAIL CLOSED: initAuthCreds NÃO, socket NÃO, QR NÃO", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const authAdapter = authAdapterComResultado(new AuthStateLoadError("decrypt_error"));
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao.conectar({ persistirIntencaoConectada: true });

    assert.equal(authAdapter.inicializarCreds.mock.calls.length, 0);
    assert.equal(fabricaSocket.criados.length, 0);
    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(sessao.obterQrAtual(), null);
  });

  test("D) JSON inválido (parse_error) -> FAIL CLOSED, QR NÃO", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const authAdapter = authAdapterComResultado(new AuthStateLoadError("parse_error"));
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao.conectar({ persistirIntencaoConectada: true });

    assert.equal(authAdapter.inicializarCreds.mock.calls.length, 0);
    assert.equal(fabricaSocket.criados.length, 0);
    assert.equal(sessao.obterQrAtual(), null);
  });

  test("E) fencing stale (lease_stale) -> erro explícito, NUNCA confundido com AUTH_ABSENT, QR NÃO, leaseManager avisado", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const authAdapter = authAdapterComResultado(new AuthStateLoadError("lease_stale"));
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao.conectar({ persistirIntencaoConectada: true });

    assert.equal(authAdapter.inicializarCreds.mock.calls.length, 0, "lease_stale NUNCA pode ser tratado como 'sem sessão' (initAuthCreds proibido)");
    assert.equal(fabricaSocket.criados.length, 0);
    assert.equal(sessao.obterQrAtual(), null);
    assert.equal(leaseManager.notificarPerdaExterna.mock.calls.length, 1, "precisa avisar o leaseManager, mesma disciplina de heartbeat/desired-state/restore");
  });

  test("F) auth persistida + registered=false/authConfirmado=false -> NÃO É MAIS FAIL CLOSED (Checkpoint C3.5-C.1/C.3 — este é o estado NORMAL de qualquer sessão QR ainda não confirmada; ver teste histórico 'BUG #1' acima)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const authAdapter = authAdapterComResultado({ status: "loaded", registered: false, authConfirmado: false });
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao.conectar({ persistirIntencaoConectada: true });

    assert.equal(authAdapter.inicializarCreds.mock.calls.length, 0, "auth PRESENTE nunca é descartado silenciosamente");
    assert.equal(fabricaSocket.criados.length, 1, "AUTH_PRESENT sempre abre socket agora — fail-closed baseado em registered foi removido");
    assert.equal(sessao._autenticadaAlgumaVez(), false, "authConfirmado:false ainda não conta como sessão confirmada");
    assert.equal(sessao.obterQrAtual(), null);
  });

  test("G) erro HTTP ao consultar auth-state -> FAIL CLOSED, QR NÃO", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const authAdapter = authAdapterComResultado(new AuthStateLoadError("http_error"));
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao.conectar({ persistirIntencaoConectada: true });

    assert.equal(fabricaSocket.criados.length, 0);
    assert.equal(sessao.obterQrAtual(), null);
  });

  test("H) connect terminal falha antes do socket -> tenta rollback de desired para DISCONNECTED", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const chamadasDesired = [];
    const backendClient = backendClientFalso();
    backendClient.definirEstadoDesejado = mock.fn(async (payload) => { chamadasDesired.push(payload.desiredConnectionState); return { ok: true }; });
    const authAdapter = authAdapterComResultado(new AuthStateLoadError("decrypt_error"));
    const leaseManager = leaseManagerFalso({ leaseEpoch: 9 });
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao.conectar({ persistirIntencaoConectada: true });

    assert.deepEqual(chamadasDesired, ["CONNECTED", "DISCONNECTED"], "persiste CONNECTED antes do socket, depois reverte para DISCONNECTED ao falhar terminalmente");
    assert.equal(fabricaSocket.criados.length, 0);
  });

  test("I) rollback do desired falha -> erro original preservado (fail-closed mantido), QR NÃO", async () => {
    const fabricaSocket = socketFalsoFabrica();
    let chamada = 0;
    const backendClient = backendClientFalso();
    backendClient.definirEstadoDesejado = mock.fn(async () => {
      chamada += 1;
      if (chamada === 1) return { ok: true }; // persiste CONNECTED normalmente
      throw new Error("backend indisponível para o rollback"); // rollback falha
    });
    const authAdapter = authAdapterComResultado(new AuthStateLoadError("parse_error"));
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao.conectar({ persistirIntencaoConectada: true }); // não pode lançar — rollback falho não mascara/propaga

    assert.equal(backendClient.definirEstadoDesejado.mock.calls.length, 2, "tentou persistir CONNECTED e depois tentou o rollback");
    assert.equal(fabricaSocket.criados.length, 0, "fail-closed original preservado — nenhum socket, mesmo com rollback falho");
    assert.equal(sessao.obterQrAtual(), null);
    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
  });

  test("reconexão automática pós-515/restore NUNCA aciona o rollback de desired (persistirIntencaoConectada sempre false nesses caminhos)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.definirEstadoDesejado = mock.fn(async () => ({ ok: true }));
    const authAdapter = authAdapterComResultado(new AuthStateLoadError("decrypt_error"));
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await sessao.conectar(); // sem persistirIntencaoConectada — como a reconexão automática chama

    assert.equal(backendClient.definirEstadoDesejado.mock.calls.length, 0, "nunca escreveu CONNECTED, então nunca tenta reverter nada");
  });
});

describe("baileysSession — reset explícito do operador (Checkpoint C3.5-B.2)", () => {
  test("1) reset sem lease (não sou leader) -> SEM_LEASE, nada tocado (nem desired, nem auth, nem heartbeat)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const leaseManager = leaseManagerFalso({ leader: false });
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComRegistroFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });

    await assert.rejects(sessao.resetarSessao(), (e) => e.codigo === "WHATSAPP_GATEWAY_NOT_LEADER");
    assert.equal(backendClient.definirEstadoDesejado.mock.calls.length, 0);
    assert.equal(backendClient.resetarAuthState.mock.calls.length, 0);
    assert.equal(backendClient.notificarHeartbeat.mock.calls.length, 0);
  });

  test("2) desired=DISCONNECTED falha -> aborta imediatamente: socket não é fechado, auth backend intacto, invalidarLocal NUNCA chamado", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.definirEstadoDesejado = mock.fn(async () => { throw new Error("backend indisponível"); });
    const authAdapter = authAdapterComRegistroFalso();
    authAdapter.invalidarLocal = mock.fn(authAdapter.invalidarLocal);
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });
    await sessao.conectar();
    const totalSocketsAntes = fabricaSocket.criados.length;

    await assert.rejects(sessao.resetarSessao(), (e) => e.codigo === "WHATSAPP_GATEWAY_UNAVAILABLE");

    assert.equal(backendClient.resetarAuthState.mock.calls.length, 0, "auth backend nunca deveria ser tocado");
    assert.equal(authAdapter.invalidarLocal.mock.calls.length, 0);
    assert.equal(fabricaSocket.criados[0].end.mock.calls.length, 0, "socket técnico não pode ter sido fechado — passo 3 falhou antes do passo 4");
    assert.equal(fabricaSocket.criados.length, totalSocketsAntes, "nenhum socket novo");
  });

  test("3) desired funciona, mas o reset do auth no backend falha -> socket técnico já fechado, auth ANTIGO preservado, invalidarLocal NUNCA chamado", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.resetarAuthState = mock.fn(async () => { throw new Error("falha ao limpar auth no backend"); });
    const authAdapter = authAdapterComRegistroFalso();
    authAdapter.invalidarLocal = mock.fn(authAdapter.invalidarLocal);
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });
    await sessao.conectar();
    const socket = fabricaSocket.criados[0];

    await assert.rejects(sessao.resetarSessao(), (e) => e.codigo === "WHATSAPP_GATEWAY_UNAVAILABLE");

    assert.equal(backendClient.definirEstadoDesejado.mock.calls[0].arguments[0].desiredConnectionState, "DISCONNECTED");
    assert.equal(socket.end.mock.calls.length, 1, "passo 4: socket técnico precisa ter sido fechado, já que o passo 3 confirmou");
    assert.equal(backendClient.resetarAuthState.mock.calls.length, 1, "tentou resetar o auth");
    assert.equal(authAdapter.invalidarLocal.mock.calls.length, 0, "NUNCA invalida localmente se o backend não confirmou o reset");
  });

  test("4) reset completo: desired=DISCONNECTED confirmado, auth resetado (NULL/NULL fenced), local invalidado, status=DISCONNECTED, heartbeat final", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const authAdapter = authAdapterComRegistroFalso({ status: "loaded", authConfirmado: true, authSessionId: AUTH_SESSION_ID_FAKE });
    const leaseManager = leaseManagerFalso({ gatewayProcessId: "proc-reset", leaseEpoch: 7 });
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });
    await sessao.conectar();
    const socket = fabricaSocket.criados[0];
    assert.equal(sessao._autenticadaAlgumaVez(), true, "pré-condição: sessão restaurada como já pareada");

    await sessao.resetarSessao();

    const chamadaDesired = backendClient.definirEstadoDesejado.mock.calls[0].arguments[0];
    assert.equal(chamadaDesired.desiredConnectionState, "DISCONNECTED");
    assert.deepEqual(
      { gatewayProcessId: chamadaDesired.gatewayProcessId, leaseEpoch: chamadaDesired.leaseEpoch },
      { gatewayProcessId: "proc-reset", leaseEpoch: 7 },
    );
    assert.equal(socket.end.mock.calls.length, 1);
    assert.deepEqual(backendClient.resetarAuthState.mock.calls[0].arguments[0], { gatewayProcessId: "proc-reset", leaseEpoch: 7 });
    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(sessao._autenticadaAlgumaVez(), false, "marcador de pareamento anterior precisa ter sido limpo");
    assert.ok(backendClient.notificarHeartbeat.mock.calls.length > 0, "heartbeat final precisa ter sido mandado");
  });

  test("5) fencing stale ao persistir desired=DISCONNECTED -> erro sanitizado, leaseManager avisado, nenhum auth tocado", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const erroStale = new Error("stale");
    erroStale.leaseStale = true;
    backendClient.definirEstadoDesejado = mock.fn(async () => { throw erroStale; });
    const authAdapter = authAdapterComRegistroFalso();
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });
    await sessao.conectar();

    await assert.rejects(sessao.resetarSessao(), (e) => e.codigo === "WHATSAPP_GATEWAY_UNAVAILABLE");

    assert.equal(leaseManager.notificarPerdaExterna.mock.calls.length, 1, "leaseManager precisa ser avisado da perda externa");
    assert.equal(backendClient.resetarAuthState.mock.calls.length, 0, "nada de auth pode ter sido tocado");
  });

  test("6) backend confirma o reset do auth, mas invalidarLocal() falha localmente -> fail-safe grave: estado local limpo mesmo assim, NUNCA tenta reconstruir o auth antigo no banco", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const authAdapter = authAdapterComRegistroFalso({ status: "loaded", registered: true });
    authAdapter.invalidarLocal = mock.fn(() => { throw new Error("falha local ao limpar creds"); });
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });
    await sessao.conectar();

    await assert.rejects(sessao.resetarSessao(), (e) => e.codigo === "WHATSAPP_GATEWAY_UNAVAILABLE");

    assert.equal(backendClient.resetarAuthState.mock.calls.length, 1, "o reset do backend já tinha sido confirmado");
    assert.equal(backendClient.definirEstadoDesejado.mock.calls.length, 1, "não tenta desfazer o reset do backend nem regravar CONNECTED");
    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(sessao._autenticadaAlgumaVez(), false, "estado local precisa ser tratado como limpo, mesmo com a falha de invalidarLocal");
  });
});

describe("baileysSession — confirmação durável de auth (Checkpoint C3.5-C.2/C.3)", () => {
  // Fake com drenagem controlável POR NÚMERO de chamada — usado pelos testes
  // que precisam observar o estado exatamente ANTES do drain terminar (o
  // dance de confirmação suspende exatamente aí, no primeiro `await`).
  // `chamadasParaBloquear` identifica quais invocações de
  // aguardarPersistenciasPendentes() devem travar (contadas globalmente,
  // 1-based) — necessário porque conectar() TAMBÉM chama este método (antes
  // de recarregar), então um socket NOVO aberto enquanto o dance de um
  // socket ANTIGO ainda está preso não pode travar também.
  function authAdapterComDrainControlavel({ authSessionId = AUTH_SESSION_ID_FAKE, chamadasParaBloquear = new Set() } = {}) {
    let creds = null;
    let chamadas = 0;
    const liberadores = new Map();
    return {
      async carregar() { return { status: "absent" }; },
      inicializarCreds(c) { creds = c; },
      comoAuthState() { return { creds, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds(delta) { if (creds) Object.assign(creds, delta); else creds = delta; },
      // Checkpoint C3.5-C.8.2 — a sessão chama `garantirPersistido()` (não mais o drain puro).
      async garantirPersistido() {
        chamadas += 1;
        const numero = chamadas;
        if (chamadasParaBloquear.has(numero)) {
          await new Promise((resolve) => { liberadores.set(numero, resolve); });
        }
      },
      obterAuthSessionIdAtual() { return authSessionId; },
      liberarChamada(numero) { liberadores.get(numero)?.(); },
    };
  }

  test("1) fluxo QR real completo: 'registered' PERMANECE false o tempo todo (Checkpoint C3.5-C.1) — open->drain->confirmarAuthState(RPC)->authConfirmado->CONNECTED", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const authAdapter = authAdapterComRegistroFalso(); // AUTH_ABSENT -> pairing novo
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar();

    // Handshake normal — creds parciais chegam, 'registered' nunca aparece
    // (comprovado contra o Baileys 6.7.24 real — ver
    // test/baileys-contrato-real.test.js).
    fabricaSocket.criados[0].ev.emit("creds.update", { account: { fake: "parcial" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(authAdapter.comoAuthState().creds?.registered, false, "registered começa (e continua) false — initAuthCreds() real nunca o altera neste fluxo");

    fabricaSocket.criados[0].user = { id: "5511999990000:1@s.whatsapp.net" };
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTING, "confirmação é assíncrona — não promove no mesmo tick síncrono do 'open'");

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(backendClient.confirmarAuthState.mock.calls.length, 1);
    assert.equal(backendClient.confirmarAuthState.mock.calls[0].arguments[0].authSessionId, AUTH_SESSION_ID_FAKE);
    assert.equal(sessao._authConfirmado(), true);
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTED);
    assert.equal(authAdapter.comoAuthState().creds?.registered, false, "CONNECTED foi alcançado com registered CONTINUANDO false — a prova central do Checkpoint C3.5-C.3");
  });

  test("2) 'open' antes do drain terminar -> ainda NÃO CONNECTED; só depois do drain resolver é que confirma e promove", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const authAdapter = authAdapterComDrainControlavel({ chamadasParaBloquear: new Set([2]) });
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar(); // chamada #1 do drain — resolve na hora
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" }); // chamada #2 — travada
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTING, "drain ainda não liberou — não pode ter confirmado nada");
    assert.equal(backendClient.confirmarAuthState.mock.calls.length, 0, "confirmarAuthState só é chamado DEPOIS do drain");

    authAdapter.liberarChamada(2);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(backendClient.confirmarAuthState.mock.calls.length, 1);
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTED);
  });

  test("3) persistência pendente falha (transitória) -> socket fechado, NUNCA CONNECTED, sem QR automático, confirmarAuthState nem chega a ser chamado (C3.5-C.8.2: e a reconexão é REAGENDADA em vez de terminal)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    let chamadasDrain = 0;
    const authAdapter = {
      async carregar() { return { status: "absent" }; },
      inicializarCreds() {},
      comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
      // Chamada #1 (dentro do próprio conectar(), antes do reload) resolve
      // normalmente; só a #2 (do dance de confirmação, depois do 'open') falha.
      async garantirPersistido() {
        chamadasDrain += 1;
        if (chamadasDrain >= 2) throw new Error("detalhe interno sensível — nunca pode vazar no log");
      },
      obterAuthSessionIdAtual() { return AUTH_SESSION_ID_FAKE; },
    };
    const agendadas = [];
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar: (fn, ms) => { agendadas.push(ms); },
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(fabricaSocket.criados[0].end.mock.calls.length, 1);
    assert.equal(backendClient.confirmarAuthState.mock.calls.length, 0);
    assert.equal(sessao._autenticadaAlgumaVez(), false);
    assert.equal(sessao.obterQrAtual(), null, "nunca gera QR automaticamente");
    assert.equal(agendadas.length, 1, "falha TRANSITÓRIA: fecha o socket mas REAGENDA a reconexão (antes: fail-safe terminal, sem nova tentativa)");
    assert.equal(sessao._reconexaoPendente(), true);
  });

  test("3b) persistência pendente falha de forma PERMANENTE (ex.: payload acima do teto) -> fail-safe TERMINAL: socket fechado, NUNCA CONNECTED, SEM reagendar", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    let chamadasDrain = 0;
    const authAdapter = {
      async carregar() { return { status: "absent" }; },
      inicializarCreds() {},
      comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds() {},
      async garantirPersistido() {
        chamadasDrain += 1;
        if (chamadasDrain >= 2) throw new AuthPersistenciaError("permanente", "payload_grande_demais", { status: 413 });
      },
      obterAuthSessionIdAtual() { return AUTH_SESSION_ID_FAKE; },
    };
    const agendadas = [];
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar: (fn, ms) => { agendadas.push(ms); },
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(fabricaSocket.criados[0].end.mock.calls.length, 1);
    assert.equal(backendClient.confirmarAuthState.mock.calls.length, 0);
    assert.equal(agendadas.length, 0, "erro permanente: NENHUMA reconexão agendada (sem loop)");
    assert.equal(sessao._reconexaoPendente(), false);
  });

  test("4) confirmarAuthState falha com erro genérico -> fail-safe: socket fechado, NUNCA CONNECTED", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.confirmarAuthState = mock.fn(async () => { throw new Error("backend indisponível"); });
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComRegistroFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar: () => {},
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(fabricaSocket.criados[0].end.mock.calls.length, 1);
    assert.equal(sessao._authConfirmado(), false);
  });

  test("5) LEASE_STALE ao confirmar -> nunca CONNECTED, leaseManager avisado, fail-safe", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const erroStale = new Error("stale"); erroStale.leaseStale = true;
    backendClient.confirmarAuthState = mock.fn(async () => { throw erroStale; });
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComRegistroFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager, agendar: () => {},
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(leaseManager.notificarPerdaExterna.mock.calls.length, 1);
    assert.equal(sessao._authConfirmado(), false);
  });

  test("6) AUTH_SESSION_STALE ao confirmar (geração mudou por baixo) -> NUNCA tratado como transitório: fail-safe IMEDIATO, sem retry, nunca CONNECTED", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const erroStale = new Error("geração obsoleta"); erroStale.authSessionStale = true;
    backendClient.confirmarAuthState = mock.fn(async () => { throw erroStale; });
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComRegistroFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar: () => {},
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(backendClient.confirmarAuthState.mock.calls.length, 1, "AUTH_SESSION_STALE nunca é retry — diferente do 404 de capacidade ausente");
    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(sessao._authConfirmado(), false);
  });

  test("7) 'registered'=true (Baileys) SEM 'open' -> nunca CONNECTED — creds.update sozinho não decide mais nada, nem no fluxo QR nem no pairing code numérico (o ÚNICO lugar real onde o Baileys de fato seta registered=true — ver test/baileys-contrato-real.test.js)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComRegistroFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("creds.update", { registered: true });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTING, "registered:true sem 'open' nunca promove");
    assert.equal(sessao._authConfirmado(), false);
    assert.equal(backendClient.confirmarAuthState.mock.calls.length, 0, "creds.update nunca dispara o dance de confirmação — só 'open' dispara");
  });

  test("8) authSessionId ausente no instante do 'open' -> fail-safe imediato, confirmarAuthState nem chega a ser chamado (defesa em profundidade)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const authAdapter = authAdapterComRegistroFalso();
    authAdapter.obterAuthSessionIdAtual = () => null;
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar: () => {},
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(backendClient.confirmarAuthState.mock.calls.length, 0);
    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(fabricaSocket.criados[0].end.mock.calls.length, 1);
  });

  test("9) 404 (capacidade ausente, rolling deploy) -> retry com backoff -> sucesso na 2ª tentativa -> CONNECTED", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    let chamadas = 0;
    backendClient.confirmarAuthState = mock.fn(async () => {
      chamadas += 1;
      if (chamadas === 1) { const e = new Error("404"); e.capacidadeAusente = true; throw e; }
      return {};
    });
    const chamadasAgendar = [];
    const agendar = (fn, ms) => { chamadasAgendar.push(ms); fn(); };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComRegistroFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar,
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(chamadasAgendar.length, 1, "1 retry agendado depois do 404");
    assert.equal(backendClient.confirmarAuthState.mock.calls.length, 2);
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTED);
  });

  test("9b) 404 persistente -> retry LIMITADO, nunca loop infinito, acaba em fail-safe", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    backendClient.confirmarAuthState = mock.fn(async () => { const e = new Error("404"); e.capacidadeAusente = true; throw e; });
    const chamadasAgendar = [];
    const agendar = (fn, ms) => { chamadasAgendar.push(ms); fn(); };
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComRegistroFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar,
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(chamadasAgendar.length > 0 && chamadasAgendar.length < 10, "retry precisa ter um teto — nunca loop infinito");
    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED, "esgotou as tentativas -> fail-safe");
    assert.equal(fabricaSocket.criados[0].end.mock.calls.length, 1);
  });

  test("10) callback de socket antigo (obsoleto) NUNCA confirma a geração de um socket mais novo — reconexão antes do drain terminar", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const authAdapter = authAdapterComDrainControlavel({ chamadasParaBloquear: new Set([2]) });
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, agendar: () => {},
    });
    await sessao.conectar(); // chamada #1 do drain (dentro de conectar()) — resolve na hora
    const socketAntigo = fabricaSocket.criados[0];
    socketAntigo.ev.emit("connection.update", { connection: "open" }); // chamada #2 (dance) — travada

    // O socket antigo cai ANTES do drain resolver — pareamento inicial não
    // reconecta sozinho (autenticadaAlgumaVez ainda false), então um novo
    // /connect explícito é o que abre o segundo socket (chamada #3 do drain,
    // NÃO travada — só a #2 está no conjunto bloqueado).
    socketAntigo.ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: DISCONNECT_REASON_CONNECTION_LOST } } },
    });
    await sessao.conectar();
    assert.equal(fabricaSocket.criados.length, 2, "segundo socket precisa ter sido criado normalmente, sem esperar o dance obsoleto");

    authAdapter.liberarChamada(2); // o dance do socket ANTIGO finalmente resolve
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(backendClient.confirmarAuthState.mock.calls.length, 0, "o callback obsoleto detecta que o socket mudou (comparação de referência) e nunca chega a chamar confirmarAuthState");
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTING, "o socket NOVO continua CONNECTING — o dance antigo não pode tê-lo promovido nem derrubado");
  });

  test("11) reset limpa authConfirmado local (a geração some junto com o authSessionId)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComRegistroFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager,
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sessao._authConfirmado(), true, "pré-condição: geração confirmada antes do reset");

    await sessao.resetarSessao();

    assert.equal(sessao._authConfirmado(), false);
    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
  });

  test("12) idempotência: 'open' repetido não chama confirmarAuthState de novo depois de já confirmado", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const backendClient = backendClientFalso();
    const sessao = criarSessaoBaileys({
      authAdapter: authAdapterComRegistroFalso(), backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTED);

    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(backendClient.confirmarAuthState.mock.calls.length, 1, "authConfirmado já era true — 'open' repetido não deveria disparar o dance de novo");
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTED);
  });

  test("13) nenhuma mensagem é enviada enquanto o dance de confirmação ainda está em voo (enviar() exige CONNECTED)", async () => {
    const fabricaSocket = socketFalsoFabrica();
    const authAdapter = authAdapterComDrainControlavel({ chamadasParaBloquear: new Set([2]) });
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient: backendClientFalso(), config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT,
    });
    await sessao.conectar();
    fabricaSocket.criados[0].ev.emit("connection.update", { connection: "open" }); // preso no drain, ainda CONNECTING

    await assert.rejects(
      () => sessao.enviar({ tipo: "text", telefoneE164: "+5511999990000", conteudo: { text: "oi" } }),
      (e) => { assert.equal(e.preEnvio, true); return true; },
    );
    assert.equal(fabricaSocket.criados[0].sendMessage.mock.calls.length, 0);
  });

  test("14) ANTI-REGRESSÃO ponta-a-ponta: RESET -> AUTH_ABSENT -> QR -> creds parciais (registered nunca aparece) -> 515 -> reload -> open -> drain -> confirmar -> CONNECTED", async () => {
    const fabricaSocket = socketFalsoFabrica();
    let credsPersistidos = { registered: true }; // sessão antiga (legado pré-checkpoint) — nunca deveria sobreviver ao reset
    let authSessionIdPersistido = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const authAdapter = {
      async carregar() {
        if (credsPersistidos === null) return { status: "absent" };
        return { status: "loaded", authConfirmado: false, authSessionId: authSessionIdPersistido };
      },
      inicializarCreds(c) { credsPersistidos = c; },
      invalidarLocal() { credsPersistidos = null; authSessionIdPersistido = null; },
      comoAuthState() { return { creds: credsPersistidos, keys: { get: async () => ({}), set: async () => {} } }; },
      async aoAtualizarCreds(delta) {
        if (credsPersistidos) Object.assign(credsPersistidos, delta);
        else credsPersistidos = delta;
      },
      async aguardarPersistenciasPendentes() {},
      obterAuthSessionIdAtual() { return authSessionIdPersistido; },
    };
    const backendClient = backendClientFalso();
    backendClient.resetarAuthState = mock.fn(async () => { credsPersistidos = null; authSessionIdPersistido = null; return { ok: true }; });
    const leaseManager = leaseManagerFalso();
    const sessao = criarSessaoBaileys({
      authAdapter, backendClient, config: configFalso(),
      fabricaSocket, DisconnectReasonLoggedOut: DISCONNECT_REASON_LOGGED_OUT, leaseManager, agendar: (fn) => fn(),
    });

    // RESET explícito.
    await sessao.resetarSessao();
    assert.equal(sessao._status(), STATUS_CONEXAO.DISCONNECTED);
    assert.equal(credsPersistidos, null, "backend real (simulado) precisa ter sido limpo pelo reset");

    // Novo /connect -> AUTH_ABSENT -> QR permitido.
    await sessao.conectar({ persistirIntencaoConectada: true });
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTING);
    fabricaSocket.criados[0].ev.emit("connection.update", { qr: "2@novo-pareamento-fake==" });
    assert.equal(sessao.obterQrAtual(), "2@novo-pareamento-fake==");

    // Handshake real: creds parciais chegam — 'registered' NUNCA aparece
    // (Checkpoint C3.5-C.1). A 1ª persistência minta a geração nova.
    authSessionIdPersistido = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    fabricaSocket.criados[0].ev.emit("creds.update", { account: { fake: "parcial" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sessao._authConfirmado(), false);
    assert.equal(credsPersistidos?.registered, false, "registered continua false — igual ao boot real via initAuthCreds()");

    // 515/restartRequired antes de qualquer 'open' — achado ao vivo (Checkpoint C3). O novo fluxo funciona mesmo com registered=false o tempo todo.
    fabricaSocket.criados[0].ev.emit("connection.update", {
      connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fabricaSocket.criados.length, 2, "reconectou pós-515");
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTING, "falta o 'open' deste socket novo");

    // reload do socket novo: authConfirmado ainda false (nunca confirmado) -> falta o dance completo, disparado pelo 'open' abaixo.
    fabricaSocket.criados[1].user = { id: "5511999990000:1@s.whatsapp.net" };
    fabricaSocket.criados[1].ev.emit("connection.update", { connection: "open" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(backendClient.confirmarAuthState.mock.calls.length, 1);
    assert.equal(backendClient.confirmarAuthState.mock.calls[0].arguments[0].authSessionId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    assert.equal(sessao._status(), STATUS_CONEXAO.CONNECTED);
    assert.equal(sessao._autenticadaAlgumaVez(), true);
    assert.equal(credsPersistidos?.registered, false, "registered NUNCA precisou virar true em NENHUM momento deste fluxo ponta-a-ponta — a prova final do Checkpoint C3.5-C.3");
  });
});
