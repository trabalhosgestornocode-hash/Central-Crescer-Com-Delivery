// PROPOSTA (NÃO LIGADA a nada): consolidar os avisos do D-1 de um MESMO telefone numa mensagem só, sem perder nenhuma autorização.
// Contexto (doc 32): um mesmo responsável cadastrado em 7 empresas/lojas recebe 7 mensagens/dia e o teto de 3/dia por telefone barra 4.
// Este módulo é PURO (sem banco, provider, fila, política nem relógio global) e existe para provar as invariantes ANTES de qualquer uso:
//   1. AUTORIZAÇÃO INDEPENDENTE por empresa e unidade: cada bloco é avaliado pelas regras do SEU registro (registro ativo, categoria habilitada,
//      opt-out do contato, empresa habilitada/pausada, unidade no escopo, revogação). Bloco não autorizado NUNCA entra, e não derruba os demais.
//   2. CONTEÚDO COMPLETO: o texto de cada relatório entra byte a byte, sem trim, sem corte, sem resumo. Se não couber, vira outra mensagem.
//   3. RASTREABILIDADE: cada bloco leva o título "empresa — unidade" e a saída lista, por bloco, id, empresa e unidade.
//   4. REVOGAÇÃO POR DESTINATÁRIO: revogar um registro tira só o bloco dele; opt-out do contato tira todos os blocos daquele telefone.
//   5. LIMITE: nenhuma mensagem passa do limite (padrão 3500 < 4096 do provider); bloco que sozinho não cabe com o título sai como a mensagem
//      ORIGINAL (sem título), e acima do limite do provedor é excluído com motivo — nunca cortado.
//   6. IDEMPOTÊNCIA: ordem determinística (empresa, unidade, id) e chave = hash dos ids ordenados; o mesmo conjunto gera a mesma chave
//      (reprocessar não duplica); outro conjunto (ex.: um bloco revogado) é OUTRA mensagem.
//   7. ISOLAMENTO: só agrupa itens do MESMO contato de WhatsApp; telefones diferentes e empresas sem autorização para aquele telefone nunca se misturam.
//   8. COTAS E ENVIO ATUAL INTACTOS: nada aqui altera cotas nem agenda/envia; a mensagem consolidada contaria como UMA para o teto do telefone
//      (decisão de política, fora deste módulo e dependente de autorização).
import crypto from "node:crypto";

export const LIMITE_PROVEDOR = 4096;          // espelha MAX_TEXTO_ENVIO do provider (não importado: este módulo não toca o envio)
export const LIMITE_PADRAO = 3500;            // margem sob o limite do provedor
const SEPARADOR = "\n\n";
const titulo = (b) => `*${b.empresa} — ${b.unidade}*`;
const bloco = (b) => `${titulo(b)}\n${b.conteudo}`;
const cmp = (a, b) => String(a).localeCompare(String(b), "pt-BR");
const ordem = (a, b) => cmp(a.empresa, b.empresa) || cmp(a.unidade, b.unidade) || cmp(a.id, b.id);
export const chaveDeConsolidacao = (ids) => crypto.createHash("sha256").update([...ids].map(String).sort().join("|")).digest("hex").slice(0, 32);

/**
 * Regras de autorização de UM bloco, na ordem; devolve o 1º motivo de exclusão (vocabulário fixo) ou null.
 * @param {{registroAtivo?: boolean, revogado?: boolean, categoriaHabilitada?: boolean, optOutContato?: boolean,
 *          empresaHabilitada?: boolean, empresaPausadaAte?: (Date|string|null), escopoUnidades?: (string[]|null)}} estado
 * @param {{unidadeId?: (string|null)}} item
 */
export function motivoDeExclusao(estado, item = {}, agora = new Date()) {
  const e = estado ?? {};
  if (e.registroAtivo !== true) return "REGISTRO_INATIVO";
  if (e.revogado === true) return "REVOGADO";
  if (e.optOutContato !== false) return "OPT_OUT";                          // ausente/indeterminado = fail-closed
  if (e.categoriaHabilitada !== true) return "CATEGORIA_DESABILITADA";
  if (e.empresaHabilitada !== true) return "EMPRESA_NAO_HABILITADA";
  if (e.empresaPausadaAte && new Date(e.empresaPausadaAte).getTime() > new Date(agora).getTime()) return "EMPRESA_PAUSADA";
  if (Array.isArray(e.escopoUnidades) && !e.escopoUnidades.includes(item.unidadeId)) return "UNIDADE_FORA_DO_ESCOPO";
  return null;
}

/**
 * @param {Array<{id: string, contatoWhatsappId: string, organizacaoId: string, empresa: string, unidade: string, unidadeId?: string, conteudo: string,
 *   autorizado?: boolean, estado?: object}>} itens   `autorizado` explícito OU `estado` (avaliado por motivoDeExclusao); sem nenhum dos dois = não autorizado
 * @param {{maxCaracteres?: number, agora?: Date}} [opcoes]
 * @returns {{mensagens: Array<{contatoWhatsappId: string, chave: string, ids: string[], texto: string, blocos: number,
 *   detalhes: Array<{id: string, organizacaoId: string, empresa: string, unidade: string}>}>, excluidos: Array<{id: (string|null), motivo: string}>}}
 */
export function consolidarPorTelefone(itens, { maxCaracteres = LIMITE_PADRAO, agora = new Date() } = {}) {
  const teto = Math.min(Math.max(Number(maxCaracteres) || LIMITE_PADRAO, 200), LIMITE_PROVEDOR);
  const excluidos = []; const porTelefone = new Map();
  for (const it of itens ?? []) {
    if (!it?.id || !it.contatoWhatsappId || !it.organizacaoId || !it.empresa || !it.unidade || typeof it.conteudo !== "string" || !it.conteudo.trim()) { excluidos.push({ id: it?.id ?? null, motivo: "ITEM_INVALIDO" }); continue; }
    const motivo = typeof it.autorizado === "boolean" ? (it.autorizado ? null : "NAO_AUTORIZADO") : (it.estado ? motivoDeExclusao(it.estado, it, agora) : "NAO_AUTORIZADO");
    if (motivo) { excluidos.push({ id: it.id, motivo }); continue; }
    if (it.conteudo.length > LIMITE_PROVEDOR) { excluidos.push({ id: it.id, motivo: "BLOCO_MAIOR_QUE_O_LIMITE_DO_PROVEDOR" }); continue; }
    if (!porTelefone.has(it.contatoWhatsappId)) porTelefone.set(it.contatoWhatsappId, []);
    porTelefone.get(it.contatoWhatsappId).push(it);
  }
  const mensagens = [];
  const detalhe = (b) => ({ id: b.id, organizacaoId: b.organizacaoId, empresa: b.empresa, unidade: b.unidade });
  for (const [contatoWhatsappId, lista] of [...porTelefone.entries()].sort(([a], [b]) => cmp(a, b))) {
    const ordenados = [...lista].sort(ordem);
    if (ordenados.length === 1) { const u = ordenados[0]; mensagens.push({ contatoWhatsappId, chave: u.id, ids: [u.id], texto: u.conteudo, blocos: 1, detalhes: [detalhe(u)] }); continue; }
    let atual = [];
    const montar = (bs) => bs.map(bloco).join(SEPARADOR);
    const fecha = () => {
      if (!atual.length) return;
      mensagens.push({ contatoWhatsappId, chave: atual.length === 1 ? atual[0].id : chaveDeConsolidacao(atual.map((b) => b.id)), ids: atual.map((b) => b.id),
        texto: atual.length === 1 ? atual[0].conteudo : montar(atual), blocos: atual.length, detalhes: atual.map(detalhe) });
      atual = [];
    };
    for (const b of ordenados) {
      if (bloco(b).length > teto) { fecha(); atual = [b]; fecha(); continue; }                 // não cabe nem sozinho com título: sai como a mensagem ORIGINAL, inteira
      if (atual.length && montar([...atual, b]).length > teto) fecha();
      atual.push(b);
    }
    fecha();
  }
  return { mensagens, excluidos };
}
