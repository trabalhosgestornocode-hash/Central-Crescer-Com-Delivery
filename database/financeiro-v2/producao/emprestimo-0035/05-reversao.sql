-- 05 — REVERSÃO da 0035 (só se necessário; revisar antes). Passo A: concessões voltam às ações anteriores. Passo B: banco volta à 0034.
-- ===================== A) concessões (mesmo kit oficial, sem registrar_emprestimo)
-- MOVA — CONCESSÃO OPERACIONAL (escrita estreita) em UMA unidade. Revisar antes de aplicar. Idempotente.
set local search_path = financeiro_v2, pg_catalog, public;
do $$ begin
  if not exists (select 1 from fv2_escopo where organizacao_id = 'e7216085-1ece-45dc-bc41-d74f11a88e40' and unidade_id = '4d3b75bd-79b5-4335-ae5b-a183580c3555') then raise exception 'MOVA: a unidade não está no Financeiro v2 — nada foi feito'; end if;
  if not exists (select 1 from fv2_migracao where nome = '0033_registrar_conta_parcelada.sql') then raise exception 'MOVA: a migração 0033_registrar_conta_parcelada.sql não foi aplicada — nada foi feito'; end if;
  if not exists (select 1 from fv2_migracao where nome = '0034_operacoes_entre_empresas.sql') then raise exception 'MOVA: a migração 0034_operacoes_entre_empresas.sql não foi aplicada — nada foi feito'; end if;
  if not exists (select 1 from fv2_migracao where nome = '0031_registrar_juros_no_pagamento.sql') then raise exception 'MOVA: a migração 0031_registrar_juros_no_pagamento.sql não foi aplicada — nada foi feito'; end if;
  if not exists (select 1 from fv2_migracao where nome = '0030_registrar_obrigacao_documental.sql') then raise exception 'MOVA: a migração 0030_registrar_obrigacao_documental.sql não foi aplicada — nada foi feito'; end if;
  if exists (select 1 from fv2_concessao c where c.usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' and exists (select 1 from jsonb_array_elements_text(c.acoes) a where not '["financeiro_v2.ver","financeiro_v2.enviar_documento","financeiro_v2.baixar_por_comprovante","financeiro_v2.registrar_obrigacao","financeiro_v2.registrar_juros","financeiro_v2.vincular_pagamento","financeiro_v2.prestar_sangria","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_emprestimo"]'::jsonb ? a)) then
    raise exception 'MOVA: a identidade operacional tem ação AMPLA em alguma unidade — nada foi feito';
  end if;
end $$;
with atual as (select * from fv2_concessao where organizacao_id = 'e7216085-1ece-45dc-bc41-d74f11a88e40' and unidade_id = '4d3b75bd-79b5-4335-ae5b-a183580c3555' and usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' for update),
nova as (
  insert into fv2_concessao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, chave_idempotencia, impressao, extras, usuario_id, acoes, situacao, concedido_por, justificativa)
  select gen_random_uuid(), 'e7216085-1ece-45dc-bc41-d74f11a88e40', '4d3b75bd-79b5-4335-ae5b-a183580c3555', 1, now(), '63d66676-f042-4197-9b51-076f5145c1b9', now(), '63d66676-f042-4197-9b51-076f5145c1b9', 'concessao:839a6da8-649d-4b6f-81c7-cb51c5c919cd', null, '{"origem":"MOVA_OPERACIONAL"}'::jsonb, '839a6da8-649d-4b6f-81c7-cb51c5c919cd', '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb, 'ATIVA', '63d66676-f042-4197-9b51-076f5145c1b9', 'Reversão da 0035: concessão volta às ações anteriores'
   where not exists (select 1 from atual)
  returning *),
alterada as (
  update fv2_concessao c set acoes = '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb, situacao = 'ATIVA', versao = c.versao + 1, atualizado_em = now(), atualizado_por = '63d66676-f042-4197-9b51-076f5145c1b9', concedido_por = '63d66676-f042-4197-9b51-076f5145c1b9', justificativa = 'Reversão da 0035: concessão volta às ações anteriores'
    from atual where c.id = atual.id and (c.acoes <> '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb or c.situacao <> 'ATIVA')
  returning c.*, atual.acoes as acoes_antes, atual.situacao as situacao_antes, atual.versao as versao_antes)
insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'CRIACAO', null, jsonb_build_object('versao', versao, 'acoes', acoes, 'situacao', situacao), justificativa, concedido_por, now() from nova
union all
select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'ALTERACAO', jsonb_build_object('versao', versao_antes, 'acoes', acoes_antes, 'situacao', situacao_antes),
       jsonb_build_object('versao', versao, 'acoes', acoes, 'situacao', situacao), justificativa, concedido_por, now() from alterada;
select organizacao_id, unidade_id, acoes, situacao, versao from fv2_concessao where usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' order by organizacao_id, unidade_id;

-- MOVA — CONCESSÃO OPERACIONAL (escrita estreita) em UMA unidade. Revisar antes de aplicar. Idempotente.
set local search_path = financeiro_v2, pg_catalog, public;
do $$ begin
  if not exists (select 1 from fv2_escopo where organizacao_id = '00000000-0000-0000-0000-000000000001' and unidade_id = '00000000-0000-0000-0000-0000000000a1') then raise exception 'MOVA: a unidade não está no Financeiro v2 — nada foi feito'; end if;
  if not exists (select 1 from fv2_migracao where nome = '0033_registrar_conta_parcelada.sql') then raise exception 'MOVA: a migração 0033_registrar_conta_parcelada.sql não foi aplicada — nada foi feito'; end if;
  if not exists (select 1 from fv2_migracao where nome = '0034_operacoes_entre_empresas.sql') then raise exception 'MOVA: a migração 0034_operacoes_entre_empresas.sql não foi aplicada — nada foi feito'; end if;
  if not exists (select 1 from fv2_migracao where nome = '0031_registrar_juros_no_pagamento.sql') then raise exception 'MOVA: a migração 0031_registrar_juros_no_pagamento.sql não foi aplicada — nada foi feito'; end if;
  if not exists (select 1 from fv2_migracao where nome = '0030_registrar_obrigacao_documental.sql') then raise exception 'MOVA: a migração 0030_registrar_obrigacao_documental.sql não foi aplicada — nada foi feito'; end if;
  if exists (select 1 from fv2_concessao c where c.usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' and exists (select 1 from jsonb_array_elements_text(c.acoes) a where not '["financeiro_v2.ver","financeiro_v2.enviar_documento","financeiro_v2.baixar_por_comprovante","financeiro_v2.registrar_obrigacao","financeiro_v2.registrar_juros","financeiro_v2.vincular_pagamento","financeiro_v2.prestar_sangria","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_emprestimo"]'::jsonb ? a)) then
    raise exception 'MOVA: a identidade operacional tem ação AMPLA em alguma unidade — nada foi feito';
  end if;
end $$;
with atual as (select * from fv2_concessao where organizacao_id = '00000000-0000-0000-0000-000000000001' and unidade_id = '00000000-0000-0000-0000-0000000000a1' and usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' for update),
nova as (
  insert into fv2_concessao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, chave_idempotencia, impressao, extras, usuario_id, acoes, situacao, concedido_por, justificativa)
  select gen_random_uuid(), '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 1, now(), '63d66676-f042-4197-9b51-076f5145c1b9', now(), '63d66676-f042-4197-9b51-076f5145c1b9', 'concessao:839a6da8-649d-4b6f-81c7-cb51c5c919cd', null, '{"origem":"MOVA_OPERACIONAL"}'::jsonb, '839a6da8-649d-4b6f-81c7-cb51c5c919cd', '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb, 'ATIVA', '63d66676-f042-4197-9b51-076f5145c1b9', 'Reversão da 0035: concessão volta às ações anteriores'
   where not exists (select 1 from atual)
  returning *),
alterada as (
  update fv2_concessao c set acoes = '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb, situacao = 'ATIVA', versao = c.versao + 1, atualizado_em = now(), atualizado_por = '63d66676-f042-4197-9b51-076f5145c1b9', concedido_por = '63d66676-f042-4197-9b51-076f5145c1b9', justificativa = 'Reversão da 0035: concessão volta às ações anteriores'
    from atual where c.id = atual.id and (c.acoes <> '["financeiro_v2.baixar_por_comprovante","financeiro_v2.enviar_documento","financeiro_v2.registrar_conta_parcelada","financeiro_v2.registrar_intercompany","financeiro_v2.registrar_juros","financeiro_v2.registrar_obrigacao","financeiro_v2.ver"]'::jsonb or c.situacao <> 'ATIVA')
  returning c.*, atual.acoes as acoes_antes, atual.situacao as situacao_antes, atual.versao as versao_antes)
insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'CRIACAO', null, jsonb_build_object('versao', versao, 'acoes', acoes, 'situacao', situacao), justificativa, concedido_por, now() from nova
union all
select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'ALTERACAO', jsonb_build_object('versao', versao_antes, 'acoes', acoes_antes, 'situacao', situacao_antes),
       jsonb_build_object('versao', versao, 'acoes', acoes, 'situacao', situacao), justificativa, concedido_por, now() from alterada;
select organizacao_id, unidade_id, acoes, situacao, versao from fv2_concessao where usuario_id = '839a6da8-649d-4b6f-81c7-cb51c5c919cd' order by organizacao_id, unidade_id;

-- ===================== B) banco
begin;
set local search_path = financeiro_v2, pg_catalog, public;
do $$ begin
  if exists (select 1 from fv2_concessao where acoes ? 'financeiro_v2.registrar_emprestimo') then raise exception '0035: ainda há concessão com registrar_emprestimo — rode o passo A antes'; end if;
end $$;
create or replace function fv2_obrigacao_documental() returns trigger language plpgsql as $$
declare
  l record;
  xid_atual text := (pg_current_xact_id()::text::bigint % 4294967296)::text;
  documental boolean := fv2_so_registra_obrigacao();
  parcelada boolean := fv2_so_registra_conta_parcelada();
begin
  if not documental and not parcelada then
    return new;
  end if;
  if tg_table_name = 'fv2_lancamento' then
    -- 27/11: PRESERVA a exceção da 0031 (encargo do pagamento por quem tem registrar_juros; forma conferida por
    -- fv2_juros_documental). A primeira versão desta migração a perdia e recusava toda despesa paga com juros/multa.
    if documental and new.origem->>'tipo' = 'AJUSTE' and fv2_tem_acao(array['financeiro_v2.registrar_juros']) then
      return new;
    end if;
    if new.situacao <> 'ATIVO' or new.valor_centavos <= 0 or new.origem->>'tipo' <> 'OBRIGACAO' or new.retido_no_repasse then
      raise exception 'Financeiro v2: só se registra lançamento ativo nascido de conta a pagar.' using errcode = '42501';
    end if;
    if new.natureza = 'DESPESA' or (parcelada and new.natureza = 'PATRIMONIAL' and new.categoria_codigo = 'IMOBILIZADO') then
      return new;
    end if;
    raise exception 'Financeiro v2: conta a pagar estreita só em categoria de DESPESA (ou compra de equipamentos, na relatada).' using errcode = '42501';
  end if;
  -- fv2_obrigacao
  if new.recorrencia is not null or new.situacao <> 'ABERTA' or new.liquidado_centavos <> 0 or new.ajustes_centavos <> 0 then
    raise exception 'Financeiro v2: conta a pagar estreita nasce em aberto, sem repetição.' using errcode = '42501';
  end if;
  select x.*, x.xmin::text as criado_em_xid into l from fv2_lancamento x
   where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.lancamento_id;
  if not found or l.criado_em_xid <> xid_atual or l.origem->>'id' <> new.grupo_id::text then
    raise exception 'Financeiro v2: a conta a pagar estreita aponta para o lançamento criado com ela (mesma transação).' using errcode = '42501';
  end if;
  -- forma da 0030: uma parcela, valor igual ao do lançamento, natureza DESPESA
  if documental and (new.parcela->>'total')::int = 1 and l.valor_centavos = new.valor_base_centavos and l.natureza = 'DESPESA' then
    return new;
  end if;
  -- forma da 0033: 1 a 24 parcelas do MESMO lançamento (a soma é conferida no fim da transação)
  if parcelada and (new.parcela->>'total')::int between 1 and 24 and (new.parcela->>'numero')::int between 1 and (new.parcela->>'total')::int
     and new.valor_base_centavos > 0 and new.valor_base_centavos <= l.valor_centavos and cardinality(new.documento_ids) = 0 then
    return new;
  end if;
  raise exception 'Financeiro v2: forma de conta a pagar não permitida para esta permissão estreita.' using errcode = '42501';
end $$;
drop function if exists fv2_principal_de_emprestimo(text, text);
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar", "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar", "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos", "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir", "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento", "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao", "financeiro_v2.registrar_juros", "financeiro_v2.prestar_sangria", "financeiro_v2.registrar_conta_parcelada", "financeiro_v2.registrar_intercompany"]'::jsonb);
delete from fv2_migracao where nome = '0035_registrar_emprestimo.sql';
select count(*) migracoes from fv2_migracao;
commit;
