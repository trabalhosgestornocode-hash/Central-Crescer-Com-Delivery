// Checklist Operacional — CÁLCULO (funções puras: linhas de `ifood_pedidos` → resumo do dia).
//
// Sem banco, sem rede, sem relógio implícito: tudo recebe `agoraMs`. O service lê as linhas do tenant e
// chama `montarResumo`; os testes chamam direto com linhas fixas.
//
// FONTE: somente o estado oficial que o Events já persistiu em `ifood_pedidos` (carimbos = `createdAt` dos
// eventos oficiais do iFood). Nunca o Parser Food Delivery, nunca dado D-1, nunca estimativa.
//
// DEFINIÇÕES (Checkpoint 0 — nunca somar trechos para obter a vida):
//   preparo  confirmação (CFM) → pronto (RTP)                    EXATO
//            confirmação (CFM) → saída (DSP), sem RTP            APROXIMADO (inclui a espera do entregador)
//   entrega  saída (DSP) → conclusão (CON), só order_type DELIVERY
//            APROXIMADO por definição: CON ainda não foi validado em produção como "entregue ao cliente"
//            (pode ser emitido depois da entrega). Separado por modalidade (delivery_by IFOOD × MERCHANT).
//   vida     recebimento (PLC; sem PLC, o createdAt do pedido) → conclusão (CON)   EXATO
//
// DIA OPERACIONAL: no fuso do negócio, de VIRADA_HORA até VIRADA_HORA do dia seguinte. Padrão = DIA CIVIL
// (00:00), a mesma convenção já usada pelo projeto (hojeIsoBrasil no Dashboard iFood). Uma virada diferente
// (ex.: 04:00 para lojas que fecham depois da meia-noite) é DECISÃO DE NEGÓCIO PENDENTE — o parâmetro existe,
// mas nenhum valor fora do padrão é usado sem aprovação. O pedido pertence ao dia em que foi RECEBIDO: um
// CON atrasado de ontem nunca entra na média de hoje. Pedido em andamento é decidido por TEMPO, não por dia.
//
// ELEGIBILIDADE por indicador (pedidos de teste ficam fora de tudo; cancelados, de todas as médias):
//   preparo  agendado FORA — a confirmação de um agendado acontece horas antes do preparo começar
//   entrega  agendado DENTRO — saída → conclusão não depende do agendamento
//   vida     agendado FORA — o recebimento antecede o horário agendado
// Duração negativa, zero ou acima do teto é descartada e CONTADA (`descartados`) — nunca corrigida.
//
// EM ANDAMENTO: todo pedido com estado oficial não terminal continua contado como ativo, mesmo aberto há mais
// de LIMITE_ATIVO_MIN — nesse caso marcado `semConclusao` e com alerta crítico (nunca escondido).

import { createHash } from "node:crypto";

export const FUSO_NEGOCIO = "America/Sao_Paulo";
export const VIRADA_HORA = 0;
/** Pedido ativo há mais que isto é marcado `semConclusao` e gera alerta crítico (continua ativo). */
export const LIMITE_ATIVO_MIN = 4 * 60;

/**
 * Chave OPACA do pedido para a tela (lista, ordenação, destaque). O orderId do iFood não sai do servidor:
 * a tela só precisa de uma identidade estável, e o número curto (displayId) para as pessoas.
 */
export const chaveOpaca = (orderId) => createHash("sha256").update(`checklist:${orderId ?? ""}`).digest("hex").slice(0, 16);
/** Tetos de plausibilidade (min). Acima disso o par de carimbos é tratado como inconsistente. */
export const TETO_MIN = Object.freeze({ preparo: 240, entrega: 240, vida: 600 });
export const LIMITE_ULTIMOS = 12;

const TERMINAIS = new Set(["CONCLUDED", "CANCELLED"]);
const MIN = 60_000;

const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const valido = (t) => Number.isFinite(t);
const arred = (v) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------------------
// Dia operacional no fuso do negócio
// ---------------------------------------------------------------------------

function partesNoFuso(t, fuso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: fuso, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(t)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  return p;
}

/** Deslocamento do fuso em ms no instante `t` (local − UTC). */
function deslocamento(t, fuso) {
  const p = partesNoFuso(t, fuso);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

/** Instante UTC de uma hora local (ano, mês, dia, hora) no fuso. Duas passadas cobrem mudança de horário. */
function instanteLocal(ano, mes, dia, hora, fuso) {
  const ingenuo = Date.UTC(ano, mes - 1, dia, hora);
  let t = ingenuo - deslocamento(ingenuo, fuso);
  t = ingenuo - deslocamento(t, fuso);
  return t;
}

/**
 * Janela do dia operacional que contém `agoraMs`.
 * @returns {{data: string, inicioMs: number, fimMs: number}}
 */
export function diaOperacional(agoraMs, { fuso = FUSO_NEGOCIO, viradaHora = VIRADA_HORA } = {}) {
  const p = partesNoFuso(agoraMs, fuso);
  // Antes da virada ainda é o dia anterior.
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day - (p.hour < viradaHora ? 1 : 0)));
  const [a, m, d] = [base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate()];
  const prox = new Date(Date.UTC(a, m - 1, d + 1));
  return {
    data: `${a}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    inicioMs: instanteLocal(a, m, d, viradaHora, fuso),
    fimMs: instanteLocal(prox.getUTCFullYear(), prox.getUTCMonth() + 1, prox.getUTCDate(), viradaHora, fuso),
  };
}

// ---------------------------------------------------------------------------
// Pedido → medições
// ---------------------------------------------------------------------------

/** Recebimento OFICIAL: PLC; sem PLC, o createdAt do pedido (Order Details). Nunca o horário em que NÓS recebemos. */
export const recebidoEm = (p) => p.placed_event_created_at ?? p.order_created_at ?? null;

/** Conclusão: o `status_oficial_em` só é a conclusão enquanto o estado oficial for CONCLUDED (é o createdAt do CON). */
export const concluidoEm = (p) => (p.status_oficial === "CONCLUDED" ? p.status_oficial_em ?? null : null);

/** Instante usado só para colocar o pedido num dia/janela. Sem carimbo oficial, o primeiro evento visto. */
const referencia = (p) => {
  for (const c of [recebidoEm(p), p.primeiro_evento_em, p.criado_em]) if (valido(ms(c))) return ms(c);
  return NaN;
};

const agendado = (p) => p.order_timing === "SCHEDULED";

/** Duração entre dois carimbos, ou o motivo de não haver. */
function duracao(inicio, fim, teto) {
  const a = ms(inicio);
  const b = ms(fim);
  if (!valido(a) || !valido(b)) return { min: null, motivo: "carimbo_ausente" };
  const d = (b - a) / MIN;
  if (d <= 0 || d > teto) return { min: null, motivo: "inconsistente" };
  return { min: d, motivo: null };
}

/** @returns {{min: number|null, aproximado: boolean, fim: 'RTP'|'DSP'|null, em: string|null, motivo: string|null}} */
export function medirPreparo(p) {
  if (!p.confirmed_event_at) return { min: null, aproximado: false, fim: null, em: null, motivo: "carimbo_ausente" };
  if (p.ready_event_at) {
    const d = duracao(p.confirmed_event_at, p.ready_event_at, TETO_MIN.preparo);
    return { ...d, aproximado: false, fim: "RTP", em: p.ready_event_at };
  }
  if (p.dispatch_event_at) {
    const d = duracao(p.confirmed_event_at, p.dispatch_event_at, TETO_MIN.preparo);
    return { ...d, aproximado: true, fim: "DSP", em: p.dispatch_event_at };
  }
  return { min: null, aproximado: false, fim: null, em: null, motivo: "sem_fim" };
}

/** @returns {{min: number|null, modalidade: string|null, em: string|null, motivo: string|null}} */
export function medirEntrega(p) {
  const fim = concluidoEm(p);
  if (!p.order_type) return { min: null, modalidade: null, em: null, motivo: "sem_detalhes" };
  if (p.order_type !== "DELIVERY") return { min: null, modalidade: null, em: null, motivo: "nao_delivery" };
  const modalidade = p.delivery_by ?? null;
  if (!fim) return { min: null, modalidade, em: null, motivo: "nao_concluido" };
  if (!p.dispatch_event_at) return { min: null, modalidade, em: null, motivo: "sem_saida" };
  const d = duracao(p.dispatch_event_at, fim, TETO_MIN.entrega);
  return { ...d, modalidade, em: fim };
}

/** @returns {{min: number|null, em: string|null, motivo: string|null}} */
export function medirVida(p) {
  const fim = concluidoEm(p);
  if (!fim) return { min: null, em: null, motivo: "nao_concluido" };
  const d = duracao(recebidoEm(p), fim, TETO_MIN.vida);
  return { ...d, em: fim };
}

/** Trechos da vida do pedido. Trecho sem os dois carimbos fica null (nunca estimado). */
export function decompor(p) {
  const trecho = (a, b, teto) => duracao(a, b, teto).min;
  const pronto = p.ready_event_at ?? null;
  return {
    confirmacao: trecho(recebidoEm(p), p.confirmed_event_at, TETO_MIN.vida),
    preparo: pronto ? trecho(p.confirmed_event_at, pronto, TETO_MIN.preparo) : null,
    espera: pronto ? trecho(pronto, p.dispatch_event_at, TETO_MIN.vida) : null,
    entrega: p.order_type === "DELIVERY" ? trecho(p.dispatch_event_at, concluidoEm(p), TETO_MIN.entrega) : null,
  };
}

// ---------------------------------------------------------------------------
// Agregação
// ---------------------------------------------------------------------------

const media = (xs) => (xs.length ? arred(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
const ultimoPorFim = (itens) => itens.reduce((a, b) => (ms(b.em) > ms(a.em) ? b : a), itens[0]);

function indicadorVazio(extra = {}) {
  return { disponivel: true, motivo: null, ultimo: null, mediaDia: null, amostras: 0, descartados: 0, ...extra };
}

function agregarPreparo(doDia) {
  const naoCancelados = doDia.filter((p) => p.status_oficial !== "CANCELLED");
  const agendadosExcluidos = naoCancelados.filter(agendado).length;
  const elegiveis = naoCancelados.filter((p) => !agendado(p));
  const med = elegiveis.map((p) => ({ p, m: medirPreparo(p) }));
  const ok = med.filter((x) => x.m.min != null);
  const descartados = med.filter((x) => x.m.motivo === "inconsistente").length;
  const aproximadas = ok.filter((x) => x.m.aproximado).length;
  // Pedidos que já deveriam ter preparo medido (passaram da confirmação e saíram/ficaram prontos ou concluíram).
  const esperados = elegiveis.filter((p) => p.ready_event_at || p.dispatch_event_at || p.status_oficial === "CONCLUDED").length;
  if (!ok.length) {
    const indisponivel = esperados > 0;
    return indicadorVazio({
      disponivel: !indisponivel,
      motivo: indisponivel ? "Os pedidos do dia não têm os carimbos de confirmação e de pronto/saída." : null,
      descartados, amostrasExatas: 0, amostrasAproximadas: 0, mediaAproximada: false, agendadosExcluidos,
    });
  }
  const u = ultimoPorFim(ok.map((x) => ({ ...x, em: x.m.em })));
  return {
    disponivel: true,
    motivo: null,
    ultimo: { min: arred(u.m.min), displayId: u.p.display_id ?? null, em: u.m.em, aproximado: u.m.aproximado, fim: u.m.fim },
    mediaDia: media(ok.map((x) => x.m.min)),
    amostras: ok.length,
    amostrasExatas: ok.length - aproximadas,
    amostrasAproximadas: aproximadas,
    mediaAproximada: aproximadas > 0,
    descartados,
    agendadosExcluidos,
  };
}

function agregarEntrega(doDia) {
  const concluidos = doDia.filter((p) => p.status_oficial === "CONCLUDED");
  const med = concluidos.map((p) => ({ p, m: medirEntrega(p) }));
  const ok = med.filter((x) => x.m.min != null);
  const semDetalhes = med.filter((x) => x.m.motivo === "sem_detalhes").length;
  const semSaida = med.filter((x) => x.m.motivo === "sem_saida").length;
  const descartados = med.filter((x) => x.m.motivo === "inconsistente").length;
  const criterio = "Saída (DSP) até a conclusão (CON). A conclusão ainda não foi validada como entrega ao cliente.";

  const porModalidade = {};
  for (const x of ok) {
    const k = x.m.modalidade ?? "DESCONHECIDA";
    (porModalidade[k] ??= []).push(x.m.min);
  }
  const modalidades = Object.fromEntries(Object.entries(porModalidade).map(([k, xs]) => [k, { mediaDia: media(xs), amostras: xs.length }]));

  if (!ok.length) {
    let motivo = null;
    if (semDetalhes > 0) motivo = "Faltam os detalhes do pedido para separar entrega de retirada.";
    else if (semSaida > 0) motivo = "Os pedidos de entrega concluídos não têm o evento de saída (DSP).";
    else if (descartados > 0) motivo = "Os carimbos de saída e conclusão dos pedidos do dia são inconsistentes.";
    return indicadorVazio({ disponivel: motivo == null, motivo, descartados, semDetalhes, aproximado: true, criterio, porModalidade: modalidades });
  }
  const u = ultimoPorFim(ok.map((x) => ({ ...x, em: x.m.em })));
  return {
    disponivel: true,
    motivo: null,
    ultimo: { min: arred(u.m.min), displayId: u.p.display_id ?? null, em: u.m.em, aproximado: true, modalidade: u.m.modalidade },
    mediaDia: media(ok.map((x) => x.m.min)),
    amostras: ok.length,
    mediaAproximada: true,
    aproximado: true,
    criterio,
    porModalidade: modalidades,
    semDetalhes,
    descartados,
  };
}

function agregarVida(doDia) {
  const todosConcluidos = doDia.filter((p) => p.status_oficial === "CONCLUDED");
  const agendadosExcluidos = todosConcluidos.filter(agendado).length;
  const concluidos = todosConcluidos.filter((p) => !agendado(p));
  const med = concluidos.map((p) => ({ p, m: medirVida(p) }));
  const ok = med.filter((x) => x.m.min != null);
  const descartados = med.filter((x) => x.m.motivo === "inconsistente").length;
  if (!ok.length) {
    const indisponivel = concluidos.length > 0;
    return indicadorVazio({
      disponivel: !indisponivel,
      motivo: indisponivel ? "Os pedidos concluídos do dia não têm o carimbo de recebimento." : null,
      descartados, decomposicao: null, agendadosExcluidos,
    });
  }
  const u = ultimoPorFim(ok.map((x) => ({ ...x, em: x.m.em })));
  const dec = decompor(u.p);
  return {
    disponivel: true,
    motivo: null,
    ultimo: { min: arred(u.m.min), displayId: u.p.display_id ?? null, em: u.m.em },
    mediaDia: media(ok.map((x) => x.m.min)),
    amostras: ok.length,
    descartados,
    agendadosExcluidos,
    decomposicao: Object.fromEntries(Object.entries(dec).map(([k, v]) => [k, v == null ? null : arred(v)])),
  };
}

/**
 * Pedido em andamento, só com os campos que a tela usa (lista POSITIVA — nenhum dado do cliente, nenhum
 * orderId do iFood). `semConclusao`: aberto há mais de LIMITE_ATIVO_MIN (ou sem horário de referência).
 */
function paraAtivo(p, agoraMs) {
  const t = referencia(p);
  return {
    id: chaveOpaca(p.order_id),
    displayId: p.display_id ?? null,
    recebidoEm: recebidoEm(p),
    status: p.status_oficial ?? "PLACED",
    confirmadoEm: p.confirmed_event_at ?? null,
    despachadoEm: p.dispatch_event_at ?? null,
    tipo: p.order_type ?? null,
    entregaPor: p.delivery_by ?? null,
    agendado: agendado(p),
    semConclusao: !valido(t) || agoraMs - t > LIMITE_ATIVO_MIN * MIN,
  };
}

/** Linha da tabela "Últimos pedidos". Agendado não mostra preparo/vida (as médias também os excluem). */
function paraRecente(p) {
  const prep = medirPreparo(p);
  const ent = medirEntrega(p);
  const vida = medirVida(p);
  const cancelado = p.status_oficial === "CANCELLED";
  const ag = agendado(p);
  return {
    id: chaveOpaca(p.order_id),
    displayId: p.display_id ?? null,
    recebidoEm: recebidoEm(p),
    status: p.status_oficial ?? "PLACED",
    agendado: ag,
    preparoMin: cancelado || ag || prep.min == null ? null : arred(prep.min),
    preparoAproximado: !cancelado && !ag && prep.min != null && prep.aproximado,
    entregaMin: cancelado || ent.min == null ? null : arred(ent.min),
    vidaMin: cancelado || ag || vida.min == null ? null : arred(vida.min),
  };
}

/**
 * Resumo do dia a partir das linhas do tenant. As linhas JÁ vêm filtradas por organização + unidade.
 * @param {{pedidos: object[], agoraMs: number, fuso?: string, viradaHora?: number}} p
 */
export function montarResumo({ pedidos, agoraMs, fuso = FUSO_NEGOCIO, viradaHora = VIRADA_HORA }) {
  const dia = diaOperacional(agoraMs, { fuso, viradaHora });
  const reais = (pedidos ?? []).filter((p) => p && p.is_test !== true);
  const teste = (pedidos ?? []).length - reais.length;
  const noDia = (p) => { const t = referencia(p); return valido(t) && t >= dia.inicioMs && t < dia.fimMs; };
  const doDia = reais.filter(noDia);

  // Ativo = estado oficial não terminal. Nenhum é removido por idade: o aberto há tempo demais continua
  // ativo, marcado `semConclusao`, e gera alerta crítico.
  const ativos = reais.filter((p) => !TERMINAIS.has(p.status_oficial)).map((p) => paraAtivo(p, agoraMs));
  const semConclusao = ativos.filter((a) => a.semConclusao).length;
  const agendados = ativos.filter((a) => a.agendado).length;

  const semDetalhesHoje = doDia.filter((p) => !p.order_type).length;
  const alertas = [];
  if (semConclusao) {
    alertas.push({
      codigo: "pedidos_sem_conclusao", nivel: "critico", quantidade: semConclusao,
      texto: `${semConclusao} ${semConclusao === 1 ? "pedido aberto" : "pedidos abertos"} há mais de ${LIMITE_ATIVO_MIN / 60} h sem conclusão`,
    });
  }
  if (agendados) {
    alertas.push({ codigo: "pedidos_agendados", nivel: "info", quantidade: agendados, texto: `${agendados} ${agendados === 1 ? "pedido agendado" : "pedidos agendados"} em andamento` });
  }
  if (semDetalhesHoje) {
    alertas.push({ codigo: "detalhes_ausentes", nivel: "atencao", quantidade: semDetalhesHoje, texto: `${semDetalhesHoje} ${semDetalhesHoje === 1 ? "pedido" : "pedidos"} sem detalhes do iFood (tipo e número)` });
  }

  return {
    diaOperacional: { data: dia.data, inicio: new Date(dia.inicioMs).toISOString(), fim: new Date(dia.fimMs).toISOString(), fuso, viradaHora },
    indicadores: { preparo: agregarPreparo(doDia), entrega: agregarEntrega(doDia), vida: agregarVida(doDia) },
    pedidosAtivos: ativos.sort((a, b) => (ms(a.recebidoEm) || Infinity) - (ms(b.recebidoEm) || Infinity)),
    ultimosPedidos: [...doDia].sort((a, b) => referencia(b) - referencia(a)).slice(0, LIMITE_ULTIMOS).map(paraRecente),
    contagemDia: {
      recebidos: doDia.length,
      concluidos: doDia.filter((p) => p.status_oficial === "CONCLUDED").length,
      cancelados: doDia.filter((p) => p.status_oficial === "CANCELLED").length,
      emAndamento: ativos.length,
      semConclusao,
      agendados,
      teste,
    },
    alertas,
  };
}
