// MOVA — avaliação DETERMINÍSTICA de um comprovante antes de qualquer baixa documental (pagamento por comprovante).
//
// A IA só LÊ o documento (situação impressa, valor, data, favorecido, identificador). Ela NUNCA atesta autenticidade
// bancária: aparência de comprovante não basta. Quem decide se a leitura serve para registrar pagamento é esta função,
// com regras fixas e conservadoras; qualquer dúvida ⇒ conferência humana (nunca "pago" no escuro).
//
// Situações distinguidas (para a resposta e para a Central):
//   PIX_CONCLUIDO · PIX_AGENDADO · TRANSFERENCIA_PENDENTE · TRANSACAO_CANCELADA · DOCUMENTO_ILEGIVEL · DOCUMENTO_INCONSISTENTE ·
//   COMPROVANTE_DUPLICADO · DOCUMENTO_SUSPEITO (integridade do arquivo) · NAO_E_COMPROVANTE.

export const SITUACAO_TRANSACAO = Object.freeze(["CONCLUIDA", "AGENDADA", "PENDENTE", "CANCELADA", "NAO_IDENTIFICADA"]);

export const SITUACAO_COMPROVANTE = Object.freeze({
  PIX_CONCLUIDO: "PIX_CONCLUIDO",
  PIX_AGENDADO: "PIX_AGENDADO",
  TRANSFERENCIA_PENDENTE: "TRANSFERENCIA_PENDENTE",
  TRANSACAO_CANCELADA: "TRANSACAO_CANCELADA",
  DOCUMENTO_ILEGIVEL: "DOCUMENTO_ILEGIVEL",
  DOCUMENTO_INCONSISTENTE: "DOCUMENTO_INCONSISTENTE",
  COMPROVANTE_DUPLICADO: "COMPROVANTE_DUPLICADO",
  DOCUMENTO_SUSPEITO: "DOCUMENTO_SUSPEITO",
  NAO_E_COMPROVANTE: "NAO_E_COMPROVANTE",
});

/**
 * @param {object} leitura  saída validada do extrator (tipoDocumento, legivel, situacaoTransacao, valorCentavos, dataPagamento,
 *                          favorecido, idTransacao, confianca, camposAusentes, incertezas)
 * @param {{hoje:string, duplicado?:boolean, integridadeOk?:boolean}} contexto
 * @returns {{situacao:string, apto:boolean, comIdentificador:boolean, motivos:string[]}}
 *          `apto` = pode servir de evidência para baixa documental (ainda sujeita à política, ao limite e à duplicidade no Financeiro).
 */
export function avaliarComprovante(leitura, { hoje, duplicado = false, integridadeOk = true } = {}) {
  const r = (situacao, motivos = []) => Object.freeze({ situacao, apto: situacao === SITUACAO_COMPROVANTE.PIX_CONCLUIDO && motivos.length === 0, comIdentificador: Boolean(leitura?.idTransacao), motivos: Object.freeze(motivos) });
  if (!leitura || leitura.tipoDocumento !== "COMPROVANTE_PAGAMENTO") return r(SITUACAO_COMPROVANTE.NAO_E_COMPROVANTE, ["NAO_E_COMPROVANTE"]);
  if (!integridadeOk) return r(SITUACAO_COMPROVANTE.DOCUMENTO_SUSPEITO, ["INTEGRIDADE_DO_ARQUIVO"]);
  if (duplicado) return r(SITUACAO_COMPROVANTE.COMPROVANTE_DUPLICADO, ["DUPLICADO"]);
  if (leitura.legivel === false) return r(SITUACAO_COMPROVANTE.DOCUMENTO_ILEGIVEL, ["ILEGIVEL"]);
  const st = leitura.situacaoTransacao ?? "NAO_IDENTIFICADA";
  if (st === "AGENDADA") return r(SITUACAO_COMPROVANTE.PIX_AGENDADO, ["AGENDAMENTO_NAO_E_PAGAMENTO"]);
  if (st === "PENDENTE") return r(SITUACAO_COMPROVANTE.TRANSFERENCIA_PENDENTE, ["TRANSACAO_PENDENTE"]);
  if (st === "CANCELADA") return r(SITUACAO_COMPROVANTE.TRANSACAO_CANCELADA, ["TRANSACAO_CANCELADA"]);
  const motivos = [];
  if (st !== "CONCLUIDA") motivos.push("CONCLUSAO_NAO_IDENTIFICADA");
  if (!(Number.isSafeInteger(leitura.valorCentavos) && leitura.valorCentavos > 0)) motivos.push("VALOR_AUSENTE");
  if (!leitura.dataPagamento) motivos.push("DATA_AUSENTE");
  else if (hoje && leitura.dataPagamento > hoje) motivos.push("DATA_FUTURA");
  if (!leitura.favorecido) motivos.push("FAVORECIDO_AUSENTE");
  if (leitura.confianca && leitura.confianca !== "ALTA") motivos.push("CONFIANCA_DA_LEITURA");
  if ((leitura.camposAusentes ?? []).length) motivos.push("CAMPOS_AUSENTES");
  if ((leitura.incertezas ?? []).length) motivos.push("INCERTEZAS_NA_LEITURA");
  if (motivos.length) return r(SITUACAO_COMPROVANTE.DOCUMENTO_INCONSISTENTE, motivos);
  return r(SITUACAO_COMPROVANTE.PIX_CONCLUIDO);
}
