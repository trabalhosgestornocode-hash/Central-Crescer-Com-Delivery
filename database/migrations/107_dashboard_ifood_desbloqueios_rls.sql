-- =====================================================================
-- MIGRATION 107 — Corretiva da 068: RLS e grants de dashboard_ifood_desbloqueios
-- =====================================================================
-- PROBLEMA
--   A 068 cria `dashboard_ifood_desbloqueios` sem habilitar RLS e sem revogar
--   privilégios. Os default privileges do Supabase dão GRANT ALL (inclusive
--   TRUNCATE, que não passa por RLS) a anon/authenticated em toda tabela nova
--   de `public`. Em produção o RLS foi ligado fora da 068, mas os grants de
--   anon/authenticated continuam lá.
--
-- CORREÇÃO (não reescreve a 068, que já está aplicada)
--   * RLS habilitado SEM policy => deny-all para anon/authenticated;
--   * nenhum privilégio para anon/authenticated. O acesso é só do backend
--     (service_role), que já é quem lê e grava esta tabela.
--   Mesma convenção das migrations 104/105/106.
--
-- IDEMPOTENTE: reexecutar não muda nada. Não altera dados nem outras tabelas.
-- PRÉ-REQUISITO: migration 068 aplicada.
-- ROLLBACK: não há — voltar a expor a tabela a anon/authenticated não é um
--           estado desejado.
-- =====================================================================

alter table dashboard_ifood_desbloqueios enable row level security;

revoke all on dashboard_ifood_desbloqueios from anon, authenticated;
