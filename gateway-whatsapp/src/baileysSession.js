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

// Checkpoint C3.5-C.3 — retry do 404 "capacidade ausente" ao chamar
// POST /eventos/auth-state/confirmar durante uma janela de rolling deploy
// (Gateway já atualizado, backend ainda não expõe a rota nova). Contador
// PRÓPRIO, independente de `tentativasReconexao`/`RESTORE_*`: nunca tratamos
// 401/403/LEASE_STALE/AUTH_SESSION_STALE como transitório — só este 404
// específico, e com teto de tentativas (nunca loop infinito).
const CONFIRMAR_AUTH_BASE_MS = 1_000;
const CONFIRMAR_AUTH_TETO_MS = 15_000;
const CONFIRMAR_AUTH_MAX_TENTATIVAS = 5;

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
  // Checkpoint C3.5-C.1/C.2/C.3 — CORREÇÃO DE CAUSA RAIZ: comprovado contra o
  // Baileys 6.7.24 REALMENTE instalado que `creds.registered` NUNCA vira
  // `true` no fluxo de pareamento por QR (só existe no fluxo de pairing code
  // numérico, node_modules/baileys/lib/Socket/messages-recv.js, handler
  // 'link_code_companion_reg'). Uma sessão real ficou presa em CONNECTING
  // permanentemente por causa disso, ao vivo em produção. `registered` NUNCA
  // MAIS decide nada aqui — só aparece em log para diagnóstico (ver
  // `creds_update.recebido`/`registradoNoFechamento` abaixo).
  //
  // Os DOIS fatos independentes que juntos (e só juntos) autorizam
  // status=CONNECTED agora são: `socketOpen` — o evento
  // `connection.update({connection:"open"})` do Baileys já disparou nesta
  // conexão; `authConfirmado` — o marcador DURÁVEL do Crescer (Postgres,
  // `whatsapp_auth_confirmado_fenced`, migration 086) já confirmou, para a
  // GERAÇÃO exata de auth desta conexão (`auth_session_id`), que
  // connection:"open" foi observado e toda persistência pendente concluiu.
  // Nenhum dos dois, isolado, pode marcar CONNECTED. Ambos resetados a cada
  // novo socket, em `abrirSocketEEscutarEventos()` e no fechamento
  // (`connection:"close"`).
  let socketOpen = false;
  let authConfirmado = false;
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

  /**
   * Checkpoint C3.5-C.2/C.3 — ÚNICO ponto de todo o módulo que pode promover
   * `status` para CONNECTED. Só promove quando os DOIS fatos independentes
   * (`socketOpen` e `authConfirmado`) já são verdadeiros — chamado tanto pelo
   * handler de `connection:"open"` (restore normal, quando `authConfirmado`
   * já veio true do backend) quanto ao final de `confirmarGeracaoAposOpen()`
   * (pareamento novo/reconexão/recovery legado, depois da RPC de confirmação
   * ter sucesso) — nenhum dos dois toca `status` diretamente. Idempotente:
   * chamar de novo depois de já CONNECTED é NOOP silencioso.
   */
  function tentarConfirmarConexao() {
    if (status === STATUS_CONEXAO.CONNECTED) return;
    if (!socketOpen || !authConfirmado) return;
    status = STATUS_CONEXAO.CONNECTED;
    autenticadaAlgumaVez = true;
    log("info", "pareamento.concluido", {});
    heartbeat().catch(() => {});
  }

  function aoConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update ?? {};

    if (qr) {
      if (origemSocket === "restore") {
        // ANOMALIA (Checkpoint C3.5-B, item 5; atualizado C3.5-C.2/C.3) — um
        // socket aberto por restaurarSessaoSePossivel() SEMPRE carrega um
        // auth_state_encrypted já existente (RESTORE NORMAL, authConfirmado
        // já true; ou RECOVERY LEGADO, authConfirmado ainda false, mas o
        // ciphertext/auth_session_id são reais) — nunca é AUTH_ABSENT, então
        // NUNCA deveria pedir pareamento novo. Se pedir mesmo assim (auth
        // state incompatível de um jeito que só se revela no handshake),
        // trata como falha e aborta — nunca expõe o QR (não grava em
        // qrAtual, não loga o valor, não reconecta sozinho por aqui).
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
      // Checkpoint C3.5-C.2/C.3 — `connection.open` sozinho NUNCA autoriza
      // CONNECTED/autenticadaAlgumaVez/pareamento concluído: é só UM dos
      // dois fatos independentes exigidos. `tentarConfirmarConexao()` é o
      // ÚNICO ponto que decide a promoção. Quando `authConfirmado` já veio
      // `true` do backend (restore normal — mesma geração já confirmada
      // antes), isto sozinho basta. Senão (pareamento novo, reconexão
      // pós-515, ou recovery legado — geração ainda NUNCA confirmada),
      // dispara `confirmarGeracaoAposOpen()`: captura o socket/geração ATUAL
      // e o `authSessionId` esperado SINCRONAMENTE, antes de qualquer
      // `await` — é essa captura síncrona que garante que um callback de
      // socket/geração antiga nunca confirme uma geração mais nova.
      qrAtual = null;
      tentativasReconexao = 0;
      socketOpen = true;
      telefone = socket?.user?.id ? deJid(socket.user.id) : telefone;
      log("info", "conexao.socket_aberto", {
        telefone: mascararTelefone(telefone),
        // Diagnóstico apenas (Checkpoint C3.5-C.1) — NUNCA decide fluxo.
        registradoNoBaileys: !!authAdapter.comoAuthState().creds?.registered,
      });
      if (authConfirmado) {
        tentarConfirmarConexao();
      } else {
        const socketCapturado = socket;
        const authSessionIdEsperado = authAdapter.obterAuthSessionIdAtual?.() ?? null;
        confirmarGeracaoAposOpen(socketCapturado, authSessionIdEsperado).catch(() => {});
      }
      return;
    }

    if (connection === "close") {
      // QR expira com o fechamento do socket que o gerou — um novo QR (se
      // houver reconexão) vem num evento `qr` futuro, nunca reaproveita este.
      qrAtual = null;
      origemSocket = null; // este socket morreu — qualquer socket futuro define sua própria origem
      socketOpen = false;
      authConfirmado = false;
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
        // Passo ESPERADO do handshake — reconecta recarregando os MESMOS
        // creds (ainda não confirmados), nunca gera QR novo. Checkpoint
        // C3.5-C.3: `conectar()` já trata TODO AUTH_PRESENT igual, sem
        // depender de `registered` — nenhuma opção especial precisa ser
        // passada aqui além do padrão.
        agendarReconexao();
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
   * Checkpoint C3.5-C.2/C.3 — fail-safe da confirmação durável
   * (`confirmarGeracaoAposOpen`, abaixo). Chamado sempre que a geração ATUAL
   * de auth não conseguiu ser confirmada (drain falhou, authSessionId
   * ausente, RPC recusou por LEASE_STALE/AUTH_SESSION_STALE/motivo
   * desconhecido, ou o retry de capacidade ausente esgotou as tentativas).
   * NUNCA pode resultar em CONNECTED (o socket é fechado antes de qualquer
   * chance de `tentarConfirmarConexao()` promover) e NUNCA gera um novo QR
   * automaticamente (`shutdownLocalSolicitado=true` impede o handler de
   * `close` de agendar reconexão). `socketCapturado` — defesa contra fechar
   * um socket mais NOVO que já assumiu no lugar do que falhou (checado de
   * novo aqui, além de nos pontos de chamada, porque fechar é sempre a ação
   * mais perigosa/irreversível do fluxo). Best-effort: manda um heartbeat
   * final, preservando LOGGED_OUT se por acaso já fosse o caso (mesma
   * invariante de sempre, via `marcarDesconectado()`).
   */
  async function falharSeguroConfirmacao(socketCapturado, categoria) {
    if (socket !== socketCapturado) return; // outro socket já assumiu — nunca mexe nele
    shutdownLocalSolicitado = true;
    origemSocket = null;
    socketOpen = false;
    authConfirmado = false;
    pararHeartbeatPeriodico();
    if (socket) {
      await socket.end?.(undefined).catch(() => {});
      socket = null;
    }
    marcarDesconectado();
    await heartbeat().catch(() => {});
    log("error", "auth_confirmar.fail_safe", { categoria });
  }

  /**
   * Checkpoint C3.5-C.2/C.3 — confirmação durável da GERAÇÃO de auth, depois
   * de `connection:"open"`. `socketCapturado`/`authSessionIdEsperado` já
   * foram capturados SINCRONAMENTE por quem chamou (no handler de
   * `connection.update`, antes de qualquer `await`) — nunca lidos de novo
   * aqui, para que um callback de um socket/geração já superados nunca
   * consiga confirmar uma geração mais nova.
   *
   * ORDEM (Checkpoint C3.5-C.3, item 11):
   *   1. socketOpen já foi marcado por quem chamou.
   *   2. aguarda toda persistência de creds/keys pendente concluir.
   *   3. confirma que ainda é o MESMO socket/geração (ninguém fechou/substituiu
   *      enquanto o drain rodava).
   *   4. exige authSessionIdEsperado válido (não-null).
   *   5. chama o backend (`confirmarAuthState`) com o fencing owner/epoch
   *      ATUAL (relido — pode ter mudado durante o drain).
   *   6. 404 (capacidade ausente, rolling deploy) — retry limitado/backoff,
   *      só para este motivo específico; nunca para 401/403/LEASE_STALE/
   *      AUTH_SESSION_STALE.
   *   7. confirma de novo o MESMO socket/geração, depois da chamada de rede.
   *   8. marca `authConfirmado=true`.
   *   9. `tentarConfirmarConexao()`.
   * Qualquer falha definitiva cai em `falharSeguroConfirmacao()` — nunca
   * CONNECTED, nunca reconexão/QR automáticos.
   */
  async function confirmarGeracaoAposOpen(socketCapturado, authSessionIdEsperado, tentativa = 0) {
    // 2.
    try {
      await authAdapter.aguardarPersistenciasPendentes?.();
    } catch (e) {
      if (socket !== socketCapturado) return; // callback obsoleto — outro socket já assumiu, nada a fazer
      log("error", "auth_confirmar.persistencia_pendente_falhou", {
        erroTipo: e?.name ?? e?.constructor?.name ?? null,
      });
      await falharSeguroConfirmacao(socketCapturado, "persistencia_pendente_falhou");
      return;
    }

    // 3.
    if (socket !== socketCapturado) return;

    // 4.
    if (!authSessionIdEsperado) {
      log("error", "auth_confirmar.sem_auth_session_id", {});
      await falharSeguroConfirmacao(socketCapturado, "auth_session_id_ausente");
      return;
    }

    // Mesmo padrão de heartbeat()/demais chamadas fenced: sem `leaseManager`
    // injetado (testes de lifecycle sem lease), segue SEM fencing — igual ao
    // comportamento de sempre. Só aborta quando `leaseManager` FOI injetado e
    // diz explicitamente que perdemos a lease nesse meio-tempo (aí
    // `_forcarFailSafe()` já cuida do resto).
    const contextoLease = leaseManager?.contexto();
    if (leaseManager && !contextoLease) return;

    // 5.
    let categoriaFalha = null;
    try {
      await backendClient.confirmarAuthState({ ...contextoLease, authSessionId: authSessionIdEsperado });
    } catch (e) {
      if (e?.leaseStale) {
        leaseManager?.notificarPerdaExterna("auth_confirmar_lease_stale");
        categoriaFalha = "lease_stale";
      } else if (e?.authSessionStale) {
        // Checkpoint C3.5-C.2/C.3 — NUNCA tratado como transitório: a
        // geração mudou por baixo (reset+novo pareamento no mesmo epoch).
        categoriaFalha = "auth_session_stale";
      } else if (e?.capacidadeAusente) {
        // 6. — só este motivo específico tem retry/backoff.
        if (socket !== socketCapturado) return;
        if (tentativa >= CONFIRMAR_AUTH_MAX_TENTATIVAS - 1) {
          categoriaFalha = "capacidade_ausente_esgotada";
        } else {
          const espera = Math.min(CONFIRMAR_AUTH_BASE_MS * (2 ** tentativa), CONFIRMAR_AUTH_TETO_MS);
          log("warn", "auth_confirmar.capacidade_ausente_tentando_de_novo", { tentativa });
          agendar(() => {
            confirmarGeracaoAposOpen(socketCapturado, authSessionIdEsperado, tentativa + 1).catch(() => {});
          }, espera);
          return;
        }
      } else {
        categoriaFalha = e?.name ?? e?.constructor?.name ?? "unknown";
      }
    }

    // 7.
    if (socket !== socketCapturado) return;

    if (categoriaFalha) {
      log("error", "auth_confirmar.recusado", { categoria: categoriaFalha });
      await falharSeguroConfirmacao(socketCapturado, categoriaFalha);
      return;
    }

    // 8.
    authConfirmado = true;
    log("info", "auth_confirmar.confirmado", {});
    // 9.
    tentarConfirmarConexao();
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

  /**
   * Checkpoint C3.5-B.1 — rollback best-effort, mas AGUARDADO, de
   * desired_connection_state=CONNECTED->DISCONNECTED quando `conectar()`
   * (chamada com `persistirIntencaoConectada:true`, ou seja, só o /connect
   * manual) já persistiu a intenção mas falha de forma TERMINAL antes de
   * qualquer socket (auth ausente NÃO cai aqui — só falta explícita de
   * chamar isto nesse caso, porque pareamento novo é o fluxo normal).
   * Nunca chamado pela reconexão automática pós-515 nem pelo restore
   * automático (nenhum dos dois passa `persistirIntencaoConectada`) — os
   * dois nunca escreveram CONNECTED para começo de conversa, então nunca há
   * nada para desfazer; é assim que se evita aplicar isto a uma queda
   * transitória de uma sessão já autenticada.
   */
  async function reverterDesiredParaDisconnected(motivo) {
    const contextoLease = leaseManager?.contexto();
    if (!contextoLease) return; // perdemos a lease nesse meio-tempo — nada nosso a reverter
    try {
      await backendClient.definirEstadoDesejado({ desiredConnectionState: "DISCONNECTED", ...contextoLease });
      log("warn", "connect.desired_rollback", { motivo });
    } catch (e) {
      if (e?.leaseStale) leaseManager?.notificarPerdaExterna("desired_rollback_stale");
      // NUNCA mascara o erro original — quem chamou já decidiu o resultado
      // (fail-closed) antes de tentar este rollback; uma falha aqui só
      // significa que `desired_connection_state` fica com CONNECTED
      // desatualizado até o próximo /disconnect manual ou LOGGED_OUT real.
      log("error", "connect.desired_rollback_falhou", {
        motivoOriginal: motivo, erroTipo: e?.name ?? e?.constructor?.name ?? null,
      });
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
   * Cria o socket Baileys, liga os listeners e inicia o heartbeat — a parte
   * comum entre `conectar()` (origem 'manual', inclusive reconexão
   * automática pós-515) e `restaurarSessaoSePossivel()` (origem 'restore').
   * Quem chama já deve ter deixado `authAdapter.comoAuthState()` no estado
   * correto (creds carregados/decididos) ANTES de invocar isto.
   * @param {'manual'|'restore'} origem
   * @param {object} [opcoes]
   * @param {boolean} [opcoes.authConfirmadoPreviamente] Checkpoint
   *   C3.5-C.2/C.3 — true quando o auth JÁ carregado para este socket tem
   *   `authConfirmado===true` DURÁVEL vindo do backend (a MESMA geração —
   *   `auth_session_id` — já passou por connection:"open"+drain+confirmação
   *   num boot ANTERIOR: todo caminho de restore normal, seção 13). Inicializa
   *   `authConfirmado` (local) já como verdadeiro nesse caso — não existe uma
   *   NOVA confirmação para esperar, `connection:"open"` sozinho já basta
   *   (via `tentarConfirmarConexao()`). Só fica `false` (exigindo que ESTE
   *   socket rode `confirmarGeracaoAposOpen()` inteiro antes de poder virar
   *   CONNECTED) para pareamento novo (AUTH_ABSENT), reconexão pós-515, ou
   *   recovery legado (seção 14) — geração ainda NUNCA confirmada.
   *   `creds.registered` do Baileys NUNCA participa desta decisão (Checkpoint
   *   C3.5-C.1 — no fluxo QR real, nunca vira `true`).
   */
  function abrirSocketEEscutarEventos(origem, { authConfirmadoPreviamente = false } = {}) {
    origemSocket = origem;
    socketOpen = false;
    authConfirmado = authConfirmadoPreviamente;
    socket = fabricaSocket({ auth: authAdapter.comoAuthState(), logger: criarLoggerBaileysSilencioso(), printQRInTerminal: false });
    socket.ev.on("connection.update", aoConnectionUpdate);
    socket.ev.on("creds.update", (c) => {
      // Só um booleano derivado, nunca o objeto `c` (creds reais) inteiro —
      // diagnóstico apenas (Checkpoint C3.5-C.1: `registered` NUNCA decide
      // fluxo — só a confirmação durável via `confirmarGeracaoAposOpen()`,
      // disparada pelo handler de connection:"open", decide isso agora).
      log("info", "creds_update.recebido", { registrado: !!c?.registered });
      authAdapter.aoAtualizarCreds(c).catch((e) => {
        if (e?.leaseStale) leaseManager?.notificarPerdaExterna("creds_update_persistir_stale");
        log("error", "auth_state.persistir_falhou", { erro: e?.name ?? e?.constructor?.name ?? "unknown" });
      });
    });
    socket.ev.on("messages.upsert", aoMessagesUpsert);
    socket.ev.on("messages.update", aoMessagesUpdate);

    status = STATUS_CONEXAO.CONNECTING;
    iniciarHeartbeatPeriodico();
  }

  /**
   * @param {object} [opcoes]
   * @param {boolean} [opcoes.persistirIntencaoConectada] Checkpoint C3.5-B,
   *   item 3 — true SÓ na chamada vinda de POST /whatsapp/connect (nunca na
   *   reconexão automática pós-515 nem no restore, que não representam uma
   *   nova decisão do operador). Grava desired_connection_state=CONNECTED
   *   ANTES de tocar no socket; se a gravação falhar, aborta sem abrir
   *   socket nenhum — nunca um socket "órfão" de uma intenção não registrada.
   */
  async function conectar({ persistirIntencaoConectada = false } = {}) {
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
      if (persistirIntencaoConectada) await reverterDesiredParaDisconnected("persistencia_pendente_falhou");
      return;
    }

    // Checkpoint C3.5-B.1 (correção da causa raiz de um QR gerado ao vivo em
    // produção por cima de uma sessão real já pareada) — `authAdapter.
    // carregar()` NUNCA mais devolve um boolean puro nem é envolvido num
    // `.catch(() => false)` cru. `{status:'absent'}` é a ÚNICA forma
    // legítima de "sem sessão para restaurar" (só ela permite pareamento
    // novo/QR); QUALQUER outra falha (fencing stale, erro HTTP, decrypt
    // AES-GCM, JSON malformado, estrutura inesperada) lança
    // `AuthStateLoadError` e cai no `catch` abaixo — fail-closed, nunca mais
    // tratado como "nunca pareado".
    let resultadoAuth;
    try {
      resultadoAuth = await authAdapter.carregar();
    } catch (e) {
      status = STATUS_CONEXAO.DISCONNECTED;
      const categoria = e?.categoria ?? "unknown";
      log("error", "connect.auth_load_fail_closed", { categoria });
      // Se a própria leitura de auth state veio stale (owner/epoch não
      // batem), isto quase sempre significa que já perdemos a lease — avisa
      // quem coordena, mesma disciplina já aplicada em heartbeat/desired-
      // state/restore (nunca um "silêncio" só porque esta chamada específica
      // não tinha esse tratamento ainda).
      if (categoria === "lease_stale") leaseManager?.notificarPerdaExterna("connect_auth_load_stale");
      if (persistirIntencaoConectada) await reverterDesiredParaDisconnected(`auth_load_${categoria}`);
      return;
    }

    if (resultadoAuth.status === "absent") {
      // Única situação em que dá para iniciar um pareamento novo (QR) com
      // segurança — não existe ciphertext nenhum salvo para esta
      // organização/instância.
      log("info", "connect.auth_absent_pairing_permitido", {});
      const { initAuthCreds } = await import("baileys");
      authAdapter.inicializarCreds(initAuthCreds());
    } else {
      // AUTH_PRESENT — sempre tenta retomar com os creds existentes.
      // Checkpoint C3.5-C.1: `creds.registered` do Baileys NUNCA decide isto
      // — comprovado contra o pacote 6.7.24 REALMENTE instalado que, no
      // fluxo de QR, `registered` nunca vira `true` (só existe no fluxo de
      // pairing code numérico). O antigo branch fail-closed baseado em
      // `registered!==true` partia dessa premissa falsa e travava TODA
      // sessão QR real para sempre (inclusive reconexão pós-515, que
      // recarrega exatamente estes mesmos creds ainda não registrados) — foi
      // removido. `authConfirmado` (marcador DURÁVEL, backend) é quem decide
      // se este socket herda a confirmação de uma geração já confirmada
      // antes (RESTORE NORMAL) ou precisa passar pela confirmação completa
      // de novo (pareamento novo, pós-515, ou recovery legado de uma sessão
      // real anterior a este checkpoint — seções 13/14).
      if (resultadoAuth.authConfirmado) autenticadaAlgumaVez = true;
      log("info", "connect.auth_loaded_restore", {
        authConfirmado: resultadoAuth.authConfirmado === true,
        // Diagnóstico apenas — nunca decide fluxo (Checkpoint C3.5-C.1).
        registradoNoBaileys: resultadoAuth.registered === true,
      });
    }

    // Checkpoint C3.5-C.2/C.3 — `authConfirmadoPreviamente` é exatamente
    // `resultadoAuth.authConfirmado===true`: se a geração recarregada JÁ foi
    // confirmada antes pelo backend, o fato B já é verdade e este socket
    // pode virar CONNECTED só com `connection.open`. Senão (pareamento novo,
    // pós-515, ou recovery legado), este socket precisa rodar
    // `confirmarGeracaoAposOpen()` inteiro antes de poder promover.
    abrirSocketEEscutarEventos("manual", { authConfirmadoPreviamente: resultadoAuth.authConfirmado === true });
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
    socketOpen = false;
    authConfirmado = false;
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
   * Checkpoint C3.5-B.2 — RESET/RE-PAIR explícito do OPERADOR (nunca
   * chamado automaticamente por nenhum outro caminho — shutdown técnico,
   * reconexão pós-515 e restore automático NUNCA fazem isto). Único jeito
   * de invalidar de forma controlada um auth state antigo (ex.: revogado
   * fora de banda, pelo celular) e preparar a sessão para um pareamento
   * novo, e a ÚNICA via permitida para sair de LOGGED_OUT sem um /connect
   * que já teria auth ausente (item 8 — reset é deliberado; nenhum outro
   * caminho tem essa permissão).
   *
   * ORDEM OBRIGATÓRIA (auditoria) — cada passo só avança se o anterior
   * confirmou sucesso; uma falha no meio NUNCA deixa um estado pior que o
   * inicial:
   *   1-2. exige leader; captura contexto owner/epoch.
   *   3. persiste desired=DISCONNECTED (fenced) PRIMEIRO — antes de tocar
   *      em qualquer socket ou auth. Falha aqui (stale ou erro) ABORTA
   *      imediatamente: nenhum socket é fechado por esta função (só como
   *      efeito colateral de perda de lease, se for o caso — mesmo
   *      comportamento já existente de notificarPerdaExterna/aoPerderLease),
   *      nenhum auth é tocado, erro sanitizado devolvido.
   *   4. SÓ SE o passo 3 confirmou: fecha o socket técnico existente
   *      (nunca manda mensagem, por construção de fecharSocketTecnico()).
   *   5. executa o reset fenced do auth (NULL/NULL, mesma RPC de sempre).
   *      Falha aqui: desired JÁ ficou DISCONNECTED (estado seguro e
   *      recuperável) e o auth ANTIGO continua preservado — NUNCA chama
   *      invalidarLocal() como se o reset tivesse concluído; erro
   *      explícito de "reset incompleto".
   *   6. SÓ SE o passo 5 confirmou: authAdapter.invalidarLocal(). Se isto
   *      falhar (teoricamente, é só memória local), trata como fail-safe
   *      grave — nunca tenta reconstruir o auth antigo no banco (o backend
   *      já está correto; o problema é só local).
   *   7. limpa marcadores de sessão/pareamento anterior.
   *   8. status=DISCONNECTED DIRETO (não via marcarDesconectado() — reset
   *      é a via explícita que PODE sair de LOGGED_OUT).
   *   9. heartbeat fenced final.
   *   10. log sanitizado de conclusão.
   */
  async function resetarSessao() {
    // 1-2.
    if (leaseManager && !leaseManager.souLeader()) throw erro(CODIGOS.SEM_LEASE);
    const contexto = leaseManager?.contexto();
    if (!contexto) throw erro(CODIGOS.SEM_LEASE);
    log("info", "reset.iniciado", {});

    // 3.
    try {
      await backendClient.definirEstadoDesejado({ desiredConnectionState: "DISCONNECTED", ...contexto });
    } catch (e) {
      if (e?.leaseStale) leaseManager?.notificarPerdaExterna("reset_desired_stale");
      log("error", "reset.desired_falhou", { erroTipo: e?.name ?? e?.constructor?.name ?? null });
      throw erro(CODIGOS.INDISPONIVEL, "reset abortado: falha ao persistir desired=DISCONNECTED — nada foi alterado");
    }
    log("info", "reset.desired_confirmado", {});

    // 4.
    await fecharSocketTecnico();
    log("info", "reset.socket_fechado", {});

    // 5.
    try {
      await backendClient.resetarAuthState(contexto);
    } catch (e) {
      if (e?.leaseStale) leaseManager?.notificarPerdaExterna("reset_auth_stale");
      log("error", "reset.auth_state_falhou", { erroTipo: e?.name ?? e?.constructor?.name ?? null });
      status = STATUS_CONEXAO.DISCONNECTED; // já é o caso (fecharSocketTecnico não altera status), explícito por clareza
      throw erro(CODIGOS.INDISPONIVEL, "reset incompleto: desired=DISCONNECTED confirmado, mas o auth state antigo NÃO foi limpo — permanece preservado");
    }
    log("info", "reset.auth_state_invalidado", {});

    // 6.
    try {
      authAdapter.invalidarLocal();
    } catch (e) {
      log("error", "reset.invalidar_local_falhou", { erroTipo: e?.name ?? e?.constructor?.name ?? null });
      autenticadaAlgumaVez = false;
      epochRestoreAvaliado = null;
      origemSocket = null;
      socketOpen = false;
      authConfirmado = false;
      status = STATUS_CONEXAO.DISCONNECTED;
      // O backend já confirmou o reset do auth — nunca tentamos desfazer
      // isso; é um problema LOCAL grave, não um motivo para reconstruir o
      // auth antigo no banco.
      throw erro(CODIGOS.INDISPONIVEL, "reset do backend concluído, mas falha local grave ao invalidar a memória do processo");
    }

    // 7.
    autenticadaAlgumaVez = false;
    epochRestoreAvaliado = null;
    origemSocket = null;
    socketOpen = false;
    authConfirmado = false;

    // 8.
    status = STATUS_CONEXAO.DISCONNECTED;
    shutdownLocalSolicitado = false;

    // 9.
    await heartbeat();

    // 10.
    log("info", "reset.concluido", {});
  }

  /**
   * Checkpoint C3.5-B — avalia se dá para restaurar a sessão automaticamente
   * e, se sim, restaura. Chamado por `leaseManager` via `aoTornarSeLeader`
   * (nunca a partir de HTTP — não existe rota para isto). Idempotente e
   * seguro de chamar mais de uma vez: uma avaliação em andamento
   * (`restaurandoSessao`) ou já concluída para este epoch
   * (`epochRestoreAvaliado`) faz qualquer chamada extra ser NOOP.
   *
   * REGRA FINAL (Checkpoint C3.5-C.2/C.3, seções 13/14): só restaura se, na
   * ordem, TUDO isto valer — somos leader do epoch atual; não há socket já
   * aberto/abrindo (manual ou restore anterior); ainda não avaliamos este
   * epoch; `desired_connection_state` lido (fenced) é CONNECTED; `status`
   * lido não é LOGGED_OUT; existe auth state carregável com `authSessionId`
   * presente (NUNCA `creds.registered` — Checkpoint C3.5-C.1: não decide
   * mais nada); e, imediatamente antes de abrir o socket, a lease ainda é
   * nossa NO MESMO epoch (proteção de corrida — tudo acima envolveu I/O de
   * rede). Duas variantes de socket resultante, decididas por
   * `authConfirmado` (durável, backend): RESTORE NORMAL (true — geração já
   * confirmada antes, só falta `connection.open`) ou RECOVERY LEGADO (false
   * — geração com auth presente nunca confirmada, ex.: sessão real anterior
   * a este checkpoint; UMA tentativa por epoch, nunca gera QR).
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

    // Checkpoint C3.5-C.2/C.3 — mesmo contrato explícito de conectar(): nunca
    // mais um boolean puro. Uma falha real (fencing stale, decrypt, parse,
    // HTTP) lança `AuthStateLoadError`; só `{status:'absent'}` é NOOP normal
    // (nunca abre socket, nunca gera QR). `registered` do Baileys NUNCA
    // decide isto (Checkpoint C3.5-C.1 — nunca vira true no fluxo QR real);
    // quem decide é `authSessionId`/`authConfirmado`, os marcadores DURÁVEIS
    // do backend (migration 086).
    let resultadoAuth;
    try {
      resultadoAuth = await authAdapter.carregar();
    } catch (e) {
      const categoria = e?.categoria ?? "unknown";
      if (categoria === "lease_stale") { leaseManager?.notificarPerdaExterna("restore_auth_stale"); return; }
      // Auth state corrompido/indecifrável (ou qualquer outra falha real) —
      // FAIL-SAFE: nunca deleta, nunca gera QR, nunca tenta de novo em loop.
      // NOOP definitivo para este epoch; só um /connect manual resolve.
      epochRestoreAvaliado = contextoOriginal.leaseEpoch;
      log("error", "restore.auth_state_corrompido_fail_safe", { categoria });
      return;
    }
    if (resultadoAuth.status !== "loaded") {
      epochRestoreAvaliado = contextoOriginal.leaseEpoch;
      log("info", "restore.noop_sem_auth_carregado", {});
      return;
    }
    // Checkpoint C3.5-C.2/C.3, seção 14 — defesa em profundidade: todo
    // AUTH_PRESENT deveria ter authSessionId (o backfill da migration 086
    // garante isto para qualquer linha pré-existente; a RPC sempre gera um
    // na transição ausente->presente). Sem ele não há geração nenhuma para
    // confirmar depois de connection:"open" — fail-safe, nunca restaura às
    // cegas. Lido via obterAuthSessionIdAtual() (nunca um campo no retorno
    // de carregar() — authState.js só devolve {status,registered,
    // authConfirmado}; a geração fica em estado interno do adapter, exposta
    // só por este getter síncrono, a MESMA fonte que confirmarGeracaoAposOpen()
    // usa depois do 'open').
    const authSessionIdCarregado = authAdapter.obterAuthSessionIdAtual?.() ?? null;
    if (!authSessionIdCarregado) {
      epochRestoreAvaliado = contextoOriginal.leaseEpoch;
      log("error", "restore.sem_auth_session_id_fail_safe", {});
      return;
    }

    // Última checagem antes de abrir socket (item 9) — tudo acima envolveu
    // I/O de rede; o epoch pode ter mudado nesse meio-tempo.
    const contextoFinal = leaseManager?.contexto();
    if (!contextoFinal || contextoFinal.leaseEpoch !== contextoOriginal.leaseEpoch) return;
    if (status === STATUS_CONEXAO.CONNECTED || status === STATUS_CONEXAO.CONNECTING || status === STATUS_CONEXAO.LOGGED_OUT) return;

    epochRestoreAvaliado = contextoOriginal.leaseEpoch;
    shutdownLocalSolicitado = false;
    if (resultadoAuth.authConfirmado) {
      // RESTORE NORMAL (seção 13) — esta MESMA geração já foi confirmada
      // durável antes (auth_confirmado=true); connection:"open" sozinho
      // basta desta vez, via tentarConfirmarConexao() no handler.
      autenticadaAlgumaVez = true; // sessão já confirmada de verdade — queda futura pode reconectar sozinha
      log("info", "restore.abrindo_socket_normal", {});
    } else {
      // RECOVERY LEGADO (seção 14) — auth presente mas NUNCA confirmado
      // durável (sessão real anterior a este checkpoint, ou backfill da
      // migration 086). UMA tentativa por epoch (epochRestoreAvaliado já
      // marcado acima) — nunca gera QR (origem 'restore' — ver handler de
      // `qr` em aoConnectionUpdate), nunca initAuthCreds(), nunca reset. Se
      // abrir com sucesso, `confirmarGeracaoAposOpen()` confirma exatamente
      // este authSessionId depois do drain.
      log("info", "restore.abrindo_socket_recovery_legado", {});
    }
    abrirSocketEEscutarEventos("restore", { authConfirmadoPreviamente: resultadoAuth.authConfirmado === true });
  }

  return {
    conectar,
    desconectar,
    resetarSessao,
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
    _socketOpen: () => socketOpen,
    _authConfirmado: () => authConfirmado,
  };
}
