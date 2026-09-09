-- ROLLBACK da migration 078 (performance_mensal_complemento).
-- Remove apenas o que a 078 criou: a tabela de complementos, o trigger/função
-- de versionamento e o índice único de apoio à FK composta em `unidades`.
-- Nenhum dado oficial é tocado (a 078 não copia lançamentos). Reexecutável.
-- LOCAL: não aplicar em produção sem autorização específica.
BEGIN;

DROP TRIGGER IF EXISTS performance_complemento_versionar ON public.performance_mensal_complemento;
DROP TABLE IF EXISTS public.performance_mensal_complemento;
DROP FUNCTION IF EXISTS public.performance_complemento_versionar();
-- O índice só existe para a FK composta desta feature; sem a tabela ele é órfão.
DROP INDEX IF EXISTS public.unidades_id_organizacao_performance_uidx;

COMMIT;
