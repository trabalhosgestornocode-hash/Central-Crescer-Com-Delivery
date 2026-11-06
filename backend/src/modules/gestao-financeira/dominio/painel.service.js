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

const padrao = { repo: repositorio, db: undefined };
const fimDoMes = (ym) => { const [a, m] = ym.split("-").map(Number); return `${ym}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0")}`; };
const ind = (valorCentavos, { formula, origem, estado = "ok", unidade = "moeda", nota = null }) => ({ valorCentavos: valorCentavos ?? null, unidade, formula, origem, estado: valorCentavos == null && estado === "ok" ? "indisponivel" : estado, nota });

async function vendasDoMes(c, mes, deps) {
  const refs = await deps.repo.listarReferencias(c, { mes }, deps.db);
  const soma = (f) => refs.filter(f).reduce((s, r) => s + Number(r.valor_centavos), 0);
  const tem = (tipo) => refs.some((r) => r.tipo === tipo);
  const porDia = new Map();
  for (const r of refs) { if (!["venda", "dinheiro", "sangria"].includes(r.tipo)) continue; const d = String(r.data).slice(0, 10); const x = porDia.get(d) ?? { data: d, vendaCentavos: 0, dinheiroCentavos: 0, sangriaCentavos: 0 }; if (r.tipo === "venda") x.vendaCentavos += Number(r.valor_centavos); if (r.tipo === "dinheiro") x.dinheiroCentavos += Number(r.valor_centavos); if (r.tipo === "sangria") x.sangriaCentavos += Number(r.valor_centavos); porDia.set(d, x); }
  const taxas = {}; for (const r of refs.filter((x) => x.tipo === "taxa")) taxas[r.canal ?? "outro"] = (taxas[r.canal ?? "outro"] ?? 0) + Number(r.valor_centavos);
  return { registradas: refs.length, brutoCentavos: tem("venda") ? soma((r) => r.tipo === "venda") : null, dinheiroCentavos: soma((r) => r.tipo === "dinheiro"), sangriaCentavos: soma((r) => r.tipo === "sangria"), taxasPorCanal: taxas, porDia: [...porDia.values()].sort((a, b) => a.data.localeCompare(b.data)), diasComVenda: [...porDia.values()].filter((d) => d.vendaCentavos > 0).length };
}

/** DRE gerencial de REFERÊNCIA do mês (critério misto por categoria; regras padrão propostas). */
export async function dreReferencia(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const mes = mesAno(q?.mes, "mes");
  const [plano, obrs, pags, vendas, rateios, dividas] = await Promise.all([deps.repo.listarPlanoContas(c, deps.db), deps.repo.listarObrigacoes(c, deps.db), deps.repo.listarPagamentos(c, deps.db), vendasDoMes(c, mes, deps),
    deps.repo.listarRateios ? f152.rateiosParaDre(c, deps) : [], deps.repo.listarDividas ? f152.listarDividas(c, { mes }, deps) : null]);
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
  return {
    mes, regime: dre.regime, versaoRegras: dre.versaoRegras, regrasAprovadas: dre.regrasAprovadas, grupos, indicadores: dre.indicadores,
    regras: Object.entries(regras.porCategoria).map(([categoria, r]) => ({ categoria, grupo: GRUPOS[r.grupo], criterio: r.criterio, motivo: r.motivo })),
    pendencias: { ...dre.pendencias, categoriasSemRegraNoPlano: regras.semRegra, rateios: rateios.length ? `${new Set(rateios.map((r) => r.obrigacaoChave)).size} obrigação(ões) rateada(s); ${rateios.filter((r) => r.status === "proposto").length} parcela(s) ainda PROPOSTA(S), pendente(s) de aprovação da contadora` : "nenhum rateio registrado: obrigações que cruzam meses entram inteiras na competência",
      dividas: temDividaPe ? "PE financeiro com as parcelas (principal + juros) das dívidas marcadas para entrar no PE; encargos já estão nas despesas fixas" : "sem dívidas marcadas para o PE financeiro: PE financeiro indisponível" },
    semContasAPagar: obrs.length === 0,
  };
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
  const notaRef = dre.semContasAPagar ? "Sem contas a pagar registradas: custos e despesas por competência ficam incompletos." : "Metodologia gerencial (critério misto por categoria) ainda não aprovada pela contadora.";
  const cx = (id) => caixa.itens.find((x) => x.id === id)?.valor?.centavos ?? null;
  const lista = await obr.listar(c, { mes }, deps);
  const receber = deps.repo.listarRecebiveis ? await f152.listarRecebiveis(c, { mes }, deps) : null;
  const acrescimoPendente = lista.itens.filter((i) => i.status === "aberta" && (i.pagoCentavos ?? 0) > i.valorOriginalCentavos).reduce((s, i) => s + i.pagoCentavos - i.valorOriginalCentavos, 0);
  const saldos = geral.saldosPorConta;
  return {
    mes, dataBase: cp.dataBase, versaoRegras: dre.versaoRegras, regrasAprovadas: dre.regrasAprovadas,
    indicadores: {
      faturamentoBruto: rec.resumo.faturamentoBruto,
      faturamentoLiquido: ind(I.faturamentoBruto == null ? null : I.faturamentoLiquido, { formula: "faturamento bruto − deduções (Simples, taxas e tarifas de venda, antecipação)", origem: "DRE gerencial de referência", estado: ref, nota: notaRef }),
      recebimentos: rec.resumo.recebimentos,
      custos: ind(I.custosTotais, { formula: "CMV + entregas", origem: "DRE gerencial de referência (contas a pagar)", estado: ref, nota: notaRef }),
      cmv: ind(I.cmv, { formula: "Σ insumos e descartáveis por competência (valor original)", origem: "DRE gerencial de referência (contas a pagar)", estado: ref, nota: notaRef }),
      despesas: ind(I.despesasVariaveis + I.despesasFixas, { formula: "despesas variáveis + fixas (pessoal, administrativas, serviços, financeiras), pelo pagamento", origem: "DRE gerencial de referência (pagamentos)", estado: ref, nota: notaRef }),
      resultadoGerencial: ind(I.faturamentoBruto == null ? null : I.resultadoGerencial, { formula: "margem de contribuição − despesas fixas", origem: "DRE gerencial de referência", estado: ref, nota: notaRef }),
      margemLiquida: ind(I.margemLiquidaBps, { formula: "resultado gerencial ÷ faturamento bruto", origem: "DRE gerencial de referência", estado: ref, unidade: "bps", nota: notaRef }),
      resultadoCaixa: ind(cx("resultadoGerencial"), { formula: "recebimentos − pagamentos operacionais (regime de caixa)", origem: "Fluxo de Caixa", nota: "Visão de caixa, separada da metodologia gerencial." }),
      saldoDisponivel: ind(saldos?.totalCentavos ?? null, { formula: "saldo de abertura + entradas − saídas, por conta", origem: "Saldos calculados das contas financeiras", estado: saldos?.parcial ? "parcial" : "ok", nota: "Saldo CALCULADO; o saldo informado em extrato/contagem ainda não é registrado no sistema." }),
      contasAPagar: ind(cp.contasPagar.emAbertoCentavos, { formula: "Σ saldo em aberto das contas a pagar (vencidas + a vencer) na data-base", origem: "Contas a Pagar", nota: `Vencido: R$ ${formatarCentavos(cp.contasPagar.vencidoCentavos)} · a vencer: R$ ${formatarCentavos(cp.contasPagar.aVencerCentavos)}` }),
      contasAReceber: receber == null ? ind(null, { formula: "Σ recebíveis em aberto", origem: "—", estado: "indisponivel", nota: "Cadastro de contas a receber indisponível." })
        : ind(receber.resumo.pendenteCentavos, { formula: "Σ (valor original − recebido) dos recebíveis em aberto", origem: "Contas a Receber", nota: receber.resumo.quantidade ? `${receber.resumo.quantidade} recebível(is); ${receber.resumo.atrasados} atrasado(s)` : "Nenhum recebível registrado." }),
      jurosEncargos: ind((cp.juros?.confirmadoCentavos ?? 0) + (cp.juros?.presumidoCentavos ?? 0) + acrescimoPendente, { formula: "acréscimos confirmados + presumidos (pago acima do original)", origem: "Contas a Pagar / Juros e Encargos", estado: acrescimoPendente > 0 || (cp.juros?.presumidoCentavos ?? 0) > 0 ? "proposta" : "ok",
        nota: `Confirmados: R$ ${formatarCentavos(cp.juros?.confirmadoCentavos ?? 0)} · presumidos: R$ ${formatarCentavos((cp.juros?.presumidoCentavos ?? 0) + acrescimoPendente)} (presumido não é juros até a classificação).` }),
    },
    contasPagar: cp.contasPagar, bloqueiosFechamento: cp.bloqueiosFechamento,
    serieVendas: rec.vendas.porDia, saldosPorConta: saldos?.contas ?? [],
    composicao: dre.grupos.map((g) => ({ grupo: g.rotulo, centavos: g.linhas.reduce((s, l) => s + l.centavos, 0) })),
  };
}
