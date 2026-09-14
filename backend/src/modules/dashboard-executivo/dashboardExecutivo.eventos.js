// Taxonomia de eventos de domínio do Dashboard iFood — Etapa 2 (piloto).
// Espelha frontend/src/realtime/realtimeEvents.js#EVENTOS_DASHBOARD_IFOOD;
// nunca deixe as duas listas divergirem. Fica aqui (dentro do módulo do
// domínio), não em backend/src/modules/realtime/* — a infraestrutura de
// Realtime é genérica e não conhece "lançamento"/"modelo logístico"; só o
// domínio sabe que eventos fazem sentido pra ele.
export const EVENTOS_DASHBOARD_IFOOD = Object.freeze({
  LANCAMENTO_CRIADO: "dashboard_ifood.lancamento_criado",
  LANCAMENTO_ATUALIZADO: "dashboard_ifood.lancamento_atualizado",
  LANCAMENTO_EXCLUIDO: "dashboard_ifood.lancamento_excluido",
  // Cobre criar/editar/excluir o LOTE de distribuição mensal — a auditoria
  // confirmou que a taxonomia aprovada tem só este evento pra faturamento
  // mensal (nunca "criado"/"excluido" separados): uma operação de lote pode
  // tocar dezenas de dias de uma vez, e um único refetch (carregarConteudo)
  // já traz o resultado final — não há por que emitir um evento por linha
  // nem inventar variantes que a Etapa 1 não aprovou.
  LANCAMENTO_MENSAL_ATUALIZADO: "dashboard_ifood.lancamento_mensal_atualizado",
  MODELO_LOGISTICO_ATUALIZADO: "dashboard_ifood.modelo_logistico_atualizado",
});

/** "YYYY-MM" a partir de um ano/mês numéricos — formato de `competencia` no payload dos eventos. */
export const competenciaDe = (ano, mes) => `${ano}-${String(mes).padStart(2, "0")}`;
