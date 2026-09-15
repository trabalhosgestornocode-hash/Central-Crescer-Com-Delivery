-- =====================================================================
-- MIGRATION 081 — Parser Food Delivery: distância em raio/rota + prazo de entrega
-- =====================================================================
-- OBJETIVO
--   Persistir campos do relatório de pedidos lidos pelo parser
--   (parserFoodDelivery.parser.js) mas nunca gravados até aqui:
--     - distancia_raio_km  — ÚNICA fonte real hoje (auditoria confirmou:
--       "Distância em rota (km)" existe no relatório mas vem sempre vazia
--       nas importações atuais). Alimenta o Dashboard Operacional como
--       "Distância estimada" — NUNCA como "km rodados"/"percurso real":
--       é uma estimativa em raio, não o trajeto percorrido.
--     - distancia_rota_km  — guardada só para compatibilidade futura. Não
--       alimenta nenhum indicador hoje; se o relatório passar a preenchê-la,
--       a troca de fonte é uma mudança separada e validada.
--     - prazo_entrega      — coluna real "Prazo de entrega" (datetime
--       absoluto). Alimenta a Etapa 7 (Entregas no prazo): comparado contra
--       `data_entregue` (NUNCA `data_finalizado` — este pode acontecer
--       depois da entrega e geraria falso atraso).
--
--   Migration ainda não aplicada em produção no momento em que este arquivo
--   ganhou `prazo_entrega` (verificado via information_schema.columns) —
--   por isso o campo novo entrou aqui em vez de uma 082 separada, seguindo
--   a convenção do projeto de agrupar colunas pendentes da mesma tabela/
--   funcionalidade numa migration só enquanto ela não foi fechada.
--
-- PRÉ-REQUISITO: migration 037 aplicada.
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

alter table parser_fd_pedidos add column if not exists distancia_raio_km numeric(10,2);
alter table parser_fd_pedidos add column if not exists distancia_rota_km numeric(10,2);
alter table parser_fd_pedidos add column if not exists prazo_entrega timestamptz;
