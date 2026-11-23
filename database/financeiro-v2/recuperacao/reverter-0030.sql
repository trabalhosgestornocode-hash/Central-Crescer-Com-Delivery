-- Financeiro v2 — RECUPERAÇÃO da migração 0030 (conta a pagar por documento). Só DEFINIÇÕES: nenhum dado é alterado.
-- Aplicar como `postgres` (não superusuário, com BYPASSRLS), numa ÚNICA transação, só com autorização específica.
-- Recusa se: 0030 não aplicada; houver migração posterior; ALGUMA concessão tiver `registrar_obrigacao` (revogue antes).
-- As expressões restauradas são as de PRODUÇÃO lidas em 23/11/2026 antes da 0030.
set local search_path = financeiro_v2, pg_catalog;
do $$ declare n int; begin
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception 'reverter-0030: não aplicar como superusuário'; end if;
  if not (select rolbypassrls from pg_roles where rolname = current_user) then raise exception 'reverter-0030: exige BYPASSRLS (senão as contagens enganam)'; end if;
  if not exists (select 1 from fv2_migracao where nome = '0030_registrar_obrigacao_documental.sql') then raise exception 'reverter-0030: 0030 não aplicada — nada foi feito'; end if;
  select count(*) into n from fv2_migracao where nome > '0030_registrar_obrigacao_documental.sql';
  if n > 0 then raise exception 'reverter-0030: há % migração(ões) posterior(es) — nada foi feito', n; end if;
  select count(*) into n from fv2_concessao where acoes ? 'financeiro_v2.registrar_obrigacao';
  if n > 0 then raise exception 'reverter-0030: % concessão(ões) com registrar_obrigacao — revogue antes', n; end if;
end $$;
grant fv2_guardiao to current_user;
drop trigger fv2_lancamento_documental on fv2_lancamento;
drop trigger fv2_obrigacao_documental on fv2_obrigacao;
drop function fv2_obrigacao_documental();
drop function fv2_so_registra_obrigacao();
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento",
  "financeiro_v2.baixar_por_comprovante"]'::jsonb);
alter policy fv2_lancamento_incluir on fv2_lancamento with check (( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.aplicar'::text, 'financeiro_v2.cancelar'::text, 'financeiro_v2.corrigir'::text, 'financeiro_v2.registrar'::text, 'financeiro_v2.revisar'::text]) AS fv2_tem_acao));
alter policy fv2_obrigacao_incluir on fv2_obrigacao with check (( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.aplicar'::text, 'financeiro_v2.registrar'::text]) AS fv2_tem_acao));
alter policy fv2_contraparte_incluir on fv2_contraparte with check (( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.aplicar'::text, 'financeiro_v2.registrar'::text]) AS fv2_tem_acao));
alter policy fv2_vinculo_documental_incluir on fv2_vinculo_documental with check ((( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.registrar'::text, 'financeiro_v2.importar'::text, 'financeiro_v2.reclassificar'::text, 'financeiro_v2.enviar_documento'::text, 'financeiro_v2.vincular_pagamento'::text]) AS fv2_tem_acao) OR ( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.baixar_por_comprovante'::text]) AS fv2_tem_acao)));
alter policy fv2_historico_incluir on fv2_historico with check ((( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.registrar'::text, 'financeiro_v2.corrigir'::text, 'financeiro_v2.cancelar'::text, 'financeiro_v2.conciliar'::text, 'financeiro_v2.fechar'::text, 'financeiro_v2.homologar'::text, 'financeiro_v2.revisar'::text, 'financeiro_v2.configurar'::text, 'financeiro_v2.importar'::text, 'financeiro_v2.conceder'::text, 'financeiro_v2.documentos'::text, 'financeiro_v2.aprovar'::text, 'financeiro_v2.aplicar'::text, 'financeiro_v2.revogar'::text, 'financeiro_v2.confirmar_importacao'::text, 'financeiro_v2.reabrir'::text, 'financeiro_v2.reclassificar'::text, 'financeiro_v2.enviar_documento'::text, 'financeiro_v2.vincular_pagamento'::text]) AS fv2_tem_acao) OR (( SELECT financeiro_v2.fv2_em_provisionamento() AS fv2_em_provisionamento) AND (registro_tipo = 'CONCESSAO'::text)) OR ((CURRENT_USER = 'fv2_guardiao'::name) AND (registro_tipo = 'CONCESSAO'::text)) OR ( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.baixar_por_comprovante'::text]) AS fv2_tem_acao)));
delete from fv2_migracao where nome = '0030_registrar_obrigacao_documental.sql';
revoke fv2_guardiao from current_user;
do $$ declare n int; begin
  select count(*) into n from fv2_migracao;
  if n <> 29 then raise exception 'reverter-0030 pós: % migrações (esperado 29)', n; end if;
  if exists (select 1 from pg_trigger where tgname in ('fv2_lancamento_documental', 'fv2_obrigacao_documental')) then raise exception 'reverter-0030 pós: gatilho ainda existe'; end if;
end $$;
