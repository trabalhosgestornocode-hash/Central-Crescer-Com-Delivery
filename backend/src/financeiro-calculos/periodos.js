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

/**
 * Decide se o mês pode ser fechado AGORA (a decisão final é do banco, sob trava). NÃO existe política geral de "fechar com pendências":
 * a única via é uma EXCEÇÃO por unidade + competência (concedida por SuperAdmin), que cobre SÓ as pendências identificadas no ato da concessão.
 * `excecao` = { id, expiraEm, pendenciasIds: [...], pendenciasConciliacaoIds: [...] } da exceção ATIVA e vigente (ou null/undefined).
 */
export function avaliarFechamento({ status, pendenciasLancamentos, pendenciasLancamentosIds = [], pendenciasConciliacao, pendenciasConciliacaoIds = [], excecao = null }) {
  const bloqueios = [];
  if (status === "fechado") bloqueios.push({ codigo: "JA_FECHADO", texto: "O período já está fechado." });
  const total = pendenciasLancamentos + pendenciasConciliacao;
  const comPendencias = total > 0;
  let cobertura = null;
  if (comPendencias) {
    if (!excecao) {
      bloqueios.push({ codigo: "PENDENCIAS_IMPEDEM", texto: `${total} pendência(s) impedem o fechamento. Resolva-as; fechar com pendências só é possível com uma exceção excepcional, aprovada por SuperAdmin para esta unidade e competência.` });
    } else {
      const cobertos = new Set((excecao.pendenciasIds ?? []).map(String));
      const naoCobertas = pendenciasLancamentosIds.filter((id) => !cobertos.has(String(id))).length;
      const cobertasConc = new Set((excecao.pendenciasConciliacaoIds ?? []).map(String));
      const conciliacaoAcima = pendenciasConciliacaoIds.filter((id) => !cobertasConc.has(String(id))).length;
      cobertura = { excecaoId: excecao.id, expiraEm: excecao.expiraEm ?? null, naoCobertas: naoCobertas + conciliacaoAcima };
      if (cobertura.naoCobertas > 0) bloqueios.push({ codigo: "EXCECAO_INSUFICIENTE", texto: `A exceção concedida não cobre ${cobertura.naoCobertas} pendência(s) surgida(s) depois da aprovação. Resolva-as ou peça uma nova exceção.` });
    }
  }
  return { pode: bloqueios.length === 0, exigeReconhecimento: comPendencias && cobertura !== null && cobertura.naoCobertas === 0, pendenciasTotal: total, bloqueios, excecao: cobertura };
}
