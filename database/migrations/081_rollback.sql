-- =====================================================================
-- ROLLBACK da MIGRATION 081 — remove as colunas de distância e prazo de entrega
-- =====================================================================
-- COMO USAR: Supabase -> SQL Editor -> cole ESTE ARQUIVO INTEIRO e execute.
-- =====================================================================

alter table parser_fd_pedidos drop column if exists distancia_raio_km;
alter table parser_fd_pedidos drop column if exists distancia_rota_km;
alter table parser_fd_pedidos drop column if exists prazo_entrega;
