// Escopo de INBOUND do Gateway (Checkpoints C3.5-C.9.3 / C.9.3-R / C.9.4).
//
// CONTEXTO (provado em produção com a telemetria do C.9.2/C.9.3): a cada reconexão o servidor reentrega as
// mensagens offline e o Baileys tenta decifrar TODAS — dezenas de "Bad MAC" — e o `messages.upsert` NUNCA foi
// emitido em produção (zero chamadas `mensagem-recebida` ao backend). O produto NÃO é somente outbound: chats
// DIRETOS de clientes (respostas a alertas, consentimento/opt-out, futuro Agente Crescer) precisam chegar.
//
// MECANISMO DO FILTRO (Baileys 6.7.24, código instalado): `config.shouldIgnoreJid(jid)` é consultado no PRIMEIRO
// passo de handleMessage (antes de decryptMessageNode), de handleReceipt, handleNotification e das presenças.
// Ignorar = só ACK e return. O Baileys nunca ignora o JID técnico `@s.whatsapp.net`, e nós também não.
//
// POLÍTICA (explícita, sem booleano obscuro):
//   ALL_SUPPORTED  (padrão) — NADA é ignorado e NADA é injetado: as opções do socket são as de antes.
//   DIRECT_ONLY             — ignora SOMENTE group, status, broadcast e newsletter. Direct (PN e LID), meta_ai,
//                             technical e UNKNOWN passam (FAIL-SAFE). NÃO DECIDIDO para produção (C.9.4).
//
// DIAGNÓSTICO (WHATSAPP_INBOUND_DIAG_ENABLED, padrão desligado) — só OBSERVA, nunca filtra, nunca injeta. Segue a
// mensagem pelo pipeline REAL do Baileys por TIPO de JID (sem identificadores):
//
//   stanza (ws CB:message)  → decrypt ok/falha (na emissão de `messages.upsert`, ANTES do buffer)
//        → enfileirada (emitida com o buffer de eventos ATIVO) | emitida direto (buffer inativo)
//        → entregue (listener de messages.upsert do Gateway, i.e. o buffer foi LIBERADO)
//        → encaminhada ao backend (mensagem-recebida)
//   e o ciclo da fila offline/buffer: CB:ib,,offline_preview, CB:ib,,offline, receivedPendingNotifications,
//   buffer()/flush(), mensagens retidas — para distinguir "decrypt falhou" de "evento retido no buffer".
//
// Fontes (nada é injetado no Baileys): listeners `ws.on('CB:*')`, wrappers TRANSPARENTES de `ev.emit/buffer/flush`
// (mesmos argumentos e retorno, nunca lançam), um wrapper do LOGGER ("sent retry receipt") e a linha de console da
// libsignal. A identidade autenticada é lida SÓ em memória para separar direct_lid_self de direct_lid_other (uma
// comparação booleana); nunca é guardada, logada nem hasheada.
//
// NUNCA registra JID, LID, telefone, participant, author, remoteJid, ID de mensagem, conteúdo, hash ou chave: o que
// sai é o NOME do tipo, números, booleanos e segundos.

import {
  isJidUser, isLidUser, isJidGroup, isJidBroadcast, isJidStatusBroadcast, isJidNewsletter, isJidMetaIa, isJidBot, META_AI_JID, jidDecode, proto,
} from "baileys";
import { criarObservadorOffline } from "./offlineObserve.js";
import { criarIdentidadeOffline } from "./offlineIdentidade.js";

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

export const TIPOS_JID = Object.freeze(["direct_pn", "direct_lid_self", "direct_lid_other", "group", "status", "broadcast", "newsletter", "meta_ai", "technical", "unknown"]);

/** Categorias que o produto v1 explicitamente NÃO suporta (nenhum uso no código: verificado no C.9.3). */
export const TIPOS_NAO_SUPORTADOS_V1 = Object.freeze(new Set(["group", "status", "broadcast", "newsletter"]));

/**
 * Deriva, SÓ EM MEMÓRIA, as partes de usuário da identidade autenticada (`creds.me`: {id, lid}) para comparar.
 * O resultado nunca é logado nem exposto; existe apenas dentro do closure que classifica.
 */
export function identidadeDe(me) {
  try {
    const user = (j) => (typeof j === "string" && j ? jidDecode(j)?.user ?? null : null);
    return { pnUser: user(me?.id), lidUser: user(me?.lid) };
  } catch {
    return { pnUser: null, lidUser: null };
  }
}

/**
 * Classificação pelos helpers OFICIAIS do Baileys 6.7.24 (WABinary/jid-utils.js). A ordem importa:
 * `status@broadcast` também termina em `@broadcast`. LID: `direct_lid_self` só se o usuário do LID é o da identidade
 * autenticada (eventos do próprio aparelho/sessão); sem identidade ⇒ `direct_lid_other`.
 * @param {any} jid
 * @param {{lidUser?: string|null}} [identidade]
 * @returns {'direct_pn'|'direct_lid_self'|'direct_lid_other'|'group'|'status'|'broadcast'|'newsletter'|'meta_ai'|'technical'|'unknown'}
 */
export function classificarJid(jid, identidade) {
  try {
    if (typeof jid !== "string" || jid === "") return "unknown";
    if (isJidStatusBroadcast(jid)) return "status";
    if (isJidBroadcast(jid)) return "broadcast";
    if (isJidGroup(jid)) return "group";
    if (isJidNewsletter(jid)) return "newsletter";
    if (isJidMetaIa(jid) || isJidBot(jid) || jid === META_AI_JID) return "meta_ai";
    if (jid === "@s.whatsapp.net") return "technical";         // o servidor
    if (isJidUser(jid)) return "direct_pn";
    if (isLidUser(jid)) {
      const meu = identidade?.lidUser;
      return meu && jidDecode(jid)?.user === meu ? "direct_lid_self" : "direct_lid_other";
    }
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
 *   stanzas   — vistas por espécie + `ignoradas` (só o filtro DIRECT_ONLY preenche)
 *   mensagens — decryptTentado/Ok/Falha (+motivo), enfileiradas (emitidas com o buffer ativo), emitidasDireto,
 *               entregues (chegaram ao listener = buffer liberado), encaminhadas (enviadas ao backend)
 *   retries   — retry receipts: total, comPreChave (pré-chave nova anexada) e semPreChave
 *   badMacLinhas — total GLOBAL de linhas "Session error: … Bad MAC" da libsignal (sem tipo: a linha não traz JID)
 */
export function criarContadoresInbound() {
  const stanzas = {}; const mensagens = {}; const retries = {};
  let badMacLinhas = 0;
  let sujo = false;
  const slot = (o, tipo, ini) => (o[tipo] ??= ini());
  const novaFm = () => ({ tentado: 0, falha: 0 });
  const novaMsg = () => ({ decryptTentado: 0, decryptOk: 0, decryptFalha: 0, motivos: {}, enfileiradas: 0, emitidasDireto: 0, entregues: 0, encaminhadas: 0, fromMe: { sim: novaFm(), nao: novaFm(), desconhecido: novaFm() } });
  return {
    /** @param {string} tipo @param {boolean} ignorada @param {'message'|'receipt'|'notification'} [especie] */
    aoStanza(tipo, ignorada, especie) {
      const s = slot(stanzas, tipo, () => ({ message: 0, receipt: 0, notification: 0, ignoradas: 0 }));
      if (ESPECIES_STANZA.includes(especie)) s[especie]++;
      if (ignorada) s.ignoradas++;
      sujo = true;
    },
    /** mensagem que passou pelo decrypt e foi EMITIDA como messages.upsert (antes do buffer). */
    aoMensagemEmitida(m, identidade, bufferando) {
      const c = slot(mensagens, classificarJid(m?.key?.remoteJid, identidade), novaMsg);
      c.decryptTentado++;
      // (C.9.6) dimensão fromMe: a stanza é classificada pelo remetente (from) e o decrypt pelo chat (remoteJid); mensagens enviadas por OUTRO
      // aparelho da própria conta chegam com remoteJid = o destinatário. Só observação: a categoria acima não muda.
      const fm = m?.key?.fromMe === true ? "sim" : m?.key?.fromMe === false ? "nao" : "desconhecido";
      c.fromMe[fm].tentado++;
      if (m?.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT) {
        c.decryptFalha++;
        c.fromMe[fm].falha++;
        const mot = classificarMotivoFalha(m.messageStubParameters?.[0]);
        c.motivos[mot] = (c.motivos[mot] ?? 0) + 1;
      } else {
        c.decryptOk++;
      }
      if (bufferando) c.enfileiradas++; else c.emitidasDireto++;
      sujo = true;
    },
    aoMensagemEntregue(m, identidade) { slot(mensagens, classificarJid(m?.key?.remoteJid, identidade), novaMsg).entregues++; sujo = true; },
    aoMensagemEncaminhada(m, identidade) { slot(mensagens, classificarJid(m?.key?.remoteJid, identidade), novaMsg).encaminhadas++; sujo = true; },
    /** @param {string} tipo @param {boolean} comPreChave */
    aoRetry(tipo, comPreChave) {
      const r = slot(retries, tipo, () => ({ total: 0, comPreChave: 0, semPreChave: 0 }));
      r.total++;
      if (comPreChave) r.comPreChave++; else r.semPreChave++;
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
 * Estado do ciclo da fila offline / buffer de eventos do Baileys. Só booleanos, contagens e instantes (que viram
 * "segundos desde" na emissão).
 */
export function criarCicloFilaOffline({ agora = () => Date.now() } = {}) {
  const s = {
    buffersIniciados: 0, flushes: 0, flushesEfetivos: 0, offlinePreview: 0, offlineFim: 0, offlineFimContagem: null,
    pendentesNotificados: 0, conexoesAbertas: 0, retidas: 0, ultimoFlushEm: null, ultimaEnfileiradaEm: null, bufferAtivo: false,
    nosOffline: 0, nosVivos: 0, offlineFimEm: null, retidasPerdidas: 0, socketsObservados: 0,
  };
  const assinatura = () => JSON.stringify([s.buffersIniciados, s.flushes, s.flushesEfetivos, s.offlinePreview, s.offlineFim, s.offlineFimContagem, s.pendentesNotificados, s.conexoesAbertas, s.retidas, s.bufferAtivo, s.nosOffline, s.nosVivos, s.retidasPerdidas]);
  let assinaturaEmitida = assinatura();   // estado inicial = "nada novo": só emite quando algo muda
  const seg = (t) => (t == null ? null : Math.max(0, Math.round((agora() - t) / 1000)));
  return {
    estado: s,
    aoBuffer(jaEstavaAtivo) { if (!jaEstavaAtivo) s.buffersIniciados++; s.bufferAtivo = true; },
    aoFlush(efetivo) { s.flushes++; if (efetivo) { s.flushesEfetivos++; s.retidas = 0; s.ultimoFlushEm = agora(); } s.bufferAtivo = false; },
    aoEnfileirada() { s.retidas++; s.ultimaEnfileiradaEm = agora(); },
    aoOfflinePreview() { s.offlinePreview++; },
    aoOfflineFim(contagem) { s.offlineFim++; s.offlineFimEm = agora(); s.offlineFimContagem = Number.isFinite(contagem) ? contagem : null; },
    /** um nó message/receipt/notification chegou: OFFLINE (attrs.offline) ou VIVO (é o vivo que faz flush no Baileys) */
    aoNo(offline) { if (offline) s.nosOffline++; else s.nosVivos++; },
    aoPendentesNotificados() { s.pendentesNotificados++; },
    aoConexaoAberta() { s.conexoesAbertas++; },
    /** (C.9.6) um socket NOVO passou a ser observado: o buffer do anterior morreu com ele — as retidas dele deixam de contar e viram "perdidas". */
    aoNovoSocket() { s.socketsObservados++; s.retidasPerdidas += s.retidas; s.retidas = 0; s.bufferAtivo = false; },
    definirBufferAtivo(v) { s.bufferAtivo = Boolean(v); },
    mudou: () => assinatura() !== assinaturaEmitida,
    marcarEmitido() { assinaturaEmitida = assinatura(); },
    /**
     * @param {boolean|null} myAppStateKeyIdPresente @param {boolean|null} [bufferAtivoVivo] ev.isBuffering() lido na hora
     * SEMÂNTICA (C.9.6): `mensagensRetidas` = mensagens emitidas com o buffer ativo do socket ATUAL (zera a cada socket novo: o buffer velho
     * morreu com ele e vira `retidasPerdidasNoFechamento`). NÃO é cumulativo por processo (antes do C.9.6 era: 80 → 170 nas 2 primeiras
     * amostras) e é só TELEMETRIA — não altera o buffer real do Baileys.
     */
    payload(myAppStateKeyIdPresente, bufferAtivoVivo) {
      return {
        bufferAtivo: typeof bufferAtivoVivo === "boolean" ? bufferAtivoVivo : s.bufferAtivo, mensagensRetidas: s.retidas,
        bufferChamadasExternas: s.buffersIniciados, flushes: s.flushes, flushesEfetivos: s.flushesEfetivos,
        offlinePreviewRecebido: s.offlinePreview, offlineFimRecebido: s.offlineFim, offlineFimContagem: s.offlineFimContagem,
        receivedPendingNotifications: s.pendentesNotificados, conexoesAbertas: s.conexoesAbertas,
        myAppStateKeyIdPresente: myAppStateKeyIdPresente == null ? null : Boolean(myAppStateKeyIdPresente),
        nosOfflineVistos: s.nosOffline, nosVivosVistos: s.nosVivos, retidasPerdidasNoFechamento: s.retidasPerdidas,
        segundosDesdeOfflineFim: seg(s.offlineFimEm), segundosDesdeUltimoFlush: seg(s.ultimoFlushEm), segundosDesdeUltimaEnfileirada: seg(s.ultimaEnfileiradaEm),
      };
    },
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

const LIMITE_IDS_EM_MEMORIA = 5000;

/**
 * Cola de produção: escopo + diagnóstico opcional, prontos para o server.js.
 *
 * Regras de compatibilidade (o padrão NÃO muda nada):
 *   - `opcoesSocket()` só devolve `shouldIgnoreJid` em DIRECT_ONLY. Em ALL_SUPPORTED — com ou sem diagnóstico —
 *     devolve `{}`: o Baileys usa o próprio default `() => false`.
 *   - NUNCA devolve `shouldIgnoreJid: undefined`: o merge de defaults do Baileys o sobrescreveria.
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
 * @param {() => number} [deps.agora] relógio injetável
 * @param {boolean|object} [deps.offlineObserve] (C.9.6) liga o observador da fila offline (máquina de estados diagnóstica + watchdog em modo
 *   OBSERVE). Só vale com o diagnóstico ligado. `true` usa os PADRÕES; um objeto sobrescreve limites (testes).
 * @param {() => (number|null)} [deps.obterEpoch] epoch técnico da lease (só para rotular os eventos do observador)
 *   (C.9.7) `offlineObserve` objeto também aceita `identidade: false` (desliga a identidade efêmera) e `identidadeOpcoes` (testes); o resto são limites do observador.
 */
export function criarInboundGateway({ escopoBruto, diagHabilitado = false, emitir, intervaloMs = 30_000, agendar = setInterval, cancelar = clearInterval, consoleAlvo = console, agora = () => Date.now(), offlineObserve = false, obterEpoch = () => null } = {}) {
  const { escopo, valido } = interpretarEscopo(escopoBruto);
  const contadores = diagHabilitado ? criarContadoresInbound() : undefined;
  const ciclo = diagHabilitado ? criarCicloFilaOffline({ agora }) : undefined;
  const politica = criarPoliticaInbound({ escopo, contadores });
  const filtrar = escopo === ESCOPO_DIRECT_ONLY;
  // (C.9.6) O observador NÃO recebe ev/ws/socket: só dados, leitores por geração, emitir e timer. Ver src/offlineObserve.js.
  // (C.9.7) identidade EFÊMERA dos nós offline (HMAC com segredo aleatório só em memória): só nasce com o observador; só contagens saem.
  const { identidade: identidadeLigada = true, identidadeOpcoes = {}, ...limitesObserve } = typeof offlineObserve === "object" && offlineObserve ? offlineObserve : {};
  const identidadeOffline = diagHabilitado && offlineObserve && identidadeLigada !== false ? criarIdentidadeOffline(identidadeOpcoes) : undefined;
  const observador = diagHabilitado && offlineObserve
    ? criarObservadorOffline({ agora, emitir, obterEpoch, agendar, cancelar, identidade: identidadeOffline, ...limitesObserve })
    : undefined;

  let timer = null;
  let consoleOriginal = null;
  let consoleEnvolvido = null;
  /** @type {null | (() => {lidUser?: string|null, pnUser?: string|null})} */
  let obterIdentidade = null;
  /** @type {null | (() => boolean|null)} */
  let obterAppStateKey = null;
  /** @type {null | (() => boolean|null)} */
  let obterBufferAtivo = null;
  // id da stanza → tinha <enc>? SÓ em memória (limitada); serve para reproduzir a regra de pré-chave do retry.
  const encPorId = new Map();

  const identidade = () => { try { return obterIdentidade?.() ?? undefined; } catch { return undefined; } };

  const emitirResumo = () => {
    if (!contadores) return;
    try {
      if (contadores.haMudancas()) {
        const { stanzas, mensagens, retries, badMacLinhas } = contadores.snapshot();
        const tipos = TIPOS_JID.filter((t) => stanzas[t] || mensagens[t] || retries[t]).map((tipo) => {
          const s = stanzas[tipo] ?? { message: 0, receipt: 0, notification: 0, ignoradas: 0 };
          const m = mensagens[tipo] ?? { decryptTentado: 0, decryptOk: 0, decryptFalha: 0, motivos: {}, enfileiradas: 0, emitidasDireto: 0, entregues: 0, encaminhadas: 0, fromMe: { sim: { tentado: 0, falha: 0 }, nao: { tentado: 0, falha: 0 }, desconhecido: { tentado: 0, falha: 0 } } };
          const r = retries[tipo] ?? { total: 0, comPreChave: 0, semPreChave: 0 };
          return {
            tipo,
            stanzasMensagem: s.message, stanzasReceipt: s.receipt, stanzasNotificacao: s.notification, ignoradas: s.ignoradas,
            decryptTentado: m.decryptTentado, decryptOk: m.decryptOk, decryptFalha: m.decryptFalha,
            motivos: Object.entries(m.motivos).map(([motivo, n]) => ({ motivo, n })),
            enfileiradas: m.enfileiradas, emitidasDireto: m.emitidasDireto, entregues: m.entregues, encaminhadas: m.encaminhadas,
            fromMe: ["sim", "nao", "desconhecido"].map((v) => ({ v, tentado: m.fromMe[v].tentado, falha: m.fromMe[v].falha })),
            retryTotal: r.total, retryComPreChave: r.comPreChave, retrySemPreChave: r.semPreChave,
          };
        });
        // valores CUMULATIVOS desde o boot do processo (a leitura de uma reconexão é a diferença entre dois resumos)
        emitir("info", "inbound.contadores", { escopo, filtroAtivo: filtrar, tipos, badMacLinhas });
        contadores.marcarEmitido();
      }
    } catch { /* diagnóstico nunca interfere */ }
    try {
      if (ciclo?.mudou()) {
        let appState = null; try { appState = obterAppStateKey?.() ?? null; } catch { appState = null; }
        let buf = null; try { buf = obterBufferAtivo?.() ?? null; } catch { buf = null; }
        const p = ciclo.payload(appState, buf);
        const est = observador?.estado?.();
        if (est) { p.socketGeneration = est.socketGeneration; p.fase = est.fase; }
        emitir("info", "inbound.fila_offline", p);
        ciclo.marcarEmitido();
      }
    } catch { /* idem */ }
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
    /** (C.9.6) true se o observador da fila offline (máquina de estados + watchdog OBSERVE) está ligado */
    offlineObserve: Boolean(observador),
    /** Opções a MESCLAR nas do socket. Vazio em ALL_SUPPORTED (com ou sem diagnóstico). */
    opcoesSocket: () => (filtrar ? { shouldIgnoreJid: politica.shouldIgnoreJid } : {}),
    /** true se o filtro real está ativo (só DIRECT_ONLY) */
    filtroAtivo: filtrar,
    /** mensagens ENTREGUES ao listener de messages.upsert do Gateway (o buffer de eventos foi liberado). */
    aoMensagens(messages) {
      if (!contadores) return;
      try { const id = identidade(); for (const m of messages ?? []) contadores.aoMensagemEntregue(m, id); } catch { /* idem */ }
    },
    /** mensagem ENCAMINHADA ao backend (mensagem-recebida). */
    aoEncaminhada(m) {
      if (!contadores) return;
      try { contadores.aoMensagemEncaminhada(m, identidade()); } catch { /* idem */ }
    },
    /**
     * Observa (sem interferir) o socket: stanzas por tipo, ciclo da fila offline e o pipeline decrypt→buffer→entrega.
     * Todos os wrappers repassam argumentos e retorno idênticos e nunca lançam.
     */
    observarSocket(socket) {
      if (!contadores) return;
      ciclo.aoNovoSocket();   // (C.9.6) o buffer do socket anterior morreu com ele
      const ev = socket?.ev;
      const ws = socket?.ws;
      let g;
      try {
        g = observador?.novaGeracao({
          lerBufferAtivo: () => (typeof ev?.isBuffering === "function" ? ev.isBuffering() === true : false),
          lerSocketAberto: () => ws?.isOpen === true,
        });
      } catch { g = undefined; }
      obterIdentidade = () => identidadeDe(socket?.user ?? socket?.authState?.creds?.me);
      obterAppStateKey = () => Boolean(socket?.authState?.creds?.myAppStateKeyId);
      obterBufferAtivo = () => (typeof socket?.ev?.isBuffering === "function" ? socket.ev.isBuffering() === true : null);
      if (typeof ws?.on === "function") {
        const obs = (evento, fn) => { try { ws.on(evento, (node) => { try { fn(node); } catch { /* idem */ } }); } catch { /* idem */ } };
        for (const [evento, especie] of [["CB:message", "message"], ["CB:receipt", "receipt"], ["CB:notification", "notification"]]) {
          obs(evento, (node) => {
            const tipoStanza = classificarJid(node?.attrs?.from, identidade());
            contadores.aoStanza(tipoStanza, false, especie);
            ciclo.aoNo(Boolean(node?.attrs?.offline));   // mesma regra do Baileys: `!!node.attrs.offline`
            // (C.9.6) valor BRUTO de attrs.offline e o `t` (só para bucket de idade): o observador classifica antes de qualquer coerção
            observador?.aoNo(g, { especie, tipo: tipoStanza, offlineAttr: node?.attrs?.offline, t: node?.attrs?.t });
            // (C.9.7) identidade efêmera: SÓ nós offline (mesma regra do Baileys). O material bruto entra direto no módulo de identidade
            // (que só devolve contagens) e não vai para o observador, para log nem para nenhuma outra estrutura.
            if (identidadeOffline && node?.attrs?.offline) identidadeOffline.registrar(g, especie, { type: node.attrs.type, id: node.attrs.id, from: node.attrs.from, participant: node.attrs.participant });
            if (especie === "message" && node?.attrs?.id != null) {
              const tinhaEnc = Array.isArray(node.content) && node.content.some((c) => c?.tag === "enc");
              encPorId.set(node.attrs.id, tinhaEnc);
              if (encPorId.size > LIMITE_IDS_EM_MEMORIA) encPorId.delete(encPorId.keys().next().value);
            }
          });
        }
        obs("CB:ib,,offline_preview", (node) => { ciclo.aoOfflinePreview(); observador?.aoPreview(g, node); });
        obs("CB:ib,,offline", (node) => {
          const filho = Array.isArray(node?.content) ? node.content.find((c) => c?.tag === "offline") : null;
          ciclo.aoOfflineFim(Number(filho?.attrs?.count));
        });
        if (observador) {
          // qualquer frame recebido prova que o socket está vivo (não é progresso da fila offline)
          obs("frame", () => observador.aoAtividade(g));
          // o marcador é observado ANTES do handler do Baileys (prependListener): assim sabemos quantas retidas o flush oficial vai liberar.
          // O listener só LÊ: não altera nada e o handler do Baileys roda em seguida, como sempre.
          const antesDoMarcador = (node) => {
            try {
              const filho = Array.isArray(node?.content) ? node.content.find((c) => c?.tag === "offline") : null;
              observador.aoMarcador(g, Number(filho?.attrs?.count));
            } catch { /* idem */ }
          };
          try { if (typeof ws.prependListener === "function") ws.prependListener("CB:ib,,offline", antesDoMarcador); else ws.on("CB:ib,,offline", antesDoMarcador); } catch { /* idem */ }
        }
      }
      if (ev && typeof ev.emit === "function") {
        const bufferando = () => { try { return typeof ev.isBuffering === "function" ? ev.isBuffering() === true : false; } catch { return false; } };
        const emitOriginal = ev.emit;
        ev.emit = function emitObservado(evento, dados, ...resto) {
          try {
            if (evento === "messages.upsert") {
              const buf = bufferando(); const id = identidade();
              for (const m of dados?.messages ?? []) { contadores.aoMensagemEmitida(m, id, buf); if (buf) ciclo.aoEnfileirada(); observador?.aoUpsert(g, buf); }
            } else if (evento === "connection.update") {
              if (dados?.receivedPendingNotifications) ciclo.aoPendentesNotificados();
              if (dados?.connection === "open") ciclo.aoConexaoAberta();
              if (dados?.connection === "close") observador?.aoFechado(g);
            }
          } catch { /* idem */ }
          return emitOriginal.call(this, evento, dados, ...resto);
        };
        if (typeof ev.buffer === "function") {
          const bufOriginal = ev.buffer;
          ev.buffer = function bufferObservado(...args) {
            let ja = false; try { ja = bufferando(); } catch { /* idem */ }
            const r = bufOriginal.apply(this, args);
            try { ciclo.aoBuffer(ja); } catch { /* idem */ }
            return r;
          };
        }
        if (typeof ev.flush === "function") {
          const flushOriginal = ev.flush;
          ev.flush = function flushObservado(...args) {
            const r = flushOriginal.apply(this, args);
            try { ciclo.aoFlush(r === true); observador?.aoFlush(g, r === true); } catch { /* idem */ }
            return r;
          };
        }
      }
    },
    /**
     * Envolve o logger do Baileys para contar os "sent retry receipt" por tipo, com a regra REAL de pré-chave do
     * Baileys (`retryCount > 1 || forceIncludeKeys`, onde forceIncludeKeys = a stanza NÃO tinha `<enc>`).
     * Diagnóstico desligado devolve o MESMO logger (nenhum wrapper).
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
            if (n === "info" && args[1] === "sent retry receipt") {
              try {
                const attrs = args[0]?.msgAttrs;
                const tinhaEnc = encPorId.get(attrs?.id);
                const comPreChave = Number(args[0]?.retryCount) > 1 || tinhaEnc === false;
                contadores.aoRetry(classificarJid(attrs?.from, identidade()), comPreChave);
              } catch { /* idem */ }
            }
            return b[n]?.(...args);
          };
        }
        return l;
      };
      return envolver(base);
    },
    /** cópia dos contadores (só números) ou undefined se o diagnóstico está desligado */
    snapshot: () => contadores?.snapshot(),
    /** estado do ciclo da fila offline (só números/booleanos) ou undefined se desligado */
    estadoFila: () => ciclo?.payload(obterAppStateKey?.() ?? null, obterBufferAtivo?.() ?? null),
    /** (C.9.6) estado do observador da fila offline (geração atual; só números/booleanos/vocabulário fechado) ou undefined se desligado */
    estadoObserve: () => observador?.estado(),
    /** (C.9.7) só TAMANHOS da identidade efêmera (nunca impressões) ou undefined se desligada */
    estadoIdentidade: () => identidadeOffline?.estado(),
    metricasObserve: () => observador?.metricas(),
    emitirResumo,
    parar() {
      observador?.parar();
      if (timer) { cancelar(timer); timer = null; }
      if (consoleOriginal && consoleAlvo?.error === consoleEnvolvido) consoleAlvo.error = consoleOriginal;
      consoleOriginal = null; consoleEnvolvido = null;
    },
  };
}
