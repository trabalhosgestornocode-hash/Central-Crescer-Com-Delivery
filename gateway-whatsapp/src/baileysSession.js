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
// LIFECYCLE (Checkpoint C0, item 15; refinado no Checkpoint C3):
//   CONNECTING -> CONNECTED -> DISCONNECTED -> reconecta sozinho (backoff)
//                                              SÓ SE já autenticou alguma vez
//               -> LOGGED_OUT (terminal — NUNCA reconecta sozinho)
//
// PAREAMENTO INICIAL NUNCA RECONECTA SOZINHO (ajuste Checkpoint C3): antes da
// primeira vez que a sessão chega a `CONNECTED` (ou de recuperar um auth
// state já válido do backend), um QR expirado ou um `close` qualquer só pode
// levar a DISCONNECTED e PARAR — nunca gerar um novo QR sem um novo
// `/connect` explícito. Só depois de autenticada de verdade (uma vez que
// existe sessão real a preservar) uma queda transitória justifica
// reconexão automática. Ver `autenticadaAlgumaVez` abaixo.

import { log, mascararTelefone } from "./logsafe.js";
import { erro, CODIGOS } from "./errors.js";
import { criarLoggerBaileysSilencioso } from "./logger-baileys-silencioso.js";

// Diagnóstico (Checkpoint C3, instrumentação read-only): nomes dos códigos
// numéricos de DisconnectReason do Baileys (node_modules/baileys/lib/Types/
// index.js) — só para log, nunca afeta lógica. IMPORTANTE: o campo do log
// correspondente NÃO PODE se chamar `codigo` — essa chave é mascarada como
// ambígua por logsafe.js#CHAVES_EXATAS (pensada para código de verificação/
// OTP), o que escondia justamente o dado que faltava para diagnosticar closes
// anteriores. `codigoDesconexao`/`razaoDesconexao` não colidem com nada.
const NOMES_DISCONNECT_REASON = {
  401: "loggedOut",
  403: "forbidden",
  408: "connectionLost_ou_timedOut", // Baileys usa o mesmo código 408 para os dois
  411: "multideviceMismatch",
  428: "connectionClosed",
  440: "connectionReplaced",
  500: "badSession",
  503: "unavailableService",
  515: "restartRequired",
};

// ACHADO AO VIVO (Checkpoint C3): 515/restartRequired NÃO é falha — é o
// próprio WhatsApp pedindo, de propósito, uma reconexão com os MESMOS creds
// recém-recebidos (ainda `registered:false` nesse instante) para concluir o
// handshake de um pareamento novo, sem QR novo. Comportamento documentado do
// próprio Baileys. Tratado à parte da regra geral "pareamento inicial nunca
// reconecta sozinho" — aqui o reconnect É o próximo passo esperado.
const CODIGO_RESTART_REQUIRED = 515;

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
  // true assim que a sessão chega a CONNECTED pela primeira vez, OU quando
  // `conectar()` recupera um auth state já válido do backend (restart de
  // sessão já pareada). Enquanto for false, estamos num PAREAMENTO INICIAL —
  // QR expirado ou close não reconectam sozinhos.
  let autenticadaAlgumaVez = false;
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
      autenticadaAlgumaVez = true;
      telefone = socket?.user?.id ? deJid(socket.user.id) : telefone;
      log("info", "conexao.aberta", { telefone: mascararTelefone(telefone) });
      heartbeat().catch(() => {});
      return;
    }

    if (connection === "close") {
      // QR expira com o fechamento do socket que o gerou — um novo QR (se
      // houver reconexão) vem num evento `qr` futuro, nunca reaproveita este.
      qrAtual = null;
      const codigo = lastDisconnect?.error?.output?.statusCode;
      // Lido NO INSTANTE do close — nunca o valor de antes de conectar(). Só
      // um booleano derivado; nunca loga o objeto `creds` inteiro.
      const registradoNoFechamento = !!authAdapter.comoAuthState().creds?.registered;

      if (codigo === DisconnectReasonLoggedOut) {
        // TERMINAL — nunca reconecta sozinho. Exige novo QR humano.
        status = STATUS_CONEXAO.LOGGED_OUT;
        pararHeartbeatPeriodico();
        log("warn", "conexao.logged_out", { codigoDesconexao: codigo, razaoDesconexao: NOMES_DISCONNECT_REASON[codigo] ?? "desconhecido", registradoNoFechamento });
        heartbeat().catch(() => {});
        return;
      }

      status = STATUS_CONEXAO.DISCONNECTED;
      log("warn", "conexao.fechada_transitoria", {
        codigoDesconexao: codigo ?? null,
        razaoDesconexao: NOMES_DISCONNECT_REASON[codigo] ?? "desconhecido",
        registradoNoFechamento,
        tentativa: tentativasReconexao,
        autenticadaAlgumaVez,
      });
      heartbeat().catch(() => {});

      if (encerradoManualmente) return;
      if (codigo === CODIGO_RESTART_REQUIRED) {
        // Passo ESPERADO do handshake — reconecta com os MESMOS creds
        // (ainda não registrados), nunca gera QR novo.
        agendarReconexao({ preservarCredsNaoRegistrados: true });
        return;
      }
      if (autenticadaAlgumaVez) {
        // Sessão já tinha uma autenticação real — vale reconectar sozinho.
        agendarReconexao();
      } else {
        // Pareamento inicial nunca reconecta sozinho — exige novo /connect.
        // Para também o heartbeat periódico: sem isto, ele continuaria
        // reportando DISCONNECTED a cada WHATSAPP_HEARTBEAT_MS para sempre,
        // avançando disconnected_at/last_seen_at repetidamente sem nenhuma
        // queda nova ter acontecido — ruído confirmado ao vivo.
        pararHeartbeatPeriodico();
        log("warn", "pareamento_inicial.interrompido_sem_reconexao_automatica", {});
      }
    }
  }

  function agendarReconexao(opcoes = {}) {
    const espera = backoffMs();
    tentativasReconexao += 1;
    agendar(() => { conectar(opcoes).catch((e) => log("error", "reconexao.falhou", { erro: e?.message })); }, espera);
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

  /**
   * @param {object} [opcoes]
   * @param {boolean} [opcoes.preservarCredsNaoRegistrados] só usado pela
   *   reconexão automática após 515/restartRequired — reaproveita os creds
   *   parciais recém-recebidos (ainda `registered:false`) em vez de
   *   descartá-los. Nunca usado por uma chamada externa via /connect.
   */
  async function conectar({ preservarCredsNaoRegistrados = false } = {}) {
    if (status === STATUS_CONEXAO.CONNECTED) throw erro(CODIGOS.JA_CONECTADO);
    if (status === STATUS_CONEXAO.LOGGED_OUT) {
      // Só um NOVO pareamento (novo QR) sai de LOGGED_OUT — reset explícito,
      // nunca automático.
      status = STATUS_CONEXAO.DISCONNECTED;
    }
    encerradoManualmente = false;

    const carregouAlgo = await authAdapter.carregar().catch(() => false);
    // "carregou algo" só prova que existe ALGUM auth state salvo — o
    // Baileys grava creds PARCIAIS via creds.update durante o próprio
    // handshake, antes até do QR ser escaneado (confirmado ao vivo no
    // Checkpoint C3: um pareamento que nunca chegou a CONNECTED já deixou um
    // auth_state_encrypted real no banco). `creds.registered`
    // (node_modules/baileys/lib/Types/Auth.d.ts) só vira true quando o
    // registro termina de verdade.
    const credsRegistrados = carregouAlgo && authAdapter.comoAuthState().creds?.registered;
    const podeReaproveitar = carregouAlgo && (credsRegistrados || preservarCredsNaoRegistrados);
    if (podeReaproveitar) {
      if (credsRegistrados) autenticadaAlgumaVez = true;
      // senão: reconexão pós-restartRequired com creds ainda não registrados
      // — reaproveita SEM marcar autenticadaAlgumaVez (ainda não é sessão
      // estabelecida de verdade; só o próprio "open" ou um registered:true
      // futuro decide isso).
    } else {
      // Descarta creds parciais de um pareamento ABANDONADO (não é o caso do
      // restartRequired, que reaproveita explicitamente acima). Sem isto, um
      // pareamento interrompido deixava creds PARCIAIS salvas, e o próximo
      // /connect tentava RETOMÁ-las em vez de começar do zero — o Baileys
      // fechava a conexão quase instantaneamente, sem nunca gerar QR novo.
      const { initAuthCreds } = await import("baileys");
      authAdapter.inicializarCreds(initAuthCreds());
    }

    socket = fabricaSocket({ auth: authAdapter.comoAuthState(), logger: criarLoggerBaileysSilencioso(), printQRInTerminal: false });
    socket.ev.on("connection.update", aoConnectionUpdate);
    socket.ev.on("creds.update", (c) => {
      // Só um booleano derivado, nunca o objeto `c` (creds reais) inteiro —
      // diagnóstico de quando o registro realmente completa (Checkpoint C3).
      log("info", "creds_update.recebido", { registrado: !!c?.registered });
      authAdapter.aoAtualizarCreds(c).catch((e) => log("error", "auth_state.persistir_falhou", { erro: e?.message }));
    });
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
    /** QR atual (string) ou null — só em memória, nunca persistido/logado. Ver routes.js#/whatsapp/qr. */
    obterQrAtual: () => qrAtual,
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
    _autenticadaAlgumaVez: () => autenticadaAlgumaVez,
  };
}
