-- =====================================================================
-- ROLLBACK — MIGRATION 080 (Realtime: grants efêmeros de canal)
-- =====================================================================
-- Reversível a qualquer momento, sem perda de dado em nenhuma outra
-- tabela: `realtime_channel_grants` é nova e isolada, e remover a policy
-- e a função só devolvem `realtime.messages` ao estado anterior (nenhum
-- canal privado autorizado — que é onde já estava antes desta migration).
-- NUNCA desabilita RLS em `realtime.messages` (não foi esta migration que
-- habilitou — o Supabase já mantém habilitada por padrão).
-- Testado ponta a ponta no projeto de teste descartável: tabela e função
-- somem, policy some, `to_regclass`/`pg_policies` confirmam limpeza total.
-- =====================================================================
begin;

drop policy if exists "crescer_realtime_receber_broadcast_via_grant" on realtime.messages;
drop function if exists public.tem_grant_realtime(text);
drop table if exists public.realtime_channel_grants;

commit;
