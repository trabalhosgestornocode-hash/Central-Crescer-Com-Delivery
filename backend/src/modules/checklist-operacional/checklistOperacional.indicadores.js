// Checklist Operacional — INDICADORES HISTÓRICOS do Dashboard Operacional (funções puras).
//
// Entrada: linhas de `ifood_pedidos` JÁ filtradas por organização + unidade, a janela do período
// (checklistOperacional.periodos.js) e a linha do tempo das metas (checklistOperacional.metas.js). Saída: todos os
// números do Dashboard, dos relatórios e das análises — a tela, o PDF, o Excel e o Agente leem ESTE resultado; nenhum
// deles recalcula nada.
//
// MEDIÇÕES: as MESMAS do resumo ao vivo (medirPreparo / medirEntrega / medirVida de checklistOperacional.calc.js),
// com as mesmas elegibilidades ("Etapa 2": só DELIVERY; preparo = chegada PLC → despacho DSP; entrega = DSP → conclusão;
// vida = PLC → conclusão; teste fora de tudo; cancelado fora das durações; agendado fora de preparo e vida). Duração
// inconsistente é descartada e CONTADA — nunca corrigida.
//
// META DE CADA PEDIDO: a vigente no RECEBIMENTO do pedido (histórico versionado). Pedido recebido antes da primeira
// meta salva fica "sem meta vigente": entra nos tempos, mas não no % dentro da meta (nem no denominador). Assim mudar a
// meta hoje nunca muda o resultado de ontem.
//
// Todo indicador tem definição, fórmula, unidade, denominador e tratamento de ausência em DEFINICOES (vai na resposta).
// Dashboard 2.0: mediana e P90 continuam calculados em `estatisticas` (as análises robustas e o Agente usam), mas saíram das
// definições exibidas e de toda a interface gerencial (tela, PDF, Excel, fechamento e WhatsApp).

import { medirPreparo, medirEntrega, medirVida, referencia, chaveOpaca, FUSO_NEGOCIO } from "./checklistOperacional.calc.js";
import { metaVigenteEm } from "./checklistOperacional.metas.js";
import { somarDias, diasEntre, diaDaSemana } from "./checklistOperacional.periodos.js";

export const ETAPAS = Object.freeze(["preparo", "entrega", "vida"]);
export const NOME_ETAPA = Object.freeze({ preparo: "Preparo", entrega: "Entrega", vida: "Vida do pedido" });
export const LIMITE_EVIDENCIAS = 500;

const TERMINAIS = new Set(["CONCLUDED", "CANCELLED"]);
const HORA_MS = 3_600_000;
const arred = (v, casas = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** casas) / 10 ** casas);
const pct = (num, den) => (den > 0 ? arred((num / den) * 100) : null);

export const DEFINICOES = Object.freeze({
  pedidos: {
    nome: "Pedidos acompanhados", unidade: "pedidos",
    definicao: "Pedidos reais (não teste) recebidos no período, pelo carimbo oficial de recebimento do iFood.",
    formula: "contagem de pedidos com recebimento em [início, fim]", denominador: "—",
    ausentes: "Pedido sem nenhum carimbo de horário não entra no período. Pedidos de teste ficam fora de tudo.",
  },
  media: {
    nome: "Tempo médio", unidade: "min",
    definicao: "Média aritmética das durações válidas da etapa.",
    formula: "Σ durações ÷ amostras", denominador: "amostras válidas da etapa",
    ausentes: "Só pedidos de entrega (DELIVERY) entram; retirada fica fora. Sem os dois carimbos da etapa o pedido não entra. Duração ≤ 0 ou acima do teto é descartada e contada.",
  },
  pctDentro: {
    nome: "Dentro da meta", unidade: "%",
    definicao: "Parte das durações avaliadas que ficou até a meta (inclusive).",
    formula: "durações ≤ meta vigente no recebimento ÷ durações avaliadas × 100", denominador: "durações válidas com meta vigente",
    ausentes: "Pedido recebido antes da primeira meta salva fica fora do denominador e é contado como \"sem meta vigente\".",
  },
  atrasos: {
    nome: "Atrasos", unidade: "pedidos / %",
    definicao: "Durações acima da meta vigente no recebimento.",
    formula: "durações > meta ÷ durações avaliadas × 100", denominador: "durações válidas com meta vigente",
    ausentes: "Igual a \"Dentro da meta\".",
  },
  maiorAtraso: {
    nome: "Maior atraso", unidade: "min",
    definicao: "Maior excedente sobre a meta entre os atrasos do período.",
    formula: "máx(duração − meta) entre as durações acima da meta", denominador: "—", ausentes: "Sem atraso no período: vazio.",
  },
  pedidoAtrasado: {
    nome: "Pedido atrasado", unidade: "pedidos",
    definicao: "Pedido com pelo menos uma das etapas selecionadas acima da meta (contado uma vez).",
    formula: "pedidos com alguma etapa > meta", denominador: "pedidos com alguma etapa avaliada", ausentes: "Pedido sem etapa avaliada não entra.",
  },
  demandaHora: {
    nome: "Demanda por horário", unidade: "pedidos",
    definicao: "Pedidos recebidos em cada hora do dia (fuso da operação), somados no período.",
    formula: "contagem por hora local do recebimento", denominador: "—", ausentes: "Hora sem pedido = 0.",
  },
  volumeSemana: {
    nome: "Volume por dia da semana", unidade: "pedidos / dia",
    definicao: "Pedidos por dia da semana e a média por dia observado.",
    formula: "pedidos do dia da semana ÷ quantidade desses dias no período", denominador: "dias do período com aquele dia da semana",
    ausentes: "Dias antes do primeiro pedido registrado da unidade não entram no denominador (sem cobertura).",
  },
  checklistItens: {
    nome: "Cumprimento dos itens do checklist", unidade: "%",
    definicao: "Itens de checklist marcados pela equipe.", formula: "—", denominador: "—",
    ausentes: "A Central não registra itens de checklist (só os tempos dos pedidos): indicador indisponível.",
  },
});

// ---------------------------------------------------------------------------
// Estatística
// ---------------------------------------------------------------------------

/** Percentil por interpolação linear entre as posições (R-7 / PERCENTIL.INC). `ordenados` crescente. */
export function percentil(ordenados, p) {
  if (!ordenados.length) return null;
  if (ordenados.length === 1) return ordenados[0];
  const pos = (ordenados.length - 1) * p;
  const i = Math.floor(pos);
  const f = pos - i;
  return i + 1 < ordenados.length ? ordenados[i] + (ordenados[i + 1] - ordenados[i]) * f : ordenados[i];
}

/** Resumo de uma amostra de durações (min). Vazia → números null (nunca zero). */
export function estatisticas(valores) {
  const xs = valores.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return { amostras: 0, media: null, mediana: null, p90: null, minimo: null, maximo: null };
  return {
    amostras: xs.length,
    media: arred(xs.reduce((s, x) => s + x, 0) / xs.length),
    mediana: arred(percentil(xs, 0.5)),
    p90: arred(percentil(xs, 0.9)),
    minimo: arred(xs[0]),
    maximo: arred(xs[xs.length - 1]),
  };
}

// ---------------------------------------------------------------------------
// Hora / dia locais (formatador em cache: o Dashboard chama por pedido)
// ---------------------------------------------------------------------------

const formatadores = new Map();
function partesLocais(t, fuso) {
  let f = formatadores.get(fuso);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: fuso, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" });
    formatadores.set(fuso, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour) % 24 };
}

// ---------------------------------------------------------------------------
// Pedido → medições avaliadas
// ---------------------------------------------------------------------------

const agendado = (p) => p.order_timing === "SCHEDULED";

/** Medição de UMA etapa do pedido, com a meta vigente. `null` quando a etapa não se aplica ao pedido. */
function medirEtapa(etapa, p, meta) {
  const cancelado = p.status_oficial === "CANCELLED";
  // Mesma régua do resumo ao vivo (calc.js, "Etapa 2"): só DELIVERY entra nos tempos. Retirada não se aplica (null);
  // pedido sem os detalhes do iFood é dado ausente (contado em `semCarimbo`).
  if (p.order_type && p.order_type !== "DELIVERY") return null;
  let m;
  if (etapa === "preparo") {
    if (cancelado || agendado(p)) return null;
    m = medirPreparo(p);
    // Ainda não despachado e em andamento: o preparo não terminou — não é ausência de dado.
    if (m.motivo === "sem_saida" && p.status_oficial !== "CONCLUDED") return null;
  } else if (etapa === "entrega") {
    if (p.status_oficial !== "CONCLUDED") return null;
    m = medirEntrega(p);
  } else {
    if (p.status_oficial !== "CONCLUDED" || agendado(p)) return null;
    m = medirVida(p);
  }
  if (m.min == null) return { min: null, motivo: m.motivo };
  const limite = meta?.valores?.[etapa]?.meta ?? null;
  const avaliado = limite != null;
  return {
    min: m.min,
    motivo: null,
    meta: limite,
    versaoMeta: meta?.versao ?? null,
    avaliado,
    atraso: avaliado && m.min > limite + 1e-9,
  };
}

/**
 * Pedidos do intervalo, já medidos. Duplicatas por `order_id` (não deveriam existir: é único no banco) são ignoradas.
 * @returns {{itens: object[], teste: number, foraDaJanela: number}}
 */
export function pedidosDoIntervalo({ pedidos, intervalo, linhaDoTempo, fuso = FUSO_NEGOCIO }) {
  const vistos = new Set();
  const itens = [];
  let teste = 0;
  for (const p of pedidos ?? []) {
    if (!p || !p.order_id || vistos.has(p.order_id)) continue;
    const t = referencia(p);
    if (!Number.isFinite(t) || t < intervalo.inicioMs || t >= intervalo.fimMs) continue;
    if (intervalo.corteMs != null && t >= intervalo.corteMs) continue;
    vistos.add(p.order_id);
    if (p.is_test === true) { teste += 1; continue; }
    const meta = metaVigenteEm(linhaDoTempo, t);
    const local = partesLocais(t, fuso);
    itens.push({
      p, t, data: local.data, hora: local.hora, meta,
      etapas: Object.fromEntries(ETAPAS.map((e) => [e, medirEtapa(e, p, meta)])),
    });
  }
  return { itens, teste };
}

// ---------------------------------------------------------------------------
// Agregação
// ---------------------------------------------------------------------------

function agregarEtapa(itens, etapa) {
  const medidas = itens.map((i) => ({ i, m: i.etapas[etapa] })).filter((x) => x.m);
  const validas = medidas.filter((x) => x.m.min != null);
  const avaliadas = validas.filter((x) => x.m.avaliado);
  const atrasos = avaliadas.filter((x) => x.m.atraso);
  const maior = atrasos.reduce((a, b) => (!a || b.m.min - b.m.meta > a.m.min - a.m.meta ? b : a), null);
  return {
    etapa,
    ...estatisticas(validas.map((x) => x.m.min)),
    esperadas: medidas.length,
    avaliadas: avaliadas.length,
    dentro: avaliadas.length - atrasos.length,
    atrasos: atrasos.length,
    pctDentro: pct(avaliadas.length - atrasos.length, avaliadas.length),
    pctAtraso: pct(atrasos.length, avaliadas.length),
    semMetaVigente: validas.length - avaliadas.length,
    descartados: medidas.filter((x) => x.m.motivo === "inconsistente").length,
    semCarimbo: medidas.filter((x) => x.m.motivo && x.m.motivo !== "inconsistente").length,
    maiorAtraso: maior ? {
      excedenteMin: arred(maior.m.min - maior.m.meta), duracaoMin: arred(maior.m.min), metaMin: maior.m.meta,
      displayId: maior.i.p.display_id ?? null, recebidoEm: new Date(maior.i.t).toISOString(), id: chaveOpaca(maior.i.p.order_id),
    } : null,
  };
}

/** Situação final do pedido nas etapas selecionadas. */
function classeDoPedido(item, etapas) {
  const avaliadas = etapas.map((e) => item.etapas[e]).filter((m) => m?.avaliado);
  if (!avaliadas.length) return "sem_avaliacao";
  return avaliadas.some((m) => m.atraso) ? "atrasado" : "dentro";
}

function contagens(itens) {
  const st = (s) => itens.filter((i) => i.p.status_oficial === s).length;
  return {
    pedidos: itens.length,
    concluidos: st("CONCLUDED"),
    cancelados: st("CANCELLED"),
    emAndamento: itens.filter((i) => !TERMINAIS.has(i.p.status_oficial)).length,
    agendados: itens.filter((i) => agendado(i.p)).length,
    semDetalhes: itens.filter((i) => !i.p.order_type).length,
  };
}

function resumoDoConjunto(itens, etapas) {
  const porEtapa = Object.fromEntries(etapas.map((e) => [e, agregarEtapa(itens, e)]));
  const classes = itens.map((i) => classeDoPedido(i, etapas));
  const atrasados = classes.filter((c) => c === "atrasado").length;
  const avaliados = classes.filter((c) => c !== "sem_avaliacao").length;
  return {
    ...contagens(itens),
    porEtapa,
    pedidosAvaliados: avaliados,
    pedidosAtrasados: atrasados,
    pctPedidosAtrasados: pct(atrasados, avaliados),
    pctPedidosDentro: pct(avaliados - atrasados, avaliados),
    distribuicaoStatus: {
      dentro: avaliados - atrasados,
      atrasado: atrasados,
      semAvaliacao: classes.length - avaliados,
    },
  };
}

/** Dias do intervalo (todos, inclusive os sem pedido). */
const diasDo = (intervalo) => Array.from({ length: diasEntre(intervalo.inicio, intervalo.fim) }, (_, k) => somarDias(intervalo.inicio, k));

function evolucaoDiaria(itens, intervalo, etapas, coberturaDesde) {
  const porDia = new Map();
  for (const i of itens) (porDia.get(i.data) ?? porDia.set(i.data, []).get(i.data)).push(i);
  return diasDo(intervalo).map((data) => {
    const doDia = porDia.get(data) ?? [];
    const r = resumoDoConjunto(doDia, etapas);
    return {
      data,
      semCobertura: coberturaDesde != null && data < coberturaDesde,
      pedidos: r.pedidos, concluidos: r.concluidos, cancelados: r.cancelados,
      pedidosAtrasados: r.pedidosAtrasados, pedidosAvaliados: r.pedidosAvaliados, pctPedidosAtrasados: r.pctPedidosAtrasados,
      porEtapa: Object.fromEntries(etapas.map((e) => {
        const x = r.porEtapa[e];
        return [e, { amostras: x.amostras, media: x.media, mediana: x.mediana, p90: x.p90, avaliadas: x.avaliadas, atrasos: x.atrasos, pctDentro: x.pctDentro }];
      })),
    };
  });
}

function demandaPorHora(itens, etapas) {
  const horas = Array.from({ length: 24 }, (_, hora) => ({ hora, pedidos: 0, atrasados: 0, avaliados: 0 }));
  for (const i of itens) {
    const h = horas[i.hora];
    h.pedidos += 1;
    const c = classeDoPedido(i, etapas);
    if (c !== "sem_avaliacao") h.avaliados += 1;
    if (c === "atrasado") h.atrasados += 1;
  }
  return horas.map((h) => ({ ...h, pctAtrasados: pct(h.atrasados, h.avaliados) }));
}

const NOMES_SEMANA = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

function volumePorDiaDaSemana(itens, intervalo, coberturaDesde) {
  const dias = diasDo(intervalo).filter((d) => coberturaDesde == null || d >= coberturaDesde);
  const semana = NOMES_SEMANA.map((nome, dia) => ({ dia, nome, pedidos: 0, diasObservados: dias.filter((d) => diaDaSemana(d) === dia).length }));
  for (const i of itens) semana[diaDaSemana(i.data)].pedidos += 1;
  return semana.map((s) => ({ ...s, mediaPorDia: s.diasObservados ? arred(s.pedidos / s.diasObservados) : null }));
}

/** Atrasos detalhados (evidência). Ordem: maior excedente primeiro. */
function evidenciasDeAtraso(itens, etapas) {
  const lista = [];
  for (const i of itens) {
    for (const e of etapas) {
      const m = i.etapas[e];
      if (!m?.atraso) continue;
      lista.push({
        id: chaveOpaca(i.p.order_id), displayId: i.p.display_id ?? null, recebidoEm: new Date(i.t).toISOString(),
        data: i.data, hora: i.hora, etapa: e, duracaoMin: arred(m.min), metaMin: m.meta, excedenteMin: arred(m.min - m.meta),
        versaoMeta: m.versaoMeta,
      });
    }
  }
  return lista.sort((a, b) => b.excedenteMin - a.excedenteMin || a.recebidoEm.localeCompare(b.recebidoEm));
}

/** Diferença atual − anterior (null quando qualquer lado falta). `pp` para percentuais. */
const delta = (a, b) => (a == null || b == null ? null : arred(a - b));
const deltaPct = (a, b) => (a == null || b == null || b === 0 ? null : arred(((a - b) / b) * 100));

function comparar(atual, anterior, etapas) {
  return {
    pedidos: { atual: atual.pedidos, anterior: anterior.pedidos, diferenca: atual.pedidos - anterior.pedidos, variacaoPct: deltaPct(atual.pedidos, anterior.pedidos) },
    pctPedidosAtrasados: { atual: atual.pctPedidosAtrasados, anterior: anterior.pctPedidosAtrasados, diferencaPP: delta(atual.pctPedidosAtrasados, anterior.pctPedidosAtrasados) },
    porEtapa: Object.fromEntries(etapas.map((e) => {
      const a = atual.porEtapa[e];
      const b = anterior.porEtapa[e];
      return [e, {
        media: { atual: a.media, anterior: b.media, diferenca: delta(a.media, b.media), variacaoPct: deltaPct(a.media, b.media) },
        mediana: { atual: a.mediana, anterior: b.mediana, diferenca: delta(a.mediana, b.mediana), variacaoPct: deltaPct(a.mediana, b.mediana) },
        p90: { atual: a.p90, anterior: b.p90, diferenca: delta(a.p90, b.p90), variacaoPct: deltaPct(a.p90, b.p90) },
        pctDentro: { atual: a.pctDentro, anterior: b.pctDentro, diferencaPP: delta(a.pctDentro, b.pctDentro) },
        amostras: { atual: a.amostras, anterior: b.amostras },
      }];
    })),
  };
}

/** Metas que valeram em algum momento do intervalo (para o relatório dizer contra o quê cada pedido foi avaliado). */
function metasAplicaveis(linhaDoTempo, intervalo) {
  const fim = intervalo.corteMs ?? intervalo.fimMs;
  const vigenteNoInicio = metaVigenteEm(linhaDoTempo, intervalo.inicioMs);
  const dentro = (linhaDoTempo ?? []).filter((v) => v.desdeMs > intervalo.inicioMs && v.desdeMs < fim);
  const versoes = [...(vigenteNoInicio ? [vigenteNoInicio] : []), ...dentro]
    .map((v) => ({ versao: v.versao, desde: new Date(v.desdeMs).toISOString(), valores: v.valores }));
  return { versoes, inicioSemMeta: !vigenteNoInicio };
}

/**
 * Dashboard de UM período + o comparativo equivalente.
 * @param {{pedidos: object[], pedidosAnterior?: object[], periodo: object, linhaDoTempo: object[], etapa?: string,
 *          primeiroPedidoEm?: string|null, fuso?: string}} p  `periodo` = resultado ok de resolverPeriodo
 */
export function montarDashboard({ pedidos, pedidosAnterior = null, periodo, linhaDoTempo, etapa = "todas", primeiroPedidoEm = null, fuso = FUSO_NEGOCIO }) {
  const etapas = etapa === "todas" ? [...ETAPAS] : ETAPAS.includes(etapa) ? [etapa] : [...ETAPAS];
  const coberturaDesde = primeiroPedidoEm ? partesLocais(Date.parse(primeiroPedidoEm), fuso).data : null;

  const atualSel = pedidosDoIntervalo({ pedidos, intervalo: periodo.atual, linhaDoTempo, fuso });
  // O comparativo pode vir na mesma lista (janela única) ou separado.
  const antSel = pedidosDoIntervalo({ pedidos: pedidosAnterior ?? pedidos, intervalo: periodo.anterior, linhaDoTempo, fuso });

  const atual = resumoDoConjunto(atualSel.itens, etapas);
  const anterior = resumoDoConjunto(antSel.itens, etapas);
  const evolucao = evolucaoDiaria(atualSel.itens, periodo.atual, etapas, coberturaDesde);
  const evidencias = evidenciasDeAtraso(atualSel.itens, etapas);

  const diasSemCobertura = evolucao.filter((d) => d.semCobertura).length;
  const diasSemPedidos = evolucao.filter((d) => !d.semCobertura && d.pedidos === 0).length;
  const metas = metasAplicaveis(linhaDoTempo, periodo.atual);
  const semMetaVigente = etapas.reduce((s, e) => s + atual.porEtapa[e].semMetaVigente, 0);

  return {
    periodo: {
      tipo: periodo.tipo, parcial: periodo.parcial,
      inicio: periodo.atual.inicio, fim: periodo.atual.fim, dias: periodo.atual.dias,
      ate: periodo.atual.corteMs != null ? new Date(periodo.atual.corteMs).toISOString() : null,
      anterior: {
        inicio: periodo.anterior.inicio, fim: periodo.anterior.fim, dias: periodo.anterior.dias,
        ate: periodo.anterior.corteMs != null ? new Date(periodo.anterior.corteMs).toISOString() : null,
      },
      fuso,
    },
    etapa,
    etapas,
    resumo: atual,
    anterior,
    comparacao: comparar(atual, anterior, etapas),
    evolucaoDiaria: evolucao,
    demandaPorHora: demandaPorHora(atualSel.itens, etapas),
    volumePorDiaDaSemana: volumePorDiaDaSemana(atualSel.itens, periodo.atual, coberturaDesde),
    atrasos: { total: evidencias.length, itens: evidencias.slice(0, LIMITE_EVIDENCIAS), truncado: evidencias.length > LIMITE_EVIDENCIAS },
    checklistItens: { disponivel: false, motivo: DEFINICOES.checklistItens.ausentes },
    metasAplicaveis: metas,
    qualidade: {
      primeiroPedidoEm,
      coberturaDesde,
      diasSemCobertura,
      diasSemPedidos,
      pedidosTeste: atualSel.teste,
      pedidosSemDetalhes: atual.semDetalhes,
      agendados: atual.agendados,
      emAndamento: atual.emAndamento,
      semMetaVigente,
      inicioSemMeta: metas.inicioSemMeta,
      porEtapa: Object.fromEntries(etapas.map((e) => {
        const x = atual.porEtapa[e];
        return [e, { esperadas: x.esperadas, validas: x.amostras, descartados: x.descartados, semCarimbo: x.semCarimbo, semMetaVigente: x.semMetaVigente }];
      })),
      avisos: avisosDeQualidade({ atual, etapas, diasSemCobertura, metas, semMetaVigente, parcial: periodo.parcial }),
    },
    definicoes: DEFINICOES,
    // Usado só pelo motor de análises (não vai para a resposta HTTP).
    _itens: atualSel.itens,
    _itensAnterior: antSel.itens,
  };
}

function avisosDeQualidade({ atual, etapas, diasSemCobertura, metas, semMetaVigente, parcial }) {
  const avisos = [];
  if (parcial) avisos.push("O período termina hoje: os números de hoje são parciais e o comparativo foi cortado no mesmo horário.");
  if (diasSemCobertura) avisos.push(`${diasSemCobertura} ${diasSemCobertura === 1 ? "dia" : "dias"} do período são anteriores ao primeiro pedido registrado da unidade (sem cobertura; nada é estimado).`);
  if (metas.inicioSemMeta) avisos.push("Parte do período não tinha meta salva para a unidade: esses pedidos não entram no % dentro da meta.");
  if (semMetaVigente) avisos.push(`${semMetaVigente} ${semMetaVigente === 1 ? "medição ficou" : "medições ficaram"} sem meta vigente.`);
  if (atual.semDetalhes) avisos.push(`${atual.semDetalhes} ${atual.semDetalhes === 1 ? "pedido sem" : "pedidos sem"} detalhes do iFood (tipo de pedido): a entrega deles não é medida.`);
  if (etapas.includes("entrega")) avisos.push("Entrega vai da saída até a conclusão registrada pelo iFood.");
  for (const e of etapas) {
    const x = atual.porEtapa[e];
    if (x.descartados) avisos.push(`${NOME_ETAPA[e]}: ${x.descartados} ${x.descartados === 1 ? "duração inconsistente descartada" : "durações inconsistentes descartadas"}.`);
  }
  return avisos;
}

/** Remove os campos internos antes de responder. */
export function paraResposta(dashboard) {
  const { _itens, _itensAnterior, ...resto } = dashboard;
  return resto;
}

export const _interno = { partesLocais, medirEtapa, classeDoPedido, HORA_MS };
