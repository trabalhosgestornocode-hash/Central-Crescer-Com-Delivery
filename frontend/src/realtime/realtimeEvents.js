// Taxonomia de eventos de domínio do Realtime + nomes de canal (tópicos).
//
// ESCOPO DA ETAPA 1: só a infraestrutura. As constantes de evento do
// Dashboard iFood já estão aqui (aprovadas na auditoria, Fase E) porque são
// dado estático inofensivo, mas NENHUM módulo ainda se inscreve nelas — isso
// é a Etapa 2, por decisão explícita do escopo aprovado ("não habilite ainda
// todos os eventos do Dashboard").
//
// Nunca eventos genéricos ("data_changed"/"update") — cada um tem significado
// de domínio, e o payload é sempre mínimo (ids/data/versão — nunca valor
// monetário, nome de cliente/usuário ou a linha inteira do banco).

/** Piloto — Dashboard iFood (Etapa 2, ainda não wired). */
export const EVENTOS_DASHBOARD_IFOOD = Object.freeze({
  LANCAMENTO_CRIADO: "dashboard_ifood.lancamento_criado",
  LANCAMENTO_ATUALIZADO: "dashboard_ifood.lancamento_atualizado",
  LANCAMENTO_EXCLUIDO: "dashboard_ifood.lancamento_excluido",
  LANCAMENTO_MENSAL_ATUALIZADO: "dashboard_ifood.lancamento_mensal_atualizado",
  MODELO_LOGISTICO_ATUALIZADO: "dashboard_ifood.modelo_logistico_atualizado",
});

/**
 * Sinal interno (não vem do servidor) que o RealtimeManager injeta no bus
 * quando um canal RECONECTA depois de já ter estado subscrito (Fase S/T da
 * auditoria: nunca confiar que os eventos perdidos durante a queda foram
 * recebidos). Um módulo interessado em qualquer evento de um tópico deve
 * tratar isto como "seus dados podem estar desatualizados, refaça o fetch" —
 * o mesmo refetch que faria para o evento de domínio real.
 */
export const RESINCRONIZACAO = "_realtime.resincronizado";

// ---------------------------------------------------------------------------
// Tópicos — espelha EXATAMENTE backend/src/modules/realtime/realtime.topicos.js.
// Nunca deixe os dois divergirem (é o mesmo contrato que a policy de
// `realtime.messages` no Supabase vai checar contra as claims do JWT).
// ---------------------------------------------------------------------------

export const topicoEmpresa = (organizacaoId) => `empresa:${organizacaoId}`;
export const topicoUnidade = (unidadeId) => `unidade:${unidadeId}`;
