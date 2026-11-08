// Financeiro 2.0 — Painel (Visão Geral), Receitas e Vendas e DRE Gerencial de Referência.
// Compõe serviços existentes (relatórios de caixa, contas a pagar, referências de vendas) + o motor puro do DRE de referência.
// Regras de apresentação:
//   • FATURAMENTO (vendas registradas) nunca é confundido com RECEBIMENTOS (entradas no banco/caixa): são indicadores separados;
//   • cada indicador traz metodologia, origem e ESTADO: "ok" (dado registrado), "proposta" (regra gerencial ainda não aprovada pela
//     contadora), "parcial" (falta parte dos dados) ou "indisponivel" (o sistema não tem a fonte) — nunca um número inventado.
import * as repositorio from "./repositorio.js";
import * as rel from "./relatorios.service.js";
import * as obr from "./obrigacoes.service.js";
import * as f152 from "./f152.service.js";
import { exigirContexto } from "./contexto.js";
import { mesAno } from "./validacao.js";
import { montarDreReferencia } from "../../../financeiro-calculos/dreGerencialReferencia.js";
import { regrasPadrao, GRUPOS } from "../../../financeiro-calculos/regrasReferencia.js";
import { formatarCentavos } from "../../../financeiro-calculos/dinheiro.js";
import { arvoreDre, composicaoIndicadores, conciliarCategoria, bpsDoBruto } from "../../../financeiro-calculos/composicao.js";
import { comporPorCanal, comporPonte, nomeDoCanal } from "../../../financeiro-calculos/canaisVenda.js";
import { rotulosDoPlano } from "../../../financeiro-calculos/rotulosCategorias.js";

const padrao = { repo: repositorio, db: undefined };
const fimDoMes = (ym) => { const [a, m] = ym.split("-").map(Number); return `${ym}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0")}`; };
const ind = (valorCentavos, { formula, origem, estado = "ok", unidade = "moeda", nota = null }) => ({ valorCentavos: valorCentavos ?? null, unidade, formula, origem, estado: valorCentavos == null && estado === "ok" ? "indisponivel" : estado, nota });

async function vendasDoMes(c, mes, deps) {
  const refs = await deps.repo.listarReferencias(c, { mes }, deps.db);
  const soma = (f) => refs.filter(f).reduce((s, r) => s + Number(r.valor_centavos), 0);
  const tem = (tipo) => refs.some((r) => r.tipo === tipo);
  const porDia = new Map();
  for (const r of refs) { if (!["venda", "dinheiro", "sangria"].includes(r.tipo)) continue; const d = String(r.data).slice(0, 10); const x = porDia.get(d) ?? { data: d, vendaCentavos: 0, dinheiroCentavos: 0, sangriaCentavos: 0 }; if (r.tipo === "venda") x.vendaCentavos += Number(r.valor_centavos); if (r.tipo === "dinheiro") x.dinheiroCentavos += Number(r.valor_centavos); if (r.tipo === "sangria") x.sangriaCentavos += Number(r.valor_centavos); porDia.set(d, x); }
  const canalMap = new Map(); for (const r of refs.filter((x) => x.tipo === "venda")) canalMap.set(r.canal ?? null, (canalMap.get(r.canal ?? null) ?? 0) + Number(r.valor_centavos));
  const porCanal = [...canalMap].map(([canal, centavos]) => ({ canal, centavos })).sort((a, b) => b.centavos - a.centavos);
  const taxas = {}; for (const r of refs.filter((x) => x.tipo === "taxa")) taxas[r.canal ?? "outro"] = (taxas[r.canal ?? "outro"] ?? 0) + Number(r.valor_centavos);
  // totais por canal vindos do relatório de vendas por canal (fonte opcional: sem ela a composição por canal fica indisponível, sem inventar)
  const bruto0 = tem("venda") ? soma((r) => r.tipo === "venda") : null;
  // PONTE (migration 153): total do painel por canal → ajustes → base gerencial. Sem a tabela/dados, cai no relatório simples (ou em nada).
  let ponteCanais = null, canalComposicao = null;
  if (deps.repo.listarVendasCanal) {
    const [cs, as] = await Promise.all([deps.repo.listarVendasCanal(c, { competencia: `${mes}-01` }, deps.db), deps.repo.listarVendasAjustes ? deps.repo.listarVendasAjustes(c, { competencia: `${mes}-01` }, deps.db) : []]);
    if (cs.length) ponteCanais = comporPonte({ brutoOficialCentavos: bruto0,
      canais: cs.map((r) => ({ id: r.id, canal: r.canal, origemTecnica: r.origem_tecnica, vendasQtd: r.vendas_qtd, painelCentavos: Number(r.valor_painel_centavos), gerencialCentavos: Number(r.valor_gerencial_centavos), granularidade: r.granularidade, fonte: r.fonte, observacao: r.observacao })),
      ajustes: as.map((r) => ({ id: r.id, canal: r.canal, tipo: r.tipo, valorCentavos: Number(r.valor_centavos), descricao: r.descricao, estado: r.estado, evidencia: r.evidencia })) });
  } else {
    const linhasCanal = deps.repo.listarVendasPorCanal ? await deps.repo.listarVendasPorCanal(c, { mes }, deps.db) : [];
    canalComposicao = linhasCanal?.length ? comporPorCanal(linhasCanal, bruto0) : null;
  }
  return { registradas: refs.length, porCanal, canalComposicao, ponteCanais, brutoCentavos: tem("venda") ? soma((r) => r.tipo === "venda") : null, dinheiroCentavos: soma((r) => r.tipo === "dinheiro"), sangriaCentavos: soma((r) => r.tipo === "sangria"), taxasPorCanal: taxas, porDia: [...porDia.values()].sort((a, b) => a.data.localeCompare(b.data)), diasComVenda: [...porDia.values()].filter((d) => d.vendaCentavos > 0).length };
}

/** DRE gerencial de REFERÊNCIA do mês (critério misto por categoria; regras padrão propostas). */
export async function dreReferencia(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const mes = mesAno(q?.mes, "mes");
  const [plano, obrs, pags, vendas, rateios, dividas, forn] = await Promise.all([deps.repo.listarPlanoContas(c, deps.db), deps.repo.listarObrigacoes(c, deps.db), deps.repo.listarPagamentos(c, deps.db), vendasDoMes(c, mes, deps),
    deps.repo.listarRateios ? f152.rateiosParaDre(c, deps) : [], deps.repo.listarDividas ? f152.listarDividas(c, { mes }, deps) : null, deps.repo.listarFornecedores ? deps.repo.listarFornecedores(c, deps.db) : []]);
  const temDividaPe = (dividas?.itens ?? []).some((d) => d.entraPeFinanceiro);
  const regras = regrasPadrao(plano);
  const catNome = new Map(plano.map((p) => [p.id, p.nome]));
  const obrPorId = new Map(obrs.map((o) => [o.id, o]));
  const dre = montarDreReferencia({ mes, regras, dados: {
    vendas: { brutoCentavos: vendas.brutoCentavos },
    obrigacoes: obrs.map((o) => ({ chave: o.id, categoria: catNome.get(o.categoria_id), competencia: String(o.competencia).slice(0, 7), valorCentavos: Number(o.valor_original_centavos), status: o.status })),
    pagamentos: pags.map((p) => ({ chave: p.id, obrigacaoChave: p.obrigacao_id, categoria: catNome.get(obrPorId.get(p.obrigacao_id)?.categoria_id), data: String(p.data_pagamento).slice(0, 10), valorCentavos: Number(p.valor_centavos), status: p.status })),
    rateios: rateios.map((r) => ({ ...r, categoria: catNome.get(obrPorId.get(r.obrigacaoChave)?.categoria_id) })),
    parcelasDividaCentavos: temDividaPe ? dividas.resumo.parcelasPeFinanceiroNoMesCentavos : null,
  } });
  const grupos = Object.entries(GRUPOS).filter(([k]) => k !== "fora").map(([k, rotulo]) => ({ grupo: k, rotulo, linhas: dre.linhas.filter((l) => l.grupo === k).map(({ origens, ...l }) => ({ ...l, parcelas: origens.length, criterio: regras.porCategoria[l.descricao]?.criterio ?? "fonte", motivo: regras.porCategoria[l.descricao]?.motivo ?? "vendas registradas" })) }));
  // lançamentos de ORIGEM de cada linha (obrigação, pagamento, rateio ou fonte de vendas), com descrição, fornecedor, datas e valor
  const fornNome = new Map(forn.map((f) => [f.id, f.nome]));
  const lancamentosPorLinha = new Map(dre.linhas.map((l) => [l.codigo, l.origens.map((o) => {
    const ob = o.tipo === "obrigacao" ? obrPorId.get(o.id) : o.tipo === "rateio" ? obrPorId.get(o.id) : o.tipo === "pagamento" ? obrPorId.get(pags.find((p) => p.id === o.id)?.obrigacao_id) : null;
    const pg = o.tipo === "pagamento" ? pags.find((p) => p.id === o.id) : null;
    return { tipo: o.tipo, id: o.id, criterio: o.criterio, centavos: o.centavos, descricao: ob?.descricao ?? (o.tipo === "fonte" ? "Vendas registradas do mês (Saci)" : null), fornecedor: ob ? (fornNome.get(ob.fornecedor_id) ?? null) : null,
      competencia: ob ? String(ob.competencia).slice(0, 7) : null, data: pg ? String(pg.data_pagamento).slice(0, 10) : ob ? String(ob.vencimento ?? "").slice(0, 10) || null : null, obrigacaoId: ob?.id ?? null };
  })]));
  const rotulos = rotulosDoPlano(c.organizacaoId, plano.map((p) => ({ ...p, nome: p.nome })), deps.env ?? process.env);
  // pendência ESPECÍFICA por categoria: tem parcela de rateio ainda PROPOSTA (depende da aprovação da contadora)
  const pendenciasPorLinha = new Map();
  for (const l of dre.linhas) {
    const props = l.origens.filter((o) => o.tipo === "rateio" && rateios.some((r) => r.obrigacaoChave === o.id && r.competencia === mes && r.status === "proposto"));
    if (props.length) pendenciasPorLinha.set(l.codigo, `${props.length} rateio(s) por competência ainda proposto(s), aguardando a contadora`);
  }
  const catConc = plano.find((p) => rotulos.get(p.nome)?.chave === "entregadores_proprios");
  const arvore = arvoreDre({ grupos, indicadores: dre.indicadores, regrasAprovadas: dre.regrasAprovadas, semContasAPagar: obrs.length === 0 }, vendas, { rotulos, lancamentosPorLinha, pendenciasPorLinha, conciliacaoCodigo: catConc ? `CAT:${catConc.nome}` : null, papelPorLinha: new Map(plano.map((p) => [`CAT:${p.nome}`, p.papel])) });
  // resumo executivo do DRE: os MESMOS números da árvore (nada é recalculado por outra fórmula), com % do bruto
  const Ir = dre.indicadores, brutoR = Ir.faturamentoBruto;
  const mk = (c) => ({ centavos: c, pctBrutoBps: c == null ? null : (c < 0 ? -1 : 1) * bpsDoBruto(Math.abs(c), brutoR) });
  const resumo = { bruto: mk(Ir.faturamentoBruto), deducoes: mk(Ir.deducoes), liquido: mk(Ir.faturamentoLiquido), custos: mk(Ir.custosTotais), despesas: mk(Ir.despesasVariaveis + Ir.despesasFixas),
    margemContribuicao: mk(Ir.margemContribuicao), resultado: mk(Ir.resultadoGerencial), margemLiquidaBps: Ir.margemLiquidaBps };
  // categoria de entregadores próprios (quando a empresa tem a regra): conciliação livro-caixa × Contas a Pagar × DRE gerencial
  let conciliacaoEntregadores = null;
  const catEnt = plano.find((p) => rotulos.get(p.nome)?.chave === "entregadores_proprios");
  if (catEnt) {
    const livro = await deps.repo.listarTodosLancamentos(c, { de: `${mes}-01`, ate: fimDoMes(mes) }, deps.db);
    const doCat = livro.filter((l) => l.categoria_id === catEnt.id && l.status !== "cancelado");
    const livroCentavos = doCat.reduce((s, l) => s + (l.sentido === "saida" ? 1 : -1) * Number(l.valor_centavos), 0);
    const obrCat = obrs.filter((o) => o.categoria_id === catEnt.id);
    const idsCat = new Set(obrCat.map((o) => o.id));
    const linhaEnt = dre.linhas.find((l) => l.descricao === catEnt.nome);
    const conc = conciliarCategoria({ mes, livroCaixaCentavos: livroCentavos, gerencialCentavos: linhaEnt?.centavos ?? 0,
      obrigacoes: obrCat.map((o) => ({ id: o.id, descricao: o.descricao, competencia: o.competencia, valorCentavos: Number(o.valor_original_centavos), status: o.status })),
      pagamentos: pags.filter((p) => idsCat.has(p.obrigacao_id) && p.status !== "cancelado").map((p) => ({ obrigacaoId: p.obrigacao_id, data: p.data_pagamento, valorCentavos: Number(p.valor_centavos) })),
      parcelasRateio: rateios.filter((r) => idsCat.has(r.obrigacaoChave)).map((r) => ({ obrigacaoId: r.obrigacaoChave, competencia: r.competencia, valorCentavos: r.valorCentavos })),
      rateadas: new Set(rateios.filter((r) => idsCat.has(r.obrigacaoChave)).map((r) => r.obrigacaoChave)) });
    const r0 = rotulos.get(catEnt.nome);
    conciliacaoEntregadores = { ...conc, categoria: r0.nome, nomeOriginal: r0.nomeOriginal, explicacao: r0.explicacao, distincoes: r0.distincoes, lancamentosLivroCaixa: doCat.length };
  }
  // apresentação: o nome exibido substitui o gravado; o gravado segue em `nomeOriginal` (id/histórico intactos)
  const exibir = (nome) => rotulos.get(nome) ?? { nome, nomeOriginal: nome, renomeada: false, explicacao: null };
  const gruposExib = grupos.map((g) => ({ ...g, linhas: g.linhas.map((l) => { const r = exibir(l.descricao); return r.renomeada ? { ...l, descricao: r.nome, nomeOriginal: r.nomeOriginal, explicacao: r.explicacao, lancamentos: lancamentosPorLinha.get(l.codigo) } : { ...l, lancamentos: lancamentosPorLinha.get(l.codigo) }; }) }));
  const saida = {
    mes, regime: dre.regime, versaoRegras: dre.versaoRegras, regrasAprovadas: dre.regrasAprovadas, grupos: gruposExib, arvore, resumo, conciliacaoEntregadores, vendasPorCanal: vendas.porCanal, indicadores: dre.indicadores,
    regras: Object.entries(regras.porCategoria).map(([categoria, r]) => ({ categoria: exibir(categoria).nome, nomeOriginal: exibir(categoria).renomeada ? categoria : null, grupo: GRUPOS[r.grupo], criterio: r.criterio, motivo: r.motivo })),
    pendencias: { ...dre.pendencias, categoriasSemRegraNoPlano: regras.semRegra, rateios: rateios.length ? `${new Set(rateios.map((r) => r.obrigacaoChave)).size} obrigação(ões) rateada(s); ${rateios.filter((r) => r.status === "proposto").length} parcela(s) ainda PROPOSTA(S), pendente(s) de aprovação da contadora` : "nenhum rateio registrado: obrigações que cruzam meses entram inteiras na competência",
      dividas: temDividaPe ? "PE financeiro com as parcelas (principal + juros) das dívidas marcadas para entrar no PE; encargos já estão nas despesas fixas" : "sem dívidas marcadas para o PE financeiro: PE financeiro indisponível" },
    semContasAPagar: obrs.length === 0,
  };
  Object.defineProperty(saida, "dividasLista", { value: dividas, enumerable: false });   // reuso interno pelo painel; não vai na resposta
  return saida;
}

/** Receitas e Vendas do mês: vendas registradas (faturamento) × recebimentos no banco/caixa (regime de caixa). */
export async function receitas(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const mes = mesAno(q?.mes, "mes");
  const periodo = { de: `${mes}-01`, ate: fimDoMes(mes) };
  const [vendas, geral, caixa] = await Promise.all([vendasDoMes(c, mes, deps), rel.visaoGeral(c, periodo, deps), rel.indicadores(c, periodo, deps)]);
  // entradas por conta SEM transferências internas (dinheiro que mudou de conta não é recebimento)
  const recebimentosPorConta = (geral.movimentoPorConta ?? []).map((m) => ({ conta: m.nome, entradasCentavos: m.entradas - m.transferenciasEntrada, transferenciasCentavos: m.transferenciasEntrada }));
  const recebidos = caixa.itens.find((x) => x.id === "receitaOperacional")?.valor?.centavos ?? null;
  return {
    mes, vendas, recebimentosPorConta,
    resumo: {
      faturamentoBruto: ind(vendas.brutoCentavos, { formula: "Σ vendas diárias registradas (Saci)", origem: "Referências de vendas (conciliação)" }),
      taxasRetidas: ind(Object.values(vendas.taxasPorCanal).reduce((s, v) => s + v, 0) || null, { formula: "Σ taxas registradas por canal", origem: "Referências de taxas (iFood, Stone)" }),
      dinheiro: ind(vendas.dinheiroCentavos, { formula: "Σ vendas em espécie (Saci)", origem: "Referências de vendas" }),
      recebimentos: ind(recebidos, { formula: "Σ entradas de receita operacional no extrato/caixa (regime de caixa)", origem: "Lançamentos do Fluxo de Caixa", nota: "Recebimento é dinheiro que entrou na conta; não é faturamento." }),
    },
  };
}

/** Painel (Visão Geral 2.0): 12 indicadores com metodologia, origem e estado. */
export async function painel(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const mes = mesAno(q?.mes, "mes");
  const periodo = { de: `${mes}-01`, ate: fimDoMes(mes) };
  const [dre, rec, caixa, cp, geral] = await Promise.all([dreReferencia(c, { mes }, deps), receitas(c, { mes }, deps), rel.indicadores(c, periodo, deps), obr.resumoMes(c, { mes }, deps), rel.visaoGeral(c, periodo, deps)]);
  const I = dre.indicadores, ref = dre.semContasAPagar ? "parcial" : "proposta";
  // Sem contas a pagar, deduções, custos e despesas ficam em ZERO e o "resultado" viraria o faturamento inteiro: número enganoso.
  // Nesse caso os indicadores gerenciais saem SEM valor (—), com o motivo; nunca um número que pareça completo.
  const g = (v) => (dre.semContasAPagar ? null : v);
  const notaRef = dre.semContasAPagar ? "Sem contas a pagar registradas: deduções, custos e despesas ainda não podem ser calculados (importe ou registre as contas do mês)." : "Metodologia gerencial (critério misto por categoria) ainda não aprovada pela contadora.";
  const cx = (id) => caixa.itens.find((x) => x.id === id)?.valor?.centavos ?? null;
  const lista = await obr.listar(c, { mes }, deps);
  const jm = await obr.jurosDoMes(c, { mes }, deps);
  const receber = deps.repo.listarRecebiveis ? await f152.listarRecebiveis(c, { mes }, deps) : null;
  const acrescimoPendente = lista.itens.filter((i) => i.status === "aberta" && (i.pagoCentavos ?? 0) > i.valorOriginalCentavos).reduce((s, i) => s + i.pagoCentavos - i.valorOriginalCentavos, 0);
  const saldos = geral.saldosPorConta;
  const indicadoresOut = {
      faturamentoBruto: rec.resumo.faturamentoBruto,
      faturamentoLiquido: ind(I.faturamentoBruto == null ? null : g(I.faturamentoLiquido), { formula: "faturamento bruto − deduções (Simples, taxas e tarifas de venda, antecipação)", origem: "DRE gerencial de referência", estado: ref, nota: notaRef }),
      recebimentos: rec.resumo.recebimentos,
      custos: ind(g(I.custosTotais), { formula: "CMV + entregas", origem: "DRE gerencial de referência (contas a pagar)", estado: ref, nota: notaRef }),
      cmv: ind(g(I.cmv), { formula: "Σ insumos e descartáveis por competência (valor original)", origem: "DRE gerencial de referência (contas a pagar)", estado: ref, nota: notaRef }),
      despesas: ind(g(I.despesasVariaveis + I.despesasFixas), { formula: "despesas variáveis + fixas (pessoal, administrativas, serviços, financeiras), pelo pagamento", origem: "DRE gerencial de referência (pagamentos)", estado: ref, nota: notaRef }),
      resultadoGerencial: ind(I.faturamentoBruto == null ? null : g(I.resultadoGerencial), { formula: "margem de contribuição − despesas fixas", origem: "DRE gerencial de referência", estado: ref, nota: notaRef }),
      margemLiquida: ind(g(I.margemLiquidaBps), { formula: "resultado gerencial ÷ faturamento bruto", origem: "DRE gerencial de referência", estado: ref, unidade: "bps", nota: notaRef }),
      resultadoCaixa: ind(cx("resultadoGerencial"), { formula: "recebimentos − pagamentos operacionais (regime de caixa)", origem: "Fluxo de Caixa", nota: "Visão de caixa, separada da metodologia gerencial." }),
      saldoDisponivel: ind(saldos?.totalCentavos ?? null, { formula: "saldo de abertura + entradas − saídas, por conta", origem: "Saldos calculados das contas financeiras", estado: saldos?.parcial ? "parcial" : "ok", nota: "Saldo CALCULADO; o saldo informado em extrato/contagem ainda não é registrado no sistema." }),
      contasAPagar: ind(cp.contasPagar.emAbertoCentavos, { formula: "Σ saldo em aberto das contas a pagar (vencidas + a vencer) na data-base", origem: "Contas a Pagar", nota: `Vencido: R$ ${formatarCentavos(cp.contasPagar.vencidoCentavos)} · a vencer: R$ ${formatarCentavos(cp.contasPagar.aVencerCentavos)}` }),
      contasAReceber: receber == null ? ind(null, { formula: "Σ recebíveis em aberto", origem: "—", estado: "indisponivel", nota: "Cadastro de contas a receber indisponível." })
        : ind(receber.resumo.pendenteCentavos, { formula: "Σ (valor original − recebido) dos recebíveis em aberto", origem: "Contas a Receber", nota: receber.resumo.quantidade ? `${receber.resumo.quantidade} recebível(is); ${receber.resumo.atrasados} atrasado(s)` : "Nenhum recebível registrado." }),
      jurosEncargos: ind(jm.pagosNoMes.totalCentavos, { formula: "acréscimos (total pago − valor original da obrigação) PAGOS no mês", origem: "Contas a Pagar / Juros e Encargos", estado: jm.pagosNoMes.presumidoCentavos > 0 ? "proposta" : "ok",
        nota: `Pagos no mês: R$ ${formatarCentavos(jm.pagosNoMes.totalCentavos)} · das obrigações da competência: R$ ${formatarCentavos(jm.daCompetencia.totalCentavos)} · total das obrigações relacionadas: R$ ${formatarCentavos(jm.totalRelacionadasCentavos)} (presumido não é juros até a classificação).` }),
  };
  // recebimentos por conta, SÓ de categorias de receita operacional (mesma base do total), com os lançamentos de origem
  const [lancsMes, planoP, contasP] = await Promise.all([deps.repo.listarTodosLancamentos(c, periodo, deps.db), deps.repo.listarPlanoContas(c, deps.db), deps.repo.listarContas(c, deps.db)]);
  const papelDe = new Map(planoP.map((p) => [p.id, p.papel])), nomeConta = new Map(contasP.map((x) => [x.id, x.nome]));
  const recPorConta = new Map();
  for (const l of lancsMes) {
    if (l.status === "cancelado" || papelDe.get(l.categoria_id) !== "receita_operacional") continue;
    const v = (l.sentido === "entrada" ? 1 : -1) * Number(l.valor_centavos), k = nomeConta.get(l.conta_id) ?? "Conta não identificada";
    const x = recPorConta.get(k) ?? { conta: k, entradasCentavos: 0, lancamentos: [] }; x.entradasCentavos += v;
    x.lancamentos.push({ tipo: "lancamento", id: l.id, criterio: "caixa", centavos: v, descricao: l.descricao ?? null, fornecedor: null, competencia: null, data: String(l.data_movimento).slice(0, 10) }); recPorConta.set(k, x);
  }
  const recebimentosPorConta = [...recPorConta.values()].map((x) => ({ ...x, lancamentos: x.lancamentos.sort((a, b) => a.data.localeCompare(b.data)).slice(0, 200), totalLancamentos: x.lancamentos.length }));
  const dividasLista = dre.dividasLista ?? null;
  const estados = Object.fromEntries(Object.entries(indicadoresOut).map(([k, v]) => [k, v.estado]));
  const composicao = composicaoIndicadores({ dre, arvore: dre.arvore, vendas: rec.vendas, recebimentosPorConta, recebimentosCentavos: indicadoresOut.recebimentos.valorCentavos, saldos, cp, receber, dividas: dividasLista, estados,
    juros: { confirmadoCentavos: jm.pagosNoMes.confirmadoCentavos, presumidoCentavos: jm.pagosNoMes.presumidoCentavos, totalCentavos: jm.pagosNoMes.totalCentavos }, jurosMes: jm });
  if (dre.semContasAPagar) for (const id of ["faturamentoLiquido", "deducoes", "cmv", "custos", "despesas", "margemContribuicao", "resultadoGerencial", "margemLiquida", "pontoEquilibrio"]) {
    composicao[id] = { ...composicao[id], valorCentavos: null, componentes: [], conferencia: null, situacao: "parcial", faltam: ["Não há contas a pagar registradas no mês: importe ou registre as contas para calcular deduções, custos e despesas."] };
  }
  return {
    mes, dataBase: cp.dataBase, versaoRegras: dre.versaoRegras, regrasAprovadas: dre.regrasAprovadas,
    indicadores: indicadoresOut,
    composicao, conciliacaoEntregadores: dre.conciliacaoEntregadores,
    contasPagar: cp.contasPagar, bloqueiosFechamento: cp.bloqueiosFechamento,
    serieVendas: rec.vendas.porDia, saldosPorConta: saldos?.contas ?? [],
    composicaoGrafico: dre.semContasAPagar ? dre.grupos.filter((x) => x.grupo === "receita").map((x) => ({ grupo: x.rotulo, centavos: x.linhas.reduce((s, l) => s + l.centavos, 0) })) : dre.grupos.map((g) => ({ grupo: g.rotulo, centavos: g.linhas.reduce((s, l) => s + l.centavos, 0) })),
  };
}
