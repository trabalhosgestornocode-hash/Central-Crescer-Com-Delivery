-- =====================================================================================================================
-- Financeiro v2 — migração 0034: OPERAÇÕES ENTRE EMPRESAS (intercompany) — MOVA (26/11/2026)
--
-- Espelho de aplicacao/intercompany.js. Caso real: a Subway Saci (MP ALIMENTOS) pagou R$ 6.495,60 à distribuidora pelo Açaí no Grau
-- Saci (AF PRODUTOS). Empresa PAGADORA e empresa BENEFICIÁRIA são dimensões diferentes:
--   * DEVEDORA (quem se beneficiou, ex.: Açaí): a conta do fornecedor é LIQUIDADA "paga por outra empresa" — liquidação SEM saída
--     bancária nesta empresa (`extras.origemDoVinculo = 'INTERCOMPANY'`) — e nasce o PASSIVO com a credora. A despesa é reconhecida
--     UMA vez (pela conta do fornecedor); nenhuma saída de banco ou caixa é inventada na devedora.
--   * CREDORA (quem pagou, ex.: Subway): nasce o ATIVO (a receber da devedora). A saída real é a do EXTRATO: ela só é LIGADA ao
--     ativo quando existe (nunca criada aqui) — não é despesa operacional da credora nem duplica a saída importada.
-- Os dois lados (um em cada escopo) compartilham UM vínculo (`vinculo_id`), gravados na MESMA transação do banco (a aplicação assume
-- a sessão de cada escopo em sequência). REEMBOLSO (parcial ou integral) liquida os dois lados; não é receita nem despesa.
-- Vencimento do reembolso é OPCIONAL (nunca inventado). Categoria contábil: OPERACOES_ENTRE_EMPRESAS (patrimonial; fora da DRE).
-- Ação nova `financeiro_v2.registrar_intercompany` (MIGRAÇÃO RESTRITIVA: nenhuma concessão existente a recebe).
-- Mesmas proteções das demais tabelas: escopo por empresa/unidade (RLS), sem exclusão, versão e histórico obrigatórios.
-- =====================================================================================================================

create table fv2_intercompany (
  seq                        bigint generated always as identity,
  id                         uuid not null primary key,
  organizacao_id             uuid not null,
  unidade_id                 uuid not null,
  versao                     integer not null check (versao >= 1),
  criado_em                  timestamptz not null,
  criado_por                 uuid not null,
  atualizado_em              timestamptz not null,
  atualizado_por             uuid not null,
  chave_idempotencia         text not null check (length(chave_idempotencia) between 1 and 400),
  impressao                  text,
  extras                     jsonb not null default '{}'::jsonb check (jsonb_typeof(extras) = 'object'),
  vinculo_id                 uuid not null,
  papel                      text not null check (papel in ('DEVEDORA', 'CREDORA')),
  contraparte_organizacao_id uuid not null,
  contraparte_unidade_id     uuid not null,
  contraparte_nome           text not null check (length(btrim(contraparte_nome)) between 1 and 200),
  descricao                  text not null check (length(btrim(descricao)) between 1 and 300),
  data_pagamento             date not null,
  valor_centavos             bigint not null check (valor_centavos > 0),
  reembolsado_centavos       bigint not null default 0 check (reembolsado_centavos >= 0),
  saldo_centavos             bigint not null,
  vencimento                 date,
  situacao                   text not null check (situacao in ('ABERTO', 'PARCIAL', 'LIQUIDADO')),
  obrigacao_id               uuid,
  movimentacao_id            uuid,
  documento_ids              uuid[] not null default '{}',
  liquidacoes                jsonb not null default '[]'::jsonb check (jsonb_typeof(liquidacoes) = 'array'),
  unique (organizacao_id, unidade_id, id),
  unique (organizacao_id, unidade_id, vinculo_id),
  check (reembolsado_centavos <= valor_centavos),
  check (saldo_centavos = valor_centavos - reembolsado_centavos),
  check (situacao = case when reembolsado_centavos = 0 then 'ABERTO' when reembolsado_centavos = valor_centavos then 'LIQUIDADO' else 'PARCIAL' end),
  check ((organizacao_id, unidade_id) <> (contraparte_organizacao_id, contraparte_unidade_id)),
  check (papel = 'DEVEDORA' or obrigacao_id is null),
  check (papel = 'CREDORA' or movimentacao_id is null),
  check (vencimento is null or vencimento >= data_pagamento),
  check (atualizado_em >= criado_em)
);
alter table fv2_intercompany add constraint fv2_intercompany_escopo_fk foreign key (organizacao_id, unidade_id) references fv2_escopo;
create unique index fv2_intercompany_chave_uq on fv2_intercompany (organizacao_id, unidade_id, chave_idempotencia);
-- uma conta do fornecedor só é paga por outra empresa UMA vez; uma saída do extrato só sustenta UM ativo intercompany
create unique index fv2_intercompany_obrigacao_uq on fv2_intercompany (organizacao_id, unidade_id, obrigacao_id) where obrigacao_id is not null;
create unique index fv2_intercompany_movimentacao_uq on fv2_intercompany (organizacao_id, unidade_id, movimentacao_id) where movimentacao_id is not null;
create index fv2_intercompany_vencimento on fv2_intercompany (organizacao_id, unidade_id, vencimento) where situacao <> 'LIQUIDADO';

create trigger fv2_intercompany_sem_delete before delete on fv2_intercompany for each row execute function fv2_proibir_exclusao();
create trigger fv2_intercompany_sem_truncate before truncate on fv2_intercompany for each statement execute function fv2_proibir_exclusao();
create trigger fv2_intercompany_versao before update on fv2_intercompany for each row execute function fv2_guardar_versao();
create constraint trigger fv2_intercompany_historico after insert or update on fv2_intercompany deferrable initially deferred
  for each row execute function fv2_exigir_historico('INTERCOMPANY');

-- O fato original é imutável: só o reembolso (posição + histórico de liquidações), o vencimento informado depois e a ligação da saída
-- do extrato (uma vez) mudam. O histórico de liquidações só CRESCE.
create function fv2_intercompany_imutavel() returns trigger language plpgsql as $$
declare
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por', 'extras', 'reembolsado_centavos', 'saldo_centavos', 'situacao', 'liquidacoes', 'vencimento', 'movimentacao_id'];
  m record;
  xid_atual text := (pg_current_xact_id()::text::bigint % 4294967296)::text;
begin
  if tg_op = 'INSERT' then
    if new.reembolsado_centavos <> 0 or jsonb_array_length(new.liquidacoes) <> 0 then
      raise exception 'FV2: a operação entre empresas nasce sem reembolso' using errcode = 'FV010';
    end if;
    if new.movimentacao_id is not null then
      select x.* into m from fv2_movimentacao x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.movimentacao_id;
      if not found or m.sentido <> 'SAIDA' or m.situacao <> 'VALIDA' or m.valor_centavos <> new.valor_centavos or m.xmin::text = xid_atual then
        raise exception 'FV2: só uma saída JÁ importada do extrato, válida e do mesmo valor, é ligada ao ativo entre empresas' using errcode = 'FV010';
      end if;
    end if;
    return new;
  end if;
  if (to_jsonb(old) - livres) is distinct from (to_jsonb(new) - livres) then
    raise exception 'FV2: o fato original da operação entre empresas não pode ser alterado' using errcode = 'FV010';
  end if;
  if new.reembolsado_centavos < old.reembolsado_centavos or jsonb_array_length(new.liquidacoes) < jsonb_array_length(old.liquidacoes)
     or coalesce((select jsonb_agg(e order by i) from jsonb_array_elements(new.liquidacoes) with ordinality t(e, i) where i <= jsonb_array_length(old.liquidacoes)), '[]'::jsonb) is distinct from old.liquidacoes
     or new.reembolsado_centavos <> coalesce((select sum((e->>'valorCentavos')::bigint) from jsonb_array_elements(new.liquidacoes) e), 0) then
    raise exception 'FV2: reembolso entre empresas só acrescenta liquidações (nada é apagado ou reescrito)' using errcode = 'FV010';
  end if;
  if old.movimentacao_id is not null and new.movimentacao_id is distinct from old.movimentacao_id then
    raise exception 'FV2: a saída do extrato ligada à operação entre empresas não se troca' using errcode = 'FV010';
  end if;
  if old.movimentacao_id is null and new.movimentacao_id is not null then
    select x.* into m from fv2_movimentacao x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.movimentacao_id;
    if not found or m.sentido <> 'SAIDA' or m.situacao <> 'VALIDA' or m.valor_centavos <> new.valor_centavos or m.xmin::text = xid_atual then
      raise exception 'FV2: só uma saída JÁ importada do extrato, válida e do mesmo valor, é ligada ao ativo entre empresas' using errcode = 'FV010';
    end if;
  end if;
  return new;
end $$;
create trigger fv2_intercompany_fato before insert or update on fv2_intercompany for each row execute function fv2_intercompany_imutavel();

alter table fv2_intercompany enable row level security;
alter table fv2_intercompany force row level security;
create policy fv2_intercompany_escopo on fv2_intercompany
  using (organizacao_id = (select fv2_org()) and unidade_id = (select fv2_uni()))
  with check (organizacao_id = (select fv2_org()) and unidade_id = (select fv2_uni()));
create policy fv2_intercompany_ler on fv2_intercompany as restrictive for select using ((select fv2_sessao_operacional()));
create policy fv2_intercompany_incluir on fv2_intercompany as restrictive for insert with check ((select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.registrar_intercompany'])));
create policy fv2_intercompany_alterar on fv2_intercompany as restrictive for update
  using ((select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.registrar_intercompany'])))
  with check ((select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.registrar_intercompany'])));
grant select, insert, update on fv2_intercompany to fv2_app;

create or replace function fv2_tabela_do_tipo(p_tipo text) returns regclass language sql immutable as $$
  select case p_tipo
    when 'CONTA' then 'fv2_conta' when 'CONTRAPARTE' then 'fv2_contraparte' when 'CATEGORIA' then 'fv2_categoria'
    when 'LANCAMENTO' then 'fv2_lancamento' when 'VENDA' then 'fv2_venda' when 'PAGAMENTO_VENDA' then 'fv2_pagamento_venda'
    when 'OBRIGACAO' then 'fv2_obrigacao' when 'RECEBIVEL' then 'fv2_recebivel' when 'MOVIMENTACAO' then 'fv2_movimentacao'
    when 'LIQUIDACAO' then 'fv2_liquidacao' when 'TRANSFERENCIA' then 'fv2_transferencia' when 'AJUSTE' then 'fv2_ajuste'
    when 'ESTORNO' then 'fv2_estorno' when 'DOCUMENTO' then 'fv2_documento' when 'VINCULO_DOCUMENTAL' then 'fv2_vinculo_documental'
    when 'CORRESPONDENCIA' then 'fv2_correspondencia' when 'COMPETENCIA' then 'fv2_competencia'
    when 'IMPORTACAO' then 'fv2_importacao' when 'REGISTRO_FONTE' then 'fv2_registro_fonte' when 'CONCESSAO' then 'fv2_concessao'
    when 'PROPOSTA' then 'fv2_proposta' when 'DIVERGENCIA_FONTE' then 'fv2_divergencia_fonte'
    when 'SALDO_CONTA' then 'fv2_saldo_conta' when 'SESSAO_CAIXA' then 'fv2_sessao_caixa'
    when 'VERSAO_FECHAMENTO' then 'fv2_versao_fechamento' when 'ATRIBUICAO_PENDENCIA' then 'fv2_atribuicao_pendencia'
    when 'CANAL_PROCESSADOR' then 'fv2_canal_processador' when 'CONFIGURACAO_UNIDADE' then 'fv2_configuracao_unidade'
    when 'ABERTURA' then 'fv2_abertura' when 'FECHAMENTO_CAIXA' then 'fv2_fechamento_caixa'
    when 'SEMANA_ENTREGADORES' then 'fv2_semana_entregadores' when 'FECHAMENTO_ENTREGADOR' then 'fv2_fechamento_entregador'
    when 'EXTRA_ENTREGADOR' then 'fv2_extra_entregador' when 'INTERCOMPANY' then 'fv2_intercompany'
  end::regclass
$$;

-- Catálogo do banco.
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar",
  "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar",
  "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir",
  "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento",
  "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao", "financeiro_v2.registrar_juros",
  "financeiro_v2.prestar_sangria", "financeiro_v2.registrar_conta_parcelada", "financeiro_v2.registrar_intercompany"]'::jsonb);

-- Liquidação SEM saída bancária: por comprovante (0029) ou PAGA POR OUTRA EMPRESA (esta migração, com o passivo intercompany).
alter table fv2_liquidacao drop constraint fv2_liquidacao_sem_movimentacao;
alter table fv2_liquidacao add constraint fv2_liquidacao_sem_movimentacao check (
  movimentacao_id is not null
  or (alvo_tipo = 'OBRIGACAO' and extras->>'origemDoVinculo' = 'COMPROVANTE' and (extras->>'documentoId') is not null)
  or (alvo_tipo = 'OBRIGACAO' and extras->>'origemDoVinculo' = 'INTERCOMPANY' and (extras->>'intercompanyId') is not null));

-- Políticas: a ação estreita liquida a conta do fornecedor (liquidação + posição da conta) e grava o histórico. Nada mais.
do $$
declare
  r record;
  expr text;
begin
  for r in select * from (values
      ('fv2_liquidacao', 'fv2_liquidacao_incluir', 'check'),
      ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'using'),
      ('fv2_obrigacao', 'fv2_obrigacao_alterar', 'check'),
      ('fv2_historico', 'fv2_historico_incluir', 'check')
    ) as v(tabela, politica, parte) loop
    select case when r.parte = 'using' then pg_get_expr(p.polqual, p.polrelid) else pg_get_expr(p.polwithcheck, p.polrelid) end into expr
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = current_schema() and c.relname = r.tabela and p.polname = r.politica;
    if expr is null then
      raise exception 'Financeiro v2 0034: política %.% (%) não encontrada.', r.tabela, r.politica, r.parte;
    end if;
    execute format('alter policy %I on %I %s ((%s) or (select fv2_tem_acao(array[%L])))', r.politica, r.tabela,
      case when r.parte = 'using' then 'using' else 'with check' end, expr, 'financeiro_v2.registrar_intercompany');
  end loop;
end $$;

-- Quem SÓ tem a ação estreita de intercompany (sem ação ampla nem outra ação que altere contas) só muda a POSIÇÃO da conta liquidada.
create or replace function fv2_so_intercompany() returns boolean language sql stable as $$
  select not (select rolsuper from pg_roles where rolname = current_user)
     and fv2_tem_acao(array['financeiro_v2.registrar_intercompany'])
     and not fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.aplicar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar',
                                'financeiro_v2.baixar_por_comprovante', 'financeiro_v2.vincular_pagamento', 'financeiro_v2.prestar_sangria', 'financeiro_v2.registrar_juros'])
$$;
create or replace function fv2_obrigacao_paga_por_outra_empresa() returns trigger language plpgsql as $$
begin
  if not fv2_so_intercompany() then
    return new;
  end if;
  if (to_jsonb(old) - array['versao', 'atualizado_em', 'atualizado_por', 'liquidado_centavos', 'saldo_centavos', 'situacao'])
       is distinct from (to_jsonb(new) - array['versao', 'atualizado_em', 'atualizado_por', 'liquidado_centavos', 'saldo_centavos', 'situacao'])
     or new.liquidado_centavos <= old.liquidado_centavos then
    raise exception 'Financeiro v2: a operação entre empresas só registra o pagamento da conta (nada mais muda).' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_obrigacao_intercompany before update on fv2_obrigacao for each row execute function fv2_obrigacao_paga_por_outra_empresa();

-- Pagamento por comprovante (0029/0032) + liquidação PAGA POR OUTRA EMPRESA: exige o passivo DEVEDORA desta unidade, desta conta e
-- do mesmo valor, gravado antes na mesma transação. Data não futura. Quem só tem a ação estreita nunca grava liquidação com saída.
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
    if new.alvo_tipo = 'OBRIGACAO' and coalesce(new.extras->>'origemDoVinculo', '') = 'INTERCOMPANY' then
      if not exists (select 1 from fv2_intercompany i
                      where i.organizacao_id = new.organizacao_id and i.unidade_id = new.unidade_id and i.id = (new.extras->>'intercompanyId')::uuid
                        and i.papel = 'DEVEDORA' and i.obrigacao_id = new.alvo_id and i.valor_centavos = new.valor_centavos
                        and i.data_pagamento = new.data_efetiva) then
        raise exception 'Financeiro v2: conta paga por outra empresa exige o passivo entre empresas desta conta, do mesmo valor e data.' using errcode = '42501';
      end if;
      if new.data_efetiva > current_date + 1 then
        raise exception 'Financeiro v2: pagamento por outra empresa não pode ter data futura.' using errcode = '42501';
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

-- =====================================================================================================================
-- 27/11 (revisão do PR #236) — AUTORIZAÇÃO VINCULADA À OPERAÇÃO (fim do CONTRAPARTE_SEM_SESSAO)
--
-- A sessão da plataforma é de UMA unidade e a autoridade só emite sessão de banco para o escopo DESSA sessão (regra mantida).
-- Para a operação entre empresas, a autoridade passa a poder emitir UMA sessão para a OUTRA empresa quando, e só quando:
--   * a MESMA pessoa (usuario_id) tem concessão ATIVA com aprovar + aplicar + registrar_intercompany NAS DUAS unidades;
--   * a autenticação é aal2 com segundo fator RECENTE (≤ 10 min), conferido pela autoridade e registrado aqui;
--   * a finalidade é INTERCOMPANY e a sessão fica PRESA à chave da operação (só grava o registro/reembolso dessa chave);
--   * a validade é curta (≤ 120 s) e as ações da sessão ficam RESTRITAS a ver + registrar_intercompany (acoes_autorizadas),
--     mesmo que a concessão da pessoa seja mais ampla — portanto vale o regime ESTREITO (fv2_so_intercompany) nessa empresa;
--   * cada emissão fica na auditoria fv2_autorizacao_vinculada (sem exclusão nem alteração).
-- Sessões comuns não mudam (acoes_autorizadas nulo ⇒ regra de sempre). RLS, MFA e escopo continuam valendo.
-- =====================================================================================================================

create table fv2_autorizacao_vinculada (
  id                          uuid primary key default gen_random_uuid(),
  sessao_id                   uuid not null unique references fv2_sessao_banco (id),
  usuario_id                  uuid not null,
  organizacao_id              uuid not null,            -- escopo da sessão vinculada (a outra empresa)
  unidade_id                  uuid not null,
  principal_organizacao_id    uuid not null,            -- escopo da sessão da plataforma (onde a pessoa aprovou)
  principal_unidade_id        uuid not null,
  finalidade                  text not null check (finalidade = 'INTERCOMPANY'),
  chave                       text not null check (length(chave) between 1 and 300),
  proposta_id                 uuid,
  nivel_autenticacao          text not null check (nivel_autenticacao = 'aal2'),
  segundo_fator_em            timestamptz not null,
  emitida_por                 text not null default session_user,
  emitida_em                  timestamptz not null default clock_timestamp(),
  expira_em                   timestamptz not null,
  foreign key (organizacao_id, unidade_id) references fv2_escopo,
  foreign key (principal_organizacao_id, principal_unidade_id) references fv2_escopo,
  check ((organizacao_id, unidade_id) <> (principal_organizacao_id, principal_unidade_id)),
  check (expira_em > emitida_em and expira_em <= emitida_em + interval '121 seconds')
);
create function fv2_autorizacao_vinculada_imutavel() returns trigger language plpgsql as $$
begin
  raise exception 'Financeiro v2: a autorização vinculada é registro de auditoria e não se altera.' using errcode = 'FV002';
end $$;
create trigger fv2_autorizacao_vinculada_sem_delete before delete on fv2_autorizacao_vinculada for each row execute function fv2_proibir_exclusao();
create trigger fv2_autorizacao_vinculada_sem_update before update on fv2_autorizacao_vinculada for each row execute function fv2_autorizacao_vinculada_imutavel();
alter table fv2_autorizacao_vinculada enable row level security;
alter table fv2_autorizacao_vinculada force row level security;
-- leitura (auditoria) nas DUAS unidades envolvidas, com sessão operacional; gravação só pela função da autoridade (abaixo)
create policy fv2_autorizacao_vinculada_ler on fv2_autorizacao_vinculada for select using ((select fv2_sessao_operacional()) and (
  (organizacao_id = (select fv2_org()) and unidade_id = (select fv2_uni()))
  or (principal_organizacao_id = (select fv2_org()) and principal_unidade_id = (select fv2_uni()))));
create policy fv2_autorizacao_vinculada_guardiao on fv2_autorizacao_vinculada to fv2_guardiao using (true) with check (true);
revoke all on fv2_autorizacao_vinculada from public;
grant select on fv2_autorizacao_vinculada to fv2_app;
grant select, insert on fv2_autorizacao_vinculada to fv2_guardiao;

-- Permissão por ação passa a respeitar as ações RESTRITAS da sessão (só as sessões vinculadas as têm; as comuns: nulo).
create or replace function fv2_tem_acao(p_acoes text[]) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (
    select 1
      from fv2__sessao_vigente() s
      join fv2_concessao c on c.organizacao_id = s.organizacao_id and c.unidade_id = s.unidade_id and c.usuario_id = s.usuario_id
     where s.finalidade = 'OPERACAO' and c.situacao = 'ATIVA' and c.acoes ?| p_acoes
       and (s.acoes_autorizadas is null or s.acoes_autorizadas ?| p_acoes)
  )
$$;

/** Chave da operação a que a sessão VIGENTE está presa (null = sessão comum). */
create function fv2__chave_vinculada() returns text language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select a.chave from fv2__sessao_vigente() s join fv2_autorizacao_vinculada a on a.sessao_id = s.sessao_id
$$;
alter function fv2__chave_vinculada() owner to fv2_guardiao;
revoke all on function fv2__chave_vinculada() from public;
grant execute on function fv2__chave_vinculada() to fv2_app;

create function fv2_abrir_sessao_vinculada(p_usuario uuid, p_principal_organizacao uuid, p_principal_unidade uuid, p_organizacao uuid,
  p_unidade uuid, p_validade_segundos integer, p_finalidade text, p_chave text, p_proposta uuid, p_nivel_autenticacao text,
  p_segundo_fator_em timestamptz)
returns text language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  token text := fv2__novo_token();
  exigidas text[] := array['financeiro_v2.aprovar', 'financeiro_v2.aplicar', 'financeiro_v2.registrar_intercompany'];
  sessao uuid;
  expira timestamptz;
begin
  if p_usuario is null or p_principal_organizacao is null or p_principal_unidade is null or p_organizacao is null or p_unidade is null then
    raise exception 'Financeiro v2: autorização vinculada incompleta.' using errcode = '22023';
  end if;
  if p_organizacao = p_principal_organizacao and p_unidade = p_principal_unidade then
    raise exception 'Financeiro v2: a autorização vinculada é para a OUTRA empresa da operação.' using errcode = '22023';
  end if;
  if p_finalidade is distinct from 'INTERCOMPANY' or coalesce(length(btrim(p_chave)), 0) not between 1 and 300 then
    raise exception 'Financeiro v2: autorização vinculada só para operação entre empresas, com a chave da operação.' using errcode = '22023';
  end if;
  if p_validade_segundos is null or p_validade_segundos < 1 or p_validade_segundos > 120 then
    raise exception 'Financeiro v2: autorização vinculada vale no máximo 120 s.' using errcode = '22023';
  end if;
  if p_nivel_autenticacao is distinct from 'aal2' or p_segundo_fator_em is null
     or p_segundo_fator_em < clock_timestamp() - interval '10 minutes' or p_segundo_fator_em > clock_timestamp() + interval '1 minute' then
    raise exception 'Financeiro v2: a autorização vinculada exige segundo fator recente (aal2, últimos 10 minutos).' using errcode = 'FV020';
  end if;
  if not exists (select 1 from fv2_escopo e where e.organizacao_id = p_organizacao and e.unidade_id = p_unidade)
     or not exists (select 1 from fv2_escopo e where e.organizacao_id = p_principal_organizacao and e.unidade_id = p_principal_unidade) then
    raise exception 'Financeiro v2: escopo não configurado.' using errcode = 'FV020';
  end if;
  -- Compartilhada nas duas unidades: uma revogação em andamento nunca é "furada".
  perform fv2__trava_concessoes(p_principal_organizacao, p_principal_unidade, false);
  perform fv2__trava_concessoes(p_organizacao, p_unidade, false);
  -- a MESMA pessoa, com as permissões de aprovar a operação, NAS DUAS empresas (concessão gravada e ativa agora)
  if not exists (select 1 from fv2_concessao c where c.organizacao_id = p_principal_organizacao and c.unidade_id = p_principal_unidade
                  and c.usuario_id = p_usuario and c.situacao = 'ATIVA' and c.acoes ?& exigidas)
     or not exists (select 1 from fv2_concessao c where c.organizacao_id = p_organizacao and c.unidade_id = p_unidade
                  and c.usuario_id = p_usuario and c.situacao = 'ATIVA' and c.acoes ?& exigidas) then
    raise exception 'Financeiro v2: a pessoa precisa de aprovar, aplicar e registrar_intercompany nas duas empresas.' using errcode = 'FV020';
  end if;
  expira := clock_timestamp() + make_interval(secs => p_validade_segundos);
  insert into fv2_sessao_banco (token_hash, usuario_id, organizacao_id, unidade_id, finalidade, pode_escrever, acoes_autorizadas, referencia, expira_em)
  values (sha256(convert_to(token, 'UTF8')), p_usuario, p_organizacao, p_unidade, 'OPERACAO', true,
          '["financeiro_v2.registrar_intercompany", "financeiro_v2.ver"]'::jsonb, left('vinculada:INTERCOMPANY:' || p_chave, 200), expira)
  returning id into sessao;
  insert into fv2_autorizacao_vinculada (sessao_id, usuario_id, organizacao_id, unidade_id, principal_organizacao_id, principal_unidade_id,
    finalidade, chave, proposta_id, nivel_autenticacao, segundo_fator_em, expira_em)
  values (sessao, p_usuario, p_organizacao, p_unidade, p_principal_organizacao, p_principal_unidade, p_finalidade, p_chave, p_proposta,
          p_nivel_autenticacao, p_segundo_fator_em, expira);
  return token;
end $$;
alter function fv2_abrir_sessao_vinculada(uuid, uuid, uuid, uuid, uuid, integer, text, text, uuid, text, timestamptz) owner to fv2_guardiao;
revoke all on function fv2_abrir_sessao_vinculada(uuid, uuid, uuid, uuid, uuid, integer, text, text, uuid, text, timestamptz) from public;
grant execute on function fv2_abrir_sessao_vinculada(uuid, uuid, uuid, uuid, uuid, integer, text, text, uuid, text, timestamptz) to fv2_autoridade;

-- A sessão vinculada só grava a operação da SUA chave: o lado novo (insert) e o reembolso cuja liquidação nova tem a mesma chave.
create function fv2_intercompany_da_chave() returns trigger language plpgsql as $$
declare
  ch text := fv2__chave_vinculada();
begin
  if ch is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.chave_idempotencia not in ('intercompany:' || ch || ':DEVEDORA', 'intercompany:' || ch || ':CREDORA') then
      raise exception 'Financeiro v2: a autorização vinculada não cobre esta operação entre empresas.' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.movimentacao_id is distinct from old.movimentacao_id
     or jsonb_array_length(new.liquidacoes) <> jsonb_array_length(old.liquidacoes) + 1
     or (new.liquidacoes -> (jsonb_array_length(new.liquidacoes) - 1))->>'chave' is distinct from ch then
    raise exception 'Financeiro v2: a autorização vinculada só registra o reembolso da sua chave.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_intercompany_chave_vinculada before insert or update on fv2_intercompany for each row execute function fv2_intercompany_da_chave();
