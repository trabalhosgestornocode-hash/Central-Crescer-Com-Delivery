-- Rollback da 143: devolve as categorias dos relatórios ao estado da 133. A linha da v2 em `comunicacao_termos` é IMUTÁVEL (trigger) e permanece como rascunho,
-- inofensiva (consentimento real exige termo vigente não-rascunho). Se for preciso "voltar" ao texto da v1, o caminho é inserir uma v3 — nunca apagar.
begin;
set local lock_timeout = '5s';
update comunicacao_categorias set rotulo = 'Fechamento operacional diário', descricao = 'Resumo do dia operacional consolidado (Dashboard Operacional 2.0). Em simulação.', estado = 'SIMULACAO', transporte = 'noop'
 where codigo = 'fechamento_operacional_diario' and ativo = false;
update comunicacao_categorias set rotulo = 'Resumo semanal', descricao = 'Resumo da semana operacional.', estado = 'EM_BREVE', transporte = 'noop'
 where codigo = 'resumo_semanal' and ativo = false;
commit;
