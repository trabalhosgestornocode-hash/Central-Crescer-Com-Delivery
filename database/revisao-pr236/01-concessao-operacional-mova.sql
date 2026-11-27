-- PR #236 — CONCESSÃO OPERACIONAL do MOVA (identidade 839a6da8) nas DUAS unidades. PREPARADO PARA REVISÃO — NÃO APLICADO.
-- Pré-requisito: FV2 0033 e 0034 aplicadas (o SQL confere). Acrescenta SÓ registrar_conta_parcelada e registrar_intercompany às ações atuais
-- (ver, baixar_por_comprovante, enviar_documento, registrar_juros, registrar_obrigacao). NÃO inclui prestar_sangria nem ação ampla.
-- Aplicar como postgres numa transação, uma unidade por vez; conferir o select do fim.

-- ===================== AÇAÍ
begin;
-- MOVA — CONCESSÃO OPERACIONAL (escrita estreita) em UMA unidade. Revisar antes de aplicar. Idempotente.
set local search_path = financeiro_v2, pg_catalog, public;
do $$ begin
  if not exists (select 1 from fv2_escopo where organizacao_id = 'e7216085-1ece-45dc-bc41-d74f11a88e40' and unidade_id = '4d3b75bd-79b5-4335-ae5b-a183580c3555') then raise exception 'MOVA: a unidade não está no Financeiro v2 — nada foi feito'; end if;
  if not exists (select 1 from fv2_migracao where nome = '0033_registrar_conta_parcelada.sql') then raise exception 'MOVA: a migração 0033_registrar_conta_parcelada.sql não foi aplicada — nada foi feito'; end if;
  if not exists (select 1 from fv2_migracao where nome = '0034_operacoes_entre_empresas.sql') then raise exception 'MOVA: a migração 0034_operacoes_entre_empresas.sql não foi aplicada — nada foi feito'; end if;
  if not exists (select 1 from fv2_migracao where nome = '0031_registrar_juros_no_pagamento.sql') then raise exception 'MOVA: a migração 0031_registrar_juros_no_pagamento.sql não foi aplicada — nada foi feito'; end if;
  if not exists (select 1 from fv2_migracao where nome = '0030_registrar_obrigacao_documental.sql') then raise exception 'MOVA: a migração 0030_registrar_obrigacao_documental.sql não foi aplicada — nada foi feito'; end if;
  if exists (select 1 from fv2_concessao c where c.usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' and exists (select 1 from jsonb_array_elements_text(c.acoes) a where not '["financeiro_v2.ver","financeiro_v2.enviar_documento","financeiro_v2.baixar_por_comprovante","financeiro_v2.registrar_obrigacao","financeiro_v2.registrar_juros","financeiro_v2.vincular_pagamento","financeiro_v2.prestar_sangria","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany"]'::jsonb ? a)) then
    raise exception 'MOVA: a identidade operacional tem ação AMPLA em alguma unidade — nada foi feito';
  end if;
end $$;
with atual as (select * from fv2_concessao where organizacao_id = 'e7216085-1ece-45dc-bc41-d74f11a88e40' and unidade_id = '4d3b75bd-79b5-4335-ae5b-a183580c3555' and usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' for update),
nova as (
  insert into fv2_concessao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, chave_idempotencia, impressao, extras, usuario_id, acoes, situacao, concedido_por, justificativa)
  select gen_random_uuid(), 'e7216085-1ece-45dc-bc41-d74f11a88e40', '4d3b75bd-79b5-4335-ae5b-a183580c3555', 1, now(), '63d66676-f042-4197-9b51-076f5145c1b9', now(), '63d66676-f042-4197-9b51-076f5145c1b9', 'concessao:839a6da8-649d-4b6f-81c7-cb51c5c919cd', null, '{"origem":"MOVA_OPERACIONAL"}'::jsonb, '839a6da8-649d-4b6f-81c7-cb51c5c919cd', '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb, 'ATIVA', '63d66676-f042-4197-9b51-076f5145c1b9', 'Revisão do PR #236 (27/11/2026): conta relatada (única e parcelada) e operação entre empresas pela identidade operacional do MOVA. Mantém as ações atuais; sem prestar_sangria; sem ação ampla.'
   where not exists (select 1 from atual)
  returning *),
alterada as (
  update fv2_concessao c set acoes = '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb, situacao = 'ATIVA', versao = c.versao + 1, atualizado_em = now(), atualizado_por = '63d66676-f042-4197-9b51-076f5145c1b9', concedido_por = '63d66676-f042-4197-9b51-076f5145c1b9', justificativa = 'Revisão do PR #236 (27/11/2026): conta relatada (única e parcelada) e operação entre empresas pela identidade operacional do MOVA. Mantém as ações atuais; sem prestar_sangria; sem ação ampla.'
    from atual where c.id = atual.id and (c.acoes <> '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb or c.situacao <> 'ATIVA')
  returning c.*, atual.acoes as acoes_antes, atual.situacao as situacao_antes, atual.versao as versao_antes)
insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'CRIACAO', null, jsonb_build_object('versao', versao, 'acoes', acoes, 'situacao', situacao), justificativa, concedido_por, now() from nova
union all
select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'ALTERACAO', jsonb_build_object('versao', versao_antes, 'acoes', acoes_antes, 'situacao', situacao_antes),
       jsonb_build_object('versao', versao, 'acoes', acoes, 'situacao', situacao), justificativa, concedido_por, now() from alterada;
select organizacao_id, unidade_id, acoes, situacao, versao from fv2_concessao where usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' order by organizacao_id, unidade_id;

commit;

-- ===================== SUBWAY
begin;
-- MOVA — CONCESSÃO OPERACIONAL (escrita estreita) em UMA unidade. Revisar antes de aplicar. Idempotente.
set local search_path = financeiro_v2, pg_catalog, public;
do $$ begin
  if not exists (select 1 from fv2_escopo where organizacao_id = '00000000-0000-0000-0000-000000000001' and unidade_id = '00000000-0000-0000-0000-0000000000a1') then raise exception 'MOVA: a unidade não está no Financeiro v2 — nada foi feito'; end if;
  if not exists (select 1 from fv2_migracao where nome = '0033_registrar_conta_parcelada.sql') then raise exception 'MOVA: a migração 0033_registrar_conta_parcelada.sql não foi aplicada — nada foi feito'; end if;
  if not exists (select 1 from fv2_migracao where nome = '0034_operacoes_entre_empresas.sql') then raise exception 'MOVA: a migração 0034_operacoes_entre_empresas.sql não foi aplicada — nada foi feito'; end if;
  if not exists (select 1 from fv2_migracao where nome = '0031_registrar_juros_no_pagamento.sql') then raise exception 'MOVA: a migração 0031_registrar_juros_no_pagamento.sql não foi aplicada — nada foi feito'; end if;
  if not exists (select 1 from fv2_migracao where nome = '0030_registrar_obrigacao_documental.sql') then raise exception 'MOVA: a migração 0030_registrar_obrigacao_documental.sql não foi aplicada — nada foi feito'; end if;
  if exists (select 1 from fv2_concessao c where c.usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' and exists (select 1 from jsonb_array_elements_text(c.acoes) a where not '["financeiro_v2.ver","financeiro_v2.enviar_documento","financeiro_v2.baixar_por_comprovante","financeiro_v2.registrar_obrigacao","financeiro_v2.registrar_juros","financeiro_v2.vincular_pagamento","financeiro_v2.prestar_sangria","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany"]'::jsonb ? a)) then
    raise exception 'MOVA: a identidade operacional tem ação AMPLA em alguma unidade — nada foi feito';
  end if;
end $$;
with atual as (select * from fv2_concessao where organizacao_id = '00000000-0000-0000-0000-000000000001' and unidade_id = '00000000-0000-0000-0000-0000000000a1' and usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' for update),
nova as (
  insert into fv2_concessao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, chave_idempotencia, impressao, extras, usuario_id, acoes, situacao, concedido_por, justificativa)
  select gen_random_uuid(), '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 1, now(), '63d66676-f042-4197-9b51-076f5145c1b9', now(), '63d66676-f042-4197-9b51-076f5145c1b9', 'concessao:839a6da8-649d-4b6f-81c7-cb51c5c919cd', null, '{"origem":"MOVA_OPERACIONAL"}'::jsonb, '839a6da8-649d-4b6f-81c7-cb51c5c919cd', '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb, 'ATIVA', '63d66676-f042-4197-9b51-076f5145c1b9', 'Revisão do PR #236 (27/11/2026): conta relatada (única e parcelada) e operação entre empresas pela identidade operacional do MOVA. Mantém as ações atuais; sem prestar_sangria; sem ação ampla.'
   where not exists (select 1 from atual)
  returning *),
alterada as (
  update fv2_concessao c set acoes = '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb, situacao = 'ATIVA', versao = c.versao + 1, atualizado_em = now(), atualizado_por = '63d66676-f042-4197-9b51-076f5145c1b9', concedido_por = '63d66676-f042-4197-9b51-076f5145c1b9', justificativa = 'Revisão do PR #236 (27/11/2026): conta relatada (única e parcelada) e operação entre empresas pela identidade operacional do MOVA. Mantém as ações atuais; sem prestar_sangria; sem ação ampla.'
    from atual where c.id = atual.id and (c.acoes <> '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb or c.situacao <> 'ATIVA')
  returning c.*, atual.acoes as acoes_antes, atual.situacao as situacao_antes, atual.versao as versao_antes)
insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'CRIACAO', null, jsonb_build_object('versao', versao, 'acoes', acoes, 'situacao', situacao), justificativa, concedido_por, now() from nova
union all
select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'ALTERACAO', jsonb_build_object('versao', versao_antes, 'acoes', acoes_antes, 'situacao', situacao_antes),
       jsonb_build_object('versao', versao, 'acoes', acoes, 'situacao', situacao), justificativa, concedido_por, now() from alterada;
select organizacao_id, unidade_id, acoes, situacao, versao from fv2_concessao where usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' order by organizacao_id, unidade_id;

commit;
