// Máquina de estados da competência financeira.
//
//   ABERTA → FECHAMENTO_PRELIMINAR → FECHAMENTO_COM_PENDENCIAS → FECHAMENTO_HOMOLOGADO
//                                  ↘────────────────────────────↗
// Voltar para ABERTA é sempre uma REVISÃO: exige justificativa e fica no histórico. Sair de HOMOLOGADO exige a ação
// própria de revisão (`financeiro_v2.revisar`).
//
// Escrita por estado (decisão da Execução 01B):
//   ABERTA / FECHAMENTO_PRELIMINAR → operações autorizadas, com histórico.
//   FECHAMENTO_COM_PENDENCIAS      → só correções auditadas: exige `financeiro_v2.corrigir` e deixa marca na competência.
//   FECHAMENTO_HOMOLOGADO          → bloqueada; reabrir exige permissão de revisão, justificativa e auditoria.
import { CODIGO, falhar } from "./erros.js";
import { ESTADO_COMPETENCIA as E } from "./catalogos.js";
import { ACAO } from "./contexto.js";

const TRANSICOES = Object.freeze({
  [E.ABERTA]: { [E.FECHAMENTO_PRELIMINAR]: ACAO.FECHAR },
  [E.FECHAMENTO_PRELIMINAR]: { [E.FECHAMENTO_COM_PENDENCIAS]: ACAO.FECHAR, [E.FECHAMENTO_HOMOLOGADO]: ACAO.HOMOLOGAR, [E.ABERTA]: ACAO.FECHAR },
  [E.FECHAMENTO_COM_PENDENCIAS]: { [E.FECHAMENTO_PRELIMINAR]: ACAO.FECHAR, [E.FECHAMENTO_HOMOLOGADO]: ACAO.HOMOLOGAR, [E.ABERTA]: ACAO.FECHAR },
  [E.FECHAMENTO_HOMOLOGADO]: { [E.ABERTA]: ACAO.REVISAR },
});

/**
 * Valida a transição e devolve a ação exigida para executá-la.
 * @param {{pendencias?:string[], metodologia?:string|null, justificativa?:string|null}} dados
 */
export function acaoDaTransicao(estadoAtual, novoEstado, dados = {}) {
  const acao = TRANSICOES[estadoAtual]?.[novoEstado];
  if (!acao) falhar(CODIGO.TRANSICAO_INVALIDA, "Transição de fechamento não permitida.", { de: estadoAtual, para: novoEstado });
  if (novoEstado === E.FECHAMENTO_COM_PENDENCIAS && !(dados.pendencias?.length > 0)) {
    falhar(CODIGO.TRANSICAO_INVALIDA, "Fechamento com pendências exige a lista das pendências documentadas.");
  }
  if (novoEstado === E.FECHAMENTO_HOMOLOGADO && !dados.metodologia) {
    falhar(CODIGO.TRANSICAO_INVALIDA, "Homologação exige a metodologia aplicada.");
  }
  if (novoEstado === E.ABERTA && !dados.justificativa) {
    falhar(CODIGO.TRANSICAO_INVALIDA, "Reabrir uma competência exige justificativa.");
  }
  return acao;
}

export const aceitaEscrita = (estado) => estado !== E.FECHAMENTO_HOMOLOGADO;
export const exigeCorrecaoAuditada = (estado) => estado === E.FECHAMENTO_COM_PENDENCIAS;
