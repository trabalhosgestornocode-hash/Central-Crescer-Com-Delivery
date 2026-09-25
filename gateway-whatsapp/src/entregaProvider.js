// H.4-B.4 — ENTREGA CONFIRMÁVEL: transforma os sinais REAIS do Baileys 6.7.24 (instalado) em confirmações de status de uma mensagem
// que ESTE Gateway enviou, e as entrega ao backend (`POST /eventos/status-provider`, o MESMO canal HMAC já existente).
//
// SEMÂNTICA (comprovada no código do Baileys instalado — ver docs/comunicacao-entrega-confirmavel-h4b4.md):
//   * `sendMessage()` resolvido = o stanza foi ESCRITO no socket. Nada mais. O id (`3EB0…`) é gerado localmente.
//   * `<ack class="message" id>` do servidor SEM `error` = o servidor do WhatsApp aceitou o stanza. O Baileys NÃO emite evento para isso
//     (só trata o ack com `error`, em `handleBadAck`). Este módulo o observa direto no `ws` (leitura pura).
//   * `<receipt id>` SEM `type` = entrega (`DELIVERY_ACK`); `type="read"|"read-self"` = leitura; `type="played"` = reprodução;
//     `type="sender"` = `SERVER_ACK`. Outros tipos (`retry`, `inactive`, `hist_sync`…) NÃO produzem status.
//   * chat direto -> `messages.update {key, update:{status}}`; grupo/status -> `message-receipt.update {key, receipt:{userJid, receiptTimestamp|readTimestamp}}`.
//
// SÓ mensagens que ESTE processo enviou (`rastrear()`, chamado ANTES do sendMessage com o id pré-gerado) são reportadas: o Baileys emite
// `messages.update` para TODO recibo de mensagem de saída da conta (inclusive as enviadas do celular do dono) — reportá-los todos
// inundaria o backend de chamadas com ids desconhecidos. Perde-se, de propósito, o recibo de uma mensagem enviada por um processo que
// já reiniciou (documentado; o id fica em comunicacao_mensagens e a reconciliação humana cobre).
//
// DOIS OBSERVADORES para o mesmo evento (ev do Baileys + nó cru do `ws`) com DEDUPE por (id,status): o do `ws` não depende de o buffer de
// eventos do Baileys ser liberado (a fila offline nunca termina nesta conta — C.9→G.4.1). É leitura pura: nenhum flush, nenhum ack,
// nenhuma mudança no buffer, recovery continua OFF.
//
// LOGS: só ids técnicos, tipos e contagens — nunca telefone completo, conteúdo, segredo ou auth state (o JID vai MASCARADO por quem loga).

export const CONTRATO_STATUS_VERSAO = 1;
/** v2 — receipt VINCULADO à origem do envio: leva a instância emissora e a chave de correlação (idempotencyKey do pedido de envio). Espelha o backend. */
export const CONTRATO_STATUS_VERSAO_VINCULADO = 2;
export const STATUS_EVENTO = Object.freeze(["SERVER_ACK", "DELIVERED", "READ", "PROVIDER_ERROR"]);
/** WAMessageStatus do Baileys 6.7.24 (Types/Message.js): ERROR 0, PENDING 1, SERVER_ACK 2, DELIVERY_ACK 3, READ 4, PLAYED 5. */
export const STATUS_BAILEYS = Object.freeze({ ERROR: 0, PENDING: 1, SERVER_ACK: 2, DELIVERY_ACK: 3, READ: 4, PLAYED: 5 });

const ATRASOS_RETRY_MS = Object.freeze([1_000, 3_000, 10_000, 30_000]);
const RESULTADOS_CONCLUIDOS = new Set(["APLICADO", "DUPLICADO", "ACK_REGISTRADO", "ERRO_REGISTRADO"]);
const CODIGO_ERRO = /^[0-9]{1,6}$/;

/** status numérico do Baileys -> evento do contrato, ou `null` (PENDING não é sinal do provider). */
export function classificarStatusBaileys(n) {
  switch (n) {
    case STATUS_BAILEYS.ERROR: return { status: "PROVIDER_ERROR", ackTipo: "ack_erro" };
    case STATUS_BAILEYS.SERVER_ACK: return { status: "SERVER_ACK", ackTipo: "sender" };
    case STATUS_BAILEYS.DELIVERY_ACK: return { status: "DELIVERED", ackTipo: "entrega" };
    case STATUS_BAILEYS.READ: return { status: "READ", ackTipo: "leitura" };
    case STATUS_BAILEYS.PLAYED: return { status: "READ", ackTipo: "reproducao" };
    default: return null;
  }
}

/** `type` do nó `<receipt>` -> evento do contrato (mesma tabela do Baileys, STATUS_MAP + default DELIVERY_ACK), ou `null` (não é status). */
export function classificarTipoReceipt(tipo) {
  if (tipo === undefined || tipo === null) return { status: "DELIVERED", ackTipo: "entrega" };
  if (tipo === "sender") return { status: "SERVER_ACK", ackTipo: "sender" };
  if (tipo === "read") return { status: "READ", ackTipo: "leitura" };
  if (tipo === "played") return { status: "READ", ackTipo: "reproducao" };
  return null;   // "read-self" (outro aparelho NOSSO leu), "retry", "inactive", "hist_sync"… não dizem nada sobre a entrega da NOSSA mensagem
}

export function tipoDeJid(jid) {
  const s = String(jid ?? "");
  if (s.endsWith("@g.us")) return "group";
  if (s.endsWith("@lid")) return "lid";
  if (s.endsWith("@s.whatsapp.net")) return "pn";
  if (s === "status@broadcast" || s.endsWith("@broadcast")) return "broadcast";
  return "outro";
}

const codigoErro = (v) => (CODIGO_ERRO.test(String(v ?? "")) ? String(v) : "desconhecido");
const iso = (ms) => new Date(ms).toISOString();

/**
 * @param {object} deps
 * @param {(payload: object) => Promise<{resultado?: string}>} deps.notificar   backendClient.notificarStatusProvider
 * @param {(nivel: string, evento: string, dados: object) => void} deps.emitir  log estruturado sanitizado
 * @param {() => {socketGeneration?: number|null, leaseEpoch?: number|null}} [deps.contexto]
 * @param {string|null} [deps.providerInstanceId]  instância emissora (config); com `correlationId` do envio o receipt sai no contrato v2 (vinculado)
 */
export function criarObservadorEntrega({
  notificar, emitir, contexto = () => ({}), providerInstanceId = null, agora = () => Date.now(), agendar = setTimeout, cancelar = clearTimeout,
  maxRastreados = 500, ttlRastreioMs = 48 * 3600_000, maxDedupe = 4000, atrasosRetryMs = ATRASOS_RETRY_MS, intervaloLogNaoRastreadoMs = 60_000,
} = {}) {
  const rastreados = new Map();   // providerMessageId -> {correlationId, jidMascarado, enviadoEmMs}
  const vistos = new Set();       // `${id}|${status}|${erro}` — dedupe entre os 2 observadores e entre repetições do servidor
  const timers = new Set();
  const cont = { recebidos: 0, duplicados: 0, naoRastreados: 0, persistidos: 0, esgotados: 0, rejeitados: 0, legados: 0 };
  let naoRastreadosDesdeLog = 0;
  let ultimoLogNaoRastreado = 0;

  function ctx() { try { return contexto() ?? {}; } catch { return {}; } }

  function rastrear({ providerMessageId, correlationId = null, jidMascarado = null }) {
    if (typeof providerMessageId !== "string" || providerMessageId === "") return;
    rastreados.delete(providerMessageId);
    rastreados.set(providerMessageId, { correlationId, jidMascarado, enviadoEmMs: agora() });
    while (rastreados.size > maxRastreados) rastreados.delete(rastreados.keys().next().value);
  }

  function rastreio(id) {
    const r = rastreados.get(id);
    if (!r) return null;
    if (agora() - r.enviadoEmMs > ttlRastreioMs) { rastreados.delete(id); return null; }
    return r;
  }

  function contarNaoRastreado() {
    cont.naoRastreados += 1; naoRastreadosDesdeLog += 1;
    if (agora() - ultimoLogNaoRastreado >= intervaloLogNaoRastreadoMs) {
      emitir("info", "provider_receipt_nao_rastreado", { quantidadeDesdeUltimoLog: naoRastreadosDesdeLog, totalProcesso: cont.naoRastreados });
      naoRastreadosDesdeLog = 0; ultimoLogNaoRastreado = agora();
    }
  }

  function agendarRetry(fn, atrasoMs) {
    const h = agendar(() => { timers.delete(h); fn(); }, atrasoMs);
    h?.unref?.();
    timers.add(h);
  }

  /** Chave de dedupe de um receipt: mesmo id + mesmo status (+ código de erro). */
  const chaveDe = (evt) => `${evt.providerMessageId}|${evt.status}|${evt.erroCodigo ?? ""}`;

  async function entregar(evt, tentativa) {
    const payload = { contratoStatus: CONTRATO_STATUS_VERSAO, providerMessageId: evt.providerMessageId, status: evt.status, ocorridoEm: evt.ocorridoEm, ackTipo: evt.ackTipo };
    // v2 só quando as DUAS provas existem (instância configurada + chave de correlação rastreada no envio); senão o v1 legado (org da conexão), como antes.
    const vinculado = Boolean(providerInstanceId && evt.correlationId);
    if (vinculado) Object.assign(payload, { contratoStatus: CONTRATO_STATUS_VERSAO_VINCULADO, providerInstanceId, correlationId: evt.correlationId });
    else cont.legados += 1;
    if (evt.status === "PROVIDER_ERROR") payload.erroCodigo = evt.erroCodigo;
    let resultado = null;
    let rejeitadoPorContrato = false;
    try {
      const r = await notificar(payload);
      resultado = typeof r?.resultado === "string" ? r.resultado : null;
    } catch (e) {
      rejeitadoPorContrato = e?.detalheInterno?.status === 400;
      emitir("warn", "notificar_status_provider.falhou", { providerMessageId: evt.providerMessageId, status: evt.status, tentativa, erro: e?.message });
    }
    if (rejeitadoPorContrato && vinculado) {
      // O backend recusou o v2 (backend ainda antigo ou contrato divergente): NÃO perde o receipt — reenvia UMA vez como v1 (só alcança a org da conexão: fail-closed).
      emitir("warn", "provider_receipt_v2_recusado_reenviando_v1", { providerMessageId: evt.providerMessageId, status: evt.status });
      return entregar({ ...evt, correlationId: null }, tentativa);
    }
    if (rejeitadoPorContrato) { cont.rejeitados += 1; emitir("warn", "provider_receipt_rejeitado_contrato", { providerMessageId: evt.providerMessageId, status: evt.status }); return; }
    if (resultado !== null && RESULTADOS_CONCLUIDOS.has(resultado)) {
      cont.persistidos += 1;
      emitir("info", "provider_receipt_persistido", { providerMessageId: evt.providerMessageId, status: evt.status, resultado, tentativa, ...ctx() });
      return;
    }
    if (resultado === "ESTADO_NAO_ELEGIVEL" || resultado === "AMBIGUA") {
      emitir("warn", "provider_receipt_nao_aplicado", { providerMessageId: evt.providerMessageId, status: evt.status, resultado });
      return;
    }
    // NAO_ENCONTRADA (o backend ainda não gravou o providerMessageId — o receipt pode ganhar da finalização do envio) ou falha de transporte:
    // retry LIMITADO (em memória; se o processo reiniciar, o registro histórico continua sendo SENT).
    if (tentativa < atrasosRetryMs.length) { agendarRetry(() => { entregar(evt, tentativa + 1).catch(() => {}); }, atrasosRetryMs[tentativa]); return; }
    cont.esgotados += 1;
    // Esgotou SEM o backend conhecer o id (ou com falha de transporte): libera a chave de dedupe — um reenvio legítimo do MESMO recibo (mesmo id+status),
    // quando o backend já souber o id, deve tentar de novo e não ser engolido como "duplicado" até o processo reiniciar. (400 de contrato e estados
    // não elegíveis/ambíguos são determinísticos: a chave continua presa de propósito.)
    vistos.delete(chaveDe(evt));
    emitir("warn", "provider_receipt_entrega_esgotada", { providerMessageId: evt.providerMessageId, status: evt.status, ultimoResultado: resultado ?? "falha_de_transporte", tentativas: tentativa + 1 });
  }

  /** ponto único: rastreio, dedupe, log `provider_receipt_received`, entrega. */
  function processar({ providerMessageId, status, ackTipo, fonte, erro = null, ocorridoEmMs = null, remoteJid = null }) {
    cont.recebidos += 1;
    const r = rastreio(providerMessageId);
    if (!r) { contarNaoRastreado(); return false; }
    const erroCod = status === "PROVIDER_ERROR" ? codigoErro(erro) : null;
    const chave = chaveDe({ providerMessageId, status, erroCodigo: erroCod });
    if (vistos.has(chave)) { cont.duplicados += 1; return false; }
    vistos.add(chave);
    while (vistos.size > maxDedupe) vistos.delete(vistos.values().next().value);
    const t = agora();
    const ocorridoMs = Number.isFinite(ocorridoEmMs) && ocorridoEmMs > 0 && ocorridoEmMs <= t + 60_000 ? ocorridoEmMs : t;
    const evt = { providerMessageId, status, ackTipo, erroCodigo: erroCod, ocorridoEm: iso(ocorridoMs), correlationId: typeof r.correlationId === "string" && r.correlationId !== "" ? r.correlationId : null };
    emitir(status === "PROVIDER_ERROR" ? "warn" : "info", "provider_receipt_received", {
      providerMessageId, fonte, ackTipo, statusInterno: status, erroCodigo: erroCod, ocorridoEm: evt.ocorridoEm,
      remoteJidTipo: tipoDeJid(remoteJid), correlationId: r.correlationId, latenciaDesdeEnvioMs: Math.max(0, t - r.enviadoEmMs), ...ctx(),
    });
    entregar(evt, 0).catch(() => { /* já logado */ });
    return true;
  }

  return {
    rastrear,
    /** `socket.ev.on("messages.update")` — chat direto. */
    aoMessagesUpdate(updates) {
      for (const u of updates ?? []) {
        try {
          const id = u?.key?.id;
          const st = u?.update?.status;
          if (!id || st === undefined || st === null) continue;
          if (u.key.fromMe === false) continue;   // recibo de mensagem RECEBIDA (ex.: read-self de outro aparelho nosso) — não é sobre nós
          const cls = classificarStatusBaileys(st);
          if (!cls) continue;
          processar({ providerMessageId: id, ...cls, fonte: "messages.update", erro: cls.status === "PROVIDER_ERROR" ? u.update?.messageStubParameters?.[0] : null, remoteJid: u.key.remoteJid });
        } catch { /* observador nunca interfere */ }
      }
    },
    /** `socket.ev.on("message-receipt.update")` — grupo/status: `receipt.receiptTimestamp` = entrega, `readTimestamp` = leitura (segundos). */
    aoMessageReceiptUpdate(updates) {
      for (const u of updates ?? []) {
        try {
          const id = u?.key?.id;
          if (!id || u.key.fromMe === false) continue;
          const rc = u.receipt ?? {};
          const leitura = Number(rc.readTimestamp) > 0;
          const entrega = Number(rc.receiptTimestamp) > 0;
          if (!leitura && !entrega) continue;
          processar({ providerMessageId: id, status: leitura ? "READ" : "DELIVERED", ackTipo: leitura ? "leitura" : "entrega", fonte: "message-receipt.update",
            ocorridoEmMs: (leitura ? Number(rc.readTimestamp) : Number(rc.receiptTimestamp)) * 1000, remoteJid: u.key.remoteJid });
        } catch { /* observador nunca interfere */ }
      }
    },
    /** `socket.ws.on("CB:ack,class:message")` — o servidor aceitou (sem `error`) ou rejeitou (com `error`) o stanza que enviamos. Leitura pura. */
    aoAckWs(no) {
      try {
        const a = no?.attrs ?? {};
        if (!a.id) return;
        if (a.error) processar({ providerMessageId: a.id, status: "PROVIDER_ERROR", ackTipo: "ack_erro", fonte: "ws.ack", erro: a.error, remoteJid: a.from });
        else processar({ providerMessageId: a.id, status: "SERVER_ACK", ackTipo: "ack_servidor", fonte: "ws.ack", ocorridoEmMs: Number(a.t) > 0 ? Number(a.t) * 1000 : null, remoteJid: a.from });
      } catch { /* observador nunca interfere */ }
    },
    /** `socket.ws.on("CB:receipt")` — recibo cru, ANTES do Baileys e independente do buffer de eventos. Só ids que rastreamos; leitura pura (sem ack/flush). */
    aoReceiptWs(no) {
      try {
        const a = no?.attrs ?? {};
        const cls = classificarTipoReceipt(a.type);
        if (!cls || !a.id) return;
        const ids = [a.id];
        if (Array.isArray(no.content)) for (const c of no.content[0]?.content ?? []) if (c?.tag === "item" && c.attrs?.id) ids.push(c.attrs.id);
        for (const id of ids) processar({ providerMessageId: id, ...cls, fonte: "ws.receipt", ocorridoEmMs: Number(a.t) > 0 ? Number(a.t) * 1000 : null, remoteJid: a.from });
      } catch { /* observador nunca interfere */ }
    },
    metricas: () => ({ ...cont, rastreados: rastreados.size, retriesPendentes: timers.size }),
    encerrar() { for (const h of timers) cancelar(h); timers.clear(); },
  };
}
