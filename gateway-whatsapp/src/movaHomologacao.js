// MOVA — HOMOLOGAÇÃO PRIVADA (Execução 04B): UMA conversa privada explicitamente autorizada substitui o grupo de testes.
//
// DESLIGADA POR PADRÃO. Só liga com as DUAS variáveis (confirmação explícita de modo):
//   WHATSAPP_MOVA_HOMOLOGACAO_CONTATO=<telefone E.164 sem o +>        (o número fica SÓ no ambiente; nunca no código/repositório)
//   WHATSAPP_MOVA_HOMOLOGACAO_CONFIRMACAO=privada-somente-homologacao (texto exato)
// Identidade VERIFICADA (nunca o número declarado no payload): o próprio WhatsApp resolve o número (`onWhatsApp`, mesma função
// do envio individual — src/destinatario.js) e devolve o JID canônico (PN) e, quando há, o LID. Uma mensagem privada só é do
// contato se o `remoteJid` for exatamente esse JID/LID, ou se o chat for LID e o Baileys trouxer `senderPn` igual ao JID. A
// resolução é por SOCKET (reconexão = resolve de novo); falha de resolução = NADA passa (fail-closed).
// Mensagens da própria conta nunca passam. Outros contatos privados nunca passam.
import { resolverJidCanonico } from "./destinatario.js";

export const CONFIRMACAO_HOMOLOGACAO = "privada-somente-homologacao";

/** null = desligado. Fora do formato ou sem a confirmação exata ⇒ desligado (com motivo, sem o número). */
export function lerContatoHomologacao({ contato, confirmacao }) {
  const c = String(contato ?? "").trim();
  if (!c) return { ativo: false, motivo: "SEM_CONTATO" };
  if (!/^[1-9][0-9]{7,14}$/.test(c)) throw new Error("WHATSAPP_MOVA_HOMOLOGACAO_CONTATO precisa ser o telefone em E.164 sem o '+' (só dígitos)");
  if (String(confirmacao ?? "").trim() !== CONFIRMACAO_HOMOLOGACAO) return { ativo: false, motivo: "SEM_CONFIRMACAO_DE_MODO" };
  return { ativo: true, telefoneE164: `+${c}` };
}

const semDevice = (jid) => String(jid ?? "").replace(/:\d+@/, "@");

/**
 * @param {{telefoneE164:string, resolver?:typeof resolverJidCanonico}} p
 */
export function criarVerificadorDeContato({ telefoneE164, resolver = resolverJidCanonico }) {
  let cache = null; // { socket, identidade }
  async function identidade(socket) {
    if (cache && cache.socket === socket) return cache.identidade;
    const r = await resolver({ socket, telefoneE164 }); // lança (preEnvio) se o WhatsApp não confirmar
    // 23/11: no Brasil, conta antiga tem JID canônico SEM o 9º dígito (55 DD XXXXXXXX) enquanto o cadastro guarda 55 DD 9XXXXXXXX.
    // `cadastrado` é o número AUTORIZADO (o do ambiente), que o WhatsApp acabou de confirmar (resolver acima; últimos dígitos
    // coerentes). É a chave da conversa no backend; `jid`/`lid` são o endereço real de entrega.
    const id = Object.freeze({ jid: r.jid, lid: r.lid ?? null, cadastrado: `${telefoneE164.slice(1)}@s.whatsapp.net` });
    cache = { socket, identidade: id };
    return id;
  }
  return Object.freeze({
    identidade,
    /** A mensagem privada é do contato verificado? Nunca lança: qualquer dúvida = false. */
    async mensagemDoContato(m, socket) {
      const key = m?.key;
      if (!key || key.fromMe === true || typeof key.remoteJid !== "string" || key.remoteJid.endsWith("@g.us")) return false;
      let id;
      try { id = await identidade(socket); } catch { return false; }
      const remoto = semDevice(key.remoteJid);
      if (remoto === id.jid || remoto === id.cadastrado) return true;
      if (remoto.endsWith("@lid")) return (id.lid !== null && remoto === id.lid) || [id.jid, id.cadastrado].includes(semDevice(key.senderPn));
      return false;
    },
    /** O JID pedido para ENVIO é o do contato verificado neste socket? */
    async jidAutorizadoParaEnvio(jid, socket) {
      try { const id = await identidade(socket); return [id.jid, id.cadastrado].includes(semDevice(jid)); } catch { return false; }
    },
  });
}
