-- =====================================================================
-- 125 — iFood: remove o índice "uma conexão viva por unidade" (uq_ifood_conexao_unidade_viva)
-- =====================================================================
-- ETAPA SEPARADA E CONTROLADA. Só aplicar quando:
--   (a) a 124 estiver aplicada (a unicidade passa a ser por (unidade, finalidade));
--   (b) o código novo (seleção de conexão por finalidade) estiver no ar e homologado;
--   (c) a conexão existente da unidade que vai ganhar a 2ª conexão já tiver sido ROTULADA
--       (database/operacoes/ifood-conexao-rotular.sql).
-- Depois desta migration a unidade pode ter UMA conexão viva POR finalidade. O índice por merchant
-- (uq_ifood_conexao_merchant_vivo) e a unicidade (conexao, app) das credenciais continuam valendo.
-- Nenhuma linha é alterada. Idempotente. Rollback: 125_rollback.sql.

begin;
set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from pg_indexes where indexname = 'uq_ifood_conexao_unidade_finalidade_viva') then
    raise exception '125: a migration 124 (indice por unidade+finalidade) nao esta aplicada; nada foi alterado.';
  end if;
end $$;

drop index if exists uq_ifood_conexao_unidade_viva;

commit;
