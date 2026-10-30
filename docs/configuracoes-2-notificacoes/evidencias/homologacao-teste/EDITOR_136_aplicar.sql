-- PROJETO DE TESTE APENAS (wiqqsxnysbzhcrzrrean). Migration 136 sobre 132–135 já homologadas. Uma transação.
-- 136 — Fuso e horário da unidade: escrita SÓ pelo backend (service_role) ou por migration.
--
-- Achado da homologação no Supabase de teste (30/10/2026): a política existente `rls_unidades_tenant` (ALL, authenticated, própria
-- empresa) deixa qualquer membro logado atualizar `unidades` direto pelo PostgREST, sem passar pelas permissões do backend. Isso já
-- valia para as colunas antigas (pré-existente, fora desta frente), mas `timezone`/`horario_funcionamento` (132) passam a decidir a
-- competência do fechamento depois da data de corte (D-15) — então estas duas colunas ficam protegidas aqui: `anon` e `authenticated`
-- não as gravam (nem no INSERT), o backend (service_role, com `configuracoes.gerenciar`) e as migrations continuam gravando.
-- A validação de formato da 132 continua igual. Rollback: 136_rollback.sql (volta exatamente à função da 132).

begin;
set local lock_timeout = '5s';

create or replace function unidades_validar_fuso_horario() returns trigger
language plpgsql set search_path = public as $$
declare
  dia text; faixa jsonb; dias constant text[] := array['seg','ter','qua','qui','sex','sab','dom'];
begin
  -- 136: escrita direta pelo PostgREST com a sessão do usuário é recusada (só o backend decide quem pode mudar o fuso)
  if current_user in ('anon', 'authenticated')
     and ((tg_op = 'INSERT' and (new.timezone is not null or new.horario_funcionamento is not null))
          or (tg_op = 'UPDATE' and (new.timezone is distinct from old.timezone or new.horario_funcionamento is distinct from old.horario_funcionamento))) then
    raise exception 'unidades: fuso e horário só mudam pelo backend' using errcode = '42501';
  end if;
  if new.timezone is not null and not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'unidades: fuso inválido (%)', new.timezone using errcode = '22023';
  end if;
  if new.horario_funcionamento is not null then
    if jsonb_typeof(new.horario_funcionamento) <> 'object' then
      raise exception 'unidades: horario_funcionamento deve ser um objeto' using errcode = '22023';
    end if;
    for dia in select jsonb_object_keys(new.horario_funcionamento) loop
      if not (dia = any (dias)) then raise exception 'unidades: dia inválido (%)', dia using errcode = '22023'; end if;
      if jsonb_typeof(new.horario_funcionamento -> dia) <> 'array' or jsonb_array_length(new.horario_funcionamento -> dia) > 3 then
        raise exception 'unidades: o dia % deve ter de 0 a 3 faixas', dia using errcode = '22023';
      end if;
      for faixa in select value from jsonb_array_elements(new.horario_funcionamento -> dia) loop
        if coalesce(faixa->>'inicio', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(faixa->>'fim', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
           or faixa->>'inicio' = faixa->>'fim' then
          raise exception 'unidades: faixa inválida em % (use HH:MM, início diferente do fim)', dia using errcode = '22023';
        end if;
      end loop;
    end loop;
  end if;
  return new;
end $$;
revoke all on function unidades_validar_fuso_horario() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function unidades_validar_fuso_horario() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function unidades_validar_fuso_horario() from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then revoke all on function unidades_validar_fuso_horario() from service_role; end if;
end $$;

commit;
