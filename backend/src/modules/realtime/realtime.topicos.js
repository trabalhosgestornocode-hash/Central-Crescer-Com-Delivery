// Nomes de canal (tópicos) do Realtime — função PURA, sem I/O, usada dos dois
// lados de uma mesma regra:
//   1. aqui, para o backend dizer ao frontend quais tópicos a credencial
//      recém-emitida autoriza (realtime.controller.js);
//   2. espelhada na policy SQL de `realtime.messages` (proposta, ainda não
//      aplicada — ver a entrega da Etapa 1) que compara `realtime.topic()`
//      contra as claims `org`/`unidade` do mesmo JWT.
// Nunca deixe as duas divergirem: um tópico que esta função não gera aqui não
// deveria ser aceito pela policy, e vice-versa.

/** Canal da empresa inteira — "Todas as unidades" assina só este. */
export const topicoEmpresa = (organizacaoId) => `empresa:${organizacaoId}`;

/** Canal de uma unidade específica. */
export const topicoUnidade = (unidadeId) => `unidade:${unidadeId}`;

/**
 * Tópicos que um contexto (organizacaoId + unidadeId) tem autorização para
 * assinar. Com unidade selecionada: os dois — o de unidade (dado da própria
 * unidade) e o de empresa (agregados que dependem dela, Fase O). Em "Todas as
 * unidades" (unidadeId nulo): só o de empresa — ver unidade não é o mesmo que
 * ver a empresa inteira, mesmo que hoje as duas leituras sejam permitidas ao
 * mesmo perfil; o agregado NÃO dá acesso a canais de unidades específicas às
 * quais o contexto não esteja diretamente vinculado.
 * @param {{organizacaoId: string, unidadeId?: string|null}} ctx
 * @returns {string[]}
 */
export function topicosAutorizados({ organizacaoId, unidadeId = null }) {
  if (!organizacaoId) return [];
  const topicos = [topicoEmpresa(organizacaoId)];
  if (unidadeId) topicos.push(topicoUnidade(unidadeId));
  return topicos;
}
