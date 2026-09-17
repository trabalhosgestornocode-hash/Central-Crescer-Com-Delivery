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

// Diagnóstico do 2º close (Checkpoint C3, autorizado — só observabilidade,
// nenhuma mudança de lifecycle): quando `codigoDesconexao` vem `null`,
// `lastDisconnect.error` não é um erro Boom padrão do Baileys e o motivo
// real fica invisível. Classifica com segurança — só tipos/nomes/booleans,
// NUNCA `message`/`stack`/valores de `data`/`output` (podem conter dados
// sensíveis do handshake). `erroCampos`/`outputCampos`/`dataCampos` são só
// os NOMES das propriedades (Object.keys), nunca o conteúdo.
function diagnosticarErroFechamento(error) {
  if (error == null || typeof error !== "object") {
    return {
      erroTipo: null, erroCodigoRede: null, erroErrno: null, erroSyscall: null,
      isBoom: false, temOutput: false, temData: false,
      erroCampos: [], outputCampos: [], dataCampos: [],
    };
  }
  const primitivoOuNull = (v) => (typeof v === "string" || typeof v === "number") ? v : null;
  const syscallSeguro = (v) => (typeof v === "string" && v.length <= 20) ? v : null;
  const camposDe = (obj) => (obj != null && typeof obj === "object") ? Object.keys(obj) : [];

  return {
    erroTipo: error.name ?? error.constructor?.name ?? null,
    erroCodigoRede: primitivoOuNull(error.code),
    erroErrno: primitivoOuNull(error.errno),
    erroSyscall: syscallSeguro(error.syscall),
    isBoom: error.isBoom === true,
    temOutput: error.output != null,
    temData: error.data != null,
    erroCampos: camposDe(error),
    outputCampos: camposDe(error.output),
    dataCampos: camposDe(error.data),
  };
}

// ACHADO AO VIVO (Checkpoint C3): 515/restartRequired NÃO é falha — é o
// próprio WhatsApp pedindo, de propósito, uma reconexão com os MESMOS creds
// recém-recebidos (ainda `registered:false` nesse instante) para concluir o
// handshake de um pareamento novo, sem QR novo. Comportamento documentado do
// próprio Baileys. Tratado à parte da regra geral "pareamento inicial nunca
// reconecta sozinho" — aqui o reconnect É o próximo passo esperado.
const CODIGO_RESTART_REQUIRED = 515;

// Checkpoint C3.5-B — retry do RESTORE automático (não confundir com
// `config.reconnect`, usado pela reconexão pós-close de uma sessão já
// aberta). Só cobre falha TRANSITÓRIA ao consultar /estado-conexao ou
// /auth-state (rede/backend fora do ar) — nunca usado para "sem auth
// state"/"não registrado"/LOGGED_OUT, que são NOOP definitivo, não erro.
// Contador independente de `tentativasReconexao` — um não interfere no outro.
const RESTORE_BASE_MS = 2_000;
const RESTORE_TETO_MS = 30_000;
const RESTORE_MAX_TENTATIVAS = 6;

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
 * @param {ReturnType<import('./leaseManager.js').criarLeaseManager>} [deps.leaseManager]
 *   Checkpoint C3.5 — sem isto injetado, a sessão funciona sem exclusão
 *   mútua (usado pelos testes de lifecycle que não envolvem lease). Em
 *   produção, server.js SEMPRE injeta: `conectar()` recusa rodar sem
 *   `souLeader()`, e `heartbeat()` nunca manda nada sem `contexto()` válido.
 */
export function criarSessaoBaileys({ authAdapter, backendClient, config, fabricaSocket, DisconnectReasonLoggedOut, agendar = setTimeout, leaseManager }) {
  let socket = null;
  let status = STATUS_CONEXAO.DISCONNECTED;
  let telefone = null;
  let qrAtual = null;
  let tentativasReconexao = 0;
  let heartbeatTimer = null;
  // Checkpoint C3.5-B, item 4 — CONCEITO LOCAL, nunca persistido: só impede
  // este PROCESSO de reagendar reconexão automática enquanto ele mesmo está
  // encerrando (desconectar() manual, ou _forcarFailSafe() por perda de
  // lease). NÃO representa a intenção do operador — isso é
  // `desired_connection_state`, gravado no banco via
  // backendClient.definirEstadoDesejado() e lido pelo restore. Os dois
  // nomes precisam ficar visualmente distintos de propósito: um é só
  // "não reconecte ESTE processo agora"; o outro é "o operador quer estar
  // pareado ou não".
  let shutdownLocalSolicitado = false;
  // true assim que a sessão chega a CONNECTED pela primeira vez, OU quando
  // `conectar()` recupera um auth state já válido do backend (restart de
  // sessão já pareada). Enquanto for false, estamos num PAREAMENTO INICIAL —
  // QR expirado ou close não reconectam sozinhos.
  let autenticadaAlgumaVez = false;
  // Checkpoint C3.5-B — de qual caminho veio o socket ATUAL (ou o que
  // acabou de ser criado): 'manual' (conectar(), inclusive reconexão
  // automática pós-515) ou 'restore' (restaurarSessaoSePossivel()). Só
  // importa para o handler de QR (item 5: restaurar NUNCA pode gerar QR —
  // se gerar, é anomalia, não um pareamento novo). Resetado para null
  // sempre que o socket é encerrado/substituído.
  let origemSocket = null;
  // Guardas de "restore uma vez por epoch" (item 9) — nunca duas avaliações
  // concorrentes, e nunca reavalia um epoch que já concluiu definitivamente
  // (sucesso, ou um NOOP definitivo — não conta falha transitória de rede).
  let restaurandoSessao = false;
  let epochRestoreAvaliado = null;
  // Checkpoint C3.5-B (reforço) — Promise em voo da persistência de
  // desired_connection_state=DISCONNECTED disparada pelo branch LOGGED_OUT
  // de `aoConnectionUpdate`. Guardada (não um fire-and-forget cru) para que
  // um shutdown técnico logo em seguida (`desconectar()`/SIGTERM) espere
  // essa gravação assentar (sucesso OU falha tratada) antes de prosseguir,
  // em vez de deixá-la correndo solta atravessando um `process.exit()`.
  let persistindoLogoutDesiredState = null;
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
    // Checkpoint C3.5, item 10: um processo que não é (mais) leader NUNCA
    // grava heartbeat de conexão — é exatamente isto que teria impedido a
    // instância ociosa `j4jv6` de sobrescrever `disconnected_at` no shutdown
    // ao vivo. Sem `leaseManager` injetado (testes sem lease), segue sem
    // fencing, igual ao comportamento anterior a este checkpoint.
    const contextoLease = leaseManager?.contexto();
    if (leaseManager && !contextoLease) {
      log("info", "heartbeat.pulado_sem_lease", {});
      return;
    }
    try {
      await backendClient.notificarHeartbeat({
        providerInstanceId: config.providerInstanceId,
        status,
        telefone,
        atualizadoEm: new Date().toISOString(),
        gatewayVersion: config.gatewayVersion,
        ...contextoLease,
        ...extra,
      });
    } catch (e) {
      // Checkpoint C3.5, item 12: uma rejeição 409 (fencing) significa que
      // perdemos a lease — nunca tratar como "heartbeat falho comum" (que
      // só loga e segue). Avisa quem coordena a lease para fechar o socket.
      if (e?.leaseStale) leaseManager?.notificarPerdaExterna("heartbeat_stale");
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
      if (origemSocket === "restore") {
        // ANOMALIA (Checkpoint C3.5-B, item 5) — um socket aberto por
        // restaurarSessaoSePossivel() só existe porque já confirmamos
        // creds.registered:true; ele NUNCA deveria pedir pareamento novo.
        // Se pedir mesmo assim (auth state incompatível de um jeito que só
        // se revela no handshake), trata como falha e aborta — nunca expõe
        // o QR (não grava em qrAtual, não loga o valor, não reconecta
        // sozinho por aqui).
        log("warn", "restore.anomalia_qr_abortando", {});
        status = STATUS_CONEXAO.DISCONNECTED;
        origemSocket = null;
        pararHeartbeatPeriodico();
        const s = socket;
        socket = null;
        Promise.resolve(s?.end?.(undefined)).catch(() => {});
        return;
      }
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
      origemSocket = null; // este socket morreu — qualquer socket futuro define sua própria origem
      const codigo = lastDisconnect?.error?.output?.statusCode;
      // Lido NO INSTANTE do close — nunca o valor de antes de conectar(). Só
      // um booleano derivado; nunca loga o objeto `creds` inteiro.
      const registradoNoFechamento = !!authAdapter.comoAuthState().creds?.registered;
      // Só entra no log quando o close NÃO é um Boom padrão (`codigo` null)
      // — ver diagnosticarErroFechamento acima.
      const diagnosticoErro = codigo == null ? diagnosticarErroFechamento(lastDisconnect?.error) : null;

      if (codigo === DisconnectReasonLoggedOut) {
        // TERMINAL — nunca reconecta sozinho. Exige novo QR humano.
        //
        // INVARIANTE CRÍTICA (reforço pós-auditoria): a partir daqui,
        // `status` só pode sair de LOGGED_OUT por um pareamento novo real
        // (ver o reset explícito em `conectar()`). NENHUM shutdown técnico
        // (SIGTERM -> desconectar(), ou _forcarFailSafe() por perda de
        // lease) pode rebaixar isto para DISCONNECTED — nem localmente, nem
        // no heartbeat que ele manda ao backend. Achado ao vivo na
        // auditoria: sem essa trava, LOGGED_OUT+SIGTERM logo em seguida
        // fazia `desconectar()` mandar um heartbeat final com
        // status=DISCONNECTED, sobrescrevendo o LOGGED_OUT já persistido —
        // e um novo owner que lesse /estado-conexao depois via
        // restaurarSessaoSePossivel() veria status=DISCONNECTED (em vez de
        // LOGGED_OUT) e, se a gravação de desired=DISCONNECTED abaixo
        // também tivesse falhado, tentaria restaurar uma sessão que o
        // WhatsApp já invalidou. `marcarDesconectado()`/`heartbeat()`
        // abaixo (chamados por `desconectar()`/`_forcarFailSafe()`) são o
        // que fecha esse buraco: eles NUNCA escrevem DISCONNECTED por cima
        // de LOGGED_OUT.
        status = STATUS_CONEXAO.LOGGED_OUT;
        pararHeartbeatPeriodico();
        log("warn", "conexao.logged_out", { codigoDesconexao: codigo, razaoDesconexao: NOMES_DISCONNECT_REASON[codigo] ?? "desconhecido", registradoNoFechamento });
        // Este heartbeat é o que PERSISTE status=LOGGED_OUT no backend — a
        // trava de que restaurarSessaoSePossivel() depende (verifica
        // `estado.status === LOGGED_OUT`) INDEPENDENTE de a gravação de
        // desired_connection_state abaixo funcionar ou não.
        heartbeat().catch(() => {});
        // Checkpoint C3.5-B, item 6 — LOGGED_OUT é definitivo: o próprio
        // WhatsApp encerrou o pareamento (ex.: dispositivo removido pelo
        // usuário). Grava desired_connection_state=DISCONNECTED para que
        // nenhum restart deste processo, handover de lease, ou renovação
        // de epoch tente reabrir socket com um auth state que o WhatsApp já
        // invalidou. NÃO é mais um fire-and-forget cru: a Promise fica
        // guardada em `persistindoLogoutDesiredState` para que
        // `desconectar()` (SIGTERM logo em seguida) espere ela assentar
        // antes de prosseguir. Mesmo assim, uma FALHA aqui nunca é a única
        // trava contra restore — `status=LOGGED_OUT` (heartbeat acima) já
        // é suficiente sozinho, porque restaurarSessaoSePossivel() checa os
        // dois (desired E status) antes de abrir qualquer socket.
        const contextoLeaseLogout = leaseManager?.contexto();
        if (contextoLeaseLogout) {
          persistindoLogoutDesiredState = (async () => {
            try {
              await backendClient.definirEstadoDesejado({
                desiredConnectionState: "DISCONNECTED",
                ...contextoLeaseLogout,
              });
            } catch (e) {
              if (e?.leaseStale) leaseManager?.notificarPerdaExterna("desired_state_stale_logged_out");
              log("warn", "logged_out.persistir_desired_disconnected_falhou", { erro: e?.message });
            }
          })();
        }
        return;
      }

      status = STATUS_CONEXAO.DISCONNECTED;
      log("warn", "conexao.fechada_transitoria", {
        codigoDesconexao: codigo ?? null,
        razaoDesconexao: NOMES_DISCONNECT_REASON[codigo] ?? "desconhecido",
        registradoNoFechamento,
        tentativa: tentativasReconexao,
        autenticadaAlgumaVez,
        ...(diagnosticoErro ?? {}),
      });
      heartbeat().catch(() => {});

      if (shutdownLocalSolicitado) return;
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

  /**
   * Checkpoint C3.5-B (reforço) — só isto decide se `status` pode virar
   * DISCONNECTED. LOGGED_OUT é terminal: nunca é rebaixado por um shutdown
   * técnico (SIGTERM) nem por perda de lease — só um pareamento novo real
   * (via `conectar()`, que já faz esse reset explícito) tira a sessão de
   * LOGGED_OUT. Chamar isto sobre um status que já é LOGGED_OUT é NOOP de
   * propósito.
   */
  function marcarDesconectado() {
    if (status !== STATUS_CONEXAO.LOGGED_OUT) status = STATUS_CONEXAO.DISCONNECTED;
  }

  /**
   * Checkpoint C3.5-B (reforço) — separado de `marcarDesconectado()` de
   * propósito (pedido explícito): só fecha o socket e para os timers, NUNCA
   * decide o `status` resultante. Quem chama decide status depois, via
   * `marcarDesconectado()` — é isso que permite `desconectar()` preservar
   * LOGGED_OUT em vez de sempre forçar DISCONNECTED.
   */
  async function fecharSocketTecnico() {
    origemSocket = null;
    pararHeartbeatPeriodico();
    if (socket) {
      await socket.end?.(undefined);
      socket = null;
    }
  }

  /**
   * Se um LOGGED_OUT acabou de disparar a persistência (assíncrona) de
   * desired_connection_state=DISCONNECTED, espera ela assentar (sucesso OU
   * falha já tratada dentro dela mesma) antes de prosseguir — nunca deixa
   * essa gravação "solta" atravessando um shutdown técnico/SIGTERM logo em
   * seguida. Nunca lança (a função guardada já trata a própria falha).
   */
  async function aguardarPersistenciaLogoutPendente() {
    if (persistindoLogoutDesiredState) await persistindoLogoutDesiredState;
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
   * Cria o socket Baileys, liga os listeners e inicia o heartbeat — a parte
   * comum entre `conectar()` (origem 'manual', inclusive reconexão
   * automática pós-515) e `restaurarSessaoSePossivel()` (origem 'restore').
   * Quem chama já deve ter deixado `authAdapter.comoAuthState()` no estado
   * correto (creds carregados/decididos) ANTES de invocar isto.
   * @param {'manual'|'restore'} origem
   */
  function abrirSocketEEscutarEventos(origem) {
    origemSocket = origem;
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

  /**
   * @param {object} [opcoes]
   * @param {boolean} [opcoes.preservarCredsNaoRegistrados] só usado pela
   *   reconexão automática após 515/restartRequired — reaproveita os creds
   *   parciais recém-recebidos (ainda `registered:false`) em vez de
   *   descartá-los. Nunca usado por uma chamada externa via /connect.
   * @param {boolean} [opcoes.persistirIntencaoConectada] Checkpoint C3.5-B,
   *   item 3 — true SÓ na chamada vinda de POST /whatsapp/connect (nunca na
   *   reconexão automática pós-515 nem no restore, que não representam uma
   *   nova decisão do operador). Grava desired_connection_state=CONNECTED
   *   ANTES de tocar no socket; se a gravação falhar, aborta sem abrir
   *   socket nenhum — nunca um socket "órfão" de uma intenção não registrada.
   */
  async function conectar({ preservarCredsNaoRegistrados = false, persistirIntencaoConectada = false } = {}) {
    // Checkpoint C3.5, item 14: só o dono atual da lease pode abrir socket
    // — protege tanto o /connect manual quanto a reconexão automática
    // pós-515 (que também passa por aqui). Nunca cria uma segunda sessão.
    if (leaseManager && !leaseManager.souLeader()) throw erro(CODIGOS.SEM_LEASE);
    if (status === STATUS_CONEXAO.CONNECTED) throw erro(CODIGOS.JA_CONECTADO);
    if (status === STATUS_CONEXAO.LOGGED_OUT) {
      // Só um NOVO pareamento (novo QR) sai de LOGGED_OUT — reset explícito,
      // nunca automático.
      status = STATUS_CONEXAO.DISCONNECTED;
    }
    shutdownLocalSolicitado = false;

    if (persistirIntencaoConectada) {
      const contextoLeaseConnect = leaseManager?.contexto();
      if (!contextoLeaseConnect) throw erro(CODIGOS.SEM_LEASE);
      try {
        await backendClient.definirEstadoDesejado({ desiredConnectionState: "CONNECTED", ...contextoLeaseConnect });
      } catch (e) {
        if (e?.leaseStale) leaseManager?.notificarPerdaExterna("desired_state_stale_connect");
        log("error", "connect.persistir_intencao_falhou", { erroTipo: e?.name ?? e?.constructor?.name ?? null });
        throw erro(CODIGOS.INDISPONIVEL, "falha ao persistir intenção de conexão");
      }
    }

    // Drena qualquer persistência de auth state ainda em voo (ex.: o
    // `creds.update` do pair-success, disparado pouco antes do
    // 515/restartRequired) ANTES de recarregar — senão `carregar()` poderia
    // ler do backend um estado mais antigo que este mesmo processo já
    // produziu, mas ainda não terminou de gravar. `?.()` porque nem todo
    // fake de teste implementa este método (comportamento opcional/aditivo).
    //
    // Se essa gravação pendente FALHOU, o backend ainda está com um estado
    // mais antigo do que este processo já produziu em memória — recarregar
    // aqui devolveria auth state obsoleto para um socket novo. Aborta a
    // reconexão de forma segura (DISCONNECTED, sem socket novo, sem
    // `carregar()`) em vez de seguir como se a gravação tivesse dado certo.
    // Nunca um retry cego aqui — só a próxima queda/backoff normal decide
    // se vale tentar de novo.
    try {
      await authAdapter.aguardarPersistenciasPendentes?.();
    } catch (e) {
      status = STATUS_CONEXAO.DISCONNECTED;
      log("error", "reconexao.abortada_persistencia_pendente_falhou", {
        // Só o NOME do erro (classe sanitizada) — nunca `message`/`stack`,
        // que podem conter detalhes do payload/HTTP (ver diagnosticarErroFechamento acima).
        erroTipo: e?.name ?? e?.constructor?.name ?? null,
      });
      return;
    }
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

    abrirSocketEEscutarEventos("manual");
  }

  /**
   * @param {object} [opcoes]
   * @param {boolean} [opcoes.persistirIntencao] Checkpoint C3.5-B, item 3 —
   *   true SÓ na chamada vinda de POST /whatsapp/disconnect (a decisão real
   *   do operador). Grava desired_connection_state=DISCONNECTED ANTES de
   *   fechar o socket; se a gravação falhar (e não for por perda de lease —
   *   nesse caso o próprio leaseManager já aciona `_forcarFailSafe()`
   *   independentemente), aborta SEM fechar o socket local (fail-safe: nunca
   *   fica com o socket fechado e uma intenção não gravada, que um restore
   *   futuro poderia reinterpretar errado).
   */
  async function desconectar({ persistirIntencao = false } = {}) {
    if (persistirIntencao) {
      const contextoLeaseDisconnect = leaseManager?.contexto();
      if (contextoLeaseDisconnect) {
        try {
          await backendClient.definirEstadoDesejado({ desiredConnectionState: "DISCONNECTED", ...contextoLeaseDisconnect });
        } catch (e) {
          if (e?.leaseStale) leaseManager?.notificarPerdaExterna("desired_state_stale_disconnect");
          log("error", "disconnect.persistir_intencao_falhou", { erroTipo: e?.name ?? e?.constructor?.name ?? null });
          throw erro(CODIGOS.INDISPONIVEL, "falha ao persistir intenção de desconexão");
        }
      }
    }
    shutdownLocalSolicitado = true;
    // Reforço pós-auditoria — se um LOGGED_OUT acabou de disparar a
    // gravação de desired=DISCONNECTED, espera ela assentar antes de seguir
    // (nunca deixa essa Promise correndo solta atravessando o resto deste
    // shutdown, que nos casos técnicos costuma terminar num process.exit()).
    await aguardarPersistenciaLogoutPendente();
    await fecharSocketTecnico();
    // NUNCA `status = DISCONNECTED` direto aqui — ver marcarDesconectado():
    // se a sessão já é LOGGED_OUT (terminal), este shutdown (manual ou
    // técnico) precisa preservar isso, tanto localmente quanto no heartbeat
    // final abaixo (que manda o `status` atual, seja ele qual for).
    marcarDesconectado();
    await heartbeat();
  }

  /**
   * Checkpoint C3.5, item 12 — chamado pelo `leaseManager` quando este
   * processo PERDE a lease enquanto ainda tinha socket aberto (renew
   * rejeitado/expirado, ou um 409 fenced numa gravação). Fecha o socket e
   * para tudo, mas — diferente de `desconectar()` — NUNCA manda um
   * heartbeat final: a essa altura `leaseManager.contexto()` já é `null`
   * (a lease já foi dada como perdida antes deste callback rodar), então
   * qualquer heartbeat seria recusado pelo backend mesmo, e `heartbeat()`
   * já pula sozinho sem `contexto()` — não tenta reaver ownership
   * silenciosamente mantendo o socket vivo.
   */
  async function _forcarFailSafe() {
    shutdownLocalSolicitado = true; // um close subsequente do socket não pode agendar reconexão
    await aguardarPersistenciaLogoutPendente();
    origemSocket = null;
    pararHeartbeatPeriodico();
    if (socket) {
      await socket.end?.(undefined).catch(() => {});
      socket = null;
    }
    // Mesma trava de marcarDesconectado() — perda de lease não pode
    // rebaixar LOGGED_OUT para DISCONNECTED localmente.
    marcarDesconectado();
  }

  /**
   * Checkpoint C3.5-B — avalia se dá para restaurar a sessão automaticamente
   * e, se sim, restaura. Chamado por `leaseManager` via `aoTornarSeLeader`
   * (nunca a partir de HTTP — não existe rota para isto). Idempotente e
   * seguro de chamar mais de uma vez: uma avaliação em andamento
   * (`restaurandoSessao`) ou já concluída para este epoch
   * (`epochRestoreAvaliado`) faz qualquer chamada extra ser NOOP.
   *
   * REGRA FINAL (item 5): só restaura se, na ordem, TUDO isto valer —
   * somos leader do epoch atual; não há socket já aberto/abrindo (manual ou
   * restore anterior); ainda não avaliamos este epoch; `desired_connection_
   * state` lido (fenced) é CONNECTED; `status` lido não é LOGGED_OUT; existe
   * auth state carregável e `creds.registered === true`; e, imediatamente
   * antes de abrir o socket, a lease ainda é nossa NO MESMO epoch (proteção
   * de corrida — tudo acima envolveu I/O de rede).
   */
  async function restaurarSessaoSePossivel() {
    const contextoLease = leaseManager?.contexto();
    if (!contextoLease) return; // standby — nunca lê auth state nem estado de sessão (item 6)
    if (restaurandoSessao) return;
    if (epochRestoreAvaliado === contextoLease.leaseEpoch) return; // restore uma vez por epoch (item 9)
    // Defesa em profundidade (reforço pós-auditoria) — mesmo processo, MESMO
    // epoch, já LOGGED_OUT localmente: nunca tenta restaurar. Redundante com
    // a checagem de `estado.status` em tentarRestaurarComRetry() (que cobre
    // o caso comum: um NOVO owner lendo o status persistido), mas não custa
    // nada e fecha qualquer brecha de reentrância dentro do MESMO processo.
    if (status === STATUS_CONEXAO.CONNECTED || status === STATUS_CONEXAO.CONNECTING || status === STATUS_CONEXAO.LOGGED_OUT) return;

    restaurandoSessao = true;
    try {
      await tentarRestaurarComRetry(contextoLease);
    } finally {
      restaurandoSessao = false;
    }
  }

  async function tentarRestaurarComRetry(contextoOriginal, tentativa = 0) {
    const contextoLease = leaseManager?.contexto();
    // Perdemos a lease, ou ela renovou para um epoch diferente, entre
    // agendamentos de retry — cancela; nunca restaura em nome de um epoch
    // que não é mais (ou ainda não é de novo) o nosso.
    if (!contextoLease || contextoLease.leaseEpoch !== contextoOriginal.leaseEpoch) return;
    if (status === STATUS_CONEXAO.CONNECTED || status === STATUS_CONEXAO.CONNECTING || status === STATUS_CONEXAO.LOGGED_OUT) return;

    let estado;
    try {
      estado = await backendClient.obterEstadoSessao(contextoLease);
    } catch (e) {
      if (e?.leaseStale) { leaseManager?.notificarPerdaExterna("restore_estado_stale"); return; }
      // Falha TRANSITÓRIA (rede/backend indisponível) — retry com backoff
      // limitado, só enquanto ainda formos leader deste mesmo epoch.
      if (tentativa >= RESTORE_MAX_TENTATIVAS - 1) {
        epochRestoreAvaliado = contextoOriginal.leaseEpoch;
        log("error", "restore.desistiu_apos_falhas_transitorias", { tentativas: tentativa + 1 });
        return;
      }
      const espera = Math.min(RESTORE_BASE_MS * (2 ** tentativa), RESTORE_TETO_MS);
      log("warn", "restore.estado_sessao_falhou_tentando_de_novo", { tentativa, erro: e?.message });
      agendar(() => { tentarRestaurarComRetry(contextoOriginal, tentativa + 1); }, espera);
      return;
    }

    if (estado?.desiredConnectionState !== "CONNECTED") {
      epochRestoreAvaliado = contextoOriginal.leaseEpoch;
      log("info", "restore.noop_desired_disconnected", {});
      return;
    }
    if (estado?.status === STATUS_CONEXAO.LOGGED_OUT) {
      epochRestoreAvaliado = contextoOriginal.leaseEpoch;
      log("info", "restore.noop_logged_out", {});
      return;
    }

    let carregouAlgo;
    try {
      carregouAlgo = await authAdapter.carregar();
    } catch (e) {
      // Auth state corrompido/indecifrável — FAIL-SAFE: nunca deleta, nunca
      // gera QR, nunca tenta de novo em loop. NOOP definitivo para este
      // epoch; só um /connect manual (que descarta creds inválidos) resolve.
      epochRestoreAvaliado = contextoOriginal.leaseEpoch;
      log("error", "restore.auth_state_corrompido_fail_safe", { erroTipo: e?.name ?? e?.constructor?.name ?? null });
      return;
    }
    const credsRegistrados = carregouAlgo && authAdapter.comoAuthState().creds?.registered;
    if (!credsRegistrados) {
      epochRestoreAvaliado = contextoOriginal.leaseEpoch;
      log("info", "restore.noop_sem_auth_registrado", {});
      return;
    }

    // Última checagem antes de abrir socket (item 9) — tudo acima envolveu
    // I/O de rede; o epoch pode ter mudado nesse meio-tempo.
    const contextoFinal = leaseManager?.contexto();
    if (!contextoFinal || contextoFinal.leaseEpoch !== contextoOriginal.leaseEpoch) return;
    if (status === STATUS_CONEXAO.CONNECTED || status === STATUS_CONEXAO.CONNECTING || status === STATUS_CONEXAO.LOGGED_OUT) return;

    epochRestoreAvaliado = contextoOriginal.leaseEpoch;
    autenticadaAlgumaVez = true; // sessão já pareada de verdade — queda futura pode reconectar sozinha
    shutdownLocalSolicitado = false;
    log("info", "restore.abrindo_socket", {});
    abrirSocketEEscutarEventos("restore");
  }

  return {
    conectar,
    desconectar,
    _forcarFailSafe,
    /** Checkpoint C3.5-B — só chamado por server.js via leaseManager({aoTornarSeLeader}). */
    _restaurarSessaoSePossivel: restaurarSessaoSePossivel,
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
    _origemSocket: () => origemSocket,
    _epochRestoreAvaliado: () => epochRestoreAvaliado,
  };
}
