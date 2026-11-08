-- =====================================================================
-- 155 — Financeiro 2.0: CONCILIAÇÃO de UMA saída com VÁRIAS entradas (2 a 3).
-- NÃO APLICADA EM PRODUÇÃO (preparada e testada só em banco local descartável). Aplicar em produção é decisão do responsável.
-- Caso real: uma transferência Stone → Unicred cai na Unicred em 2–3 créditos cuja SOMA é exatamente a saída. A tabela fin_transferencias
-- continua 1:1 (intocada). Aqui nasce o vínculo 1:N:
--   • fin_transferencias_multiplas          = a saída, a justificativa e QUEM aprovou (nunca criada por sugestão automática);
--   • fin_transferencias_multiplas_entradas = cada entrada, com o valor no momento do vínculo.
-- Regras (no banco, não só na aplicação): 2 a 3 entradas distintas; soma EXATA; mesmo tenant; sentidos corretos; lançamentos realizados;
-- contas de entrada diferentes da conta de saída; todos de categoria de transferência; nenhum lançamento já vinculado (1:1 ou 1:N);
-- justificativa ≥ 10 caracteres. Os lançamentos NÃO são alterados (valor/data/conta/categoria/status travados enquanto vinculados);
-- só deixam de ser "pendentes". Desfazer exige motivo (≥ 10) e preserva tudo na trilha. Sem DELETE direto: só pela função.
-- Idempotente. Rollback: 155_rollback.sql (recusa se houver dados).
-- =====================================================================
begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.fin_transferencias') is null or to_regprocedure('public.fin_auditar()') is null or to_regprocedure('public.fin_validar_escopo()') is null
     or to_regprocedure('public.fin_periodo_travar_e_checar(uuid,uuid,date)') is null then
    raise exception 'MIGRATION 155 abortada: requer as migrations 120, 121, 122 e 151 aplicadas.';
  end if;
end $$;

create table if not exists fin_transferencias_multiplas (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  lancamento_saida_id uuid not null references fin_lancamentos(id) on delete restrict,
  valor_centavos bigint not null check (valor_centavos > 0),
  quantidade_entradas smallint not null check (quantidade_entradas between 2 and 3),
  justificativa text not null check (length(btrim(justificativa)) >= 10),
  aprovado_por uuid not null,
  aprovado_em timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (lancamento_saida_id),
  unique (organizacao_id, unidade_id, id)
);
create table if not exists fin_transferencias_multiplas_entradas (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  multipla_id uuid not null,
  lancamento_entrada_id uuid not null references fin_lancamentos(id) on delete restrict,
  valor_centavos bigint not null check (valor_centavos > 0),
  created_at timestamptz not null default now(),
  unique (lancamento_entrada_id),
  foreign key (organizacao_id, unidade_id, multipla_id) references fin_transferencias_multiplas (organizacao_id, unidade_id, id) on delete restrict
);
create index if not exists ix_fin_transf_mult_ent_pai on fin_transferencias_multiplas_entradas (multipla_id);

-- Nenhum lançamento participa de dois vínculos (1:1 ou 1:N). Cobre também a 1:1 criada DEPOIS (gatilho na tabela antiga).
create or replace function fin2_multipla_exclusiva() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'fin_transferencias_multiplas_entradas' then
    if exists (select 1 from fin_transferencias t where t.status <> 'cancelada' and (t.lancamento_saida_id = new.lancamento_entrada_id or t.lancamento_entrada_id = new.lancamento_entrada_id))
       or exists (select 1 from fin_transferencias_multiplas m where m.lancamento_saida_id = new.lancamento_entrada_id) then
      raise exception 'fin_multipla_conflito: entrada ja vinculada' using errcode = '23514';
    end if;
  elsif tg_table_name = 'fin_transferencias_multiplas' then
    if exists (select 1 from fin_transferencias t where t.status <> 'cancelada' and (t.lancamento_saida_id = new.lancamento_saida_id or t.lancamento_entrada_id = new.lancamento_saida_id))
       or exists (select 1 from fin_transferencias_multiplas_entradas e where e.lancamento_entrada_id = new.lancamento_saida_id) then
      raise exception 'fin_multipla_conflito: saida ja vinculada' using errcode = '23514';
    end if;
  else  -- fin_transferencias (1:1): recusa pernas que já estão num vínculo 1:N
    if exists (select 1 from fin_transferencias_multiplas m where m.lancamento_saida_id in (new.lancamento_saida_id, new.lancamento_entrada_id))
       or exists (select 1 from fin_transferencias_multiplas_entradas e where e.lancamento_entrada_id in (new.lancamento_saida_id, new.lancamento_entrada_id)) then
      raise exception 'fin_multipla_conflito: lancamento ja conciliado com varias entradas' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_fin_transf_mult_excl on fin_transferencias_multiplas;
create trigger trg_fin_transf_mult_excl before insert on fin_transferencias_multiplas for each row execute function fin2_multipla_exclusiva();
drop trigger if exists trg_fin_transf_mult_ent_excl on fin_transferencias_multiplas_entradas;
create trigger trg_fin_transf_mult_ent_excl before insert on fin_transferencias_multiplas_entradas for each row execute function fin2_multipla_exclusiva();
drop trigger if exists trg_fin_transferencias_multipla_excl on fin_transferencias;
create trigger trg_fin_transferencias_multipla_excl before insert on fin_transferencias for each row execute function fin2_multipla_exclusiva();

-- Imutabilidade: o vínculo nunca é editado (só criado ou desfeito pela função).
create or replace function fin2_multipla_imutavel() returns trigger language plpgsql as $$
begin raise exception 'fin_multipla_imutavel: desfaca o vinculo e crie outro' using errcode = '23514'; end $$;
drop trigger if exists trg_fin_transf_mult_imut on fin_transferencias_multiplas;
create trigger trg_fin_transf_mult_imut before update on fin_transferencias_multiplas for each row execute function fin2_multipla_imutavel();
drop trigger if exists trg_fin_transf_mult_ent_imut on fin_transferencias_multiplas_entradas;
create trigger trg_fin_transf_mult_ent_imut before update on fin_transferencias_multiplas_entradas for each row execute function fin2_multipla_imutavel();

-- Lançamentos vinculados ficam travados (valor, sentido, conta, data, categoria, status), como as pernas de um par 1:1.
create or replace function fin2_lancamento_multipla_guarda() returns trigger language plpgsql as $$
begin
  if (new.valor_centavos is distinct from old.valor_centavos or new.sentido is distinct from old.sentido or new.conta_id is distinct from old.conta_id
      or new.data_movimento is distinct from old.data_movimento or new.categoria_id is distinct from old.categoria_id or new.status is distinct from old.status)
     and (exists (select 1 from fin_transferencias_multiplas m where m.lancamento_saida_id = old.id)
          or exists (select 1 from fin_transferencias_multiplas_entradas e where e.lancamento_entrada_id = old.id)) then
    raise exception 'fin_transferencia_multipla: desfaca a conciliacao com varias entradas antes de alterar este lancamento' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists trg_fin_lancamentos_multipla_guarda on fin_lancamentos;
create trigger trg_fin_lancamentos_multipla_guarda before update on fin_lancamentos for each row execute function fin2_lancamento_multipla_guarda();

-- Auditoria e escopo (mesmo padrão da 121)
do $$
declare t text;
begin
  foreach t in array array['fin_transferencias_multiplas', 'fin_transferencias_multiplas_entradas'] loop
    execute format('drop trigger if exists trg_%1$s_auditar on %1$s', t);
    execute format('create trigger trg_%1$s_auditar after insert or update or delete on %1$s for each row execute function fin_auditar()', t);
    execute format('drop trigger if exists trg_%1$s_escopo on %1$s', t);
    execute format('create trigger trg_%1$s_escopo before insert or update on %1$s for each row execute function fin_validar_escopo()', t);
  end loop;
end $$;

-- Vincula UMA saída a 2–3 entradas. A decisão é humana (permissão de conciliar na aplicação; aqui fica registrado quem aprovou).
create or replace function fin_vincular_transferencia_multipla(p_org uuid, p_unidade uuid, p_usuario uuid, p_saida uuid, p_entradas uuid[], p_justificativa text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare s fin_lancamentos; e fin_lancamentos; v_id uuid; v_soma bigint := 0; v_n int; v_just text := btrim(coalesce(p_justificativa, '')); ids uuid[]; x uuid; papel_s text; papel_e text;
begin
  if p_usuario is null then raise exception 'fin_multipla_invalida: aprovador obrigatorio' using errcode = '23514'; end if;
  if length(v_just) < 10 then raise exception 'fin_multipla_justificativa_obrigatoria: informe a justificativa (minimo 10 caracteres)' using errcode = '23514'; end if;
  select array_agg(distinct u) into ids from unnest(coalesce(p_entradas, '{}'::uuid[])) u;
  v_n := coalesce(array_length(ids, 1), 0);
  if v_n <> coalesce(array_length(p_entradas, 1), 0) then raise exception 'fin_multipla_invalida: entradas repetidas' using errcode = '23514'; end if;
  if v_n < 2 or v_n > 3 then raise exception 'fin_multipla_invalida: informe de 2 a 3 entradas' using errcode = '23514'; end if;
  perform 1 from fin_lancamentos where id = p_saida or id = any(ids) order by id for update;
  select * into s from fin_lancamentos where id = p_saida;
  if s.id is null or s.organizacao_id <> p_org or s.unidade_id <> p_unidade then raise exception 'fin_multipla_invalida: saida inexistente neste tenant' using errcode = '23514'; end if;
  if s.sentido <> 'saida' or s.status <> 'realizado' then raise exception 'fin_multipla_invalida: a saida precisa estar realizada' using errcode = '23514'; end if;
  select papel into papel_s from fin_plano_contas where id = s.categoria_id;
  if papel_s is distinct from 'transferencia' then raise exception 'fin_multipla_invalida: a saida precisa ter categoria de transferencia' using errcode = '23514'; end if;
  foreach x in array ids loop
    select * into e from fin_lancamentos where id = x;
    if e.id is null or e.organizacao_id <> p_org or e.unidade_id <> p_unidade then raise exception 'fin_multipla_invalida: entrada inexistente neste tenant' using errcode = '23514'; end if;
    if e.sentido <> 'entrada' or e.status <> 'realizado' then raise exception 'fin_multipla_invalida: as entradas precisam estar realizadas' using errcode = '23514'; end if;
    if e.conta_id = s.conta_id then raise exception 'fin_multipla_invalida: entrada na mesma conta da saida' using errcode = '23514'; end if;
    select papel into papel_e from fin_plano_contas where id = e.categoria_id;
    if papel_e is distinct from 'transferencia' then raise exception 'fin_multipla_invalida: as entradas precisam ter categoria de transferencia' using errcode = '23514'; end if;
    v_soma := v_soma + e.valor_centavos;
  end loop;
  if v_soma <> s.valor_centavos then raise exception 'fin_multipla_soma: a soma das entradas (%) difere da saida (%)', v_soma, s.valor_centavos using errcode = '23514'; end if;
  insert into fin_transferencias_multiplas (organizacao_id, unidade_id, lancamento_saida_id, valor_centavos, quantidade_entradas, justificativa, aprovado_por)
  values (p_org, p_unidade, p_saida, s.valor_centavos, v_n, v_just, p_usuario) returning id into v_id;
  insert into fin_transferencias_multiplas_entradas (organizacao_id, unidade_id, multipla_id, lancamento_entrada_id, valor_centavos)
  select p_org, p_unidade, v_id, l.id, l.valor_centavos from fin_lancamentos l where l.id = any(ids);
  update fin_lancamentos set classificacao_pendente = false, atualizado_por = p_usuario where id = p_saida or id = any(ids);
  return v_id;
end $$;

-- Desfaz com motivo: apaga só o vínculo (as pernas permanecem ativas e voltam a pendentes; o antes/depois fica na trilha).
create or replace function fin_desvincular_transferencia_multipla(p_org uuid, p_unidade uuid, p_usuario uuid, p_multipla uuid, p_motivo text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare m fin_transferencias_multiplas; v_motivo text := btrim(coalesce(p_motivo, '')); ids uuid[];
begin
  if length(v_motivo) < 10 then raise exception 'fin_transferencia_motivo_obrigatorio: informe o motivo (minimo 10 caracteres)' using errcode = '23514'; end if;
  select * into m from fin_transferencias_multiplas where id = p_multipla and organizacao_id = p_org and unidade_id = p_unidade for update;
  if not found then return false; end if;
  select array_agg(lancamento_entrada_id) into ids from fin_transferencias_multiplas_entradas where multipla_id = m.id;
  perform 1 from fin_lancamentos where id = m.lancamento_saida_id or id = any(ids) order by id for update;
  perform fin_periodo_travar_e_checar(p_org, p_unidade, (select data_movimento from fin_lancamentos where id = m.lancamento_saida_id));
  delete from fin_transferencias_multiplas_entradas where multipla_id = m.id;
  delete from fin_transferencias_multiplas where id = m.id;
  update fin_lancamentos set classificacao_pendente = true, atualizado_por = p_usuario,
         nota_revisao = case when nota_revisao is null or nota_revisao = '' then 'Conciliacao 1:N desfeita: ' || v_motivo else nota_revisao || ' | Conciliacao 1:N desfeita: ' || v_motivo end
   where id = m.lancamento_saida_id or id = any(ids);
  return true;
end $$;

-- Transferência de unidades: as tabelas novas entram na lista da guarda
create or replace function public.gestao_financeira_tabelas_da_unidade() returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array[
    'gestao_financeira_concessoes', 'gestao_financeira_concessoes_auditoria',                                     -- 120
    'fin_contas', 'fin_saldos_abertura', 'fin_lancamentos', 'fin_transferencias', 'fin_periodos', 'fin_importacoes',
    'fin_auditoria',                                                                                              -- 121
    'fin_referencias', 'fin_conciliacao_resolucoes', 'fin_sangria_excecoes', 'fin_excecoes_fechamento',           -- 122
    'fin_obrigacoes', 'fin_pagamentos', 'fin_conciliacao_saidas',                                                 -- 151
    'fin_rateios', 'fin_rateio_parcelas', 'fin_recebiveis', 'fin_recebimentos', 'fin_dividas', 'fin_divida_eventos', -- 152
    'fin_vendas_canal', 'fin_vendas_ajustes',                                                                     -- 153
    'fin_transferencias_multiplas', 'fin_transferencias_multiplas_entradas'                                       -- 155
  ]::text[]
$$;

-- Privilégios: backend-only. RLS ligada, NENHUMA policy; o backend só LÊ as tabelas e grava pelas funções.
do $$
declare t text; r text; f text;
begin
  foreach t in array array['fin_transferencias_multiplas', 'fin_transferencias_multiplas_entradas'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from public', t);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table %I from %I', t, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on table %I from service_role', t);
      execute format('grant select on table %I to service_role', t);
    end if;
  end loop;
  foreach f in array array['fin_vincular_transferencia_multipla(uuid,uuid,uuid,uuid,uuid[],text)', 'fin_desvincular_transferencia_multipla(uuid,uuid,uuid,uuid,text)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  foreach f in array array['fin2_multipla_exclusiva()', 'fin2_multipla_imutavel()', 'fin2_lancamento_multipla_guarda()'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
end $$;

-- Pós-condições
do $$
declare t text;
begin
  foreach t in array array['fin_transferencias_multiplas', 'fin_transferencias_multiplas_entradas'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception '155 pós-condição: RLS desligada em %', t; end if;
    if exists (select 1 from pg_policies where tablename = t) then raise exception '155 pós-condição: % tem policy', t; end if;
    if t <> all (public.gestao_financeira_tabelas_da_unidade()) then raise exception '155 pós-condição: % fora da guarda de transferência', t; end if;
    if exists (select 1 from pg_roles where rolname = 'anon') and has_table_privilege('anon', 'public.' || t, 'select') then raise exception '155 pós-condição: anon lê %', t; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') and has_table_privilege('service_role', 'public.' || t, 'insert,update,delete') then raise exception '155 pós-condição: service_role escreve direto em %', t; end if;
  end loop;
end $$;
commit;
