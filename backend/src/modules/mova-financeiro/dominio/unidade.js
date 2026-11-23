// IDENTIFICAÇÃO DA UNIDADE — determinística e fail-closed. A unidade NUNCA vem do provedor nem da IA sozinha.
//
// Evidências, em ordem de força:
//   1. o grupo só atende UMA unidade (configuração)                      → essa unidade;
//   2. menção explícita no texto/legenda a um apelido configurado        → essa unidade (só entre as do grupo);
//   3. identificador do destinatário no documento (ex.: CNPJ, extraído) → a unidade dona desse identificador;
//   3b. (24/11) PAGADOR do comprovante (titular/documento da conta de origem, cadastro `pagadores`) → a unidade dona dele;
//   4. sugestão da IA (apelido)                                          → só CONFIRMA; sozinha não decide.
// O pagador identifica a unidade mesmo num grupo/conversa com várias unidades (o usuário não precisa escrevê-la); nunca dá
// acesso: pagador de unidade FORA da conversa ⇒ DOCUMENTO_DE_OUTRA_UNIDADE (nada é gravado; orientação para o canal certo).
// Conflito entre evidências (texto diz uma, documento diz outra) ⇒ DOCUMENTO_DE_OUTRA_UNIDADE / UNIDADE_CONFLITANTE: bloqueia.
// Nenhuma evidência ⇒ UNIDADE_NAO_IDENTIFICADA: bloqueia e pede esclarecimento. Documento de unidade FORA do grupo ⇒ bloqueia.
import { normalizar, normalizarDocumento } from "./configuracao.js";
import { RESULTADO_PAGADOR, unidadePeloPagador } from "./pagador.js";

export const RESULTADO_UNIDADE = Object.freeze({
  IDENTIFICADA: "IDENTIFICADA",
  NAO_IDENTIFICADA: "UNIDADE_NAO_IDENTIFICADA",
  CONFLITANTE: "UNIDADE_CONFLITANTE",
  DOCUMENTO_DE_OUTRA_UNIDADE: "DOCUMENTO_DE_OUTRA_UNIDADE",
  FORA_DO_GRUPO: "UNIDADE_FORA_DO_GRUPO",
});

/** Unidades citadas no texto (apelido inteiro, por palavra). */
export function unidadesCitadas(texto, unidades) {
  const t = ` ${normalizar(texto)} `;
  if (t.trim() === "") return [];
  return unidades.filter((u) => u.apelidos.some((a) => t.includes(` ${a} `)));
}

/**
 * @param {{cfg:object, grupo:{unidades:string[]}, textos:string[], documentoDestinatario?:string|null, sugestaoIa?:string|null}} p
 * @returns {{resultado:string, unidade:object|null, evidencia:string|null}}
 */
export function resolverUnidade({ cfg, grupo, textos, documentoDestinatario = null, sugestaoIa = null, pagador = null, documentoPagador = null }) {
  const doGrupo = cfg.unidades.filter((u) => grupo.unidades.includes(u.unidadeId));
  const todas = cfg.unidades;
  // Documento: procura em TODAS as unidades configuradas, para detectar documento de unidade errada/fora do grupo.
  const doc = documentoDestinatario ? normalizarDocumento(documentoDestinatario) : "";
  const peloDocumento = doc ? todas.filter((u) => u.documentos.includes(doc)) : [];
  const citadas = [...new Map(textos.flatMap((t) => unidadesCitadas(t, todas)).map((u) => [u.unidadeId, u])).values()];
  if (citadas.length > 1) return { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "TEXTO_CITA_VARIAS" };
  const citada = citadas[0] ?? null;
  const documentoDe = peloDocumento.length === 1 ? peloDocumento[0] : null;
  // 24/11: pagador (procura em TODAS as unidades, para detectar comprovante pago pela conta de outra unidade).
  const pg = (pagador || documentoPagador) ? unidadePeloPagador({ unidades: todas, pagador, documentoPagador }) : { resultado: RESULTADO_PAGADOR.SEM_EVIDENCIA, unidade: null };
  if (pg.resultado === RESULTADO_PAGADOR.CONFLITO) return { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: pg.evidencia };
  const pagadorDe = pg.unidade;
  if (pagadorDe && !doGrupo.includes(pagadorDe)) return { resultado: RESULTADO_UNIDADE.DOCUMENTO_DE_OUTRA_UNIDADE, unidade: null, evidencia: "PAGADOR_FORA_DA_CONVERSA", unidadeDoDocumento: pagadorDe.nome };
  if (pagadorDe && citada && citada !== pagadorDe) return { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "TEXTO_X_PAGADOR" };
  if (pagadorDe && documentoDe && documentoDe !== pagadorDe) return { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "DOCUMENTO_X_PAGADOR" };

  if (citada && !doGrupo.includes(citada)) return { resultado: RESULTADO_UNIDADE.FORA_DO_GRUPO, unidade: null, evidencia: "TEXTO" };
  if (documentoDe && !doGrupo.includes(documentoDe)) return { resultado: RESULTADO_UNIDADE.DOCUMENTO_DE_OUTRA_UNIDADE, unidade: null, evidencia: "DOCUMENTO_FORA_DO_GRUPO" };
  if (citada && documentoDe && citada !== documentoDe) return { resultado: RESULTADO_UNIDADE.DOCUMENTO_DE_OUTRA_UNIDADE, unidade: null, evidencia: "TEXTO_X_DOCUMENTO" };

  const sugerida = sugestaoIa ? unidadesCitadas(sugestaoIa, doGrupo) : [];
  const confirmaIa = (u) => sugerida.length === 0 || (sugerida.length === 1 && sugerida[0] === u);
  if (citada) return confirmaIa(citada) ? { resultado: RESULTADO_UNIDADE.IDENTIFICADA, unidade: citada, evidencia: "TEXTO" } : { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "TEXTO_X_IA" };
  if (pagadorDe) return confirmaIa(pagadorDe) ? { resultado: RESULTADO_UNIDADE.IDENTIFICADA, unidade: pagadorDe, evidencia: pg.evidencia } : { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "PAGADOR_X_IA" };
  if (documentoDe) return confirmaIa(documentoDe) ? { resultado: RESULTADO_UNIDADE.IDENTIFICADA, unidade: documentoDe, evidencia: "DOCUMENTO" } : { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "DOCUMENTO_X_IA" };
  if (doGrupo.length === 1) return confirmaIa(doGrupo[0]) ? { resultado: RESULTADO_UNIDADE.IDENTIFICADA, unidade: doGrupo[0], evidencia: "GRUPO_DE_UMA_UNIDADE" } : { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "GRUPO_X_IA" };
  // Grupo compartilhado sem evidência própria: a sugestão da IA NÃO basta.
  return { resultado: RESULTADO_UNIDADE.NAO_IDENTIFICADA, unidade: null, evidencia: null };
}
