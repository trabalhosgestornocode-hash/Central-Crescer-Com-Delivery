-- =====================================================================
-- ROLLBACK da MIGRATION 079 — volta ao estado equivalente à 046/078
-- =====================================================================
-- Reverte, em ordem inversa e com IF EXISTS (reexecutável):
--   1. função transacional de hard delete
--   2. 3 tabelas novas (parser_fd_pedido_overrides, parser_fd_lancamentos,
--      parser_fd_entregadores) + policies + triggers
--   3. coluna parser_fd_pedidos.entregador_id
--   4. auditoria: colunas antes/depois + índices novos; `acao` CHECK volta
--      ao conjunto da 046; `importacao_id` volta a NOT NULL
--
-- ATENÇÃO — DADO HUMANO: parser_fd_lancamentos e parser_fd_pedido_overrides
-- guardam ajustes operacionais inseridos por usuários. Este rollback os
-- APAGA. O backfill de override para parser_fd_pedido_overrides na 079 não
-- removeu nada de parser_fd_pedidos (as colunas classificacao_override_*
-- continuam lá), então os overrides ANTERIORES à 079 permanecem; só os
-- criados DEPOIS da 079 pelo novo fluxo são perdidos. Exporte antes se
-- precisar preservar.
--
-- COMO USAR: Supabase -> SQL Editor -> cole ESTE ARQUIVO INTEIRO e execute.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Função transacional
-- ---------------------------------------------------------------------
drop function if exists parser_fd_lancamento_hard_delete(uuid, uuid, uuid, uuid, text, text);

-- ---------------------------------------------------------------------
-- 2. Tabelas novas (ordem inversa das FKs)
-- ---------------------------------------------------------------------
drop policy  if exists rls_parser_fd_pedido_overrides_tenant on parser_fd_pedido_overrides;
drop table   if exists parser_fd_pedido_overrides;

drop policy  if exists rls_parser_fd_lancamentos_tenant on parser_fd_lancamentos;
drop table   if exists parser_fd_lancamentos;

-- ---------------------------------------------------------------------
-- 3. parser_fd_pedidos.entregador_id (criada pela 079)
-- ---------------------------------------------------------------------
drop index if exists idx_pfdped_entregador_id;
alter table parser_fd_pedidos drop column if exists entregador_id;

drop policy  if exists rls_parser_fd_entregadores_tenant on parser_fd_entregadores;
drop table   if exists parser_fd_entregadores;

-- ---------------------------------------------------------------------
-- 4. Auditoria — desfaz extensões da 079
-- ---------------------------------------------------------------------
drop index if exists idx_pfdaud_lancamento;
drop index if exists idx_pfdaud_entregador;

alter table parser_fd_auditoria
  drop column if exists lancamento_id,
  drop column if exists entregador_id,
  drop column if exists valor_antes,
  drop column if exists valor_depois,
  drop column if exists dados_antes,
  drop column if exists dados_depois;

alter table parser_fd_auditoria drop constraint if exists parser_fd_auditoria_acao_check;
alter table parser_fd_auditoria add constraint parser_fd_auditoria_acao_check
  check (acao in ('importacao_criada', 'codigos_alterados', 'excluida', 'classificacao_alterada'));

-- `importacao_id` volta a NOT NULL. Só é possível se não houver linha com
-- importacao_id nulo (haveria se ações de lançamento tivessem sido
-- gravadas). O rollback do passo 2 já removeu a origem dessas linhas via
-- FK? Não — parser_fd_auditoria não tem FK para lançamento. Limpa aqui as
-- linhas órfãs de ações que deixaram de existir no conjunto do CHECK.
delete from parser_fd_auditoria where importacao_id is null;
alter table parser_fd_auditoria alter column importacao_id set not null;

commit;

-- =====================================================================
-- VERIFICAÇÃO pós-rollback (rode separadamente):
--   select to_regclass('parser_fd_entregadores');       -- NULL
--   select to_regclass('parser_fd_lancamentos');        -- NULL
--   select to_regclass('parser_fd_pedido_overrides');   -- NULL
--   \d parser_fd_pedidos   -> sem coluna entregador_id
--   \df parser_fd_lancamento_hard_delete   -> vazio
-- =====================================================================
