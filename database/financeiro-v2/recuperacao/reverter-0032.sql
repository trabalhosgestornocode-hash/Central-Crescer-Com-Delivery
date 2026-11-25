-- Financeiro v2 — RECUPERAÇÃO da migração 0032 (prestação de contas da sangria, ação estreita). Só DEFINIÇÕES: nenhum dado é alterado.
-- Aplicar como `postgres` (não superusuário, com BYPASSRLS), numa ÚNICA transação, só com autorização específica.
-- Recusa se: 0032 não aplicada; houver migração posterior; ALGUMA concessão tiver `prestar_sangria` (revogue antes).
-- Despesas, liquidações e trocos já gravados continuam válidos (registros normais); só a ação e as barreiras somem.
-- As expressões restauradas são as de PRODUÇÃO lidas em 25/11/2026 antes da 0032.
set local search_path = financeiro_v2, pg_catalog;
do $$ declare n int; begin
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception 'reverter-0032: não aplicar como superusuário'; end if;
  if not (select rolbypassrls from pg_roles where rolname = current_user) then raise exception 'reverter-0032: exige BYPASSRLS (senão as contagens enganam)'; end if;
  if not exists (select 1 from fv2_migracao where nome = '0032_prestar_sangria.sql') then raise exception 'reverter-0032: 0032 não aplicada — nada foi feito'; end if;
  select count(*) into n from fv2_migracao where nome > '0032_prestar_sangria.sql';
  if n > 0 then raise exception 'reverter-0032: há % migração(ões) posterior(es) — nada foi feito', n; end if;
  select count(*) into n from fv2_concessao where acoes ? 'financeiro_v2.prestar_sangria';
  if n > 0 then raise exception 'reverter-0032: % concessão(ões) com prestar_sangria — revogue antes', n; end if;
end $$;
grant fv2_guardiao to current_user;
-- gatilho da 0029 como era (sem a exceção da sangria)
create or replace function fv2_pagamento_por_comprovante() returns trigger language plpgsql as $$
declare
  tipo_doc text;
  m record;
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por', 'extras', 'movimentacao_id'];
  so_documental boolean;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  so_documental := not fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.vincular_pagamento', 'financeiro_v2.cancelar']);
  if tg_op = 'INSERT' then
    if new.movimentacao_id is not null then
      if so_documental then
        raise exception 'Financeiro v2: quem só baixa por comprovante não grava liquidação com saída bancária.' using errcode = '42501';
      end if;
      return new;
    end if;
    if new.alvo_tipo <> 'OBRIGACAO' or coalesce(new.extras->>'origemDoVinculo', '') <> 'COMPROVANTE' then
      raise exception 'Financeiro v2: liquidação sem saída bancária só para pagamento de conta por comprovante.' using errcode = '42501';
    end if;
    select d.tipo into tipo_doc from fv2_documento d
     where d.organizacao_id = new.organizacao_id and d.unidade_id = new.unidade_id and d.id = (new.extras->>'documentoId')::uuid;
    if tipo_doc is distinct from 'COMPROVANTE' then
      raise exception 'Financeiro v2: pagamento sem extrato exige um documento COMPROVANTE desta unidade.' using errcode = '42501';
    end if;
    if new.data_efetiva > current_date + 1 then
      raise exception 'Financeiro v2: pagamento por comprovante não pode ter data futura (agendamento não é pagamento).' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.movimentacao_id is not null and new.movimentacao_id is distinct from old.movimentacao_id then
    raise exception 'Financeiro v2: a saída de uma liquidação não se troca.' using errcode = '42501';
  end if;
  if old.movimentacao_id is null and new.movimentacao_id is not null then
    if (to_jsonb(old) - livres) is distinct from (to_jsonb(new) - livres)
       or coalesce(new.extras->>'origemDoVinculo', '') <> 'COMPROVANTE'
       or (old.extras->'documentoId') is distinct from (new.extras->'documentoId') then
      raise exception 'Financeiro v2: conciliar o pagamento por comprovante só liga a saída do extrato (nada mais muda).' using errcode = '42501';
    end if;
    select x.* into m from fv2_movimentacao x
     where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.movimentacao_id;
    if not found or m.sentido <> 'SAIDA' or m.situacao <> 'VALIDA' or m.transferencia_id is not null or m.pagamento_id is not null
       or m.estorno_id is not null or m.natureza in ('DEVOLUCAO', 'TRANSFERENCIA_INTERNA')
       or m.valor_centavos <> new.valor_centavos - new.estornado_centavos then
      raise exception 'Financeiro v2: a conciliação exige saída válida do extrato com o valor do pagamento.' using errcode = '42501';
    end if;
    return new;
  end if;
  if fv2_so_vincula() and (to_jsonb(old) - array['versao', 'atualizado_em', 'atualizado_por']) is distinct from (to_jsonb(new) - array['versao', 'atualizado_em', 'atualizado_por']) then
    raise exception 'Financeiro v2: sem permissão para alterar esta liquidação além da conciliação.' using errcode = '42501';
  end if;
  return new;
end $$;
-- gatilho do vínculo de extrato como era (sem a exceção da sangria)
create or replace function fv2_vinculo_extrato_liquidacao() returns trigger language plpgsql as $$
declare
  m record;
  xid_atual text := (pg_current_xact_id()::text::bigint % 4294967296)::text;
begin
  if not fv2_so_vincula() then
    return new;
  end if;
  if new.movimentacao_id is null then
    return new; -- pagamento por comprovante (0029)
  end if;
  if new.alvo_tipo <> 'OBRIGACAO' then
    raise exception 'Financeiro v2: vincular pagamento do extrato só baixa conta a pagar.' using errcode = '42501';
  end if;
  select x.*, x.xmin::text as criada_em_xid into m from fv2_movimentacao x
   where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.movimentacao_id;
  if not found or m.sentido <> 'SAIDA' or m.situacao <> 'VALIDA' or m.transferencia_id is not null or m.pagamento_id is not null
     or m.estorno_id is not null or m.natureza in ('DEVOLUCAO', 'TRANSFERENCIA_INTERNA') then
    raise exception 'Financeiro v2: a baixa por extrato exige uma saída válida, que não seja transferência nem devolução.' using errcode = '42501';
  end if;
  if m.criada_em_xid = xid_atual then
    raise exception 'Financeiro v2: vincular pagamento do extrato usa saída JÁ registrada — não cria saída nova.' using errcode = '42501';
  end if;
  if coalesce(new.extras->>'origemDoVinculo', '') <> 'EXTRATO' then
    raise exception 'Financeiro v2: liquidação gravada por vincular_pagamento precisa ser marcada como vínculo de extrato.' using errcode = '42501';
  end if;
  if new.extras->>'documentoId' is null and not exists (
    select 1 from fv2_correspondencia c
     where c.organizacao_id = new.organizacao_id and c.unidade_id = new.unidade_id and c.situacao = 'CONFIRMADA'
       and cardinality(c.evidencia_documento_ids) > 0
       and (c.lado_a || c.lado_b) @> jsonb_build_array(jsonb_build_object('tipo', 'MOVIMENTACAO', 'id', new.movimentacao_id::text))
       and (c.lado_a || c.lado_b) @> jsonb_build_array(jsonb_build_object('tipo', 'OBRIGACAO', 'id', new.alvo_id::text))) then
    raise exception 'Financeiro v2: a baixa por extrato exige documento que comprove o pagamento ou conciliação confirmada com evidência.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger fv2_lancamento_sangria on fv2_lancamento;
drop trigger fv2_obrigacao_sangria on fv2_obrigacao;
drop trigger fv2_liquidacao_sangria on fv2_liquidacao;
drop trigger fv2_movimentacao_sangria on fv2_movimentacao;
drop trigger fv2_sessao_caixa_sangria on fv2_sessao_caixa;
drop function fv2_prestacao_de_sangria();
drop function fv2_e_saida_de_sangria(uuid, uuid, uuid);
drop function fv2_so_presta_sangria();
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento",
  "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao", "financeiro_v2.registrar_juros"]'::jsonb);
alter policy fv2_contraparte_incluir on fv2_contraparte with check ((( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.aplicar'::text, 'financeiro_v2.registrar'::text]) AS fv2_tem_acao) OR ( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.registrar_obrigacao'::text]) AS fv2_tem_acao)));
alter policy fv2_historico_incluir on fv2_historico with check ((( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.registrar'::text, 'financeiro_v2.corrigir'::text, 'financeiro_v2.cancelar'::text, 'financeiro_v2.conciliar'::text, 'financeiro_v2.fechar'::text, 'financeiro_v2.homologar'::text, 'financeiro_v2.revisar'::text, 'financeiro_v2.configurar'::text, 'financeiro_v2.importar'::text, 'financeiro_v2.conceder'::text, 'financeiro_v2.documentos'::text, 'financeiro_v2.aprovar'::text, 'financeiro_v2.aplicar'::text, 'financeiro_v2.revogar'::text, 'financeiro_v2.confirmar_importacao'::text, 'financeiro_v2.reabrir'::text, 'financeiro_v2.reclassificar'::text, 'financeiro_v2.enviar_documento'::text, 'financeiro_v2.vincular_pagamento'::text]) AS fv2_tem_acao) OR (( SELECT financeiro_v2.fv2_em_provisionamento() AS fv2_em_provisionamento) AND (registro_tipo = 'CONCESSAO'::text)) OR ((CURRENT_USER = 'fv2_guardiao'::name) AND (registro_tipo = 'CONCESSAO'::text)) OR ( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.baixar_por_comprovante'::text]) AS fv2_tem_acao) OR ( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.registrar_obrigacao'::text]) AS fv2_tem_acao) OR ( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.registrar_juros'::text]) AS fv2_tem_acao)));
alter policy fv2_lancamento_incluir on fv2_lancamento with check ((( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.aplicar'::text, 'financeiro_v2.cancelar'::text, 'financeiro_v2.corrigir'::text, 'financeiro_v2.registrar'::text, 'financeiro_v2.revisar'::text]) AS fv2_tem_acao) OR ( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.registrar_obrigacao'::text]) AS fv2_tem_acao) OR ( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.registrar_juros'::text]) AS fv2_tem_acao)));
alter policy fv2_liquidacao_incluir on fv2_liquidacao with check ((( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.registrar'::text, 'financeiro_v2.aplicar'::text, 'financeiro_v2.vincular_pagamento'::text]) AS fv2_tem_acao) OR ( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.baixar_por_comprovante'::text]) AS fv2_tem_acao)));
alter policy fv2_movimentacao_alterar on fv2_movimentacao using ((( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.registrar'::text, 'financeiro_v2.corrigir'::text, 'financeiro_v2.cancelar'::text, 'financeiro_v2.conciliar'::text, 'financeiro_v2.fechar'::text, 'financeiro_v2.homologar'::text, 'financeiro_v2.revisar'::text, 'financeiro_v2.configurar'::text, 'financeiro_v2.importar'::text, 'financeiro_v2.conceder'::text, 'financeiro_v2.documentos'::text, 'financeiro_v2.aprovar'::text, 'financeiro_v2.aplicar'::text, 'financeiro_v2.revogar'::text, 'financeiro_v2.confirmar_importacao'::text, 'financeiro_v2.reabrir'::text, 'financeiro_v2.reclassificar'::text, 'financeiro_v2.enviar_documento'::text, 'financeiro_v2.vincular_pagamento'::text]) AS fv2_tem_acao) OR ( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.baixar_por_comprovante'::text]) AS fv2_tem_acao)));
alter policy fv2_movimentacao_alterar on fv2_movimentacao with check (( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.cancelar'::text, 'financeiro_v2.conciliar'::text, 'financeiro_v2.registrar'::text, 'financeiro_v2.vincular_pagamento'::text]) AS fv2_tem_acao));
alter policy fv2_movimentacao_incluir on fv2_movimentacao with check (( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.aplicar'::text, 'financeiro_v2.cancelar'::text, 'financeiro_v2.registrar'::text, 'financeiro_v2.revisar'::text]) AS fv2_tem_acao));
alter policy fv2_obrigacao_alterar on fv2_obrigacao using ((( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.registrar'::text, 'financeiro_v2.corrigir'::text, 'financeiro_v2.cancelar'::text, 'financeiro_v2.conciliar'::text, 'financeiro_v2.fechar'::text, 'financeiro_v2.homologar'::text, 'financeiro_v2.revisar'::text, 'financeiro_v2.configurar'::text, 'financeiro_v2.importar'::text, 'financeiro_v2.conceder'::text, 'financeiro_v2.documentos'::text, 'financeiro_v2.aprovar'::text, 'financeiro_v2.aplicar'::text, 'financeiro_v2.revogar'::text, 'financeiro_v2.confirmar_importacao'::text, 'financeiro_v2.reabrir'::text, 'financeiro_v2.reclassificar'::text, 'financeiro_v2.enviar_documento'::text, 'financeiro_v2.vincular_pagamento'::text]) AS fv2_tem_acao) OR ( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.baixar_por_comprovante'::text]) AS fv2_tem_acao)));
alter policy fv2_obrigacao_alterar on fv2_obrigacao with check ((( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.cancelar'::text, 'financeiro_v2.corrigir'::text, 'financeiro_v2.registrar'::text, 'financeiro_v2.vincular_pagamento'::text]) AS fv2_tem_acao) OR ( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.baixar_por_comprovante'::text]) AS fv2_tem_acao)));
alter policy fv2_obrigacao_incluir on fv2_obrigacao with check ((( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.aplicar'::text, 'financeiro_v2.registrar'::text]) AS fv2_tem_acao) OR ( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.registrar_obrigacao'::text]) AS fv2_tem_acao)));
alter policy fv2_sessao_caixa_alterar on fv2_sessao_caixa using (( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.registrar'::text, 'financeiro_v2.corrigir'::text, 'financeiro_v2.cancelar'::text, 'financeiro_v2.conciliar'::text, 'financeiro_v2.fechar'::text, 'financeiro_v2.homologar'::text, 'financeiro_v2.revisar'::text, 'financeiro_v2.configurar'::text, 'financeiro_v2.importar'::text, 'financeiro_v2.conceder'::text, 'financeiro_v2.documentos'::text, 'financeiro_v2.aprovar'::text, 'financeiro_v2.aplicar'::text, 'financeiro_v2.revogar'::text, 'financeiro_v2.confirmar_importacao'::text, 'financeiro_v2.reabrir'::text, 'financeiro_v2.reclassificar'::text, 'financeiro_v2.enviar_documento'::text, 'financeiro_v2.vincular_pagamento'::text]) AS fv2_tem_acao));
alter policy fv2_sessao_caixa_alterar on fv2_sessao_caixa with check (( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.registrar'::text]) AS fv2_tem_acao));
alter policy fv2_vinculo_documental_incluir on fv2_vinculo_documental with check ((( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.registrar'::text, 'financeiro_v2.importar'::text, 'financeiro_v2.reclassificar'::text, 'financeiro_v2.enviar_documento'::text, 'financeiro_v2.vincular_pagamento'::text]) AS fv2_tem_acao) OR ( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.baixar_por_comprovante'::text]) AS fv2_tem_acao) OR ( SELECT financeiro_v2.fv2_tem_acao(ARRAY['financeiro_v2.registrar_obrigacao'::text]) AS fv2_tem_acao)));
delete from fv2_migracao where nome = '0032_prestar_sangria.sql';
revoke fv2_guardiao from current_user;
do $$ declare n int; begin
  select count(*) into n from fv2_migracao;
  if n <> 31 then raise exception 'reverter-0032 pós: % migrações (esperado 31)', n; end if;
  if exists (select 1 from pg_trigger where tgname like 'fv2\_%\_sangria') then raise exception 'reverter-0032 pós: gatilho ainda existe'; end if;
  if exists (select 1 from pg_policy where pg_get_expr(polqual, polrelid) like '%prestar_sangria%' or pg_get_expr(polwithcheck, polrelid) like '%prestar_sangria%') then raise exception 'reverter-0032 pós: política ainda cita prestar_sangria'; end if;
end $$;
