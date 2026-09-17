// Sessão Baileys — a ÚNICA parte deste processo que fala com o WhatsApp.
//
// Eventos assinados (Checkpoint C0, item 14 — só os necessários ao escopo):
//   connection.update — status da conexão / QR / motivo de fechamento
//   creds.update      — persistido IMEDIATAMENTE (item 8) via authAdapter
//   messages.upsert   — mensagem recebida (ignora fromMe)
//   messages.update   — transição de status de entrega (sent/delivered/read)
// Nada de chats.*, contacts.*, groups.*, presence.update — fora de escopo.
//
// `fabricaSocket` é injetado (nunca importado direto aqui): em produção
// server.js passa o `makeWASocket` real do Baileys; em teste, um socket fake
// determinístico. Isso é o que permite testar TODO o lifecycle/reconexão/
// heartbeat sem nunca abrir um socket real nem escanear QR — ver
// test/baileysSession.test.js.
//
// LIFECYCLE (Checkpoint C0, item 15):
//   CONNECTING -> CONNECTED -> DISCONNECTED (transitório, reconecta)
//               -> LOGGED_OUT (terminal — NUNCA reconecta sozinho)

import { log, mascararTelefone } from "./logsafe.js";
import { erro, CODIGOS } from "./errors.js";

export const STATUS_CONEXAO = Object.freeze({
  CONNECTING: "CONNECTING",
  CONNECTED: "CONNECTED",
  DISCONNECTED: "DISCONNECTED",
  LOGGED_OUT: "LOGGED_OUT",
});

/** JID de contato individual — Baileys nunca aceita o E.164 puro. */
export function paraJid(telefoneE164) {
  const digitos = String(telefoneE164).replace(/\D/g, "");
  return `${digitos}@s.whatsapp.net`;
}

export function deJid(jid) {
  return `+${String(jid).split("@")[0].split(":")[0]}`;
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./authState.js').criarAuthStateAdapter>} deps.authAdapter
 * @param {ReturnType<import('./backendClient.js').criarBackendClient>} deps.backendClient
 * @param {object} deps.config
 * @param {(opts: object) => object} deps.fabricaSocket    equivalente a makeWASocket
 * @param {number} deps.DisconnectReasonLoggedOut           DisconnectReason.loggedOut do Baileys
 * @param {(ms: number, fn: () => void) => any} [deps.agendar] injeção de setTimeout, p/ teste sem tempo real
 */
export function criarSessaoBaileys({ authAdapter, backendClient, config, fabricaSocket, DisconnectReasonLoggedOut, agendar = setTimeout }) {
  let socket = null;
  let status = STATUS_CONEXAO.DISCONNECTED;
  let telefone = null;
  let qrAtual = null;
  let tentativasReconexao = 0;
  let heartbeatTimer = null;
  let encerradoManualmente = false;
  const handlersMensagem = [];
  const statusPorMensagemId = new Map(); // providerMessageId -> {status}

  function backoffMs() {
    const base = config.reconnect.baseMs * (2 ** tentativasReconexao);
    // jitter de até 20% — evita "manada" de reconexão sincronizada se vários
    // gateways caíssem juntos (hoje só existe um número, mas o desenho não
    // deveria assumir isso para sempre — Checkpoint C0, item 20).
    const jitter = base * 0.2 * Math.random();
    return Math.min(base + jitter, config.reconnect.tetoMs);
  }

  async function heartbeat(extra = {}) {
    try {
      await backendClient.notificarHeartbeat({
        providerInstanceId: config.providerInstanceId,
        status,
        telefone,
        atualizadoEm: new Date().toISOString(),
        gatewayVersion: config.gatewayVersion,
        ...extra,
      });
    } catch (e) {
      // Heartbeat falho não pode derrubar a sessão — só fica no log.
      log("warn", "heartbeat.falhou", { erro: e?.message });
    }
  }

  function iniciarHeartbeatPeriodico() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => heartbeat(), config.heartbeatMs);
    heartbeatTimer.unref?.();
  }

  function pararHeartbeatPeriodico() {
    clearInterval(heartbeatTimer);
  }

  function aoConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update ?? {};

    if (qr) {
      qrAtual = qr;
      status = STATUS_CONEXAO.CONNECTING;
      log("info", "conexao.qr_gerado", {}); // NUNCA loga o valor do QR
      heartbeat({ qr }).catch(() => {});
      return;
    }

    if (connection === "open") {
      status = STATUS_CONEXAO.CONNECTED;
      qrAtual = null;
      tentativasReconexao = 0;
      telefone = socket?.user?.id ? deJid(socket.user.id) : telefone;
      log("info", "conexao.aberta", { telefone: mascararTelefone(telefone) });
      heartbeat().catch(() => {});
      return;
    }

    if (connection === "close") {
      const codigo = lastDisconnect?.error?.output?.statusCode;
      if (codigo === DisconnectReasonLoggedOut) {
        // TERMINAL — nunca reconecta sozinho. Exige novo QR humano.
        status = STATUS_CONEXAO.LOGGED_OUT;
        pararHeartbeatPeriodico();
        log("warn", "conexao.logged_out", {});
        heartbeat().catch(() => {});
        return;
      }

      status = STATUS_CONEXAO.DISCONNECTED;
      log("warn", "conexao.fechada_transitoria", { codigo: codigo ?? null, tentativa: tentativasReconexao });
      heartbeat().catch(() => {});
      if (!encerradoManualmente) agendarReconexao();
    }
  }

  function agendarReconexao() {
    const espera = backoffMs();
    tentativasReconexao += 1;
    agendar(() => { conectar().catch((e) => log("error", "reconexao.falhou", { erro: e?.message })); }, espera);
  }

  function aoMessagesUpsert({ messages }) {
    for (const m of messages ?? []) {
      if (m.key?.fromMe) continue; // eco da própria mensagem enviada — ignorar
      handlersMensagem.forEach((h) => h({
        providerMessageId: m.key?.id,
        telefoneE164: m.key?.remoteJid ? deJid(m.key.remoteJid) : null,
        conteudo: m.message ?? null,
        recebidoEm: new Date().toISOString(),
      }));
      backendClient.notificarMensagemRecebida({
        providerMessageId: m.key?.id,
        telefoneE164: m.key?.remoteJid ? deJid(m.key.remoteJid) : null,
        recebidoEm: new Date().toISOString(),
      }).catch((e) => log("warn", "notificar_mensagem_recebida.falhou", { erro: e?.message }));
    }
  }

  function aoMessagesUpdate(updates) {
    for (const u of updates ?? []) {
      const id = u.key?.id;
      const novoStatus = u.update?.status ?? null;
      if (!id || novoStatus == null) continue;
      statusPorMensagemId.set(id, { status: novoStatus });
      backendClient.notificarStatusProvider({ providerMessageId: id, status: novoStatus }).catch(
        (e) => log("warn", "notificar_status_provider.falhou", { erro: e?.message }),
      );
    }
  }

  async function conectar() {
    if (status === STATUS_CONEXAO.CONNECTED) throw erro(CODIGOS.JA_CONECTADO);
    if (status === STATUS_CONEXAO.LOGGED_OUT) {
      // Só um NOVO pareamento (novo QR) sai de LOGGED_OUT — reset explícito,
      // nunca automático.
      status = STATUS_CONEXAO.DISCONNECTED;
    }
    encerradoManualmente = false;

    const carregouAlgo = await authAdapter.carregar().catch(() => false);
    if (!carregouAlgo) {
      const { initAuthCreds } = await import("baileys");
      authAdapter.inicializarCreds(initAuthCreds());
    }

    socket = fabricaSocket({ auth: authAdapter.comoAuthState(), printQRInTerminal: false });
    socket.ev.on("connection.update", aoConnectionUpdate);
    socket.ev.on("creds.update", (c) => authAdapter.aoAtualizarCreds(c).catch((e) => log("error", "auth_state.persistir_falhou", { erro: e?.message })));
    socket.ev.on("messages.upsert", aoMessagesUpsert);
    socket.ev.on("messages.update", aoMessagesUpdate);

    status = STATUS_CONEXAO.CONNECTING;
    iniciarHeartbeatPeriodico();
  }

  async function desconectar() {
    encerradoManualmente = true;
    pararHeartbeatPeriodico();
    if (socket) {
      await socket.end?.(undefined);
      socket = null;
    }
    status = STATUS_CONEXAO.DISCONNECTED;
    await heartbeat();
  }

  return {
    conectar,
    desconectar,
    async getStatus() {
      return { conectado: status === STATUS_CONEXAO.CONNECTED, provider: "baileys", telefone, atualizadoEm: new Date().toISOString(), status };
    },
    async enviar({ tipo, telefoneE164, conteudo }) {
      if (status !== STATUS_CONEXAO.CONNECTED) {
        // preEnvio: true — sabemos com certeza que nada saiu (nem tentamos).
        const e = erro(CODIGOS.NAO_CONECTADO);
        e.preEnvio = true;
        throw e;
      }
      const jid = paraJid(telefoneE164);
      const resultado = await socket.sendMessage(jid, conteudo);
      return { providerMessageId: resultado?.key?.id, enviadoEm: new Date().toISOString() };
    },
    onMessage(handler) { handlersMensagem.push(handler); },
    async markAsRead({ providerMessageId, telefoneE164 }) {
      if (!socket) throw erro(CODIGOS.NAO_CONECTADO);
      await socket.readMessages([{ id: providerMessageId, remoteJid: paraJid(telefoneE164) }]);
    },
    async getMessageStatus(providerMessageId) {
      return statusPorMensagemId.get(providerMessageId) ?? { status: "UNKNOWN" };
    },
    // ---- só para teste/observabilidade ----
    _status: () => status,
    _tentativasReconexao: () => tentativasReconexao,
    _qrAtual: () => qrAtual,
  };
}
