-- ROLLBACK da migration 091. Remove tudo o que a 091 acrescentou e restaura
-- comunicacao_mensagens_sincroniza_alerta() EXATAMENTE como a 088 a definiu
-- (o trigger em si nunca foi recriado por nenhuma das duas migrations —
-- CREATE OR REPLACE de função com mesma assinatura não precisa disso).
-- comunicacao_agendar_mensagem_alerta (função NORMAL) nunca foi tocada por
-- nenhuma das duas — nada a restaurar ali. Nenhuma mensagem/alerta é
-- apagado ou alterado por este rollback; histórico preservado integralmente.
-- Reverta o deploy do backend ANTES (se algo já estiver chamando a nova RPC).
begin;

drop function if exists comunicacao_agendar_mensagem_critica(uuid, text, text, text, timestamptz, timestamptz, integer);
drop function if exists comunicacao_atualizar_status_alerta_por_mensagem(uuid, text);

-- Restaura o corpo EXATO da 088 (sem o gate de prioridade) — mesma assinatura,
-- mesmo trigger trg_comunicacao_mensagens_sincroniza_alerta (definido em 088,
-- nunca dropado por este rollback).
create or replace function comunicacao_mensagens_sincroniza_alerta()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'CANCELLED' then
    update comunicacao_alertas set status = 'DETECTED', updated_at = now()
     where id = new.alerta_id and status in ('SCHEDULED', 'PROCESSING');
  else
    update comunicacao_alertas set status = new.status, updated_at = now()
     where id = new.alerta_id and status not in ('RESOLVED', 'CANCELLED') and status <> new.status;
  end if;
  return null;
end;
$$;

drop function if exists comunicacao_estagio_prioridade(text);

notify pgrst, 'reload schema';
commit;
