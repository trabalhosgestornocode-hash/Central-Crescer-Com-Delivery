// Checkpoint C3.5-C.9.6 — OBSERVADOR da fila offline do Baileys: máquina de estados DIAGNÓSTICA + watchdog em modo OBSERVE.
//
// PERGUNTA QUE ESTE MÓDULO RESPONDE (e só ela): "se o failsafe futuro estivesse ativo, ele teria disparado aqui?".
//
// GARANTIA ESTRUTURAL DE NÃO INTERFERÊNCIA
//   Este módulo NÃO importa o Baileys e NÃO recebe o `ev`, o `ws` nem o socket. Ele só recebe:
//     - eventos observados (preview, nós, mensagens enfileiradas, flushes, marcador, fechamento), como dados;
//     - funções de LEITURA por geração de socket (`lerBufferAtivo`, `lerSocketAberto`);
//     - `emitir` (log estruturado) e `agendar/cancelar` (timer).
//   Ele não tem nenhum caminho para liberar buffer, encaminhar mensagem, pedir offline_batch ou enviar algo. Um teste estático
//   (test/offlineObserve.test.js) proíbe qualquer chamada a flush/buffer/emit/send/end neste arquivo.
//
// ESTADOS (só diagnóstico — nenhum deles altera o buffer nem o fluxo de mensagens)
//   CONNECTING                — socket novo, nada visto da fase offline
//   OFFLINE_LOADING           — 1º preview ou 1º nó offline visto (registra QUAL gatilho venceu)
//   OFFLINE_STALLED_OBSERVED  — o failsafe futuro TERIA disparado (sem progresso ≥ stallDetectionMs ou teto absoluto)
//   LIVE                      — só pelo marcador oficial (CB:ib,,offline)
//   CLOSED                    — o socket daquela geração fechou; timer cancelado; eventos posteriores ignorados
//
// TRANSIÇÕES
//   CONNECTING → OFFLINE_LOADING           preview | nó offline
//   OFFLINE_LOADING → LIVE                 marcador (também vale a partir de OFFLINE_STALLED_OBSERVED: "marcador tardio")
//   OFFLINE_LOADING → OFFLINE_STALLED_OBSERVED   watchdog (condição base + sem progresso | teto absoluto)
//   OFFLINE_STALLED_OBSERVED → OFFLINE_LOADING   houve PROGRESSO depois do stall ("retomada", só diagnóstico)
//   qualquer → CLOSED                      fechamento do socket daquela geração (ou surgimento de uma geração nova)
//
// EVENTOS: exatamente UM `inbound.offline_stalled_observed` por ENTRADA em OFFLINE_STALLED_OBSERVED (teto de
//   `maxEventosStallPorGeracao` por geração; depois só contadores). Uma retomada seguida de novo travamento é uma NOVA entrada.
//
// NUNCA registra JID, LID, telefone, participant, author, remoteJid, ID de mensagem, conteúdo, timestamp original ou payload:
// só inteiros, booleanos, buckets e vocabulário fechado.
//
// C.9.7 (ainda só diagnóstico)
//   - histograma SEGURO do valor bruto de attrs.offline (classificarValorOffline): inteiros de 0 a 99 saem exatos (por construção nenhum
//     identificador/timestamp/telefone/token cabe em 1-2 dígitos); qualquer outra coisa sai só como CLASSE fechada (nº de dígitos, texto
//     curto/longo...), nunca o valor. Cruzado com a idade da mensagem, por espécie.
//   - `identidade` (opcional, INJETADA — este arquivo continua sem imports): só recebe `novaGeracao(g)` e `comparar(g)` e devolve CONTAGENS.
//     O material bruto das stanzas NUNCA passa por aqui: o wiring o entrega direto ao módulo de identidade. Evento
//     `inbound.offline_overlap` (1 por geração; reemite no fechamento só se a contagem mudou; teto de 3 por geração).

export const FASE = Object.freeze({
  CONNECTING: "CONNECTING",
  OFFLINE_LOADING: "OFFLINE_LOADING",
  OFFLINE_STALLED_OBSERVED: "OFFLINE_STALLED_OBSERVED",
  LIVE: "LIVE",
  CLOSED: "CLOSED",
});

/**
 * Valores INICIAIS (experimentais) — ver docs. Base: nas 2 amostras de produção a rajada de ~100 nós terminou de ser processada em
 * T+6,3 s; 30 s ≈ 5× isso, > 20 s (espera de sync do próprio Baileys) e < 35 s (limite de keep-alive do Baileys).
 */
export const PADROES = Object.freeze({
  stallDetectionMs: 30_000,
  absoluteMaxOfflineMs: 180_000,
  tickMs: 1_000,
  heartbeatMs: 60_000,
  keepAliveLimiteMs: 35_000,
  marcos: Object.freeze([1, 100]),
  maxEventosStallPorGeracao: 5,
});

export const ESPECIES = Object.freeze(["message", "receipt", "notification"]);
export const CLASSES_ATRIBUTO_OFFLINE = Object.freeze(["missing", "empty", "zero", "one", "other"]);
export const BUCKETS_IDADE = Object.freeze(["lt1m", "m1a5", "m5a30", "m30a120", "h2a24", "gt24h", "ausente", "invalido"]);

// ---------------------------------------------------------------------------------------------------------------------
// classificações puras
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Bucket do valor BRUTO de `attrs.offline` (antes de qualquer coerção truthy): missing | empty | "0" | "1" | other.
 * Só o bucket sai; o valor de `other` nunca é registrado.
 */
export function classificarAtributoOffline(valor) {
  if (valor === undefined || valor === null) return "missing";
  const s = typeof valor === "string" ? valor : (typeof valor === "number" || typeof valor === "boolean") ? String(valor) : null;
  if (s === null) return "other";
  if (s === "") return "empty";
  if (s === "0") return "zero";
  if (s === "1") return "one";
  return "other";
}

/**
 * Bucket de idade aproximada de uma mensagem no momento da ingestão, a partir do `t` da stanza (segundos desde a época).
 * É MÉTRICA, nunca decisão. O `t` original nunca é registrado. Relógios levemente adiantados (até 2 min) contam como < 1 min.
 */
export function bucketIdade(tBruto, agoraMs) {
  if (tBruto === undefined || tBruto === null || tBruto === "") return "ausente";
  const s = String(tBruto);
  if (!/^\d{1,12}$/.test(s)) return "invalido";
  const idadeMs = agoraMs - Number(s) * 1000;
  if (!Number.isFinite(idadeMs) || idadeMs < -120_000) return "invalido";
  const min = idadeMs / 60_000;
  if (min < 1) return "lt1m";
  if (min < 5) return "m1a5";
  if (min < 30) return "m5a30";
  if (min < 120) return "m30a120";
  if (min < 1440) return "h2a24";
  return "gt24h";
}

/** classes FECHADAS do valor bruto de attrs.offline quando ele NÃO é um inteiro canônico de 0 a 99 (o valor nunca sai) */
export const CLASSES_VALOR_OFFLINE = Object.freeze(["ausente", "vazio", "tipo_nao_string", "int_nao_canonico", "int_3dig", "int_4dig", "int_5_6dig", "int_7_9dig", "int_10mais_dig", "negativo", "decimal", "texto_curto", "texto_longo"]);

/**
 * Classificação SEGURA do valor BRUTO de `attrs.offline` para o histograma. Devolve `{tipo:"int", valor:0..99}` ou `{tipo:"classe", nome}`.
 * Por que 0-99 é seguro POR CONSTRUÇÃO (sem depender da semântica do protocolo, que o Baileys 6.7.24 não interpreta): o valor só é
 * emitido se for um inteiro canônico de 1-2 dígitos; um identificador, telefone, timestamp, ID ou token tem muito mais informação que isso,
 * e mesmo se o servidor usasse esse campo como identificador, <= 100 valores possíveis, agregados em CONTAGEM (nunca por nó), não
 * identificam nada. Todo o resto vira uma classe pela ESTRUTURA (nº de dígitos, sinal, decimal, comprimento de texto), sem nenhum caractere do valor.
 */
export function classificarValorOffline(valor) {
  if (valor === undefined || valor === null) return { tipo: "classe", nome: "ausente" };
  const s = typeof valor === "string" ? valor : (typeof valor === "number" || typeof valor === "boolean") ? String(valor) : null;
  if (s === null) return { tipo: "classe", nome: "tipo_nao_string" };
  if (s === "") return { tipo: "classe", nome: "vazio" };
  if (/^(0|[1-9][0-9]?)$/.test(s)) return { tipo: "int", valor: Number(s) };
  if (/^[0-9]+$/.test(s)) {
    const n = s.length;
    return { tipo: "classe", nome: n <= 2 ? "int_nao_canonico" : n === 3 ? "int_3dig" : n === 4 ? "int_4dig" : n <= 6 ? "int_5_6dig" : n <= 9 ? "int_7_9dig" : "int_10mais_dig" };
  }
  if (/^-[0-9]+$/.test(s)) return { tipo: "classe", nome: "negativo" };
  if (/^-?[0-9]*\.[0-9]+$/.test(s)) return { tipo: "classe", nome: "decimal" };
  return { tipo: "classe", nome: s.length <= 8 ? "texto_curto" : "texto_longo" };
}

const MAX_BINS_VALOR = 24;            // bins distintos por espécie e por geração; o excedente só é CONTADO (binsOmitidos)
const MAX_EMISSOES_OVERLAP = 3;       // inbound.offline_overlap por geração
const MAX_GERACOES_HISTORICO = 6;     // resumos de gerações anteriores (preview + idade) para o evento de sobreposição
const PREVIEW_NOMES = Object.freeze(["count", "message", "receipt", "notification", "call", "status", "appdata"]);
const rotuloBin = (b) => (b.tipo === "int" ? `i:${b.valor}` : `c:${b.nome}`);
/** grupo grosso de idade para o cruzamento valor × idade (só mensagens) */
const grupoIdade = (bucket) => (bucket === "h2a24" ? "h2a24" : bucket === "gt24h" ? "gt24h" : bucket === "ausente" || bucket === "invalido" ? "sem" : "lt2h");

const NOME_ATRIBUTO = /^[a-z][a-z0-9_-]{0,23}$/;
const MAX_ATRIBUTOS_PREVIEW = 12;
/** vocabulário FECHADO e inicial de valores não numéricos que não podem carregar identificador; ampliar só com evidência. */
export const ENUM_SEGURO = Object.freeze(new Set(["all", "none", "recent", "full", "delta", "online", "offline", "available", "unavailable"]));

/**
 * Sanitização EXPLÍCITA dos atributos do nó `ib > offline_preview`. O Baileys 6.7.24 não interpreta esses atributos (só faz
 * log do nó), então os nomes reais são desconhecidos: a regra é agnóstica de esquema.
 *   - nome fora do padrão de token de protocolo (`^[a-z][a-z0-9_-]{0,23}$`) ⇒ nem o nome sai (só conta em `atributosIgnorados`);
 *   - valor inteiro de até 7 dígitos ⇒ `numerico`; "true"/"false" ⇒ `booleano`; vocabulário fechado ⇒ `enum`;
 *   - parece identificador/telefone/timestamp/token (contém @, :, /, =, ≥8 dígitos, ≥16 caracteres base64-like) ⇒ `sensivel`
 *     (o VALOR não sai);
 *   - qualquer outro ⇒ `desconhecido` (só o tamanho sai, limitado a 64).
 * @param {any} no o nó `ib` inteiro (ou qualquer lixo: nunca lança)
 */
export function sanitizarAtributosPreview(no) {
  const saida = { atributos: [], atributosIgnorados: 0, filhos: 0, atributosNoIb: 0 };
  try {
    if (!no || typeof no !== "object") return saida;
    saida.atributosNoIb = no.attrs && typeof no.attrs === "object" ? Object.keys(no.attrs).length : 0;
    const filhos = Array.isArray(no.content) ? no.content : [];
    const preview = filhos.find((c) => c && typeof c === "object" && c.tag === "offline_preview");
    if (!preview) return saida;
    saida.filhos = Array.isArray(preview.content) ? preview.content.length : 0;
    const attrs = preview.attrs && typeof preview.attrs === "object" ? preview.attrs : {};
    for (const [nome, valor] of Object.entries(attrs)) {
      if (saida.atributos.length >= MAX_ATRIBUTOS_PREVIEW || !NOME_ATRIBUTO.test(nome)) { saida.atributosIgnorados++; continue; }
      const s = typeof valor === "string" ? valor : (typeof valor === "number" || typeof valor === "boolean") ? String(valor) : null;
      if (s === null) { saida.atributos.push({ nome, classe: "desconhecido", tamanho: 0 }); continue; }
      if (/^\d{1,7}$/.test(s)) saida.atributos.push({ nome, classe: "numerico", valor: Number(s) });
      else if (s === "true" || s === "false") saida.atributos.push({ nome, classe: "booleano", valor: s === "true" });
      else if (ENUM_SEGURO.has(s)) saida.atributos.push({ nome, classe: "enum", valor: s });
      else if (/[@:/=]|\d{8,}|[A-Za-z0-9+_-]{16,}/.test(s)) saida.atributos.push({ nome, classe: "sensivel" });
      else saida.atributos.push({ nome, classe: "desconhecido", tamanho: Math.min(s.length, 64) });
    }
  } catch { /* sanitização nunca lança */ }
  return saida;
}

/** o `tipo` agregado é SEMPRE um nome do vocabulário de tipos de JID (direct_pn, group, ...), nunca um JID: qualquer outra coisa vira "unknown" */
const TIPO_SEGURO = /^[a-z][a-z_]{0,23}$/;
const MAX_TIPOS_DISTINTOS = 16;

const contadoresZerados = () => ({ missing: 0, empty: 0, zero: 0, one: 0, other: 0 });
const bucketsZerados = () => Object.fromEntries(BUCKETS_IDADE.map((b) => [b, 0]));
/** objeto → lista [{k, ...}] (listas evitam que o logsafe mascare chaves e mantêm o esquema fechado) */
const lista = (obj) => Object.entries(obj).map(([nome, n]) => ({ nome, n }));

// ---------------------------------------------------------------------------------------------------------------------
// observador
// ---------------------------------------------------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {() => number} [deps.agora]
 * @param {(nivel: string, evento: string, dados?: object) => void} deps.emitir
 * @param {() => (number|null)} [deps.obterEpoch] epoch da lease (técnico); null se desconhecido
 * @param {(fn: () => void, ms: number) => any} [deps.agendar] setInterval injetável
 * @param {(h: any) => void} [deps.cancelar] clearInterval injetável
 * @param {() => boolean} [deps.lerRecoveryUsado] Checkpoint G.3.0 — leitor OPCIONAL e só-leitura do motor de recovery
 *   (nunca uma referência ao motor em si: preserva a garantia estrutural de não-interferência do cabeçalho acima).
 *   Sem ele (padrão), `RECOVERY_PATH_USED` continua `false` sempre — o comportamento de antes deste checkpoint,
 *   correto quando não há motor de recovery nenhum. Quando injetado (só pelo wiring, com o motor já construído),
 *   deve refletir `estado().status !== "IDLE"` da GERAÇÃO ATUAL do motor — ou seja, só vira `true` depois que o
 *   motor de fato pediu o 1º batch adicional (nunca antes: nem por estar habilitado, nem pelo stall sozinho, nem
 *   se o auth headroom bloqueou a entrada), e volta a `false` sozinho numa geração nova (o motor também reseta
 *   `estado()` em `novaGeracao()` — nenhum estado global aqui, só a leitura de outro objeto por geração).
 */
export function criarObservadorOffline({
  agora = () => Date.now(),
  emitir,
  obterEpoch = () => null,
  agendar = setInterval,
  cancelar = clearInterval,
  stallDetectionMs = PADROES.stallDetectionMs,
  absoluteMaxOfflineMs = PADROES.absoluteMaxOfflineMs,
  tickMs = PADROES.tickMs,
  heartbeatMs = PADROES.heartbeatMs,
  keepAliveLimiteMs = PADROES.keepAliveLimiteMs,
  marcos = PADROES.marcos,
  maxEventosStallPorGeracao = PADROES.maxEventosStallPorGeracao,
  identidade = undefined,
  lerRecoveryUsado = () => false,
} = {}) {
  if (!(stallDetectionMs > 0)) throw new RangeError("stallDetectionMs deve ser > 0");
  if (!(absoluteMaxOfflineMs > stallDetectionMs)) throw new RangeError("absoluteMaxOfflineMs deve ser > stallDetectionMs");
  if (!(stallDetectionMs < keepAliveLimiteMs)) throw new RangeError("stallDetectionMs deve ficar ABAIXO do limite de keep-alive do Baileys");
  if (!(tickMs > 0) || !(heartbeatMs > 0)) throw new RangeError("tickMs e heartbeatMs devem ser > 0");

  let geracao = 0;
  /** @type {any} */
  let s = null;
  const totais = { geracoes: 0, stallEventos: 0, retidasPerdidas: 0, heartbeats: 0, overlapEventos: 0 };
  /** resumo (preview numérico + idade offline) das últimas gerações FECHADAS, só para rotular o evento de sobreposição */
  const historicoGeracoes = [];

  const logar = (evento, dados) => { try { emitir("info", evento, dados); } catch { /* observabilidade nunca interfere */ } };
  const epoch = () => { try { const e = obterEpoch(); return Number.isFinite(e) ? e : null; } catch { return null; } };
  const lerBool = (f) => { try { return f() === true; } catch { return false; } };
  const seg = (ms) => Math.max(0, Math.round(ms / 1000));

  function novoEstado(g, t, leitores) {
    return {
      g, aberturaEm: t, fase: FASE.CONNECTING, gatilho: null,
      inicioOfflineEm: null, previewEm: null, ultimoProgressoEm: null, ultimaAtividadeEm: t, ultimoHeartbeatEm: null,
      previews: 0, batchesInferidos: 0, nosOffline: 0, nosVivos: 0, upserts: 0, retidas: 0,
      fim: false, fimEm: null, fimContagem: null,
      flushes: 0, flushesEfetivos: 0, flushesSemMarcador: 0, avisouFlushSemMarcador: false,
      stallEntradas: 0, stallEventos: 0, retomadas: 0, stallDesdeEm: null, ticksAdiadosPorSaude: 0,
      marcosEmitidos: new Set(),
      porEspecie: { message: 0, receipt: 0, notification: 0 }, porTipo: {},
      attrOffline: { message: contadoresZerados(), receipt: contadoresZerados(), notification: contadoresZerados() },
      idade: { offline: bucketsZerados(), vivo: bucketsZerados() },
      valores: { message: new Map(), receipt: new Map(), notification: new Map() }, valoresOmitidos: { message: 0, receipt: 0, notification: 0 },
      previewNumerico: null, overlapEmitidos: 0, ultimoOverlapCount: null,
      timer: null, lerBufferAtivo: leitores.lerBufferAtivo ?? (() => false), lerSocketAberto: leitores.lerSocketAberto ?? (() => false),
    };
  }

  /** só devolve o estado se o token é o da geração ATUAL e ela ainda não fechou */
  const ativo = (g) => (s && s.g === g && s.fase !== FASE.CLOSED ? s : null);

  function pararTimer(x) { if (x?.timer) { try { cancelar(x.timer); } catch { /* idem */ } x.timer = null; } }
  function iniciarTimer(x) {
    if (x.timer) return;
    try { x.timer = agendar(() => { try { tick(x.g); } catch { /* idem */ } }, tickMs); x.timer?.unref?.(); } catch { x.timer = null; }
  }

  /** histograma do valor BRUTO de attrs.offline (só inteiros 0-99 ou CLASSES fechadas), por espécie; message também cruza com a idade */
  function registrarValor(x, esp, valorBruto, bIdade) {
    const c = classificarValorOffline(valorBruto);
    const mapa = x.valores[esp]; const rot = rotuloBin(c);
    let b = mapa.get(rot);
    if (!b) {
      if (mapa.size >= MAX_BINS_VALOR) { x.valoresOmitidos[esp] += 1; return; }
      b = { ...c, n: 0, ...(esp === "message" ? { idade: { lt2h: 0, h2a24: 0, gt24h: 0, sem: 0 } } : {}) };
      mapa.set(rot, b);
    }
    b.n += 1;
    if (b.idade && bIdade !== null) b.idade[grupoIdade(bIdade)] += 1;
  }

  function entrarCarregando(x, gatilho) {
    if (x.fase !== FASE.CONNECTING) return;
    x.fase = FASE.OFFLINE_LOADING; x.gatilho = gatilho; x.inicioOfflineEm = agora(); x.ultimoProgressoEm = x.inicioOfflineEm; x.ultimoHeartbeatEm = x.inicioOfflineEm;
    iniciarTimer(x);
  }

  /** progresso = preview, nó offline, mensagem enfileirada, batch (inferido), flush efetivo, marcador. Reinicia o relógio de silêncio. */
  function progresso(x) {
    const t = agora();
    x.ultimoProgressoEm = t;
    if (x.fase === FASE.OFFLINE_STALLED_OBSERVED) {
      x.fase = FASE.OFFLINE_LOADING; x.retomadas += 1; x.stallDesdeEm = null;
      if (x.retomadas <= maxEventosStallPorGeracao) emitirEstado(x, "retomada");
    }
  }

  function socketSaudavel(x, t) {
    return x.fase !== FASE.CLOSED && lerBool(x.lerSocketAberto) && (t - x.ultimaAtividadeEm) < keepAliveLimiteMs;
  }

  /** decisão pura do watchdog (sem efeitos): serve ao tick e ao `observeWouldRecover` do heartbeat */
  function avaliar(x, t) {
    const semProgressoMs = t - (x.ultimoProgressoEm ?? t);
    const desdeInicioMs = t - (x.inicioOfflineEm ?? t);
    const bufferAtivo = lerBool(x.lerBufferAtivo);
    const saudavel = socketSaudavel(x, t);
    const base = x.fase === FASE.OFFLINE_LOADING && bufferAtivo && !x.fim && x.retidas > 0 && saudavel;
    const motivo = semProgressoMs >= stallDetectionMs ? "no_progress" : desdeInicioMs >= absoluteMaxOfflineMs ? "absolute_max" : null;
    return { base, motivo, bufferAtivo, saudavel, semProgressoMs, desdeInicioMs };
  }

  function baseEvento(x) { return { socketGeneration: x.g, epoch: epoch() }; }

  /** bins do histograma de valores de attrs.offline de uma espécie: só inteiros 0-99 (exatos) ou CLASSES fechadas, com n (e a idade, p/ message) */
  const binsDe = (mapa) => [...mapa.values()]
    .sort((a, b) => b.n - a.n || (rotuloBin(a) < rotuloBin(b) ? -1 : 1))
    .map((b) => ({ ...(b.tipo === "int" ? { tipo: "int", valor: b.valor } : { tipo: "classe", nome: b.nome }), n: b.n, ...(b.idade ? { idade: lista(b.idade) } : {}) }));

  function agregados(x) {
    return {
      especies: lista(x.porEspecie),
      tiposAgregados: lista(x.porTipo).sort((a, b) => (a.nome < b.nome ? -1 : 1)),
      attrOffline: ESPECIES.map((e) => ({ especie: e, ...x.attrOffline[e] })),
      attrOfflineValores: ESPECIES.map((e) => ({ especie: e, bins: binsDe(x.valores[e]), binsOmitidos: x.valoresOmitidos[e] })),
      idade: ["offline", "vivo"].map((o) => ({ origem: o, buckets: lista(x.idade[o]) })),
    };
  }

  const previewLista = (p) => (p ? PREVIEW_NOMES.filter((k) => Object.hasOwn(p, k)).map((k) => ({ nome: k, valor: p[k] })) : null);

  /**
   * (C.9.7) Sobreposição desta geração com a anterior — SÓ contagens. O módulo de identidade é injetado e devolve apenas números.
   * 1 evento por geração no 1º gatilho (stall | marcador | fechamento); reemite só se a contagem mudou, até o teto.
   */
  function emitirSobreposicao(x, gatilho) {
    if (!identidade || x.overlapEmitidos >= MAX_EMISSOES_OVERLAP) return;
    let r = null; try { r = identidade.comparar(x.g); } catch { r = null; }
    if (!r || !(r.currentCount > 0)) return;
    if (x.overlapEmitidos > 0 && x.ultimoOverlapCount === r.currentCount) return;
    x.overlapEmitidos += 1; x.ultimoOverlapCount = r.currentCount; totais.overlapEventos += 1;
    const ant = r.previousGeneration == null ? null : (historicoGeracoes.find((h) => h.g === r.previousGeneration) ?? null);
    const atual = x.previewNumerico; const anterior = ant?.previewNumerico ?? null;
    logar("inbound.offline_overlap", {
      ...baseEvento(x), gatilho, ...r,
      previewAtual: previewLista(atual), previewAnterior: previewLista(anterior),
      previewCountDelta: Number.isFinite(atual?.count) && Number.isFinite(anterior?.count) ? atual.count - anterior.count : null,
      idadeOffline: lista(x.idade.offline), idadeOfflineAnterior: ant ? lista(ant.idadeOffline) : null,
      RECOVERY_PATH_USED: lerBool(lerRecoveryUsado), observeOnly: true,
    });
  }

  function emitirEstado(x, gatilho, extra = {}) {
    const t = agora();
    const a = avaliar(x, t);
    const observeWouldRecover = x.fase === FASE.OFFLINE_STALLED_OBSERVED || Boolean(a.base && a.motivo);
    const dados = {
      ...baseEvento(x), gatilho, fase: x.fase,
      segundosDesdeAbertura: seg(t - x.aberturaEm),
      segundosDesdeInicioOffline: x.inicioOfflineEm == null ? null : seg(t - x.inicioOfflineEm),
      segundosDesdeProgresso: x.ultimoProgressoEm == null ? null : seg(t - x.ultimoProgressoEm),
      mensagensRetidas: x.retidas, nosOfflineVistos: x.nosOffline, nosVivosVistos: x.nosVivos,
      offlinePreviewRecebido: x.previews, offlineFimRecebido: x.fim, bufferAtivo: lerBool(x.lerBufferAtivo), socketHealthy: socketSaudavel(x, t),
      observeWouldRecover, stallEntradas: x.stallEntradas, retomadas: x.retomadas,
      flushes: x.flushes, flushesEfetivos: x.flushesEfetivos, flushesSemMarcador: x.flushesSemMarcador,
      RECOVERY_PATH_USED: lerBool(lerRecoveryUsado), observeOnly: true,
      ...extra,
    };
    if (gatilho !== "heartbeat") Object.assign(dados, agregados(x));
    logar("inbound.offline_state", dados);
  }

  function entrarStall(x, t, a) {
    x.fase = FASE.OFFLINE_STALLED_OBSERVED; x.stallEntradas += 1; x.stallDesdeEm = t;
    if (x.stallEventos < maxEventosStallPorGeracao) {
      x.stallEventos += 1; totais.stallEventos += 1;
      logar("inbound.offline_stalled_observed", {
        ...baseEvento(x),
        stallReason: a.motivo,
        secondsSinceProgress: seg(a.semProgressoMs), secondsSinceOfflineStart: seg(a.desdeInicioMs),
        bufferAtivo: a.bufferAtivo, mensagensRetidas: x.retidas,
        offlinePreviewRecebido: x.previews, offlineFimRecebido: x.fim,
        nosOfflineVistos: x.nosOffline, nosVivosVistos: x.nosVivos,
        socketHealthy: a.saudavel, entrada: x.stallEntradas,
        limiteSemProgressoSegundos: seg(stallDetectionMs), limiteAbsolutoSegundos: seg(absoluteMaxOfflineMs),
        RECOVERY_PATH_USED: lerBool(lerRecoveryUsado), observeOnly: true,
        ...agregados(x),
      });
    }
    emitirSobreposicao(x, "stall");
  }

  /** fecha a geração `g` (idempotente): se estava presa, conta e emite as retidas que morrem com o buffer dela */
  function fechar(g) {
    const x = s && s.g === g ? s : null;
    if (!x || x.fase === FASE.CLOSED) return;
    const presa = x.fase === FASE.OFFLINE_LOADING || x.fase === FASE.OFFLINE_STALLED_OBSERVED;
    if (presa) {
      totais.retidasPerdidas += x.retidas;
      emitirEstado(x, "fechamento", { retidasPerdidas: x.retidas });
    }
    emitirSobreposicao(x, "fechamento");
    historicoGeracoes.push({ g: x.g, previewNumerico: x.previewNumerico, idadeOffline: { ...x.idade.offline } });
    while (historicoGeracoes.length > MAX_GERACOES_HISTORICO) historicoGeracoes.shift();
    x.fase = FASE.CLOSED; pararTimer(x);
  }

  function tick(g) {
    const x = ativo(g); if (!x) return;
    const t = agora();
    if (x.fase === FASE.OFFLINE_LOADING) {
      const a = avaliar(x, t);
      if (a.motivo && !a.saudavel && x.retidas > 0 && a.bufferAtivo && !x.fim) x.ticksAdiadosPorSaude += 1;   // teria disparado, mas o socket não está saudável
      if (a.base && a.motivo) entrarStall(x, t, a);
    }
    if ((x.fase === FASE.OFFLINE_LOADING || x.fase === FASE.OFFLINE_STALLED_OBSERVED) && x.ultimoHeartbeatEm != null && t - x.ultimoHeartbeatEm >= heartbeatMs) {
      x.ultimoHeartbeatEm = t; totais.heartbeats += 1;
      emitirEstado(x, "heartbeat");
    }
  }

  return {
    /**
     * Novo socket (nova conexão): a geração anterior vira CLOSED (timer cancelado; se estava presa, conta as retidas que morrem
     * com o buffer dela). Devolve o token inteiro e incremental que TODA chamada seguinte deve apresentar.
     * @param {{lerBufferAtivo?: () => boolean, lerSocketAberto?: () => boolean}} [leitores]
     */
    novaGeracao(leitores = {}) {
      if (s) fechar(s.g);
      geracao += 1; totais.geracoes += 1;
      s = novoEstado(geracao, agora(), leitores);
      try { identidade?.novaGeracao(geracao); } catch { /* identidade nunca interfere */ }   // DEPOIS de fechar a anterior (o fechamento ainda compara)
      return geracao;
    },
    /** qualquer frame/nó recebido: prova de que o socket está vivo (não é progresso da fila offline) */
    aoAtividade(g) { const x = ativo(g); if (x) x.ultimaAtividadeEm = agora(); },

    aoPreview(g, no) {
      const x = ativo(g); if (!x) return;
      x.ultimaAtividadeEm = agora();
      entrarCarregando(x, "preview");
      x.previews += 1; x.batchesInferidos += 1;              // o Baileys 6.7.24 responde a CADA preview com UM offline_batch count=100 (canário)
      if (x.previewEm == null) x.previewEm = agora();
      const san = sanitizarAtributosPreview(no);
      if (x.previewNumerico == null) {                        // só o 1º preview da geração: os números (count/message/...) para comparar entre conexões
        x.previewNumerico = {};
        for (const a of san.atributos) if (a.classe === "numerico" && PREVIEW_NOMES.includes(a.nome)) x.previewNumerico[a.nome] = a.valor;
      }
      if (x.fase !== FASE.CLOSED) progresso(x);
      logar("inbound.offline_preview", { ...baseEvento(x), sinceSocketMs: agora() - x.aberturaEm, ordem: x.previews, fase: x.fase, ...san });
    },

    /**
     * Um nó message/receipt/notification chegou. Recebe o valor BRUTO de attrs.offline e o `t` bruto: a classificação acontece
     * ANTES de qualquer coerção truthy; o Baileys decide sozinho (o observador nunca altera a decisão).
     * @param {{especie: 'message'|'receipt'|'notification', tipo: string, offlineAttr: any, t?: any}} n
     */
    aoNo(g, { especie, tipo, offlineAttr, t }) {
      const x = ativo(g); if (!x) return;
      const agoraMs = agora();
      x.ultimaAtividadeEm = agoraMs;
      const esp = ESPECIES.includes(especie) ? especie : "message";
      x.attrOffline[esp][classificarAtributoOffline(offlineAttr)] += 1;
      x.porEspecie[esp] += 1;
      let tipoSeg = typeof tipo === "string" && TIPO_SEGURO.test(tipo) ? tipo : "unknown";
      if (!(tipoSeg in x.porTipo) && Object.keys(x.porTipo).length >= MAX_TIPOS_DISTINTOS) tipoSeg = "unknown";
      x.porTipo[tipoSeg] = (x.porTipo[tipoSeg] ?? 0) + 1;
      const offline = Boolean(offlineAttr);                   // MESMA regra do Baileys (`!!node.attrs.offline`): só para contar, nunca para decidir
      const bIdade = esp === "message" ? bucketIdade(t, agoraMs) : null;
      if (bIdade !== null) x.idade[offline ? "offline" : "vivo"][bIdade] += 1;
      registrarValor(x, esp, offlineAttr, bIdade);
      if (!offline) { x.nosVivos += 1; return; }
      entrarCarregando(x, "no_offline");
      x.nosOffline += 1;
      progresso(x);
      if (marcos.includes(x.nosOffline) && !x.marcosEmitidos.has(x.nosOffline)) {
        x.marcosEmitidos.add(x.nosOffline);
        logar("inbound.offline_node_progress", {
          ...baseEvento(x), milestone: x.nosOffline, offlineNodes: x.nosOffline,
          sinceSocketMs: agoraMs - x.aberturaEm, sincePreviewMs: x.previewEm == null ? null : agoraMs - x.previewEm,
          fase: x.fase, ...agregados(x),
        });
      }
    },

    /** um messages.upsert foi emitido no `ev` (decifrado e, se `bufferando`, RETIDO no buffer do socket) */
    aoUpsert(g, bufferando) {
      const x = ativo(g); if (!x) return;
      x.upserts += 1;
      if (bufferando) x.retidas += 1;
      if (x.fase !== FASE.CONNECTING) progresso(x);
    },

    /** ev.flush() foi chamado (por quem quer que seja: marcador, nó vivo...). `efetivo` = havia buffer para liberar. */
    aoFlush(g, efetivo) {
      const x = ativo(g); if (!x) return;
      x.flushes += 1;
      if (!efetivo) return;
      x.flushesEfetivos += 1; x.retidas = 0;
      if (!x.fim && (x.fase === FASE.OFFLINE_LOADING || x.fase === FASE.OFFLINE_STALLED_OBSERVED)) {
        x.flushesSemMarcador += 1;                             // flush oficial SEM marcador ⇒ (history-sync off no Gateway) foi um nó VIVO processado pelo Baileys
        if (!x.avisouFlushSemMarcador) { x.avisouFlushSemMarcador = true; progresso(x); emitirEstado(x, "flush_sem_marcador"); return; }
      }
      if (x.fase !== FASE.CONNECTING) progresso(x);
    },

    /** rodar ANTES do handler do Baileys (ws.prependListener): assim `retidasAntesDoFlush` é o que o flush oficial vai liberar */
    aoMarcador(g, contagem) {
      const x = ativo(g); if (!x) return;
      const t = agora();
      x.ultimaAtividadeEm = t;
      const tardio = x.fase === FASE.OFFLINE_STALLED_OBSERVED;
      if (x.fase === FASE.CONNECTING) entrarCarregando(x, "marcador");
      const retidasAntes = x.retidas;
      x.fim = true; x.fimEm = t; x.fimContagem = Number.isFinite(contagem) ? contagem : null; x.ultimoProgressoEm = t;
      x.fase = FASE.LIVE; pararTimer(x);
      emitirEstado(x, "marcador", { marcadorTardio: tardio, retidasAntesDoFlush: retidasAntes, offlineFimContagem: x.fimContagem });
      emitirSobreposicao(x, "marcador");
    },

    /** o socket dessa geração fechou */
    aoFechado(g) { fechar(g); },

    /** um tick do relógio (o timer interno chama isto; testes chamam direto) */
    tick,

    /** cópia SÓ com números/booleanos/vocabulário fechado da geração atual */
    estado() {
      if (!s) return null;
      const t = agora();
      const a = avaliar(s, t);
      return {
        socketGeneration: s.g, fase: s.fase, gatilho: s.gatilho, previews: s.previews, batchesInferidos: s.batchesInferidos,
        nosOffline: s.nosOffline, nosVivos: s.nosVivos, upserts: s.upserts, retidas: s.retidas,
        fim: s.fim, flushes: s.flushes, flushesEfetivos: s.flushesEfetivos, flushesSemMarcador: s.flushesSemMarcador,
        stallEntradas: s.stallEntradas, stallEventos: s.stallEventos, retomadas: s.retomadas, ticksAdiadosPorSaude: s.ticksAdiadosPorSaude,
        segundosDesdeProgresso: s.ultimoProgressoEm == null ? null : seg(t - s.ultimoProgressoEm),
        offlineLastProgressAt: s.ultimoProgressoEm,
        socketHealthy: a.saudavel, observeWouldRecover: s.fase === FASE.OFFLINE_STALLED_OBSERVED || Boolean(a.base && a.motivo),
        attrOffline: JSON.parse(JSON.stringify(s.attrOffline)), attrOfflineValores: agregados(s).attrOfflineValores, idade: JSON.parse(JSON.stringify(s.idade)),
        overlapEmitidos: s.overlapEmitidos, previewNumerico: s.previewNumerico ? { ...s.previewNumerico } : null,
        porEspecie: { ...s.porEspecie }, porTipo: { ...s.porTipo },
      };
    },
    metricas: () => ({ ...totais }),
    /** encerra o timer da geração atual (parada do processo) */
    parar() { pararTimer(s); },
  };
}
