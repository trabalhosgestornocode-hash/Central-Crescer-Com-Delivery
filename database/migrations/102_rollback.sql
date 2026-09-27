-- ROLLBACK da migration 102. NÃO aplicar sem autorização.
-- Aborta se houver detalhes/ações gravados (evita perder dado sem querer).
do $$ begin
  if exists (select 1 from ifood_pedidos where details_payload is not null or action_state <> 'none')
     or exists (select 1 from ifood_pedido_acoes) then
    raise exception 'Rollback 102 abortado: existem detalhes de pedido ou ações gravadas. Exporte antes e remova manualmente.';
  end if;
end $$;

drop table if exists ifood_pedido_acoes;
drop index if exists idx_ifood_pedidos_details_pendentes;
drop index if exists idx_ifood_pedidos_action;
alter table ifood_pedidos drop constraint if exists ck_ifood_pedidos_details_status;
alter table ifood_pedidos drop constraint if exists ck_ifood_pedidos_action_state;
alter table ifood_pedidos
  drop column if exists display_id, drop column if exists order_type, drop column if exists order_timing,
  drop column if exists category, drop column if exists sales_channel, drop column if exists is_test,
  drop column if exists delivery_by, drop column if exists order_created_at, drop column if exists preparation_start_at,
  drop column if exists scheduled_start_at, drop column if exists scheduled_end_at, drop column if exists pickup_code,
  drop column if exists delivery_observations, drop column if exists takeout_observations, drop column if exists extra_info,
  drop column if exists total_sub_total, drop column if exists total_delivery_fee, drop column if exists total_additional_fees,
  drop column if exists total_benefits, drop column if exists total_order_amount, drop column if exists payment_methods,
  drop column if exists card_brands, drop column if exists cash_change_for, drop column if exists payment_prepaid,
  drop column if exists payment_pending, drop column if exists has_offline_payment, drop column if exists discount_sponsors,
  drop column if exists customer_document_number, drop column if exists customer_document_type, drop column if exists items_count,
  drop column if exists items, drop column if exists benefits, drop column if exists payments, drop column if exists customer,
  drop column if exists delivery, drop column if exists takeout, drop column if exists dine_in, drop column if exists indoor,
  drop column if exists schedule, drop column if exists additional_fees, drop column if exists additional_info,
  drop column if exists details_payload, drop column if exists details_payload_hash, drop column if exists details_avisos,
  drop column if exists details_status, drop column if exists details_tentativas, drop column if exists details_ultima_tentativa_em,
  drop column if exists details_ultimo_erro, drop column if exists details_fetched_at, drop column if exists details_atualizado_em,
  drop column if exists action_state, drop column if exists confirm_attempts, drop column if exists confirm_last_error,
  drop column if exists confirm_http_status, drop column if exists placed_event_created_at, drop column if exists placed_event_received_at,
  drop column if exists confirm_requested_at, drop column if exists confirmed_event_at, drop column if exists confirmed_event_received_at;
