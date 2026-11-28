-- 04 — CONCESSÃO de registrar_emprestimo à identidade operacional do MOVA em Açaí no Grau Saci e Subway Saci. Revisar antes de aplicar.
-- ALTERAÇÃO PROTEGIDA: mantém exatamente as ações vigentes e só acrescenta a nova. RECUSA (nada é feito) se a 0035 não estiver aplicada,
-- se a identidade tiver ação ampla, ou se qualquer concessão mudou desde a revisão (versão, situação ou ações). Uma transação; histórico gravado.
begin;
set local search_path = financeiro_v2, pg_catalog, public;
do $$ declare c record; begin
  if not exists (select 1 from fv2_migracao where nome = '0035_registrar_emprestimo.sql' and sha256 = '3a02c8fa1079abe762a1267027c0ff36cf9478b03b69358dfec49d525b982509') then raise exception '0035: migração não aplicada (ou hash diferente) — nada foi feito'; end if;
  if exists (select 1 from fv2_concessao x where x.usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' and exists (select 1 from jsonb_array_elements_text(x.acoes) a where not '["financeiro_v2.ver","financeiro_v2.enviar_documento","financeiro_v2.baixar_por_comprovante","financeiro_v2.registrar_obrigacao","financeiro_v2.registrar_juros","financeiro_v2.vincular_pagamento","financeiro_v2.prestar_sangria","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_emprestimo"]'::jsonb ? a)) then
    raise exception '0035: a identidade operacional tem ação AMPLA — nada foi feito'; end if;
  select * into c from fv2_concessao where organizacao_id = 'e7216085-1ece-45dc-bc41-d74f11a88e40' and unidade_id = '4d3b75bd-79b5-4335-ae5b-a183580c3555' and usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' for update;
  if not found or c.situacao <> 'ATIVA' then raise exception '0035: concessão de Açaí no Grau Saci ausente ou não ATIVA — nada foi feito'; end if;
  if c.versao <> 4 or not (c.acoes @> '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb and '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb @> c.acoes) then
    raise exception '0035: a concessão de Açaí no Grau Saci mudou desde a revisão (versão %) — nada foi feito; gerar o kit de novo', c.versao; end if;
  select * into c from fv2_concessao where organizacao_id = '00000000-0000-0000-0000-000000000001' and unidade_id = '00000000-0000-0000-0000-0000000000a1' and usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' for update;
  if not found or c.situacao <> 'ATIVA' then raise exception '0035: concessão de Subway Saci ausente ou não ATIVA — nada foi feito'; end if;
  if c.versao <> 2 or not (c.acoes @> '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb and '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb @> c.acoes) then
    raise exception '0035: a concessão de Subway Saci mudou desde a revisão (versão %) — nada foi feito; gerar o kit de novo', c.versao; end if;
end $$;
with alvo as (select * from fv2_concessao where usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' and situacao = 'ATIVA' and not acoes ? 'financeiro_v2.registrar_emprestimo'
                and (organizacao_id, unidade_id) in (('e7216085-1ece-45dc-bc41-d74f11a88e40'::uuid, '4d3b75bd-79b5-4335-ae5b-a183580c3555'::uuid), ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-0000000000a1'::uuid)) for update),
alterada as (
  update fv2_concessao c set acoes = '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_emprestimo","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb, versao = c.versao + 1, atualizado_em = now(), atualizado_por = '63d66676-f042-4197-9b51-076f5145c1b9', concedido_por = '63d66676-f042-4197-9b51-076f5145c1b9',
         justificativa = 'Empréstimos e financiamentos (principal) pelo MOVA, só com confirmação no WhatsApp e composição declarada — autorizado pelo proprietário'
    from alvo where c.id = alvo.id
  returning c.*, alvo.acoes as acoes_antes, alvo.versao as versao_antes, alvo.situacao as situacao_antes)
insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'ALTERACAO', jsonb_build_object('versao', versao_antes, 'acoes', acoes_antes, 'situacao', situacao_antes),
       jsonb_build_object('versao', versao, 'acoes', acoes, 'situacao', situacao), justificativa, concedido_por, now() from alterada;
do $$ begin
  if (select count(*) from fv2_concessao where acoes ? 'financeiro_v2.registrar_emprestimo') <> 2 then raise exception '0035: a ação ficou fora das 2 concessões previstas — nada foi feito'; end if;
end $$;
select organizacao_id, unidade_id, versao, situacao, acoes from fv2_concessao where usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' order by organizacao_id, unidade_id;
commit;
