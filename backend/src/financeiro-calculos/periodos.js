// Fechamento mensal — funções PURAS: snapshot determinístico, validação de mês e decisão de fechamento.
// O snapshot é a FOTO dos resultados no instante do fechamento (valores em centavos/bps, nada de formatação), imutável no banco.

export const SCHEMA_SNAPSHOT = 1;
export const mesValido = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m ?? "");
export const primeiroDia = (m) => `${m}-01`;
export function ultimoDia(m) { const [a, mm] = m.split("-").map(Number); return `${m}-${String(new Date(Date.UTC(a, mm, 0)).getUTCDate()).padStart(2, "0")}`; }

/**
 * apuracao: saída de motor.apurar; dre: saída de montarDre; saldos: saída de saldosPorConta; conciliacao: saída de conciliar.
 * `geradoEm` é injetado (sem relógio aqui) para o resultado ser reproduzível em testes.
 */
export function montarSnapshot({ mes, apuracao: a, dre, saldos, conciliacao, pendencias, geradoEm }) {
  return {
    schema: SCHEMA_SNAPSHOT, mes, regime: "caixa", geradoEm,
    indicadores: {
      receitaOperacional: a.receitaOperacional, custosVariaveis: a.custosVariaveis, despesasVariaveis: a.despesasVariaveis, tributos: a.tributos,
      despesasFixas: a.despesasFixas, despesasPessoal: a.despesasPessoal, despesasFinanceiras: a.despesasFinanceiras,
      margemContribuicao: a.margemContribuicao, margemContribuicaoBps: a.margemContribuicaoBps, resultadoGerencial: a.resultadoGerencial, margemLiquidaBps: a.margemLiquidaBps,
      pontoEquilibrio: a.pontoEquilibrio, entradasTotais: a.entradasTotais, saidasTotais: a.saidasTotais, variacaoCaixa: a.variacaoCaixa, saldoAnterior: a.saldoAnterior, saldoFinal: a.saldoFinal,
      transferenciasLiquidasExternas: a.transferencias.liquidasExternas, financiamentos: a.financiamentos, ponteFecha: a.ponteResultadoCaixa.fecha, parcial: a.parcial,
    },
    dre: dre.linhas.map((l) => (l.tipo === "percentual"
      ? { id: l.id, rotulo: l.rotulo, bps: l.bps }
      : { id: l.id, rotulo: l.rotulo, centavos: l.centavos, percentualReceitaBps: l.percentualReceitaBps, detalhes: (l.detalhes ?? []).map((d) => ({ nome: d.nome, centavos: d.centavos })) })),
    saldosPorConta: saldos.contas.map((c) => ({ contaId: c.contaId, nome: c.nome, aberturaCentavos: c.aberturaCentavos, variacao: c.variacao, saldoCentavos: c.saldoCentavos, parcial: c.parcial })),
    saldosConciliadosComExtrato: false,
    conciliacao: conciliacao ? {
      ponte: { vendasCentavos: conciliacao.ponte.vendasCentavos, recebidoCentavos: conciliacao.ponte.recebidoCentavos, taxasTotalCentavos: conciliacao.ponte.taxasTotalCentavos, residualCentavos: conciliacao.ponte.residualCentavos, estado: conciliacao.ponte.estado },
      contagemPorEstado: conciliacao.resumo.contagemPorEstado, pendenciasAbertas: conciliacao.resumo.pendenciasAbertas,
    } : null,
    pendencias,
  };
}

/** Decide se o mês pode ser fechado AGORA (a decisão final é do banco, sob trava). */
export function avaliarFechamento({ status, pendenciasLancamentos, pendenciasConciliacao, politicaPermitePendencias }) {
  const bloqueios = [];
  if (status === "fechado") bloqueios.push({ codigo: "JA_FECHADO", texto: "O período já está fechado." });
  const total = pendenciasLancamentos + pendenciasConciliacao;
  const comPendencias = total > 0;
  if (comPendencias && !politicaPermitePendencias) bloqueios.push({ codigo: "PENDENCIAS_IMPEDEM", texto: `${total} pendência(s) impedem o fechamento (a política de fechar com pendências não foi aprovada).` });
  return { pode: bloqueios.length === 0, exigeReconhecimento: comPendencias && politicaPermitePendencias === true, pendenciasTotal: total, bloqueios };
}
