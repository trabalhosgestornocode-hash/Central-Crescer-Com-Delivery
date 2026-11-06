-- =====================================================================
-- 151 — Financeiro 2.0: CONTAS A PAGAR (obrigação × pagamentos), ACRÉSCIMOS (juros/multa/tarifa) e CONCILIAÇÃO DE SAÍDAS.
-- Estende a Gestão Financeira (120/121/122). NÃO cria um sistema paralelo: usa fin_contas, fin_plano_contas, fin_lancamentos (extrato),
-- fin_periodos (trava por competência), fin_auditoria (trilha) e o mesmo modelo de privilégios (backend-only, RLS sem policy, sem DELETE).
--
-- Decisões aprovadas (GO condicionado, 05/11/2026):
--   • níveis novos `contador` e `administrador`;  • a diferença é calculada sobre o TOTAL dos pagamentos e só na obrigação QUITADA;
--   • pagamento parcial nunca vira desconto;      • juros de contas a pagar ficam separados dos juros de empréstimo (estes não estão aqui);
--   • tolerância de SUGESTÃO: R$ 0,01 e 1 dia;    • NENHUMA sugestão é confirmada automaticamente (só a função de confirmação, chamada por pessoa);
--   • fechamento mensal bloqueado enquanto houver divergência bloqueadora (ver fin2_bloqueios_fechamento).
-- Idempotente. Rollback: 151_rollback.sql (recusa se houver dados).
-- =====================================================================
begin;
set local lock_timeout = '5s';   -- (revisão #12) não ficar na fila segurando o tráfego financeiro

do $$
begin
  if to_regclass('public.fin_lancamentos') is null or to_regclass('public.fin_periodos') is null
     or to_regprocedure('public.fin_periodo_travar_e_checar(uuid,uuid,date)') is null
     or to_regprocedure('public.fin_guarda_periodo_data()') is null
     or to_regprocedure('public.gestao_financeira_tabelas_da_unidade()') is null then
    raise exception 'MIGRATION 151 abortada: requer as migrations 120, 121 e 122 aplicadas.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1) Níveis de concessão: + contador, + administrador (decisões 2, 4 e 5). As permissões de cada nível ficam no backend
--    (gestaoFinanceira.permissoes.js); aqui só o domínio de valores aceitos.
-- ---------------------------------------------------------------------
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.gestao_financeira_concessoes'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%nivel%' loop
    execute format('alter table public.gestao_financeira_concessoes drop constraint %I', c.conname);
  end loop;
  alter table public.gestao_financeira_concessoes
    add constraint gestao_financeira_concessoes_nivel_check check (nivel in ('leitura', 'operador', 'gestor', 'contador', 'administrador'));
end $$;

-- ---------------------------------------------------------------------
-- 2) Tolerâncias (constantes versionadas: mudar exige migration auditável)
-- ---------------------------------------------------------------------
create or replace function fin2_tolerancia_centavos() returns int language sql immutable as $$ select 1 $$;
create or replace function fin2_tolerancia_dias() returns int language sql immutable as $$ select 1 $$;

-- ---------------------------------------------------------------------
-- 3) Tabelas
-- ---------------------------------------------------------------------
create table if not exists fin_fornecedores (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  nome text not null check (length(btrim(nome)) between 1 and 120),
  documento text check (documento is null or length(documento) <= 20),
  ativo boolean not null default true,
  criado_por uuid, atualizado_por uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists ux_fin_fornecedores_nome on fin_fornecedores (organizacao_id, lower(btrim(nome)));

create table if not exists fin_obrigacoes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  fornecedor_id uuid not null references fin_fornecedores(id) on delete restrict,
  categoria_id uuid not null references fin_plano_contas(id) on delete restrict,
  descricao text not null check (length(btrim(descricao)) between 1 and 300),
  competencia date not null check (competencia = date_trunc('month', competencia)::date),
  vencimento date not null,
  valor_original_centavos bigint not null check (valor_original_centavos > 0 and valor_original_centavos <= 100000000000),
  status text not null default 'aberta' check (status in ('aberta', 'quitada', 'cancelada')),
  -- registro provisório (decisão 3): feito por quem não pode confirmar; precisa de confirmação de gerente/contadora/administrador
  provisoria boolean not null default false,
  confirmada_por uuid, confirmada_em timestamptz,
  data_quitacao date, quitada_por uuid, quitada_em timestamptz,
  classificacao_diferenca text check (classificacao_diferenca in ('juros', 'multa', 'tarifa', 'outro', 'desconto')),
  classificada_por uuid, classificada_em timestamptz,
  motivo_reversao text,
  motivo_cancelamento text, cancelada_por uuid, cancelada_em timestamptz,
  origem text not null default 'manual' check (origem in ('manual', 'importacao')),
  chave_origem text, referencia_origem text,
  observacoes text check (observacoes is null or length(observacoes) <= 1000),
  criado_por uuid, atualizado_por uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint fin_obr_quitacao_completa check ((status = 'quitada') = (data_quitacao is not null and quitada_por is not null and quitada_em is not null)),
  constraint fin_obr_cancelamento_completo check (status <> 'cancelada' or (cancelada_por is not null and cancelada_em is not null and length(btrim(coalesce(motivo_cancelamento, ''))) >= 10)),
  constraint fin_obr_classificacao_so_quitada check (classificacao_diferenca is null or (status = 'quitada' and classificada_por is not null and classificada_em is not null)),
  constraint fin_obr_quitada_confirmada check (not (provisoria and status = 'quitada'))
);
create unique index if not exists ux_fin_obrigacoes_chave on fin_obrigacoes (organizacao_id, unidade_id, chave_origem) where chave_origem is not null;
create index if not exists ix_fin_obrigacoes_comp on fin_obrigacoes (organizacao_id, unidade_id, competencia);
create index if not exists ix_fin_obrigacoes_venc on fin_obrigacoes (organizacao_id, unidade_id, vencimento);
create index if not exists ix_fin_obrigacoes_fornecedor on fin_obrigacoes (fornecedor_id);

create table if not exists fin_pagamentos (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  obrigacao_id uuid not null references fin_obrigacoes(id) on delete restrict,
  conta_id uuid not null references fin_contas(id) on delete restrict,
  data_pagamento date not null,
  valor_centavos bigint not null check (valor_centavos > 0 and valor_centavos <= 100000000000),
  status text not null default 'ativo' check (status in ('ativo', 'cancelado')),
  -- (revisão #5) pagamento registrado por quem não pode confirmar (operador) nasce PROVISÓRIO; só quitação/confirmação de registro o confirma
  provisorio boolean not null default false, confirmado_por uuid, confirmado_em timestamptz,
  motivo_cancelamento text, cancelado_por uuid, cancelado_em timestamptz,
  comprovante_ref text check (comprovante_ref is null or length(comprovante_ref) <= 300),
  observacao text check (observacao is null or length(observacao) <= 1000),
  origem text not null default 'manual' check (origem in ('manual', 'importacao')),
  chave_origem text, referencia_origem text,
  criado_por uuid, atualizado_por uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint fin_pag_cancelamento_completo check (status <> 'cancelado' or (cancelado_por is not null and cancelado_em is not null and length(btrim(coalesce(motivo_cancelamento, ''))) >= 10))
);
create unique index if not exists ux_fin_pagamentos_chave on fin_pagamentos (organizacao_id, unidade_id, chave_origem) where chave_origem is not null;
create index if not exists ix_fin_pagamentos_obr on fin_pagamentos (obrigacao_id);
create index if not exists ix_fin_pagamentos_data on fin_pagamentos (organizacao_id, unidade_id, data_pagamento);

-- Vínculo pagamento ⇄ saída do extrato (fin_lancamentos). n:n via `grupo`: 1 saída ⇄ n pagamentos (agrupado) ou 1 ⇄ 1.
create table if not exists fin_conciliacao_saidas (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  grupo uuid not null,
  pagamento_id uuid not null references fin_pagamentos(id) on delete restrict,
  lancamento_id uuid not null references fin_lancamentos(id) on delete restrict,
  valor_alocado_centavos bigint not null check (valor_alocado_centavos > 0),
  status text not null check (status in ('sugerido', 'conciliado', 'divergente', 'rejeitado', 'revogado')),
  regra text not null check (regra in ('exato', 'data_proxima', 'agrupado', 'manual')),
  diferenca_centavos bigint not null default 0,     -- saída do extrato − Σ pagamentos do grupo (no momento da criação)
  dias_diferenca int not null default 0,
  justificativa text,
  evidencia jsonb,
  confirmado_por uuid, confirmado_em timestamptz,
  rejeitado_por uuid, rejeitado_em timestamptz,
  revogado_por uuid, revogado_em timestamptz, motivo_revogacao text,
  criado_por uuid, atualizado_por uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint fin_cs_conciliado_completo check (status <> 'conciliado' or (confirmado_por is not null and confirmado_em is not null and evidencia is not null)),
  constraint fin_cs_rejeitado_completo check (status <> 'rejeitado' or (rejeitado_por is not null and rejeitado_em is not null)),
  constraint fin_cs_revogado_completo check (status <> 'revogado' or (revogado_por is not null and revogado_em is not null and length(btrim(coalesce(motivo_revogacao, ''))) >= 10))
);
create unique index if not exists ux_fin_cs_par_ativo on fin_conciliacao_saidas (pagamento_id, lancamento_id) where status in ('sugerido', 'conciliado', 'divergente');
create index if not exists ix_fin_cs_pag on fin_conciliacao_saidas (pagamento_id);
create index if not exists ix_fin_cs_lanc on fin_conciliacao_saidas (lancamento_id);
create index if not exists ix_fin_cs_grupo on fin_conciliacao_saidas (grupo);

-- ---------------------------------------------------------------------
-- 4) Gatilhos de integridade
-- LIMITE HONESTO (revisão #9, igual ao da 122): as transições "só pela função" usam flags LOCAIS de transação (fin2.obrigacao_op,
-- fin2.conciliacao_op). Defendem contra a API/backend (PostgREST: cada requisição é uma transação e set_config não é exposto); NÃO
-- defendem contra quem já tem SQL bruto como service_role/dono. A auditoria (fin_auditoria, imutável) registra quem alterou o quê.
-- ---------------------------------------------------------------------
-- Trava os meses informados (ordem crescente, sem repetição) — mesmo protocolo da 122 (FOR SHARE; o fechamento usa FOR UPDATE).
create or replace function fin2_travar_meses(p_org uuid, p_unidade uuid, p_datas date[]) returns void language plpgsql as $$
declare m date;
begin
  for m in select distinct date_trunc('month', d)::date from unnest(p_datas) d where d is not null order by 1 loop
    perform fin_periodo_travar_e_checar(p_org, p_unidade, m);
  end loop;
end $$;

create or replace function fin_fornecedores_guarda() returns trigger language plpgsql as $$
begin
  if new.organizacao_id is distinct from old.organizacao_id or new.criado_por is distinct from old.criado_por then
    raise exception 'fin_campo_imutavel' using errcode = '23514';
  end if;
  return new;
end $$;

-- Obrigação: identidade imutável; fornecedor da MESMA organização; mês fechado (competência e mês da quitação) intocável;
-- transições de estado SÓ pelas funções (flag local da transação), nunca por UPDATE direto.
create or replace function fin_obrigacoes_guarda() returns trigger language plpgsql as $$
declare v_flag text := coalesce(current_setting('fin2.obrigacao_op', true), ''); v_soma bigint; v_ult date;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'fin2_isolamento_invalido: o Financeiro 2.0 exige READ COMMITTED (atual: %)', current_setting('transaction_isolation') using errcode = '25001';
  end if;
  if not exists (select 1 from fin_fornecedores f where f.id = new.fornecedor_id and f.organizacao_id = new.organizacao_id) then
    raise exception 'fin_escopo_invalido: fornecedor de outra organizacao' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'aberta' or new.classificacao_diferenca is not null or new.data_quitacao is not null then
      raise exception 'fin2_estado_inicial_invalido: a obrigacao nasce aberta e sem classificacao' using errcode = '23514';
    end if;
    perform fin2_travar_meses(new.organizacao_id, new.unidade_id, array[new.competencia]);
    return new;
  end if;
  if new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id or new.origem is distinct from old.origem
     or new.chave_origem is distinct from old.chave_origem or new.criado_por is distinct from old.criado_por then
    raise exception 'fin_campo_imutavel' using errcode = '23514';
  end if;
  if old.status = 'cancelada' then raise exception 'fin2_obrigacao_cancelada_imutavel' using errcode = '23514'; end if;
  if (new.status is distinct from old.status or new.data_quitacao is distinct from old.data_quitacao or new.quitada_por is distinct from old.quitada_por
      or new.classificacao_diferenca is distinct from old.classificacao_diferenca or new.classificada_por is distinct from old.classificada_por
      or new.provisoria is distinct from old.provisoria and new.provisoria = false
      -- (revisão #8) campos de AUTORIA e de MOTIVO também só pelas funções (não se forja quem confirmou/quitou/classificou nem quando)
      or new.confirmada_por is distinct from old.confirmada_por or new.confirmada_em is distinct from old.confirmada_em
      or new.quitada_em is distinct from old.quitada_em or new.classificada_em is distinct from old.classificada_em
      or new.motivo_cancelamento is distinct from old.motivo_cancelamento or new.cancelada_por is distinct from old.cancelada_por
      or new.cancelada_em is distinct from old.cancelada_em or new.motivo_reversao is distinct from old.motivo_reversao)
     and v_flag <> old.id::text then
    raise exception 'fin2_transicao_via_funcao: quitacao, classificacao, confirmacao e cancelamento so pelas funcoes proprias' using errcode = '23514';
  end if;
  -- (2ª revisão, #3) reduzir o valor de conta ABERTA não pode deixá-la paga por inteiro com o último pagamento num mês FECHADO (quitação impossível)
  if new.status = 'aberta' and new.valor_original_centavos < old.valor_original_centavos then
    select coalesce(sum(valor_centavos), 0), max(data_pagamento) into v_soma, v_ult from fin_pagamentos where obrigacao_id = old.id and status = 'ativo';
    if v_soma >= new.valor_original_centavos and v_ult is not null
       and exists (select 1 from fin_periodos pp where pp.unidade_id = new.unidade_id and pp.mes = date_trunc('month', v_ult)::date and pp.status = 'fechado') then
      raise exception 'fin2_quitacao_em_mes_fechado: com este valor a conta ficaria paga por inteiro com o ultimo pagamento num mes fechado' using errcode = '23514';
    end if;
  end if;
  if old.status = 'quitada' and new.status = 'quitada'
     and (new.valor_original_centavos is distinct from old.valor_original_centavos or new.competencia is distinct from old.competencia
          or new.categoria_id is distinct from old.categoria_id) then
    raise exception 'fin2_obrigacao_quitada: desfaca a quitacao antes de alterar valor, competencia ou categoria' using errcode = '23514';
  end if;
  -- Trava por EFEITO: o que muda o resultado da COMPETÊNCIA (valor, competência, categoria, fornecedor, descrição, cancelamento) trava o mês da
  -- competência; o que muda o ACRÉSCIMO (quitação, classificação) trava o mês da quitação. Assim uma conta de competência já fechada, paga com
  -- atraso no mês seguinte, ainda pode ser quitada (o acréscimo pertence ao mês do pagamento) sem tocar o mês fechado.
  if new.valor_original_centavos is distinct from old.valor_original_centavos or new.competencia is distinct from old.competencia
     or new.categoria_id is distinct from old.categoria_id or new.fornecedor_id is distinct from old.fornecedor_id or new.descricao is distinct from old.descricao
     or new.provisoria is distinct from old.provisoria                  -- (revisão #10) provisório num mês fechado reabriria um bloqueio já resolvido
     or (new.status is distinct from old.status and 'cancelada' in (new.status, old.status)) then
    perform fin2_travar_meses(new.organizacao_id, new.unidade_id, array[old.competencia, new.competencia]);
  end if;
  if new.data_quitacao is distinct from old.data_quitacao or new.classificacao_diferenca is distinct from old.classificacao_diferenca
     or (new.status is distinct from old.status and 'quitada' in (new.status, old.status)) then
    perform fin2_travar_meses(new.organizacao_id, new.unidade_id, array[old.data_quitacao, new.data_quitacao]);
  end if;
  return new;
end $$;

-- Pagamento: obrigação do MESMO tenant e ABERTA (trava a obrigação: serializa com a quitação); conta do tenant (fin_validar_escopo);
-- mês do pagamento travado (fin_guarda_periodo_data); valor/conta/data não mudam com vínculo de conciliação ativo; cancelar exige motivo e sem vínculo ativo.
create or replace function fin_pagamentos_guarda() returns trigger language plpgsql as $$
declare v_obr fin_obrigacoes; v_flag text := coalesce(current_setting('fin2.obrigacao_op', true), ''); v_soma bigint; v_ult date;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'fin2_isolamento_invalido: o Financeiro 2.0 exige READ COMMITTED (atual: %)', current_setting('transaction_isolation') using errcode = '25001';
  end if;
  select * into v_obr from fin_obrigacoes o where o.id = new.obrigacao_id for share;
  if v_obr.id is null or v_obr.organizacao_id <> new.organizacao_id or v_obr.unidade_id <> new.unidade_id then
    raise exception 'fin_escopo_invalido: obrigacao de outro tenant' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'ativo' then raise exception 'fin2_estado_inicial_invalido' using errcode = '23514'; end if;
    if v_obr.status <> 'aberta' then raise exception 'fin2_obrigacao_nao_aberta: desfaca a quitacao antes de registrar novo pagamento' using errcode = '23514'; end if;
    return new;
  end if;
  if new.obrigacao_id is distinct from old.obrigacao_id or new.origem is distinct from old.origem or new.chave_origem is distinct from old.chave_origem
     or new.criado_por is distinct from old.criado_por then
    raise exception 'fin_campo_imutavel' using errcode = '23514';
  end if;
  if old.status = 'cancelado' then raise exception 'fin2_pagamento_cancelado_imutavel' using errcode = '23514'; end if;
  if (new.provisorio is distinct from old.provisorio and new.provisorio = false or new.confirmado_por is distinct from old.confirmado_por
      or new.confirmado_em is distinct from old.confirmado_em) and v_flag <> new.obrigacao_id::text then
    raise exception 'fin2_transicao_via_funcao: o pagamento provisorio so e confirmado pela quitacao ou pela confirmacao do registro' using errcode = '23514';
  end if;
  -- (revisão #3) cancelar/alterar um pagamento não pode deixar a conta PAGA POR INTEIRO com o último pagamento num mês FECHADO:
  -- a quitação seria datada nesse mês e ficaria impossível (conta aberta para sempre). Recusa antes.
  if new.status is distinct from old.status or new.valor_centavos is distinct from old.valor_centavos or new.data_pagamento is distinct from old.data_pagamento then
    select coalesce(sum(x.v), 0), max(x.d) into v_soma, v_ult from (
      select valor_centavos as v, data_pagamento as d from fin_pagamentos where obrigacao_id = old.obrigacao_id and status = 'ativo' and id <> old.id
      union all select new.valor_centavos, new.data_pagamento where new.status = 'ativo') x;
    if v_soma >= v_obr.valor_original_centavos and v_ult is not null
       and exists (select 1 from fin_periodos pp where pp.unidade_id = new.unidade_id and pp.mes = date_trunc('month', v_ult)::date and pp.status = 'fechado') then
      raise exception 'fin2_quitacao_em_mes_fechado: esta alteracao deixaria a conta paga por inteiro com o ultimo pagamento num mes fechado' using errcode = '23514';
    end if;
  end if;
  if (new.valor_centavos is distinct from old.valor_centavos or new.conta_id is distinct from old.conta_id or new.data_pagamento is distinct from old.data_pagamento
      or new.status is distinct from old.status) then
    if v_obr.status <> 'aberta' then raise exception 'fin2_obrigacao_nao_aberta: desfaca a quitacao antes de alterar o pagamento' using errcode = '23514'; end if;
    if exists (select 1 from fin_conciliacao_saidas s where s.pagamento_id = old.id and s.status in ('sugerido', 'conciliado', 'divergente')) then
      raise exception 'fin2_pagamento_vinculado: desfaca o vinculo de conciliacao antes de alterar ou cancelar este pagamento' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- Conciliação de saídas: tenant de pagamento e lançamento; lançamento = SAÍDA REALIZADA; Σ alocado não excede nenhum dos lados;
-- nasce 'sugerido' ou 'divergente' (NUNCA 'conciliado' direto); 'conciliado' e 'revogado' só pelas funções; meses travados.
create or replace function fin_conciliacao_saidas_guarda() returns trigger language plpgsql as $$
declare p fin_pagamentos; l fin_lancamentos; v_flag text := coalesce(current_setting('fin2.conciliacao_op', true), ''); s_pag bigint; s_lanc bigint;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'fin2_isolamento_invalido: o Financeiro 2.0 exige READ COMMITTED (atual: %)', current_setting('transaction_isolation') using errcode = '25001';
  end if;
  if tg_op = 'UPDATE' then
    if new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id or new.grupo is distinct from old.grupo
       or new.pagamento_id is distinct from old.pagamento_id or new.lancamento_id is distinct from old.lancamento_id
       or new.valor_alocado_centavos is distinct from old.valor_alocado_centavos or new.regra is distinct from old.regra or new.criado_por is distinct from old.criado_por
       or new.diferenca_centavos is distinct from old.diferenca_centavos or new.dias_diferenca is distinct from old.dias_diferenca then
      raise exception 'fin_campo_imutavel' using errcode = '23514';
    end if;
    if old.status in ('rejeitado', 'revogado') then raise exception 'fin2_vinculo_encerrado_imutavel' using errcode = '23514'; end if;
    -- (revisão #8) evidência, justificativa e autoria da confirmação/revogação: só pela função (flag do grupo). Rejeição: só na própria transição.
    if (new.evidencia is distinct from old.evidencia or new.justificativa is distinct from old.justificativa or new.confirmado_por is distinct from old.confirmado_por
        or new.confirmado_em is distinct from old.confirmado_em or new.revogado_por is distinct from old.revogado_por or new.revogado_em is distinct from old.revogado_em
        or new.motivo_revogacao is distinct from old.motivo_revogacao) and v_flag <> old.grupo::text then
      raise exception 'fin2_campo_via_funcao: evidencia e autoria da conciliacao so pelas funcoes de confirmacao/revogacao' using errcode = '23514';
    end if;
    if (new.rejeitado_por is distinct from old.rejeitado_por or new.rejeitado_em is distinct from old.rejeitado_em) and not (new.status = 'rejeitado' and old.status <> 'rejeitado') then
      raise exception 'fin2_campo_via_funcao' using errcode = '23514';
    end if;
    if new.status is distinct from old.status then
      if new.status = 'conciliado' and (old.status not in ('sugerido', 'divergente') or v_flag <> old.grupo::text) then
        raise exception 'fin2_conciliacao_via_funcao: confirmar so pela funcao de confirmacao (acao humana)' using errcode = '23514';
      elsif new.status = 'revogado' and (old.status <> 'conciliado' or v_flag <> old.grupo::text) then
        raise exception 'fin2_conciliacao_via_funcao: revogar so pela funcao de revogacao' using errcode = '23514';
      elsif new.status = 'rejeitado' and old.status not in ('sugerido', 'divergente') then
        raise exception 'fin2_transicao_invalida' using errcode = '23514';
      elsif new.status in ('sugerido', 'divergente') then
        raise exception 'fin2_transicao_invalida' using errcode = '23514';
      end if;
    end if;
  end if;
  select * into p from fin_pagamentos where id = new.pagamento_id for update;
  select * into l from fin_lancamentos where id = new.lancamento_id for update;
  if p.id is null or l.id is null or p.organizacao_id <> new.organizacao_id or p.unidade_id <> new.unidade_id
     or l.organizacao_id <> new.organizacao_id or l.unidade_id <> new.unidade_id then
    raise exception 'fin_escopo_invalido: pagamento ou lancamento de outro tenant' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.status not in ('sugerido', 'divergente') then
      raise exception 'fin2_conciliacao_via_funcao: o vinculo nasce sugerido ou divergente; nunca conciliado automaticamente' using errcode = '23514';
    end if;
    if p.status <> 'ativo' then raise exception 'fin2_pagamento_cancelado_imutavel' using errcode = '23514'; end if;
    if l.sentido <> 'saida' or l.status <> 'realizado' then
      raise exception 'fin2_lancamento_nao_e_saida: so saidas realizadas do extrato sao conciliadas com pagamentos' using errcode = '23514';
    end if;
    if exists (select 1 from fin_plano_contas c where c.id = l.categoria_id and c.papel = 'transferencia') then
      raise exception 'fin2_lancamento_transferencia: perna de transferencia interna nao e pagamento de obrigacao' using errcode = '23514';
    end if;
  end if;
  if new.status in ('sugerido', 'conciliado', 'divergente') then
    select coalesce(sum(valor_alocado_centavos), 0) into s_pag from fin_conciliacao_saidas
     where pagamento_id = new.pagamento_id and status in ('sugerido', 'conciliado', 'divergente') and id <> new.id;
    if s_pag + new.valor_alocado_centavos > p.valor_centavos then
      raise exception 'fin2_alocacao_excedida: o pagamento ja esta alocado a outra saida' using errcode = '23514';
    end if;
    -- (revisão #1) uma saída do extrato pertence a UM ÚNICO grupo ativo. Sem isso, um 2º grupo "divergente justificado" somava pagamentos acima
    -- do valor da saída. A divergência justificada cobre só a diferença DENTRO do grupo.
    if exists (select 1 from fin_conciliacao_saidas o where o.lancamento_id = new.lancamento_id and o.grupo <> new.grupo
                and o.status in ('sugerido', 'conciliado', 'divergente')) then
      raise exception 'fin2_saida_ja_vinculada: esta saida do extrato ja esta vinculada a outro grupo de pagamentos' using errcode = '23514';
    end if;
    -- (3ª revisão, M-1) cada pagamento entra pelo valor INTEGRAL (sem alocação parcial: pagamento em duas saídas = registre dois pagamentos)
    if new.valor_alocado_centavos <> p.valor_centavos then
      raise exception 'fin2_alocacao_parcial: o pagamento entra no vinculo pelo valor integral' using errcode = '23514';
    end if;
    -- (3ª revisão, A-1) teto ABSOLUTO em qualquer status ativo: Σ pagamentos do grupo NUNCA passa do valor da saída do extrato (+ tolerância).
    -- A justificativa de divergência cobre só a diferença para MENOS (saída maior que os pagamentos: tarifa, juros não registrados etc.).
    select coalesce(sum(valor_alocado_centavos), 0) into s_lanc from fin_conciliacao_saidas
     where grupo = new.grupo and status in ('sugerido', 'conciliado', 'divergente') and id <> new.id;
    if s_lanc + new.valor_alocado_centavos > l.valor_centavos + fin2_tolerancia_centavos() then
      raise exception 'fin2_alocacao_excedida: os pagamentos somariam mais que a saida do extrato' using errcode = '23514';
    end if;
    if tg_op = 'INSERT' and exists (select 1 from fin_conciliacao_saidas o where o.grupo = new.grupo and o.status = 'conciliado') then
      raise exception 'fin2_vinculo_encerrado_imutavel: grupo ja conciliado nao recebe novos pagamentos' using errcode = '23514';
    end if;
  end if;
  -- (revisão #2) REJEITAR não altera resultado nem conciliação: não trava mês (uma sugestão que cruza um mês fechado continua descartável)
  if not (tg_op = 'UPDATE' and new.status = 'rejeitado' and old.status is distinct from 'rejeitado') then
    perform fin2_travar_meses(new.organizacao_id, new.unidade_id, array[p.data_pagamento, l.data_movimento]);
  end if;
  return new;
end $$;

-- Saída do extrato com vínculo ATIVO não muda valor/conta/data/sentido/status (desfaça o vínculo antes). Gatilho NOVO e separado em
-- fin_lancamentos: não altera a guarda da 121/122.
create or replace function fin2_lancamentos_vinculo_saida() returns trigger language plpgsql as $$
begin
  -- (reverificação, NOVO-1) a checagem do vínculo só é confiável com snapshot novo por instrução: exigir READ COMMITTED quando muda campo relevante
  if (new.valor_centavos is distinct from old.valor_centavos or new.conta_id is distinct from old.conta_id or new.data_movimento is distinct from old.data_movimento
      or new.sentido is distinct from old.sentido or new.status is distinct from old.status or new.categoria_id is distinct from old.categoria_id)
     and current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'fin2_isolamento_invalido: alterar saida do extrato exige READ COMMITTED (atual: %)', current_setting('transaction_isolation') using errcode = '25001';
  end if;
  if (new.valor_centavos is distinct from old.valor_centavos or new.conta_id is distinct from old.conta_id or new.data_movimento is distinct from old.data_movimento
      or new.sentido is distinct from old.sentido or new.status is distinct from old.status
      -- (revisão #7, ajustado na 2ª revisão/N1) classificar ou reclassificar entre despesas continua livre; só é recusado virar transferência/saldo anterior
      or (new.categoria_id is distinct from old.categoria_id
          and exists (select 1 from fin_plano_contas c where c.id = new.categoria_id and c.papel in ('transferencia', 'saldo_anterior'))))
     and exists (select 1 from fin_conciliacao_saidas s where s.lancamento_id = old.id and s.status in ('sugerido', 'conciliado', 'divergente')) then
    raise exception 'fin2_lancamento_vinculado: esta saida esta vinculada a pagamento(s); desfaca o vinculo antes' using errcode = '23514';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 5) Divergências BLOQUEADORAS do fechamento (decisão 10). Conjunto determinado pelo BANCO.
--   a) vínculo de conciliação DIVERGENTE não resolvido com pagamento ou saída no mês;
--   b) obrigação quitada no mês com total pago MENOR que o original e sem classificação ("a verificar": desconto ou saldo?);
--   c) quitação pendente: obrigação aberta cujo total pago até o fim do mês já cobre o original e cujo último pagamento é do mês;
--   d) registro PROVISÓRIO (feito por operador) não confirmado, com competência no mês.
-- Juro PRESUMIDO não classificado NÃO bloqueia (fica visível como presumido; a classificação só muda o rótulo, não o total).
-- ---------------------------------------------------------------------
create or replace function fin2_bloqueios_fechamento(p_org uuid, p_unidade uuid, p_mes date) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with m as (select date_trunc('month', p_mes)::date as ini, (date_trunc('month', p_mes) + interval '1 month')::date as fim),
  pago as (
    select o.id, o.valor_original_centavos as orig,
           coalesce(sum(p.valor_centavos) filter (where p.status = 'ativo' and p.data_pagamento < (select fim from m)), 0) as pago_ate_fim,
           max(p.data_pagamento) filter (where p.status = 'ativo' and p.data_pagamento < (select fim from m)) as ultimo   -- (revisão #3)
      from fin_obrigacoes o left join fin_pagamentos p on p.obrigacao_id = o.id
     where o.organizacao_id = p_org and o.unidade_id = p_unidade
     group by o.id, o.valor_original_centavos
  ),
  b as (
    select 'divergencia_conciliacao'::text as tipo, s.grupo::text as ref
      from fin_conciliacao_saidas s
      join fin_pagamentos p on p.id = s.pagamento_id
      join fin_lancamentos l on l.id = s.lancamento_id, m
     where s.organizacao_id = p_org and s.unidade_id = p_unidade and s.status = 'divergente'
       and ((p.data_pagamento >= m.ini and p.data_pagamento < m.fim) or (l.data_movimento >= m.ini and l.data_movimento < m.fim))
    union
    select 'pago_a_menor_a_verificar', o.id::text
      from fin_obrigacoes o join pago g on g.id = o.id, m
     where o.organizacao_id = p_org and o.unidade_id = p_unidade and o.status = 'quitada' and o.classificacao_diferenca is null
       and o.data_quitacao >= m.ini and o.data_quitacao < m.fim
       and (select coalesce(sum(valor_centavos), 0) from fin_pagamentos x where x.obrigacao_id = o.id and x.status = 'ativo') < o.valor_original_centavos
    union
    select 'quitacao_pendente', o.id::text
      from fin_obrigacoes o join pago g on g.id = o.id, m
     where o.organizacao_id = p_org and o.unidade_id = p_unidade and o.status = 'aberta'
       and g.pago_ate_fim >= o.valor_original_centavos and g.ultimo >= m.ini and g.ultimo < m.fim
    union
    select 'registro_provisorio', o.id::text
      from fin_obrigacoes o, m
     where o.organizacao_id = p_org and o.unidade_id = p_unidade and o.status <> 'cancelada' and o.provisoria and o.competencia = m.ini
    union
    select 'pagamento_provisorio', x.id::text                                   -- (revisão #5) pagamento de operador ainda não confirmado
      from fin_pagamentos x, m
     where x.organizacao_id = p_org and x.unidade_id = p_unidade and x.status = 'ativo' and x.provisorio
       and x.data_pagamento >= m.ini and x.data_pagamento < m.fim
  )
  select coalesce(jsonb_agg(jsonb_build_object('tipo', tipo, 'ref', ref) order by tipo, ref), '[]'::jsonb) from b
$$;

-- Fecha só sem bloqueios: gatilho em fin_periodos, disparado DENTRO de fin_fechar_periodo (que já segura FOR UPDATE do período; quem escreve
-- obrigação/pagamento/vínculo pega FOR SHARE do mesmo período ⇒ o conjunto é estável no instante do fechamento). Sem exceção possível.
create or replace function fin2_periodos_bloqueia_fechamento() returns trigger language plpgsql as $$
declare v jsonb;
begin
  if new.status = 'fechado' and old.status is distinct from 'fechado' then
    if current_setting('transaction_isolation') <> 'read committed' then
      raise exception 'fin2_isolamento_invalido: o fechamento exige READ COMMITTED (atual: %)', current_setting('transaction_isolation') using errcode = '25001';
    end if;
    v := fin2_bloqueios_fechamento(new.organizacao_id, new.unidade_id, new.mes);
    if jsonb_array_length(v) > 0 then
      raise exception 'fin2_divergencias_bloqueadoras: % divergencia(s) de contas a pagar/conciliacao de saidas impedem o fechamento', jsonb_array_length(v) using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['fin_fornecedores', 'fin_obrigacoes', 'fin_pagamentos', 'fin_conciliacao_saidas'] loop
    execute format('drop trigger if exists trg_%1$s_auditar on %1$s', t);
    execute format('create trigger trg_%1$s_auditar after insert or update or delete on %1$s for each row execute function fin_auditar()', t);
    execute format('drop trigger if exists trg_%1$s_upd on %1$s', t);
    execute format('create trigger trg_%1$s_upd before update on %1$s for each row execute function fin_touch_updated_at()', t);
  end loop;
  foreach t in array array['fin_obrigacoes', 'fin_pagamentos', 'fin_conciliacao_saidas'] loop
    execute format('drop trigger if exists trg_%1$s_escopo on %1$s', t);
    execute format('create trigger trg_%1$s_escopo before insert or update on %1$s for each row execute function fin_validar_escopo()', t);
  end loop;
end $$;
drop trigger if exists trg_fin_fornecedores_guarda on fin_fornecedores;
create trigger trg_fin_fornecedores_guarda before update on fin_fornecedores for each row execute function fin_fornecedores_guarda();
drop trigger if exists trg_fin_obrigacoes_guarda on fin_obrigacoes;
create trigger trg_fin_obrigacoes_guarda before insert or update on fin_obrigacoes for each row execute function fin_obrigacoes_guarda();
drop trigger if exists trg_fin_pagamentos_guarda on fin_pagamentos;
create trigger trg_fin_pagamentos_guarda before insert or update on fin_pagamentos for each row execute function fin_pagamentos_guarda();
drop trigger if exists trg_fin_pagamentos_periodo on fin_pagamentos;
create trigger trg_fin_pagamentos_periodo before insert or update or delete on fin_pagamentos for each row execute function fin_guarda_periodo_data('data_pagamento');
drop trigger if exists trg_fin_conciliacao_saidas_guarda on fin_conciliacao_saidas;
create trigger trg_fin_conciliacao_saidas_guarda before insert or update on fin_conciliacao_saidas for each row execute function fin_conciliacao_saidas_guarda();
drop trigger if exists trg_fin2_lancamentos_vinculo_saida on fin_lancamentos;
create trigger trg_fin2_lancamentos_vinculo_saida before update on fin_lancamentos for each row execute function fin2_lancamentos_vinculo_saida();
drop trigger if exists trg_fin2_periodos_bloqueia_fechamento on fin_periodos;
create trigger trg_fin2_periodos_bloqueia_fechamento before update on fin_periodos for each row execute function fin2_periodos_bloqueia_fechamento();

-- ---------------------------------------------------------------------
-- 6) Operações atômicas (RPC). Recebem org+unidade+usuário explícitos (do contexto validado no backend) e conferem o escopo.
-- ---------------------------------------------------------------------
create or replace function fin2_obter_obrigacao_para_alterar(p_org uuid, p_unidade uuid, p_obrigacao uuid) returns fin_obrigacoes language plpgsql as $$
declare v fin_obrigacoes;
begin
  select * into v from fin_obrigacoes where id = p_obrigacao and organizacao_id = p_org and unidade_id = p_unidade for update;
  if not found then raise exception 'fin2_obrigacao_nao_encontrada' using errcode = 'P0002'; end if;
  return v;
end $$;

-- Quitar: exige pagamento ativo; data da quitação = data do ÚLTIMO pagamento (o acréscimo pertence a esse mês). Confirma registro provisório.
create or replace function fin_obrigacao_quitar(p_org uuid, p_unidade uuid, p_usuario uuid, p_obrigacao uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v fin_obrigacoes; v_ult date; i int := 0;
begin
  v := fin2_obter_obrigacao_para_alterar(p_org, p_unidade, p_obrigacao);
  if v.status <> 'aberta' then raise exception 'fin2_obrigacao_nao_aberta' using errcode = '23514'; end if;
  select max(data_pagamento) into v_ult from fin_pagamentos where obrigacao_id = v.id and status = 'ativo';
  if v_ult is null then raise exception 'fin2_quitacao_sem_pagamento: registre ao menos um pagamento antes de quitar' using errcode = '23514'; end if;
  -- (3ª revisão, M-2; reverificação NOVO-2) último pagamento num mês FECHADO: a diferença pertence ao mês da DECISÃO = o mês CORRENTE, se estiver
  -- aberto e for posterior ao pagamento. Só se não for (relógio anterior aos pagamentos ou mês corrente fechado) cai no 1º mês aberto seguinte.
  if exists (select 1 from fin_periodos pp where pp.unidade_id = p_unidade and pp.mes = date_trunc('month', v_ult)::date and pp.status = 'fechado')
     and current_date > v_ult
     and not exists (select 1 from fin_periodos pp where pp.unidade_id = p_unidade and pp.mes = date_trunc('month', current_date)::date and pp.status = 'fechado') then
    v_ult := current_date;
  end if;
  while exists (select 1 from fin_periodos pp where pp.unidade_id = p_unidade and pp.mes = date_trunc('month', v_ult)::date and pp.status = 'fechado') loop
    v_ult := (date_trunc('month', v_ult) + interval '1 month')::date; i := i + 1;
    if i > 240 then raise exception 'fin_periodo_fechado' using errcode = '23514'; end if;
  end loop;
  perform set_config('fin2.obrigacao_op', v.id::text, true);
  update fin_pagamentos set provisorio = false, confirmado_por = p_usuario, confirmado_em = now(), atualizado_por = p_usuario
   where obrigacao_id = v.id and organizacao_id = p_org and unidade_id = p_unidade and status = 'ativo' and provisorio;
  update fin_obrigacoes set status = 'quitada', data_quitacao = v_ult, quitada_por = p_usuario, quitada_em = now(), motivo_reversao = null,
         provisoria = false, confirmada_por = coalesce(confirmada_por, p_usuario), confirmada_em = coalesce(confirmada_em, now()), atualizado_por = p_usuario
   where id = v.id returning * into v;
  perform set_config('fin2.obrigacao_op', '', true);
  return to_jsonb(v);
end $$;

create or replace function fin_obrigacao_desfazer_quitacao(p_org uuid, p_unidade uuid, p_usuario uuid, p_obrigacao uuid, p_motivo text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v fin_obrigacoes;
begin
  if p_motivo is null or length(btrim(p_motivo)) < 10 then raise exception 'fin2_motivo_obrigatorio' using errcode = '23514'; end if;
  v := fin2_obter_obrigacao_para_alterar(p_org, p_unidade, p_obrigacao);
  if v.status <> 'quitada' then raise exception 'fin2_obrigacao_nao_quitada' using errcode = '23514'; end if;
  perform set_config('fin2.obrigacao_op', v.id::text, true);
  update fin_obrigacoes set status = 'aberta', data_quitacao = null, quitada_por = null, quitada_em = null,
         classificacao_diferenca = null, classificada_por = null, classificada_em = null, motivo_reversao = btrim(p_motivo), atualizado_por = p_usuario
   where id = v.id returning * into v;
  perform set_config('fin2.obrigacao_op', '', true);
  return to_jsonb(v);
end $$;

-- Classificar a diferença (Σ pagamentos − original) da obrigação QUITADA. Sinal decide o que é aceito:
--   > 0 → juros | multa | tarifa | outro  (null = volta a "juros/acréscimo presumido");   < 0 → desconto (null = "a verificar");   = 0 → nada a classificar.
create or replace function fin_obrigacao_classificar(p_org uuid, p_unidade uuid, p_usuario uuid, p_obrigacao uuid, p_classificacao text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v fin_obrigacoes; v_dif bigint;
begin
  v := fin2_obter_obrigacao_para_alterar(p_org, p_unidade, p_obrigacao);
  if v.status <> 'quitada' then raise exception 'fin2_obrigacao_nao_quitada: so a obrigacao quitada tem diferenca a classificar' using errcode = '23514'; end if;
  select coalesce(sum(valor_centavos), 0) - v.valor_original_centavos into v_dif from fin_pagamentos where obrigacao_id = v.id and status = 'ativo';
  if v_dif = 0 then raise exception 'fin2_sem_diferenca' using errcode = '23514'; end if;
  if p_classificacao is not null and ((v_dif > 0 and p_classificacao not in ('juros', 'multa', 'tarifa', 'outro')) or (v_dif < 0 and p_classificacao <> 'desconto')) then
    raise exception 'fin2_classificacao_incompativel: acrescimo aceita juros/multa/tarifa/outro; pagamento a menor aceita apenas desconto' using errcode = '23514';
  end if;
  perform set_config('fin2.obrigacao_op', v.id::text, true);
  update fin_obrigacoes set classificacao_diferenca = p_classificacao,
         classificada_por = case when p_classificacao is null then null else p_usuario end,
         classificada_em = case when p_classificacao is null then null else now() end, atualizado_por = p_usuario
   where id = v.id returning * into v;
  perform set_config('fin2.obrigacao_op', '', true);
  return to_jsonb(v);
end $$;

create or replace function fin_obrigacao_confirmar_registro(p_org uuid, p_unidade uuid, p_usuario uuid, p_obrigacao uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v fin_obrigacoes;
begin
  v := fin2_obter_obrigacao_para_alterar(p_org, p_unidade, p_obrigacao);
  if v.status = 'cancelada' then raise exception 'fin2_obrigacao_cancelada_imutavel' using errcode = '23514'; end if;
  perform set_config('fin2.obrigacao_op', v.id::text, true);
  update fin_pagamentos set provisorio = false, confirmado_por = p_usuario, confirmado_em = now(), atualizado_por = p_usuario
   where obrigacao_id = v.id and organizacao_id = p_org and unidade_id = p_unidade and status = 'ativo' and provisorio;
  if v.provisoria then
    update fin_obrigacoes set provisoria = false, confirmada_por = p_usuario, confirmada_em = now(), atualizado_por = p_usuario where id = v.id returning * into v;
  end if;
  perform set_config('fin2.obrigacao_op', '', true);
  return to_jsonb(v);
end $$;

create or replace function fin_obrigacao_cancelar(p_org uuid, p_unidade uuid, p_usuario uuid, p_obrigacao uuid, p_motivo text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare v fin_obrigacoes;
begin
  if p_motivo is null or length(btrim(p_motivo)) < 10 then raise exception 'fin2_motivo_obrigatorio' using errcode = '23514'; end if;
  v := fin2_obter_obrigacao_para_alterar(p_org, p_unidade, p_obrigacao);
  if v.status = 'cancelada' then return to_jsonb(v); end if;
  if v.status <> 'aberta' then raise exception 'fin2_obrigacao_nao_aberta: desfaca a quitacao antes de cancelar' using errcode = '23514'; end if;
  if exists (select 1 from fin_pagamentos where obrigacao_id = v.id and status = 'ativo') then
    raise exception 'fin2_obrigacao_com_pagamento: cancele os pagamentos antes de cancelar a obrigacao' using errcode = '23514';
  end if;
  perform set_config('fin2.obrigacao_op', v.id::text, true);
  update fin_obrigacoes set status = 'cancelada', motivo_cancelamento = btrim(p_motivo), cancelada_por = p_usuario, cancelada_em = now(), atualizado_por = p_usuario
   where id = v.id returning * into v;
  perform set_config('fin2.obrigacao_op', '', true);
  return to_jsonb(v);
end $$;

-- Confirmar um GRUPO de vínculos (ação humana). Fora da tolerância (R$ 0,01 / 1 dia) exige justificativa (≥ 10 caracteres).
-- Grava a EVIDÊNCIA: identificadores do lançamento do extrato (id, chave de origem, importação, referência) e dos pagamentos.
create or replace function fin_conciliacao_saida_confirmar(p_org uuid, p_unidade uuid, p_usuario uuid, p_grupo uuid, p_justificativa text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare n int; v_lanc fin_lancamentos; v_pag bigint; v_dias int; v_dif bigint; v_ev jsonb; v_outra_conta boolean; v_just text := nullif(btrim(coalesce(p_justificativa, '')), '');
begin
  perform 1 from fin_conciliacao_saidas where grupo = p_grupo and organizacao_id = p_org and unidade_id = p_unidade for update;
  select count(*) into n from fin_conciliacao_saidas where grupo = p_grupo and organizacao_id = p_org and unidade_id = p_unidade and status in ('sugerido', 'divergente');
  if n = 0 then raise exception 'fin2_vinculo_nao_encontrado' using errcode = 'P0002'; end if;
  if exists (select 1 from fin_conciliacao_saidas where grupo = p_grupo and organizacao_id = p_org and unidade_id = p_unidade and status not in ('sugerido', 'divergente', 'rejeitado')) then
    raise exception 'fin2_transicao_invalida' using errcode = '23514';
  end if;
  if (select count(distinct lancamento_id) from fin_conciliacao_saidas where grupo = p_grupo and organizacao_id = p_org and unidade_id = p_unidade and status in ('sugerido', 'divergente')) <> 1 then
    raise exception 'fin2_grupo_invalido: um grupo concilia exatamente uma saida do extrato' using errcode = '23514';
  end if;
  select l.* into v_lanc from fin_lancamentos l where l.organizacao_id = p_org and l.unidade_id = p_unidade
     and l.id = (select lancamento_id from fin_conciliacao_saidas where grupo = p_grupo and organizacao_id = p_org and unidade_id = p_unidade and status in ('sugerido', 'divergente') limit 1);
  select sum(s.valor_alocado_centavos), max(abs(p.data_pagamento - v_lanc.data_movimento)), bool_or(p.conta_id <> v_lanc.conta_id)
    into v_pag, v_dias, v_outra_conta
    from fin_conciliacao_saidas s join fin_pagamentos p on p.id = s.pagamento_id
   where s.grupo = p_grupo and s.organizacao_id = p_org and s.unidade_id = p_unidade and p.organizacao_id = p_org and p.unidade_id = p_unidade
     and s.status in ('sugerido', 'divergente');
  v_dif := v_lanc.valor_centavos - v_pag;
  -- (revisão #6) pagamento registrado numa conta e saída em OUTRA conta: também exige justificativa (ex.: conta registrada errada)
  if (abs(v_dif) > fin2_tolerancia_centavos() or v_dias > fin2_tolerancia_dias() or v_outra_conta) and (v_just is null or length(v_just) < 10) then
    raise exception 'fin2_justificativa_obrigatoria: diferenca de valor, data ou conta fora da tolerancia exige justificativa' using errcode = '23514';
  end if;
  v_ev := jsonb_build_object(
    'lancamento', jsonb_build_object('id', v_lanc.id, 'contaId', v_lanc.conta_id, 'data', v_lanc.data_movimento, 'valorCentavos', v_lanc.valor_centavos,
                                     'descricao', v_lanc.descricao, 'origem', v_lanc.origem, 'chaveOrigem', v_lanc.chave_origem,
                                     'importacaoId', v_lanc.importacao_id, 'referenciaOrigem', v_lanc.referencia_origem),
    'pagamentos', (select jsonb_agg(jsonb_build_object('id', p.id, 'obrigacaoId', p.obrigacao_id, 'data', p.data_pagamento, 'valorCentavos', p.valor_centavos, 'contaId', p.conta_id) order by p.id)
                     from fin_conciliacao_saidas s join fin_pagamentos p on p.id = s.pagamento_id
                    where s.grupo = p_grupo and s.organizacao_id = p_org and s.unidade_id = p_unidade and s.status in ('sugerido', 'divergente')),
    'diferencaCentavos', v_dif, 'diasDiferenca', v_dias, 'contaDiferente', coalesce(v_outra_conta, false), 'toleranciaCentavos', fin2_tolerancia_centavos(), 'toleranciaDias', fin2_tolerancia_dias(),
    'confirmadoPor', p_usuario, 'confirmadoEm', now());
  perform set_config('fin2.conciliacao_op', p_grupo::text, true);
  update fin_conciliacao_saidas set status = 'conciliado', confirmado_por = p_usuario, confirmado_em = now(), justificativa = v_just, evidencia = v_ev, atualizado_por = p_usuario
   where grupo = p_grupo and organizacao_id = p_org and unidade_id = p_unidade and status in ('sugerido', 'divergente');
  perform set_config('fin2.conciliacao_op', '', true);
  return v_ev;
end $$;

create or replace function fin_conciliacao_saida_revogar(p_org uuid, p_unidade uuid, p_usuario uuid, p_grupo uuid, p_motivo text) returns int
language plpgsql set search_path = public, pg_temp as $$
declare n int;
begin
  if p_motivo is null or length(btrim(p_motivo)) < 10 then raise exception 'fin2_motivo_obrigatorio' using errcode = '23514'; end if;
  perform 1 from fin_conciliacao_saidas where grupo = p_grupo and organizacao_id = p_org and unidade_id = p_unidade for update;
  perform set_config('fin2.conciliacao_op', p_grupo::text, true);
  update fin_conciliacao_saidas set status = 'revogado', revogado_por = p_usuario, revogado_em = now(), motivo_revogacao = btrim(p_motivo), atualizado_por = p_usuario
   where grupo = p_grupo and organizacao_id = p_org and unidade_id = p_unidade and status = 'conciliado';
  get diagnostics n = row_count;
  perform set_config('fin2.conciliacao_op', '', true);
  if n = 0 then raise exception 'fin2_vinculo_nao_encontrado' using errcode = 'P0002'; end if;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 7) Transferência de unidades (120 §5b): as tabelas novas com unidade_id entram na lista explícita (a guarda as conta).
-- ---------------------------------------------------------------------
create or replace function public.gestao_financeira_tabelas_da_unidade() returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array[
    'gestao_financeira_concessoes', 'gestao_financeira_concessoes_auditoria',                                     -- 120
    'fin_contas', 'fin_saldos_abertura', 'fin_lancamentos', 'fin_transferencias', 'fin_periodos', 'fin_importacoes',
    'fin_auditoria',                                                                                              -- 121
    'fin_referencias', 'fin_conciliacao_resolucoes', 'fin_sangria_excecoes', 'fin_excecoes_fechamento',           -- 122
    'fin_obrigacoes', 'fin_pagamentos', 'fin_conciliacao_saidas'                                                  -- 151
  ]::text[]
$$;

-- 151: a guarda da 120 monta a mensagem com um RÓTULO por tabela; sem rótulo, `texto || null` anulava a lista inteira e a guarda
-- deixava a transferência PASSAR em silêncio (achado da prova I08). Rótulos das tabelas novas + coalesce defensivo. Corpo idêntico ao da 120 no resto.
create or replace function public.gestao_financeira_verificar_unidade_transferivel(p_unidade_id uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_tabela text; v_oid regclass; v_qtd bigint; v_achados text := ''; v_ignora_rls boolean;
  v_rotulo constant jsonb := jsonb_build_object(
    'gestao_financeira_concessoes', 'concessões de acesso', 'gestao_financeira_concessoes_auditoria', 'auditoria de concessões',
    'fin_contas', 'contas', 'fin_saldos_abertura', 'saldos de abertura', 'fin_lancamentos', 'lançamentos',
    'fin_transferencias', 'transferências', 'fin_periodos', 'períodos', 'fin_importacoes', 'importações',
    'fin_auditoria', 'auditoria financeira', 'fin_referencias', 'referências de conciliação',
    'fin_conciliacao_resolucoes', 'resoluções de conciliação', 'fin_sangria_excecoes', 'exceções de sangria',
    'fin_excecoes_fechamento', 'exceções de fechamento',
    'fin_obrigacoes', 'contas a pagar', 'fin_pagamentos', 'pagamentos', 'fin_conciliacao_saidas', 'conciliação de saídas');
begin
  if p_unidade_id is null then
    raise exception 'Unidade não informada.' using errcode = '22023';
  end if;
  -- A contagem abaixo precisa de um snapshot NOVO (tirado depois da trava): só READ COMMITTED garante isso dentro da transação.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Transferência/promoção de unidade exige isolamento READ COMMITTED (atual: %). Nada foi alterado.',
      current_setting('transaction_isolation') using errcode = '25001';
  end if;
  perform 1 from public.unidades where id = p_unidade_id for update;
  select r.rolsuper or r.rolbypassrls into v_ignora_rls from pg_roles r where r.rolname = current_user;
  foreach v_tabela in array public.gestao_financeira_tabelas_da_unidade() loop
    v_oid := to_regclass('public.' || v_tabela);
    continue when v_oid is null;
    if not has_table_privilege(current_user, v_oid, 'select')
       or exists (select 1 from pg_class c where c.oid = v_oid and c.relrowsecurity and not coalesce(v_ignora_rls, false)
                    and (c.relforcerowsecurity or not pg_has_role(current_user, c.relowner, 'USAGE'))) then
      raise exception 'Não foi possível verificar o histórico financeiro da unidade (o papel % não lê % por inteiro). Nada foi alterado.',
        current_user, v_tabela using errcode = '42501';
    end if;
    execute format('select count(*) from public.%I where unidade_id = $1', v_tabela) into v_qtd using p_unidade_id;
    if v_qtd > 0 then
      v_achados := v_achados || case when v_achados = '' then '' else ', ' end || coalesce(v_rotulo ->> v_tabela, v_tabela) || ': ' || v_qtd;
    end if;
  end loop;
  if v_achados <> '' then
    raise exception 'Esta unidade possui registros no Financeiro (%) e não pode ser transferida nem promovida: o histórico financeiro pertence à empresa atual e não muda de empresa. Nada foi alterado.', v_achados
      using errcode = '22023';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 8) Privilégios: backend-only (mesmo modelo da 121). RLS ligada, NENHUMA policy, sem DELETE para o service_role.
-- ---------------------------------------------------------------------
do $$
declare t text; r text;
begin
  foreach t in array array['fin_fornecedores', 'fin_obrigacoes', 'fin_pagamentos', 'fin_conciliacao_saidas'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from public', t);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table %I from %I', t, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on table %I from service_role', t);
      execute format('grant select, insert, update on table %I to service_role', t);
    end if;
  end loop;
  -- RPCs: só o service_role executa
  foreach t in array array['fin_obrigacao_quitar(uuid,uuid,uuid,uuid)', 'fin_obrigacao_desfazer_quitacao(uuid,uuid,uuid,uuid,text)',
                           'fin_obrigacao_classificar(uuid,uuid,uuid,uuid,text)', 'fin_obrigacao_confirmar_registro(uuid,uuid,uuid,uuid)',
                           'fin_obrigacao_cancelar(uuid,uuid,uuid,uuid,text)', 'fin_conciliacao_saida_confirmar(uuid,uuid,uuid,uuid,text)',
                           'fin_conciliacao_saida_revogar(uuid,uuid,uuid,uuid,text)', 'fin2_bloqueios_fechamento(uuid,uuid,date)',
                           'fin2_tolerancia_centavos()', 'fin2_tolerancia_dias()'] loop
    execute format('revoke all on function %s from public', t);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', t, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', t); end if;
  end loop;
  -- funções auxiliares e de gatilho: ninguém as chama diretamente (os gatilhos rodam com o papel de quem escreve; não exigem EXECUTE)
  foreach t in array array['fin2_travar_meses(uuid,uuid,date[])', 'fin2_obter_obrigacao_para_alterar(uuid,uuid,uuid)', 'fin_fornecedores_guarda()',
                           'fin_obrigacoes_guarda()', 'fin_pagamentos_guarda()', 'fin_conciliacao_saidas_guarda()', 'fin2_lancamentos_vinculo_saida()',
                           'fin2_periodos_bloqueia_fechamento()'] loop
    execute format('revoke all on function %s from public', t);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', t, r); end if;
    end loop;
  end loop;
end $$;
-- as RPCs chamam funções auxiliares como o papel do chamador (service_role): ele precisa de EXECUTE nelas
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function fin2_travar_meses(uuid,uuid,date[]), fin2_obter_obrigacao_para_alterar(uuid,uuid,uuid) to service_role;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 9) PÓS-CONDIÇÕES (falha segura): RLS ligada, zero policies, anon/authenticated sem acesso, service_role sem DELETE; lista de unidade completa.
-- ---------------------------------------------------------------------
do $$
declare t text; r text; n int; v_fora text;
begin
  foreach t in array array['fin_fornecedores', 'fin_obrigacoes', 'fin_pagamentos', 'fin_conciliacao_saidas'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception 'MIGRATION 151 abortada: RLS desligado em %.', t; end if;
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) and has_any_column_privilege(r, ('public.' || t)::regclass, 'select,insert,update,references') then
        raise exception 'MIGRATION 151 abortada: % ainda tem acesso a %.', r, t;
      end if;
    end loop;
    select count(*) into n from pg_policies where schemaname = 'public' and tablename = t;
    if n > 0 then raise exception 'MIGRATION 151 abortada: % possui policy.', t; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') and has_table_privilege('service_role', ('public.' || t)::regclass, 'delete') then
      raise exception 'MIGRATION 151 abortada: service_role tem DELETE em %.', t;
    end if;
    -- (revisão #11) privilégios de tabela que has_any_column_privilege não cobre
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) and (has_table_privilege(r, ('public.' || t)::regclass, 'truncate')
         or has_table_privilege(r, ('public.' || t)::regclass, 'trigger') or has_table_privilege(r, ('public.' || t)::regclass, 'references')
         or (r <> 'service_role' and has_table_privilege(r, ('public.' || t)::regclass, 'delete'))) then
        raise exception 'MIGRATION 151 abortada: % tem TRUNCATE/TRIGGER/REFERENCES/DELETE em %.', r, t;
      end if;
    end loop;
  end loop;
  -- (revisão #11) nenhuma função nova executável por anon/authenticated (inclui PUBLIC)
  select string_agg(p.proname || '/' || pp.papel, ', ') into v_fora
    from pg_proc p cross join unnest(array['anon', 'authenticated']) as pp(papel)
   where p.pronamespace = 'public'::regnamespace and exists (select 1 from pg_roles where rolname = pp.papel)
     and (p.proname like 'fin2\_%' or p.proname like 'fin\_obrigac%' or p.proname like 'fin\_conciliacao\_saida%'
          or p.proname in ('fin_fornecedores_guarda', 'fin_obrigacoes_guarda', 'fin_pagamentos_guarda'))
     and has_function_privilege(pp.papel, p.oid, 'execute');
  if v_fora is not null then raise exception 'MIGRATION 151 abortada: funcoes novas executaveis por anon/authenticated: %', v_fora; end if;
  -- (revisão #11) os gatilhos de integridade existem e estão habilitados
  select string_agg(x.tab || '.' || x.trg, ', ') into v_fora from (values
      ('fin_fornecedores', 'trg_fin_fornecedores_guarda'), ('fin_fornecedores', 'trg_fin_fornecedores_auditar'), ('fin_fornecedores', 'trg_fin_fornecedores_upd'),
      ('fin_obrigacoes', 'trg_fin_obrigacoes_guarda'), ('fin_obrigacoes', 'trg_fin_obrigacoes_auditar'), ('fin_obrigacoes', 'trg_fin_obrigacoes_escopo'), ('fin_obrigacoes', 'trg_fin_obrigacoes_upd'),
      ('fin_pagamentos', 'trg_fin_pagamentos_guarda'), ('fin_pagamentos', 'trg_fin_pagamentos_periodo'), ('fin_pagamentos', 'trg_fin_pagamentos_auditar'),
      ('fin_pagamentos', 'trg_fin_pagamentos_escopo'), ('fin_pagamentos', 'trg_fin_pagamentos_upd'),
      ('fin_conciliacao_saidas', 'trg_fin_conciliacao_saidas_guarda'), ('fin_conciliacao_saidas', 'trg_fin_conciliacao_saidas_auditar'),
      ('fin_conciliacao_saidas', 'trg_fin_conciliacao_saidas_escopo'), ('fin_conciliacao_saidas', 'trg_fin_conciliacao_saidas_upd'),
      ('fin_lancamentos', 'trg_fin2_lancamentos_vinculo_saida'), ('fin_periodos', 'trg_fin2_periodos_bloqueia_fechamento')) as x(tab, trg)
   where not exists (select 1 from pg_trigger g where g.tgrelid = ('public.' || x.tab)::regclass and g.tgname = x.trg and not g.tgisinternal and g.tgenabled = 'O');
  if v_fora is not null then raise exception 'MIGRATION 151 abortada: gatilhos ausentes ou desabilitados: %', v_fora; end if;
  select string_agg(c.relname, ', ' order by c.relname) into v_fora
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and (c.relname like 'fin\_%' or c.relname like 'gestao\_financeira\_%')
     and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'unidade_id' and a.attnum > 0 and not a.attisdropped)
     and c.relname::text <> all (public.gestao_financeira_tabelas_da_unidade());
  if v_fora is not null then raise exception 'MIGRATION 151 abortada: tabelas financeiras fora da lista de transferencia: %', v_fora; end if;
end $$;
commit;
