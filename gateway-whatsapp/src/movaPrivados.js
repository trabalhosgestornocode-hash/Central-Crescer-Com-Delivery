// MOVA — CONVERSAS PRIVADAS AUTORIZADAS (operação). Generaliza a homologação privada (src/movaHomologacao.js) para uma
// LISTA FECHADA de números cadastrados pelo proprietário (participantes autorizados e entregadores).
//
// DESLIGADA POR PADRÃO. Só liga com as DUAS variáveis:
//   WHATSAPP_MOVA_PRIVADOS=<E.164 sem '+'>,<...>        (os números ficam SÓ no ambiente; nunca no código/repositório)
//   WHATSAPP_MOVA_PRIVADOS_CONFIRMACAO=privados-autorizados-mova   (texto exato)
// Cada número é VERIFICADO pelo próprio WhatsApp (mesma regra da homologação: JID canônico e LID, por socket; dúvida = não
// passa). Mensagem privada de QUALQUER outro contato continua sem ir ao MOVA (a Central de Comunicação não muda).
// O contato de homologação, quando ligado, entra no mesmo conjunto (mesma interface).
import { criarVerificadorDeContato } from "./movaHomologacao.js";
import { resolverJidCanonico } from "./destinatario.js";

export const CONFIRMACAO_PRIVADOS = "privados-autorizados-mova";
export const MAX_PRIVADOS = 50;

/** { ativo:false, motivo } | { ativo:true, telefones:["+55…"] }. Número fora do formato ⇒ erro no boot (fail-closed). */
export function lerPrivadosMova({ lista, confirmacao }) {
  const itens = String(lista ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (itens.length === 0) return { ativo: false, motivo: "SEM_PRIVADOS" };
  for (const n of itens) if (!/^[1-9][0-9]{7,14}$/.test(n)) throw new Error("WHATSAPP_MOVA_PRIVADOS precisa listar telefones em E.164 sem o '+' (só dígitos), separados por vírgula");
  const unicos = [...new Set(itens)];
  if (unicos.length > MAX_PRIVADOS) throw new Error(`WHATSAPP_MOVA_PRIVADOS aceita no máximo ${MAX_PRIVADOS} números`);
  if (String(confirmacao ?? "").trim() !== CONFIRMACAO_PRIVADOS) return { ativo: false, motivo: "SEM_CONFIRMACAO_DE_MODO" };
  return { ativo: true, telefones: Object.freeze(unicos.map((n) => `+${n}`)) };
}

/**
 * Conjunto de contatos verificados. Interface compatível com o verificador único (mensagemDoContato, jidAutorizadoParaEnvio,
 * identidade) e, para vários contatos: `quemEnviou(m, socket)` → identidade {jid, lid} | null, e
 * `identidadeDoDestino(jid, socket)` → identidade | null. Nunca lança.
 * @param {{telefonesE164:string[], resolver?:typeof resolverJidCanonico}} p
 */
export function criarVerificadorDeContatos({ telefonesE164, resolver = resolverJidCanonico }) {
  const unicos = [...new Set(telefonesE164 ?? [])];
  if (unicos.length === 0) throw new TypeError("privados MOVA: lista vazia");
  const verificadores = unicos.map((t) => criarVerificadorDeContato({ telefoneE164: t, resolver }));
  async function quemEnviou(m, socket) {
    for (const v of verificadores) {
      if (await v.mensagemDoContato(m, socket)) { try { return await v.identidade(socket); } catch { return null; } }
    }
    return null;
  }
  async function identidadeDoDestino(jid, socket) {
    for (const v of verificadores) {
      if (await v.jidAutorizadoParaEnvio(jid, socket)) { try { return await v.identidade(socket); } catch { return null; } }
    }
    return null;
  }
  return Object.freeze({
    total: verificadores.length,
    quemEnviou,
    identidadeDoDestino,
    async mensagemDoContato(m, socket) { return (await quemEnviou(m, socket)) !== null; },
    async jidAutorizadoParaEnvio(jid, socket) { return (await identidadeDoDestino(jid, socket)) !== null; },
    /** Compatibilidade com o verificador único: identidade do PRIMEIRO contato. */
    identidade: (socket) => verificadores[0].identidade(socket),
  });
}
