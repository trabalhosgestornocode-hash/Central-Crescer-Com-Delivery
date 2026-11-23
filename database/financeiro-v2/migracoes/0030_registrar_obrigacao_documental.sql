-- =====================================================================================================================
-- Financeiro v2 — migração 0030: CONTA A PAGAR A PARTIR DE DOCUMENTO com ação ESTREITA — Agente 2 (23/11/2026)
--
-- Espelho de economico.registrarObrigacaoDocumental. Ação nova `financeiro_v2.registrar_obrigacao` (MIGRAÇÃO RESTRITIVA:
-- nenhuma concessão existente a recebe). Quem SÓ tem esta ação (sem registrar/aplicar/corrigir/cancelar/conciliar) grava:
--   * UM lançamento de DESPESA, ativo, com origem OBRIGACAO, criado na MESMA transação da obrigação;
--   * a obrigação de UMA parcela, sem recorrência, em aberto, apontando para esse lançamento (o documento entra pelo vínculo
--     documental logo depois; o pagamento por comprovante exige o COMPROVANTE — 0029);
--   * a contraparte nova do formulário, o histórico e o vínculo documental dessa operação.
-- Nada de movimentação, liquidação, receita, dedução, patrimonial, conta, categoria ou alteração de registro existente: as
-- políticas de ALTERAÇÃO não são ampliadas. Políticas ampliadas a partir da expressão ATUAL (pg_policy).
-- =====================================================================================================================

-- 1) Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento",
  "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao"]'::jsonb);

-- 2) Políticas de INCLUSÃO: acrescenta a ação às expressões ATUAIS.
do $$
declare
  r record;
  expr text;
begin
  for r in select * from (values
      ('fv2_lancamento', 'fv2_lancamento_incluir'),
      ('fv2_obrigacao', 'fv2_obrigacao_incluir'),
      ('fv2_contraparte', 'fv2_contraparte_incluir'),
      ('fv2_vinculo_documental', 'fv2_vinculo_documental_incluir'),
      ('fv2_historico', 'fv2_historico_incluir')
    ) as v(tabela, politica) loop
    select pg_get_expr(p.polwithcheck, p.polrelid) into expr
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = current_schema() and c.relname = r.tabela and p.polname = r.politica;
    if expr is null then
      raise exception 'Financeiro v2 0030: política %.% não encontrada.', r.tabela, r.politica;
    end if;
    execute format('alter policy %I on %I with check ((%s) or (select fv2_tem_acao(array[%L])))', r.politica, r.tabela, expr, 'financeiro_v2.registrar_obrigacao');
  end loop;
end $$;

-- 3) Quem SÓ registra obrigação por documento: o banco confere a forma do que é gravado (qualquer gravador não superusuário).
create or replace function fv2_so_registra_obrigacao() returns boolean language sql stable as $$
  select not (select rolsuper from pg_roles where rolname = current_user)
     and fv2_tem_acao(array['financeiro_v2.registrar_obrigacao'])
     and not fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar'])
$$;

create or replace function fv2_obrigacao_documental() returns trigger language plpgsql as $$
declare
  l record;
  xid_atual text := (pg_current_xact_id()::text::bigint % 4294967296)::text;
begin
  if not fv2_so_registra_obrigacao() then
    return new;
  end if;
  if tg_table_name = 'fv2_lancamento' then
    if new.natureza <> 'DESPESA' or new.situacao <> 'ATIVO' or new.valor_centavos <= 0 or new.origem->>'tipo' <> 'OBRIGACAO' or new.retido_no_repasse then
      raise exception 'Financeiro v2: por documento só se registra lançamento de DESPESA nascido de conta a pagar.' using errcode = '42501';
    end if;
    return new;
  end if;
  -- fv2_obrigacao
  if (new.parcela->>'total')::int <> 1 or new.recorrencia is not null or new.situacao <> 'ABERTA' or new.liquidado_centavos <> 0 or new.ajustes_centavos <> 0 then
    raise exception 'Financeiro v2: conta a pagar por documento tem uma parcela, sem repetição e em aberto.' using errcode = '42501';
  end if;
  select x.*, x.xmin::text as criado_em_xid into l from fv2_lancamento x
   where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.lancamento_id;
  if not found or l.criado_em_xid <> xid_atual or l.origem->>'id' <> new.grupo_id::text or l.valor_centavos <> new.valor_base_centavos then
    raise exception 'Financeiro v2: a conta a pagar por documento aponta para o lançamento criado com ela (mesma transação e valor).' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_lancamento_documental before insert on fv2_lancamento for each row execute function fv2_obrigacao_documental();
create trigger fv2_obrigacao_documental before insert on fv2_obrigacao for each row execute function fv2_obrigacao_documental();
