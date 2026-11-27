-- =====================================================================================================================
-- Financeiro v2 — migração 0033: CONTA A PAGAR RELATADA E PARCELADA com ação ESTREITA — MOVA (26/11/2026)
--
-- Espelho de economico.registrarContaParcelada. Ação nova `financeiro_v2.registrar_conta_parcelada` (MIGRAÇÃO RESTRITIVA:
-- nenhuma concessão existente a recebe). Caso real: "compra de bebedouro para o açaí, 2 parcelas no cartão, dia 19/12 e 19/01,
-- R$ 194,50" — conta a pagar SEM documento (o relato confirmado no WhatsApp é a origem), em N parcelas com vencimentos EXPLÍCITOS.
-- Quem SÓ tem esta ação (sem registrar/aplicar/corrigir/cancelar/conciliar) grava:
--   * UM lançamento ATIVO pelo TOTAL, de DESPESA — ou PATRIMONIAL apenas na categoria IMOBILIZADO ("Compra de equipamentos e
--     bens", que não entra no resultado) —, com origem OBRIGACAO, criado na MESMA transação das parcelas;
--   * de 1 a 24 parcelas em aberto, sem recorrência, apontando para esse lançamento; a SOMA das parcelas é igual ao total
--     (conferida no fim da transação);
--   * a contraparte nova do relato (ou "Fornecedor não informado") e o histórico dessa operação.
-- Nada de movimentação, liquidação (a conta NÃO nasce paga), documento, receita, dedução, conta, categoria ou alteração de registro
-- existente: as políticas de ALTERAÇÃO não são ampliadas. Políticas ampliadas a partir da expressão ATUAL (pg_policy).
-- A forma de quem só tem `registrar_obrigacao` (0030: uma parcela, despesa, valor igual ao do lançamento) continua IGUAL.
-- =====================================================================================================================

-- 1) Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento",
  "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao", "financeiro_v2.registrar_juros",
  "financeiro_v2.prestar_sangria", "financeiro_v2.registrar_conta_parcelada"]'::jsonb);

-- 2) Políticas de INCLUSÃO: acrescenta a ação às expressões ATUAIS (sem vínculo documental: a conta relatada não tem documento).
do $$
declare
  r record;
  expr text;
begin
  for r in select * from (values
      ('fv2_lancamento', 'fv2_lancamento_incluir'),
      ('fv2_obrigacao', 'fv2_obrigacao_incluir'),
      ('fv2_contraparte', 'fv2_contraparte_incluir'),
      ('fv2_historico', 'fv2_historico_incluir')
    ) as v(tabela, politica) loop
    select pg_get_expr(p.polwithcheck, p.polrelid) into expr
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = current_schema() and c.relname = r.tabela and p.polname = r.politica;
    if expr is null then
      raise exception 'Financeiro v2 0033: política %.% não encontrada.', r.tabela, r.politica;
    end if;
    execute format('alter policy %I on %I with check ((%s) or (select fv2_tem_acao(array[%L])))', r.politica, r.tabela, expr, 'financeiro_v2.registrar_conta_parcelada');
  end loop;
end $$;

-- 3) Quem grava SEM ação ampla: a forma do que é gravado é conferida pelo banco (qualquer gravador não superusuário).
create or replace function fv2_so_registra_conta_parcelada() returns boolean language sql stable as $$
  select not (select rolsuper from pg_roles where rolname = current_user)
     and fv2_tem_acao(array['financeiro_v2.registrar_conta_parcelada'])
     and not fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar'])
$$;

-- A função da 0030 passa a conhecer as DUAS formas estreitas. A identidade que tem as duas ações grava qualquer uma delas, e cada
-- gravação é conferida pela forma em que se encaixa (uma parcela com o valor do lançamento = 0030; parcelada = 0033).
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

-- 4) Soma das parcelas = total do lançamento (no fim da transação, quando todas as parcelas já foram gravadas).
create or replace function fv2_conta_parcelada_soma() returns trigger language plpgsql as $$
declare
  total bigint;
  soma bigint;
  qtd int;
begin
  if not fv2_so_registra_conta_parcelada() then
    return null;
  end if;
  select l.valor_centavos into total from fv2_lancamento l
   where l.organizacao_id = new.organizacao_id and l.unidade_id = new.unidade_id and l.id = new.lancamento_id;
  select coalesce(sum(o.valor_base_centavos), 0), count(*) into soma, qtd from fv2_obrigacao o
   where o.organizacao_id = new.organizacao_id and o.unidade_id = new.unidade_id and o.grupo_id = new.grupo_id;
  if soma <> total or qtd <> (new.parcela->>'total')::int then
    raise exception 'Financeiro v2: as parcelas da conta relatada precisam somar o total do lançamento.' using errcode = '42501';
  end if;
  return null;
end $$;
create constraint trigger fv2_obrigacao_parcelada_soma after insert on fv2_obrigacao deferrable initially deferred
  for each row execute function fv2_conta_parcelada_soma();
