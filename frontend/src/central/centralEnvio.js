// CENTRAL DE COMUNICAÇÃO — o FLUXO de envio de uma mensagem manual, sem DOM (testável com uma API falsa).
//
// GARANTIAS
//   * DUPLO CLIQUE não duplica: enquanto um envio está em andamento, outro é recusado aqui; e, mesmo que passasse, o `envioId` é o mesmo e o backend cria UMA linha.
//   * Falha DEFINITIVA (o servidor recusou: 4xx) ⇒ a bolha some e o texto VOLTA ao composer (nada foi criado; o `envioId` é preservado).
//   * Falha AMBÍGUA (rede/timeout/5xx: o servidor pode ter recebido) ⇒ a bolha vira "Falhou" com "Tentar de novo", que reusa o MESMO `envioId` — nunca duplica.
//   * NUNCA há retry automático.

import { mensagemOtimista, comoFalhaLocal, textoEnviavel } from "./centralModelo.js";

/** 4xx (exceto 408) = o servidor RECUSOU antes de criar qualquer coisa; o resto é ambíguo. */
export const foiRecusa = (err) => Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 && err.status !== 408;

export const MSG_AMBIGUA = "Não foi possível confirmar o envio. Se a mensagem não aparecer entregue, use Tentar de novo: ela não será duplicada.";

/**
 * @param {object} p
 * @param {{conversaEnviar: Function}} p.api
 * @param {string} p.contatoId
 * @param {string} p.texto
 * @param {string} p.envioId
 * @param {string|null} [p.operador]
 * @param {Date} [p.agora]
 * @param {string|null} [p.organizacaoId] @param {string|null} [p.unidadeId]
 * @returns {Promise<{tipo: 'invalido'} | {tipo: 'ok', otimista: object, mensagem: object|null, jaExistia: boolean}
 *   | {tipo: 'recusado', otimista: object, erro: string} | {tipo: 'ambiguo', otimista: object, falha: object, erro: string}>}
 */
export async function executarEnvio({ api, contatoId, texto, envioId, operador = null, agora = new Date(), organizacaoId = null, unidadeId = null }) {
  if (!textoEnviavel(texto) || !envioId || !contatoId) return { tipo: "invalido" };
  const limpo = texto.trim();
  const otimista = mensagemOtimista({ envioId, texto: limpo, operador, agora });
  try {
    const r = await api.conversaEnviar(contatoId, { envioId, texto: limpo, organizacaoId: organizacaoId ?? undefined, unidadeId: unidadeId ?? undefined });
    return { tipo: "ok", otimista, mensagem: r?.mensagem ? { ...r.mensagem, envioId } : null, jaExistia: r?.jaExistia === true, status: r?.status ?? null };
  } catch (err) {
    if (foiRecusa(err)) return { tipo: "recusado", otimista, erro: err.message || "O envio foi recusado." };
    return { tipo: "ambiguo", otimista, falha: comoFalhaLocal(otimista, MSG_AMBIGUA), erro: MSG_AMBIGUA };
  }
}

/** Guarda anti-duplo-clique: `tentar()` devolve false se já há um envio em andamento. Um objeto por conversa aberta. */
export function criarTrava() {
  let emAndamento = false;
  return {
    tentar() { if (emAndamento) return false; emAndamento = true; return true; },
    liberar() { emAndamento = false; },
    ativa: () => emAndamento,
  };
}
