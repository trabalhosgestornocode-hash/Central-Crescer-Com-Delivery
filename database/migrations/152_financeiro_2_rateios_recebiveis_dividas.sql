-- =====================================================================
-- 152 — Financeiro 2.0: RATEIOS por competência, CONTAS A RECEBER e DÍVIDAS/EMPRÉSTIMOS.
-- Estende 120/121/122/151 sem sistema paralelo: mesmo modelo de privilégios (backend-only, RLS sem policy, sem DELETE),
-- trava por competência (fin_guarda_periodo_data), trilha imutável (fin_auditar) e escopo de tenant (fin_validar_escopo).
--
--   • RATEIO distribui o CUSTO de uma conta a pagar entre competências (DRE de referência). NÃO altera pagamentos nem o extrato.
--     Σ parcelas = valor elegível ≤ valor original; gravado só por fin_rateio_definir (substitui o ativo, com histórico);
--     aprovar (fin_rateio_aprovar) é decisão da contadora — "proposto" é referência provisória, nunca definitivo.
--   • RECEBÍVEL é controle (origem, contraparte, previsto, recebido, pendente). Recebimento NÃO cria lançamento de caixa:
--     pode apenas apontar a entrada do extrato que já existe (conciliação) — sem duplicar vendas ou repasses.
--   • DÍVIDA separa natureza (própria, sócio, entre empresas, terceiros, tributária); eventos distinguem principal, juros e encargos;
--     saldo devedor informado é opcional e marcado como documentado ou não.
-- Idempotente. Rollback: 152_rollback.sql (recusa se houver dados).
-- =====================================================================
begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.fin_obrigacoes') is null or to_regclass('public.fin_pagamentos') is null
     or to_regprocedure('public.fin_periodo_travar_e_checar(uuid,uuid,date)') is null or to_regprocedure('public.fin_guarda_periodo_data()') is null
     or to_regprocedure('public.fin_auditar()') is null or to_regprocedure('public.fin_validar_escopo()') is null then
    raise exception 'MIGRATION 152 abortada: requer as migrations 120, 121, 122 e 151 aplicadas.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1) RATEIOS
-- ---------------------------------------------------------------------
create table if not exists fin_rateios (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  obrigacao_id uuid not null references fin_obrigacoes(id) on delete restrict,
  valor_elegivel_centavos bigint not null check (valor_elegivel_centavos > 0),
  competencia_origem date not null check (competencia_origem = date_trunc('month', competencia_origem)::date),
  criterio text not null check (criterio in ('dias_consumo', 'producao', 'outro')),
  justificativa text not null check (length(btrim(justificativa)) between 5 and 1000),
  origem_documental text check (origem_documental is null or length(origem_documental) <= 300),
  status text not null default 'proposto' check (status in ('proposto', 'aprovado', 'cancelado')),
  aprovado_por uuid, aprovado_em timestamptz,
  motivo_cancelamento text, cancelado_por uuid, cancelado_em timestamptz,
  origem text not null default 'manual' check (origem in ('manual', 'importacao')),
  chave_origem text,
  criado_por uuid, atualizado_por uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint fin_rat_aprovacao_completa check ((status = 'aprovado') = (aprovado_por is not null and aprovado_em is not null) or status = 'cancelado'),
  constraint fin_rat_cancelamento_completo check (status <> 'cancelado' or (cancelado_por is not null and cancelado_em is not null and length(btrim(coalesce(motivo_cancelamento, ''))) >= 5))
);
create unique index if not exists ux_fin_rateios_ativo on fin_rateios (obrigacao_id) where status <> 'cancelado';
create unique index if not exists ux_fin_rateios_chave on fin_rateios (organizacao_id, unidade_id, chave_origem) where chave_origem is not null and status <> 'cancelado';
create index if not exists ix_fin_rateios_unidade on fin_rateios (organizacao_id, unidade_id);

create table if not exists fin_rateio_parcelas (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  rateio_id uuid not null references fin_rateios(id) on delete restrict,
  competencia date not null check (competencia = date_trunc('month', competencia)::date),
  valor_centavos bigint not null check (valor_centavos > 0),
  criado_por uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (rateio_id, competencia)
);
create index if not exists ix_fin_rateio_parcelas_comp on fin_rateio_parcelas (organizacao_id, unidade_id, competencia);

-- parcelas e transições de rateio só pelas funções (flag local da transação)
create or replace function fin2_rateio_guarda() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('fin2.rateio_op', true), '') <> 'on' then
    raise exception 'fin2_rateio_via_funcao: rateios são gravados só por fin_rateio_definir/aprovar/cancelar' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id) then
    raise exception 'fin_campo_imutavel: organizacao e unidade nao mudam' using errcode = '23514';
  end if;
  if tg_table_name = 'fin_rateios' and tg_op = 'UPDATE' then
    -- (IF aninhado: o PL/pgSQL resolveria new.obrigacao_id mesmo no gatilho das parcelas)
    if to_jsonb(new)->'obrigacao_id' is distinct from to_jsonb(old)->'obrigacao_id' or to_jsonb(new)->'valor_elegivel_centavos' is distinct from to_jsonb(old)->'valor_elegivel_centavos' then
      raise exception 'fin_campo_imutavel: rateio não muda de obrigação nem de valor (cancele e defina outro)' using errcode = '23514';
    end if;
  end if;
  if tg_table_name = 'fin_rateio_parcelas' and tg_op = 'UPDATE' then
    raise exception 'fin_campo_imutavel: parcelas de rateio não são editadas (defina um novo rateio)' using errcode = '23514';
  end if;
  return new;
end $$;

-- Define (ou substitui) o rateio ATIVO de uma obrigação. p_parcelas = [{"competencia":"AAAA-MM-01","valorCentavos":123}, ...]
create or replace function fin_rateio_definir(p_org uuid, p_unidade uuid, p_usuario uuid, p_obrigacao uuid, p_valor_elegivel bigint,
  p_criterio text, p_justificativa text, p_origem_documental text, p_parcelas jsonb, p_chave text default null, p_origem text default 'manual') returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare o fin_obrigacoes; v_ant fin_rateios; v_id uuid; v_soma bigint := 0; v_qtd int := 0; v_p jsonb; v_comp date;
begin
  if current_setting('transaction_isolation') <> 'read committed' then raise exception 'fin2_isolamento_invalido: exige READ COMMITTED' using errcode = '25001'; end if;
  select * into o from fin_obrigacoes where id = p_obrigacao and organizacao_id = p_org and unidade_id = p_unidade for update;
  if not found then raise exception 'fin2_obrigacao_inexistente' using errcode = 'P0002'; end if;
  if o.status = 'cancelada' then raise exception 'fin2_rateio_obrigacao_cancelada: obrigação cancelada não é rateada' using errcode = '23514'; end if;
  if p_valor_elegivel is null or p_valor_elegivel <= 0 or p_valor_elegivel > o.valor_original_centavos then
    raise exception 'fin2_rateio_valor_invalido: valor elegível deve ser > 0 e ≤ valor original (%)', o.valor_original_centavos using errcode = '23514';
  end if;
  if jsonb_typeof(p_parcelas) <> 'array' or jsonb_array_length(p_parcelas) = 0 then raise exception 'fin2_rateio_sem_parcelas' using errcode = '23514'; end if;
  for v_p in select * from jsonb_array_elements(p_parcelas) loop
    v_comp := (v_p->>'competencia')::date;
    if v_comp is distinct from date_trunc('month', v_comp)::date or coalesce((v_p->>'valorCentavos')::bigint, 0) <= 0 then
      raise exception 'fin2_rateio_parcela_invalida: %', v_p using errcode = '23514';
    end if;
    v_soma := v_soma + (v_p->>'valorCentavos')::bigint; v_qtd := v_qtd + 1;
  end loop;
  if v_soma <> p_valor_elegivel then
    raise exception 'fin2_rateio_soma_divergente: Σ parcelas (%) ≠ valor elegível (%)', v_soma, p_valor_elegivel using errcode = '23514';
  end if;
  if (select count(distinct e->>'competencia') from jsonb_array_elements(p_parcelas) e) <> v_qtd then raise exception 'fin2_rateio_competencia_repetida' using errcode = '23514'; end if;
  perform set_config('fin2.rateio_op', 'on', true);
  select * into v_ant from fin_rateios where obrigacao_id = p_obrigacao and status <> 'cancelado' for update;
  if found then
    -- competências do rateio anterior também precisam estar abertas (o resultado delas muda)
    perform fin_periodo_travar_e_checar(p_org, p_unidade, pa.competencia) from fin_rateio_parcelas pa where pa.rateio_id = v_ant.id;
    update fin_rateios set status = 'cancelado', motivo_cancelamento = 'substituído por novo rateio', cancelado_por = p_usuario, cancelado_em = now(), atualizado_por = p_usuario where id = v_ant.id;
  end if;
  insert into fin_rateios(organizacao_id, unidade_id, obrigacao_id, valor_elegivel_centavos, competencia_origem, criterio, justificativa, origem_documental, origem, chave_origem, criado_por, atualizado_por)
    values (p_org, p_unidade, p_obrigacao, p_valor_elegivel, o.competencia, p_criterio, p_justificativa, p_origem_documental, coalesce(p_origem, 'manual'), p_chave, p_usuario, p_usuario)
    returning id into v_id;
  insert into fin_rateio_parcelas(organizacao_id, unidade_id, rateio_id, competencia, valor_centavos, criado_por)
    select p_org, p_unidade, v_id, (e->>'competencia')::date, (e->>'valorCentavos')::bigint, p_usuario from jsonb_array_elements(p_parcelas) e;
  perform set_config('fin2.rateio_op', 'off', true);
  return v_id;
end $$;

create or replace function fin_rateio_aprovar(p_org uuid, p_unidade uuid, p_usuario uuid, p_rateio uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  perform fin_periodo_travar_e_checar(p_org, p_unidade, pa.competencia) from fin_rateio_parcelas pa where pa.rateio_id = p_rateio;
  perform set_config('fin2.rateio_op', 'on', true);
  update fin_rateios set status = 'aprovado', aprovado_por = p_usuario, aprovado_em = now(), atualizado_por = p_usuario
   where id = p_rateio and organizacao_id = p_org and unidade_id = p_unidade and status = 'proposto';
  if not found then raise exception 'fin2_rateio_nao_aprovavel: inexistente ou não está proposto' using errcode = 'P0002'; end if;
  perform set_config('fin2.rateio_op', 'off', true);
end $$;

create or replace function fin_rateio_cancelar(p_org uuid, p_unidade uuid, p_usuario uuid, p_rateio uuid, p_motivo text) returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  if length(btrim(coalesce(p_motivo, ''))) < 5 then raise exception 'fin2_motivo_obrigatorio' using errcode = '23514'; end if;
  perform fin_periodo_travar_e_checar(p_org, p_unidade, pa.competencia) from fin_rateio_parcelas pa where pa.rateio_id = p_rateio;
  perform set_config('fin2.rateio_op', 'on', true);
  update fin_rateios set status = 'cancelado', motivo_cancelamento = p_motivo, cancelado_por = p_usuario, cancelado_em = now(), atualizado_por = p_usuario
   where id = p_rateio and organizacao_id = p_org and unidade_id = p_unidade and status <> 'cancelado';
  if not found then raise exception 'fin2_rateio_inexistente' using errcode = 'P0002'; end if;
  perform set_config('fin2.rateio_op', 'off', true);
end $$;

-- ---------------------------------------------------------------------
-- 2) CONTAS A RECEBER
-- ---------------------------------------------------------------------
create table if not exists fin_recebiveis (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  origem text not null check (origem in ('venda', 'repasse', 'reembolso', 'emprestimo_concedido', 'outro')),
  contraparte text not null check (length(btrim(contraparte)) between 1 and 120),
  descricao text check (descricao is null or length(descricao) <= 300),
  competencia date not null check (competencia = date_trunc('month', competencia)::date),
  valor_original_centavos bigint not null check (valor_original_centavos > 0),
  previsao date,
  conta_id uuid references fin_contas(id) on delete restrict,          -- conta de destino prevista
  status text not null default 'aberto' check (status in ('aberto', 'cancelado')),
  motivo_cancelamento text, cancelado_por uuid, cancelado_em timestamptz,
  origem_registro text not null default 'manual' check (origem_registro in ('manual', 'importacao')),
  chave_origem text, observacoes text check (observacoes is null or length(observacoes) <= 1000),
  criado_por uuid, atualizado_por uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint fin_rec_cancelamento_completo check (status <> 'cancelado' or (cancelado_por is not null and cancelado_em is not null and length(btrim(coalesce(motivo_cancelamento, ''))) >= 5))
);
create unique index if not exists ux_fin_recebiveis_chave on fin_recebiveis (organizacao_id, unidade_id, chave_origem) where chave_origem is not null;
create index if not exists ix_fin_recebiveis_unidade on fin_recebiveis (organizacao_id, unidade_id, competencia);

create table if not exists fin_recebimentos (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  recebivel_id uuid not null references fin_recebiveis(id) on delete restrict,
  data date not null,
  valor_centavos bigint not null check (valor_centavos > 0),
  conta_id uuid not null references fin_contas(id) on delete restrict,
  lancamento_id uuid references fin_lancamentos(id) on delete restrict,   -- entrada do extrato JÁ existente (conciliação); nunca cria caixa
  status text not null default 'ativo' check (status in ('ativo', 'cancelado')),
  motivo_cancelamento text, cancelado_por uuid, cancelado_em timestamptz,
  observacao text check (observacao is null or length(observacao) <= 1000),
  criado_por uuid, atualizado_por uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint fin_rcb_cancelamento_completo check (status <> 'cancelado' or (cancelado_por is not null and cancelado_em is not null and length(btrim(coalesce(motivo_cancelamento, ''))) >= 5))
);
create index if not exists ix_fin_recebimentos_rec on fin_recebimentos (recebivel_id);

create or replace function fin2_recebimentos_guarda() returns trigger language plpgsql as $$
declare r fin_recebiveis; l fin_lancamentos; v_total bigint;
begin
  if current_setting('transaction_isolation') <> 'read committed' then raise exception 'fin2_isolamento_invalido: exige READ COMMITTED' using errcode = '25001'; end if;
  if tg_op = 'UPDATE' and (new.recebivel_id is distinct from old.recebivel_id or new.valor_centavos is distinct from old.valor_centavos or new.data is distinct from old.data
       or new.conta_id is distinct from old.conta_id or new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id) then
    raise exception 'fin_campo_imutavel: recebimento não muda valor, data, conta nem recebível (cancele e registre outro)' using errcode = '23514';
  end if;
  select * into r from fin_recebiveis where id = new.recebivel_id for update;
  if r.organizacao_id <> new.organizacao_id or r.unidade_id <> new.unidade_id then raise exception 'fin_escopo_invalido: recebível de outro tenant' using errcode = '23514'; end if;
  if new.status = 'ativo' and r.status = 'cancelado' then raise exception 'fin2_recebivel_cancelado' using errcode = '23514'; end if;
  if new.lancamento_id is not null then
    select * into l from fin_lancamentos where id = new.lancamento_id;
    if l.organizacao_id <> new.organizacao_id or l.unidade_id <> new.unidade_id or l.sentido <> 'entrada' or l.conta_id <> new.conta_id or l.status <> 'realizado' then
      raise exception 'fin2_recebimento_lancamento_invalido: a entrada do extrato precisa ser realizada, da mesma conta e unidade' using errcode = '23514';
    end if;
    if (select coalesce(sum(valor_centavos), 0) from fin_recebimentos where lancamento_id = new.lancamento_id and status = 'ativo' and id <> new.id) + new.valor_centavos > l.valor_centavos + 1 then
      raise exception 'fin2_recebimento_excede_entrada: recebimentos vinculados somariam mais que a entrada do extrato' using errcode = '23514';
    end if;
  end if;
  select coalesce(sum(valor_centavos), 0) into v_total from fin_recebimentos where recebivel_id = new.recebivel_id and status = 'ativo' and id <> new.id;
  if new.status = 'ativo' and v_total + new.valor_centavos > r.valor_original_centavos + 1 then
    raise exception 'fin2_recebimento_excede_recebivel: recebido (%) passaria do valor original (%)', v_total + new.valor_centavos, r.valor_original_centavos using errcode = '23514';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 3) DÍVIDAS E EMPRÉSTIMOS
-- ---------------------------------------------------------------------
create table if not exists fin_dividas (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  natureza text not null check (natureza in ('propria', 'socio', 'entre_empresas', 'terceiros', 'tributaria')),
  credor text not null check (length(btrim(credor)) between 1 and 120),
  descricao text check (descricao is null or length(descricao) <= 300),
  valor_original_centavos bigint check (valor_original_centavos is null or valor_original_centavos > 0),   -- desconhecido = null (nunca zero)
  data_contratacao date,
  parcelas_total int check (parcelas_total is null or parcelas_total > 0),
  valor_parcela_centavos bigint check (valor_parcela_centavos is null or valor_parcela_centavos > 0),
  parcelas_pagas_antes int check (parcelas_pagas_antes is null or parcelas_pagas_antes >= 0),
  saldo_informado_centavos bigint check (saldo_informado_centavos is null or saldo_informado_centavos >= 0),
  saldo_informado_em date,
  documentada boolean not null default false,
  pendencia_documental text check (pendencia_documental is null or length(pendencia_documental) <= 500),
  entra_pe_financeiro boolean not null default false,
  status text not null default 'ativa' check (status in ('ativa', 'quitada', 'cancelada')),
  origem text not null default 'manual' check (origem in ('manual', 'importacao')),
  chave_origem text, observacoes text check (observacoes is null or length(observacoes) <= 1000),
  criado_por uuid, atualizado_por uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint fin_div_saldo_com_data check ((saldo_informado_centavos is null) = (saldo_informado_em is null))
);
create unique index if not exists ux_fin_dividas_chave on fin_dividas (organizacao_id, unidade_id, chave_origem) where chave_origem is not null;

create table if not exists fin_divida_eventos (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  divida_id uuid not null references fin_dividas(id) on delete restrict,
  data date not null,
  tipo text not null check (tipo in ('captacao', 'amortizacao', 'juros', 'encargo', 'retencao', 'reembolso', 'envio', 'recebimento', 'outro')),
  principal_centavos bigint not null default 0 check (principal_centavos >= 0),
  juros_centavos bigint not null default 0 check (juros_centavos >= 0),
  encargos_centavos bigint not null default 0 check (encargos_centavos >= 0),
  parcela_numero int check (parcela_numero is null or parcela_numero > 0),
  lancamento_id uuid references fin_lancamentos(id) on delete restrict,
  pagamento_id uuid references fin_pagamentos(id) on delete restrict,
  status text not null default 'ativo' check (status in ('ativo', 'cancelado')),
  motivo_cancelamento text, cancelado_por uuid, cancelado_em timestamptz,
  chave_origem text, observacao text check (observacao is null or length(observacao) <= 1000),
  criado_por uuid, atualizado_por uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint fin_dev_valor_positivo check (principal_centavos + juros_centavos + encargos_centavos > 0),
  constraint fin_dev_cancelamento_completo check (status <> 'cancelado' or (cancelado_por is not null and cancelado_em is not null and length(btrim(coalesce(motivo_cancelamento, ''))) >= 5))
);
create unique index if not exists ux_fin_divida_eventos_chave on fin_divida_eventos (organizacao_id, unidade_id, chave_origem) where chave_origem is not null;
create index if not exists ix_fin_divida_eventos_div on fin_divida_eventos (divida_id, data);

create or replace function fin2_divida_eventos_guarda() returns trigger language plpgsql as $$
declare d fin_dividas;
begin
  if tg_op = 'UPDATE' and (new.divida_id is distinct from old.divida_id or new.data is distinct from old.data or new.principal_centavos is distinct from old.principal_centavos
       or new.juros_centavos is distinct from old.juros_centavos or new.encargos_centavos is distinct from old.encargos_centavos or new.tipo is distinct from old.tipo
       or new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id) then
    raise exception 'fin_campo_imutavel: evento de dívida não muda valores, data nem tipo (cancele e registre outro)' using errcode = '23514';
  end if;
  select * into d from fin_dividas where id = new.divida_id;
  if d.organizacao_id <> new.organizacao_id or d.unidade_id <> new.unidade_id then raise exception 'fin_escopo_invalido: dívida de outro tenant' using errcode = '23514'; end if;
  if new.lancamento_id is not null and not exists (select 1 from fin_lancamentos l where l.id = new.lancamento_id and l.organizacao_id = new.organizacao_id and l.unidade_id = new.unidade_id) then
    raise exception 'fin_escopo_invalido: lançamento de outro tenant' using errcode = '23514';
  end if;
  if new.pagamento_id is not null and not exists (select 1 from fin_pagamentos p where p.id = new.pagamento_id and p.organizacao_id = new.organizacao_id and p.unidade_id = new.unidade_id) then
    raise exception 'fin_escopo_invalido: pagamento de outro tenant' using errcode = '23514';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 4) Gatilhos: escopo, trava por competência, trilha, updated_at, guardas
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['fin_rateios', 'fin_rateio_parcelas', 'fin_recebiveis', 'fin_recebimentos', 'fin_dividas', 'fin_divida_eventos'] loop
    execute format('drop trigger if exists trg_%1$s_auditar on %1$s', t);
    execute format('create trigger trg_%1$s_auditar after insert or update or delete on %1$s for each row execute function fin_auditar()', t);
    execute format('drop trigger if exists trg_%1$s_upd on %1$s', t);
    execute format('create trigger trg_%1$s_upd before update on %1$s for each row execute function fin_touch_updated_at()', t);
    execute format('drop trigger if exists trg_%1$s_escopo on %1$s', t);
    execute format('create trigger trg_%1$s_escopo before insert or update on %1$s for each row execute function fin_validar_escopo()', t);
  end loop;
end $$;
drop trigger if exists trg_fin_rateios_guarda on fin_rateios;
create trigger trg_fin_rateios_guarda before insert or update or delete on fin_rateios for each row execute function fin2_rateio_guarda();
drop trigger if exists trg_fin_rateio_parcelas_guarda on fin_rateio_parcelas;
create trigger trg_fin_rateio_parcelas_guarda before insert or update or delete on fin_rateio_parcelas for each row execute function fin2_rateio_guarda();
drop trigger if exists trg_fin_rateio_parcelas_periodo on fin_rateio_parcelas;
create trigger trg_fin_rateio_parcelas_periodo before insert or update or delete on fin_rateio_parcelas for each row execute function fin_guarda_periodo_data('competencia');
drop trigger if exists trg_fin_recebimentos_guarda on fin_recebimentos;
create trigger trg_fin_recebimentos_guarda before insert or update on fin_recebimentos for each row execute function fin2_recebimentos_guarda();
drop trigger if exists trg_fin_recebimentos_periodo on fin_recebimentos;
create trigger trg_fin_recebimentos_periodo before insert or update or delete on fin_recebimentos for each row execute function fin_guarda_periodo_data('data');
drop trigger if exists trg_fin_divida_eventos_guarda on fin_divida_eventos;
create trigger trg_fin_divida_eventos_guarda before insert or update on fin_divida_eventos for each row execute function fin2_divida_eventos_guarda();
drop trigger if exists trg_fin_divida_eventos_periodo on fin_divida_eventos;
create trigger trg_fin_divida_eventos_periodo before insert or update or delete on fin_divida_eventos for each row execute function fin_guarda_periodo_data('data');

-- ---------------------------------------------------------------------
-- 5) Transferência de unidades: tabelas novas com unidade_id entram na lista (a guarda as conta; rótulo = nome da tabela)
-- ---------------------------------------------------------------------
create or replace function public.gestao_financeira_tabelas_da_unidade() returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array[
    'gestao_financeira_concessoes', 'gestao_financeira_concessoes_auditoria',                                     -- 120
    'fin_contas', 'fin_saldos_abertura', 'fin_lancamentos', 'fin_transferencias', 'fin_periodos', 'fin_importacoes',
    'fin_auditoria',                                                                                              -- 121
    'fin_referencias', 'fin_conciliacao_resolucoes', 'fin_sangria_excecoes', 'fin_excecoes_fechamento',           -- 122
    'fin_obrigacoes', 'fin_pagamentos', 'fin_conciliacao_saidas',                                                 -- 151
    'fin_rateios', 'fin_rateio_parcelas', 'fin_recebiveis', 'fin_recebimentos', 'fin_dividas', 'fin_divida_eventos' -- 152
  ]::text[]
$$;

-- ---------------------------------------------------------------------
-- 6) Privilégios: backend-only. RLS ligada, NENHUMA policy, sem DELETE.
-- ---------------------------------------------------------------------
do $$
declare t text; r text;
begin
  foreach t in array array['fin_rateios', 'fin_rateio_parcelas', 'fin_recebiveis', 'fin_recebimentos', 'fin_dividas', 'fin_divida_eventos'] loop
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
  foreach t in array array['fin_rateio_definir(uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb,text,text)', 'fin_rateio_aprovar(uuid,uuid,uuid,uuid)',
                           'fin_rateio_cancelar(uuid,uuid,uuid,uuid,text)', 'fin2_rateio_guarda()', 'fin2_recebimentos_guarda()', 'fin2_divida_eventos_guarda()'] loop
    execute format('revoke all on function %s from public', t);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', t, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') and t like 'fin_rateio_%' then execute format('grant execute on function %s to service_role', t); end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 7) Pós-condições
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['fin_rateios', 'fin_rateio_parcelas', 'fin_recebiveis', 'fin_recebimentos', 'fin_dividas', 'fin_divida_eventos'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception '152 pós-condição: RLS desligada em %', t; end if;
    if exists (select 1 from pg_policies where tablename = t) then raise exception '152 pós-condição: % tem policy', t; end if;
    if t <> all (public.gestao_financeira_tabelas_da_unidade()) then raise exception '152 pós-condição: % fora da guarda de transferência', t; end if;
    if exists (select 1 from pg_roles where rolname = 'anon') and has_table_privilege('anon', 'public.' || t, 'select') then raise exception '152 pós-condição: anon lê %', t; end if;
  end loop;
end $$;
commit;
