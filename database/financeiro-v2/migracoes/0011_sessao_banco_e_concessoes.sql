-- =====================================================================================================================
-- Financeiro v2 — migração 0011: identidade de sessão no banco e concessões protegidas (Execução 07B)
--
-- Só é aplicada no PostgreSQL local isolado (scripts/fv2-banco-teste.mjs). Não pertence a database/migrations/.
--
-- PROBLEMA (auditoria 07, riscos P7 e P8):
--   * o escopo do RLS vinha de duas variáveis de sessão (fv2.organizacao_id/fv2.unidade_id) que o próprio papel da
--     aplicação define: quem tivesse a credencial da aplicação escolhia qualquer unidade;
--   * a aplicação gravava fv2_concessao por SQL livre: as regras de escalada só existiam no núcleo.
--
-- CORREÇÃO:
--   * SESSÃO DE BANCO: só a AUTORIDADE (papel fv2_autoridade — o gateway de autenticação, credencial separada) emite
--     sessões. A emissão exige concessão ATIVA do usuário no escopo. A aplicação recebe um token aleatório (o banco
--     guarda só o hash) e o declara por transação (fv2.sessao). Organização, unidade e usuário vêm do REGISTRO da sessão,
--     nunca de variável escolhida pela aplicação. Sem sessão válida = nenhuma linha (falha fechada).
--   * CONCESSÕES: a aplicação perde INSERT/UPDATE em fv2_concessao. A única escrita é fv2_gravar_concessao, que confere
--     NO BANCO: ator = usuário da sessão; ninguém concede a si mesmo; o ator tem `conceder` e todas as ações novas;
--     escopo = o da sessão; trava por escopo (concorrência sem escalada); auditoria própria, só de inserção; e revoga as
--     sessões de banco do alvo (a mudança vale na próxima transação).
--   * PROVISIONAMENTO INICIAL: sessão especial emitida só pela autoridade, com atestante ≠ alvo, nível aal2 declarado,
--     justificativa e evidência, apenas quando a unidade não tem quem conceda. Não dá acesso financeiro ao atestante.
--   * As funções privilegiadas pertencem a fv2_guardiao (sem login, sem membros), com search_path fixo e EXECUTE
--     revogado de PUBLIC. As políticas dele são explícitas e restritas às tabelas de concessão e escopo.
--   * Políticas de todas as tabelas: escopo da sessão avaliado uma vez por consulta; leitura exige sessão OPERACIONAL;
--     escrita exige sessão com ação além de `ver`.
--
-- LIMITE HONESTO: o banco não autentica pessoas. Ele confia em quem detém a credencial de fv2_autoridade. A garantia é
-- que a credencial da APLICAÇÃO, sozinha, não escolhe escopo, não cria sessão e não altera concessão.
-- =====================================================================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'fv2_autoridade') then
    create role fv2_autoridade nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'fv2_guardiao') then
    create role fv2_guardiao nologin;
  end if;
end $$;

-- ------------------------------------------------------------------------------------------------ tabelas protegidas
create table fv2_sessao_banco (
  id                uuid primary key default gen_random_uuid(),
  token_hash        bytea not null unique check (length(token_hash) = 32),
  usuario_id        uuid not null,
  organizacao_id    uuid not null,
  unidade_id        uuid not null,
  finalidade        text not null check (finalidade in ('OPERACAO', 'PROVISIONAMENTO')),
  pode_escrever     boolean not null,
  alvo              uuid,
  acoes_autorizadas jsonb,
  referencia        text check (referencia is null or length(referencia) <= 200),
  emitida_por       text not null default session_user,
  emitida_em        timestamptz not null default clock_timestamp(),
  expira_em         timestamptz not null,
  revogada_em       timestamptz,
  motivo_revogacao  text,
  foreign key (organizacao_id, unidade_id) references fv2_escopo,
  check ((finalidade = 'PROVISIONAMENTO') = (alvo is not null)),
  check (expira_em > emitida_em)
);
create index fv2_sessao_banco_usuario on fv2_sessao_banco (organizacao_id, unidade_id, usuario_id) where revogada_em is null;

create table fv2_auditoria_concessao (
  seq             bigint generated always as identity primary key,
  organizacao_id  uuid not null,
  unidade_id      uuid not null,
  concessao_id    uuid not null,
  usuario_alvo    uuid not null,
  ator            uuid not null,
  sessao_id       uuid not null,
  finalidade      text not null,
  operacao        text not null,
  acoes_antes     jsonb not null,
  acoes_depois    jsonb not null,
  situacao_depois text not null,
  justificativa   text not null,
  papel_de_banco  text not null default session_user,
  em              timestamptz not null default clock_timestamp()
);

create table fv2_provisionamento_inicial (
  id                 uuid primary key default gen_random_uuid(),
  organizacao_id     uuid not null,
  unidade_id         uuid not null,
  usuario_id         uuid not null,
  atestante_id       uuid not null check (atestante_id <> usuario_id),
  nivel_autenticacao text not null check (nivel_autenticacao = 'aal2'),
  acoes              jsonb not null,
  justificativa      text not null,
  evidencia          text not null,
  sessao_id          uuid not null references fv2_sessao_banco,
  emitido_em         timestamptz not null default clock_timestamp(),
  concluido_em       timestamptz,
  foreign key (organizacao_id, unidade_id) references fv2_escopo
);

create function fv2_somente_insercao() returns trigger language plpgsql as $$
begin
  raise exception 'Financeiro v2: % só aceita inclusão.', tg_table_name using errcode = 'FV040';
end $$;
create trigger fv2_auditoria_concessao_imutavel before update or delete on fv2_auditoria_concessao for each row execute function fv2_somente_insercao();
create trigger fv2_auditoria_concessao_sem_truncate before truncate on fv2_auditoria_concessao for each statement execute function fv2_somente_insercao();
create trigger fv2_sessao_banco_sem_delete before delete on fv2_sessao_banco for each row execute function fv2_somente_insercao();
create trigger fv2_provisionamento_sem_delete before delete on fv2_provisionamento_inicial for each row execute function fv2_somente_insercao();

revoke all on fv2_sessao_banco, fv2_auditoria_concessao, fv2_provisionamento_inicial from public;
grant select, insert, update on fv2_sessao_banco, fv2_provisionamento_inicial to fv2_guardiao;
grant select, insert on fv2_auditoria_concessao to fv2_guardiao;
grant select on fv2_escopo to fv2_guardiao;
grant select, insert, update on fv2_concessao to fv2_guardiao;

-- Exceção EXPLÍCITA e restrita: o guardião (sem login, sem membros) só é alcançado pelas funções abaixo, que filtram o
-- escopo pela própria sessão. Nenhum outro papel ganha política nova.
create policy fv2_concessao_guardiao on fv2_concessao to fv2_guardiao using (true) with check (true);
create policy fv2_escopo_guardiao on fv2_escopo for select to fv2_guardiao using (true);

-- A aplicação não escreve mais concessões por SQL.
revoke insert, update, delete, truncate on fv2_concessao from fv2_app;

-- ------------------------------------------------------------------------------------------------ sessão vigente
create type fv2_sessao_vigente as (
  sessao_id uuid, usuario_id uuid, organizacao_id uuid, unidade_id uuid,
  finalidade text, pode_escrever boolean, alvo uuid, acoes_autorizadas jsonb
);

create function fv2__sessao_vigente() returns setof fv2_sessao_vigente
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select s.id, s.usuario_id, s.organizacao_id, s.unidade_id, s.finalidade, s.pode_escrever, s.alvo, s.acoes_autorizadas
    from fv2_sessao_banco s
   where s.token_hash = sha256(convert_to(nullif(current_setting('fv2.sessao', true), ''), 'UTF8'))
     and s.revogada_em is null
     and s.expira_em > now()
$$;

create or replace function fv2_org() returns uuid language sql stable as $$ select organizacao_id from fv2__sessao_vigente() $$;
create or replace function fv2_uni() returns uuid language sql stable as $$ select unidade_id from fv2__sessao_vigente() $$;
create function fv2_usuario() returns uuid language sql stable as $$ select usuario_id from fv2__sessao_vigente() $$;
create function fv2_sessao_operacional() returns boolean language sql stable as
  $$ select coalesce((select finalidade = 'OPERACAO' from fv2__sessao_vigente()), false) $$;
create function fv2_pode_escrever() returns boolean language sql stable as
  $$ select coalesce((select finalidade = 'OPERACAO' and pode_escrever from fv2__sessao_vigente()), false) $$;
create function fv2_em_provisionamento() returns boolean language sql stable as
  $$ select coalesce((select finalidade = 'PROVISIONAMENTO' from fv2__sessao_vigente()), false) $$;

/** A aplicação declara o token da transação. Limpa qualquer valor de sessão deixado na conexão (pool). */
create function fv2_assumir_sessao(p_token text) returns fv2_sessao_vigente language plpgsql as $$
declare
  v fv2_sessao_vigente;
begin
  perform set_config('fv2.sessao', '', false);
  perform set_config('fv2.sessao', coalesce(p_token, ''), true);
  select * into v from fv2__sessao_vigente();
  return v;
end $$;

-- ------------------------------------------------------------------------------------------------ emissão (autoridade)
create function fv2__acoes_ordenadas(p jsonb) returns jsonb language sql immutable as
  $$ select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from (select distinct x from jsonb_array_elements_text(p) x) d $$;

create function fv2__trava_concessoes(p_organizacao uuid, p_unidade uuid, p_exclusiva boolean) returns void language plpgsql as $$
begin
  if p_exclusiva then
    perform pg_advisory_xact_lock(hashtextextended('fv2|' || p_organizacao || '|' || p_unidade || '|concessoes', 0));
  else
    perform pg_advisory_xact_lock_shared(hashtextextended('fv2|' || p_organizacao || '|' || p_unidade || '|concessoes', 0));
  end if;
end $$;

create function fv2__novo_token() returns text language sql volatile as
  $$ select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') $$;

create function fv2_abrir_sessao(p_usuario uuid, p_organizacao uuid, p_unidade uuid, p_validade_segundos integer, p_referencia text)
returns text language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  acoes jsonb;
  token text := fv2__novo_token();
begin
  if p_usuario is null or p_organizacao is null or p_unidade is null then
    raise exception 'Financeiro v2: sessão sem usuário, organização ou unidade.' using errcode = '22023';
  end if;
  if p_validade_segundos is null or p_validade_segundos < 1 or p_validade_segundos > 43200 then
    raise exception 'Financeiro v2: validade da sessão fora do limite (1 s a 12 h).' using errcode = '22023';
  end if;
  if not exists (select 1 from fv2_escopo e where e.organizacao_id = p_organizacao and e.unidade_id = p_unidade) then
    raise exception 'Financeiro v2: escopo não configurado.' using errcode = 'FV020';
  end if;
  -- Compartilhada: espera concessões em alteração no escopo terminarem (uma revogação em andamento nunca é "furada").
  perform fv2__trava_concessoes(p_organizacao, p_unidade, false);
  select c.acoes into acoes from fv2_concessao c
   where c.organizacao_id = p_organizacao and c.unidade_id = p_unidade and c.usuario_id = p_usuario and c.situacao = 'ATIVA';
  if acoes is null or jsonb_array_length(acoes) = 0 then
    raise exception 'Financeiro v2: usuário sem concessão ativa nesta unidade.' using errcode = 'FV020';
  end if;
  insert into fv2_sessao_banco (token_hash, usuario_id, organizacao_id, unidade_id, finalidade, pode_escrever, referencia, expira_em)
  values (sha256(convert_to(token, 'UTF8')), p_usuario, p_organizacao, p_unidade, 'OPERACAO',
          exists (select 1 from jsonb_array_elements_text(acoes) a where a <> 'financeiro_v2.ver'),
          left(p_referencia, 200), clock_timestamp() + make_interval(secs => p_validade_segundos));
  return token;
end $$;

create function fv2_abrir_sessao_de_provisionamento(p_atestante uuid, p_usuario uuid, p_organizacao uuid, p_unidade uuid,
  p_acoes jsonb, p_nivel_autenticacao text, p_justificativa text, p_evidencia text)
returns text language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  token text := fv2__novo_token();
  sessao uuid;
  acoes jsonb;
begin
  if p_atestante is null or p_usuario is null or p_organizacao is null or p_unidade is null then
    raise exception 'Financeiro v2: provisionamento incompleto.' using errcode = 'FV021';
  end if;
  if p_nivel_autenticacao is distinct from 'aal2' then
    raise exception 'Financeiro v2: o atestante precisa de autenticação multifator (aal2).' using errcode = 'FV021';
  end if;
  if p_atestante = p_usuario then
    raise exception 'Financeiro v2: o atestante não provisiona a si mesmo.' using errcode = 'FV021';
  end if;
  if coalesce(length(btrim(p_justificativa)), 0) not between 1 and 500 or coalesce(length(btrim(p_evidencia)), 0) not between 1 and 300 then
    raise exception 'Financeiro v2: provisionamento exige justificativa e evidência.' using errcode = 'FV021';
  end if;
  if jsonb_typeof(p_acoes) is distinct from 'array' or jsonb_array_length(p_acoes) = 0 then
    raise exception 'Financeiro v2: provisionamento exige ações explícitas.' using errcode = 'FV021';
  end if;
  acoes := fv2__acoes_ordenadas(p_acoes);
  if not exists (select 1 from fv2_escopo e where e.organizacao_id = p_organizacao and e.unidade_id = p_unidade) then
    raise exception 'Financeiro v2: escopo não configurado.' using errcode = 'FV021';
  end if;
  perform fv2__trava_concessoes(p_organizacao, p_unidade, true);
  if exists (select 1 from fv2_concessao c where c.organizacao_id = p_organizacao and c.unidade_id = p_unidade
              and c.situacao = 'ATIVA' and c.acoes ? 'financeiro_v2.conceder') then
    raise exception 'Financeiro v2: a unidade já tem administrador; provisionamento inicial recusado.' using errcode = 'FV021';
  end if;
  insert into fv2_sessao_banco (token_hash, usuario_id, organizacao_id, unidade_id, finalidade, pode_escrever, alvo, acoes_autorizadas, referencia, expira_em)
  values (sha256(convert_to(token, 'UTF8')), p_atestante, p_organizacao, p_unidade, 'PROVISIONAMENTO', false, p_usuario, acoes,
          'provisionamento inicial', clock_timestamp() + interval '2 minutes')
  returning id into sessao;
  insert into fv2_provisionamento_inicial (organizacao_id, unidade_id, usuario_id, atestante_id, nivel_autenticacao, acoes, justificativa, evidencia, sessao_id)
  values (p_organizacao, p_unidade, p_usuario, p_atestante, p_nivel_autenticacao, acoes, btrim(p_justificativa), btrim(p_evidencia), sessao);
  return token;
end $$;

/** Logout, troca de contexto ou revogação da sessão da plataforma: encerra as sessões de banco do usuário no escopo. */
create function fv2_encerrar_sessoes(p_usuario uuid, p_organizacao uuid, p_unidade uuid, p_motivo text)
returns integer language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  n integer;
begin
  update fv2_sessao_banco set revogada_em = clock_timestamp(), motivo_revogacao = left(coalesce(p_motivo, 'encerrada pela autoridade'), 200)
   where usuario_id = p_usuario and organizacao_id = p_organizacao and unidade_id = p_unidade and revogada_em is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- ------------------------------------------------------------------------------------------------ escrita de concessão
create function fv2_gravar_concessao(p jsonb, p_versao_esperada integer)
returns integer language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  s fv2_sessao_vigente;
  r fv2_concessao;
  atual fv2_concessao;
  ator jsonb;
  antes jsonb;
  novas jsonb;
  operacao text;
  n integer;
begin
  select * into s from fv2__sessao_vigente();
  if s.sessao_id is null then
    raise exception 'Financeiro v2: sessão de banco ausente, expirada ou revogada.' using errcode = '42501';
  end if;
  r := jsonb_populate_record(null::fv2_concessao, p);
  if r.organizacao_id is distinct from s.organizacao_id or r.unidade_id is distinct from s.unidade_id then
    raise exception 'Financeiro v2: concessão fora do escopo da sessão.' using errcode = '42501';
  end if;
  perform fv2__trava_concessoes(s.organizacao_id, s.unidade_id, true);
  -- Revalida DEPOIS da trava: a sessão do ator pode ter sido revogada enquanto esperava.
  select * into s from fv2__sessao_vigente();
  if s.sessao_id is null then
    raise exception 'Financeiro v2: sessão de banco revogada durante a operação.' using errcode = '42501';
  end if;
  if r.usuario_id = s.usuario_id then
    raise exception 'Financeiro v2: ninguém concede nem revoga o próprio acesso.' using errcode = 'FV030';
  end if;
  if r.atualizado_por is distinct from s.usuario_id or r.concedido_por is distinct from s.usuario_id then
    raise exception 'Financeiro v2: a autoria da concessão é a do usuário da sessão.' using errcode = 'FV031';
  end if;
  select * into atual from fv2_concessao c where c.organizacao_id = s.organizacao_id and c.unidade_id = s.unidade_id and c.id = r.id;
  if atual.id is not null and atual.usuario_id <> r.usuario_id then
    raise exception 'Financeiro v2: uma concessão não muda de usuário.' using errcode = 'FV033';
  end if;
  antes := case when atual.id is not null and atual.situacao = 'ATIVA' then atual.acoes else '[]'::jsonb end;
  select coalesce(jsonb_agg(a), '[]'::jsonb) into novas from jsonb_array_elements_text(r.acoes) a where not (antes ? a);

  if s.finalidade = 'PROVISIONAMENTO' then
    if r.usuario_id is distinct from s.alvo or r.situacao <> 'ATIVA' or fv2__acoes_ordenadas(r.acoes) is distinct from s.acoes_autorizadas then
      raise exception 'Financeiro v2: o provisionamento grava exatamente o que foi atestado.' using errcode = 'FV035';
    end if;
    if exists (select 1 from fv2_concessao c where c.organizacao_id = s.organizacao_id and c.unidade_id = s.unidade_id
                and c.situacao = 'ATIVA' and c.acoes ? 'financeiro_v2.conceder') then
      raise exception 'Financeiro v2: a unidade já tem administrador.' using errcode = 'FV035';
    end if;
    operacao := 'PROVISIONAMENTO';
  else
    select c.acoes into ator from fv2_concessao c
     where c.organizacao_id = s.organizacao_id and c.unidade_id = s.unidade_id and c.usuario_id = s.usuario_id and c.situacao = 'ATIVA';
    if ator is null or not (ator ? 'financeiro_v2.conceder') then
      raise exception 'Financeiro v2: o usuário da sessão não tem concessão para conceder.' using errcode = 'FV032';
    end if;
    if exists (select 1 from jsonb_array_elements_text(novas) a where not (ator ? a)) then
      raise exception 'Financeiro v2: não é possível conceder uma ação que você não possui.' using errcode = 'FV034';
    end if;
    operacao := case when jsonb_array_length(novas) > 0 then 'CONCESSAO' else 'REVOGACAO' end;
  end if;

  if p_versao_esperada is null then
    insert into fv2_concessao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por,
                               chave_idempotencia, impressao, extras, usuario_id, acoes, situacao, concedido_por, justificativa)
    values (r.id, r.organizacao_id, r.unidade_id, r.versao, r.criado_em, r.criado_por, r.atualizado_em, r.atualizado_por,
            r.chave_idempotencia, r.impressao, coalesce(r.extras, '{}'::jsonb), r.usuario_id, r.acoes, r.situacao, r.concedido_por, r.justificativa);
    n := 1;
  else
    update fv2_concessao c
       set versao = r.versao, atualizado_em = r.atualizado_em, atualizado_por = r.atualizado_por, impressao = r.impressao,
           extras = coalesce(r.extras, '{}'::jsonb), acoes = r.acoes, situacao = r.situacao, concedido_por = r.concedido_por,
           justificativa = r.justificativa
     where c.organizacao_id = s.organizacao_id and c.unidade_id = s.unidade_id and c.id = r.id and c.versao = p_versao_esperada;
    get diagnostics n = row_count;
    if n = 0 then
      return 0;
    end if;
  end if;

  insert into fv2_auditoria_concessao (organizacao_id, unidade_id, concessao_id, usuario_alvo, ator, sessao_id, finalidade, operacao,
                                       acoes_antes, acoes_depois, situacao_depois, justificativa)
  values (s.organizacao_id, s.unidade_id, r.id, r.usuario_id, s.usuario_id, s.sessao_id, s.finalidade, operacao,
          coalesce(atual.acoes, '[]'::jsonb), r.acoes, r.situacao, r.justificativa);
  -- Qualquer mudança nos direitos do alvo derruba as sessões de banco dele: a próxima transação recalcula (ou é recusada).
  update fv2_sessao_banco b set revogada_em = clock_timestamp(), motivo_revogacao = 'concessão alterada'
   where b.usuario_id = r.usuario_id and b.organizacao_id = s.organizacao_id and b.unidade_id = s.unidade_id and b.revogada_em is null;
  if s.finalidade = 'PROVISIONAMENTO' then
    update fv2_provisionamento_inicial p set concluido_em = clock_timestamp() where p.sessao_id = s.sessao_id and p.concluido_em is null;
  end if;
  return n;
end $$;

-- ------------------------------------------------------------------------------------------------ propriedade e execução
do $$
declare
  f text;
begin
  foreach f in array array[
    'fv2__sessao_vigente()', 'fv2_abrir_sessao(uuid, uuid, uuid, integer, text)',
    'fv2_abrir_sessao_de_provisionamento(uuid, uuid, uuid, uuid, jsonb, text, text, text)',
    'fv2_encerrar_sessoes(uuid, uuid, uuid, text)', 'fv2_gravar_concessao(jsonb, integer)'
  ] loop
    execute format('alter function %s owner to fv2_guardiao', f);
    execute format('revoke all on function %s from public', f);
  end loop;
end $$;
grant execute on function fv2__sessao_vigente() to fv2_app;
grant execute on function fv2_gravar_concessao(jsonb, integer) to fv2_app;
grant execute on function fv2_abrir_sessao(uuid, uuid, uuid, integer, text) to fv2_autoridade;
grant execute on function fv2_abrir_sessao_de_provisionamento(uuid, uuid, uuid, uuid, jsonb, text, text, text) to fv2_autoridade;
grant execute on function fv2_encerrar_sessoes(uuid, uuid, uuid, text) to fv2_autoridade;
revoke all on function fv2__trava_concessoes(uuid, uuid, boolean) from public;
grant execute on function fv2__trava_concessoes(uuid, uuid, boolean) to fv2_guardiao;

-- ------------------------------------------------------------------------------------------------ políticas
-- 1) escopo da sessão avaliado UMA vez por consulta (subconsulta), não por linha;
-- 2) leitura só com sessão operacional (a de provisionamento enxerga apenas concessões e o histórico delas);
-- 3) escrita só com sessão operacional que tenha alguma ação além de `ver`.
do $$
declare
  p record;
  t record;
  usando text;
  conferindo text;
begin
  for p in select tablename, policyname, qual, with_check from pg_policies
            where schemaname = current_schema() and tablename like 'fv2\_%' and (qual like '%fv2_org()%' or with_check like '%fv2_org()%') loop
    usando := replace(replace(p.qual, 'fv2_org()', '(select fv2_org())'), 'fv2_uni()', '(select fv2_uni())');
    conferindo := replace(replace(p.with_check, 'fv2_org()', '(select fv2_org())'), 'fv2_uni()', '(select fv2_uni())');
    if conferindo is null then
      execute format('alter policy %I on %I using (%s)', p.policyname, p.tablename, usando);
    else
      execute format('alter policy %I on %I using (%s) with check (%s)', p.policyname, p.tablename, usando, conferindo);
    end if;
  end loop;
  for t in select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
            where ns.nspname = current_schema() and c.relkind = 'r' and c.relrowsecurity and c.relname like 'fv2\_%'
              and c.relname not in ('fv2_concessao', 'fv2_escopo', 'fv2_historico') loop
    execute format('create policy %I on %I as restrictive for select using ((select fv2_sessao_operacional()))', t.relname || '_ler', t.relname);
    execute format('create policy %I on %I as restrictive for insert with check ((select fv2_pode_escrever()))', t.relname || '_incluir', t.relname);
    execute format('create policy %I on %I as restrictive for update using ((select fv2_pode_escrever()))', t.relname || '_alterar', t.relname);
  end loop;
end $$;

create policy fv2_historico_ler on fv2_historico as restrictive for select
  using ((select fv2_sessao_operacional()) or registro_tipo = 'CONCESSAO');
create policy fv2_historico_incluir on fv2_historico as restrictive for insert
  with check ((select fv2_pode_escrever()) or ((select fv2_em_provisionamento()) and registro_tipo = 'CONCESSAO'));
