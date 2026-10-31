// PROTÓTIPO (NÃO LIGADO a nada): consolidar os avisos do D-1 de um MESMO telefone em poucas mensagens, respeitando as autorizações.
// Existe para a decisão material do RATE_LIMIT (alternativa "consolidar por telefone") e para provar as regras antes de qualquer uso:
//   * só agrupa itens do MESMO contato de WhatsApp (nunca mistura telefones);
//   * só entra bloco AUTORIZADO daquele registro (empresa/unidade/categoria habilitadas e sem revogação/opt-out): o resto é excluído com motivo;
//   * cada bloco continua ATRIBUÍDO à sua empresa e unidade (o texto de uma empresa nunca aparece sob o nome de outra);
//   * ordem determinística (empresa, unidade, id) e chave idempotente (hash dos ids ordenados): reprocessar não duplica;
//   * nunca corta um bloco ao meio: se passar do limite de caracteres, abre outra mensagem (um bloco gigante vai sozinho);
//   * 1 bloco só ⇒ a mensagem original, intacta (compatível com o comportamento de hoje).
// Não chama provider, banco, fila nem política. A política de envio (quantas mensagens, quando) segue sendo decidida fora daqui.
import crypto from "node:crypto";

const TITULO = (b) => `*${b.empresa} — ${b.unidade}*`;
const ordem = (a, b) => String(a.empresa).localeCompare(String(b.empresa), "pt-BR") || String(a.unidade).localeCompare(String(b.unidade), "pt-BR") || String(a.id).localeCompare(String(b.id));
export const chaveDeConsolidacao = (ids) => crypto.createHash("sha256").update([...ids].map(String).sort().join("|")).digest("hex").slice(0, 32);

/**
 * @param {Array<{id: string, contatoWhatsappId: string, organizacaoId: string, empresa: string, unidade: string, conteudo: string, autorizado: boolean}>} itens
 * @param {{maxCaracteres?: number}} [opcoes]
 * @returns {{mensagens: Array<{contatoWhatsappId: string, chave: string, ids: string[], texto: string, blocos: number}>, excluidos: Array<{id: string, motivo: string}>}}
 */
export function consolidarPorTelefone(itens, { maxCaracteres = 1500 } = {}) {
  const excluidos = []; const porTelefone = new Map();
  for (const it of itens ?? []) {
    if (!it?.id || !it.contatoWhatsappId || !it.organizacaoId || typeof it.conteudo !== "string" || !it.conteudo.trim()) { excluidos.push({ id: it?.id ?? null, motivo: "ITEM_INVALIDO" }); continue; }
    if (it.autorizado !== true) { excluidos.push({ id: it.id, motivo: "NAO_AUTORIZADO" }); continue; }
    if (!porTelefone.has(it.contatoWhatsappId)) porTelefone.set(it.contatoWhatsappId, []);
    porTelefone.get(it.contatoWhatsappId).push(it);
  }
  const mensagens = [];
  for (const [contatoWhatsappId, lista] of [...porTelefone.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)))) {
    const ordenados = [...lista].sort(ordem);
    if (ordenados.length === 1) { const u = ordenados[0]; mensagens.push({ contatoWhatsappId, chave: u.id, ids: [u.id], texto: u.conteudo, blocos: 1 }); continue; }
    let atual = [];
    const fecha = () => { if (!atual.length) return; mensagens.push({ contatoWhatsappId, chave: chaveDeConsolidacao(atual.map((b) => b.id)), ids: atual.map((b) => b.id), texto: atual.map((b) => `${TITULO(b)}\n${b.conteudo.trim()}`).join("\n\n"), blocos: atual.length }); atual = []; };
    const tamanho = (bs) => bs.map((b) => `${TITULO(b)}\n${b.conteudo.trim()}`).join("\n\n").length;
    for (const b of ordenados) {
      if (atual.length && tamanho([...atual, b]) > maxCaracteres) fecha();
      atual.push(b);
    }
    fecha();
  }
  return { mensagens, excluidos };
}
