-- Rollback da 131 — volta exatamente o comportamento da 127 (e, com ele, o defeito: transferir/promover unidade falha com
-- "permission denied for table checklist_metas"). Nenhum dado é tocado. Idempotente.

begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regclass('public.checklist_metas') is null then
    raise notice '131_rollback: 127 ausente — nada a desfazer';
    return;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke update (organizacao_id) on table checklist_metas from service_role;
    revoke update (organizacao_id) on table checklist_metas_historico from service_role;
  end if;
end $$;

create or replace function checklist_metas_validar_tenant() returns trigger
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from unidades u where u.id = new.unidade_id and u.organizacao_id = new.organizacao_id) then
    raise exception 'checklist_metas: a unidade % não pertence à organização %', new.unidade_id, new.organizacao_id
      using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id) then
    raise exception 'checklist_metas: organização e unidade não mudam' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function checklist_metas_historico_imutavel() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception 'checklist_metas_historico é somente inclusão (%).', tg_op using errcode = '42501';
end $$;

commit;
