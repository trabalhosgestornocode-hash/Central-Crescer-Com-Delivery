// Escopo de INBOUND do Gateway (Checkpoints C3.5-C.9.3 / C.9.3-R).
//
// CONTEXTO (provado em produção com a telemetria do C.9.2): a cada reconexão o servidor reentrega as
// mensagens offline e o Baileys tenta decifrar TODAS — dezenas de "Bad MAC", com criação de sessões (1:1 e
// as de participantes de grupo, que carregam a SenderKeyDistribution), sender-keys e pré-chaves de retry.
// O produto NÃO é somente outbound: chats DIRETOS de clientes (respostas a alertas, consentimento/opt-out,
// futuro Agente Crescer) precisam continuar chegando.
//
// MECANISMO (Baileys 6.7.24, código instalado): `config.shouldIgnoreJid(jid)` é consultado no PRIMEIRO passo
// de handleMessage (messages-recv.js, antes de decryptMessageNode), de handleReceipt, handleNotification e das
// presenças. Ignorar = só ACK e return: nenhum decrypt, sessão, sender-key, retry ou Bad MAC. O Baileys nunca
// ignora o JID técnico `@s.whatsapp.net` (o servidor), e nós também não.
//
// POLÍTICA (explícita, sem booleano obscuro):
//   ALL_SUPPORTED  (padrão) — NADA é ignorado e NADA é injetado: as opções do socket são as de antes.
//   DIRECT_ONLY             — ignora SOMENTE categorias que o produto v1 não suporta: group, status, broadcast e
//                             newsletter. Direct (PN e LID), meta_ai, technical e UNKNOWN passam (FAIL-SAFE).
//
// DIAGNÓSTICO (WHATSAPP_INBOUND_DIAG_ENABLED, padrão desligado) — só OBSERVA, nunca filtra: contadores
// agregados por TIPO de JID (stanzas por espécie, mensagens recebidas, decrypt ok/falha e motivo em vocabulário
// fechado, retries com/sem chave) + um total global de linhas "Bad MAC" da libsignal. Fontes, todas sem
// injetar nada no Baileys: listeners `ws.on('CB:*')` (stanzas), `messages.upsert` (resultado do decrypt), um
// wrapper do LOGGER do Baileys ("sent retry receipt") e a linha de console da libsignal.
//
// NUNCA registra JID, telefone, participant, author, remoteJid, ID de mensagem, conteúdo, hash ou chave: o que
// sai é o NOME do tipo e números.

import {
  isJidUser, isLidUser, isJidGroup, isJidBroadcast, isJidStatusBroadcast, isJidNewsletter, isJidMetaIa, isJidBot, META_AI_JID, proto,
} from "baileys";

export const ESCOPO_ALL_SUPPORTED = "ALL_SUPPORTED";
export const ESCOPO_DIRECT_ONLY = "DIRECT_ONLY";
export const ESCOPOS = Object.freeze([ESCOPO_ALL_SUPPORTED, ESCOPO_DIRECT_ONLY]);
export const ESCOPO_PADRAO = ESCOPO_ALL_SUPPORTED;

/** @returns {{escopo: string, valido: boolean}} valor inválido cai no padrão (comportamento anterior), sinalizado. */
export function interpretarEscopo(valor) {
  const v = String(valor ?? "").trim();
  if (v === "") return { escopo: ESCOPO_PADRAO, valido: true };
  if (ESCOPOS.includes(v)) return { escopo: v, valido: true };
  return { escopo: ESCOPO_PADRAO, valido: false };
}

export const TIPOS_JID = Object.freeze(["direct_pn", "direct_lid", "group", "status", "broadcast", "newsletter", "meta_ai", "technical", "unknown"]);

/** Categorias que o produto v1 explicitamente NÃO suporta (nenhum uso no código: verificado no C.9.3). */
export const TIPOS_NAO_SUPORTADOS_V1 = Object.freeze(new Set(["group", "status", "broadcast", "newsletter"]));

/**
 * Classificação pelos helpers OFICIAIS do Baileys 6.7.24 (WABinary/jid-utils.js). A ordem importa:
 * `status@broadcast` também termina em `@broadcast`.
 * @returns {'direct_pn'|'direct_lid'|'group'|'status'|'broadcast'|'newsletter'|'meta_ai'|'technical'|'unknown'}
 */
export function classificarJid(jid) {
  try {
    if (typeof jid !== "string" || jid === "") return "unknown";
    if (isJidStatusBroadcast(jid)) return "status";
    if (isJidBroadcast(jid)) return "broadcast";
    if (isJidGroup(jid)) return "group";
    if (isJidNewsletter(jid)) return "newsletter";
    if (isJidMetaIa(jid) || isJidBot(jid) || jid === META_AI_JID) return "meta_ai";
    if (jid === "@s.whatsapp.net") return "technical";         // o servidor
    if (isJidUser(jid)) return "direct_pn";
    if (isLidUser(jid)) return "direct_lid";
    if (jid.endsWith("@c.us")) return "technical";              // server@c.us, 0@c.us, OFFICIAL_BIZ_JID, ...
    return "unknown";
  } catch {
    return "unknown";
  }
}

const MOTIVOS = [
  [/bad mac/i, "bad_mac"],
  [/no matching sessions/i, "sem_sessao_compativel"],   // como o Bad MAC de sessão chega ao stub (libsignal SessionError)
  [/no session/i, "sem_sessao"],
  [/message absent from node/i, "sem_conteudo"],
  [/key used already or never filled/i, "chave_ja_usada"],
  [/invalid prekey|missing signedprekey|prekey/i, "prekey_invalida"],
  [/sender.?key/i, "sender_key"],
];
/** Vocabulário FECHADO: nunca devolve texto do erro. */
export function classificarMotivoFalha(texto) {
  const t = typeof texto === "string" ? texto : "";
  for (const [re, nome] of MOTIVOS) if (re.test(t)) return nome;
  return "outro";
}

const ESPECIES_STANZA = Object.freeze(["message", "receipt", "notification"]);

/**
 * Contadores estruturais por TIPO de JID. Só números e nomes de vocabulário fechado.
 *   stanzas   — vistas por espécie (message/receipt/notification) + `ignoradas` (só o filtro DIRECT_ONLY preenche)
 *   mensagens — recebidas (chegaram ao messages.upsert, ou seja, passaram pelo decrypt), decryptOk, decryptFalha, motivos
 *   retries   — retry receipts enviados: total e os que carregam pré-chave nova (retryCount > 1)
 *   badMacLinhas — total GLOBAL de linhas "Session error: … Bad MAC" da libsignal (sem tipo: a linha não traz JID)
 */
export function criarContadoresInbound() {
  const stanzas = {}; const mensagens = {}; const retries = {};
  let badMacLinhas = 0;
  let sujo = false;
  const slot = (o, tipo, ini) => (o[tipo] ??= ini());
  return {
    /** @param {string} tipo @param {boolean} ignorada @param {'message'|'receipt'|'notification'} [especie] */
    aoStanza(tipo, ignorada, especie) {
      const s = slot(stanzas, tipo, () => ({ message: 0, receipt: 0, notification: 0, ignoradas: 0 }));
      if (ESPECIES_STANZA.includes(especie)) s[especie]++;
      if (ignorada) s.ignoradas++;
      sujo = true;
    },
    aoMensagem(m) {
      const tipo = classificarJid(m?.key?.remoteJid);
      const c = slot(mensagens, tipo, () => ({ recebidas: 0, decryptOk: 0, decryptFalha: 0, motivos: {} }));
      c.recebidas++;
      if (m?.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT) {
        c.decryptFalha++;
        const mot = classificarMotivoFalha(m.messageStubParameters?.[0]);
        c.motivos[mot] = (c.motivos[mot] ?? 0) + 1;
      } else {
        c.decryptOk++;
      }
      sujo = true;
    },
    /** @param {any} jid @param {any} retryCount */
    aoRetry(jid, retryCount) {
      const tipo = classificarJid(jid);
      const r = slot(retries, tipo, () => ({ total: 0, comChave: 0 }));
      r.total++;
      if (Number(retryCount) > 1) r.comChave++;   // Baileys só anexa pré-chave nova a partir do 2º retry
      sujo = true;
    },
    aoBadMacLinha() { badMacLinhas++; sujo = true; },
    /** cópia profunda; só números e nomes do vocabulário fechado */
    snapshot: () => JSON.parse(JSON.stringify({ stanzas, mensagens, retries, badMacLinhas })),
    haMudancas: () => sujo,
    marcarEmitido() { sujo = false; },
  };
}

/**
 * @param {object} deps
 * @param {string} [deps.escopo] ESCOPO_ALL_SUPPORTED | ESCOPO_DIRECT_ONLY
 * @param {ReturnType<typeof criarContadoresInbound>} [deps.contadores] opcional (diagnóstico)
 * @returns {{escopo: string, shouldIgnoreJid: (jid: any) => boolean}}
 */
export function criarPoliticaInbound({ escopo = ESCOPO_PADRAO, contadores } = {}) {
  const direto = escopo === ESCOPO_DIRECT_ONLY;
  return {
    escopo,
    shouldIgnoreJid(jid) {
      let ignorar = false;
      let tipo = "unknown";
      try {
        tipo = classificarJid(jid);
        // DIRECT_ONLY ignora só o que está EXPLICITAMENTE na lista; qualquer outro tipo (inclusive unknown) passa.
        ignorar = direto && TIPOS_NAO_SUPORTADOS_V1.has(tipo);
      } catch {
        ignorar = false; // fail-safe: nunca descarta por dúvida
      }
      // Só conta o que FOI ignorado: as stanzas "vistas" (por espécie) vêm do observador de socket.
      if (ignorar) { try { contadores?.aoStanza(tipo, true); } catch { /* diagnóstico nunca interfere */ } }
      return ignorar;
    },
  };
}

/**
 * Cola de produção: escopo + diagnóstico opcional, prontos para o server.js.
 *
 * Regras de compatibilidade (o padrão NÃO muda nada):
 *   - `opcoesSocket()` só devolve `shouldIgnoreJid` em DIRECT_ONLY. Em ALL_SUPPORTED — com ou sem diagnóstico —
 *     devolve `{}`: o Baileys usa o próprio default `() => false`.
 *   - NUNCA devolve `shouldIgnoreJid: undefined`: o merge de defaults do Baileys o sobrescreveria e
 *     `shouldIgnoreJid is not a function` derrubaria todo o recebimento (provado no harness).
 *   - Diagnóstico desligado: todos os ganchos são no-op (nenhum listener, wrapper, timer ou contador).
 *
 * @param {object} deps
 * @param {string} [deps.escopoBruto] valor cru de WHATSAPP_INBOUND_SCOPE
 * @param {boolean} [deps.diagHabilitado] WHATSAPP_INBOUND_DIAG_ENABLED
 * @param {(nivel: string, evento: string, dados?: object) => void} deps.emitir
 * @param {number} [deps.intervaloMs] período do resumo (padrão 30 s)
 * @param {(fn: () => void, ms: number) => any} [deps.agendar] setInterval injetável
 * @param {(h: any) => void} [deps.cancelar] clearInterval injetável
 * @param {Console} [deps.consoleAlvo] onde observar a linha "Bad MAC" da libsignal (padrão: console global)
 */
export function criarInboundGateway({ escopoBruto, diagHabilitado = false, emitir, intervaloMs = 30_000, agendar = setInterval, cancelar = clearInterval, consoleAlvo = console } = {}) {
  const { escopo, valido } = interpretarEscopo(escopoBruto);
  const contadores = diagHabilitado ? criarContadoresInbound() : undefined;
  const politica = criarPoliticaInbound({ escopo, contadores });
  const filtrar = escopo === ESCOPO_DIRECT_ONLY;

  let timer = null;
  let consoleOriginal = null;
  let consoleEnvolvido = null;

  const emitirResumo = () => {
    if (!contadores || !contadores.haMudancas()) return;
    try {
      const { stanzas, mensagens, retries, badMacLinhas } = contadores.snapshot();
      const tipos = TIPOS_JID.filter((t) => stanzas[t] || mensagens[t] || retries[t]).map((tipo) => {
        const s = stanzas[tipo] ?? { message: 0, receipt: 0, notification: 0, ignoradas: 0 };
        const m = mensagens[tipo] ?? { recebidas: 0, decryptOk: 0, decryptFalha: 0, motivos: {} };
        const r = retries[tipo] ?? { total: 0, comChave: 0 };
        return {
          tipo,
          stanzasMensagem: s.message, stanzasReceipt: s.receipt, stanzasNotificacao: s.notification, ignoradas: s.ignoradas,
          recebidas: m.recebidas, decryptTentado: m.decryptOk + m.decryptFalha, decryptOk: m.decryptOk, decryptFalha: m.decryptFalha,
          motivos: Object.entries(m.motivos).map(([motivo, n]) => ({ motivo, n })),
          retries: r.total, retriesComChave: r.comChave,
        };
      });
      // valores CUMULATIVOS desde o boot do processo (a leitura de uma reconexão é a diferença entre dois resumos)
      emitir("info", "inbound.contadores", { escopo, filtroAtivo: filtrar, tipos, badMacLinhas });
      contadores.marcarEmitido();
    } catch { /* diagnóstico nunca interfere */ }
  };

  if (contadores) {
    timer = agendar(emitirResumo, intervaloMs);
    timer?.unref?.();
    // Conta a linha "Session error:… Bad MAC" da libsignal (global, sem JID) — só passa adiante, nunca altera.
    try {
      const original = consoleAlvo?.error;
      if (typeof original === "function") {
        consoleOriginal = original;
        consoleEnvolvido = function observado(...args) {
          try { if (typeof args[0] === "string" && args[0].startsWith("Session error:") && /bad mac/i.test(args[0])) contadores.aoBadMacLinha(); } catch { /* idem */ }
          return original.apply(this, args);
        };
        consoleAlvo.error = consoleEnvolvido;
      }
    } catch { consoleOriginal = null; }
  }

  return {
    escopo,
    valido,
    escopoBruto,
    diagnostico: Boolean(contadores),
    /** Opções a MESCLAR nas do socket. Vazio em ALL_SUPPORTED (com ou sem diagnóstico). */
    opcoesSocket: () => (filtrar ? { shouldIgnoreJid: politica.shouldIgnoreJid } : {}),
    /** true se o filtro real está ativo (só DIRECT_ONLY) */
    filtroAtivo: filtrar,
    /** chamado com as mensagens de messages.upsert (só as NÃO ignoradas chegam aqui) */
    aoMensagens(messages) {
      if (!contadores) return;
      try { for (const m of messages ?? []) contadores.aoMensagem(m); } catch { /* idem */ }
    },
    /** Observa (sem interferir) as stanzas message/receipt/notification por tipo de JID de origem. */
    observarSocket(socket) {
      if (!contadores) return;
      const ws = socket?.ws;
      if (typeof ws?.on !== "function") return;
      for (const [evento, especie] of [["CB:message", "message"], ["CB:receipt", "receipt"], ["CB:notification", "notification"]]) {
        try { ws.on(evento, (node) => { try { contadores.aoStanza(classificarJid(node?.attrs?.from), false, especie); } catch { /* idem */ } }); } catch { /* idem */ }
      }
    },
    /**
     * Envolve o logger do Baileys para contar os "sent retry receipt" por tipo. Diagnóstico desligado devolve o
     * MESMO logger (nenhum wrapper). O wrapper só lê `msgAttrs.from` para classificar e `retryCount`; nada é guardado.
     */
    envolverLogger(base) {
      if (!contadores || !base) return base;
      const envolver = (b) => {
        const l = {
          get level() { return b.level; },
          child: (...a) => envolver(b.child(...a)),
        };
        for (const n of ["trace", "debug", "info", "warn", "error", "fatal"]) {
          l[n] = (...args) => {
            if (n === "info" && args[1] === "sent retry receipt") { try { contadores.aoRetry(args[0]?.msgAttrs?.from, args[0]?.retryCount); } catch { /* idem */ } }
            return b[n]?.(...args);
          };
        }
        return l;
      };
      return envolver(base);
    },
    /** cópia dos contadores (só números) ou undefined se o diagnóstico está desligado */
    snapshot: () => contadores?.snapshot(),
    emitirResumo,
    parar() {
      if (timer) { cancelar(timer); timer = null; }
      if (consoleOriginal && consoleAlvo?.error === consoleEnvolvido) consoleAlvo.error = consoleOriginal;
      consoleOriginal = null; consoleEnvolvido = null;
    },
  };
}
