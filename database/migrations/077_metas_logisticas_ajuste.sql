-- Ajuste das METAS LOGÍSTICAS globais em `metas_indicadores` para alinhar
-- ao que o negócio confirmou para os Indicadores de Rentabilidade do
-- Dashboard iFood. NÃO cria/remove coluna, NÃO toca em overrides por
-- organização/unidade (só as linhas globais: organizacao_id IS NULL AND
-- unidade_id IS NULL), NÃO tem relação com "proteção da precificação"
-- (conceito de tabela Balcão × iFood, calculado só no Simulador).
--
-- ANTES → DEPOIS (fração; ex.: 0.3500 = 35%):
--   marketplace  · total_deducoes     · limite     0.3200 → 0.3500
--   full_service · servicos_promocoes · meta_ideal 0.1000 → 0.0950
--   full_service · total_deducoes     · meta_ideal 0.3050 → 0.3000
--   full_service · total_deducoes     · limite     0.3200 → 0.3500
--
-- Já corretos no banco (não mexer): marketplace taxas_comissoes 13/13,
-- servicos_promocoes 5/7, taxas_entregadores 12/15, total_deducoes meta 30;
-- full_service taxas_comissoes 20,5/20,5, servicos_promocoes limite 14,5.
--
-- ROLLBACK: database/migrations/077_rollback.sql (restaura os 4 valores).
-- IDEMPOTENTE: reexecutável (UPDATE por chave lógica; sem efeito na 2ª vez).
-- APLICADA em produção (projeto Crescer Com Delivery) sob autorização explícita.
begin;

update public.metas_indicadores set limite = 0.3500
 where organizacao_id is null and unidade_id is null
   and modelo_logistico = 'marketplace' and indicador = 'total_deducoes';

update public.metas_indicadores set meta_ideal = 0.0950
 where organizacao_id is null and unidade_id is null
   and modelo_logistico = 'full_service' and indicador = 'servicos_promocoes';

update public.metas_indicadores set meta_ideal = 0.3000, limite = 0.3500
 where organizacao_id is null and unidade_id is null
   and modelo_logistico = 'full_service' and indicador = 'total_deducoes';

commit;

-- VERIFICAÇÃO (rode separadamente):
--   select modelo_logistico, indicador, meta_ideal, limite
--     from metas_indicadores where organizacao_id is null and unidade_id is null
--     order by modelo_logistico, indicador;
--   Esperado: marketplace total_deducoes 0.3000/0.3500;
--             full_service servicos_promocoes 0.0950/0.1450;
--             full_service total_deducoes 0.3000/0.3500.
