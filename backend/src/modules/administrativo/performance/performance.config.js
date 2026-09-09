// UUIDs verificados na auditoria. Configuração central de backend, nunca chave por nome.
const UNIDADES_INICIAIS = ['1ef5aace-345b-4417-9559-e7c27a230a48', 'aa1da7d9-794c-43ec-bd7c-8c5e2cf80b6e'];
export const CAMPOS = {
  faturamento: { coluna: 'faturamento_ifood_manual', nome: 'Faturamento iFood', tipo: 'moeda', fonte: 'Financeiro iFood · valor_vendas_ifood' },
  despesasIfood: { coluna: 'despesas_ifood_manual', nome: 'Despesas iFood', tipo: 'moeda', fonte: 'Financeiro iFood · total de deduções' },
  pedidos: { coluna: 'pedidos_manual', nome: 'Pedidos iFood', tipo: 'inteiro', fonte: 'Desempenho iFood · qtd_vendas' },
  novosClientes: { coluna: 'novos_clientes_manual', nome: 'Novos clientes', tipo: 'inteiro', fonte: 'Desempenho iFood · novos_clientes' },
  conversao: { coluna: 'conversao_manual', nome: 'Conversão em vendas', tipo: 'percentual', fonte: 'Complemento mensal · sem fonte automática atual' },
  entregadores: { coluna: 'taxas_entregadores_ifood_manual', nome: 'Taxas de entregadores iFood', tipo: 'moeda', fonte: 'Financeiro iFood · taxas_entregadores (já incluídas nas deduções)' },
  entregadoresExternos: { coluna: 'despesas_entregadores_externos_manual', nome: 'Custo externo de entregadores (opcional)', tipo: 'moeda', fonte: 'Complemento mensal específico · opcional' },
};
export const INDICADORES_OBRIGATORIOS = Object.keys(CAMPOS).filter(k => k !== 'entregadoresExternos');
export function configuracaoPerformance(env = process.env) {
  const conversaoReferencia = Number(env.PERFORMANCE_CONVERSAO_REFERENCIA ?? 20);
  if (!Number.isFinite(conversaoReferencia) || conversaoReferencia < 0 || conversaoReferencia > 100) throw new Error('PERFORMANCE_CONVERSAO_REFERENCIA inválida');
  const unidadeIds = env.PERFORMANCE_UNIDADE_IDS === undefined ? UNIDADES_INICIAIS : env.PERFORMANCE_UNIDADE_IDS.split(',').map(s => s.trim()).filter(Boolean);
  return { unidadeIds, parserUnidadeIds:(env.PERFORMANCE_PARSER_UNIDADE_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean), conversaoReferencia, quedaPedidos: -5, estabilidadeReceita: 3 };
}
