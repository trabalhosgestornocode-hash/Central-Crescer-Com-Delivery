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

-- §5b da 120: devolve remapear_organizacao_em_tabelas_de_unidade à definição EXATA da 054 (CREATE OR REPLACE preserva dono e privilégios)
-- ANTES de remover a guarda que a versão da 120 chama. Recusa (sem alterar nada) se quem executa não administra a função.
-- Só com 121/122 já desfeitas: com tabelas financeiras no banco, a versão da 054 volta a quebrar toda transferência/promoção.
do $$
declare v_dono oid;
begin
  if to_regclass('public.fin_auditoria') is not null or to_regclass('public.fin_lancamentos') is not null then
    raise exception 'Rollback 120 abortado: desfaça 122 e 121 antes (as tabelas financeiras ainda existem).';
  end if;
  select p.proowner into v_dono from pg_proc p
   where p.oid = to_regprocedure('public.remapear_organizacao_em_tabelas_de_unidade(uuid,uuid,uuid)');
  if v_dono is not null and not pg_has_role(current_user, v_dono, 'USAGE') then
    raise exception 'Rollback 120 abortado: a role % não administra remapear_organizacao_em_tabelas_de_unidade (dono: %).', current_user, pg_get_userbyid(v_dono);
  end if;
end $$;

create or replace function public.remapear_organizacao_em_tabelas_de_unidade(
  p_unidade_id uuid, p_org_antiga_id uuid, p_org_nova_id uuid
) returns jsonb
language plpgsql
as $$
declare
  v_tabela text;
  v_qtd int;
  v_resultado jsonb := '{}'::jsonb;
begin
  for v_tabela in
    select c1.table_name
    from information_schema.columns c1
    join information_schema.columns c2
      on c2.table_schema = c1.table_schema and c2.table_name = c1.table_name and c2.column_name = 'unidade_id'
    join information_schema.tables t
      on t.table_schema = c1.table_schema and t.table_name = c1.table_name and t.table_type = 'BASE TABLE'
    where c1.table_schema = 'public' and c1.column_name = 'organizacao_id'
      and c1.table_name not in ('martin_brower_vinculos', 'sessoes_contexto', 'insumo_historico')
    order by c1.table_name
  loop
    execute format(
      'update public.%I set organizacao_id = $1 where unidade_id = $2 and organizacao_id = $3',
      v_tabela
    ) using p_org_nova_id, p_unidade_id, p_org_antiga_id;
    get diagnostics v_qtd = row_count;
    if v_qtd > 0 then
      v_resultado := v_resultado || jsonb_build_object(v_tabela, v_qtd);
    end if;
  end loop;
  return v_resultado;
end;
$$;

drop function if exists public.gestao_financeira_verificar_unidade_transferivel(uuid);
drop function if exists public.gestao_financeira_tabelas_da_unidade();

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
