import { diasDoMes, snapshotFinanceiroMaisRecente, desempenhoParaTicketMedio, novosClientesAcumulados, totalDeducoes } from '../../dashboard-executivo/dashboardExecutivo.calc.js';
import { INDICADORES_OBRIGATORIOS } from './performance.config.js';

export const numero = v => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
export function razao(a, b, escala = 1) {
  a = numero(a); b = numero(b);
  return a == null || b == null || b <= 0 ? null : numero(a / b * escala);
}
export const variacao = (a, b) => numero(a) == null || numero(b) == null ? null : razao(Number(a) - Number(b), b, 100);
export function deslocarMes(ym, delta) {
  const [ano, mes] = ym.split('-').map(Number);
  return new Date(Date.UTC(ano, mes - 1 + delta, 1)).toISOString().slice(0, 7);
}
export function derivar(base) {
  return { ...base,
    aposDespesas: base.faturamento == null || base.despesasIfood == null ? null : numero(base.faturamento - base.despesasIfood),
    // Regra específica solicitada para a Central; Dashboard mantém valor bruto / pedidos.
    ticketMedio: razao(base.faturamento, base.pedidos),
    retencaoAposIfoodPct: base.faturamento == null || base.despesasIfood == null ? null : razao(base.faturamento - base.despesasIfood, base.faturamento, 100),
    custoIfoodPct: razao(base.despesasIfood, base.faturamento, 100),
    custoEntregadoresPct: razao(base.entregadores, base.faturamento, 100),
    custoPorPedido: razao(base.entregadores, base.pedidos),
    custoExternosPct: razao(base.entregadoresExternos, base.faturamento, 100),
    custoExternoPorPedido: razao(base.entregadoresExternos, base.pedidos),
    conversao: numero(base.conversao),
  };
}
export function calcularMes(linhas, mes, hoje) {
  const [ano, m] = mes.split('-').map(Number);
  const dias = diasDoMes(ano, m);
  const fim = dias.at(-1);
  const rows = linhas.filter(r => r.data_lancamento.slice(0, 7) === mes && r.data_lancamento <= hoje && ['rascunho', 'finalizado'].includes(r.status));
  const snapshot = snapshotFinanceiroMaisRecente(rows);
  const par = desempenhoParaTicketMedio(rows);
  const deducoes = totalDeducoes({ taxasComissoes: numero(snapshot?.taxas_comissoes), servicosPromocoes: numero(snapshot?.servicos_promocoes), taxasEntregadores: numero(snapshot?.taxas_entregadores), ajustesContraLoja: numero(snapshot?.ajustes_contra_loja) });
  const completo = fim < hoje && snapshot?.data_lancamento === fim && dias.every(d => rows.some(r => r.data_lancamento === d && r.status === 'finalizado'));
  const indicadores = derivar({ faturamento: numero(snapshot?.valor_vendas_ifood), despesasIfood: numero(deducoes), entregadores: numero(snapshot?.taxas_entregadores), pedidos: numero(par?.qtdVendas), valorBruto: numero(par?.valorVendasBruto), novosClientes: numero(novosClientesAcumulados(dias, rows)) });
  const faltantes = INDICADORES_OBRIGATORIOS.filter(k => indicadores[k] == null);
  return { mes, incompleto: !completo || faltantes.length > 0, semDados: !rows.length, financeiroAte: snapshot?.data_lancamento ?? null,
    status: mes === hoje.slice(0,7) ? 'em_andamento' : completo && !faltantes.length ? 'completo' : 'incompleto',
    completudePct: (INDICADORES_OBRIGATORIOS.length - faltantes.length) / INDICADORES_OBRIGATORIOS.length * 100,
    faltantes, indicadores };
}
// Uma unidade/mês desconhecida não desaparece silenciosamente do total.
export function consolidar(pontos) {
  // Sem visitas não há ponderação válida entre taxas mensais/unidades.
  const base = { conversao:pontos.length === 1 ? numero(pontos[0].indicadores.conversao) : null };
  for (const chave of ['faturamento', 'despesasIfood', 'entregadores', 'entregadoresExternos', 'pedidos', 'valorBruto', 'novosClientes']) {
    const valores = pontos.map(p => p.indicadores[chave]);
    base[chave] = !valores.length || valores.some(v => numero(v) == null) ? null : numero(valores.reduce((a, b) => a + Number(b), 0));
  }
  return derivar(base);
}
export function comparar(atual, anterior) {
  return Object.fromEntries(Object.keys(atual).map(k => [k, variacao(atual[k], anterior[k])]));
}
export function diagnosticar(atual, anterior, evolucao, config) {
  const alertas = [];
  if (evolucao.some(p => p.incompleto)) return ['Período incompleto ou sem dados: variações são provisórias; diagnósticos de tendência aguardam competências completas.'];
  const v = comparar(atual, anterior);
  if (v.faturamento != null && v.faturamento < 0 && v.pedidos != null && v.pedidos <= config.quedaPedidos && v.ticketMedio != null && v.ticketMedio >= 0)
    alertas.push('A queda de faturamento acompanha principalmente a redução no volume de pedidos.');
  if (v.faturamento != null && Math.abs(v.faturamento) <= config.estabilidadeReceita && atual.custoIfoodPct != null && anterior.custoIfoodPct != null && atual.custoIfoodPct > anterior.custoIfoodPct)
    alertas.push('Os custos do iFood estão crescendo proporcionalmente mais rápido que o faturamento e podem estar comprimindo a margem.');
  const clientes = evolucao.slice(-3).map(p => p.indicadores.novosClientes);
  if (clientes.length === 3 && clientes.every(v => v != null) && clientes[0] > clientes[1] && clientes[1] > clientes[2])
    alertas.push('A aquisição de novos clientes apresenta deterioração no período analisado.');
  if (atual.conversao != null && atual.conversao < config.conversaoReferencia) alertas.push(`Conversão abaixo da referência gerencial de ${config.conversaoReferencia}%.`);
  return alertas;
}
