-- PROJETO DE TESTE APENAS (wiqqsxnysbzhcrzrrean). Reverte só a 136 (volta à função da 132). Uma transação.
-- Rollback da 136: volta a função de validação EXATAMENTE à versão da 132 (sem a guarda de escrita direta).
begin;
create or replace function unidades_validar_fuso_horario() returns trigger
language plpgsql set search_path = public as $$
declare
  dia text; faixa jsonb; dias constant text[] := array['seg','ter','qua','qui','sex','sab','dom'];
begin
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
commit;
