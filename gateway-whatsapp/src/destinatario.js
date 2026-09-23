// H.4-B.4 — PRÉ-VALIDAÇÃO DO DESTINATÁRIO: consulta o PRÓPRIO WhatsApp (usync "contact", Baileys 6.7.24 `socket.onWhatsApp`)
// e devolve o JID CANÔNICO que o servidor respondeu — nunca um JID montado por concatenação.
//
// POR QUÊ. O 1º envio real terminou em SENT (sendMessage resolveu) sem que o humano recebesse. `paraJid()` só normaliza o
// número e acrescenta `@s.whatsapp.net`; para números do Brasil o WhatsApp pode ter o JID SEM o 9º dígito (ou COM), e um JID
// inexistente é aceito pelo servidor sem erro. A autoridade é a resposta do provider: NENHUMA heurística de adicionar/remover o
// 9º dígito é feita aqui (o mesmo vale para qualquer outro país).
//
// COMPORTAMENTO COMPROVADO NO BAILEYS INSTALADO (node_modules/baileys/lib/Socket/chats.js#onWhatsApp + WAUSync):
//   * número EXISTE   -> `[{ jid: "<user>@s.whatsapp.net", exists: true, lid?: "<...>@lid" }]`  (`jid` = atributo `jid` do nó `user` da resposta);
//   * número NÃO existe -> `[]` (o Baileys filtra `!!a.contact`; o protocolo devolve `contact type="out"` => `false`);
//   * resposta que não é `type="result"` -> `undefined`;
//   * falha de rede/timeout/erro do servidor -> a Promise REJEITA.
//
// FAIL-CLOSED: qualquer coisa que não seja "existe, com exatamente 1 JID de usuário coerente com o número pedido" NÃO envia:
//   RECIPIENT_NOT_ON_WHATSAPP  ([] ou exists=false)                              — PERMANENTE (nada saiu)
//   RECIPIENT_UNVERIFIED       (formato inesperado / mais de 1 resultado / JID incoerente) — PERMANENTE (nada saiu)
//   RECIPIENT_LOOKUP_FAILED    (rejeição, timeout, resposta `undefined`)         — transitório  (nada saiu)
// COERÊNCIA: o JID devolvido precisa compartilhar os últimos 8 dígitos com o número pedido. Não é heurística de correção — só
// impede aceitar uma resposta que aponte para OUTRA pessoa (a variação legítima do 9º dígito preserva os 8 finais).

import { erro, CODIGOS } from "./errors.js";

export const TIMEOUT_CONSULTA_DESTINATARIO_MS = 10_000;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const JID_USUARIO_PN = /^([1-9][0-9]{7,14})@s\.whatsapp\.net$/;
const DIGITOS_FINAIS = 8;

/**
 * @param {object} p
 * @param {{onWhatsApp?: (...jids: string[]) => Promise<any>}} p.socket
 * @param {string} p.telefoneE164
 * @param {number} [p.timeoutMs]
 * @param {typeof setTimeout} [p.agendar]
 * @param {typeof clearTimeout} [p.cancelar]
 * @returns {Promise<{jid: string, jidDifereDoPedido: boolean}>}  o `jid` é o que o WhatsApp respondeu
 * @throws {import('./errors.js').GatewayError} com `preEnvio = true` (nada foi enviado) — códigos acima
 */
export async function resolverJidCanonico({ socket, telefoneE164, timeoutMs = TIMEOUT_CONSULTA_DESTINATARIO_MS, agendar = setTimeout, cancelar = clearTimeout }) {
  const falha = (codigo, detalhe) => { const e = erro(codigo, detalhe); e.preEnvio = true; return e; };
  if (typeof telefoneE164 !== "string" || !E164.test(telefoneE164)) throw falha(CODIGOS.DESTINATARIO_NAO_VERIFICADO, "telefone fora do formato E.164");
  if (typeof socket?.onWhatsApp !== "function") throw falha(CODIGOS.DESTINATARIO_NAO_VERIFICADO, "socket sem onWhatsApp");
  const digitos = telefoneE164.slice(1);

  let resposta;
  let timer;
  try {
    const timeout = new Promise((_, rej) => { timer = agendar(() => rej(new Error("timeout")), timeoutMs); });
    resposta = await Promise.race([socket.onWhatsApp(digitos), timeout]);
  } catch (e) {
    throw falha(CODIGOS.CONSULTA_DESTINATARIO_FALHOU, e?.message === "timeout" ? "timeout" : (e?.name ?? "erro"));
  } finally {
    if (timer !== undefined) cancelar(timer);
  }

  if (resposta === undefined || resposta === null) throw falha(CODIGOS.CONSULTA_DESTINATARIO_FALHOU, "resposta vazia");
  if (!Array.isArray(resposta)) throw falha(CODIGOS.DESTINATARIO_NAO_VERIFICADO, "resposta não é lista");
  if (resposta.length === 0) throw falha(CODIGOS.DESTINATARIO_INEXISTENTE, "lista vazia");
  if (resposta.length !== 1) throw falha(CODIGOS.DESTINATARIO_NAO_VERIFICADO, "mais de um resultado");

  const item = resposta[0];
  if (item === null || typeof item !== "object") throw falha(CODIGOS.DESTINATARIO_NAO_VERIFICADO, "item inválido");
  if (item.exists === false) throw falha(CODIGOS.DESTINATARIO_INEXISTENTE, "exists=false");
  if (item.exists !== true) throw falha(CODIGOS.DESTINATARIO_NAO_VERIFICADO, "exists inesperado");
  const m = typeof item.jid === "string" ? JID_USUARIO_PN.exec(item.jid) : null;
  if (!m) throw falha(CODIGOS.DESTINATARIO_NAO_VERIFICADO, "jid fora do formato de usuário");
  if (m[1].slice(-DIGITOS_FINAIS) !== digitos.slice(-DIGITOS_FINAIS)) throw falha(CODIGOS.DESTINATARIO_NAO_VERIFICADO, "jid incoerente com o número pedido");
  return { jid: item.jid, jidDifereDoPedido: m[1] !== digitos };
}
