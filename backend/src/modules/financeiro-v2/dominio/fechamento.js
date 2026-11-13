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

/**
 * Execução 06D — a mesma regra, sem lançar: para a PRÉVIA da tela (o botão só fica habilitado se o núcleo permitir).
 * @returns {{acao:string|null, motivos:string[]}}
 */
export function avaliarTransicao(estadoAtual, novoEstado, dados = {}) {
  const acao = TRANSICOES[estadoAtual]?.[novoEstado] ?? null;
  const motivos = [];
  if (!acao) motivos.push("Transição de fechamento não permitida a partir do estado atual.");
  if (novoEstado === E.FECHAMENTO_COM_PENDENCIAS && !(dados.pendencias?.length > 0)) motivos.push("Exige a lista das pendências documentadas.");
  if (novoEstado === E.FECHAMENTO_HOMOLOGADO && !dados.metodologia) motivos.push("Exige a metodologia aplicada.");
  if (novoEstado === E.ABERTA && !dados.justificativa) motivos.push("Reabrir exige justificativa.");
  return { acao, motivos };
}

/** Transições que gravam ação sensível e exigem confirmação explícita (homologar e reabrir uma homologada). */
export const exigeConfirmacao = (estadoAtual, novoEstado) => novoEstado === E.FECHAMENTO_HOMOLOGADO || (estadoAtual === E.FECHAMENTO_HOMOLOGADO && novoEstado === E.ABERTA);

/** O que cada estado bloqueia (texto para a tela e para o histórico). */
export const EFEITO_DO_ESTADO = Object.freeze({
  [E.ABERTA]: "Operações autorizadas seguem normalmente, com histórico.",
  [E.FECHAMENTO_PRELIMINAR]: "Indicadores e metodologia ficam registrados numa versão preliminar; ajustes autorizados continuam permitidos.",
  [E.FECHAMENTO_COM_PENDENCIAS]: "Escritas só como correção auditada (permissão de corrigir), com marca na competência; as pendências ficam documentadas, não resolvidas.",
  [E.FECHAMENTO_HOMOLOGADO]: "Escritas econômicas ficam bloqueadas no núcleo e no banco; recebimentos e pagamentos posteriores ficam registrados como atualização posterior, sem mudar a versão homologada.",
});

export const aceitaEscrita = (estado) => estado !== E.FECHAMENTO_HOMOLOGADO;
export const exigeCorrecaoAuditada = (estado) => estado === E.FECHAMENTO_COM_PENDENCIAS;
