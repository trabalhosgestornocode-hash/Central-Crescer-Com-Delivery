// Setores navegáveis (UI). Função pura: a decisão final de segurança continua no backend, rota a rota.
//
// OPERACIONAL exige as TRÊS coisas: (1) ao menos um módulo operacional habilitado no contexto (o financeiro não conta),
// (2) ao menos uma permissão operacional de LEITURA (não "qualquer permissão" — e nunca as financeiras) e
// (3) a concessão financeira não marcar "somente financeiro".
// FINANCEIRO exige concessão vigente (resolverAcessoFinanceiro) e nunca existe em impersonação.
import { PERMISSOES as P } from "./permissoes.js";
import { MODULO_FINANCEIRO } from "./gestaoFinanceira.permissoes.js";

/** Permissões que provam acesso à área operacional (qualquer papel operacional tem ao menos uma; o perfil de exibição tem o checklist). */
export const PERMISSOES_OPERACIONAIS = Object.freeze([
  P.DASHBOARD_VER, P.PRODUTOS_VER, P.INSUMOS_VER, P.CMV_VER, P.VENDAS_VER, P.INTEGRACOES_VER,
  P.DASHBOARD_EXECUTIVO_VER, P.BONIFICACAO_MENSAL_VER, P.PARSER_FD_VER, P.CHECKLIST_VISUALIZAR,
]);

/**
 * @param {{ permissoes?: string[], modulos?: string[], impersonando?: boolean, financeiroOk?: boolean, somenteFinanceiro?: boolean }} e
 * @returns {Array<'financeiro'|'operacional'>}
 */
export function calcularSetores({ permissoes, modulos, impersonando, financeiroOk, somenteFinanceiro }) {
  const financeiro = financeiroOk === true && !impersonando;
  const temModuloOperacional = Array.isArray(modulos) && modulos.some((m) => m !== MODULO_FINANCEIRO);
  const temPermissaoOperacional = Array.isArray(permissoes) && permissoes.some((p) => PERMISSOES_OPERACIONAIS.includes(p));
  const operacional = temModuloOperacional && temPermissaoOperacional && !(financeiro && somenteFinanceiro === true);
  const setores = [];
  if (financeiro) setores.push("financeiro");
  if (operacional) setores.push("operacional");
  return setores;
}
