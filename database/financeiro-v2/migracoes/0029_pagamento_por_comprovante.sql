-- =====================================================================================================================
-- Financeiro v2 — migração 0029: PAGAMENTO POR COMPROVANTE × CONCILIAÇÃO COM O EXTRATO — Execução 17
--
-- Espelho de aplicacao/baixaPorComprovante.js. Duas dimensões independentes:
--   * PAGAMENTO registrado por COMPROVANTE: liquidação de conta a pagar SEM movimentação bancária (movimentacao_id nulo),
--     marcada `extras.origemDoVinculo = 'COMPROVANTE'` e com `extras.documentoId` de um documento COMPROVANTE da unidade.
--     Nenhuma saída é inventada: saldo de banco e fluxo realizado só mudam quando o extrato chega.
--   * CONCILIAÇÃO: a saída do extrato é LIGADA à mesma liquidação (movimentacao_id passa de nulo para a saída, uma única
--     vez, sem mudar valor, conta ou data). Nunca segunda liquidação, segunda saída ou despesa.
-- Ação nova `financeiro_v2.baixar_por_comprovante` (MIGRAÇÃO RESTRITIVA: nenhuma concessão existente a recebe). Conciliar
-- usa `financeiro_v2.vincular_pagamento` (0018). Quem só baixa por comprovante NÃO grava liquidação com saída, nem
-- movimentação, lançamento ou conta nova.
-- Políticas são AMPLIADAS a partir da expressão atual (pg_policy), sem reescrever as regras das migrações anteriores.
-- =====================================================================================================================

-- 1) Liquidação sem movimentação: só pagamento por comprovante de conta a pagar, com documento.
alter table fv2_liquidacao alter column movimentacao_id drop not null;
alter table fv2_liquidacao add constraint fv2_liquidacao_sem_movimentacao check (
  movimentacao_id is not null
  or (alvo_tipo = 'OBRIGACAO' and extras->>'origemDoVinculo' = 'COMPROVANTE' and (extras->>'documentoId') is not null));

-- 2) Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento",
  "financeiro_v2.baixar_por_comprovante"]'::jsonb);

-- 3) Políticas: acrescenta a ação às expressões ATUAIS (USING de alteração para alcançar as linhas; WITH CHECK do que grava).
do $$
declare
  r record;
  expr text;
begin
  for r in select * from (values
      ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'using', 'baixar_por_comprovante'),
      ('fv2_liquidacao', 'fv2_liquidacao_alterar', 'using', 'baixar_por_comprovante'),
      ('fv2_movimentacao', 'fv2_movimentacao_alterar', 'using', 'baixar_por_comprovante'),
      ('fv2_documento', 'fv2_documento_alterar', 'using', 'baixar_por_comprovante'),
      ('fv2_liquidacao', 'fv2_liquidacao_incluir', 'check', 'baixar_por_comprovante'),
      ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'check', 'baixar_por_comprovante'),
      ('fv2_vinculo_documental', 'fv2_vinculo_documental_incluir', 'check', 'baixar_por_comprovante'),
      ('fv2_historico', 'fv2_historico_incluir', 'check', 'baixar_por_comprovante'),
      -- conciliar o pagamento por comprovante = ligar a saída à liquidação existente (alteração da liquidação)
      ('fv2_liquidacao', 'fv2_liquidacao_alterar', 'check', 'vincular_pagamento')
    ) as v(tabela, politica, parte, acao) loop
    select case r.parte when 'using' then pg_get_expr(p.polqual, p.polrelid) else pg_get_expr(p.polwithcheck, p.polrelid) end into expr
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = current_schema() and c.relname = r.tabela and p.polname = r.politica;
    if expr is null then
      raise exception 'Financeiro v2 0029: política %.% (%) não encontrada.', r.tabela, r.politica, r.parte;
    end if;
    execute format('alter policy %I on %I %s ((%s) or (select fv2_tem_acao(array[%L])))', r.politica, r.tabela,
      case r.parte when 'using' then 'using' else 'with check' end, expr, 'financeiro_v2.' || r.acao);
  end loop;
end $$;

-- 4) A barreira da 0018 (quem só vincula) não se aplica à liquidação SEM movimentação: essa é tratada abaixo.
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

-- 5) Pagamento por comprovante e sua conciliação, para QUALQUER gravador (exceto o superusuário de manutenção).
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
  -- UPDATE
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
  -- Quem só vincula (ou só baixa por comprovante) não altera liquidação por outro motivo.
  if fv2_so_vincula() and (to_jsonb(old) - array['versao', 'atualizado_em', 'atualizado_por']) is distinct from (to_jsonb(new) - array['versao', 'atualizado_em', 'atualizado_por']) then
    raise exception 'Financeiro v2: sem permissão para alterar esta liquidação além da conciliação.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_liquidacao_por_comprovante before insert or update on fv2_liquidacao for each row execute function fv2_pagamento_por_comprovante();

-- 6) Conservação (0001): a liquidação SEM movimentação só confere o título; com movimentação, também o alocado da saída.
create or replace function fv2_tg_liquidacao() returns trigger language plpgsql as $$
begin
  perform fv2_conferir_titulo(new.organizacao_id, new.unidade_id, new.alvo_tipo, new.alvo_id);
  if new.movimentacao_id is not null then
    perform fv2_conferir_movimentacao(new.organizacao_id, new.unidade_id, new.movimentacao_id);
  end if;
  return null;
end $$;
