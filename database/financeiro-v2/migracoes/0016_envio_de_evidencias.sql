-- =====================================================================================================================
-- Financeiro v2 — migração 0016: ENVIO DE EVIDÊNCIAS PELA INTERFACE (Execução 08D)
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- Ação nova `financeiro_v2.enviar_documento`: grava a FICHA do documento enviado e o VÍNCULO com o registro da
-- pendência. Não abre arquivo (`documentos`) e não decide nada financeiro (reclassificar, conciliar, homologar).
-- MIGRAÇÃO RESTRITIVA: nenhuma concessão existente a recebe.
-- =====================================================================================================================

-- 1) Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento"]'::jsonb);

-- 2) USING de alteração (alcançar linhas referenciadas, ex.: SELECT ... FOR UPDATE do registro da pendência).
do $$
declare
  t record;
  escritas text := (select string_agg(format('%L', 'financeiro_v2.' || a), ', ') from unnest(array['registrar', 'corrigir', 'cancelar', 'conciliar',
    'fechar', 'homologar', 'revisar', 'configurar', 'importar', 'conceder', 'documentos', 'aprovar', 'aplicar', 'revogar', 'confirmar_importacao', 'reabrir',
    'reclassificar', 'enviar_documento']) a);
begin
  for t in select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
            where ns.nspname = current_schema() and c.relkind = 'r' and c.relrowsecurity and c.relname like 'fv2\_%'
              and c.relname not in ('fv2_concessao', 'fv2_escopo', 'fv2_historico') loop
    execute format('alter policy %I on %I using ((select fv2_tem_acao(array[%s])))', t.relname || '_alterar', t.relname, escritas);
  end loop;
end $$;

-- 3) Ficha do documento e vínculo: a ação nova só INCLUI (não altera documento existente nem vínculo).
alter policy fv2_documento_incluir on fv2_documento with check (
  (select fv2_tem_acao(array['financeiro_v2.importar', 'financeiro_v2.registrar', 'financeiro_v2.enviar_documento'])));
alter policy fv2_vinculo_documental_incluir on fv2_vinculo_documental with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.importar', 'financeiro_v2.reclassificar', 'financeiro_v2.enviar_documento'])));
alter policy fv2_historico_incluir on fv2_historico with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar',
    'financeiro_v2.fechar', 'financeiro_v2.homologar', 'financeiro_v2.revisar', 'financeiro_v2.configurar', 'financeiro_v2.importar',
    'financeiro_v2.conceder', 'financeiro_v2.documentos', 'financeiro_v2.aprovar', 'financeiro_v2.aplicar', 'financeiro_v2.revogar',
    'financeiro_v2.confirmar_importacao', 'financeiro_v2.reabrir', 'financeiro_v2.reclassificar', 'financeiro_v2.enviar_documento']))
  or ((select fv2_em_provisionamento()) and registro_tipo = 'CONCESSAO'));
