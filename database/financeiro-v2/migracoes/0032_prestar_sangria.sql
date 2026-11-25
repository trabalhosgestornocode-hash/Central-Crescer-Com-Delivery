-- =====================================================================================================================
-- Financeiro v2 — migração 0032: PRESTAÇÃO DE CONTAS DA SANGRIA com ação ESTREITA — MOVA CORE (25/11/2026)
--
-- Espelho de aplicacao/prestacaoDeSangria.js. Ação nova `financeiro_v2.prestar_sangria` (MIGRAÇÃO RESTRITIVA: nenhuma
-- concessão existente a recebe). Quem a tem SEM ação ampla (registrar/aplicar/corrigir/cancelar/conciliar/revisar) grava SÓ:
--   * DESPESA paga com o dinheiro de uma sangria EXISTENTE: um lançamento de DESPESA + a conta de UMA parcela criados juntos e
--     a liquidação dessa conta CONTRA A PRÓPRIA SAÍDA DA SANGRIA (saída do caixa físico registrada como SANGRIA numa sessão);
--   * TROCO devolvido: UMA entrada (natureza OUTRA) no caixa físico e a operação ENTRADA acrescentada à sessão de caixa;
--   * a posição da sangria (alocado e o registro da prestação em `extras.prestacaoSangria`) e a da conta (pago/saldo/situação);
--   * a contraparte nova do formulário, o histórico e o vínculo documental dessa operação.
-- Nada de pagamento, transferência, saída nova, receita, alteração de outra movimentação/conta/sessão ou de outros campos.
-- Políticas AMPLIADAS a partir da expressão atual (pg_policy). Reversão: recuperacao/reverter-0032.sql.
-- =====================================================================================================================

-- 1) Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento",
  "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao", "financeiro_v2.registrar_juros",
  "financeiro_v2.prestar_sangria"]'::jsonb);

-- 2) Políticas: acrescenta a ação às expressões ATUAIS (USING de alteração para alcançar as linhas; WITH CHECK do que grava).
do $$
declare
  r record;
  expr text;
begin
  for r in select * from (values
      ('fv2_lancamento', 'fv2_lancamento_incluir', 'check'),
      ('fv2_obrigacao', 'fv2_obrigacao_incluir', 'check'),
      ('fv2_contraparte', 'fv2_contraparte_incluir', 'check'),
      ('fv2_liquidacao', 'fv2_liquidacao_incluir', 'check'),
      ('fv2_movimentacao', 'fv2_movimentacao_incluir', 'check'),
      ('fv2_movimentacao', 'fv2_movimentacao_alterar', 'using'),
      ('fv2_movimentacao', 'fv2_movimentacao_alterar', 'check'),
      ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'using'),
      ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'check'),
      ('fv2_sessao_caixa', 'fv2_sessao_caixa_alterar', 'using'),
      ('fv2_sessao_caixa', 'fv2_sessao_caixa_alterar', 'check'),
      ('fv2_vinculo_documental', 'fv2_vinculo_documental_incluir', 'check'),
      ('fv2_historico', 'fv2_historico_incluir', 'check')
    ) as v(tabela, politica, parte) loop
    select case when r.parte = 'using' then pg_get_expr(p.polqual, p.polrelid) else pg_get_expr(p.polwithcheck, p.polrelid) end into expr
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = current_schema() and c.relname = r.tabela and p.polname = r.politica;
    if expr is null then
      raise exception 'Financeiro v2 0032: política %.% (%) não encontrada.', r.tabela, r.politica, r.parte;
    end if;
    execute format('alter policy %I on %I %s ((%s) or (select fv2_tem_acao(array[%L])))', r.politica, r.tabela,
      case when r.parte = 'using' then 'using' else 'with check' end, expr, 'financeiro_v2.prestar_sangria');
  end loop;
end $$;

-- 3) Quem SÓ presta contas de sangria (sem ação ampla): o banco confere a forma de tudo o que é gravado.
create or replace function fv2_so_presta_sangria() returns boolean language sql stable as $$
  select not (select rolsuper from pg_roles where rolname = current_user)
     and fv2_tem_acao(array['financeiro_v2.prestar_sangria'])
     and not fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar', 'financeiro_v2.revisar'])
$$;

-- Saída do caixa físico registrada como SANGRIA numa sessão de caixa da unidade.
create or replace function fv2_e_saida_de_sangria(p_org uuid, p_uni uuid, p_mov uuid) returns boolean language sql stable as $$
  select exists (
    select 1 from fv2_movimentacao m join fv2_conta c on c.organizacao_id = m.organizacao_id and c.unidade_id = m.unidade_id and c.id = m.conta_id
     where m.organizacao_id = p_org and m.unidade_id = p_uni and m.id = p_mov
       and m.sentido = 'SAIDA' and c.tipo = 'CAIXA_FISICO' and m.transferencia_id is null and m.pagamento_id is null and m.estorno_id is null
       and exists (select 1 from fv2_sessao_caixa s, jsonb_array_elements(s.operacoes) o
                    where s.organizacao_id = p_org and s.unidade_id = p_uni and s.conta_id = m.conta_id
                      and o->>'operacao' = 'SANGRIA' and o->>'movimentacaoId' = p_mov::text))
$$;

create or replace function fv2_prestacao_de_sangria() returns trigger language plpgsql as $$
declare
  xid_atual text := (pg_current_xact_id()::text::bigint % 4294967296)::text;
  l record;
  o record;
  tipo_conta text;
  ultima jsonb;
begin
  if not fv2_so_presta_sangria() then
    return new;
  end if;
  if tg_table_name = 'fv2_lancamento' then
    if new.natureza <> 'DESPESA' or new.situacao <> 'ATIVO' or new.valor_centavos <= 0 or new.origem->>'tipo' <> 'OBRIGACAO' or new.retido_no_repasse then
      raise exception 'Financeiro v2: na prestação de sangria só se registra lançamento de DESPESA nascido da conta paga com a retirada.' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_table_name = 'fv2_obrigacao' then
    if (new.parcela->>'total')::int <> 1 or new.recorrencia is not null or new.situacao <> 'ABERTA' or new.liquidado_centavos <> 0 or new.ajustes_centavos <> 0 then
      raise exception 'Financeiro v2: a despesa da sangria tem uma parcela, sem repetição, e nasce em aberto.' using errcode = '42501';
    end if;
    select x.*, x.xmin::text as criado_em_xid into l from fv2_lancamento x
     where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.lancamento_id;
    if not found or l.criado_em_xid <> xid_atual or l.origem->>'id' <> new.grupo_id::text or l.valor_centavos <> new.valor_base_centavos then
      raise exception 'Financeiro v2: a despesa da sangria aponta para o lançamento criado com ela (mesma transação e valor).' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_table_name = 'fv2_liquidacao' then
    if new.movimentacao_id is null or new.alvo_tipo <> 'OBRIGACAO' or not fv2_e_saida_de_sangria(new.organizacao_id, new.unidade_id, new.movimentacao_id) then
      raise exception 'Financeiro v2: na prestação de sangria a conta é liquidada só contra a PRÓPRIA saída da sangria.' using errcode = '42501';
    end if;
    select x.xmin::text as criado_em_xid into o from fv2_obrigacao x
     where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.alvo_id;
    if not found or o.criado_em_xid <> xid_atual then
      raise exception 'Financeiro v2: a sangria só paga a despesa registrada na mesma operação (nunca uma conta existente).' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_table_name = 'fv2_movimentacao' then
    if tg_op = 'INSERT' then
      select c.tipo into tipo_conta from fv2_conta c where c.organizacao_id = new.organizacao_id and c.unidade_id = new.unidade_id and c.id = new.conta_id;
      if new.sentido <> 'ENTRADA' or new.natureza <> 'OUTRA' or tipo_conta is distinct from 'CAIXA_FISICO' or new.valor_centavos <= 0
         or new.transferencia_id is not null or new.pagamento_id is not null or new.estorno_id is not null or new.alocado_centavos <> 0 then
        raise exception 'Financeiro v2: na prestação de sangria só entra o TROCO devolvido ao caixa físico.' using errcode = '42501';
      end if;
      return new;
    end if;
    -- UPDATE: só a própria saída da sangria, só a posição e o registro da prestação
    if not fv2_e_saida_de_sangria(old.organizacao_id, old.unidade_id, old.id)
       or (to_jsonb(old) - array['versao', 'atualizado_em', 'atualizado_por', 'extras', 'alocado_centavos']) is distinct from (to_jsonb(new) - array['versao', 'atualizado_em', 'atualizado_por', 'extras', 'alocado_centavos'])
       or (coalesce(old.extras, '{}'::jsonb) - 'prestacaoSangria') is distinct from (coalesce(new.extras, '{}'::jsonb) - 'prestacaoSangria')
       or new.alocado_centavos < old.alocado_centavos then
      raise exception 'Financeiro v2: a prestação de sangria só atualiza a posição da própria retirada.' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_table_name = 'fv2_sessao_caixa' then
    -- só acrescenta UMA operação ENTRADA (o troco) ligada a uma entrada criada nesta mesma transação; nada mais muda
    if jsonb_array_length(new.operacoes) <> jsonb_array_length(old.operacoes) + 1
       or (new.operacoes - (jsonb_array_length(new.operacoes) - 1)) is distinct from old.operacoes
       or (to_jsonb(old) - array['versao', 'atualizado_em', 'atualizado_por', 'operacoes']) is distinct from (to_jsonb(new) - array['versao', 'atualizado_em', 'atualizado_por', 'operacoes']) then
      raise exception 'Financeiro v2: a prestação de sangria só acrescenta o troco à sessão de caixa.' using errcode = '42501';
    end if;
    ultima := new.operacoes -> (jsonb_array_length(new.operacoes) - 1);
    if ultima->>'operacao' <> 'ENTRADA' or not exists (
         select 1 from fv2_movimentacao m where m.organizacao_id = new.organizacao_id and m.unidade_id = new.unidade_id and m.id::text = ultima->>'movimentacaoId'
            and m.conta_id = new.conta_id and m.sentido = 'ENTRADA' and m.xmin::text = xid_atual) then
      raise exception 'Financeiro v2: o troco acrescentado à sessão precisa ser a entrada registrada nesta operação.' using errcode = '42501';
    end if;
    return new;
  end if;
  return new;
end $$;
create trigger fv2_lancamento_sangria before insert on fv2_lancamento for each row execute function fv2_prestacao_de_sangria();
create trigger fv2_obrigacao_sangria before insert on fv2_obrigacao for each row execute function fv2_prestacao_de_sangria();
create trigger fv2_liquidacao_sangria before insert on fv2_liquidacao for each row execute function fv2_prestacao_de_sangria();
create trigger fv2_movimentacao_sangria before insert or update on fv2_movimentacao for each row execute function fv2_prestacao_de_sangria();
create trigger fv2_sessao_caixa_sangria before update on fv2_sessao_caixa for each row execute function fv2_prestacao_de_sangria();

-- 4) Pagamento por comprovante (0029): quem só baixa por comprovante continua sem gravar liquidação com saída bancária; a
--    liquidação contra a saída da SANGRIA é a exceção de quem tem `prestar_sangria` (forma conferida pelo gatilho acima).
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
      if so_documental and not fv2_so_presta_sangria() then
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

-- 5) Vínculo de extrato (0018): quem só vincula continua sem liquidar fora do extrato; a liquidação contra a saída da SANGRIA é a
--    exceção de quem só presta contas de sangria (forma conferida pelo gatilho do item 3).
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
  if fv2_so_presta_sangria() and fv2_e_saida_de_sangria(new.organizacao_id, new.unidade_id, new.movimentacao_id) then
    return new; -- prestação de contas da sangria (0032): forma conferida por fv2_prestacao_de_sangria
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
