-- Rollback da 120 — remove a fundação do Dashboard Financeiro.
-- RECUSA se houver módulo habilitado em empresa/unidade ou concessão ativa (revogue/desabilite antes de desfazer).
-- A trilha de auditoria é descartada junto com a tabela: exporte-a antes se precisar preservá-la.
-- Idempotente.
begin;
set local lock_timeout = '5s';

do $$
declare ativas boolean;
begin
  if to_regclass('public.organizacao_modulos') is not null and exists (select 1 from public.organizacao_modulos where modulo_id = 'gestao_financeira') then
    raise exception 'Rollback 120 abortado: gestao_financeira está habilitado em ao menos uma empresa.';
  end if;
  if to_regclass('public.unidade_modulos') is not null and exists (select 1 from public.unidade_modulos where modulo_id = 'gestao_financeira') then
    raise exception 'Rollback 120 abortado: gestao_financeira está habilitado em ao menos uma unidade.';
  end if;
  if to_regclass('public.gestao_financeira_concessoes') is not null then
    -- SQL dinâmico: o plano do SQL estático falharia (tabela inexistente) num segundo rollback.
    execute 'select exists (select 1 from public.gestao_financeira_concessoes where revogada_em is null)' into ativas;
    if ativas then
      raise exception 'Rollback 120 abortado: existem concessões financeiras ativas. Revogue-as antes.';
    end if;
  end if;
end $$;

drop table if exists public.gestao_financeira_concessoes cascade;
drop table if exists public.gestao_financeira_concessoes_auditoria cascade;
drop function if exists public.gfc_validar();
drop function if exists public.gfc_auditar();
drop function if exists public.gfc_auditoria_imutavel();

delete from public.modulos where id = 'gestao_financeira';

do $$
declare c record;
begin
  for c in select con.conname from pg_constraint con
            where con.conrelid = 'public.modulos'::regclass and con.contype = 'c'
              and pg_get_constraintdef(con.oid) ilike '%categoria%'
  loop
    execute format('alter table public.modulos drop constraint %I', c.conname);
  end loop;
  alter table public.modulos add constraint modulos_categoria_check check (categoria in ('operacao', 'integracao'));
end $$;

commit;
