// FONTE ÚNICA por dia entre o relatório Excel (Parser) e a API Foody — PURO (sem banco, sem rede, sem relógio).
//
// Regra (uma fonte por pedido E por período; nunca as duas somadas):
//   1. Dia com pedido no Excel importado → fonte = EXCEL. É a fonte oficial: tem nome do entregador (pagamento), distância,
//      overrides manuais e lançamentos. O fechamento Foody do mesmo dia é ignorado nos totais (vira só conferência).
//   2. Dia SEM Excel e com fechamento Foody de cobertura completa (CONSOLIDADO/CORRIGIDO) → fonte = FOODY, valores marcados
//      como do estado do fechamento (SINCRONIZADO/PROVISORIO). Sem nome de entregador: não entra em pagamento nem conciliação.
//   3. Dia sem Excel com fechamento Foody INCOMPLETO → fonte = FOODY_INCOMPLETO: aparece, mas fora dos totais.
//   4. Nada → SEM_DADOS.
//
// Quatro grandezas, nunca confundidas:
//   * taxaBruta              — soma das taxas de entregador dos pedidos elegíveis da operação (antes de descartar cancelamentos);
//   * taxaValida             — taxa bruta menos as descartadas pela regra de cancelamento (mesma resumoConciliacao do Parser);
//   * custoLogisticoAtribuido — taxa válida de entregadores PRÓPRIOS (só a Foody distingue o tipo; no Excel = null, não inventado);
//   * custoRealConciliado    — taxa válida + lançamentos (taxas adicionais/manuais/avulsos) do Parser; existe só para o PERÍODO
//                              e só quando TODOS os dias com dado vieram do Excel (senão null: seria misturar fontes).
// Distância: só existe no Excel (complementar); dias FOODY ficam com distanciaDisponivel=false.
export const FONTE = Object.freeze({ EXCEL: "EXCEL", FOODY: "FOODY", FOODY_INCOMPLETO: "FOODY_INCOMPLETO", SEM_DADOS: "SEM_DADOS" });
const COMPLETOS = new Set(["CONSOLIDADO", "CORRIGIDO"]);

const arred = (n) => (n == null ? null : Math.round(n * 100) / 100);
const somarDia = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diaDe = (p) => (p?.dataHora ? String(p.dataHora).slice(0, 10) : null);

/** Mantém, por competência, só a versão MAIS ALTA do fechamento (versões antigas são histórico, nunca somadas). */
export function ultimaVersaoPorDia(fechamentos) {
  const m = new Map();
  for (const f of fechamentos ?? []) {
    const c = String(f.competencia).slice(0, 10);
    if (!m.has(c) || Number(f.versao) > Number(m.get(c).versao)) m.set(c, f);
  }
  return m;
}

/** Bloco da operação principal do tenant dentro de `indicadores` do fechamento. */
export function blocoDaOperacao(indicadores, operacao) {
  if (!indicadores) return null;
  return indicadores[indicadores.operacao ?? operacao] ?? indicadores[operacao] ?? indicadores.subway ?? null;
}

/**
 * @param {{ de:string, ate:string, operacao?:string,
 *           excel: { pedidosElegiveis: object[], todos: object[], resumoPorDia: (pedidos:object[]) => object, custoReal?: {total:number}|null },
 *           fechamentos: object[] }} p
 *   excel.pedidosElegiveis = pedidos já com overrides e filtro de conciliação (forma da API do Parser);
 *   excel.todos = todos os pedidos consolidados (para saber se o dia TEM Excel, mesmo que só com Açaí/sem entregador);
 *   excel.resumoPorDia = resumoConciliacao do Parser (injetado: este módulo não importa o Parser).
 */
export function resolverFontePorDia({ de, ate, operacao = "subway", excel, fechamentos }) {
  const porDia = ultimaVersaoPorDia(fechamentos);
  const diasExcel = new Set((excel?.todos ?? []).map(diaDe).filter(Boolean));
  const elegiveisPorDia = new Map();
  for (const p of excel?.pedidosElegiveis ?? []) {
    const d = diaDe(p); if (!d) continue;
    if (!elegiveisPorDia.has(d)) elegiveisPorDia.set(d, []);
    elegiveisPorDia.get(d).push(p);
  }
  const dias = [];
  for (let d = de; d <= ate; d = somarDia(d, 1)) {
    const f = porDia.get(d) ?? null;
    if (diasExcel.has(d)) {
      const r = excel.resumoPorDia(elegiveisPorDia.get(d) ?? []);
      const distancias = (elegiveisPorDia.get(d) ?? []).filter((p) => p.distanciaRaioKm != null).length;
      dias.push({ competencia: d, fonte: FONTE.EXCEL, estadoValores: "PARSER", pedidos: r.totalPedidos, entregues: r.entregues,
        taxaBruta: r.taxasBrutas, taxaValida: r.taxasValidas, custoLogisticoAtribuido: null,
        distanciaDisponivel: distancias > 0, foodyIgnorado: f ? { versao: f.versao, status: f.status } : null });
      continue;
    }
    if (f) {
      const b = blocoDaOperacao(f.indicadores, operacao);
      const completo = COMPLETOS.has(f.status);
      dias.push({ competencia: d, fonte: completo ? FONTE.FOODY : FONTE.FOODY_INCOMPLETO, estadoValores: f.estado_valores ?? f.estadoValores ?? null,
        versao: f.versao, status: f.status, pedidos: b?.total?.pedidos ?? 0, entregues: b?.total?.entregues ?? 0,
        taxaBruta: b?.total?.taxasBrutas ?? null, taxaValida: b?.total?.taxasValidas ?? null,
        custoLogisticoAtribuido: b?.custoLogisticoProprio ?? null, distanciaDisponivel: false, foodyIgnorado: null });
      continue;
    }
    dias.push({ competencia: d, fonte: FONTE.SEM_DADOS, pedidos: 0, entregues: 0, taxaBruta: null, taxaValida: null, custoLogisticoAtribuido: null,
      distanciaDisponivel: false, foodyIgnorado: null });
  }

  const noTotal = dias.filter((x) => x.fonte === FONTE.EXCEL || x.fonte === FONTE.FOODY);
  const soma = (k) => arred(noTotal.reduce((s, x) => s + (Number(x[k]) || 0), 0));
  const contar = (fonte) => dias.filter((x) => x.fonte === fonte).length;
  const soExcel = noTotal.length > 0 && noTotal.every((x) => x.fonte === FONTE.EXCEL);
  const foody = noTotal.filter((x) => x.fonte === FONTE.FOODY);
  return {
    periodo: { de, ate }, operacao,
    regra: "um dia, uma fonte: Excel quando importado; senão fechamento Foody completo; nunca somados",
    dias,
    totais: {
      dias: { excel: contar(FONTE.EXCEL), foody: contar(FONTE.FOODY), foodyIncompleto: contar(FONTE.FOODY_INCOMPLETO), semDados: contar(FONTE.SEM_DADOS) },
      pedidos: noTotal.reduce((s, x) => s + x.pedidos, 0),
      entregues: noTotal.reduce((s, x) => s + x.entregues, 0),
      taxaBruta: soma("taxaBruta"),
      taxaValida: soma("taxaValida"),
      // só faz sentido somar quando todos os dias do total são Foody (o Excel não distingue o tipo de entregador)
      custoLogisticoAtribuido: foody.length && foody.length === noTotal.length ? soma("custoLogisticoAtribuido") : null,
      custoRealConciliado: soExcel && excel?.custoReal ? arred(excel.custoReal.total) : null,
      // dias que tinham as DUAS fontes e contaram uma só (prova de não duplicação)
      diasComAsDuasFontes: dias.filter((x) => x.foodyIgnorado).length,
      valoresProvisorios: foody.some((x) => x.estadoValores !== "SINCRONIZADO" && x.estadoValores !== "CONCILIADO" && x.estadoValores !== "CUSTO_REAL"),
    },
  };
}
