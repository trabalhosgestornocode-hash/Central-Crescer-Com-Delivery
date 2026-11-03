// Preparação da linha de conexão Foody de uma unidade (token cifrado + impressão). Função PURA: não grava nada.
// O cadastro em produção (tela ou script) é etapa futura e exige aprovação; aqui só existe o formato seguro da linha.
import { impressaoToken } from "./foody.seguranca.js";

/**
 * @param {{organizacaoId:string, unidadeId:string, token:string, pontoColetaEsperado?:string, criadoPor?:string}} p
 * @param {{cifrarToken:Function}} seguranca
 */
export function prepararConexao({ organizacaoId, unidadeId, token, pontoColetaEsperado = null, criadoPor = null }, seguranca) {
  if (!organizacaoId || !unidadeId) throw new TypeError("prepararConexao: organização e unidade obrigatórias.");
  const limpo = String(token ?? "").trim();
  if (limpo.length < 8) throw new TypeError("prepararConexao: token inválido.");
  return {
    organizacao_id: organizacaoId,
    unidade_id: unidadeId,
    status: "PAUSADA", // nasce pausada: ativar é um passo explícito
    token_cifrado: seguranca.cifrarToken(limpo, unidadeId),
    token_impressao: impressaoToken(limpo),
    ponto_coleta_esperado: pontoColetaEsperado ? String(pontoColetaEsperado).trim().slice(0, 120) : null,
    criado_por: criadoPor,
  };
}
