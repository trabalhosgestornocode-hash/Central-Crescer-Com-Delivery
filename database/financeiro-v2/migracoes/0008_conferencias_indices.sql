-- =====================================================================================================================
-- Financeiro v2 — migração 0008: índices da Central de Conferências (Execução 06C)
--
-- Só é aplicada no PostgreSQL local isolado (scripts/fv2-banco-teste.mjs). Não pertence a database/migrations/.
-- As listas da Central são paginadas NO BANCO (LIMIT/OFFSET + COUNT separado); estes índices atendem os filtros usados:
--   * propostas por competência e estado, ordenadas pela data da operação;
--   * importações por sobreposição de período (início ≤ fim do mês e fim ≥ início do mês);
--   * correspondências por competência (gravada em `extras` desde a 06C) e situação;
--   * registros de fonte ativos por importação (contagem do documento).
-- Nenhuma tabela, coluna, regra ou permissão nova.
-- =====================================================================================================================

create index fv2_proposta_competencia on fv2_proposta (organizacao_id, unidade_id, competencia, estado, data_operacao);
create index fv2_importacao_periodo on fv2_importacao (organizacao_id, unidade_id, periodo_inicio, periodo_fim);
create index fv2_correspondencia_competencia on fv2_correspondencia (organizacao_id, unidade_id, (extras->>'competencia'), situacao);
create index fv2_registro_fonte_importacao_situacao on fv2_registro_fonte (organizacao_id, unidade_id, importacao_id, situacao);
