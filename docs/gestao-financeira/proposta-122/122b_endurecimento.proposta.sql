-- =====================================================================
-- 122b — PROPOSTA DE ENDURECIMENTO DA 122 (integrador, checkpoint A8). NÃO É MIGRATION: fica fora de database/migrations.
-- =====================================================================
-- Dono da decisão: Agente 2 (a 122 é dele). Aditiva: não altera nenhuma função/trigger da 122; pode ser incorporada à 122 ou virar a 123.
-- Achados que ela fecha (sondados em PostgreSQL descartável com default privileges do Supabase simulados):
--   F-A  service_role reabre período fechado por UPDATE direto (fechado -> reaberto) e tem EXECUTE em fin_reabrir_periodo, embora a
--        política seja "reabertura DESABILITADA" (hoje só o serviço do backend falha fechado).
--   F-B  fin_lancamentos.importacao_id referencia fin_importacoes SÓ por id: aceita importação de OUTRO tenant (não alcançável pela API
--        hoje; defesa em profundidade).
-- Limite honesto: a trava de reabertura usa uma flag local de transação (como fin.cancelando_par). Defende contra o backend/API; NÃO
-- defende contra quem já tem SQL bruto como service_role (esse papel poderia setar a flag). SQL bruto como service_role nunca é exposto
-- por PostgREST; proteger a service key continua sendo requisito.
-- Como HABILITAR a reabertura no futuro (após aprovação da política): fin_reabrir_periodo passa a executar
--   perform set_config('fin.reabertura_autorizada', v.id::text, true);  antes do UPDATE, e o EXECUTE volta ao service_role.
begin;
set local lock_timeout = '5s';

-- ---------- F-A: reabertura continua desabilitada NO BANCO ----------
create or replace function fin_periodos_bloqueia_reabertura() returns trigger language plpgsql as $$
begin
  if old.status = 'fechado' and new.status is distinct from 'fechado'
     and coalesce(current_setting('fin.reabertura_autorizada', true), '') <> old.id::text then
    raise exception 'fin_reabertura_desabilitada: a reabertura de periodo ainda nao foi habilitada' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists trg_fin_periodos_bloqueia_reabertura on fin_periodos;
create trigger trg_fin_periodos_bloqueia_reabertura before update on fin_periodos for each row execute function fin_periodos_bloqueia_reabertura();

revoke all on function fin_periodos_bloqueia_reabertura() from public;
revoke all on function fin_reabrir_periodo(uuid,uuid,uuid,date,int,text) from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function fin_periodos_bloqueia_reabertura() from %I', r);
      execute format('revoke all on function fin_reabrir_periodo(uuid,uuid,uuid,date,int,text) from %I', r);
    end if;
  end loop;
end $$;

-- ---------- F-B: importação do MESMO tenant ----------
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fin_importacoes_tenant_uk') then
    alter table fin_importacoes add constraint fin_importacoes_tenant_uk unique (organizacao_id, unidade_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fin_lancamentos_importacao_tenant_fk') then
    -- MATCH SIMPLE: lançamentos manuais (importacao_id nulo) não são afetados
    alter table fin_lancamentos add constraint fin_lancamentos_importacao_tenant_fk
      foreign key (organizacao_id, unidade_id, importacao_id) references fin_importacoes (organizacao_id, unidade_id, id) on delete restrict not valid;
    alter table fin_lancamentos validate constraint fin_lancamentos_importacao_tenant_fk;
  end if;
end $$;

-- PÓS-CONDIÇÃO
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') and has_function_privilege('service_role', 'fin_reabrir_periodo(uuid,uuid,uuid,date,int,text)', 'execute') then
    raise exception '122b abortada: service_role ainda executa fin_reabrir_periodo.';
  end if;
end $$;
commit;
