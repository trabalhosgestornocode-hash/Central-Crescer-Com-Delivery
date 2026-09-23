-- Rollback da MIGRATION 092 (reforço de prazo final D-1).
-- Restaura o corpo EXATO do trigger da 088 e remove a RPC do reforço. Reforços já criados permanecem como
-- linhas normais em comunicacao_mensagens (sem a guarda, passariam a propagar status ao alerta).
begin;

create or replace function comunicacao_mensagens_sincroniza_alerta()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'CANCELLED' then
    -- a mensagem EXPIROU: a pendência de negócio continua; o alerta fica "ativo, sem mensagem viva"
    update comunicacao_alertas set status = 'DETECTED', updated_at = now()
     where id = new.alerta_id and status in ('SCHEDULED', 'PROCESSING');
  else
    update comunicacao_alertas set status = new.status, updated_at = now()
     where id = new.alerta_id and status not in ('RESOLVED', 'CANCELLED') and status <> new.status;
  end if;
  return null;
end;
$$;

drop function if exists comunicacao_agendar_reforco_alerta(uuid, text, text, timestamptz, timestamptz, integer);

notify pgrst, 'reload schema';
commit;
