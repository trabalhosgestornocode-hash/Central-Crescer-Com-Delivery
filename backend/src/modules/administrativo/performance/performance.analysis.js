// Camada de ANÁLISE GERENCIAL da Central de Performance. Recebe a evolução
// mensal já consolidada (uma série por unidade, mais a série consolidada) e
// devolve tendências, status, metas, diagnósticos, pontos de investigação,
// prioridades e um resumo executivo — tudo DERIVADO EM RUNTIME, nada persistido.
//
// Princípios (pedido do gestor):
//  - Preferir a comparação histórica da própria unidade a cortes absolutos.
//  - Nenhuma regra depende do nome "Centro"/"Avenida": só dos indicadores.
//  - Separar "evidência nos dados" de "hipótese que exige investigação".
//  - Não chamar de "lucro real": o que temos é margem/retenção APÓS iFood.
//  - Respeitar a qualidade dos dados: competência incompleta/parcial baixa a
//    confiança e não gera diagnóstico forte.
import { numero, variacao } from './performance.calc.js';
import { configuracaoMetas, metasFaturamento, metaConversao } from './performance.targets.js';

const pct = v => v == null ? '—' : `${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
const pp = v => v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} p.p.`;
const varTxt = v => v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

const serie = (ev, k) => ev.map(p => numero(p?.indicadores?.[k]));
const naoNulos = s => s.filter(v => v != null);
function varAcumulada(s) { const n = naoNulos(s); return n.length >= 2 ? variacao(n.at(-1), n[0]) : null; }
function varMensal(s) { let u = null; for (let i = 1; i < s.length; i++) if (s[i] != null && s[i - 1] != null) u = variacao(s[i], s[i - 1]); return u; }
function deltaPp(s) { const n = naoNulos(s); return n.length >= 2 ? numero(n.at(-1) - n[0]) : null; }
function quedasConsecutivas(s) { const n = naoNulos(s); let c = 0; for (let i = n.length - 1; i > 0; i--) { if (n[i] < n[i - 1]) c++; else break; } return c; }
function estritamenteQueda(s) { const n = naoNulos(s); return n.length >= 2 && n.every((v, i) => i === 0 || v < n[i - 1]); }
const primeiro = s => naoNulos(s)[0] ?? null;
const ultimo = s => naoNulos(s).at(-1) ?? null;

// ---------------------------------------------------------------------------
// Classificadores de tendência (cada dimensão tem o seu vocabulário no pedido).
// ---------------------------------------------------------------------------
function classificarFaturamento(s, L) {
  const acum = varAcumulada(s), mensal = varMensal(s);
  if (acum == null) return { classificacao: 'SEM DADOS', variacaoAcumulada: null, variacaoMensal: mensal, quedasConsecutivas: 0, pontos: naoNulos(s).length };
  let c = 'ESTÁVEL';
  if (acum <= L.quedaForteAcumuladaPct || (mensal != null && mensal <= L.quedaForteMensalPct)) c = 'QUEDA FORTE';
  else if (acum <= L.quedaAcumuladaPct || (mensal != null && mensal <= L.quedaAcumuladaPct)) c = 'QUEDA';
  else if (acum >= L.crescimentoAcumuladaPct) c = 'CRESCIMENTO';
  return { classificacao: c, variacaoAcumulada: acum, variacaoMensal: mensal, quedasConsecutivas: quedasConsecutivas(s), pontos: naoNulos(s).length };
}
function classificarClientes(s, L) {
  const acum = varAcumulada(s), mensal = varMensal(s), quedas = quedasConsecutivas(s);
  if (acum == null) return { classificacao: 'SEM DADOS', variacaoAcumulada: null, variacaoMensal: mensal, quedasConsecutivas: quedas, pontos: naoNulos(s).length };
  let c = 'ESTÁVEL';
  if (acum <= L.clientesQuedaAcumuladaPct || quedas >= 2) c = 'CAINDO';
  else if (acum >= L.crescimentoAcumuladaPct) c = 'CRESCENDO';
  return { classificacao: c, variacaoAcumulada: acum, variacaoMensal: mensal, quedasConsecutivas: quedas, pontos: naoNulos(s).length };
}
function classificarMargem(s, L) {
  const d = deltaPp(s), n = naoNulos(s).length;
  if (d == null) return { classificacao: 'SEM DADOS', deltaPp: null, inicial: primeiro(s), final: ultimo(s), continua: false, pontos: n };
  const continua = estritamenteQueda(s);
  const c = d <= -L.margemPp ? 'DETERIORANDO' : d >= L.margemPp ? 'MELHORANDO' : 'ESTÁVEL';
  return { classificacao: c, deltaPp: d, inicial: primeiro(s), final: ultimo(s), continua, pontos: n };
}
function classificarCustosIfood(ev, L) {
  const custo = serie(ev, 'custoIfoodPct');
  const d = deltaPp(custo);
  const varDespesas = varAcumulada(serie(ev, 'despesasIfood'));
  const varFaturamento = varAcumulada(serie(ev, 'faturamento'));
  const descolamentoPp = varDespesas != null && varFaturamento != null ? numero(varDespesas - varFaturamento) : null;
  const comum = { deltaPp: d, inicial: primeiro(custo), final: ultimo(custo), varDespesas, varFaturamento, descolamentoPp, pontos: naoNulos(custo).length };
  if (d == null) return { classificacao: 'SEM DADOS', ...comum };
  const deteriora = d >= L.custoIfoodPp || (descolamentoPp != null && descolamentoPp >= L.custoDescolamentoPct);
  const melhora = d <= -L.custoIfoodPp && (descolamentoPp == null || descolamentoPp <= 0);
  return { classificacao: deteriora ? 'DETERIORANDO' : melhora ? 'MELHORANDO' : 'ESTÁVEL', ...comum };
}
// Entregadores: nunca um único mês, nunca somar iFood + externo. Uma leitura
// por fonte disponível (percentual sobre faturamento + custo por pedido).
function classificarEntregadoresFonte(pctSerie, cppSerie, L) {
  const d = deltaPp(pctSerie), cppVar = varAcumulada(cppSerie);
  const comum = { deltaPp: d, inicial: primeiro(pctSerie), final: ultimo(pctSerie), variacaoCustoPorPedido: cppVar, pontos: naoNulos(pctSerie).length };
  if (d == null) return { classificacao: 'SEM DADOS', ...comum };
  const cppPiora = cppVar != null && cppVar > 0;
  let c = 'MANUTENÇÃO';
  if (d >= L.entregadoresCorrecaoPp && cppPiora) c = 'CORREÇÃO';
  else if (d >= L.entregadoresAcompanharPp || cppPiora) c = 'ACOMPANHAR';
  return { classificacao: c, ...comum };
}

// ---------------------------------------------------------------------------
// Status por dimensão: SAUDÁVEL / ATENÇÃO / CRÍTICO / SEM DADOS.
// Sem meta explícita, usa tendência/sequência/deterioração relativa. Conversão
// pode usar a meta de 20%.
// ---------------------------------------------------------------------------
const ORDEM_STATUS = { 'CRÍTICO': 3, 'ATENÇÃO': 2, 'SAUDÁVEL': 1, 'SEM DADOS': 0 };
const piorStatus = (...xs) => xs.reduce((a, b) => (ORDEM_STATUS[b] > ORDEM_STATUS[a] ? b : a), 'SEM DADOS');
const statusFaturamento = t => ({ 'CRESCIMENTO': 'SAUDÁVEL', 'ESTÁVEL': 'SAUDÁVEL', 'QUEDA': 'ATENÇÃO', 'QUEDA FORTE': 'CRÍTICO', 'SEM DADOS': 'SEM DADOS' }[t.classificacao]);
function statusClientes(t) {
  if (t.classificacao === 'SEM DADOS') return 'SEM DADOS';
  if (t.classificacao === 'CAINDO') return t.quedasConsecutivas >= 3 || (t.variacaoAcumulada != null && t.variacaoAcumulada <= -20) ? 'CRÍTICO' : 'ATENÇÃO';
  return 'SAUDÁVEL';
}
function statusMargem(t, L) {
  if (t.classificacao === 'SEM DADOS') return 'SEM DADOS';
  if (t.classificacao === 'DETERIORANDO') return (t.deltaPp != null && t.deltaPp <= -2 * L.margemPp) || (t.continua && t.pontos >= 3) ? 'CRÍTICO' : 'ATENÇÃO';
  return 'SAUDÁVEL';
}
function statusCustos(t, L) {
  if (t.classificacao === 'SEM DADOS') return 'SEM DADOS';
  if (t.classificacao === 'DETERIORANDO') return t.descolamentoPp != null && t.descolamentoPp >= L.custoDescolamentoFortePct ? 'CRÍTICO' : 'ATENÇÃO';
  return 'SAUDÁVEL';
}
function statusConversao(m, L) {
  if (m.status === 'SEM DADOS') return 'SEM DADOS';
  if (m.status === 'DENTRO DA META') return 'SAUDÁVEL';
  return m.gapPp != null && m.gapPp <= -L.conversaoCriticaPp ? 'CRÍTICO' : 'ATENÇÃO';
}
function statusEntregadores(fontes) {
  const cls = fontes.filter(f => f && f.classificacao !== 'SEM DADOS')
    .map(f => ({ 'MANUTENÇÃO': 'SAUDÁVEL', 'ACOMPANHAR': 'ATENÇÃO', 'CORREÇÃO': 'CRÍTICO' }[f.classificacao]));
  return cls.length ? piorStatus(...cls) : 'SEM DADOS';
}

// ---------------------------------------------------------------------------
// Diagnósticos: evidência x hipótese. Nunca afirmar causa que os dados não
// provam (ex.: "perdeu ranking no iFood").
// ---------------------------------------------------------------------------
const PONTOS_INVESTIGACAO = [
  'Exposição e ranqueamento da loja no iFood',
  'Visitas ao cardápio e conversão da vitrine',
  'Campanhas, cupons e investimento em mídia no período',
  'Valor de frete percebido pelo cliente',
  'Disponibilidade da loja e horário efetivamente online',
  'Cancelamentos e itens indisponíveis',
  'Avaliações e nota da loja',
  'Tempo de preparo e de entrega',
  'Movimentação da concorrência local',
];

function diagnosticar(ev, t, m, L) {
  const D = [];
  const evi = (dim, texto) => D.push({ dimensao: dim, tipo: 'evidencia', texto });
  const hip = (dim, texto) => D.push({ dimensao: dim, tipo: 'hipotese', texto });
  const investigacao = [];

  const varFat = t.faturamento.variacaoAcumulada;
  const varPedidos = varAcumulada(serie(ev, 'pedidos'));
  const varTicket = varAcumulada(serie(ev, 'ticketMedio'));
  const varClientes = t.clientes.variacaoAcumulada;
  const emQueda = ['QUEDA', 'QUEDA FORTE'].includes(t.faturamento.classificacao);

  if (emQueda) {
    let explicado = false;
    if (varFat != null && varFat < 0 && varPedidos != null && varPedidos <= L.quedaAcumuladaPct && varTicket != null && varTicket >= -2) {
      evi('FATURAMENTO', `A queda de faturamento (${varTxt(varFat)}) está associada principalmente à redução do volume de pedidos (${varTxt(varPedidos)}), e não à redução do ticket médio (${varTxt(varTicket)}).`);
      explicado = true;
    } else if (varFat != null && varTicket != null && varTicket <= L.quedaAcumuladaPct && (varPedidos == null || varPedidos > L.quedaAcumuladaPct)) {
      evi('FATURAMENTO', `A queda de faturamento acompanha a retração do ticket médio (${varTxt(varTicket)}), com o volume de pedidos mais estável.`);
      explicado = true;
    }
    if (varClientes != null && varClientes <= L.clientesQuedaAcumuladaPct)
      evi('CLIENTES', `A redução na aquisição de novos clientes (${varTxt(varClientes)}) acompanha a queda de pedidos.`);
    if (!explicado || t.faturamento.classificacao === 'QUEDA FORTE') {
      if (!explicado) hip('FATURAMENTO', 'Os indicadores disponíveis não explicam sozinhos a queda de faturamento; a causa operacional precisa ser investigada.');
      investigacao.push(...PONTOS_INVESTIGACAO);
    }
  }

  const cu = t.custosIfood;
  if (cu.classificacao === 'DETERIORANDO') {
    if (cu.descolamentoPp != null && cu.descolamentoPp > 0)
      evi('CUSTOS_IFOOD', `Os custos do iFood cresceram proporcionalmente mais rápido que o faturamento (despesas ${varTxt(cu.varDespesas)} vs faturamento ${varTxt(cu.varFaturamento)}) e estão pressionando a margem após iFood.`);
    else
      evi('CUSTOS_IFOOD', `O custo do iFood sobre o faturamento subiu de ${pct(cu.inicial)} para ${pct(cu.final)} no período (${pp(cu.deltaPp)}).`);
  } else if (cu.classificacao === 'MELHORANDO') {
    evi('CUSTOS_IFOOD', `O custo do iFood sobre o faturamento recuou de ${pct(cu.inicial)} para ${pct(cu.final)} no período.`);
  }

  const mg = t.margemAposIfood;
  if (mg.classificacao === 'DETERIORANDO')
    evi('MARGEM_APOS_IFOOD', mg.continua
      ? `A margem após iFood apresenta deterioração contínua no período (de ${pct(mg.inicial)} para ${pct(mg.final)}).`
      : `A margem após iFood recuou de ${pct(mg.inicial)} para ${pct(mg.final)} no período (${pp(mg.deltaPp)}).`);
  else if (mg.classificacao === 'MELHORANDO')
    evi('MARGEM_APOS_IFOOD', `A margem após iFood melhorou de ${pct(mg.inicial)} para ${pct(mg.final)} no período.`);

  if (t.clientes.classificacao === 'CAINDO' && !D.some(x => x.dimensao === 'CLIENTES')) {
    const s = naoNulos(serie(ev, 'novosClientes'));
    evi('CLIENTES', `A aquisição de novos clientes apresenta deterioração no período (de ${s[0]} para ${s.at(-1)}).`);
  }

  const c = m.conversao.ultima;
  if (c && c.status === 'ABAIXO DA META')
    evi('CONVERSAO', `Conversão em ${c.competencia}: ${pct(c.atual)} ante meta de ${pct(c.meta)} (gap de ${pp(c.gapPp)}).`);

  for (const [f, nome] of [['ifood', 'Taxas de entregadores iFood'], ['externos', 'Custo externo de entregadores']]) {
    const e = t.entregadores[f];
    if (!e || e.classificacao === 'SEM DADOS') continue;
    if (e.classificacao === 'CORREÇÃO')
      evi('ENTREGADORES', `${nome}: percentual sobre faturamento e custo por pedido deteriorando de forma consistente (${pp(e.deltaPp)}). Situação de correção de custo — a Central aponta eficiência, não decisão operacional.`);
    else if (e.classificacao === 'ACOMPANHAR')
      evi('ENTREGADORES', `${nome}: percentual sobre faturamento em elevação gradual (${pp(e.deltaPp)}). Acompanhar a eficiência do custo.`);
  }
  return { diagnosticos: D, investigacao: [...new Set(investigacao)] };
}

// ---------------------------------------------------------------------------
// Prioridades: vêm da gravidade dos indicadores, não de uma lista fixa.
// ---------------------------------------------------------------------------
const PESO_DIMENSAO = { FATURAMENTO: 6, CLIENTES: 5, CONVERSAO: 4, MARGEM_APOS_IFOOD: 3, CUSTOS_IFOOD: 3, ENTREGADORES: 2 };
function prioridades(status, m) {
  const sev = { 'CRÍTICO': 2, 'ATENÇÃO': 1 };
  const texto = {
    FATURAMENTO: s => s === 'CRÍTICO' ? 'Recuperar volume de pedidos e faturamento' : 'Estabilizar o faturamento',
    CLIENTES: () => 'Recuperar a aquisição de novos clientes',
    CONVERSAO: () => `Elevar a conversão para pelo menos ${pct(m.conversao.meta)}`,
    MARGEM_APOS_IFOOD: () => 'Proteger a margem após iFood',
    CUSTOS_IFOOD: () => 'Conter o avanço dos custos do iFood',
    ENTREGADORES: () => 'Revisar a eficiência do custo de entregadores',
  };
  const itens = Object.entries(status)
    .filter(([, s]) => sev[s])
    .sort((a, b) => (sev[b[1]] - sev[a[1]]) || (PESO_DIMENSAO[b[0]] - PESO_DIMENSAO[a[0]]))
    .map(([dim, s], i) => ({ ordem: i + 1, dimensao: dim, severidade: s, texto: texto[dim](s) }));
  return itens.length ? itens : [{ ordem: 1, dimensao: null, severidade: null, texto: 'Manter o acompanhamento — nenhum indicador em nível de atenção.' }];
}

// ---------------------------------------------------------------------------
// Resumo executivo determinístico (sem IA), montado a partir dos indicadores.
// ---------------------------------------------------------------------------
const ROTULO_PRIORIDADE = {
  FATURAMENTO: 'recuperação de demanda', CLIENTES: 'recuperação de clientes', CONVERSAO: 'elevação da conversão',
  MARGEM_APOS_IFOOD: 'proteção de margem', CUSTOS_IFOOD: 'contenção de custos iFood', ENTREGADORES: 'eficiência de entregadores',
};
function resumoExecutivo(t, m, prios, varTicket) {
  const p0 = prios[0];
  const prioridade = p0.dimensao ? ROTULO_PRIORIDADE[p0.dimensao] : 'acompanhamento';
  const partes = [];
  const f = t.faturamento;
  if (f.classificacao === 'QUEDA FORTE') partes.push(`o faturamento apresenta forte retração (${varTxt(f.variacaoAcumulada)} no período)`);
  else if (f.classificacao === 'QUEDA') partes.push(`o faturamento recua no período (${varTxt(f.variacaoAcumulada)})`);
  else if (f.classificacao === 'CRESCIMENTO') partes.push(`o faturamento cresce no período (${varTxt(f.variacaoAcumulada)})`);
  else if (f.classificacao === 'ESTÁVEL') partes.push('o faturamento permanece relativamente estável');
  if (t.clientes.classificacao === 'CAINDO') partes.push('a aquisição de novos clientes cai');
  if (['QUEDA', 'QUEDA FORTE'].includes(f.classificacao) && varTicket != null && varTicket >= -2) partes.push('o ticket médio não explica a queda');
  if (t.custosIfood.classificacao === 'DETERIORANDO') partes.push('os custos do iFood cresceram proporcionalmente no período');
  if (t.margemAposIfood.classificacao === 'DETERIORANDO') partes.push('a margem após iFood se deteriora');
  if (m.conversao.ultima?.status === 'ABAIXO DA META') partes.push(`a conversão está abaixo da meta de ${pct(m.conversao.meta)}`);
  const corpo = partes.length ? `${partes.join(', ')}.` : 'os indicadores disponíveis não apontam deterioração relevante.';
  return { prioridade, texto: `Prioridade: ${prioridade}. ${corpo.charAt(0).toUpperCase()}${corpo.slice(1)}` };
}

// ---------------------------------------------------------------------------
// Qualidade dos dados: cobertura e confiança do que foi dito acima.
// ---------------------------------------------------------------------------
function qualidade(ev, L) {
  const comDados = ev.filter(c => naoNulos(Object.values(c.indicadores ?? {})).length > 0);
  const incompletas = ev.filter(c => c.incompleto);
  const parciais = ev.filter(c => c.parcial);
  const semDados = ev.filter(c => !comDados.includes(c));
  const financeiroAte = ev.map(c => c.financeiroAte).filter(Boolean).at(-1) ?? null;
  const cobertura = comDados.length < L.minPontos ? 'insuficiente' : (incompletas.length || parciais.length) ? 'parcial' : 'completa';
  const confianca = cobertura === 'insuficiente' ? 'baixa' : cobertura === 'parcial' ? 'media' : 'alta';
  const avisos = [];
  if (cobertura === 'insuficiente') avisos.push('Cobertura insuficiente: menos de duas competências com dados. As classificações de tendência ficam suspensas.');
  if (parciais.length && ev.at(-1)?.parcial && financeiroAte) avisos.push(`Análise parcial: o financeiro oficial da competência mais recente cobre somente até ${financeiroAte}.`);
  if (incompletas.length && !parciais.length) avisos.push('Há competências incompletas no período: leia tendências e variações como provisórias.');
  return { competenciasNoPeriodo: ev.length, competenciasComDados: comDados.length,
    competenciasIncompletas: incompletas.map(c => c.competencia), competenciasParciais: parciais.map(c => c.competencia),
    competenciasSemDados: semDados.map(c => c.competencia), financeiroAte, cobertura, confianca, avisos };
}

// ---------------------------------------------------------------------------
// Bloco de metas (faturamento +7/+10, conversão vs 20%, novos clientes).
// ---------------------------------------------------------------------------
function metasBloco(ev, metas, tendClientes) {
  const sFat = serie(ev, 'faturamento');
  const q = naoNulos(serie(ev, 'novosClientes'));
  const conv = ev.map(c => ({ competencia: c.competencia, ...metaConversao(numero(c.indicadores?.conversao), metas) }));
  const ultima = [...conv].reverse().find(c => c.status !== 'SEM DADOS') ?? null;
  return {
    faturamento: metasFaturamento(ultimo(sFat), metas),
    conversao: { meta: metas.conversaoMinima, porCompetencia: conv, ultima },
    novosClientes: { atual: q.at(-1) ?? null, anterior: q.at(-2) ?? null,
      variacao: q.length >= 2 ? variacao(q.at(-1), q.at(-2)) : null, tendencia: tendClientes.classificacao },
    crescimento: { minimo: metas.crescimentoMinimo, desejado: metas.crescimentoDesejado },
  };
}

// ---------------------------------------------------------------------------
// Análise de uma série mensal (unidade ou consolidado).
// ---------------------------------------------------------------------------
export function analisarSerie(evolucao, opcoes = {}) {
  const metas = opcoes.metas ?? configuracaoMetas();
  const L = metas.limiares;
  const ev = Array.isArray(evolucao) ? evolucao : [];
  const q = qualidade(ev, L);

  const tendencias = {
    faturamento: classificarFaturamento(serie(ev, 'faturamento'), L),
    clientes: classificarClientes(serie(ev, 'novosClientes'), L),
    margemAposIfood: classificarMargem(serie(ev, 'retencaoAposIfoodPct'), L),
    custosIfood: classificarCustosIfood(ev, L),
    entregadores: {
      ifood: classificarEntregadoresFonte(serie(ev, 'custoEntregadoresPct'), serie(ev, 'custoPorPedido'), L),
      externos: classificarEntregadoresFonte(serie(ev, 'custoExternosPct'), serie(ev, 'custoExternoPorPedido'), L),
    },
    ticketMedio: { variacaoAcumulada: varAcumulada(serie(ev, 'ticketMedio')), variacaoMensal: varMensal(serie(ev, 'ticketMedio')) },
  };
  const m = metasBloco(ev, metas, tendencias.clientes);
  const periodo = { inicio: ev[0]?.competencia ?? null, fim: ev.at(-1)?.competencia ?? null, meses: ev.length, comDados: q.competenciasComDados };

  // Cobertura insuficiente: não arriscar tendência/diagnóstico forte (seção 20).
  if (q.cobertura === 'insuficiente') {
    const stConv = statusConversao(m.conversao.ultima ?? { status: 'SEM DADOS', gapPp: null }, L);
    return {
      periodo,
      tendencias: Object.fromEntries(Object.entries(tendencias).map(([k, v]) => [k, k === 'entregadores' ? { ifood: { classificacao: 'SEM DADOS' }, externos: { classificacao: 'SEM DADOS' } } : { ...v, classificacao: 'SEM DADOS' }])),
      metas: m,
      status: { FATURAMENTO: 'SEM DADOS', CUSTOS_IFOOD: 'SEM DADOS', MARGEM_APOS_IFOOD: 'SEM DADOS', CLIENTES: 'SEM DADOS', CONVERSAO: stConv, ENTREGADORES: 'SEM DADOS' },
      diagnosticos: [], investigacao: [], prioridades: prioridades({ CONVERSAO: stConv }, m),
      resumo: { prioridade: 'acompanhamento', texto: 'Dados insuficientes no período para um diagnóstico gerencial de tendências. Complete as competências para habilitar a análise.' },
      qualidade: q,
    };
  }

  const status = {
    FATURAMENTO: statusFaturamento(tendencias.faturamento),
    CUSTOS_IFOOD: statusCustos(tendencias.custosIfood, L),
    MARGEM_APOS_IFOOD: statusMargem(tendencias.margemAposIfood, L),
    CLIENTES: statusClientes(tendencias.clientes),
    CONVERSAO: statusConversao(m.conversao.ultima ?? { status: 'SEM DADOS', gapPp: null }, L),
    ENTREGADORES: statusEntregadores([tendencias.entregadores.ifood, tendencias.entregadores.externos]),
  };
  const { diagnosticos, investigacao } = diagnosticar(ev, tendencias, m, L);
  const prios = prioridades(status, m);
  const resumo = resumoExecutivo(tendencias, m, prios, tendencias.ticketMedio.variacaoAcumulada);
  return { periodo, tendencias, metas: m, status, diagnosticos, investigacao, prioridades: prios, resumo, qualidade: q };
}

// ---------------------------------------------------------------------------
// Comparação entre unidades (quando "Todas as unidades" está selecionado).
// Nunca declara "melhor" numa métrica ausente.
// ---------------------------------------------------------------------------
export function compararUnidades(unidades) {
  // unidades: [{ nome, indicadores (consolidado do período), analise }]
  const comDados = unidades.filter(u => u.analise && u.analise.qualidade.cobertura !== 'insuficiente');
  if (comDados.length < 2) return { disponivel: false, motivo: 'Comparação exige pelo menos duas unidades com cobertura suficiente no período.', destaques: {}, observacoes: [] };
  const pick = (sel, melhor) => {
    const cand = comDados.map(u => ({ nome: u.nome, valor: sel(u) })).filter(x => x.valor != null);
    return cand.length ? cand.reduce((a, b) => (melhor(b.valor, a.valor) ? b : a)) : null;
  };
  const destaques = {
    maiorCrescimento: pick(u => u.analise.tendencias.faturamento.variacaoAcumulada, (b, a) => b > a),
    maiorQueda: pick(u => u.analise.tendencias.faturamento.variacaoAcumulada, (b, a) => b < a),
    melhorRetencaoAposIfood: pick(u => numero(u.indicadores?.retencaoAposIfoodPct), (b, a) => b > a),
    maiorCustoIfood: pick(u => numero(u.indicadores?.custoIfoodPct), (b, a) => b > a),
    melhorConversao: pick(u => u.analise.metas.conversao.ultima?.atual ?? null, (b, a) => b > a),
    melhorEvolucaoClientes: pick(u => u.analise.tendencias.clientes.variacaoAcumulada, (b, a) => b > a),
  };
  const gravidade = u => Object.values(u.analise.status).reduce((s, v) => s + ({ 'CRÍTICO': 3, 'ATENÇÃO': 1 }[v] ?? 0), 0);
  const maiorAtencao = comDados.map(u => ({ nome: u.nome, valor: gravidade(u) })).reduce((a, b) => (b.valor > a.valor ? b : a));
  const observacoes = [];
  if (destaques.maiorCrescimento && destaques.maiorQueda && destaques.maiorCrescimento.nome !== destaques.maiorQueda.nome)
    observacoes.push(`${destaques.maiorCrescimento.nome} teve a melhor evolução de faturamento (${varTxt(destaques.maiorCrescimento.valor)}); ${destaques.maiorQueda.nome}, a mais fraca (${varTxt(destaques.maiorQueda.valor)}).`);
  if (destaques.melhorRetencaoAposIfood) observacoes.push(`Melhor retenção após iFood no período: ${destaques.melhorRetencaoAposIfood.nome} (${pct(destaques.melhorRetencaoAposIfood.valor)}).`);
  if (destaques.maiorCustoIfood) observacoes.push(`Maior custo iFood sobre faturamento: ${destaques.maiorCustoIfood.nome} (${pct(destaques.maiorCustoIfood.valor)}).`);
  if (destaques.melhorConversao) observacoes.push(`Melhor conversão medida: ${destaques.melhorConversao.nome} (${pct(destaques.melhorConversao.valor)}).`);
  observacoes.push(`Maior demanda de atenção gerencial: ${maiorAtencao.nome}.`);
  return { disponivel: true, destaques: { ...destaques, maiorAtencao: { nome: maiorAtencao.nome } }, observacoes };
}

// Texto gerencial curto para o topo, combinando as prioridades das unidades.
export function diagnosticoGeral(unidades, comparativo) {
  return {
    porUnidade: unidades.filter(u => u.analise).map(u => ({ unidade: u.nome, prioridade: u.analise.resumo.prioridade, texto: u.analise.resumo.texto })),
    comparativo: comparativo?.observacoes ?? [],
  };
}
