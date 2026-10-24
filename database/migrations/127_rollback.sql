-- Rollback da 127 — remove as metas persistidas do Checklist Operacional (tabelas, histórico e função de escrita).
--
-- ATENÇÃO: o histórico de alterações de metas (quem, quando, antes/depois) é APAGADO junto. Exporte antes se precisar:
--   copy (select * from checklist_metas_historico order by unidade_id, versao) to stdout with csv header;
-- Sem as tabelas, o backend volta ao comportamento anterior: o /resumo informa `metas.origem = 'padrao'` (exemplo) e
-- o PUT de metas responde 503. Nenhum pedido, evento ou tabela do iFood é tocado. Idempotente.

begin;
set local lock_timeout = '5s';
drop function if exists public.checklist_metas_salvar(uuid, uuid, bigint, numeric, numeric, numeric, numeric, numeric, numeric, text, uuid, uuid, text, uuid);
drop table if exists public.checklist_metas_historico;
drop function if exists public.checklist_metas_json(public.checklist_metas);
drop table if exists public.checklist_metas;
drop function if exists public.checklist_metas_validar_tenant();
drop function if exists public.checklist_metas_historico_imutavel();
commit;
