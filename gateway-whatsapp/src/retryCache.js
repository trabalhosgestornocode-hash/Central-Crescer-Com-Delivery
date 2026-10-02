// Cache de RETRY — reenvio de mensagens que um aparelho destinatário não conseguiu decifrar.
//
// O PROBLEMA (auditoria de 2026-10-02, comprovado no código e nos logs de produção): quando um aparelho não consegue
// decifrar uma mensagem nossa, ele exibe "Aguardando mensagem. Essa ação pode levar alguns instantes." e nos manda um
// RETRY RECEIPT. O Baileys 6.7.24 (node_modules/baileys/lib/Socket/messages-recv.js, `handleReceipt` →
// `sendMessagesAgain`) então força uma sessão Signal nova com aquele aparelho e chama `config.getMessage(key)` para
// obter o CONTEÚDO original e reenviá-lo. O padrão do pacote (`lib/Defaults/index.js`) é `getMessage: async () =>
// undefined` — sem ele, a mensagem nunca é reenviada e o destinatário fica preso em "Aguardando mensagem" para sempre.
// O próprio tipo do pacote diz isso (lib/Types/Socket.d.ts): "implement this so that messages failed to send (solves
// the 'this message can take a while' issue) can be retried".
//
// CONTRATO EXATO DO BAILEYS 6.7.24 (lido do código instalado — não suposto):
//   getMessage(key: proto.IMessageKey) => Promise<proto.IMessage | undefined>
//   * `key` = { remoteJid, id, fromMe, participant } montado em `handleReceipt`:
//       remoteJid   = attrs.from (o aparelho/usuário que pediu) — ou attrs.recipient quando o pedido veio de um aparelho
//                     da NOSSA conta. Pode vir com sufixo de aparelho ("5511…:2@s.whatsapp.net") e pode ser LID
//                     ("…@lid") mesmo que tenhamos enviado para o PN.
//       participant = attrs.participant || attrs.from
//       fromMe      = true para retry de mensagem nossa (só esse caso chega a `sendMessagesAgain`).
//   * o retorno é o `proto.IMessage` (o CONTEÚDO — `WebMessageInfo.message`), não o WebMessageInfo inteiro: o Baileys o
//     passa direto a `relayMessage(key.remoteJid, msg, { messageId: id, participant })`, que re-cifra para o aparelho
//     que pediu (ou para todos, se o pedido veio do aparelho primário — `sendToAll`).
//   * `undefined` ⇒ o Baileys só registra "recv retry request, but message not available" e não reenvia.
//   * a contagem por (id, aparelho) fica em `msgRetryCounterCache` (padrão: NodeCache de 1 h, POR SOCKET) e é limitada por
//     `maxMsgRetryCount` (5).
//
// O QUE É GUARDADO (o mínimo): os bytes de `proto.Message.encode(fullMsg.message)` — exatamente o que o Baileys
// cifrou na 1ª vez —, cifrados aqui (AES-256-GCM, subchave HKDF própria, AAD = instância+id). Nada de WebMessageInfo,
// de status, de chaves. O destino vai como HMAC (subchave própria) do usuário PN e, quando o WhatsApp informou, do LID:
// serve para nunca reenviar o conteúdo a um usuário que não foi o destinatário original.
//
// FONTE DA VERDADE: o BANCO (via backend, rotas HMAC fenced pela lease — o Gateway nunca fala com o Supabase). A memória é
// cache: cobre a janela de ~1 s entre o envio e a gravação (retries observados chegam 0,5–1,5 s depois do envio) e uma
// indisponibilidade curta do backend. Restart/reconnect ⇒ a memória some e o banco continua respondendo.
//
// FEATURE FLAG (WHATSAPP_RETRY_RESEND_ENABLED, padrão DESLIGADO): desligado, `opcoesSocket()` devolve `{}` — o socket é
// criado EXATAMENTE como antes (sem getMessage e sem msgRetryCounterCache próprio) — e nada é gravado. A observação
// passiva (retry receipts recebidos, eventos do Baileys) fica SEMPRE ligada: é o que mede o problema antes/depois.
//
// OBSERVABILIDADE: só vocabulário fechado, tipos (PN/LID/GROUP/OUTRO/NONE), contagens e um hash curto do id. Nunca
// telefone, JID, texto, payload (claro ou cifrado), chaves, QR.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { proto, jidDecode, isJidGroup, isJidUser, isLidUser } from "baileys";
import { log } from "./logsafe.js";
import { normalizarChave, derivarChave, encriptarBytes, decriptarBytes } from "./crypto.js";
import { classificarFalhaBackend } from "./classificacaoFalhas.js";

import {
  RETRY_TTL_PADRAO_HORAS, RETRY_TTL_MIN_HORAS, RETRY_TTL_MAX_HORAS, RETRY_MAX_REENVIOS_PADRAO, RETRY_MAX_REENVIOS_TETO,
} from "./retryLimites.js";

export { RETRY_TTL_PADRAO_HORAS, RETRY_TTL_MIN_HORAS, RETRY_TTL_MAX_HORAS, RETRY_MAX_REENVIOS_PADRAO, RETRY_MAX_REENVIOS_TETO };
export const RETRY_PAYLOAD_MAX_BYTES = 48 * 1024; // texto de alerta: dezenas a centenas de bytes; o teto só barra anomalia
export const VERSAO_PAYLOAD_RETRY = "r1";
// Mesmo TTL do NodeCache padrão do Baileys 6.7.24 (DEFAULT_CACHE_TTLS.MSG_RETRY = 1 h) — só o ESCOPO muda (processo).
export const MSG_RETRY_COUNTER_TTL_MS = 60 * 60 * 1000;
const ROTULO_PAYLOAD = "crescer/whatsapp/retry-cache/payload/v1";
const ROTULO_DESTINO = "crescer/whatsapp/retry-cache/destino/v1";
const ESPERA_PENDENTE_PADRAO_MS = 3_000;
const MEMORIA_MAX_ENTRADAS_PADRAO = 500;
const INTERVALO_METRICAS_PADRAO_MS = 5 * 60 * 1000;
const RETENTATIVA_GRAVACAO_MS = 2_000;

/** Tipo do JID — nunca o JID. */
export function tipoJid(jid) {
  if (typeof jid !== "string" || jid === "") return "NONE";
  try {
    if (isJidGroup(jid)) return "GROUP";
    if (isLidUser(jid)) return "LID";
    if (isJidUser(jid)) return "PN";
  } catch { /* cai em OUTRO */ }
  return "OUTRO";
}

/** "primario" (aparelho 0 / sem sufixo) | "companion" (aparelho > 0) | null — nunca o número do aparelho. */
export function tipoDispositivo(jid) {
  if (typeof jid !== "string" || jid === "") return null;
  try {
    const d = jidDecode(jid);
    if (!d) return null;
    return d.device ? "companion" : "primario";
  } catch { return null; }
}

/** Hash curto e não reversível do providerMessageId (ids do protocolo são aleatórios — sha256 basta para correlação). */
export function hashId(id) {
  if (typeof id !== "string" || id === "") return null;
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

/**
 * CacheStore compatível com o Baileys 6.7.24 (lib/Types/Socket.d.ts: get/set/del/flushAll) com TTL e teto de entradas.
 * Usado como `msgRetryCounterCache` com escopo de PROCESSO (ver criarCacheRetry).
 */
export function criarCacheTtl({ ttlMs, maxEntradas = 5_000, agora = Date.now } = {}) {
  const mapa = new Map(); // chave -> { valor, expiraEm }
  const vivo = (e) => e && e.expiraEm > agora();
  return {
    get(chave) {
      const e = mapa.get(chave);
      if (!vivo(e)) { if (e) mapa.delete(chave); return undefined; }
      return e.valor;
    },
    set(chave, valor) {
      mapa.delete(chave);
      mapa.set(chave, { valor, expiraEm: agora() + ttlMs });
      while (mapa.size > maxEntradas) mapa.delete(mapa.keys().next().value);
    },
    del(chave) { mapa.delete(chave); },
    flushAll() { mapa.clear(); },
    get tamanho() { return mapa.size; },
  };
}

function intervaloInteiro(v, min, max, padrao) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : padrao;
}

/**
 * @param {object} deps
 * @param {{salvarRetryCache: Function, consumirRetryCache: Function}} deps.backendClient
 * @param {string|Buffer} deps.chaveEncriptacaoEnv a MESMA chave mestra do auth state (env) — só subchaves derivadas são usadas
 * @param {string} deps.providerInstanceId
 * @param {() => ({gatewayProcessId: string, leaseEpoch: number}|null)} deps.obterContextoLease
 * @param {boolean} [deps.habilitado] WHATSAPP_RETRY_RESEND_ENABLED (padrão false)
 * @param {number} [deps.ttlHoras]
 * @param {number} [deps.maxReenvios]
 */
export function criarCacheRetry({
  backendClient, chaveEncriptacaoEnv, providerInstanceId = "default", obterContextoLease = () => null,
  habilitado = false, ttlHoras = RETRY_TTL_PADRAO_HORAS, maxReenvios = RETRY_MAX_REENVIOS_PADRAO,
  emitir = log, agora = Date.now, agendar = setTimeout, agendarIntervalo = setInterval, cancelarIntervalo = clearInterval,
  esperaPendenteMs = ESPERA_PENDENTE_PADRAO_MS, memoriaMaxEntradas = MEMORIA_MAX_ENTRADAS_PADRAO,
  intervaloMetricasMs = INTERVALO_METRICAS_PADRAO_MS, atrasoRetentativaMs = RETENTATIVA_GRAVACAO_MS,
}) {
  const ttlH = intervaloInteiro(ttlHoras, RETRY_TTL_MIN_HORAS, RETRY_TTL_MAX_HORAS, RETRY_TTL_PADRAO_HORAS);
  const ttlMs = ttlH * 60 * 60 * 1000;
  const maxR = intervaloInteiro(maxReenvios, 1, RETRY_MAX_REENVIOS_TETO, RETRY_MAX_REENVIOS_PADRAO);
  // Chaves só são exigidas quando o mecanismo está LIGADO (desligado, nada é cifrado nem lido).
  let chavePayload = null;
  let chaveDestino = null;
  if (habilitado) {
    const mestra = Buffer.isBuffer(chaveEncriptacaoEnv) ? chaveEncriptacaoEnv : normalizarChave(chaveEncriptacaoEnv);
    chavePayload = derivarChave(mestra, ROTULO_PAYLOAD);
    chaveDestino = derivarChave(mestra, ROTULO_DESTINO);
  }
  // Contador de retry do Baileys com escopo de PROCESSO (sobrevive à recriação do socket — ver docs). Só entra no socket
  // quando habilitado; desligado, o Baileys usa o próprio (por socket), exatamente como antes.
  const msgRetryCounterCache = criarCacheTtl({ ttlMs: MSG_RETRY_COUNTER_TTL_MS, agora });

  const memoria = new Map(); // providerMessageId -> { mensagem, destinoHash, destinoLidHash, expiraEm, reenvios }
  const pendentes = new Map(); // providerMessageId -> { promessa, resolver }  (envio em voo: getMessage espera)
  const reenviosEmCurso = new Map(); // providerMessageId -> instante em que getMessage devolveu o conteúdo
  const metricas = {
    retryRecebido: 0, getMessageChamado: 0, cacheHit: 0, cacheMiss: 0, reenvioSolicitado: 0, reenvioEnviado: 0,
    reenvioFalhou: 0, esgotado: 0, registrados: 0, persistidos: 0, falhasPersistencia: 0, destinoDivergente: 0,
    lidNaoVerificado: 0, hitMemoria: 0, hitBanco: 0,
  };
  let assinaturaUltimaEmissao = "";
  let timerMetricas = null;

  const aad = (id) => `${VERSAO_PAYLOAD_RETRY}|${providerInstanceId}|${id}`;
  const hmacDestino = (user) => createHmac("sha256", chaveDestino).update(String(user)).digest("hex");
  const igual = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length
    && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  function limparMemoria() {
    const t = agora();
    for (const [id, e] of memoria) if (e.expiraEm <= t) memoria.delete(id);
    while (memoria.size > memoriaMaxEntradas) memoria.delete(memoria.keys().next().value);
    for (const [id, t0] of reenviosEmCurso) if (t - t0 > 60_000) reenviosEmCurso.delete(id);
  }

  function resolverPendente(id) {
    const p = pendentes.get(id);
    if (p) { pendentes.delete(id); p.resolver(); }
  }

  async function esperarPendente(id) {
    const p = pendentes.get(id);
    if (!p) return;
    let timer;
    await Promise.race([p.promessa, new Promise((r) => { timer = agendar(r, esperaPendenteMs); timer?.unref?.(); })]);
    clearTimeout(timer);
  }

  async function gravarNoBackend(id, corpo, tentativa = 0) {
    const ctx = obterContextoLease();
    if (!ctx) {
      metricas.falhasPersistencia += 1;
      emitir("warn", "whatsapp.retry.cache_persistencia_falhou", { idHash: hashId(id), classe: "permanente", causa: "sem_lease", tentativa });
      return { status: "falhou" };
    }
    try {
      const r = await backendClient.salvarRetryCache({ ...corpo, ...ctx });
      metricas.persistidos += 1;
      emitir("info", "whatsapp.retry.cache_persistido", { idHash: hashId(id), resultado: r?.resultado ?? null, tentativa });
      return { status: "persistido", resultado: r?.resultado ?? null };
    } catch (e) {
      const c = classificarFalhaBackend(e);
      const capacidadeAusente = e?.capacidadeAusente === true;
      metricas.falhasPersistencia += 1;
      emitir("warn", "whatsapp.retry.cache_persistencia_falhou", { idHash: hashId(id), classe: c.classe, causa: c.causa, statusHttp: c.status, capacidadeAusente, tentativa });
      if (c.classe === "transitoria" && !capacidadeAusente && tentativa === 0) {
        // Sem unref: é UMA espera curta e única; o shutdown (process.exit) não depende dela.
        await new Promise((r) => { agendar(r, atrasoRetentativaMs); });
        return gravarNoBackend(id, corpo, 1);
      }
      return { status: "falhou", classe: c.classe };
    }
  }

  /**
   * Chamado por `enviar()` ANTES do sendMessage: um retry que chegue antes de `registrarEnvio` terminar espera (com teto).
   */
  function marcarEnvioIniciado(id) {
    if (!habilitado || typeof id !== "string" || !id || pendentes.has(id)) return;
    let resolver;
    const promessa = new Promise((r) => { resolver = r; });
    pendentes.set(id, { promessa, resolver });
  }

  function cancelarEnvio(id) { resolverPendente(id); }

  /**
   * Registra o conteúdo de uma mensagem RECÉM-ENVIADA. A parte em memória é síncrona (e libera quem espera o envio);
   * a gravação no backend é assíncrona e NUNCA lança — o envio já aconteceu e não pode falhar por causa do cache.
   * @returns {Promise<{status: string}>}
   */
  function registrarEnvio({ providerMessageId: id, mensagem, destinoJid, destinoLid = null, socketGeneration = null }) {
    if (!habilitado) return Promise.resolve({ status: "desligado" });
    try {
      const idHash = hashId(id);
      if (typeof id !== "string" || !id || !mensagem || typeof mensagem !== "object") {
        emitir("warn", "whatsapp.retry.cache_nao_registrado", { idHash, motivo: "sem_conteudo", socketGeneration });
        return Promise.resolve({ status: "ignorado" });
      }
      if (tipoJid(destinoJid) !== "PN") {
        emitir("warn", "whatsapp.retry.cache_nao_registrado", { idHash, motivo: "destino_nao_pn", socketGeneration });
        return Promise.resolve({ status: "ignorado" });
      }
      const instancia = mensagem instanceof proto.Message ? mensagem : proto.Message.fromObject(mensagem);
      const bytes = proto.Message.encode(instancia).finish();
      if (bytes.length === 0 || bytes.length > RETRY_PAYLOAD_MAX_BYTES) {
        emitir("warn", "whatsapp.retry.cache_nao_registrado", { idHash, motivo: bytes.length ? "payload_grande_demais" : "payload_vazio", bytes: bytes.length, socketGeneration });
        return Promise.resolve({ status: "ignorado" });
      }
      const userPn = jidDecode(destinoJid)?.user;
      const userLid = tipoJid(destinoLid) === "LID" ? jidDecode(destinoLid)?.user : null;
      const destinoHash = hmacDestino(userPn);
      const destinoLidHash = userLid ? hmacDestino(userLid) : null;
      // Cópia DECODIFICADA dos bytes: o objeto devolvido ao Baileys nunca é o mesmo que o chamador ainda pode mutar.
      memoria.set(id, { mensagem: proto.Message.decode(bytes), destinoHash, destinoLidHash, expiraEm: agora() + ttlMs, reenvios: 0 });
      limparMemoria();
      metricas.registrados += 1;
      resolverPendente(id);
      const payloadCifrado = encriptarBytes(bytes, chavePayload, aad(id));
      emitir("info", "whatsapp.retry.cache_registrado", { idHash, bytes: bytes.length, destinoLidConhecido: destinoLidHash !== null, socketGeneration });
      return gravarNoBackend(id, {
        providerMessageId: id, payloadCifrado, payloadVersao: VERSAO_PAYLOAD_RETRY, destinoHash, destinoLidHash,
        ttlSegundos: Math.round(ttlMs / 1000), maxReenvios: maxR,
      }).catch(() => ({ status: "falhou" }));
    } catch (e) {
      resolverPendente(id);
      emitir("error", "whatsapp.retry.cache_nao_registrado", { idHash: hashId(id), motivo: "erro_interno", erroTipo: e?.name ?? "erro", socketGeneration });
      return Promise.resolve({ status: "falhou" });
    }
  }

  function usarMemoria(id, fonte) {
    const e = memoria.get(id);
    if (!e) return null;
    if (e.expiraEm <= agora()) { memoria.delete(id); return { motivo: "expirada" }; }
    if (e.reenvios >= maxR) return { motivo: "esgotada" };
    e.reenvios += 1;
    return { fonte, registro: e };
  }

  async function consultar(id) {
    const ctx = obterContextoLease();
    if (!ctx) return usarMemoria(id, "memoria_sem_lease") ?? { motivo: "sem_lease" };
    let r;
    try {
      r = await backendClient.consumirRetryCache({ providerMessageId: id, ...ctx });
    } catch (e) {
      if (e?.leaseStale) return { motivo: "lease_stale" };
      // Backend fora do ar / rota ainda inexistente (rolling deploy): a memória cobre o que este processo enviou.
      return usarMemoria(id, "memoria_backend_indisponivel") ?? { motivo: "backend_indisponivel" };
    }
    if (r?.resultado === "OK") {
      let mensagem;
      try {
        if (r.payloadVersao !== VERSAO_PAYLOAD_RETRY) throw new Error("versao");
        mensagem = proto.Message.decode(decriptarBytes(r.payloadCifrado, chavePayload, aad(id)));
      } catch {
        emitir("error", "whatsapp.retry.payload_invalido", { idHash: hashId(id) });
        return { motivo: "payload_invalido" };
      }
      const registro = { mensagem, destinoHash: r.destinoHash, destinoLidHash: r.destinoLidHash ?? null, reenvios: r.reenvios ?? null };
      const m = memoria.get(id);
      if (m) m.reenvios = Math.max(m.reenvios, Number(r.reenvios) || 0);
      return { fonte: "banco", registro };
    }
    if (r?.resultado === "ESGOTADA") return { motivo: "esgotada" };
    if (r?.resultado === "EXPIRADA") { memoria.delete(id); return { motivo: "expirada" }; }
    // NAO_ENCONTRADA: a gravação deste processo pode ter falhado — a memória ainda vale.
    return usarMemoria(id, "memoria_sem_banco") ?? { motivo: "nao_encontrada" };
  }

  /** Nunca reenvia o conteúdo a um usuário que não seja o destinatário original (PN sempre; LID quando conhecido). */
  function verificarDestino(key, registro) {
    const tipo = tipoJid(key?.remoteJid);
    const user = jidDecode(key?.remoteJid)?.user;
    if (!user) return "divergente";
    if (tipo === "PN") return igual(hmacDestino(user), registro.destinoHash) ? "ok" : "divergente";
    if (tipo === "LID") {
      if (!registro.destinoLidHash) return "lid_nao_verificado";
      return igual(hmacDestino(user), registro.destinoLidHash) ? "ok" : "divergente";
    }
    return "divergente";
  }

  function miss(base, motivo) {
    metricas.cacheMiss += 1;
    if (motivo === "esgotada") metricas.esgotado += 1;
    if (motivo === "destino_divergente") metricas.destinoDivergente += 1;
    emitir(motivo === "esgotada" ? "warn" : "info", motivo === "esgotada" ? "whatsapp.retry.exhausted" : "whatsapp.retry.message_missing", { ...base, motivo, fonteLimite: motivo === "esgotada" ? "cache" : undefined });
    return undefined;
  }

  /** É o `getMessage` do socket — contrato exato do Baileys 6.7.24 (ver cabeçalho). Nunca lança. */
  async function obterMensagemParaRetry(key, { socketGeneration = null } = {}) {
    const id = typeof key?.id === "string" ? key.id : null;
    const base = {
      idHash: hashId(id), remoteJidType: tipoJid(key?.remoteJid), participantType: tipoJid(key?.participant),
      dispositivo: tipoDispositivo(key?.participant ?? key?.remoteJid), fromMe: key?.fromMe === true, socketGeneration,
    };
    metricas.getMessageChamado += 1;
    try {
      if (!habilitado) return miss(base, "desligado");
      if (!id) return miss(base, "sem_id");
      if (base.remoteJidType !== "PN" && base.remoteJidType !== "LID") return miss(base, "tipo_nao_suportado");
      await esperarPendente(id);
      const r = await consultar(id);
      if (!r?.registro) return miss(base, r?.motivo ?? "nao_encontrada");
      const destino = verificarDestino(key, r.registro);
      if (destino === "divergente") return miss(base, "destino_divergente");
      if (destino === "lid_nao_verificado") metricas.lidNaoVerificado += 1;
      metricas.cacheHit += 1;
      metricas.reenvioSolicitado += 1;
      if (r.fonte === "banco") metricas.hitBanco += 1; else metricas.hitMemoria += 1;
      reenviosEmCurso.set(id, agora());
      emitir("info", "whatsapp.retry.message_found", { ...base, fonte: r.fonte, destinoVerificado: destino === "ok", reenvios: r.registro.reenvios ?? null });
      emitir("info", "whatsapp.retry.resend_requested", { ...base });
      return r.registro.mensagem;
    } catch (e) {
      return miss(base, `erro_${e?.name ?? "interno"}`.slice(0, 40));
    }
  }

  /** Leitura PASSIVA dos retry receipts que chegam (o Baileys segue processando normalmente). */
  function observarSocket(socket, { obterGeracaoSocket = () => null, obterIdentidade = () => ({}) } = {}) {
    socket?.ws?.on?.("CB:receipt", (no) => {
      try {
        const a = no?.attrs ?? {};
        if (a.type !== "retry") return;
        metricas.retryRecebido += 1;
        const filhos = Array.isArray(no.content) ? no.content : [];
        const retry = filhos.find((c) => c?.tag === "retry");
        const quem = a.participant || a.from;
        const ident = obterIdentidade() ?? {};
        const tipoQuem = tipoJid(quem);
        const userQuem = (() => { try { return jidDecode(quem)?.user ?? null; } catch { return null; } })();
        const deContaPropria = Boolean(userQuem && ((tipoQuem === "PN" && userQuem === ident.pnUser) || (tipoQuem === "LID" && userQuem === ident.lidUser)));
        emitir("info", "whatsapp.retry.received", {
          idHash: hashId(a.id), remoteJidType: tipoJid(a.from), participantType: tipoJid(a.participant), recipientType: tipoJid(a.recipient),
          dispositivo: tipoDispositivo(quem), deContaPropria,
          // a MESMA regra de handleReceipt (Baileys 6.7.24) para `key.fromMe`
          fromMe: !a.recipient || deContaPropria,
          retryCount: Number(retry?.attrs?.count) || null, comChaves: filhos.some((c) => c?.tag === "keys"),
          offline: a.offline !== undefined, mensagemConhecida: memoria.has(a.id) || pendentes.has(a.id),
          habilitado, socketGeneration: obterGeracaoSocket(),
        });
      } catch { /* observação nunca interfere */ }
    });
  }

  /**
   * Envolve o logger do Baileys (silencioso) para transformar 4 mensagens EXATAS do pacote em eventos sanitizados.
   * Nunca repassa os argumentos (eles têm `key`/JID) — só o fato e contagens.
   */
  function envolverLogger(base) {
    if (!base) return base;
    const envolver = (b) => {
      const l = { get level() { return b.level; }, child: (...a) => envolver(b.child(...a)) };
      for (const n of ["trace", "debug", "info", "warn", "error", "fatal"]) {
        l[n] = (...args) => {
          try { observarLinha(n, args); } catch { /* observação nunca interfere */ }
          return b[n]?.(...args);
        };
      }
      return l;
    };
    return envolver(base);
  }

  function observarLinha(nivel, args) {
    const msg = typeof args[1] === "string" ? args[1] : (typeof args[0] === "string" ? args[0] : "");
    if (!msg) return;
    if (msg === "will not send message again, as sent too many times") {
      metricas.esgotado += 1;
      emitir("warn", "whatsapp.retry.exhausted", { fonteLimite: "baileys_maxMsgRetryCount" });
    } else if (msg === "error in sending message again") {
      metricas.reenvioFalhou += 1;
      const ids = Array.isArray(args[0]?.ids) ? args[0].ids : [];
      emitir("error", "whatsapp.retry.resend_failed", { idHash: hashId(ids[0]) });
    } else if (msg === "recv retry for not fromMe message") {
      emitir("info", "whatsapp.retry.ignorado_nao_fromme", {});
    } else if (nivel === "debug" && msg.startsWith("sending message to ") && reenviosEmCurso.has(args[0]?.msgId)) {
      const id = args[0].msgId;
      reenviosEmCurso.delete(id);
      metricas.reenvioEnviado += 1;
      const n = Number(/sending message to (\d+) devices/.exec(msg)?.[1]);
      emitir("info", "whatsapp.retry.resend_sent", { idHash: hashId(id), dispositivos: Number.isFinite(n) ? n : null });
    }
  }

  function obterMetricas() {
    const total = metricas.cacheHit + metricas.cacheMiss;
    return { ...metricas, cacheHitRate: total ? Math.round((metricas.cacheHit / total) * 1000) / 1000 : null, habilitado, ttlHoras: ttlH, maxReenvios: maxR, memoriaEntradas: memoria.size };
  }

  function emitirMetricas({ forcar = false } = {}) {
    const m = obterMetricas();
    const assinatura = JSON.stringify(metricas);
    if (!forcar && assinatura === assinaturaUltimaEmissao) return;
    assinaturaUltimaEmissao = assinatura;
    emitir("info", "whatsapp.retry.metricas", m);
  }

  return {
    get habilitado() { return habilitado; },
    /** `{}` desligado (socket idêntico ao de antes); ligado: getMessage + msgRetryCounterCache com escopo de processo. */
    opcoesSocket({ obterGeracaoSocket = () => null } = {}) {
      if (!habilitado) return {};
      return {
        getMessage: (key) => obterMensagemParaRetry(key, { socketGeneration: obterGeracaoSocket() }),
        msgRetryCounterCache,
      };
    },
    marcarEnvioIniciado,
    cancelarEnvio,
    registrarEnvio,
    obterMensagemParaRetry,
    observarSocket,
    envolverLogger,
    metricas: obterMetricas,
    emitirMetricas,
    iniciarMetricasPeriodicas() {
      if (timerMetricas) return;
      timerMetricas = agendarIntervalo(() => emitirMetricas(), intervaloMetricasMs);
      timerMetricas?.unref?.();
    },
    parar() { if (timerMetricas) { cancelarIntervalo(timerMetricas); timerMetricas = null; } },
    configuracao: () => ({ habilitado, ttlHoras: ttlH, maxReenvios: maxR }),
    // ---- só para teste ----
    _msgRetryCounterCache: msgRetryCounterCache,
    _memoria: memoria,
  };
}
