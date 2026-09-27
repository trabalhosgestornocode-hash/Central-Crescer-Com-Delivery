-- ROLLBACK da migration 103. NÃO aplicar sem autorização.
-- Aborta se houver dados que dependem da 103 (não destrói nada silenciosamente).
do $$ begin
  if exists (select 1 from ifood_disputas)
     or exists (select 1 from ifood_pedido_acoes where acao <> 'confirm' or resultado in ('ACEITA','INCERTO'))
     or exists (select 1 from ifood_pedidos where action_state !~ '^(none|confirm_sending|confirm_requested|confirm_failed)$')
     or exists (select 1 from ifood_pedidos where ready_requested_at is not null or dispatch_requested_at is not null
                or cancel_requested_at is not null or cancel_reason_code is not null or action_uncertain) then
    raise exception 'Rollback 103 abortado: existem disputas, ações ready/dispatch/cancel ou estados da 103 gravados. Exporte antes e remova manualmente.';
  end if;
end $$;

drop table if exists ifood_disputas;
drop index if exists idx_ifood_pedido_acoes_acao;

alter table ifood_pedido_acoes drop constraint if exists ck_ifood_pedido_acoes_acao;
alter table ifood_pedido_acoes drop constraint if exists ck_ifood_pedido_acoes_resultado;
alter table ifood_pedido_acoes add constraint ifood_pedido_acoes_acao_check check (acao in ('confirm'));
alter table ifood_pedido_acoes add constraint ifood_pedido_acoes_resultado_check
  check (resultado in ('ENVIADA','ACEITA_202','RECUSADA','FALHOU','JA_SOLICITADA'));
alter table ifood_pedido_acoes
  drop column if exists conexao_id, drop column if exists tentativa, drop column if exists requested_at,
  drop column if exists responded_at, drop column if exists error_message, drop column if exists request_payload,
  drop column if exists response_payload, drop column if exists dispute_id;

alter table ifood_pedidos drop constraint if exists ck_ifood_pedidos_action_uncertain;
alter table ifood_pedidos drop constraint if exists ck_ifood_pedidos_action_state;
alter table ifood_pedidos add constraint ck_ifood_pedidos_action_state
  check (action_state in ('none','confirm_sending','confirm_requested','confirm_failed'));
alter table ifood_pedidos
  drop column if exists action_uncertain, drop column if exists action_attempts, drop column if exists action_last_error,
  drop column if exists action_http_status, drop column if exists action_requested_at,
  drop column if exists ready_requested_at, drop column if exists ready_event_at,
  drop column if exists dispatch_requested_at, drop column if exists dispatch_event_at,
  drop column if exists cancel_requested_at, drop column if exists cancel_event_at,
  drop column if exists cancel_reason_code, drop column if exists cancel_reason_description,
  drop column if exists cancel_failed_event_at;
