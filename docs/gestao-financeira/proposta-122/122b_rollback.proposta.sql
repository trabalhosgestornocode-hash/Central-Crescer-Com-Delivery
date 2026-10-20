-- Rollback da proposta 122b (devolve o comportamento da 122 original: reabertura possível no banco). Só com decisão registrada.
begin;
drop trigger if exists trg_fin_periodos_bloqueia_reabertura on fin_periodos;
drop function if exists fin_periodos_bloqueia_reabertura();
alter table fin_lancamentos drop constraint if exists fin_lancamentos_importacao_tenant_fk;
alter table fin_importacoes drop constraint if exists fin_importacoes_tenant_uk;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function fin_reabrir_periodo(uuid,uuid,uuid,date,int,text) to service_role; end if;
end $$;
commit;
