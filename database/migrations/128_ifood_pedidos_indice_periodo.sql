-- =====================================================================
-- 128 — iFood: índice por PERÍODO em ifood_pedidos (Dashboard Operacional do Checklist)
-- =====================================================================
-- O Dashboard Operacional lê os pedidos de UMA unidade num intervalo de datas (`criado_em` delimita a janela; o dia de
-- cada pedido é decidido no backend pelo carimbo oficial de recebimento). O índice existente é
-- (organizacao_id, unidade_id, status_oficial) e não serve a um filtro por intervalo. A consulta do resumo ao vivo
-- (`criado_em >= desde`) também passa a usar este índice.
--
-- CONCURRENTLY: o worker do iFood grava em ifood_pedidos o tempo todo; a criação concorrente não bloqueia as escritas.
-- Por isso este arquivo NÃO roda dentro de transação (rodar como está, comando por comando). Se a criação falhar no
-- meio, o índice fica INVALID: rode `drop index concurrently if exists idx_ifood_pedidos_tenant_criado;` e repita.
--
-- 100% aditiva, sem mudança de dado. Rollback: 128_rollback.sql.

create index concurrently if not exists idx_ifood_pedidos_tenant_criado
  on ifood_pedidos(organizacao_id, unidade_id, criado_em);
