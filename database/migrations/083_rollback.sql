-- =====================================================================
-- ROLLBACK — MIGRATION 083 (whatsapp_conexoes)
-- =====================================================================
-- ⚠️  NÃO EXECUTAR: a migration 083 nunca foi aplicada em nenhum banco
--     (Checkpoint C1 criou o arquivo só localmente). Este rollback existe
--     por simetria com o padrão do projeto (toda migration nova já nasce
--     com o rollback ao lado — ver 082_rollback.sql), não porque haja algo
--     para desfazer agora.
-- =====================================================================

begin;

drop trigger if exists trg_whatsapp_conexoes_upd on whatsapp_conexoes;
drop table if exists whatsapp_conexoes;

commit;
