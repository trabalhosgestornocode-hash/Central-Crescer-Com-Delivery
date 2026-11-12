-- =====================================================================================================================
-- Financeiro v2 — migração 0007: referência do saldo informado (Execução 06B, auditoria A.1)
--
-- Só é aplicada no PostgreSQL local isolado (scripts/fv2-banco-teste.mjs). Não pertence a database/migrations/.
--   * fv2_saldo_conta.referencia — INICIO_DO_DIA ("saldo anterior": antes dos movimentos do dia) ou FIM_DO_DIA
--     ("saldo final": já inclui os movimentos do dia). Registros anteriores eram todos de início do dia.
--   * A unicidade passa a ser por conta + data + referência: um extrato pode informar o saldo final de um dia e outro o
--     saldo anterior do dia seguinte; os dois são conferidos entre si (nunca sobrescritos).
--   * A referência faz parte do saldo informado: também não é reescrita.
-- =====================================================================================================================

alter table fv2_saldo_conta add column referencia text not null default 'INICIO_DO_DIA'
  check (referencia in ('INICIO_DO_DIA', 'FIM_DO_DIA'));

do $$
declare
  nome text;
begin
  select con.conname into nome
    from pg_constraint con
   where con.conrelid = 'fv2_saldo_conta'::regclass and con.contype = 'u'
     and (select array_agg(att.attname::text order by att.attname) from pg_attribute att
           where att.attrelid = con.conrelid and att.attnum = any (con.conkey)) = array['conta_id', 'data', 'organizacao_id', 'unidade_id'];
  if nome is null then
    raise exception 'Financeiro v2: unicidade (conta, data) de fv2_saldo_conta não encontrada.';
  end if;
  execute format('alter table fv2_saldo_conta drop constraint %I', nome);
end $$;

alter table fv2_saldo_conta add constraint fv2_saldo_conta_conta_data_referencia_uq unique (organizacao_id, unidade_id, conta_id, data, referencia);

create or replace function fv2_tg_saldo_conta() returns trigger language plpgsql as $$
begin
  if (new.conta_id, new.data, new.referencia, new.valor_centavos) is distinct from (old.conta_id, old.data, old.referencia, old.valor_centavos) then
    raise exception 'Financeiro v2: saldo informado não é reescrito.' using errcode = 'FV014';
  end if;
  return new;
end $$;
