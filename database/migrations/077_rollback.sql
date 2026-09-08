-- ROLLBACK da migration 077 (ajuste das metas logísticas globais).
-- Restaura os 4 valores originais em `metas_indicadores` (linhas globais).
-- Não toca em overrides por organização/unidade. Reexecutável.
begin;

update public.metas_indicadores set limite = 0.3200
 where organizacao_id is null and unidade_id is null
   and modelo_logistico = 'marketplace' and indicador = 'total_deducoes';

update public.metas_indicadores set meta_ideal = 0.1000
 where organizacao_id is null and unidade_id is null
   and modelo_logistico = 'full_service' and indicador = 'servicos_promocoes';

update public.metas_indicadores set meta_ideal = 0.3050, limite = 0.3200
 where organizacao_id is null and unidade_id is null
   and modelo_logistico = 'full_service' and indicador = 'total_deducoes';

commit;
