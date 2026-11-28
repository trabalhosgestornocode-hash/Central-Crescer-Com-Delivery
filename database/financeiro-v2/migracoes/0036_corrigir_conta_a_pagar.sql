-- =====================================================================================================================
-- Financeiro v2 — migração 0036: CORREÇÃO CADASTRAL DE CONTA A PAGAR com ação ESTREITA — MOVA Operador Financeiro (28/11/2026)
--
-- Espelho de economico.corrigirContaAPagar. Ação nova `financeiro_v2.corrigir_conta_a_pagar` (MIGRAÇÃO RESTRITIVA: nenhuma
-- concessão existente a recebe). Quem SÓ tem esta ação (sem registrar/aplicar/corrigir/cancelar/conciliar) altera numa conta a pagar
-- APENAS: fornecedor (contraparte_id), vencimento, descrição e, em `extras`, `observacao` e `formaPagamento`. E só quando:
--   * a conta está ABERTA, sem nenhum pagamento (liquidado 0);
--   * o lançamento da conta está ATIVO e é de DESPESA (ou PATRIMONIAL só em IMOBILIZADO). Empréstimo, parcelamento tributário,
--     operações entre empresas e qualquer outra patrimonial ficam FORA (têm proteções próprias);
--   * a competência da conta aceita a correção estreita (ABERTA ou FECHAMENTO_PRELIMINAR; com pendências ou homologada, nunca).
-- No lançamento, só a DESCRIÇÃO, e só quando TODAS as parcelas do grupo cumprem as mesmas condições. Valor, competência, categoria,
-- situação, parcelas e posição nunca mudam por esta ação. Pode incluir fornecedor novo (cadastro) e o histórico da correção.
--
-- Achado da auditoria (28/11): `extras` era coluna LIVRE na barreira de quem só baixa/vincula (0018/0031); essa identidade podia
-- reescrever `observacao`/`formaPagamento`. Agora quem só muda a POSIÇÃO não altera essas duas chaves.
-- Políticas ampliadas a partir da expressão ATUAL (pg_policy), sem reescrever as regras das migrações anteriores.
-- =====================================================================================================================

-- 1) Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao",
  "financeiro_v2.reabrir", "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento",
  "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao", "financeiro_v2.registrar_juros",
  "financeiro_v2.prestar_sangria", "financeiro_v2.registrar_conta_parcelada", "financeiro_v2.registrar_intercompany",
  "financeiro_v2.registrar_emprestimo", "financeiro_v2.corrigir_conta_a_pagar"]'::jsonb);

-- 2) Políticas: acrescenta a ação às expressões ATUAIS (USING de alteração para alcançar as linhas; WITH CHECK do que grava).
do $$
declare
  r record;
  expr text;
begin
  for r in select * from (values
      ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'using'),
      ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'check'),
      ('fv2_lancamento', 'fv2_lancamento_alterar', 'using'),
      ('fv2_lancamento', 'fv2_lancamento_alterar', 'check'),
      ('fv2_contraparte', 'fv2_contraparte_incluir', 'check'),
      ('fv2_historico', 'fv2_historico_incluir', 'check')
    ) as v(tabela, politica, parte) loop
    select case r.parte when 'using' then pg_get_expr(p.polqual, p.polrelid) else pg_get_expr(p.polwithcheck, p.polrelid) end into expr
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = current_schema() and c.relname = r.tabela and p.polname = r.politica;
    if expr is null then
      raise exception 'Financeiro v2 0036: política %.% (%) não encontrada.', r.tabela, r.politica, r.parte;
    end if;
    execute format('alter policy %I on %I %s ((%s) or (select fv2_tem_acao(array[%L])))', r.politica, r.tabela,
      case r.parte when 'using' then 'using' else 'with check' end, expr, 'financeiro_v2.corrigir_conta_a_pagar');
  end loop;
end $$;

-- 3) Quem corrige SEM ação ampla.
create or replace function fv2_so_corrige_conta() returns boolean language sql stable as $$
  select not (select rolsuper from pg_roles where rolname = current_user)
     and fv2_tem_acao(array['financeiro_v2.corrigir_conta_a_pagar'])
     and not fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar'])
$$;

-- A conta (e o seu grupo) aceita a correção estreita? Aberta, sem pagamento, lançamento ativo de despesa/imobilizado, competência editável.
create or replace function fv2_conta_corrigivel(p_org uuid, p_unidade uuid, p_obrigacao uuid) returns boolean language sql stable as $$
  select exists (
    select 1 from fv2_obrigacao o join fv2_lancamento l on l.organizacao_id = o.organizacao_id and l.unidade_id = o.unidade_id and l.id = o.lancamento_id
     where o.organizacao_id = p_org and o.unidade_id = p_unidade and o.id = p_obrigacao
       and o.situacao = 'ABERTA' and o.liquidado_centavos = 0
       and l.situacao = 'ATIVO' and l.origem->>'tipo' = 'OBRIGACAO'
       and (l.natureza = 'DESPESA' or (l.natureza = 'PATRIMONIAL' and l.categoria_codigo = 'IMOBILIZADO'))
       and coalesce((select c.estado from fv2_competencia c where c.organizacao_id = o.organizacao_id and c.unidade_id = o.unidade_id and c.competencia = o.competencia), 'ABERTA')
           in ('ABERTA', 'FECHAMENTO_PRELIMINAR'))
$$;

-- 4) A forma da correção (conta): só as colunas cadastrais; em `extras`, só observacao/formaPagamento; conta elegível ANTES da mudança.
create or replace function fv2_correcao_de_conta() returns trigger language plpgsql as $$
declare
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por', 'contraparte_id', 'vencimento', 'descricao', 'extras'];
begin
  if not fv2_so_corrige_conta() then
    return new;
  end if;
  if (to_jsonb(old) - array['versao', 'atualizado_em', 'atualizado_por']) is not distinct from (to_jsonb(new) - array['versao', 'atualizado_em', 'atualizado_por']) then
    return new;
  end if;
  if (to_jsonb(old) - livres) is distinct from (to_jsonb(new) - livres)
     or (coalesce(old.extras, '{}'::jsonb) - array['observacao', 'formaPagamento']) is distinct from (coalesce(new.extras, '{}'::jsonb) - array['observacao', 'formaPagamento']) then
    raise exception 'Financeiro v2: a correção estreita muda só fornecedor, vencimento, descrição, observação e forma de pagamento.' using errcode = '42501';
  end if;
  if new.extras ? 'formaPagamento' and new.extras->>'formaPagamento' is not null
     and new.extras->>'formaPagamento' not in ('CARTAO', 'BOLETO', 'PIX', 'DINHEIRO', 'TRANSFERENCIA') then
    raise exception 'Financeiro v2: forma de pagamento inválida.' using errcode = '42501';
  end if;
  if not fv2_conta_corrigivel(old.organizacao_id, old.unidade_id, old.id) then
    raise exception 'Financeiro v2: só se corrige conta a pagar aberta, sem pagamento, de despesa (ou equipamento) e de período editável.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_obrigacao_correcao_estreita before update on fv2_obrigacao for each row execute function fv2_correcao_de_conta();

-- 5) A forma da correção (lançamento): só a descrição, e só com TODAS as parcelas do grupo elegíveis.
create or replace function fv2_correcao_de_lancamento() returns trigger language plpgsql as $$
begin
  if not fv2_so_corrige_conta() then
    return new;
  end if;
  if (to_jsonb(old) - array['versao', 'atualizado_em', 'atualizado_por', 'descricao']) is distinct from (to_jsonb(new) - array['versao', 'atualizado_em', 'atualizado_por', 'descricao']) then
    raise exception 'Financeiro v2: a correção estreita muda no lançamento só a descrição.' using errcode = '42501';
  end if;
  if old.origem->>'tipo' <> 'OBRIGACAO' or exists (
       select 1 from fv2_obrigacao o where o.organizacao_id = old.organizacao_id and o.unidade_id = old.unidade_id and o.lancamento_id = old.id
          and not fv2_conta_corrigivel(o.organizacao_id, o.unidade_id, o.id))
     or not exists (select 1 from fv2_obrigacao o where o.organizacao_id = old.organizacao_id and o.unidade_id = old.unidade_id and o.lancamento_id = old.id) then
    raise exception 'Financeiro v2: a descrição do lançamento só muda com todas as parcelas da conta abertas e sem pagamento.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_lancamento_correcao_estreita before update on fv2_lancamento for each row execute function fv2_correcao_de_lancamento();

-- 6) Barreira da 0018/0031 (quem não tem ações amplas só muda a POSIÇÃO): a correção estreita passa (conferida no item 4) e,
--    na posição, `extras.observacao`/`extras.formaPagamento` deixam de ser livres (achado da auditoria).
create or replace function fv2_vinculo_extrato_posicao() returns trigger language plpgsql as $$
declare
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por', 'extras'] || tg_argv[0]::text[];
  soma bigint;
  so_encargo boolean := false;
begin
  if not fv2_so_vincula() then
    return new;
  end if;
  -- 0036: correção cadastral estreita (nenhuma coluna de posição muda; a forma é conferida por fv2_correcao_de_conta)
  if tg_table_name = 'fv2_obrigacao' and fv2_so_corrige_conta()
     and (to_jsonb(old)->>'liquidado_centavos') is not distinct from (to_jsonb(new)->>'liquidado_centavos')
     and (to_jsonb(old)->>'saldo_centavos') is not distinct from (to_jsonb(new)->>'saldo_centavos')
     and (to_jsonb(old)->>'ajustes_centavos') is not distinct from (to_jsonb(new)->>'ajustes_centavos')
     and (to_jsonb(old)->>'situacao') is not distinct from (to_jsonb(new)->>'situacao') then
    return new;
  end if;
  -- 0036: quem só muda a posição não reescreve a observação nem a forma de pagamento da conta
  if tg_table_name = 'fv2_obrigacao'
     and ((to_jsonb(old)->'extras'->'observacao') is distinct from (to_jsonb(new)->'extras'->'observacao')
       or (to_jsonb(old)->'extras'->'formaPagamento') is distinct from (to_jsonb(new)->'extras'->'formaPagamento')) then
    raise exception 'Financeiro v2: a baixa não altera a observação nem a forma de pagamento da conta.' using errcode = '42501';
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
  if tg_table_name = 'fv2_obrigacao' and not so_encargo and (to_jsonb(new)->>'situacao') not in ('PARCIAL', 'QUITADA') then
    raise exception 'Financeiro v2: vincular pagamento do extrato só deixa a conta parcial ou quitada.' using errcode = '42501';
  end if;
  return new;
end $$;

-- 7) Barreira de ações do lançamento (0014): IDÊNTICA, com `corrigir_conta_a_pagar` na lista de quem altera sem mudar a categoria.
--    O que essa ação pode mudar no lançamento (só a descrição, com todas as parcelas elegíveis) é conferido no item 5.
create or replace function fv2_exigir_acao_do_lancamento() returns trigger language plpgsql as $$
declare
  cat record;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  if (new.categoria_id, new.categoria_codigo, new.classificacao, new.natureza)
       is not distinct from (old.categoria_id, old.categoria_codigo, old.classificacao, old.natureza) then
    -- Sem mudança de categoria: as ações de sempre (0036: + corrigir_conta_a_pagar, limitada à DESCRIÇÃO por fv2_correcao_de_lancamento). `reclassificar` sozinho não muda valor nem cancela.
    if not fv2_tem_acao(array['financeiro_v2.cancelar', 'financeiro_v2.corrigir', 'financeiro_v2.revisar', 'financeiro_v2.corrigir_conta_a_pagar']) then
      raise exception 'Financeiro v2: alterar o lançamento exige cancelar, corrigir ou revisar.' using errcode = '42501';
    end if;
    return new;
  end if;
  if not fv2_tem_acao(array['financeiro_v2.reclassificar']) then
    raise exception 'Financeiro v2: mudar a categoria de um lançamento exige reclassificar.' using errcode = '42501';
  end if;
  if old.situacao <> 'ATIVO' then
    raise exception 'Financeiro v2: lançamento cancelado não é reclassificado.' using errcode = 'FV037';
  end if;
  if (new.valor_centavos, new.moeda, new.competencia, new.situacao, new.data_operacao, new.descricao, new.origem, new.canal,
      new.retido_no_repasse, new.fonte_sistema, new.fonte_id_externo)
       is distinct from (old.valor_centavos, old.moeda, old.competencia, old.situacao, old.data_operacao, old.descricao, old.origem, old.canal,
      old.retido_no_repasse, old.fonte_sistema, old.fonte_id_externo) then
    raise exception 'Financeiro v2: a reclassificação muda só a categoria — a identidade do fato econômico é preservada.' using errcode = 'FV037';
  end if;
  if not (new.natureza = old.natureza
          or (old.origem->>'tipo' = 'OBRIGACAO' and old.natureza in ('DESPESA', 'PATRIMONIAL') and new.natureza in ('DESPESA', 'PATRIMONIAL'))) then
    raise exception 'Financeiro v2: natureza econômica incompatível na reclassificação.' using errcode = 'FV038';
  end if;
  if new.categoria_codigo in ('DESCONTOS_A_CLASSIFICAR', 'DESPESAS_A_CLASSIFICAR') then
    raise exception 'Financeiro v2: categoria provisória não é destino de reclassificação.' using errcode = 'FV038';
  end if;
  select c.codigo, c.natureza, c.classificacao, c.aceita_lancamento, c.ativa into cat
    from fv2_categoria c where c.id = new.categoria_id and c.organizacao_id = new.organizacao_id and c.unidade_id = new.unidade_id;
  if cat.codigo is null or cat.codigo <> new.categoria_codigo or cat.natureza <> new.natureza or cat.classificacao <> new.classificacao
     or not cat.aceita_lancamento or not cat.ativa then
    raise exception 'Financeiro v2: a categoria de destino não confere com o plano de contas da unidade.' using errcode = 'FV038';
  end if;
  return new;
end $$;
