// COMPOSIÇÃO dos indicadores do Financeiro 2.0 — núcleo PURO (sem banco, sem relógio). Responde, para cada total mostrado na tela:
// de que ele é feito, quanto cada parte vale, quanto isso pesa no faturamento bruto e se a soma das partes confere.
// Regras: nada é inventado nem arredondado para "fechar"; dado ausente fica ausente (null) e vira situação "sem_dados"/"parcial";
// se as partes não somam o total, a situação passa a "divergente" (a tela mostra a diferença, nunca a esconde).
import { dividirArredondando } from "./dinheiro.js";

export const SITUACAO = Object.freeze({ CONFIRMADO: "confirmado", PENDENTE: "pendente_contadora", PARCIAL: "parcial", SEM_DADOS: "sem_dados", DIVERGENTE: "divergente" });
/** Estado já usado pela API (ok|proposta|parcial|indisponivel) → situação de qualidade dos dados. */
export function situacaoDoEstado(estado) {
  return { ok: SITUACAO.CONFIRMADO, proposta: SITUACAO.PENDENTE, parcial: SITUACAO.PARCIAL, indisponivel: SITUACAO.SEM_DADOS }[estado] ?? SITUACAO.PARCIAL;
}
const PIOR = [SITUACAO.SEM_DADOS, SITUACAO.DIVERGENTE, SITUACAO.PARCIAL, SITUACAO.PENDENTE, SITUACAO.CONFIRMADO];
/** Pior situação entre várias (um total nunca é "confirmado" se uma parte não é). */
export const piorSituacao = (xs) => PIOR.find((s) => xs.includes(s)) ?? SITUACAO.CONFIRMADO;

export const bpsDoBruto = (centavos, bruto) => (centavos == null || !bruto || bruto <= 0 ? null : dividirArredondando(centavos * 10000, bruto));
export const brl = (c) => `R$ ${(Math.abs(c) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const soma = (xs) => xs.reduce((s, x) => s + (x ?? 0), 0);

/** Nó de composição. `centavos` é COM SINAL (dedução/custo entram negativos nos totais que os subtraem). */
export function no({ id, rotulo, centavos, bruto, explicacaoId = null, situacao = SITUACAO.CONFIRMADO, criterio = null, nota = null, filhos = null, lancamentos = null, nomeOriginal = null, explicacao = null, tipo = "categoria", destaque = false, origemTecnica = null, pedidos = null, acao = null, detalhe = null, papel = null, rotuloSituacao = null }) {
  return { id, rotulo, tipo, destaque, origemTecnica, pedidos, acao, detalhe, papel, rotuloSituacao, centavos, pctBrutoBps: bpsDoBruto(centavos == null ? null : Math.abs(centavos), bruto), explicacaoId, situacao, criterio, nota, nomeOriginal, explicacao, filhos, lancamentos };
}

/** Verifica a soma das partes. Divergência > 0 centavos = situação "divergente" (com a diferença exposta). */
export function conferir(totalCentavos, partes) {
  if (totalCentavos == null || partes.some((p) => p.centavos == null)) return { confere: null, somaCentavos: null, diferencaCentavos: null };
  const s = soma(partes.map((p) => p.centavos));
  return { confere: s === totalCentavos, somaCentavos: s, diferencaCentavos: totalCentavos - s };
}

/** Linhas (categorias) de um grupo do DRE de referência → nós folha com lançamentos. */
function nosDoGrupo(grupo, { bruto, sinal = 1, rotulos, lancamentosPorLinha, situacaoLinha, pendenciasPorLinha, conciliacaoCodigo, papelPorLinha }) {
  return (grupo?.linhas ?? []).filter((l) => l.centavos !== 0).map((l) => {
    const r = rotulos?.get(l.descricao);
    const pend = pendenciasPorLinha?.get(l.codigo);   // pendência ESPECÍFICA desta categoria (a regra geral fica no aviso do topo)
    return no({
      id: `cat:${l.descricao}`, rotulo: r?.nome ?? l.descricao, nomeOriginal: r?.renomeada ? r.nomeOriginal : null, explicacao: r?.explicacao ?? null,
      explicacaoId: r?.chave ?? null, centavos: sinal * l.centavos, bruto, criterio: l.criterio, nota: pend ?? l.motivo,
      situacao: pend && situacaoLinha === SITUACAO.CONFIRMADO ? SITUACAO.PENDENTE : situacaoLinha,
      lancamentos: lancamentosPorLinha?.get(l.codigo) ?? [], acao: conciliacaoCodigo && l.codigo === conciliacaoCodigo ? "conciliacao" : null, papel: papelPorLinha?.get(l.codigo) ?? null,
    });
  }).sort((a, b) => Math.abs(b.centavos) - Math.abs(a.centavos));
}

/**
 * Árvore do DRE GERENCIAL (único demonstrativo principal). Cada nível é a soma exata do nível abaixo.
 * @param dre  resultado de dreReferencia: { grupos:[{grupo,rotulo,linhas}], indicadores, regrasAprovadas, semContasAPagar }
 * @param vendas { porCanal:[{canal,centavos}] }  @param opcoes { rotulos:Map, lancamentosPorLinha:Map }
 */
export function arvoreDre(dre, vendas, { rotulos, lancamentosPorLinha, pendenciasPorLinha, conciliacaoCodigo, papelPorLinha } = {}) {
  const I = dre.indicadores, bruto = I.faturamentoBruto;
  // A regra geral "metodologia ainda não aprovada" NÃO é repetida em cada linha (vai no aviso do topo). Só marca a linha o que é específico dela.
  const sit = dre.semContasAPagar ? SITUACAO.PARCIAL : SITUACAO.CONFIRMADO;
  const g = (k) => dre.grupos.find((x) => x.grupo === k);
  const base = { bruto, rotulos, lancamentosPorLinha, situacaoLinha: sit, pendenciasPorLinha, conciliacaoCodigo, papelPorLinha };
  const T = (id, rotulo, centavos, extra = {}) => no({ id, rotulo, centavos, bruto, tipo: "total", situacao: sit, ...extra });
  const nDed = nosDoGrupo(g("deducoes"), base), nCmv = nosDoGrupo(g("cmv"), base), nEnt = nosDoGrupo(g("entregas"), base);
  const nVar = nosDoGrupo(g("variaveis"), base), nFixFolhas = nosDoGrupo(g("fixas"), base);
  // despesas fixas em subgrupos por natureza (como na apresentação): Pessoal · Financeiras e tarifas · Administrativas e serviços
  // "Prestação de serviços" (consultorias e marketing contratados) é subgrupo próprio, separado das administrativas (contabilidade, energia, aluguel...), como na apresentação
  const ROTULO_SUB = { despesa_pessoal: ["pessoal", "Pessoal"], despesa_financeira: ["financeiras", "Financeiras e tarifas"] };
  const PRESTACAO = /^(PRESTADOR|PRESTA[CÇ][AÃ]O|MARKETING)/i;
  const ORDEM_SUB = ["pessoal", "administrativas", "prestacao", "financeiras"];
  const subs = new Map();
  for (const f of nFixFolhas) {
    const [k, r] = ROTULO_SUB[f.papel] ?? (PRESTACAO.test(String(f.nomeOriginal ?? f.rotulo ?? "")) ? ["prestacao", "Prestação de serviços"] : ["administrativas", "Administrativas"]);
    (subs.get(k) ?? subs.set(k, { rotulo: r, itens: [] }).get(k)).itens.push(f);
  }
  const nFix = subs.size > 1 ? [...subs.entries()].sort((a, b) => ORDEM_SUB.indexOf(a[0]) - ORDEM_SUB.indexOf(b[0])).map(([k, v]) => no({ id: `sub:${k}`, rotulo: v.rotulo, tipo: "subgrupo", centavos: v.itens.reduce((x, i) => x + i.centavos, 0), bruto, situacao: sit, criterio: "caixa", filhos: v.itens })) : nFixFolhas;
  const filhosCanal = (vendas?.porCanal ?? []).map((c) => no({ id: `canal:${c.canal}`, rotulo: c.canal, centavos: c.centavos, bruto, situacao: SITUACAO.CONFIRMADO, criterio: "fonte" }));
  const custosFilhos = [T("cmv", "CMV", I.cmv, { explicacaoId: "cmv", tipo: "grupo", filhos: nCmv, criterio: "competencia" }), T("entregas", "Entregas", I.entregas, { explicacaoId: "entregas", tipo: "grupo", filhos: nEnt, criterio: "competencia" })];
  const linhas = [
    T("bruto", "Faturamento bruto", I.faturamentoBruto, { explicacaoId: "faturamentoBruto", tipo: "grupo", filhos: filhosCanal, situacao: bruto == null ? SITUACAO.SEM_DADOS : SITUACAO.CONFIRMADO }),
    T("deducoes", "(−) Deduções", I.deducoes, { explicacaoId: "deducoes", tipo: "grupo", filhos: nDed, criterio: "caixa" }),
    T("liquido", "= Faturamento líquido", I.faturamentoLiquido, { explicacaoId: "faturamentoLiquido", destaque: true }),
    T("custos", "(−) Custos", I.custosTotais, { explicacaoId: "custos", tipo: "grupo", filhos: custosFilhos }),
    T("variaveis", "(−) Despesas variáveis", I.despesasVariaveis, { explicacaoId: "despesasVariaveis", tipo: "grupo", filhos: nVar, criterio: "caixa" }),
    T("mc", "= Margem de contribuição", I.margemContribuicao, { explicacaoId: "margemContribuicao", destaque: true }),
    T("fixas", "(−) Despesas fixas", I.despesasFixas, { explicacaoId: "despesasFixas", tipo: "grupo", filhos: nFix, criterio: "caixa" }),
    T("resultado", "= Resultado gerencial", I.resultadoGerencial, { explicacaoId: "resultadoGerencial", destaque: true }),
  ];
  // soma das categorias de cada grupo confere com o total do grupo? (verificação exposta; não corrige nada)
  const checar = (n) => { if (n.filhos?.length) { const c = conferir(Math.abs(n.centavos), n.filhos.map((f) => ({ centavos: Math.abs(f.centavos) }))); n.conferencia = c; if (c.confere === false) n.situacao = SITUACAO.DIVERGENTE; n.filhos.forEach(checar); } };
  linhas.forEach(checar);
  return linhas;
}

/**
 * Conciliação de UMA categoria entre as três visões que aparecem no sistema:
 *   livro-caixa (lançamentos do mês) → pagamentos de Contas a Pagar do mês → DRE gerencial (competência + rateio).
 * Cada degrau da ponte é calculado dos registros; a soma dos degraus fecha com a diferença total (ou a diferença sobra exposta).
 * @param {{mes:string, livroCaixaCentavos:number|null, obrigacoes:[{id,descricao,competencia,valorCentavos,status,criterio}], pagamentos:[{obrigacaoId,data,valorCentavos}],
 *          parcelasRateio:[{obrigacaoId,competencia,valorCentavos}], rateadas:Set<string>, gerencialCentavos:number}} d
 */
export function conciliarCategoria(d) {
  const mes = d.mes, mesDe = (x) => String(x).slice(0, 7);
  const obrs = d.obrigacoes.filter((o) => o.status !== "cancelada");
  const rateadas = d.rateadas ?? new Set();
  const pagoNoMes = (o) => soma(d.pagamentos.filter((p) => p.obrigacaoId === o.id && mesDe(p.data) === mes).map((p) => p.valorCentavos));
  const pagamentosMes = soma(d.pagamentos.filter((p) => mesDe(p.data) === mes).map((p) => p.valorCentavos));
  const degraus = [];
  const add = (id, rotulo, centavos, itens) => { if (centavos !== 0 || (itens ?? []).length) degraus.push({ id, rotulo, centavos, itens: itens ?? [] }); };
  // 1) livro-caixa × Contas a Pagar
  if (d.livroCaixaCentavos != null) add("livro_sem_vinculo", "Lançamentos do livro-caixa sem pagamento correspondente em Contas a Pagar (ou com valor diferente)", -(d.livroCaixaCentavos - pagamentosMes), []);
  // 2) pago no mês, mas de outra competência e sem rateio → não pertence ao mês no gerencial
  const outras = obrs.filter((o) => !rateadas.has(o.id) && mesDe(o.competencia) !== mes && pagoNoMes(o) !== 0);
  add("outra_competencia", "Pagos no mês, mas de competência de outro mês", -soma(outras.map(pagoNoMes)), outras.map((o) => ({ descricao: o.descricao, competencia: mesDe(o.competencia), centavos: pagoNoMes(o) })));
  // 3) obrigações RATEADAS: o gerencial usa só a parcela do mês, o caixa mostra o que foi pago
  const rat = obrs.filter((o) => rateadas.has(o.id));
  const parcMes = (o) => soma(d.parcelasRateio.filter((p) => p.obrigacaoId === o.id && mesDe(p.competencia) === mes).map((p) => p.valorCentavos));
  add("rateadas_pago_menos_parcela", "Obrigações rateadas por competência: pago no mês − parcela que pertence ao mês", -soma(rat.map((o) => pagoNoMes(o) - parcMes(o))), rat.map((o) => ({ descricao: o.descricao, competencia: mesDe(o.competencia), pagoNoMesCentavos: pagoNoMes(o), parcelaDoMesCentavos: parcMes(o), centavos: pagoNoMes(o) - parcMes(o) })));
  // 4) obrigações do mês SEM rateio ainda não pagas (ou pagas a menos): o gerencial usa o valor original
  const doMes = obrs.filter((o) => !rateadas.has(o.id) && mesDe(o.competencia) === mes);
  add("do_mes_nao_pago", "Obrigações do mês sem rateio: valor original − pago no mês", soma(doMes.map((o) => o.valorCentavos - pagoNoMes(o))), doMes.filter((o) => o.valorCentavos !== pagoNoMes(o)).map((o) => ({ descricao: o.descricao, competencia: mesDe(o.competencia), centavos: o.valorCentavos - pagoNoMes(o) })));
  const partida = d.livroCaixaCentavos ?? pagamentosMes;
  const somaDegraus = soma(degraus.map((x) => x.centavos));
  const chegada = partida + somaDegraus;
  return { mes, partidaRotulo: d.livroCaixaCentavos != null ? "Livro-caixa (regime de caixa)" : "Pagamentos de Contas a Pagar (regime de caixa)", partidaCentavos: partida, pagamentosContasAPagarCentavos: pagamentosMes,
    degraus, chegadaCentavos: chegada, gerencialCentavos: d.gerencialCentavos, confere: chegada === d.gerencialCentavos, diferencaCentavos: d.gerencialCentavos - chegada };
}

/**
 * Composição de cada indicador da Visão Geral. `E` reúne os dados já calculados pelo serviço. Retorna { [id]: Composicao }.
 * Composicao = { id, valorCentavos, unidade, situacao, formula, origem, componentes:[nó], conferencia, faltam:[texto], notas:[texto] }
 */
export function composicaoIndicadores(E) {
  const { dre, arvore, vendas, recebimentosPorConta, saldos, cp, receber, dividas, estados } = E;
  const I = dre.indicadores, bruto = I.faturamentoBruto;
  const arv = new Map(arvore.map((n) => [n.id, n]));
  const sitDe = (id) => situacaoDoEstado(estados[id]);
  const comp = (id, extra) => ({ id, unidade: "moeda", componentes: [], faltam: [], notas: [], conferencia: null, ...extra });
  const cons = (c) => ({ ...c, componentes: c.componentes });
  const montar = (id, total, partes, extra) => { const c = comp(id, { valorCentavos: total, componentes: partes, situacao: sitDe(id), ...extra }); c.conferencia = conferir(total, partes); if (c.conferencia.confere === false) c.situacao = SITUACAO.DIVERGENTE; return cons(c); };
  const out = {};
  const sinal = (n, s) => ({ ...n, centavos: s * n.centavos });   // visão do nó dentro de um total que o subtrai
  const T = (id) => arv.get(id);

  const pc = vendas.ponteCanais;
  if (pc) {
    // PONTE: total do painel (SAIPOS) → ajustes → base gerencial. A base gerencial é o que alimenta a DRE e deve coincidir com o bruto oficial.
    const filhosCanal = (c) => c.ajustes.length ? [no({ id: `${c.canal}:painel`, rotulo: "Total no painel (SAIPOS)", centavos: c.painelCentavos, bruto, tipo: "total" }),
      ...c.ajustes.map((a) => no({ id: `aj:${a.id}`, rotulo: a.descricao, centavos: a.valorCentavos, bruto, situacao: a.estado === "estimado" ? SITUACAO.PENDENTE : SITUACAO.CONFIRMADO, rotuloSituacao: a.estado === "estimado" ? "Estimado" : null,
        detalhe: a.estado === "estimado" ? "estimado, a confirmar" : `confirmado${a.evidencia ? ` · evidência: ${a.evidencia}` : ""}`, criterio: null, explicacao: a.evidencia ?? null }))] : null;
    const gerNos = pc.canais.map((c) => no({ id: `canal:${c.canal}`, rotulo: c.canal, centavos: c.gerencialCentavos, bruto, situacao: c.pendente ? SITUACAO.PENDENTE : SITUACAO.CONFIRMADO, rotuloSituacao: c.pendente ? "Ajuste estimado" : null, nota: c.pendente ? "inclui ajuste estimado" : null,
      origemTecnica: c.origemTecnica ? [c.origemTecnica] : [], explicacao: c.explicacao, pedidos: c.vendasQtd, filhos: filhosCanal(c), lancamentos: [] }));
    const painelNos = pc.canais.map((c) => no({ id: `painel:${c.canal}`, rotulo: c.canal, centavos: c.painelCentavos, bruto: pc.painelCentavos, origemTecnica: c.origemTecnica ? [c.origemTecnica] : [], explicacao: c.explicacao, pedidos: c.vendasQtd, lancamentos: [] }));
    const alertas = [];
    if (pc.diferencaBaseCentavos) alertas.push(`Divergência: a base gerencial por canal (${brl(pc.gerencialCentavos)}) é ${brl(pc.diferencaBaseCentavos)} ${pc.diferencaBaseCentavos > 0 ? "MAIOR" : "MENOR"} que o faturamento bruto oficial do mês (${brl(pc.brutoOficialCentavos)}). Nenhum valor foi ajustado.`);
    if (pc.brutoOficialCentavos == null) alertas.push("Não há faturamento bruto oficial no mês para conferir a base por canal.");
    if (!pc.ponteFecha) alertas.push("A ponte entre o painel e a base gerencial não fecha: confira os ajustes registrados.");
    if (pc.ajustesSemCanal.length) alertas.push(`Há ajuste(s) de canal não registrado: ${pc.ajustesSemCanal.map((a) => a.canal).join(", ")}.`);
    const pendencias = pc.pendentes.map((a) => `Ajuste de ${brl(a.valorCentavos)} (${a.canal}) está estimado e aguarda confirmação.`);
    const mensal = pc.granularidades.includes("mensal");
    out.totalVendasCanais = montar("totalVendasCanais", pc.painelCentavos, painelNos, { rotulo: "Total de vendas por canal", formula: "soma do total de cada canal no painel (SAIPOS)", origem: "Relatório de vendas por canal (SAIPOS)", situacao: SITUACAO.CONFIRMADO,
      notas: ["É o total do PAINEL. A base usada na DRE gerencial é o faturamento bruto (ver a ponte).", mensal ? "Consolidação mensal por canal (sem detalhe diário)." : null].filter(Boolean), ponte: pc.ponte });
    out.faturamentoBruto = montar("faturamentoBruto", I.faturamentoBruto, gerNos, {
      rotulo: "Faturamento base da DRE", formula: "base gerencial por canal = total do painel (SAIPOS) + ajustes; coincide com as vendas diárias do mês", origem: "Vendas diárias (total oficial) · Relatório de vendas por canal e ajustes (composição)", alertas, pendencias,
      notas: [mensal ? "Consolidação mensal por canal (sem detalhe diário); o sistema não distribui o total mensal em dias." : null, vendas.dinheiroCentavos ? `Forma de pagamento não é canal: ${brl(vendas.dinheiroCentavos)} do mês foram recebidos em espécie (dinheiro).` : null,
        "Registros individuais por pedido não estão disponíveis: o relatório traz o total por canal."].filter(Boolean),
      situacao: bruto == null ? SITUACAO.SEM_DADOS : SITUACAO.CONFIRMADO,
      visoes: { gerencial: { rotulo: "Base da DRE gerencial", totalCentavos: pc.gerencialCentavos, componentes: gerNos }, painel: { rotulo: "Total do painel (SAIPOS)", totalCentavos: pc.painelCentavos, componentes: painelNos }, ponte: pc.ponte },
      canalConferencia: { somaCentavos: pc.gerencialCentavos, brutoOficialCentavos: pc.brutoOficialCentavos, diferencaCentavos: pc.diferencaBaseCentavos, confere: pc.baseConfere, painelCentavos: pc.painelCentavos, ajustesCentavos: pc.ajustesCentavos, ponteFecha: pc.ponteFecha },
    });
  } else {
  // ---- Faturamento bruto: por CANAL (relatório de vendas por canal, com nome amigável e origem técnica à parte).
  // Sem relatório por canal na base NÃO inventa divisão; com relatório, confere a soma dos canais contra o bruto OFICIAL e expõe a diferença.
  const cc = vendas.canalComposicao;
  const canais = vendas.porCanal ?? [];
  const semCanal = !cc && (canais.length === 0 || canais.every((c) => c.canal === null));
  const partesBruto = cc
    ? cc.canais.map((c) => no({ id: `canal:${c.canal}`, rotulo: c.canal, centavos: c.centavos, bruto, situacao: c.mapeado ? SITUACAO.CONFIRMADO : SITUACAO.PARCIAL, lancamentos: [],
      nota: c.mapeado ? null : "origem não mapeada para um canal", origemTecnica: c.origens, explicacao: c.descricao, pedidos: c.pedidos || null }))
    : canais.map((c) => no({ id: `canal:${c.canal ?? "sem"}`, rotulo: c.canal ?? "Vendas registradas (Saci) — sem canal informado", centavos: c.centavos, bruto, situacao: SITUACAO.CONFIRMADO, criterio: "fonte", lancamentos: [] }));
  const R$ = (c) => `R$ ${(Math.abs(c) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const alertasBruto = [];
  if (cc && cc.diferencaCentavos) alertasBruto.push(`Divergência: os canais somam ${R$(cc.somaCentavos)}, ${R$(cc.diferencaCentavos)} a ${cc.diferencaCentavos > 0 ? "MAIS" : "MENOS"} que o faturamento bruto oficial do mês (${R$(cc.brutoOficialCentavos)}). Nenhum valor foi ajustado.`);
  if (cc && cc.brutoOficialCentavos == null) alertasBruto.push("Não há faturamento bruto oficial no mês para conferir a soma dos canais.");
  if (cc?.naoMapeados?.length) alertasBruto.push(`Origem sem canal definido: ${cc.naoMapeados.join(", ")}.`);
  out.faturamentoBruto = montar("faturamentoBruto", I.faturamentoBruto, partesBruto, {
    formula: "soma das vendas diárias registradas (Saci) no mês; a composição por canal vem do relatório de vendas por canal", origem: cc ? "Vendas diárias (total oficial) · Relatório de vendas por canal (composição)" : "Vendas diárias importadas (referências de vendas)",
    alertas: alertasBruto,
    faltam: semCanal && bruto != null ? ["A divisão por canal (Balcão, iFood, Anota Aí e outros) não pode ser mostrada: as vendas diárias importadas trazem só o total do dia, sem o canal. Para separar, é preciso importar o faturamento do dia já dividido por canal."] : [],
    notas: [vendas.dinheiroCentavos ? `Forma de pagamento não é canal: R$ ${(vendas.dinheiroCentavos / 100).toFixed(2).replace(".", ",")} do mês foram recebidos em espécie (dinheiro). Isso não é uma divisão do faturamento por canal.` : null,
      cc ? "Registros individuais por pedido não estão disponíveis: o relatório importado traz o total por canal." : null].filter(Boolean),
    situacao: bruto == null ? SITUACAO.SEM_DADOS : SITUACAO.CONFIRMADO,
    canalConferencia: cc ? { somaCentavos: cc.somaCentavos, brutoOficialCentavos: cc.brutoOficialCentavos, diferencaCentavos: cc.diferencaCentavos, confere: cc.confere } : null,
  });
  }
  // ---- Faturamento líquido = bruto − deduções
  out.faturamentoLiquido = montar("faturamentoLiquido", I.faturamentoLiquido, bruto == null ? [] : [no({ id: "bruto", rotulo: "Faturamento bruto", centavos: bruto, bruto, tipo: "total" }), sinal(T("deducoes"), -1)],
    { formula: "faturamento bruto − deduções (Simples, taxas e tarifas de venda, antecipação)", origem: "DRE gerencial (vendas + contas a pagar)" });
  out.deducoes = montar("deducoes", I.deducoes, T("deducoes").filhos.map((n) => sinal(n, 1)), { formula: "soma das categorias de dedução (tributos e taxas sobre vendas)", origem: "Contas a Pagar (pagamentos do mês)", situacao: T("deducoes").situacao });
  out.cmv = montar("cmv", I.cmv, T("custos").filhos[0].filhos, { formula: "soma dos insumos e descartáveis por competência (valor original da conta a pagar)", origem: "Contas a Pagar (competência do mês)" });
  const entregasNo = T("custos").filhos[1];
  out.entregadores = montar("entregadores", I.entregas, entregasNo.filhos, { rotulo: entregasNo.filhos.length === 1 ? entregasNo.filhos[0].rotulo : "Entregas", formula: "soma das contas a pagar de entregadores, pela competência (rateadas quando o período atravessa dois meses)", origem: "Contas a Pagar (competência e rateios)",
    situacao: entregasNo.filhos.some((f) => f.situacao === SITUACAO.PENDENTE) ? SITUACAO.PENDENTE : sitDe("custos"), explicacaoId: entregasNo.filhos.length === 1 ? entregasNo.filhos[0].explicacaoId : "entregas" });
  out.custos = montar("custos", I.custosTotais, T("custos").filhos.map((n) => ({ ...n })), { formula: "CMV + entregas", origem: "Contas a Pagar (competência do mês)" });
  out.despesas = montar("despesas", I.despesasVariaveis + I.despesasFixas, [T("variaveis"), T("fixas")].map((n) => ({ ...n })), { formula: "despesas variáveis + despesas fixas", origem: "Contas a Pagar (pagamentos do mês)" });
  out.margemContribuicao = montar("margemContribuicao", I.margemContribuicao, bruto == null ? [] : [no({ id: "liquido", rotulo: "Faturamento líquido", centavos: I.faturamentoLiquido, bruto, tipo: "total" }), sinal(T("custos"), -1), sinal(T("variaveis"), -1)],
    { formula: "faturamento líquido − custos − despesas variáveis", origem: "DRE gerencial", situacao: sitDe("resultadoGerencial") });
  out.resultadoGerencial = montar("resultadoGerencial", I.resultadoGerencial, bruto == null ? [] : [no({ id: "liquido", rotulo: "Faturamento líquido", centavos: I.faturamentoLiquido, bruto, tipo: "total" }), sinal(T("custos"), -1), sinal(T("variaveis"), -1), sinal(T("fixas"), -1)],
    { formula: "faturamento líquido − custos − despesas variáveis − despesas fixas", origem: "DRE gerencial" });
  out.margemLiquida = comp("margemLiquida", { valorCentavos: I.margemLiquidaBps, unidade: "bps", situacao: sitDe("margemLiquida"), formula: "resultado gerencial ÷ faturamento bruto", origem: "DRE gerencial",
    componentes: bruto == null ? [] : [no({ id: "resultado", rotulo: "Resultado gerencial", centavos: I.resultadoGerencial, bruto, tipo: "total" }), no({ id: "bruto", rotulo: "Faturamento bruto", centavos: bruto, bruto, tipo: "total" })], notas: ["Percentual: não é um valor em reais."] });
  // ---- Recebimentos (entradas no banco/caixa): por conta, sem transferências internas
  const partesRec = (recebimentosPorConta ?? []).filter((c) => c.entradasCentavos !== 0).map((c) => no({ id: `conta:${c.conta}`, rotulo: c.conta, centavos: c.entradasCentavos, bruto, criterio: "caixa" }));
  out.recebimentos = montar("recebimentos", E.recebimentosCentavos, partesRec, { formula: "entradas de receita operacional no banco e no caixa (regime de caixa)", origem: "Fluxo de Caixa por conta", notas: ["Recebimento é dinheiro que entrou na conta; não é faturamento."], situacao: sitDe("recebimentos") });
  if (out.recebimentos.conferencia.confere === false) out.recebimentos.notas.push("A soma por conta difere do total porque o total considera só lançamentos de receita operacional; entradas de outras categorias aparecem por conta.");
  // ---- Saldo disponível (por conta)
  const partesSaldo = (saldos?.contas ?? []).map((c) => no({ id: `saldo:${c.nome}`, rotulo: c.nome, centavos: c.saldoCentavos, bruto: null, situacao: c.saldoCentavos == null ? SITUACAO.SEM_DADOS : SITUACAO.CONFIRMADO, nota: c.saldoCentavos == null ? "saldo de abertura desconhecido" : null }));
  out.saldoDisponivel = montar("saldoDisponivel", saldos?.totalCentavos ?? null, partesSaldo.filter((p) => p.centavos != null), { formula: "saldo de abertura + entradas − saídas, por conta", origem: "Saldos calculados das contas", situacao: sitDe("saldoDisponivel"),
    faltam: partesSaldo.filter((p) => p.centavos == null).map((p) => `Saldo de abertura da conta ${p.rotulo} não informado.`) });
  // ---- Contas a pagar / receber / juros / dívidas
  out.contasAPagar = montar("contasAPagar", cp.contasPagar.emAbertoCentavos, [no({ id: "vencido", rotulo: "Vencido", centavos: cp.contasPagar.vencidoCentavos }), no({ id: "a_vencer", rotulo: "A vencer", centavos: cp.contasPagar.aVencerCentavos })],
    { formula: "saldo em aberto das contas a pagar na data-base (vencidas + a vencer)", origem: "Contas a Pagar", situacao: sitDe("contasAPagar") });
  out.contasAReceber = receber == null ? comp("contasAReceber", { valorCentavos: null, situacao: SITUACAO.SEM_DADOS, formula: "recebíveis em aberto", origem: "Contas a Receber", faltam: ["Cadastro de contas a receber indisponível."] })
    : montar("contasAReceber", receber.resumo.pendenteCentavos, receber.resumo.quantidade ? [no({ id: "pendente", rotulo: `${receber.resumo.quantidade} recebível(is) em aberto`, centavos: receber.resumo.pendenteCentavos })] : [], { formula: "valor original − recebido, dos recebíveis em aberto", origem: "Contas a Receber", situacao: sitDe("contasAReceber") });
  const j = E.juros, jm = E.jurosMes;
  const fmtData = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  const nosJuros = (campo) => (jm?.relacionadas ?? []).filter((r) => r[campo] > 0).map((r) => no({ id: `juros:${r.obrigacaoId}`, rotulo: r.descricao ?? "Obrigação", centavos: r[campo], situacao: r.natureza === "presumido" ? SITUACAO.PENDENTE : SITUACAO.CONFIRMADO,
    detalhe: `competência ${r.competencia} · venc. ${fmtData(r.vencimento)} · pago em ${r.pagoEm.map(fmtData).join(", ")} · original ${brl(r.valorOriginalCentavos)}, pago ${brl(r.pagoCentavos)} (+${(r.percentualBps / 100).toFixed(2).replace(".", ",")}%)${r.quitada ? "" : " · obrigação ainda não quitada"}`, explicacaoId: "jurosPresumidos" }));
  const pagosNos = nosJuros("pagoNoMesCentavos"), compNos = nosJuros("daCompetenciaCentavos");
  out.jurosEncargos = montar("jurosEncargos", j.totalCentavos, jm ? pagosNos : [no({ id: "confirmados", rotulo: "Juros e encargos confirmados", centavos: j.confirmadoCentavos, situacao: SITUACAO.CONFIRMADO }), no({ id: "presumidos", rotulo: "Juros presumidos (pago acima do original, ainda sem classificação)", centavos: j.presumidoCentavos, situacao: SITUACAO.PENDENTE })],
    { formula: "acréscimos (total pago − valor original) PAGOS no mês", origem: "Contas a Pagar / Juros e Encargos", situacao: sitDe("jurosEncargos"), notas: ["Presumido não é juros definitivo até a classificação.", "Pagamento parcial não é desconto: é saldo em aberto.",
      jm ? `Total das obrigações relacionadas (todas as competências): ${brl(jm.totalRelacionadasCentavos)}.` : null].filter(Boolean),
      visoes: jm ? { pagosNoMes: { rotulo: "Juros pagos no mês", totalCentavos: jm.pagosNoMes.totalCentavos, componentes: pagosNos }, daCompetencia: { rotulo: "Juros das obrigações da competência", totalCentavos: jm.daCompetencia.totalCentavos, componentes: compNos } } : null });
  const dv = (dividas?.itens ?? []).filter((d) => d.status === "ativa");
  const saldoDiv = (d) => d.saldoInformadoCentavos ?? d.saldoCalculadoCentavos;
  const partesDiv = dv.map((d) => no({ id: `divida:${d.id}`, rotulo: `${d.credor ?? "Credor não informado"} — ${d.descricao ?? d.naturezaRotulo}`, centavos: saldoDiv(d), situacao: saldoDiv(d) == null ? SITUACAO.SEM_DADOS : d.documentada ? SITUACAO.CONFIRMADO : SITUACAO.PENDENTE, nota: d.documentada ? null : "sem documento comprobatório" }));
  const semSaldo = partesDiv.filter((p) => p.centavos == null);
  out.dividas = dividas == null ? comp("dividas", { valorCentavos: null, situacao: SITUACAO.SEM_DADOS, formula: "saldo devedor das dívidas ativas", origem: "Dívidas e Empréstimos", faltam: ["Cadastro de dívidas indisponível."] })
    : montar("dividas", dv.length && !semSaldo.length ? soma(partesDiv.map((p) => p.centavos)) : (dv.length ? null : 0), partesDiv.filter((p) => p.centavos != null), { formula: "saldo devedor informado (ou calculado) das dívidas ativas", origem: "Dívidas e Empréstimos",
      situacao: !dv.length ? SITUACAO.CONFIRMADO : semSaldo.length ? SITUACAO.PARCIAL : piorSituacao(partesDiv.map((p) => p.situacao)), faltam: semSaldo.map((p) => `Saldo não informado: ${p.rotulo}`), notas: !dv.length ? ["Nenhuma dívida ativa cadastrada."] : [] });
  // ---- Ponto de equilíbrio
  out.pontoEquilibrio = comp("pontoEquilibrio", { valorCentavos: I.pontoEquilibrio, situacao: I.pontoEquilibrio == null ? SITUACAO.SEM_DADOS : sitDe("resultadoGerencial"), formula: "despesas fixas ÷ (margem de contribuição ÷ faturamento bruto)", origem: "DRE gerencial",
    componentes: [no({ id: "fixas", rotulo: "Despesas fixas", centavos: I.despesasFixas, bruto, tipo: "total" }), no({ id: "mc", rotulo: "Margem de contribuição", centavos: I.margemContribuicao, bruto, tipo: "total" }), no({ id: "bruto", rotulo: "Faturamento bruto", centavos: bruto, bruto, tipo: "total" })],
    faltam: I.pontoEquilibrio == null ? ["Sem margem de contribuição positiva ou sem faturamento: o ponto de equilíbrio não pode ser calculado."] : [], notas: ["Faturamento mínimo para o resultado gerencial ficar em zero."] });
  for (const c of Object.values(out)) c.pctBrutoBps = c.unidade === "moeda" && c.valorCentavos != null ? bpsDoBruto(Math.abs(c.valorCentavos), bruto) : null;
  return out;
}
