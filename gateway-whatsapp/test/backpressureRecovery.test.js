// Checkpoint G.0.1 (Parte W) — backpressure de um flush GRANDE (como o que o OFFLINE_RECOVERY libera com sucesso)
// através da sessão REAL (criarSessaoBaileys -> aoMessagesUpsert -> filaConcorrenciaLimitada -> backendClient).
// Socket FAKE (EventEmitter, sem Baileys real) — o que se prova aqui é a fila/prioridade/dedupe do lado do
// Gateway, não o protocolo do Baileys (isso já é coberto por offlineRecoveryIntegracao.test.js).
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { criarSessaoBaileys } from "../src/baileysSession.js";

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function fabricaFalsa() {
  const criados = [];
  const fabrica = () => {
    const socket = { ev: new EventEmitter(), ws: new EventEmitter(), user: null, sendMessage: mock.fn(async () => ({ key: { id: "x" } })), readMessages: mock.fn(async () => {}), end: mock.fn(async () => {}) };
    criados.push(socket);
    return socket;
  };
  fabrica.criados = criados;
  return fabrica;
}
const authAdapterFalso = () => ({
  async carregar() { return { status: "absent" }; }, inicializarCreds() {}, comoAuthState() { return { creds: {}, keys: { get: async () => ({}), set: async () => {} } }; },
  async aoAtualizarCreds() {}, async aguardarPersistenciasPendentes() {}, obterAuthSessionIdAtual() { return "s"; },
});
/** backend LENTO e instrumentado: cada chamada demora `atrasoMs` e o teste observa quantas ficam em voo ao mesmo tempo. */
function backendLentoInstrumentado(atrasoMs = 15) {
  let emVoo = 0; let picoObservado = 0; const ordemDeChegada = [];
  return {
    cliente: {
      notificarHeartbeat: mock.fn(async () => {}), notificarStatusProvider: mock.fn(async () => {}),
      definirEstadoDesejado: mock.fn(async () => ({ ok: true })), obterEstadoSessao: mock.fn(async () => ({ status: "DISCONNECTED", desiredConnectionState: "DISCONNECTED" })),
      resetarAuthState: mock.fn(async () => ({ ok: true })), confirmarAuthState: mock.fn(async () => ({})),
      async notificarMensagemRecebida(payload) {
        emVoo++; picoObservado = Math.max(picoObservado, emVoo);
        await espera(atrasoMs);
        ordemDeChegada.push(payload.providerMessageId);
        emVoo--;
      },
    },
    picoObservado: () => picoObservado,
    ordemDeChegada,
  };
}
const configFalso = (concorrencia) => ({ reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "teste", gatewayVersion: "0.0.0-test", backendNotifyConcurrency: concorrencia });

describe("Checkpoint G.0.1 Parte W — flush grande (500 OFFLINE + 1 LIVE) através da sessão real", { timeout: 30_000 }, () => {
  test("concorrência nunca passa do limite configurado, mesmo com 500 mensagens no mesmo messages.upsert", async () => {
    const CONCORRENCIA = 4;
    const backend = backendLentoInstrumentado(10);
    const fabricaSocket = fabricaFalsa();
    const sessao = criarSessaoBaileys({ authAdapter: authAdapterFalso(), backendClient: backend.cliente, config: configFalso(CONCORRENCIA), fabricaSocket, DisconnectReasonLoggedOut: 401 });
    await sessao.conectar();
    const socket = fabricaSocket.criados[0];

    const N = 500;
    const mensagens = Array.from({ length: N }, (_, i) => ({ key: { remoteJid: "5511888880001@s.whatsapp.net", id: `OFF${i}`, fromMe: false }, message: { conversation: "x" } }));
    socket.ev.emit("messages.upsert", { messages: mensagens, type: "notify" });

    // espera o flush inteiro drenar (500 tarefas / 4 workers * ~10ms cada ≈ 1,25s + folga)
    await esperar(() => backend.ordemDeChegada.length === N, 15_000);

    assert.ok(backend.picoObservado() <= CONCORRENCIA, `pico observado ${backend.picoObservado()} > limite ${CONCORRENCIA}`);
    assert.equal(sessao.metricasNotificacaoBackend().concluidas, N);
    assert.equal(sessao.metricasNotificacaoBackend().ativos, 0);
    assert.equal(new Set(backend.ordemDeChegada).size, N, "dedupe do lado do Gateway não descartou nada — cada id chegou exatamente uma vez ao backend");
  });

  test("prioridade LIVE: uma mensagem LIVE anexada DEPOIS de um backlog OFFLINE_NORMAL de 300 itens ainda chega ao backend BEM antes da maior parte do backlog", async () => {
    const CONCORRENCIA = 2; // concorrência baixa de propósito: exagera o efeito da fila para tornar o teste determinístico
    const backend = backendLentoInstrumentado(8);
    const fabricaSocket = fabricaFalsa();
    const sessao = criarSessaoBaileys({ authAdapter: authAdapterFalso(), backendClient: backend.cliente, config: configFalso(CONCORRENCIA), fabricaSocket, DisconnectReasonLoggedOut: 401 });
    await sessao.conectar();
    const socket = fabricaSocket.criados[0];

    const N_BACKLOG = 300;
    const backlog = Array.from({ length: N_BACKLOG }, (_, i) => ({ key: { remoteJid: "5511888880001@s.whatsapp.net", id: `NORMAL${i}`, fromMe: false }, message: { conversation: "x" } }));
    // uma stanza LIVE real registrada (o rastreador de origem do Checkpoint F consome isto para origemTipo=LIVE)
    socket.ws.emit("CB:message", { attrs: { id: "LIVE1", from: "5511888880002@s.whatsapp.net" } });
    const live = { key: { remoteJid: "5511888880002@s.whatsapp.net", id: "LIVE1", fromMe: false }, message: { conversation: "oi" } };

    socket.ev.emit("messages.upsert", { messages: [...backlog, live], type: "notify" });

    await esperar(() => backend.ordemDeChegada.includes("LIVE1"), 15_000);
    const posicaoLive = backend.ordemDeChegada.indexOf("LIVE1");
    // com concorrência 2 e a LIVE inserida no fim de um lote de 300, sem prioridade ela chegaria por ÚLTIMO (posição ~300).
    // com prioridade, ela entra pela frente assim que os workers já em voo no instante do enqueue liberam.
    assert.ok(posicaoLive <= CONCORRENCIA + 1, `LIVE chegou na posição ${posicaoLive} do backlog — deveria ter furado a fila (prioridade)`);

    await esperar(() => backend.ordemDeChegada.length === N_BACKLOG + 1, 15_000);
    assert.equal(sessao.metricasNotificacaoBackend().concluidas, N_BACKLOG + 1);
  });

  test("backend lento não impede a sessão de continuar respondendo (aoMessagesUpsert nunca await a fila — dispara e segue)", async () => {
    const backend = backendLentoInstrumentado(500); // bem lento de propósito
    const fabricaSocket = fabricaFalsa();
    const sessao = criarSessaoBaileys({ authAdapter: authAdapterFalso(), backendClient: backend.cliente, config: configFalso(1), fabricaSocket, DisconnectReasonLoggedOut: 401 });
    await sessao.conectar();
    const socket = fabricaSocket.criados[0];
    const t0 = Date.now();
    socket.ev.emit("messages.upsert", { messages: [{ key: { remoteJid: "5511888880001@s.whatsapp.net", id: "X", fromMe: false }, message: {} }], type: "notify" });
    const duracaoSincrona = Date.now() - t0;
    assert.ok(duracaoSincrona < 50, `o handler de messages.upsert não pode bloquear esperando o backend (levou ${duracaoSincrona}ms)`);
  });
});

async function esperar(cond, ms, passo = 20) { const ini = Date.now(); while (Date.now() - ini < ms) { if (cond()) return true; await espera(passo); } return cond(); }
