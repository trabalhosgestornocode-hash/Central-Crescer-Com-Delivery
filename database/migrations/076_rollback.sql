-- ROLLBACK da migration 076 (integridade da importação DIÁRIA).
-- Remove os 3 gatilhos + funções e as 3 colunas de período. Não toca em dado
-- de lançamento/importação, fechamento, competência ou snapshot.
-- Reexecutável (tudo IF EXISTS). NÃO aplicar em produção nesta etapa.
begin;

drop trigger if exists trg_bonificacao_auditar_importacao_diaria on public.bonificacao_lancamentos_diarios;
drop trigger if exists trg_bonificacao_vinculos_diarios          on public.bonificacao_lancamentos_diarios;
drop trigger if exists trg_bonificacao_documento_diario          on public.bonificacao_importacoes;

drop function if exists public.bonificacao_auditar_importacao_diaria();
drop function if exists public.bonificacao_validar_vinculos_diarios();
drop function if exists public.bonificacao_validar_documento_diario();

alter table public.bonificacao_importacoes
  drop column if exists periodo_inicio,
  drop column if exists periodo_fim,
  drop column if exists periodo_fonte;

commit;

-- VERIFICAÇÃO (rode separadamente):
--   select count(*) from pg_trigger where tgname in
--     ('trg_bonificacao_documento_diario','trg_bonificacao_vinculos_diarios','trg_bonificacao_auditar_importacao_diaria'); -- 0
--   select count(*) from information_schema.columns
--     where table_name='bonificacao_importacoes' and column_name like 'periodo_%'; -- 0
