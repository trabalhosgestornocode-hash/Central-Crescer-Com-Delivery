// Finalidade da conexão iFood: uma unidade pode ter conexões INDEPENDENTES (ex.: Financial de homologação + Order de produção).
//
// REGRAS (espelhadas no banco, migration 124):
//   * `legado`: a conexão única de antes (Saci). Serve a qualquer app, mas só quando é a ÚNICA conexão viva da unidade;
//   * `financeiro_homologacao`: só apps financial/analytics (nunca `order`) e ambiente `homologacao`;
//   * `pedidos_producao`: só o app `order` e ambiente `producao`.
// A escolha da conexão NUNCA depende da ordem dos registros: finalidade exata, ou a única legada, ou nada (ou erro de ambiguidade).

import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";
import { IFOOD_APP_ORDER } from "./ifood.constants.js";

export const FINALIDADES = Object.freeze({
  FINANCEIRO_HOMOLOGACAO: "financeiro_homologacao",
  PEDIDOS_PRODUCAO: "pedidos_producao",
  LEGADO: "legado",
});

export const AMBIENTES = Object.freeze({ NAO_INFORMADO: "nao_informado", HOMOLOGACAO: "homologacao", PRODUCAO: "producao" });

/** Finalidade que um app OAuth exige (order -> pedidos; financial/analytics -> financeiro). */
export function finalidadeDoApp(appType) {
  return appType === IFOOD_APP_ORDER ? FINALIDADES.PEDIDOS_PRODUCAO : FINALIDADES.FINANCEIRO_HOMOLOGACAO;
}

export function ambienteDaFinalidade(finalidade) {
  if (finalidade === FINALIDADES.PEDIDOS_PRODUCAO) return AMBIENTES.PRODUCAO;
  if (finalidade === FINALIDADES.FINANCEIRO_HOMOLOGACAO) return AMBIENTES.HOMOLOGACAO;
  return AMBIENTES.NAO_INFORMADO;
}

/** Linha sem a coluna (migration 124 ainda não aplicada) conta como `legado`. */
export function finalidadeDaLinha(linha) {
  return linha?.finalidade ?? FINALIDADES.LEGADO;
}

/** O app pode ser gravado numa conexão desta finalidade? (mesma regra do trigger do banco) */
export function appPermitidoNaFinalidade(finalidade, appType) {
  if (finalidade === FINALIDADES.PEDIDOS_PRODUCAO) return appType === IFOOD_APP_ORDER;
  if (finalidade === FINALIDADES.FINANCEIRO_HOMOLOGACAO) return appType !== IFOOD_APP_ORDER;
  return true;
}

/** A conexão pode ser consultada para pedidos/eventos? (o Financial de homologação NUNCA) */
export function conexaoServePedidos(linha) {
  return finalidadeDaLinha(linha) !== FINALIDADES.FINANCEIRO_HOMOLOGACAO;
}

/**
 * Escolhe UMA conexão entre as vivas da unidade.
 *  - com `finalidade`: a de finalidade exata; senão a legada, se for a única viva; senão null;
 *  - sem `finalidade`: a única viva; mais de uma = IFOOD_CONEXAO_AMBIGUA (nunca adivinha).
 */
export function escolherConexao(linhas, finalidade = null) {
  const vivas = (linhas ?? []).filter((c) => c && c.status !== "revogada");
  if (!finalidade) {
    if (vivas.length === 0) return null;
    if (vivas.length === 1) return vivas[0];
    throw ifoodErro(IFOOD_ERROS.IFOOD_CONEXAO_AMBIGUA);
  }
  const exatas = vivas.filter((c) => finalidadeDaLinha(c) === finalidade);
  if (exatas.length === 1) return exatas[0];
  if (exatas.length > 1) throw ifoodErro(IFOOD_ERROS.IFOOD_CONEXAO_AMBIGUA);
  if (vivas.length === 1 && finalidadeDaLinha(vivas[0]) === FINALIDADES.LEGADO) return vivas[0];
  return null;
}
