// Motor de indicadores do DASHBOARD OPERACIONAL — funções PURAS (sem I/O),
// mesmo espírito de parserFoodDelivery.calc.js/classificacao.js: recebem os
// pedidos JÁ elegíveis para conciliação (Subway + com entregador, overrides
// aplicados — mesmo array que resumoConciliacao()/agruparPorEntregador()
// consomem em parserFoodDelivery.service.js) e devolvem uma estrutura pronta
// para a aba "Dashboard" do Parser Food Delivery.
//
// Regra de ouro: nunca inventa dado. Timestamp/prazo ausente ou inválido
// nunca vira zero silencioso — fica de fora do indicador correspondente
// (ex.: pedido sem `prazoEntrega` vai para "sem_prazo", nunca conta como
// "no prazo" nem "fora do prazo").
import { ehCancelado, chaveEntregador, temEntregador, STATUS_CONCILIACAO } from "./parserFoodDelivery.calc.js";

const paraMs = (iso) => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * Minutos entre dois timestamps ISO, só quando os dois existem, são datas
 * válidas e `fim` não é anterior a `ini` — nunca duração negativa, nunca 0
 * fabricado para um dado ausente (item 15 do pedido: 0 real ≠ dado inexistente).
 * @returns {number|null}
 */
function diffMinutos(iniIso, fimIso) {
  const ini = paraMs(iniIso), fim = paraMs(fimIso);
  if (ini == null || fim == null || fim < ini) return null;
  return (fim - ini) / 60000;
}

/** Data operacional do pedido (AAAA-MM-DD) — sempre a partir de `dataHora` (pedido recebido), nunca da data de importação. */
const dataOperacional = (p) => (p.dataHora ? String(p.dataHora).slice(0, 10) : null);

const media = (nums) => (nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null);
function mediana(nums) {
  if (!nums.length) return null;
  const ord = [...nums].sort((a, b) => a - b);
  const meio = Math.floor(ord.length / 2);
  return ord.length % 2 ? ord[meio] : (ord[meio - 1] + ord[meio]) / 2;
}
const arred = (n, casas = 1) => (n == null ? null : Math.round(n * 10 ** casas) / 10 ** casas);
const arredMoeda = (n) => arred(n, 2);

/** Pedido conta pra taxa (financeiramente válida) quando não foi excluído da conciliação — mesma regra de resumoConciliacao(). */
const taxaValida = (p) => p.statusConciliacao !== STATUS_CONCILIACAO.EXCLUIDO;

/** Nome de exibição estável — primeira grafia encontrada para a chave normalizada. */
function agrupadorEntregador() {
  const porChave = new Map();
  return {
    add(p, cb) {
      if (!temEntregador(p.entregador)) return;
      const chave = chaveEntregador(p.entregador);
      if (!porChave.has(chave)) porChave.set(chave, { entregador: String(p.entregador).trim().replace(/\s+/g, " "), chave });
      cb(porChave.get(chave));
    },
    valores: () => [...porChave.values()],
  };
}

// ---------------------------------------------------------------------------
// ETAPA 4/5 — rankings de entregadores
// ---------------------------------------------------------------------------
function entregadoresPorEntregas(concluidos) {
  const g = agrupadorEntregador();
  for (const p of concluidos) g.add(p, (acc) => { acc.quantidade = (acc.quantidade || 0) + 1; });
  return g.valores().map((v) => ({ entregador: v.entregador, chave: v.chave, quantidade: v.quantidade || 0 }))
    .sort((a, b) => b.quantidade - a.quantidade);
}

function entregadoresPorTaxas(pedidos) {
  const g = agrupadorEntregador();
  for (const p of pedidos) {
    if (!taxaValida(p)) continue;
    g.add(p, (acc) => { acc.taxas = (acc.taxas || 0) + (Number(p.taxaEntregador) || 0); });
  }
  return g.valores().map((v) => ({ entregador: v.entregador, chave: v.chave, taxas: arredMoeda(v.taxas || 0) }))
    .sort((a, b) => b.taxas - a.taxas);
}

// ---------------------------------------------------------------------------
// ETAPA 6 — tempo médio por situação (marcos consecutivos da timeline real)
// ---------------------------------------------------------------------------
const MARCOS_SITUACAO = [
  { chave: "aberto", rotulo: "Aberto", de: "dataHora", ate: "dataPronto" },
  { chave: "pronto", rotulo: "Pronto", de: "dataPronto", ate: "dataDespachado" },
  { chave: "despachado", rotulo: "Despachado", de: "dataDespachado", ate: "dataAceito" },
  { chave: "aceito", rotulo: "Aceito", de: "dataAceito", ate: "dataColetado" },
  { chave: "coletado", rotulo: "Coletado", de: "dataColetado", ate: "dataChegadaEntrega" },
  { chave: "chegada", rotulo: "Chegada para entrega", de: "dataChegadaEntrega", ate: "dataEntregue" },
];
function tempoPorSituacao(pedidos) {
  return MARCOS_SITUACAO.map((m) => {
    const duracoes = pedidos.map((p) => diffMinutos(p[m.de], p[m.ate])).filter((d) => d != null);
    return {
      etapa: m.chave, rotulo: m.rotulo,
      mediaMin: duracoes.length ? arred(media(duracoes)) : null,
      amostras: duracoes.length,
    };
  }).filter((s) => s.amostras > 0); // marco sem NENHUMA evidência no relatório nem aparece — nunca 0 forçado
}

// ---------------------------------------------------------------------------
// ETAPA 8/9 — tempo de entrega (coletado -> entregue), por entregador e por dia
// ---------------------------------------------------------------------------
function temposColetaEntrega(pedidos) {
  return pedidos.map((p) => ({ p, min: diffMinutos(p.dataColetado, p.dataEntregue) })).filter((x) => x.min != null);
}

function tempoPorEntregador(concluidos) {
  const porChave = new Map();
  for (const { p, min } of temposColetaEntrega(concluidos)) {
    if (!temEntregador(p.entregador)) continue;
    const chave = chaveEntregador(p.entregador);
    if (!porChave.has(chave)) porChave.set(chave, { entregador: String(p.entregador).trim().replace(/\s+/g, " "), chave, tempos: [] });
    porChave.get(chave).tempos.push(min);
  }
  return [...porChave.values()].map((v) => ({
    entregador: v.entregador, chave: v.chave, quantidade: v.tempos.length,
    mediaMin: arred(media(v.tempos)), medianaMin: arred(mediana(v.tempos)),
    minMin: arred(Math.min(...v.tempos)), maxMin: arred(Math.max(...v.tempos)),
  })).sort((a, b) => b.quantidade - a.quantidade);
}

function tempoPorDia(concluidos) {
  const porDia = new Map();
  for (const { p, min } of temposColetaEntrega(concluidos)) {
    const dia = dataOperacional(p);
    if (!dia) continue;
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(min);
  }
  return [...porDia.entries()].map(([data, tempos]) => ({ data, quantidade: tempos.length, mediaMin: arred(media(tempos)) }))
    .sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
}

// ---------------------------------------------------------------------------
// ETAPA 10 — tempo médio de vida do pedido (abertura -> finalização), por dia,
// SEM misturar concluídos e cancelados (séries separadas).
// `dataFinalizado` é o marco de encerramento; quando o relatório não trouxe
// essa coluna (importações antigas), usa `dataEntregue` como equivalente
// para pedidos concluídos — nunca para cancelados (cancelado usa `dataCancelado`).
// ---------------------------------------------------------------------------
function vidaPedidoPorDiaSerie(pedidos, campoFim) {
  const porDia = new Map();
  for (const p of pedidos) {
    const fim = p[campoFim] ?? (campoFim === "dataFinalizado" ? p.dataEntregue : null);
    const min = diffMinutos(p.dataHora, fim);
    if (min == null) continue;
    const dia = dataOperacional(p);
    if (!dia) continue;
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(min);
  }
  return [...porDia.entries()].map(([data, tempos]) => ({ data, quantidade: tempos.length, mediaMin: arred(media(tempos)) }))
    .sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
}

// ---------------------------------------------------------------------------
// ETAPA 7 — pontualidade ("Entregas no prazo"). Compara `dataEntregue`
// (momento real da entrega) contra `prazoEntrega` (prazo prometido, coluna
// real "Prazo de entrega"). NUNCA usa `dataFinalizado`: esse marco pode
// acontecer depois da entrega e geraria atraso falso. Só pedidos CONCLUÍDOS
// (não cancelados) participam.
// ---------------------------------------------------------------------------
const MIN_AMOSTRA_RANKING_PONTUALIDADE = 5; // abaixo disso 1 pedido já move o % em >=20pp — ruído demais pra apontar "melhor/pior entregador"

/**
 * Classifica UM pedido concluído quanto à pontualidade. Nunca força um
 * valor: timestamp ausente OU inválido é tratado como ausente (não vira
 * "no prazo" nem "fora do prazo" por engano).
 * @returns {'no_prazo'|'fora_do_prazo'|'sem_prazo'|'sem_data_entrega'}
 */
function classificarPontualidade(p) {
  const msEntregue = paraMs(p.dataEntregue);
  if (msEntregue == null) return "sem_data_entrega";
  const msPrazo = paraMs(p.prazoEntrega);
  if (msPrazo == null) return "sem_prazo";
  return msEntregue <= msPrazo ? "no_prazo" : "fora_do_prazo";
}

function resumoAtraso(atrasos) {
  return {
    medioMin: atrasos.length ? arred(media(atrasos)) : null,
    medianaMin: atrasos.length ? arred(mediana(atrasos)) : null,
    maiorMin: atrasos.length ? arred(Math.max(...atrasos)) : null,
    quantidade: atrasos.length,
  };
}

function pontualidade(concluidos) {
  const porChave = new Map();
  const porDia = new Map();
  const geral = { noPrazo: 0, foraDoPrazo: 0, semPrazo: 0, semDataEntrega: 0 };
  const atrasosGerais = [];

  for (const p of concluidos) {
    const status = classificarPontualidade(p);
    geral[status === "no_prazo" ? "noPrazo" : status === "fora_do_prazo" ? "foraDoPrazo" : status === "sem_prazo" ? "semPrazo" : "semDataEntrega"]++;
    const atrasoMin = status === "fora_do_prazo" ? diffMinutos(p.prazoEntrega, p.dataEntregue) : null;
    if (atrasoMin != null) atrasosGerais.push(atrasoMin);

    if (temEntregador(p.entregador)) {
      const chave = chaveEntregador(p.entregador);
      if (!porChave.has(chave)) porChave.set(chave, { entregador: String(p.entregador).trim().replace(/\s+/g, " "), chave, noPrazo: 0, foraDoPrazo: 0, semPrazo: 0, semDataEntrega: 0, atrasos: [] });
      const acc = porChave.get(chave);
      acc[status === "no_prazo" ? "noPrazo" : status === "fora_do_prazo" ? "foraDoPrazo" : status === "sem_prazo" ? "semPrazo" : "semDataEntrega"]++;
      if (atrasoMin != null) acc.atrasos.push(atrasoMin);
    }

    if (status === "no_prazo" || status === "fora_do_prazo") {
      const dia = dataOperacional(p);
      if (dia) {
        if (!porDia.has(dia)) porDia.set(dia, { noPrazo: 0, foraDoPrazo: 0 });
        porDia.get(dia)[status === "no_prazo" ? "noPrazo" : "foraDoPrazo"]++;
      }
    }
  }

  const classificaveis = geral.noPrazo + geral.foraDoPrazo;
  const porEntregador = [...porChave.values()].map((v) => {
    const classif = v.noPrazo + v.foraDoPrazo;
    return {
      entregador: v.entregador, chave: v.chave,
      noPrazo: v.noPrazo, foraDoPrazo: v.foraDoPrazo, semPrazo: v.semPrazo, semDataEntrega: v.semDataEntrega,
      classificaveis: classif,
      percentualNoPrazo: classif > 0 ? arred((v.noPrazo / classif) * 100) : null,
      atraso: resumoAtraso(v.atrasos),
    };
  }).sort((a, b) => b.classificaveis - a.classificaveis);

  const porDiaArr = [...porDia.entries()].map(([data, c]) => {
    const classif = c.noPrazo + c.foraDoPrazo;
    return { data, noPrazo: c.noPrazo, foraDoPrazo: c.foraDoPrazo, classificaveis: classif, percentualForaDoPrazo: classif > 0 ? arred((c.foraDoPrazo / classif) * 100) : null };
  }).sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));

  return {
    noPrazo: geral.noPrazo, foraDoPrazo: geral.foraDoPrazo, semPrazo: geral.semPrazo, semDataEntrega: geral.semDataEntrega,
    classificaveis, totalConcluidos: concluidos.length,
    percentualNoPrazo: classificaveis > 0 ? arred((geral.noPrazo / classificaveis) * 100) : null,
    percentualForaDoPrazo: classificaveis > 0 ? arred((geral.foraDoPrazo / classificaveis) * 100) : null,
    atraso: resumoAtraso(atrasosGerais),
    porEntregador, porDia: porDiaArr,
  };
}

// ---------------------------------------------------------------------------
// ETAPA "DISTÂNCIA" — distância ESTIMADA por entregador, a partir de
// `distanciaRaioKm` (única fonte real hoje: auditoria confirmou que
// "Distância em rota (km)" existe no relatório mas vem sempre vazia nas
// importações atuais). NUNCA chamar isso de "km rodados"/"percurso real" —
// raio é uma estimativa, não o trajeto de fato percorrido pelo entregador.
// `distanciaRotaKm` é ignorado aqui de propósito (persistido só para
// compatibilidade futura — ver parserFoodDelivery.parser.js/service.js).
// ---------------------------------------------------------------------------
const distanciaValida = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

function distanciaEstimada(pedidos) {
  const porChave = new Map();
  for (const p of pedidos) {
    if (!temEntregador(p.entregador)) continue;
    const chave = chaveEntregador(p.entregador);
    if (!porChave.has(chave)) {
      porChave.set(chave, {
        entregador: String(p.entregador).trim().replace(/\s+/g, " "), chave,
        distanciaKm: 0, entregasComDistancia: 0, pedidosElegiveis: 0,
        taxaConsiderada: 0, distanciaConsiderada: 0, pedidosConsiderados: 0,
      });
    }
    const acc = porChave.get(chave);
    acc.pedidosElegiveis++;
    const distOk = distanciaValida(p.distanciaRaioKm);
    if (distOk) { acc.distanciaKm += p.distanciaRaioKm; acc.entregasComDistancia++; }
    // "Taxa por km estimado" — só pedidos com taxa válida E distância válida
    // SIMULTANEAMENTE entram (base compatível: taxa sem distância não entra
    // no numerador; distância sem taxa válida não entra no denominador).
    // "Taxa válida" aqui é DUPLA: financeiramente válida (não excluída da
    // conciliação) E um número real presente — taxaEntregador ausente (null)
    // nunca vira 0 silencioso só porque a distância existe (item 15: 0 real
    // ≠ dado inexistente).
    const taxaOk = taxaValida(p) && typeof p.taxaEntregador === "number" && Number.isFinite(p.taxaEntregador) && p.taxaEntregador >= 0;
    if (distOk && taxaOk) {
      acc.taxaConsiderada += p.taxaEntregador;
      acc.distanciaConsiderada += p.distanciaRaioKm;
      acc.pedidosConsiderados++;
    }
  }

  const porEntregador = [...porChave.values()].map((v) => ({
    entregador: v.entregador, chave: v.chave,
    distanciaKm: arred(v.distanciaKm), entregasComDistancia: v.entregasComDistancia,
    taxaPorKmEstimado: v.distanciaConsiderada > 0 ? arredMoeda(v.taxaConsiderada / v.distanciaConsiderada) : null,
    pedidosConsiderados: v.pedidosConsiderados, pedidosElegiveis: v.pedidosElegiveis,
  })).sort((a, b) => b.distanciaKm - a.distanciaKm);

  const totais = [...porChave.values()].reduce((s, v) => ({
    taxaConsiderada: s.taxaConsiderada + v.taxaConsiderada, distanciaConsiderada: s.distanciaConsiderada + v.distanciaConsiderada,
    pedidosConsiderados: s.pedidosConsiderados + v.pedidosConsiderados, pedidosElegiveis: s.pedidosElegiveis + v.pedidosElegiveis,
  }), { taxaConsiderada: 0, distanciaConsiderada: 0, pedidosConsiderados: 0, pedidosElegiveis: 0 });

  return {
    disponivel: true,
    fonte: "raio",
    avisoFonte: "Soma das distâncias em raio informadas pelo relatório. Não representa necessariamente o percurso real realizado pelo entregador.",
    totalKm: arred(porEntregador.reduce((s, e) => s + e.distanciaKm, 0)),
    entregasComDistancia: porEntregador.reduce((s, e) => s + e.entregasComDistancia, 0),
    taxaPorKmEstimadoGeral: totais.distanciaConsiderada > 0 ? arredMoeda(totais.taxaConsiderada / totais.distanciaConsiderada) : null,
    pedidosConsiderados: totais.pedidosConsiderados, pedidosElegiveis: totais.pedidosElegiveis,
    porEntregador,
  };
}

// ---------------------------------------------------------------------------
// ETAPA 14 — análise operacional determinística (sem IA generativa)
// ---------------------------------------------------------------------------
function analiseOperacional({ porEntregas, porTaxas, porTempoEntrega, porDia, porDistancia, pontualidadeGeral, concluidos, cancelados }) {
  const maiorPor = (lista, campo) => lista.reduce((m, x) => (m == null || x[campo] > m[campo] ? x : m), null);
  const menorPor = (lista, campo) => lista.reduce((m, x) => (m == null || x[campo] < m[campo] ? x : m), null);
  const maiorDistancia = maiorPor(porDistancia.filter((e) => e.entregasComDistancia > 0), "distanciaKm");
  const diaMaiorAtraso = maiorPor(pontualidadeGeral.porDia, "percentualForaDoPrazo");
  // "Melhor"/"pior" entregador em pontualidade só entre quem tem amostra
  // mínima razoável (MIN_AMOSTRA_RANKING_PONTUALIDADE) — com poucas entregas
  // classificáveis, 1 pedido isolado desloca o % o bastante pra distorcer o
  // ranking (documentado, não é regra arbitrária: ver constante no topo do arquivo).
  const entregadoresRankeaveis = pontualidadeGeral.porEntregador.filter((e) => e.classificaveis >= MIN_AMOSTRA_RANKING_PONTUALIDADE);
  const entregadorMaiorPontualidade = maiorPor(entregadoresRankeaveis, "percentualNoPrazo");
  const entregadorMenorPontualidade = menorPor(entregadoresRankeaveis, "percentualNoPrazo");
  return {
    totalPedidosElegiveis: concluidos.length + cancelados.length,
    totalConcluidos: concluidos.length,
    totalCancelados: cancelados.length,
    entregadorMaiorVolume: porEntregas[0] ? { entregador: porEntregas[0].entregador, quantidade: porEntregas[0].quantidade } : null,
    entregadorMaiorTaxas: porTaxas[0] ? { entregador: porTaxas[0].entregador, taxas: porTaxas[0].taxas } : null,
    entregadorMenorTempoMedio: menorPor(porTempoEntrega, "mediaMin"),
    entregadorMaiorTempoMedio: maiorPor(porTempoEntrega, "mediaMin"),
    diaMenorTempoMedio: menorPor(porDia, "mediaMin"),
    diaMaiorTempoMedio: maiorPor(porDia, "mediaMin"),
    entregadorMaiorDistanciaEstimada: maiorDistancia ? { entregador: maiorDistancia.entregador, distanciaKm: maiorDistancia.distanciaKm } : null,
    pontualidadeGeral: pontualidadeGeral.classificaveis > 0 ? { percentualNoPrazo: pontualidadeGeral.percentualNoPrazo, classificaveis: pontualidadeGeral.classificaveis } : null,
    atrasoMedio: pontualidadeGeral.atraso.medioMin != null ? { medioMin: pontualidadeGeral.atraso.medioMin, quantidade: pontualidadeGeral.atraso.quantidade } : null,
    maiorAtraso: pontualidadeGeral.atraso.maiorMin != null ? { maiorMin: pontualidadeGeral.atraso.maiorMin } : null,
    diaMaiorPercentualAtraso: diaMaiorAtraso ? { data: diaMaiorAtraso.data, percentualForaDoPrazo: diaMaiorAtraso.percentualForaDoPrazo } : null,
    entregadorMaiorPontualidade: entregadorMaiorPontualidade ? { entregador: entregadorMaiorPontualidade.entregador, percentualNoPrazo: entregadorMaiorPontualidade.percentualNoPrazo, classificaveis: entregadorMaiorPontualidade.classificaveis } : null,
    entregadorMenorPontualidade: entregadorMenorPontualidade ? { entregador: entregadorMenorPontualidade.entregador, percentualNoPrazo: entregadorMenorPontualidade.percentualNoPrazo, classificaveis: entregadorMenorPontualidade.classificaveis } : null,
  };
}

/**
 * Monta a estrutura completa do Dashboard Operacional a partir dos pedidos
 * JÁ elegíveis (Subway + com entregador) de um período — mesmo array usado
 * por resumoConciliacao()/agruparPorEntregador() no service. Não faz I/O,
 * não conhece organização/unidade — o isolamento multi-tenant já aconteceu
 * uma camada acima, na consulta que produziu `pedidos`.
 * @param {Array<object>} pedidos formato da API (paraApiPedido), já com overrides aplicados
 */
export function calcularDashboardOperacional(pedidos) {
  const validos = (pedidos ?? []).filter((p) => temEntregador(p.entregador));
  const concluidos = validos.filter((p) => !ehCancelado(p.situacao));
  const cancelados = validos.filter((p) => ehCancelado(p.situacao));

  const porEntregas = entregadoresPorEntregas(concluidos);
  const porTaxas = entregadoresPorTaxas(validos);
  const porTempoEntrega = tempoPorEntregador(concluidos);
  const porDiaEntrega = tempoPorDia(concluidos);

  const temposGerais = temposColetaEntrega(concluidos).map((x) => x.min);
  const taxasTotal = arredMoeda(validos.filter(taxaValida).reduce((s, p) => s + (Number(p.taxaEntregador) || 0), 0));
  const dEstimada = distanciaEstimada(validos);
  const pPontualidade = pontualidade(concluidos);

  return {
    resumo: {
      totalEntregas: concluidos.length,
      taxasTotal,
      tempoMedioEntregaMin: temposGerais.length ? arred(media(temposGerais)) : null,
      entregadoresAtivos: porEntregas.length,
    },
    entregadoresPorEntregas: porEntregas,
    entregadoresPorTaxas: porTaxas,
    tempoPorSituacao: tempoPorSituacao(validos),
    pontualidade: pPontualidade,
    tempoPorEntregador: porTempoEntrega,
    tempoPorDia: porDiaEntrega,
    vidaPedidoPorDia: {
      concluidos: vidaPedidoPorDiaSerie(concluidos, "dataFinalizado"),
      cancelados: vidaPedidoPorDiaSerie(cancelados, "dataCancelado"),
    },
    distanciaEstimada: dEstimada,
    analiseOperacional: analiseOperacional({
      porEntregas, porTaxas, porTempoEntrega, porDia: porDiaEntrega,
      porDistancia: dEstimada.porEntregador, pontualidadeGeral: pPontualidade, concluidos, cancelados,
    }),
  };
}
