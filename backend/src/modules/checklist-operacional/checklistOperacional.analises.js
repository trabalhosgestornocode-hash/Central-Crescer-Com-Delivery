// Checklist Operacional — INTELIGÊNCIA OPERACIONAL (motor determinístico de análises; funções puras).
//
// Lê SÓ o resultado de montarDashboard (indicadores já calculados e os pedidos medidos do período). Nenhuma análise
// inventa número, estima dado ausente ou atribui causa: cada uma tem uma regra fixa, limiares fixos (LIMIARES, abaixo)
// e uma amostra mínima. Sem amostra mínima a regra não roda e isso é DITO (`naoAvaliadas`).
//
// Cada análise separa três coisas — e a tela, o PDF e o Excel mostram cada uma com o seu rótulo:
//   constatacao   FATO: o que os dados mostram, com indicador, período, referência e quantidade de ocorrências;
//   hipotese      HIPÓTESE (opcional): leitura possível, explicitamente NÃO comprovada pelos dados;
//   recomendacao  RECOMENDAÇÃO operacional (opcional): o que verificar/fazer — nunca um diagnóstico.
// `evidencias` aponta para registros consultáveis (pedidos pelo número curto, dias, horários).

import { NOME_ETAPA } from "./checklistOperacional.indicadores.js";
import { chaveOpaca } from "./checklistOperacional.calc.js";

export const LIMIARES = Object.freeze({
  // Concentração de atrasos por horário
  horaMinAvaliados: 10, horaMinAtrasados: 5, horaFatorSobreGeral: 1.5, horaMinDiferencaPP: 10,
  // Dias críticos
  diaMinAvaliados: 10, diaMinDiferencaPP: 15, diaFatorSobreGeral: 1.5,
  // Piora / melhora entre períodos
  compMinAmostras: 20, compMinVariacaoPct: 10, compMinVariacaoMin: 1, compMinVariacaoPP: 5,
  // Aumento anormal do preparo (mediana do dia contra a mediana das medianas diárias + desvio robusto)
  anomMinDias: 5, anomMinAmostrasDia: 5, anomFatorMad: 3, anomMinExcessoMin: 2,
  // Concentração por etapa
  etapaMinAtrasos: 10, etapaMinParticipacao: 0.6,
  // Reincidência: mesmo horário com atraso em vários dias
  reincMinAtrasadosNaHora: 2, reincMinPctNaHora: 50, reincMinDias: 3,
  // Leitura do desempenho contra a meta (só classifica a severidade da constatação)
  metaAtencaoAbaixoPct: 80, metaAltaAbaixoPct: 70,
});

const L = LIMIARES;
const arred = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const fmt = (v) => (v == null ? "—" : String(arred(v)).replace(".", ","));
const faixaHora = (h) => `${String(h).padStart(2, "0")}h–${String((h + 1) % 24).padStart(2, "0")}h`;
const dataBr = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

function periodoDe(d) {
  return { inicio: d.periodo.inicio, fim: d.periodo.fim };
}

/** Pedidos atrasados de um recorte (para evidência), no formato curto. */
function pedidosAtrasados(itens, etapas, filtro = () => true, limite = 50) {
  const out = [];
  for (const i of itens) {
    if (!filtro(i)) continue;
    for (const e of etapas) {
      const m = i.etapas[e];
      if (m?.atraso) out.push({ id: chaveOpaca(i.p.order_id), displayId: i.p.display_id ?? null, data: i.data, hora: i.hora, etapa: e, duracaoMin: arred(m.min), metaMin: m.meta });
    }
  }
  return { total: out.length, itens: out.sort((a, b) => (b.duracaoMin - b.metaMin) - (a.duracaoMin - a.metaMin)).slice(0, limite) };
}

const pedidoAtrasado = (i, etapas) => etapas.some((e) => i.etapas[e]?.atraso);
const pedidoAvaliado = (i, etapas) => etapas.some((e) => i.etapas[e]?.avaliado);

// ---------------------------------------------------------------------------
// Regras
// ---------------------------------------------------------------------------

function concentracaoPorHorario(d, ctx) {
  const geral = d.resumo.pctPedidosAtrasados;
  const elegiveis = d.demandaPorHora.filter((h) => h.avaliados >= L.horaMinAvaliados);
  if (geral == null || !elegiveis.length) return ctx.naoAvaliada("concentracao_horario", `nenhum horário com ${L.horaMinAvaliados}+ pedidos avaliados`);
  const criticas = elegiveis
    .filter((h) => h.atrasados >= L.horaMinAtrasados && h.pctAtrasados >= geral * L.horaFatorSobreGeral && h.pctAtrasados - geral >= L.horaMinDiferencaPP)
    .sort((a, b) => b.pctAtrasados - a.pctAtrasados)
    .slice(0, 3);
  if (!criticas.length) return null;
  const totalAtrasados = d.resumo.pedidosAtrasados;
  const nasFaixas = criticas.reduce((s, h) => s + h.atrasados, 0);
  const picos = [...d.demandaPorHora].sort((a, b) => b.pedidos - a.pedidos).slice(0, 3).map((h) => h.hora);
  const coincidePico = criticas.some((h) => picos.includes(h.hora));
  const horas = new Set(criticas.map((h) => h.hora));
  return {
    tipo: "concentracao_horario",
    titulo: "Concentração de atrasos por horário",
    severidade: criticas[0].pctAtrasados >= 50 ? "alta" : "media",
    constatacao: `${criticas.map((h) => `${faixaHora(h.hora)}: ${fmt(h.pctAtrasados)}% dos pedidos atrasados (${h.atrasados} de ${h.avaliados})`).join("; ")}. A média do período é ${fmt(geral)}%. Essas faixas somam ${nasFaixas} dos ${totalAtrasados} pedidos atrasados.`,
    indicador: "% de pedidos atrasados por hora do recebimento",
    referencia: `% de pedidos atrasados do período inteiro (${fmt(geral)}%)`,
    ocorrencias: nasFaixas,
    evidencias: {
      horas: criticas.map((h) => ({ hora: h.hora, faixa: faixaHora(h.hora), pedidos: h.pedidos, avaliados: h.avaliados, atrasados: h.atrasados, pctAtrasados: h.pctAtrasados })),
      pedidos: pedidosAtrasados(ctx.itens, d.etapas, (i) => horas.has(i.hora)),
    },
    hipotese: coincidePico
      ? "A faixa também está entre as de maior demanda do período: o volume pode estar acima da capacidade nesse horário. Não comprovado — a Central não registra escala nem equipe."
      : null,
    recomendacao: `Conferir a escala, a produção antecipada e a disponibilidade de entregadores em ${criticas.map((h) => faixaHora(h.hora)).join(", ")}.`,
  };
}

function diasCriticos(d, ctx) {
  const geral = d.resumo.pctPedidosAtrasados;
  const elegiveis = d.evolucaoDiaria.filter((x) => x.pedidosAvaliados >= L.diaMinAvaliados);
  if (geral == null || elegiveis.length < 2) return ctx.naoAvaliada("dias_criticos", `menos de 2 dias com ${L.diaMinAvaliados}+ pedidos avaliados`);
  const criticos = elegiveis
    .filter((x) => x.pctPedidosAtrasados - geral >= L.diaMinDiferencaPP && x.pctPedidosAtrasados >= geral * L.diaFatorSobreGeral)
    .sort((a, b) => b.pctPedidosAtrasados - a.pctPedidosAtrasados);
  if (!criticos.length) return null;
  const datas = new Set(criticos.map((x) => x.data));
  return {
    tipo: "dias_criticos",
    titulo: "Dias críticos",
    severidade: criticos.length >= 3 ? "alta" : "media",
    constatacao: `${plural(criticos.length, "dia ficou", "dias ficaram")} bem acima da média de atrasos do período (${fmt(geral)}%): ${criticos.slice(0, 5).map((x) => `${dataBr(x.data)} com ${fmt(x.pctPedidosAtrasados)}% (${x.pedidosAtrasados} de ${x.pedidosAvaliados})`).join("; ")}${criticos.length > 5 ? "; …" : ""}.`,
    indicador: "% de pedidos atrasados por dia",
    referencia: `média do período (${fmt(geral)}%); dia crítico = ${L.diaMinDiferencaPP}+ pontos e ${L.diaFatorSobreGeral}× acima`,
    ocorrencias: criticos.length,
    evidencias: {
      dias: criticos.map((x) => ({ data: x.data, pedidos: x.pedidos, avaliados: x.pedidosAvaliados, atrasados: x.pedidosAtrasados, pctAtrasados: x.pctPedidosAtrasados })),
      pedidos: pedidosAtrasados(ctx.itens, d.etapas, (i) => datas.has(i.data)),
    },
    hipotese: null,
    recomendacao: "Revisar o que foi diferente nesses dias (equipe, falta de insumo, promoção, clima) com quem estava na operação.",
  };
}

function variacaoEntrePeriodos(d, ctx) {
  const saidas = [];
  for (const e of d.etapas) {
    const c = d.comparacao.porEtapa[e];
    if ((c.amostras.atual ?? 0) < L.compMinAmostras || (c.amostras.anterior ?? 0) < L.compMinAmostras) {
      ctx.naoAvaliada(`variacao_${e}`, `${NOME_ETAPA[e]}: menos de ${L.compMinAmostras} medições em um dos períodos`);
      continue;
    }
    const med = c.mediana;
    const varMed = med.variacaoPct;
    const mudouMediana = varMed != null && Math.abs(varMed) >= L.compMinVariacaoPct && Math.abs(med.diferenca) >= L.compMinVariacaoMin;
    const pp = c.pctDentro.diferencaPP;
    const mudouMeta = pp != null && Math.abs(pp) >= L.compMinVariacaoPP;
    if (!mudouMediana && !mudouMeta) continue;
    // Tempo maior = pior; % dentro menor = pior. Sinais opostos = resultado misto.
    const pioraMed = mudouMediana && med.diferenca > 0;
    const melhoraMed = mudouMediana && med.diferenca < 0;
    const pioraMeta = mudouMeta && pp < 0;
    const melhoraMeta = mudouMeta && pp > 0;
    const piora = (pioraMed || pioraMeta) && !(melhoraMed || melhoraMeta);
    const melhora = (melhoraMed || melhoraMeta) && !(pioraMed || pioraMeta);
    const sentido = piora ? "piora" : melhora ? "melhora" : "misto";
    const partes = [];
    if (mudouMediana) partes.push(`mediana de ${fmt(med.anterior)} para ${fmt(med.atual)} min (${med.variacaoPct > 0 ? "+" : ""}${fmt(med.variacaoPct)}%)`);
    if (mudouMeta) partes.push(`dentro da meta de ${fmt(c.pctDentro.anterior)}% para ${fmt(c.pctDentro.atual)}% (${pp > 0 ? "+" : ""}${fmt(pp)} p.p.)`);
    saidas.push({
      tipo: `${sentido}_${e}`,
      titulo: `${sentido === "piora" ? "Piora" : sentido === "melhora" ? "Melhora" : "Variação mista"} em ${NOME_ETAPA[e].toLowerCase()}`,
      severidade: sentido === "piora" ? "media" : "informativa",
      constatacao: `${NOME_ETAPA[e]}: ${partes.join("; ")}, comparado ao período anterior.`,
      indicador: `${NOME_ETAPA[e]} — mediana e % dentro da meta`,
      referencia: `período anterior equivalente (${dataBr(d.periodo.anterior.inicio)} a ${dataBr(d.periodo.anterior.fim)}${d.periodo.anterior.ate ? ", cortado no mesmo horário" : ""})`,
      ocorrencias: c.amostras.atual,
      evidencias: { comparacao: { etapa: e, ...c } },
      hipotese: null,
      recomendacao: sentido === "piora" ? `Acompanhar ${NOME_ETAPA[e].toLowerCase()} nos próximos dias e conferir os pedidos mais lentos (lista de atrasos).` : null,
    });
  }
  return saidas;
}

function mediana(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function preparoAnormal(d, ctx) {
  if (!d.etapas.includes("preparo")) return null;
  const dias = d.evolucaoDiaria.filter((x) => (x.porEtapa.preparo?.amostras ?? 0) >= L.anomMinAmostrasDia && x.porEtapa.preparo.mediana != null);
  if (dias.length < L.anomMinDias) return ctx.naoAvaliada("preparo_anormal", `menos de ${L.anomMinDias} dias com ${L.anomMinAmostrasDia}+ preparos medidos`);
  const meds = dias.map((x) => x.porEtapa.preparo.mediana);
  const base = mediana(meds);
  const mad = mediana(meds.map((m) => Math.abs(m - base))) * 1.4826; // desvio robusto (consistente com o desvio-padrão)
  const limite = base + Math.max(L.anomFatorMad * mad, L.anomMinExcessoMin);
  const anormais = dias.filter((x) => x.porEtapa.preparo.mediana > limite).sort((a, b) => b.porEtapa.preparo.mediana - a.porEtapa.preparo.mediana);
  if (!anormais.length) return null;
  const datas = new Set(anormais.map((x) => x.data));
  return {
    tipo: "preparo_anormal",
    titulo: "Aumento anormal do tempo de preparo",
    severidade: "media",
    constatacao: `${plural(anormais.length, "dia teve", "dias tiveram")} preparo mediano acima do normal do período (${fmt(base)} min; limite ${fmt(limite)} min): ${anormais.slice(0, 5).map((x) => `${dataBr(x.data)} com ${fmt(x.porEtapa.preparo.mediana)} min (${x.porEtapa.preparo.amostras} preparos)`).join("; ")}.`,
    indicador: "Preparo — mediana diária",
    referencia: `mediana das medianas diárias (${fmt(base)} min) + ${L.anomFatorMad}× o desvio robusto (mínimo ${L.anomMinExcessoMin} min)`,
    ocorrencias: anormais.length,
    evidencias: {
      dias: anormais.map((x) => ({ data: x.data, medianaMin: x.porEtapa.preparo.mediana, amostras: x.porEtapa.preparo.amostras })),
      pedidos: pedidosAtrasados(ctx.itens, ["preparo"], (i) => datas.has(i.data)),
    },
    hipotese: null,
    recomendacao: "Verificar nesses dias a montagem da linha, reposição de insumos e o tempo até o despacho (o preparo vai da chegada à saída do pedido).",
  };
}

function concentracaoPorEtapa(d, ctx) {
  if (d.etapas.length < 2) return null;
  const atrasos = d.etapas.map((e) => ({ etapa: e, atrasos: d.resumo.porEtapa[e].atrasos, avaliadas: d.resumo.porEtapa[e].avaliadas }));
  const total = atrasos.reduce((s, x) => s + x.atrasos, 0);
  if (total < L.etapaMinAtrasos) return ctx.naoAvaliada("concentracao_etapa", `menos de ${L.etapaMinAtrasos} atrasos no período`);
  const maior = atrasos.reduce((a, b) => (b.atrasos > a.atrasos ? b : a));
  const part = maior.atrasos / total;
  if (part < L.etapaMinParticipacao) return null;
  return {
    tipo: "concentracao_etapa",
    titulo: "Atrasos concentrados em uma etapa",
    severidade: "media",
    constatacao: `${NOME_ETAPA[maior.etapa]} responde por ${fmt(part * 100)}% dos atrasos do período (${maior.atrasos} de ${total}).`,
    indicador: "atrasos por etapa",
    referencia: `soma dos atrasos de ${d.etapas.map((e) => NOME_ETAPA[e].toLowerCase()).join(", ")}`,
    ocorrencias: maior.atrasos,
    evidencias: { etapas: atrasos, pedidos: pedidosAtrasados(ctx.itens, [maior.etapa]) },
    hipotese: maior.etapa === "vida"
      ? "A vida do pedido é a soma do preparo com a entrega: o atraso pode vir de qualquer um dos dois trechos. Não comprovado."
      : null,
    recomendacao: `Priorizar a etapa de ${NOME_ETAPA[maior.etapa].toLowerCase()} na revisão do processo.`,
  };
}

function reincidencias(d, ctx) {
  const porDiaHora = new Map();
  for (const i of ctx.itens) {
    if (!pedidoAvaliado(i, d.etapas)) continue;
    const k = `${i.data}|${i.hora}`;
    const x = porDiaHora.get(k) ?? { data: i.data, hora: i.hora, avaliados: 0, atrasados: 0 };
    x.avaliados += 1;
    if (pedidoAtrasado(i, d.etapas)) x.atrasados += 1;
    porDiaHora.set(k, x);
  }
  if (d.periodo.dias < L.reincMinDias) return ctx.naoAvaliada("reincidencia", `período com menos de ${L.reincMinDias} dias`);
  const ruins = [...porDiaHora.values()].filter((x) => x.atrasados >= L.reincMinAtrasadosNaHora && (x.atrasados / x.avaliados) * 100 >= L.reincMinPctNaHora);
  const porHora = new Map();
  for (const x of ruins) (porHora.get(x.hora) ?? porHora.set(x.hora, []).get(x.hora)).push(x);
  const reincidentes = [...porHora.entries()].filter(([, xs]) => xs.length >= L.reincMinDias).sort((a, b) => b[1].length - a[1].length).slice(0, 3);
  if (!reincidentes.length) return null;
  const chaves = new Set(reincidentes.flatMap(([, xs]) => xs.map((x) => `${x.data}|${x.hora}`)));
  return {
    tipo: "reincidencia",
    titulo: "Reincidência no mesmo horário",
    severidade: "alta",
    constatacao: reincidentes.map(([h, xs]) => `${faixaHora(h)} teve metade ou mais dos pedidos atrasados em ${xs.length} dias diferentes (${xs.map((x) => dataBr(x.data)).join(", ")})`).join("; ") + ".",
    indicador: "pedidos atrasados por dia e hora",
    referencia: `${L.reincMinPctNaHora}%+ dos pedidos da hora atrasados (mínimo ${L.reincMinAtrasadosNaHora}) em ${L.reincMinDias}+ dias`,
    ocorrencias: reincidentes.reduce((s, [, xs]) => s + xs.length, 0),
    evidencias: {
      ocorrencias: reincidentes.flatMap(([, xs]) => xs).map((x) => ({ data: x.data, hora: x.hora, faixa: faixaHora(x.hora), avaliados: x.avaliados, atrasados: x.atrasados })),
      pedidos: pedidosAtrasados(ctx.itens, d.etapas, (i) => chaves.has(`${i.data}|${i.hora}`)),
    },
    hipotese: null,
    recomendacao: "Problema recorrente no mesmo horário: tratar como ajuste de rotina (escala, pré-preparo), não como caso isolado.",
  };
}

function desempenhoContraMetas(d, ctx) {
  const saidas = [];
  for (const e of d.etapas) {
    const x = d.resumo.porEtapa[e];
    if (!x.avaliadas) {
      ctx.naoAvaliada(`metas_${e}`, `${NOME_ETAPA[e]}: nenhuma medição com meta vigente`);
      continue;
    }
    const versoes = d.metasAplicaveis.versoes.map((v) => v.valores?.[e]?.meta).filter((v) => v != null);
    const metasTxt = [...new Set(versoes)].map((v) => `${fmt(v)} min`).join(" / ") || "—";
    saidas.push({
      tipo: `metas_${e}`,
      titulo: `${NOME_ETAPA[e]} contra a meta`,
      severidade: x.pctDentro < L.metaAltaAbaixoPct ? "alta" : x.pctDentro < L.metaAtencaoAbaixoPct ? "media" : "informativa",
      constatacao: `${fmt(x.pctDentro)}% das ${x.avaliadas} medições de ${NOME_ETAPA[e].toLowerCase()} ficaram dentro da meta vigente (${metasTxt}); ${x.atrasos} acima.${x.maiorAtraso ? ` Maior atraso: ${fmt(x.maiorAtraso.excedenteMin)} min acima (pedido ${x.maiorAtraso.displayId ? `#${x.maiorAtraso.displayId}` : "sem número"}).` : ""}`,
      indicador: `${NOME_ETAPA[e]} — % dentro da meta`,
      referencia: `meta vigente no recebimento de cada pedido${x.semMetaVigente ? `; ${x.semMetaVigente} medições sem meta vigente ficaram fora` : ""}`,
      ocorrencias: x.atrasos,
      evidencias: { pedidos: pedidosAtrasados(ctx.itens, [e]) },
      hipotese: null,
      recomendacao: x.pctDentro < L.metaAtencaoAbaixoPct ? `Analisar os pedidos mais lentos de ${NOME_ETAPA[e].toLowerCase()} e confirmar se a meta atual é viável para a operação.` : null,
    });
  }
  return saidas;
}

const ORDEM_SEVERIDADE = { alta: 0, media: 1, informativa: 2 };

/**
 * @param {ReturnType<import("./checklistOperacional.indicadores.js").montarDashboard>} dashboard (com `_itens`)
 * @returns {{itens: object[], naoAvaliadas: {regra: string, motivo: string}[], limiares: object, aviso: string}}
 */
export function gerarAnalises(dashboard) {
  const naoAvaliadas = [];
  const ctx = {
    itens: dashboard._itens ?? [],
    naoAvaliada: (regra, motivo) => { naoAvaliadas.push({ regra, motivo }); return null; },
  };
  const regras = [concentracaoPorHorario, diasCriticos, variacaoEntrePeriodos, preparoAnormal, concentracaoPorEtapa, reincidencias, desempenhoContraMetas];
  const itens = regras.flatMap((r) => [r(dashboard, ctx)].flat()).filter(Boolean)
    .map((a) => ({ ...a, periodo: periodoDe(dashboard), natureza: { constatacao: "fato", hipotese: a.hipotese ? "hipotese" : null, recomendacao: a.recomendacao ? "recomendacao" : null } }))
    .sort((a, b) => ORDEM_SEVERIDADE[a.severidade] - ORDEM_SEVERIDADE[b.severidade]);
  return {
    itens,
    naoAvaliadas,
    limiares: LIMIARES,
    aviso: "Análises calculadas por regras fixas sobre os pedidos registrados. Constatação é fato medido; hipótese não é comprovada; recomendação é sugestão operacional.",
  };
}
