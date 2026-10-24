-- Rollback da 128 — remove o índice por período de ifood_pedidos. Sem transação (CONCURRENTLY). Idempotente.
-- Sem o índice, o Dashboard Operacional continua funcionando (mais lento em períodos longos).
drop index concurrently if exists idx_ifood_pedidos_tenant_criado;
