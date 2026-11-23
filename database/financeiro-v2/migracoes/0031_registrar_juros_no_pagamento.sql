-- =====================================================================================================================
-- Financeiro v2 — migração 0031: ENCARGO (JUROS/MULTA) NO PAGAMENTO POR COMPROVANTE com ação ESTREITA — 23/11/2026
--
-- Espelho de baixaPorComprovante.registrarPagamentoComEncargo. Ação nova `financeiro_v2.registrar_juros` (MIGRAÇÃO
-- RESTRITIVA: nenhuma concessão existente a recebe). Ela NÃO é `corrigir`: só vale JUNTO com `baixar_por_comprovante` e, para
-- quem não tem as ações amplas (registrar, aplicar, corrigir, cancelar, conciliar), o banco confere a forma do que é gravado:
--   * UM lançamento de DESPESA, ativo, origem AJUSTE, na categoria oficial JUROS_E_MULTAS_DE_FORNECEDORES;
--   * UM ajuste de conta a pagar (OBRIGACAO), positivo, de no máximo 10% do valor base da conta, apontando para esse lançamento.
-- Nada de movimentação, receita, conta, categoria nova ou alteração de outro registro. Políticas ampliadas a partir da
-- expressão ATUAL (pg_policy), sem reescrever as regras das migrações anteriores.
-- =====================================================================================================================

-- 1) Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento",
  "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao", "financeiro_v2.registrar_juros"]'::jsonb);

-- 2) Políticas de INCLUSÃO: acrescenta a ação às expressões ATUAIS.
do $$
declare
  r record;
  expr text;
begin
  for r in select * from (values
      ('fv2_lancamento', 'fv2_lancamento_incluir'),
      ('fv2_ajuste', 'fv2_ajuste_incluir'),
      ('fv2_historico', 'fv2_historico_incluir')
    ) as v(tabela, politica) loop
    select pg_get_expr(p.polwithcheck, p.polrelid) into expr
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = current_schema() and c.relname = r.tabela and p.polname = r.politica;
    if expr is null then
      raise exception 'Financeiro v2 0031: política %.% não encontrada.', r.tabela, r.politica;
    end if;
    execute format('alter policy %I on %I with check ((%s) or (select fv2_tem_acao(array[%L])))', r.politica, r.tabela, expr, 'financeiro_v2.registrar_juros');
  end loop;
end $$;

-- 3) Quem tem `registrar_juros` e NENHUMA ação ampla: o banco confere a forma do encargo gravado.
create or replace function fv2_so_registra_juros() returns boolean language sql stable as $$
  select not (select rolsuper from pg_roles where rolname = current_user)
     and fv2_tem_acao(array['financeiro_v2.registrar_juros'])
     and not fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar'])
$$;

create or replace function fv2_juros_documental() returns trigger language plpgsql as $$
declare
  o record;
  l record;
begin
  if not fv2_so_registra_juros() then
    return new;
  end if;
  if tg_table_name = 'fv2_lancamento' then
    if new.origem->>'tipo' is distinct from 'AJUSTE' then
      return new; -- outros lançamentos são decididos pelas políticas/gatilhos das demais ações
    end if;
    if new.natureza <> 'DESPESA' or new.situacao <> 'ATIVO' or new.valor_centavos <= 0 or new.categoria_codigo <> 'JUROS_E_MULTAS_DE_FORNECEDORES' or new.retido_no_repasse then
      raise exception 'Financeiro v2: o encargo do pagamento é uma despesa ativa na categoria oficial de juros e multas.' using errcode = '42501';
    end if;
    return new;
  end if;
  -- fv2_ajuste
  if new.alvo_tipo <> 'OBRIGACAO' or new.valor_centavos <= 0 or new.lancamento_id is null then
    raise exception 'Financeiro v2: o encargo é um ajuste positivo de conta a pagar, com seu lançamento.' using errcode = '42501';
  end if;
  select x.* into o from fv2_obrigacao x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.alvo_id;
  select x.* into l from fv2_lancamento x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.lancamento_id;
  if o.id is null or l.id is null or l.categoria_codigo <> 'JUROS_E_MULTAS_DE_FORNECEDORES' or l.valor_centavos <> new.valor_centavos then
    raise exception 'Financeiro v2: o encargo aponta para a conta e para o lançamento de juros e multas com o mesmo valor.' using errcode = '42501';
  end if;
  if new.valor_centavos * 10 > o.valor_base_centavos then
    raise exception 'Financeiro v2: encargo acima de 10%% do valor da conta exige uma pessoa autorizada.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_lancamento_juros before insert on fv2_lancamento for each row execute function fv2_juros_documental();
create trigger fv2_ajuste_juros before insert on fv2_ajuste for each row execute function fv2_juros_documental();

-- 4) O gatilho da 0030 (quem só registra obrigação) não pode barrar o lançamento do ENCARGO de quem também tem `registrar_juros`:
--    esse caso é conferido pelo gatilho acima.
create or replace function fv2_obrigacao_documental() returns trigger language plpgsql as $$
declare
  l record;
  xid_atual text := (pg_current_xact_id()::text::bigint % 4294967296)::text;
begin
  if not fv2_so_registra_obrigacao() then
    return new;
  end if;
  if tg_table_name = 'fv2_lancamento' then
    if new.origem->>'tipo' = 'AJUSTE' and fv2_tem_acao(array['financeiro_v2.registrar_juros']) then
      return new; -- encargo do pagamento (0031): forma conferida por fv2_juros_documental
    end if;
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

-- 5) A barreira da 0018 (quem não tem ações amplas só muda a POSIÇÃO da conta) ganha UMA exceção estreita: com `registrar_juros`, a
--    conta pode receber o ajuste do encargo — `ajustes_centavos` e `saldo_centavos` sobem, na MESMA transação do registro de ajuste
--    (a soma dos ajustes da conta precisa bater, como na 0010), sem reduzir, sem trocar a situação e sem mudar mais nada.
create or replace function fv2_vinculo_extrato_posicao() returns trigger language plpgsql as $$
declare
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por', 'extras'] || tg_argv[0]::text[];
  soma bigint;
  so_encargo boolean := false;
begin
  if not fv2_so_vincula() then
    return new;
  end if;
  if tg_table_name = 'fv2_obrigacao' and fv2_tem_acao(array['financeiro_v2.registrar_juros'])
     and (to_jsonb(new)->>'ajustes_centavos') is distinct from (to_jsonb(old)->>'ajustes_centavos') then
    select coalesce(sum(a.valor_centavos), 0) into soma from fv2_ajuste a
     where a.organizacao_id = new.organizacao_id and a.unidade_id = new.unidade_id and a.alvo_id = new.id;
    if soma <> (to_jsonb(new)->>'ajustes_centavos')::bigint
       or (to_jsonb(new)->>'ajustes_centavos')::bigint < (to_jsonb(old)->>'ajustes_centavos')::bigint
       or new.situacao is distinct from old.situacao then
      raise exception 'Financeiro v2: o encargo só soma à conta o ajuste registrado com ele, sem reduzir nem mudar a situação.' using errcode = '42501';
    end if;
    livres := livres || array['ajustes_centavos', 'saldo_centavos'];
    so_encargo := true;
  end if;
  if (to_jsonb(old) - livres) is distinct from (to_jsonb(new) - livres) then
    raise exception 'Financeiro v2: vincular pagamento do extrato só muda a posição (alocado/pago/saldo), nada mais.' using errcode = '42501';
  end if;
  if (to_jsonb(new)->>tg_argv[1])::bigint < (to_jsonb(old)->>tg_argv[1])::bigint then
    raise exception 'Financeiro v2: vincular pagamento do extrato não desfaz baixas (use o estorno, com a permissão própria).' using errcode = '42501';
  end if;
  -- Na conta, a situação resultante de uma baixa só pode ser parcial ou quitada (nunca cancelar ou reabrir); o encargo não muda a situação.
  if tg_table_name = 'fv2_obrigacao' and not so_encargo and (to_jsonb(new)->>'situacao') not in ('PARCIAL', 'QUITADA') then
    raise exception 'Financeiro v2: vincular pagamento do extrato só deixa a conta parcial ou quitada.' using errcode = '42501';
  end if;
  return new;
end $$;
