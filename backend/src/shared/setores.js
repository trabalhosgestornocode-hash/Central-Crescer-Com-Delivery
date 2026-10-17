// Setores navegáveis (UI). Função pura: a decisão final de segurança continua no backend, rota a rota.
// Operacional = qualquer permissão operacional no contexto (comportamento atual preservado).
// Financeiro = concessão vigente (resolverAcessoFinanceiro); impersonação nunca enxerga o financeiro.
export function calcularSetores({ permissoes, impersonando, financeiroOk }) {
  const setores = [];
  if (financeiroOk && !impersonando) setores.push("financeiro");
  if (Array.isArray(permissoes) && permissoes.length > 0) setores.push("operacional");
  return setores;
}
