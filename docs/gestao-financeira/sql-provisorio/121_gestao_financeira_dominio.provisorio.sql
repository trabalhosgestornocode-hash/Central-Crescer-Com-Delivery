-- =====================================================================
-- PROVISÓRIO (NÃO EXECUTÁVEL PELO PIPELINE) — Gestão Financeira: domínio (Agente 2)
-- =====================================================================
-- Fica FORA de database/migrations de propósito. Vira `121_*.sql` (ou o número que o Agente 1 definir) só depois de:
--   1) numeração coordenada com o Agente 1 (a 120 é dele: módulo, concessões, RLS de concessões);
--   2) execução em PostgreSQL DESCARTÁVEL (scripts em backend/testes-financeiro-pg) e revisão humana.
-- NUNCA aplicar em produção a partir deste arquivo.
--
-- Modelo: dinheiro em centavos (bigint), regime de caixa, isolamento por organização + unidade DENTRO do banco
-- (gatilhos conferem que conta/categoria/unidade pertencem ao mesmo tenant), RLS ligada SEM policies (só o backend, via
-- service_role, e sempre filtrando org+unidade), sem DELETE para o service_role (cancelamento é status), auditoria imutável.

-- ---------------------------------------------------------------------
-- Plano de contas (por organização). O `papel` decide a participação nos cálculos.
-- ---------------------------------------------------------------------
create table if not exists fin_plano_contas (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  tipo text not null,
  natureza text not null,
  nome text not null,
  papel text not null check (papel in (
    'receita_operacional','custo_variavel','despesa_variavel','tributo','despesa_fixa','despesa_pessoal',
    'despesa_financeira','financiamento','transferencia','saldo_anterior')),
  ativo boolean not null default true,
  criado_por uuid,
  atualizado_por uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organizacao_id, tipo, natureza, nome)
);

-- Contas financeiras (ONDE o dinheiro está). Meio de pagamento e canal de venda NÃO são contas.
create table if not exists fin_contas (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  nome text not null,
  tipo_conta text not null default 'outra' check (tipo_conta in ('banco','adquirente','caixa_fisico','carteira_plataforma','outra')),
  ativo boolean not null default true,
  criado_por uuid,
  atualizado_por uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (unidade_id, nome)
);

-- Saldo de abertura CONHECIDO. Conta sem linha = abertura DESCONHECIDA (o motor devolve saldo parcial; nunca assume zero).
create table if not exists fin_saldos_abertura (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  conta_id uuid not null references fin_contas(id) on delete restrict,
  data_referencia date not null,
  valor_centavos bigint not null,
  origem text not null default 'manual' check (origem in ('manual','importacao')),
  nota text,
  criado_por uuid,
  created_at timestamptz not null default now(),
  unique (conta_id, data_referencia)
);

-- Lançamentos: ÚNICA fonte dos números. Indicadores são calculados, nunca gravados.
create table if not exists fin_lancamentos (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  conta_id uuid not null references fin_contas(id) on delete restrict,
  categoria_id uuid references fin_plano_contas(id) on delete restrict,   -- null = classificação pendente
  descricao text not null,
  sentido text not null check (sentido in ('entrada','saida')),
  valor_centavos bigint not null check (valor_centavos > 0),
  data_movimento date not null,
  data_competencia date,
  data_vencimento date,
  status text not null default 'realizado' check (status in ('realizado','previsto','cancelado')),
  origem text not null default 'manual' check (origem in ('manual','importacao')),
  importacao_id uuid,
  chave_origem text,                      -- idempotência da importação (fingerprint#ocorrência)
  referencia_origem text,                 -- ex.: arquivo/linha, só para rastreio
  classificacao_pendente boolean not null default false,
  nota_revisao text,
  criado_por uuid,
  atualizado_por uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (categoria_id is not null or classificacao_pendente)
);
create unique index if not exists ux_fin_lancamentos_chave on fin_lancamentos (organizacao_id, unidade_id, chave_origem) where chave_origem is not null;
create index if not exists ix_fin_lancamentos_periodo on fin_lancamentos (organizacao_id, unidade_id, data_movimento);
create index if not exists ix_fin_lancamentos_conta on fin_lancamentos (conta_id, data_movimento);
create index if not exists ix_fin_lancamentos_categoria on fin_lancamentos (categoria_id);

-- Transferência = par vinculado (saída em A, entrada em B). Líquido consolidado = 0 (validado por gatilho).
create table if not exists fin_transferencias (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  lancamento_saida_id uuid not null references fin_lancamentos(id) on delete restrict,
  lancamento_entrada_id uuid not null references fin_lancamentos(id) on delete restrict,
  origem text not null default 'manual' check (origem in ('manual','importacao')),
  criado_por uuid,
  created_at timestamptz not null default now(),
  unique (lancamento_saida_id),
  unique (lancamento_entrada_id),
  check (lancamento_saida_id <> lancamento_entrada_id)
);

-- Períodos (fechamento mensal). Mês fechado bloqueia escrita nos lançamentos (gatilho). Regras de fechar/reabrir: etapa B8.
create table if not exists fin_periodos (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  mes date not null check (mes = date_trunc('month', mes)::date),
  status text not null default 'aberto' check (status in ('aberto','fechado','reaberto')),
  fechado_por uuid, fechado_em timestamptz,
  reaberto_por uuid, reaberto_em timestamptz, motivo_reabertura text,
  snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (unidade_id, mes),
  check (status <> 'reaberto' or (motivo_reabertura is not null and length(btrim(motivo_reabertura)) > 0))
);

-- Importações: a prévia fica gravada (jsonb) para a confirmação ser ATÔMICA e auditável.
create table if not exists fin_importacoes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  arquivo_nome text,
  arquivo_hash text not null,
  status text not null default 'previa' check (status in ('previa','confirmada','cancelada','falhou')),
  previa jsonb not null,
  resumo jsonb,
  criado_por uuid,
  confirmado_por uuid,
  confirmado_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ix_fin_importacoes_unidade on fin_importacoes (organizacao_id, unidade_id, created_at desc);

-- Auditoria imutável.
create table if not exists fin_auditoria (
  id bigint generated always as identity primary key,
  organizacao_id uuid,
  unidade_id uuid,
  ator_id uuid,
  acao text not null,
  entidade text not null,
  entidade_id text,
  antes jsonb,
  depois jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ix_fin_auditoria_entidade on fin_auditoria (entidade, entidade_id);
create index if not exists ix_fin_auditoria_tenant on fin_auditoria (organizacao_id, unidade_id, created_at desc);

-- ---------------------------------------------------------------------
-- Gatilhos de integridade
-- ---------------------------------------------------------------------
create or replace function fin_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

-- A unidade pertence à organização informada; conta/categoria/lançamento são do MESMO tenant.
create or replace function fin_validar_escopo() returns trigger language plpgsql as $$
declare j jsonb := to_jsonb(new); v_conta uuid := nullif(j->>'conta_id','')::uuid; v_cat uuid := nullif(j->>'categoria_id','')::uuid;
begin
  if j ? 'unidade_id' and not exists (select 1 from unidades u where u.id = new.unidade_id and u.organizacao_id = new.organizacao_id) then
    raise exception 'fin_escopo_invalido: unidade nao pertence a organizacao' using errcode = '23514';
  end if;
  if v_conta is not null and not exists (select 1 from fin_contas c where c.id = v_conta and c.organizacao_id = new.organizacao_id and c.unidade_id = new.unidade_id) then
    raise exception 'fin_escopo_invalido: conta de outro tenant' using errcode = '23514';
  end if;
  if v_cat is not null and not exists (select 1 from fin_plano_contas p where p.id = v_cat and p.organizacao_id = new.organizacao_id) then
    raise exception 'fin_escopo_invalido: categoria de outra organizacao' using errcode = '23514';
  end if;
  return new;
end $$;

-- Campos de identidade não mudam; lançamento de transferência vinculada não muda valor/sentido/conta; mês fechado é intocável.
create or replace function fin_lancamentos_guarda() returns trigger language plpgsql as $$
declare mes_novo date; mes_velho date;
begin
  if tg_op = 'UPDATE' then
    if new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id
       or new.origem is distinct from old.origem or new.chave_origem is distinct from old.chave_origem
       or new.importacao_id is distinct from old.importacao_id or new.criado_por is distinct from old.criado_por then
      raise exception 'fin_campo_imutavel' using errcode = '23514';
    end if;
    if (new.valor_centavos is distinct from old.valor_centavos or new.sentido is distinct from old.sentido
        or new.conta_id is distinct from old.conta_id or new.data_movimento is distinct from old.data_movimento
        or new.status is distinct from old.status)
       and exists (select 1 from fin_transferencias t where t.lancamento_saida_id = old.id or t.lancamento_entrada_id = old.id) then
      raise exception 'fin_transferencia_vinculada: desvincule o par antes de alterar este lancamento' using errcode = '23514';
    end if;
    mes_velho := date_trunc('month', old.data_movimento)::date;
  end if;
  mes_novo := date_trunc('month', new.data_movimento)::date;
  if exists (select 1 from fin_periodos p where p.unidade_id = new.unidade_id and p.status = 'fechado' and p.mes in (mes_novo, coalesce(mes_velho, mes_novo))) then
    raise exception 'fin_periodo_fechado' using errcode = '23514';
  end if;
  return new;
end $$;

-- A categoria muda de papel? Só se ainda não foi usada (reclassificação histórica é explícita e auditada).
create or replace function fin_plano_contas_guarda() returns trigger language plpgsql as $$
begin
  if new.organizacao_id is distinct from old.organizacao_id then raise exception 'fin_campo_imutavel' using errcode = '23514'; end if;
  if new.papel is distinct from old.papel and exists (select 1 from fin_lancamentos l where l.categoria_id = old.id) then
    raise exception 'fin_papel_em_uso: categoria ja possui lancamentos; crie outra categoria e reclassifique com auditoria' using errcode = '23514';
  end if;
  return new;
end $$;

-- Par de transferência: mesmo tenant, sentidos opostos, mesmo valor, contas diferentes, ambos com papel transferência.
create or replace function fin_transferencias_validar() returns trigger language plpgsql as $$
declare s fin_lancamentos; e fin_lancamentos; ps text; pe text;
begin
  select * into s from fin_lancamentos where id = new.lancamento_saida_id;
  select * into e from fin_lancamentos where id = new.lancamento_entrada_id;
  if s.id is null or e.id is null then raise exception 'fin_par_invalido: perna inexistente' using errcode = '23514'; end if;
  if s.organizacao_id <> new.organizacao_id or e.organizacao_id <> new.organizacao_id or s.unidade_id <> new.unidade_id or e.unidade_id <> new.unidade_id then
    raise exception 'fin_par_invalido: pernas de outro tenant' using errcode = '23514';
  end if;
  if s.sentido <> 'saida' or e.sentido <> 'entrada' then raise exception 'fin_par_invalido: sentidos' using errcode = '23514'; end if;
  if s.valor_centavos <> e.valor_centavos then raise exception 'fin_par_invalido: valores diferentes' using errcode = '23514'; end if;
  if s.conta_id = e.conta_id then raise exception 'fin_par_invalido: mesma conta' using errcode = '23514'; end if;
  if s.status <> 'realizado' or e.status <> 'realizado' then raise exception 'fin_par_invalido: status' using errcode = '23514'; end if;
  select papel into ps from fin_plano_contas where id = s.categoria_id;
  select papel into pe from fin_plano_contas where id = e.categoria_id;
  if ps is distinct from 'transferencia' or pe is distinct from 'transferencia' then
    raise exception 'fin_par_invalido: ambas as pernas precisam ter categoria de transferencia' using errcode = '23514';
  end if;
  return new;
end $$;

-- Auditoria: grava antes/depois de toda mudança. SECURITY DEFINER: o service_role não precisa (nem tem) INSERT em fin_auditoria.
create or replace function fin_auditar() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare j jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  insert into fin_auditoria (organizacao_id, unidade_id, ator_id, acao, entidade, entidade_id, antes, depois)
  values (
    nullif(j->>'organizacao_id','')::uuid, nullif(j->>'unidade_id','')::uuid,
    coalesce(nullif(j->>'atualizado_por','')::uuid, nullif(j->>'criado_por','')::uuid, nullif(j->>'confirmado_por','')::uuid),
    tg_table_name || '.' || lower(tg_op), tg_table_name, j->>'id',
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return null;
end $$;

create or replace function fin_auditoria_imutavel() returns trigger language plpgsql as $$
begin raise exception 'fin_auditoria e imutavel' using errcode = '23514'; end $$;

do $$
declare t text;
begin
  foreach t in array array['fin_plano_contas','fin_contas','fin_saldos_abertura','fin_lancamentos','fin_transferencias','fin_periodos','fin_importacoes'] loop
    execute format('drop trigger if exists trg_%1$s_auditar on %1$s', t);
    execute format('create trigger trg_%1$s_auditar after insert or update or delete on %1$s for each row execute function fin_auditar()', t);
  end loop;
  foreach t in array array['fin_plano_contas','fin_contas','fin_lancamentos','fin_periodos','fin_importacoes'] loop
    execute format('drop trigger if exists trg_%1$s_upd on %1$s', t);
    execute format('create trigger trg_%1$s_upd before update on %1$s for each row execute function fin_touch_updated_at()', t);
  end loop;
  foreach t in array array['fin_contas','fin_saldos_abertura','fin_lancamentos','fin_transferencias','fin_periodos','fin_importacoes'] loop
    execute format('drop trigger if exists trg_%1$s_escopo on %1$s', t);
    execute format('create trigger trg_%1$s_escopo before insert or update on %1$s for each row execute function fin_validar_escopo()', t);
  end loop;
end $$;

drop trigger if exists trg_fin_lancamentos_guarda on fin_lancamentos;
create trigger trg_fin_lancamentos_guarda before insert or update on fin_lancamentos for each row execute function fin_lancamentos_guarda();
drop trigger if exists trg_fin_plano_contas_guarda on fin_plano_contas;
create trigger trg_fin_plano_contas_guarda before update on fin_plano_contas for each row execute function fin_plano_contas_guarda();
drop trigger if exists trg_fin_transferencias_validar on fin_transferencias;
create trigger trg_fin_transferencias_validar before insert on fin_transferencias for each row execute function fin_transferencias_validar();
drop trigger if exists trg_fin_auditoria_imutavel on fin_auditoria;
create trigger trg_fin_auditoria_imutavel before update or delete on fin_auditoria for each row execute function fin_auditoria_imutavel();
drop trigger if exists trg_fin_auditoria_truncate on fin_auditoria;
create trigger trg_fin_auditoria_truncate before truncate on fin_auditoria for each statement execute function fin_auditoria_imutavel();

-- ---------------------------------------------------------------------
-- Operações atômicas (RPC). Todas recebem org+unidade explícitos e conferem o escopo; chamadas só pelo backend.
-- ---------------------------------------------------------------------

-- Transferência entre contas da MESMA unidade: cria as duas pernas e o par em uma transação.
create or replace function fin_criar_transferencia(
  p_org uuid, p_unidade uuid, p_usuario uuid, p_conta_origem uuid, p_conta_destino uuid,
  p_valor_centavos bigint, p_data date, p_descricao text, p_categoria_id uuid
) returns uuid language plpgsql as $$
declare v_saida uuid; v_entrada uuid; v_par uuid;
begin
  insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, categoria_id, descricao, sentido, valor_centavos, data_movimento, criado_por, atualizado_por)
  values (p_org, p_unidade, p_conta_origem, p_categoria_id, p_descricao, 'saida', p_valor_centavos, p_data, p_usuario, p_usuario) returning id into v_saida;
  insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, categoria_id, descricao, sentido, valor_centavos, data_movimento, criado_por, atualizado_por)
  values (p_org, p_unidade, p_conta_destino, p_categoria_id, p_descricao, 'entrada', p_valor_centavos, p_data, p_usuario, p_usuario) returning id into v_entrada;
  insert into fin_transferencias (organizacao_id, unidade_id, lancamento_saida_id, lancamento_entrada_id, criado_por)
  values (p_org, p_unidade, v_saida, v_entrada, p_usuario) returning id into v_par;
  return v_par;
end $$;

-- Vincula duas pernas JÁ existentes (ex.: vindas da importação). A confirmação é humana; o gatilho valida o par.
create or replace function fin_vincular_transferencia(p_org uuid, p_unidade uuid, p_usuario uuid, p_saida uuid, p_entrada uuid)
returns uuid language plpgsql as $$
declare v_par uuid;
begin
  insert into fin_transferencias (organizacao_id, unidade_id, lancamento_saida_id, lancamento_entrada_id, criado_por)
  values (p_org, p_unidade, p_saida, p_entrada, p_usuario) returning id into v_par;
  -- par confirmado por pessoa autorizada: as duas pernas deixam de ser "transferência sem contraparte"
  update fin_lancamentos set classificacao_pendente = false, atualizado_por = p_usuario where id in (p_saida, p_entrada);
  return v_par;
end $$;

-- Desfaz o vínculo (as pernas permanecem como lançamentos; nada é excluído).
create or replace function fin_desvincular_transferencia(p_org uuid, p_unidade uuid, p_usuario uuid, p_transferencia uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_s uuid; v_e uuid;
begin
  -- Único DELETE do domínio: só por esta função (SECURITY DEFINER, escopo org+unidade conferido) e auditado pelo gatilho.
  -- O service_role não tem DELETE direto em nenhuma tabela.
  delete from fin_transferencias where id = p_transferencia and organizacao_id = p_org and unidade_id = p_unidade
    returning lancamento_saida_id, lancamento_entrada_id into v_s, v_e;
  if v_s is null then return false; end if;
  update fin_lancamentos set classificacao_pendente = true, atualizado_por = p_usuario where id in (v_s, v_e);
  return true;
end $$;

-- Confirmação da importação: tudo ou nada. Idempotente por chave_origem; reconfirmar devolve o resumo anterior.
-- Formato de `previa`: { contas:[{nome,tipo_conta}], categorias:[{tipo,natureza,nome,papel}],
--   saldos:[{conta,data,valor_centavos}], lancamentos:[{chave,data,descricao,sentido,valor_centavos,conta,
--   categoria:{tipo,natureza,nome}|null,pendente,nota,referencia,importar}], pares:[{saida,entrada,confirmado}] }
create or replace function fin_confirmar_importacao(p_org uuid, p_unidade uuid, p_usuario uuid, p_importacao uuid)
returns jsonb language plpgsql as $$
declare v fin_importacoes; n_lanc int; n_dup int; n_saldos int; n_pares int; r jsonb;
begin
  select * into v from fin_importacoes where id = p_importacao and organizacao_id = p_org and unidade_id = p_unidade for update;
  if not found then raise exception 'fin_importacao_nao_encontrada' using errcode = 'P0002'; end if;
  if v.status = 'confirmada' then return coalesce(v.resumo, '{}'::jsonb) || jsonb_build_object('jaConfirmada', true); end if;
  if v.status <> 'previa' then raise exception 'fin_importacao_estado_invalido: %', v.status using errcode = '23514'; end if;

  insert into fin_contas (organizacao_id, unidade_id, nome, tipo_conta, criado_por, atualizado_por)
  select p_org, p_unidade, c->>'nome', coalesce(c->>'tipo_conta','outra'), p_usuario, p_usuario
  from jsonb_array_elements(coalesce(v.previa->'contas','[]')) c on conflict (unidade_id, nome) do nothing;

  insert into fin_plano_contas (organizacao_id, tipo, natureza, nome, papel, criado_por, atualizado_por)
  select p_org, c->>'tipo', c->>'natureza', c->>'nome', c->>'papel', p_usuario, p_usuario
  from jsonb_array_elements(coalesce(v.previa->'categorias','[]')) c on conflict (organizacao_id, tipo, natureza, nome) do nothing;

  insert into fin_saldos_abertura (organizacao_id, unidade_id, conta_id, data_referencia, valor_centavos, origem, criado_por)
  select p_org, p_unidade, c.id, (s->>'data')::date, (s->>'valor_centavos')::bigint, 'importacao', p_usuario
  from jsonb_array_elements(coalesce(v.previa->'saldos','[]')) s
  join fin_contas c on c.unidade_id = p_unidade and c.nome = s->>'conta'
  on conflict (conta_id, data_referencia) do nothing;
  get diagnostics n_saldos = row_count;

  insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, categoria_id, descricao, sentido, valor_centavos, data_movimento,
                               origem, importacao_id, chave_origem, referencia_origem, classificacao_pendente, nota_revisao, criado_por, atualizado_por)
  select p_org, p_unidade, c.id, pc.id, l->>'descricao', l->>'sentido', (l->>'valor_centavos')::bigint, (l->>'data')::date,
         'importacao', p_importacao, l->>'chave', l->>'referencia', coalesce((l->>'pendente')::boolean, false) or pc.id is null,
         nullif(l->>'nota',''), p_usuario, p_usuario
  from jsonb_array_elements(coalesce(v.previa->'lancamentos','[]')) l
  join fin_contas c on c.unidade_id = p_unidade and c.nome = l->>'conta'
  left join fin_plano_contas pc on pc.organizacao_id = p_org and l->'categoria' is not null and jsonb_typeof(l->'categoria') = 'object'
       and pc.tipo = l#>>'{categoria,tipo}' and pc.natureza = l#>>'{categoria,natureza}' and pc.nome = l#>>'{categoria,nome}'
  where coalesce((l->>'importar')::boolean, true)
  on conflict (organizacao_id, unidade_id, chave_origem) where chave_origem is not null do nothing;
  get diagnostics n_lanc = row_count;
  n_dup := (select count(*) from jsonb_array_elements(coalesce(v.previa->'lancamentos','[]')) l where coalesce((l->>'importar')::boolean, true)) - n_lanc;

  insert into fin_transferencias (organizacao_id, unidade_id, lancamento_saida_id, lancamento_entrada_id, origem, criado_por)
  select p_org, p_unidade, ls.id, le.id, 'importacao', p_usuario
  from jsonb_array_elements(coalesce(v.previa->'pares','[]')) p
  join fin_lancamentos ls on ls.organizacao_id = p_org and ls.unidade_id = p_unidade and ls.chave_origem = p->>'saida'
  join fin_lancamentos le on le.organizacao_id = p_org and le.unidade_id = p_unidade and le.chave_origem = p->>'entrada'
  where coalesce((p->>'confirmado')::boolean, false)
  on conflict do nothing;
  get diagnostics n_pares = row_count;

  r := jsonb_build_object('lancamentosGravados', n_lanc, 'jaExistentes', n_dup, 'saldosGravados', n_saldos, 'paresVinculados', n_pares);
  update fin_importacoes set status = 'confirmada', resumo = r, confirmado_por = p_usuario, confirmado_em = now() where id = p_importacao;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- Privilégios: backend-only. RLS ligada, NENHUMA policy. Sem DELETE direto para o service_role.
-- ---------------------------------------------------------------------
do $$
declare t text; r text;
begin
  foreach t in array array['fin_plano_contas','fin_contas','fin_saldos_abertura','fin_lancamentos','fin_transferencias','fin_periodos','fin_importacoes','fin_auditoria'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from public', t);
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table %I from %I', t, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on table %I from service_role', t);
      if t = 'fin_auditoria' then execute format('grant select on table %I to service_role', t);
      else execute format('grant select, insert, update on table %I to service_role', t); end if;
    end if;
  end loop;
  foreach t in array array['fin_criar_transferencia(uuid,uuid,uuid,uuid,uuid,bigint,date,text,uuid)','fin_vincular_transferencia(uuid,uuid,uuid,uuid,uuid)',
                           'fin_desvincular_transferencia(uuid,uuid,uuid,uuid)','fin_confirmar_importacao(uuid,uuid,uuid,uuid)'] loop
    execute format('revoke all on function %s from public', t);
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', t, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', t); end if;
  end loop;
end $$;
-- Nota: o dono da função fin_desvincular_transferencia (quem aplica a migration) precisa de DELETE em fin_transferencias; revisar na homologação.
