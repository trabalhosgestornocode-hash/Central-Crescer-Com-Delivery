-- =====================================================================
-- MIGRATION 110 — Checklist Operacional: telas de exibição (TV/tablet) e pareamento por código
-- =====================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO SEM APROVAÇÃO EXPLÍCITA. Escrita e testada SÓ contra um Postgres local descartável
--     (backend/test/exibicao-migration-110-pg.test.js). A aplicação é um passo separado.
-- ✅  Puramente ADITIVA: duas tabelas novas, funções novas e UM gatilho novo em `unidades` (só reage a troca de
--     empresa e desativação, para revogar as telas daquela unidade). Nenhuma coluna/regra existente muda.
--     Rollback: 110_rollback.sql (aborta se houver tela ativa).
--
-- O QUE É: uma credencial de APARELHO, separada da conta do Supabase e do Context Token. Uma tela pertence a UMA
-- empresa + UMA unidade, para sempre (não troca de unidade), e só lê o resumo do Checklist. Ver
-- docs/exibicao-sessoes-modelo.md (modelo de ameaças, cookies, contratos).
--
-- SEGREDOS NUNCA EM CLARO: o token da tela (256 bits aleatórios, num cookie HttpOnly) e o segredo do pareamento
-- (idem, num cookie HttpOnly do aparelho) são guardados como SHA-256 em hex. O código digitado/lido por QR (curto,
-- ~40 bits) é guardado como HMAC-SHA-256 com segredo do servidor — um vazamento do banco não permite reverter os
-- códigos por força bruta. O banco nunca recebe nem devolve nada em claro.
--
-- ACESSO SÓ POR FUNÇÃO: as tabelas não têm privilégio para NENHUM papel (nem service_role). Tudo passa por funções
-- SECURITY DEFINER (search_path fixo, EXECUTE só para service_role) que (1) exigem empresa+unidade explícitas em toda
-- gestão, (2) nunca devolvem hash, (3) fazem as transições com FOR UPDATE — aprovação e consumo atômicos, sem
-- dupla aprovação nem reuso de pareamento.
--
-- FAIL-CLOSED: a resolução da tela confere, numa única transação, revogação, expiração absoluta, inatividade,
-- unidade ativa e ainda na mesma empresa, empresa ativa e módulo `ifood` contratado. Qualquer "não" = sem dados.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------------
-- Pareamentos: pedido de uma tela ainda sem credencial (código na tela / QR) -> aprovado pelo gerente -> consumido
-- ---------------------------------------------------------------------------
create table if not exists pareamentos_exibicao (
  id                      uuid primary key default gen_random_uuid(),
  codigo_hash             text not null,
  segredo_hash            text not null,
  estado                  text not null default 'pendente',
  criado_em               timestamptz not null default now(),
  expira_em               timestamptz not null,
  navegador_resumo        text,
  rede_prefixo            text,
  organizacao_id          uuid references organizacoes(id) on delete cascade,
  unidade_id              uuid references unidades(id) on delete cascade,
  aprovado_por_conta_id   uuid,
  aprovado_por_perfil_id  uuid references perfis_operacionais(id) on delete set null,
  aprovado_em             timestamptz,
  nome_dispositivo        text,
  modo_dispositivo        text,
  consumido_em            timestamptz,
  dispositivo_id          uuid,
  constraint pareamentos_exibicao_codigo_hex   check (codigo_hash ~ '^[0-9a-f]{64}$'),
  constraint pareamentos_exibicao_segredo_hex  check (segredo_hash ~ '^[0-9a-f]{64}$'),
  constraint pareamentos_exibicao_estado       check (estado in ('pendente', 'aprovado', 'consumido', 'expirado', 'cancelado')),
  constraint pareamentos_exibicao_validade     check (expira_em > criado_em and expira_em <= criado_em + interval '15 minutes'),
  constraint pareamentos_exibicao_navegador    check (navegador_resumo is null or char_length(navegador_resumo) <= 80),
  constraint pareamentos_exibicao_rede         check (rede_prefixo is null or char_length(rede_prefixo) <= 45),
  constraint pareamentos_exibicao_nome         check (nome_dispositivo is null or char_length(btrim(nome_dispositivo)) between 1 and 60),
  constraint pareamentos_exibicao_modo         check (modo_dispositivo is null or modo_dispositivo in ('tv', 'tablet')),
  -- Aprovado/consumido sempre tem dono (empresa+unidade+quem aprovou+quando); pendente/expirado nunca tem unidade.
  constraint pareamentos_exibicao_aprovacao    check (
    (estado in ('aprovado', 'consumido')) = (organizacao_id is not null and unidade_id is not null
      and aprovado_por_conta_id is not null and aprovado_em is not null and nome_dispositivo is not null and modo_dispositivo is not null)
    or estado = 'cancelado'),
  constraint pareamentos_exibicao_pendente_sem_unidade check (estado not in ('pendente', 'expirado') or unidade_id is null),
  constraint pareamentos_exibicao_consumo      check ((estado = 'consumido') = (consumido_em is not null and dispositivo_id is not null))
);

-- Código ativo é único (colisão na geração = gerar outro); segredo é único sempre.
create unique index if not exists uq_pareamentos_exibicao_codigo_pendente
  on pareamentos_exibicao (codigo_hash) where estado in ('pendente', 'aprovado');
create unique index if not exists uq_pareamentos_exibicao_segredo on pareamentos_exibicao (segredo_hash);
create index if not exists idx_pareamentos_exibicao_expira on pareamentos_exibicao (expira_em) where estado in ('pendente', 'aprovado');
create index if not exists idx_pareamentos_exibicao_rede on pareamentos_exibicao (rede_prefixo, criado_em) where estado = 'pendente';
create index if not exists idx_pareamentos_exibicao_unidade on pareamentos_exibicao (unidade_id) where unidade_id is not null;

-- ---------------------------------------------------------------------------
-- Telas (dispositivos) — a credencial de exibição
-- ---------------------------------------------------------------------------
create table if not exists dispositivos_exibicao (
  id                         uuid primary key default gen_random_uuid(),
  organizacao_id             uuid not null references organizacoes(id) on delete cascade,
  unidade_id                 uuid not null references unidades(id) on delete cascade,
  nome                       text not null,
  modo_padrao                text not null default 'tv',
  -- Rotação sem tela órfã: o token anterior vale até o novo ser USADO uma vez (+ folga curta para requisições em voo).
  token_hash                 text not null,
  token_anterior_hash        text,
  token_rotacionado_em       timestamptz not null default now(),
  token_confirmado_em        timestamptz,
  token_anterior_valido_ate  timestamptz,
  autorizado_por_conta_id    uuid not null,
  autorizado_por_perfil_id   uuid references perfis_operacionais(id) on delete set null,
  criado_em                  timestamptz not null default now(),
  ultimo_uso_em              timestamptz not null default now(),
  expira_em                  timestamptz not null,
  inatividade_dias           integer not null default 30,
  navegador_resumo           text,
  rede_prefixo               text,
  reuso_contador             integer not null default 0,
  suspeita_em                timestamptz,
  ultimo_reuso_em            timestamptz,
  ultimo_reuso_rede          text,
  revogado_em                timestamptz,
  revogado_por_conta_id      uuid,
  motivo_revogacao           text,
  constraint dispositivos_exibicao_nome        check (char_length(btrim(nome)) between 1 and 60),
  constraint dispositivos_exibicao_modo        check (modo_padrao in ('tv', 'tablet')),
  constraint dispositivos_exibicao_token_hex   check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint dispositivos_exibicao_anterior    check (token_anterior_hash is null
    or (token_anterior_hash ~ '^[0-9a-f]{64}$' and token_anterior_hash <> token_hash)),
  constraint dispositivos_exibicao_validade    check (expira_em > criado_em and expira_em <= criado_em + interval '180 days'),
  constraint dispositivos_exibicao_inatividade check (inatividade_dias between 1 and 90),
  constraint dispositivos_exibicao_navegador   check (navegador_resumo is null or char_length(navegador_resumo) <= 80),
  constraint dispositivos_exibicao_rede        check (rede_prefixo is null or char_length(rede_prefixo) <= 45),
  constraint dispositivos_exibicao_reuso       check (reuso_contador >= 0),
  constraint dispositivos_exibicao_reuso_rede  check (ultimo_reuso_rede is null or char_length(ultimo_reuso_rede) <= 45),
  constraint dispositivos_exibicao_revogacao   check ((revogado_em is null) = (motivo_revogacao is null)),
  constraint dispositivos_exibicao_motivo      check (motivo_revogacao is null or motivo_revogacao in (
    'manual', 'unidade_revogada_em_massa', 'desconectado_no_aparelho', 'unidade_transferida', 'unidade_desativada'))
);

create unique index if not exists uq_dispositivos_exibicao_token on dispositivos_exibicao (token_hash);
create unique index if not exists uq_dispositivos_exibicao_token_anterior
  on dispositivos_exibicao (token_anterior_hash) where token_anterior_hash is not null;
create index if not exists idx_dispositivos_exibicao_unidade_ativos
  on dispositivos_exibicao (organizacao_id, unidade_id) where revogado_em is null;

-- O pedido consumido é o histórico da própria tela: apagar a tela (limpeza) apaga o pedido que a criou.
alter table pareamentos_exibicao
  add constraint pareamentos_exibicao_dispositivo_fk foreign key (dispositivo_id) references dispositivos_exibicao(id) on delete cascade;

-- ---------------------------------------------------------------------------
-- Integridade de tenant: a unidade é sempre da empresa informada; tela nunca muda de empresa/unidade;
-- pareamento só recebe unidade uma vez (na aprovação).
-- ---------------------------------------------------------------------------
create or replace function exibicao_conferir_tenant() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if tg_table_name = 'dispositivos_exibicao'
       and (new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id) then
      raise exception 'tela de exibição não muda de empresa/unidade' using errcode = 'check_violation';
    end if;
    if tg_table_name = 'pareamentos_exibicao' and old.unidade_id is not null
       and (new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id) then
      raise exception 'pareamento aprovado não muda de empresa/unidade' using errcode = 'check_violation';
    end if;
  end if;
  if new.unidade_id is not null and not exists (
       select 1 from public.unidades u where u.id = new.unidade_id and u.organizacao_id = new.organizacao_id) then
    raise exception 'unidade não pertence à empresa informada' using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_dispositivos_exibicao_tenant on dispositivos_exibicao;
create trigger trg_dispositivos_exibicao_tenant before insert or update of organizacao_id, unidade_id
  on dispositivos_exibicao for each row execute function exibicao_conferir_tenant();
drop trigger if exists trg_pareamentos_exibicao_tenant on pareamentos_exibicao;
create trigger trg_pareamentos_exibicao_tenant before insert or update of organizacao_id, unidade_id
  on pareamentos_exibicao for each row execute function exibicao_conferir_tenant();

-- Unidade transferida para outra empresa ou desativada: revoga as telas e cancela pareamentos aprovados dela.
-- (A resolução já recusa nesses casos; isto deixa o registro coerente e visível na gestão.)
create or replace function exibicao_unidade_alterada() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_motivo text;
begin
  if new.organizacao_id is distinct from old.organizacao_id then
    v_motivo := 'unidade_transferida';
  elsif old.ativo and not new.ativo then
    v_motivo := 'unidade_desativada';
  else
    return new;
  end if;
  update public.dispositivos_exibicao set revogado_em = now(), motivo_revogacao = v_motivo
   where unidade_id = new.id and revogado_em is null;
  update public.pareamentos_exibicao set estado = 'cancelado'
   where unidade_id = new.id and estado = 'aprovado';
  return new;
end;
$$;

drop trigger if exists trg_exibicao_unidade_alterada on unidades;
create trigger trg_exibicao_unidade_alterada after update of organizacao_id, ativo
  on unidades for each row execute function exibicao_unidade_alterada();

-- ---------------------------------------------------------------------------
-- Elegibilidade da unidade (usada na aprovação, no consumo e em TODA resolução)
-- ---------------------------------------------------------------------------
create or replace function exibicao_unidade_elegivel(p_organizacao_id uuid, p_unidade_id uuid) returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when u.id is null or u.organizacao_id is distinct from p_organizacao_id or not u.ativo then 'unidade_indisponivel'
    when o.id is null or not o.ativo or o.status::text in ('bloqueada', 'suspensa', 'cancelada') then 'empresa_indisponivel'
    when not exists (select 1 from public.organizacao_modulos m
                      where m.organizacao_id = p_organizacao_id and m.modulo_id = 'ifood') then 'modulo_indisponivel'
    else 'ok'
  end
  from (select 1) base
  left join public.unidades u on u.id = p_unidade_id
  left join public.organizacoes o on o.id = p_organizacao_id;
$$;

-- ---------------------------------------------------------------------------
-- PAREAMENTO
-- ---------------------------------------------------------------------------

-- A tela pede um código. Limites: 60–900 s de validade; no máximo 20 pedidos pendentes por rede e 2000 no total
-- (contra enchimento da tabela). Pedidos vencidos viram `expirado` aqui mesmo (limpeza oportunista e limitada).
create or replace function exibicao_pareamento_iniciar(
  p_codigo_hash text, p_segredo_hash text, p_validade_s integer, p_rede text default null, p_navegador text default null
) returns table(resultado text, pareamento_id uuid, expira_em timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_expira timestamptz;
begin
  if p_validade_s is null or p_validade_s < 60 or p_validade_s > 900 then
    raise exception 'validade do pareamento fora da faixa (60..900 s)' using errcode = 'invalid_parameter_value';
  end if;
  update public.pareamentos_exibicao set estado = 'expirado'
   where id in (select x.id from public.pareamentos_exibicao x
                 where x.estado = 'pendente' and x.expira_em <= now() limit 500);
  if (select count(*) from public.pareamentos_exibicao x where x.estado = 'pendente') >= 2000 then
    return query select 'limite_global'::text, null::uuid, null::timestamptz; return;
  end if;
  if p_rede is not null and (select count(*) from public.pareamentos_exibicao x
                              where x.estado = 'pendente' and x.rede_prefixo = p_rede) >= 20 then
    return query select 'limite_rede'::text, null::uuid, null::timestamptz; return;
  end if;
  begin
    insert into public.pareamentos_exibicao (codigo_hash, segredo_hash, expira_em, rede_prefixo, navegador_resumo)
    values (p_codigo_hash, p_segredo_hash, now() + make_interval(secs => p_validade_s),
            left(p_rede, 45), left(p_navegador, 80))
    returning id, pareamentos_exibicao.expira_em into v_id, v_expira;
  exception when unique_violation then
    return query select 'codigo_em_uso'::text, null::uuid, null::timestamptz; return;
  end;
  return query select 'ok'::text, v_id, v_expira;
end;
$$;

-- A tela consulta o próprio pedido (pelo segredo do cookie dela). Só devolve o nome da unidade depois da aprovação.
create or replace function exibicao_pareamento_estado(p_segredo_hash text)
returns table(estado text, expira_em timestamptz, unidade_nome text, nome_dispositivo text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p public.pareamentos_exibicao%rowtype;
begin
  select * into p from public.pareamentos_exibicao x where x.segredo_hash = p_segredo_hash;
  if not found then
    return query select 'nao_encontrado'::text, null::timestamptz, null::text, null::text; return;
  end if;
  if p.estado in ('pendente', 'aprovado') and p.expira_em <= now() then
    return query select 'expirado'::text, p.expira_em, null::text, null::text; return;
  end if;
  return query
    select p.estado, p.expira_em,
           case when p.estado in ('aprovado', 'consumido') then (select u.nome from public.unidades u where u.id = p.unidade_id) end,
           case when p.estado in ('aprovado', 'consumido') then p.nome_dispositivo end;
end;
$$;

-- Antes de aprovar, o gerente vê de QUANDO é o pedido e de que navegador/rede ele veio (para reconhecer a TV
-- que está na frente dele). Só pedidos pendentes e válidos; nada de unidade, hash ou segredo.
create or replace function exibicao_pareamento_consultar(p_codigo_hash text)
returns table(resultado text, criado_em timestamptz, expira_em timestamptz, navegador_resumo text, rede_prefixo text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  p public.pareamentos_exibicao%rowtype;
begin
  select * into p from public.pareamentos_exibicao x where x.codigo_hash = p_codigo_hash and x.estado in ('pendente', 'aprovado');
  if not found or p.expira_em <= now() then
    return query select 'nao_encontrado'::text, null::timestamptz, null::timestamptz, null::text, null::text; return;
  end if;
  if p.estado <> 'pendente' then
    return query select 'indisponivel'::text, null::timestamptz, null::timestamptz, null::text, null::text; return;
  end if;
  return query select 'ok'::text, p.criado_em, p.expira_em, p.navegador_resumo, p.rede_prefixo;
end;
$$;

-- O gerente aprova o código PARA A UNIDADE DO CONTEXTO DELE (empresa/unidade vêm do backend, nunca do corpo).
-- FOR UPDATE: duas aprovações simultâneas do mesmo código -> uma vence, a outra recebe `indisponivel`.
create or replace function exibicao_pareamento_aprovar(
  p_codigo_hash text, p_organizacao_id uuid, p_unidade_id uuid, p_conta_id uuid, p_perfil_id uuid,
  p_nome text, p_modo text
) returns table(resultado text, pareamento_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p public.pareamentos_exibicao%rowtype;
  v_eleg text;
begin
  if p_conta_id is null or p_organizacao_id is null or p_unidade_id is null then
    raise exception 'aprovação exige conta, empresa e unidade' using errcode = 'invalid_parameter_value';
  end if;
  if p_nome is null or char_length(btrim(p_nome)) not between 1 and 60 then
    return query select 'nome_invalido'::text, null::uuid; return;
  end if;
  if p_modo is null or p_modo not in ('tv', 'tablet') then
    return query select 'modo_invalido'::text, null::uuid; return;
  end if;
  v_eleg := public.exibicao_unidade_elegivel(p_organizacao_id, p_unidade_id);
  if v_eleg <> 'ok' then
    return query select v_eleg, null::uuid; return;
  end if;
  select * into p from public.pareamentos_exibicao x
   where x.codigo_hash = p_codigo_hash and x.estado in ('pendente', 'aprovado')
   for update;
  if not found then
    return query select 'nao_encontrado'::text, null::uuid; return;
  end if;
  if p.estado <> 'pendente' then
    return query select 'indisponivel'::text, null::uuid; return;
  end if;
  if p.expira_em <= now() then
    update public.pareamentos_exibicao set estado = 'expirado' where id = p.id;
    return query select 'expirado'::text, null::uuid; return;
  end if;
  update public.pareamentos_exibicao
     set estado = 'aprovado', organizacao_id = p_organizacao_id, unidade_id = p_unidade_id,
         aprovado_por_conta_id = p_conta_id, aprovado_por_perfil_id = p_perfil_id, aprovado_em = now(),
         nome_dispositivo = btrim(p_nome), modo_dispositivo = p_modo,
         -- a tela tem pelo menos 5 min para buscar a credencial, sem passar de 15 min desde o pedido
         expira_em = least(p.criado_em + interval '15 minutes', greatest(p.expira_em, now() + interval '5 minutes'))
   where id = p.id;
  return query select 'ok'::text, p.id;
end;
$$;

-- A tela troca o pedido APROVADO pela credencial definitiva (token novo, gerado pelo backend). Atômico: o pedido
-- vira `consumido` na mesma transação em que a tela nasce; uma segunda tentativa recebe `ja_consumido`.
create or replace function exibicao_pareamento_consumir(
  p_segredo_hash text, p_token_hash text, p_validade_dias integer, p_inatividade_dias integer, p_limite_unidade integer
) returns table(resultado text, dispositivo_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p public.pareamentos_exibicao%rowtype;
  v_eleg text;
  v_id uuid;
begin
  if p_validade_dias is null or p_validade_dias not between 1 and 180
     or p_inatividade_dias is null or p_inatividade_dias not between 1 and 90
     or p_limite_unidade is null or p_limite_unidade not between 1 and 100 then
    raise exception 'parâmetros de consumo fora da faixa' using errcode = 'invalid_parameter_value';
  end if;
  select * into p from public.pareamentos_exibicao x where x.segredo_hash = p_segredo_hash for update;
  if not found then
    return query select 'nao_encontrado'::text, null::uuid; return;
  end if;
  if p.estado = 'consumido' then
    return query select 'ja_consumido'::text, null::uuid; return;
  end if;
  if p.estado in ('pendente', 'aprovado') and p.expira_em <= now() then
    update public.pareamentos_exibicao set estado = 'expirado' where id = p.id and estado = 'pendente';
    if p.estado = 'aprovado' then update public.pareamentos_exibicao set estado = 'cancelado' where id = p.id; end if;
    return query select 'expirado'::text, null::uuid; return;
  end if;
  if p.estado = 'pendente' then
    return query select 'aguardando'::text, null::uuid; return;
  end if;
  if p.estado <> 'aprovado' then
    return query select 'indisponivel'::text, null::uuid; return;
  end if;
  v_eleg := public.exibicao_unidade_elegivel(p.organizacao_id, p.unidade_id);
  if v_eleg <> 'ok' then
    update public.pareamentos_exibicao set estado = 'cancelado' where id = p.id;
    return query select v_eleg, null::uuid; return;
  end if;
  -- Limite de telas ativas por unidade, serializado por unidade (duas telas consumindo ao mesmo tempo não furam).
  perform pg_advisory_xact_lock(hashtextextended('exibicao:' || p.unidade_id::text, 0));
  if (select count(*) from public.dispositivos_exibicao d
       where d.unidade_id = p.unidade_id and d.revogado_em is null and d.expira_em > now()) >= p_limite_unidade then
    update public.pareamentos_exibicao set estado = 'cancelado' where id = p.id;
    return query select 'limite_atingido'::text, null::uuid; return;
  end if;
  insert into public.dispositivos_exibicao (
    organizacao_id, unidade_id, nome, modo_padrao, token_hash, autorizado_por_conta_id, autorizado_por_perfil_id,
    expira_em, inatividade_dias, navegador_resumo, rede_prefixo, token_confirmado_em)
  values (
    p.organizacao_id, p.unidade_id, p.nome_dispositivo, p.modo_dispositivo, p_token_hash, p.aprovado_por_conta_id,
    p.aprovado_por_perfil_id, now() + make_interval(days => p_validade_dias), p_inatividade_dias, p.navegador_resumo,
    p.rede_prefixo, null)
  returning id into v_id;
  update public.pareamentos_exibicao set estado = 'consumido', consumido_em = now(), dispositivo_id = v_id where id = p.id;
  return query select 'ok'::text, v_id;
end;
$$;

-- A tela desiste do pedido (fechou a página de código).
create or replace function exibicao_pareamento_cancelar(p_segredo_hash text) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.pareamentos_exibicao set estado = 'cancelado'
   where segredo_hash = p_segredo_hash and estado in ('pendente', 'aprovado');
  return case when found then 'ok' else 'nao_encontrado' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- RESOLUÇÃO DA TELA (cada consulta da TV) — tudo fail-closed, numa transação
-- ---------------------------------------------------------------------------
-- Resultados: ok | ok_token_anterior | nao_encontrado | revogado | expirado | inativo | token_substituido |
--             unidade_indisponivel | empresa_indisponivel | modulo_indisponivel
--
-- Token anterior (rotação): vale enquanto o novo ainda não foi usado (Set-Cookie perdido não deixa a tela órfã)
-- e por 2 min depois do primeiro uso do novo (requisições em voo). Depois disso, o anterior NÃO autentica.
-- Reaparecimento do anterior NUNCA revoga sozinho: restauração de backup, sincronização do navegador, aba antiga,
-- proxy/cache, VPN e troca de rede móvel produzem o mesmo sinal que uma cópia do cookie — e mudança de rede não é
-- prova de nada. Política conservadora: o token anterior fica BLOQUEADO (aquela requisição é recusada), a tela é
-- marcada como suspeita (contador, quando, de que rede) para a gestão e a auditoria, e quem decide revogar é uma
-- pessoa com permissão. A tela legítima, que já usa o token novo, continua funcionando.
create or replace function exibicao_dispositivo_resolver(p_token_hash text, p_rede text default null, p_navegador text default null)
returns table(resultado text, dispositivo_id uuid, organizacao_id uuid, unidade_id uuid, nome text, modo_padrao text, rotacao_devida boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.dispositivos_exibicao%rowtype;
  v_atual boolean;
  v_eleg text;
  v_confirmou boolean := false;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return query select 'nao_encontrado'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, false; return;
  end if;
  select * into d from public.dispositivos_exibicao x
   where x.token_hash = p_token_hash or x.token_anterior_hash = p_token_hash
   for update;
  if not found then
    return query select 'nao_encontrado'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, false; return;
  end if;
  v_atual := d.token_hash = p_token_hash;

  if d.revogado_em is not null then
    return query select 'revogado'::text, d.id, null::uuid, null::uuid, null::text, null::text, false; return;
  end if;
  if now() >= d.expira_em then
    return query select 'expirado'::text, d.id, null::uuid, null::uuid, null::text, null::text, false; return;
  end if;
  if now() >= d.ultimo_uso_em + make_interval(days => d.inatividade_dias) then
    return query select 'inativo'::text, d.id, null::uuid, null::uuid, null::text, null::text, false; return;
  end if;

  if not v_atual then
    if d.token_confirmado_em is not null and (d.token_anterior_valido_ate is null or now() >= d.token_anterior_valido_ate) then
      update public.dispositivos_exibicao
         set reuso_contador = reuso_contador + 1, suspeita_em = coalesce(suspeita_em, now()),
             ultimo_reuso_em = now(), ultimo_reuso_rede = left(p_rede, 45)
       where id = d.id;
      return query select 'token_substituido'::text, d.id, null::uuid, null::uuid, null::text, null::text, false; return;
    end if;
  end if;

  v_eleg := public.exibicao_unidade_elegivel(d.organizacao_id, d.unidade_id);
  if v_eleg <> 'ok' then
    return query select v_eleg, d.id, null::uuid, null::uuid, null::text, null::text, false; return;
  end if;

  if v_atual and d.token_confirmado_em is null then
    v_confirmou := true;
    update public.dispositivos_exibicao
       set token_confirmado_em = now(),
           token_anterior_valido_ate = case when token_anterior_hash is null then null else now() + interval '2 minutes' end
     where id = d.id;
  end if;
  -- Última atividade gravada no máximo a cada 5 min (uma TV consulta a cada 30 s).
  if v_confirmou or d.ultimo_uso_em < now() - interval '5 minutes' then
    update public.dispositivos_exibicao
       set ultimo_uso_em = now(),
           rede_prefixo = coalesce(left(p_rede, 45), rede_prefixo),
           navegador_resumo = coalesce(left(p_navegador, 80), navegador_resumo)
     where id = d.id;
  end if;

  return query select
    case when v_atual then 'ok' else 'ok_token_anterior' end,
    d.id, d.organizacao_id, d.unidade_id, d.nome, d.modo_padrao,
    -- rotação diária; com o anterior em uso (cookie novo não chegou), tenta de novo depois de 1 h
    (v_atual and (d.token_confirmado_em is not null or v_confirmou) and d.token_rotacionado_em < now() - interval '24 hours')
    or (not v_atual and d.token_confirmado_em is null and d.token_rotacionado_em < now() - interval '1 hour');
end;
$$;

-- Troca do token (compare-and-swap). `p_hash_esperado` = o token que a requisição apresentou:
--   * atual            -> o atual vira anterior, o novo vira atual (ainda não confirmado);
--   * anterior + novo ainda não confirmado HÁ MAIS DE 1 H -> só o atual (cujo Set-Cookie se perdeu) é substituído.
-- Qualquer outra situação é `conflito` e a resposta segue sem Set-Cookie. Em especial, duas abas/requisições com o
-- mesmo token rotacionando ao mesmo tempo: a segunda vê o token já trocado há segundos -> `conflito` (sem isto, ela
-- trocaria de novo o token que a primeira acabou de entregar e a tela poderia ficar com um cookie que não vale).
create or replace function exibicao_dispositivo_rotacionar(p_dispositivo_id uuid, p_hash_esperado text, p_novo_hash text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.dispositivos_exibicao%rowtype;
begin
  if p_novo_hash is null or p_novo_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'hash novo inválido' using errcode = 'invalid_parameter_value';
  end if;
  select * into d from public.dispositivos_exibicao x where x.id = p_dispositivo_id for update;
  if not found or d.revogado_em is not null or now() >= d.expira_em then
    return 'indisponivel';
  end if;
  if d.token_hash = p_hash_esperado then
    update public.dispositivos_exibicao
       set token_anterior_hash = token_hash, token_hash = p_novo_hash, token_rotacionado_em = now(),
           token_confirmado_em = null, token_anterior_valido_ate = null
     where id = d.id;
    return 'ok';
  end if;
  if d.token_anterior_hash = p_hash_esperado and d.token_confirmado_em is null
     and d.token_rotacionado_em < now() - interval '1 hour' then
    update public.dispositivos_exibicao set token_hash = p_novo_hash, token_rotacionado_em = now() where id = d.id;
    return 'ok';
  end if;
  return 'conflito';
end;
$$;

-- A própria tela se desconecta (botão na TV). Só com a credencial dela.
create or replace function exibicao_dispositivo_desconectar(p_token_hash text) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then return 'nao_encontrado'; end if;
  update public.dispositivos_exibicao
     set revogado_em = now(), motivo_revogacao = 'desconectado_no_aparelho'
   where (token_hash = p_token_hash or (token_anterior_hash = p_token_hash and token_confirmado_em is null))
     and revogado_em is null;
  return case when found then 'ok' else 'nao_encontrado' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- GESTÃO (Central, gerente) — sempre com empresa + unidade explícitas; nunca devolve hash
-- ---------------------------------------------------------------------------
create or replace function exibicao_dispositivos_listar(p_organizacao_id uuid, p_unidade_id uuid)
returns table(id uuid, nome text, modo_padrao text, situacao text, criado_em timestamptz, ultimo_uso_em timestamptz,
              expira_em timestamptz, inativa_em timestamptz, navegador_resumo text, rede_prefixo text,
              suspeita_em timestamptz, reuso_contador integer, ultimo_reuso_em timestamptz, ultimo_reuso_rede text,
              revogado_em timestamptz, motivo_revogacao text, autorizado_por_conta_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, d.nome, d.modo_padrao,
         case when d.revogado_em is not null then 'revogada'
              when now() >= d.expira_em then 'expirada'
              when now() >= d.ultimo_uso_em + make_interval(days => d.inatividade_dias) then 'inativa'
              else 'ativa' end,
         d.criado_em, d.ultimo_uso_em, d.expira_em, d.ultimo_uso_em + make_interval(days => d.inatividade_dias),
         d.navegador_resumo, d.rede_prefixo, d.suspeita_em, d.reuso_contador, d.ultimo_reuso_em, d.ultimo_reuso_rede,
         d.revogado_em, d.motivo_revogacao, d.autorizado_por_conta_id
    from public.dispositivos_exibicao d
   where p_organizacao_id is not null and p_unidade_id is not null
     and d.organizacao_id = p_organizacao_id and d.unidade_id = p_unidade_id
     and (d.revogado_em is null or d.revogado_em > now() - interval '30 days')
   order by d.revogado_em nulls first, d.criado_em desc;
$$;

create or replace function exibicao_dispositivo_renomear(p_organizacao_id uuid, p_unidade_id uuid, p_dispositivo_id uuid, p_nome text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_organizacao_id is null or p_unidade_id is null then
    raise exception 'gestão exige empresa e unidade' using errcode = 'invalid_parameter_value';
  end if;
  if p_nome is null or char_length(btrim(p_nome)) not between 1 and 60 then return 'nome_invalido'; end if;
  update public.dispositivos_exibicao set nome = btrim(p_nome)
   where id = p_dispositivo_id and organizacao_id = p_organizacao_id and unidade_id = p_unidade_id and revogado_em is null;
  return case when found then 'ok' else 'nao_encontrado' end;
end;
$$;

-- Uma tela (p_dispositivo_id) ou todas da unidade (p_dispositivo_id null). Devolve quantas foram revogadas.
create or replace function exibicao_dispositivos_revogar(
  p_organizacao_id uuid, p_unidade_id uuid, p_dispositivo_id uuid, p_conta_id uuid
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  if p_organizacao_id is null or p_unidade_id is null or p_conta_id is null then
    raise exception 'revogação exige empresa, unidade e conta' using errcode = 'invalid_parameter_value';
  end if;
  update public.dispositivos_exibicao
     set revogado_em = now(), revogado_por_conta_id = p_conta_id,
         motivo_revogacao = case when p_dispositivo_id is null then 'unidade_revogada_em_massa' else 'manual' end
   where organizacao_id = p_organizacao_id and unidade_id = p_unidade_id and revogado_em is null
     and (p_dispositivo_id is null or id = p_dispositivo_id);
  get diagnostics v_n = row_count;
  if p_dispositivo_id is null then
    update public.pareamentos_exibicao set estado = 'cancelado'
     where organizacao_id = p_organizacao_id and unidade_id = p_unidade_id and estado = 'aprovado';
  end if;
  return v_n;
end;
$$;

-- Limpeza (job): pedidos de pareamento encerrados há mais de 1 dia; telas revogadas/expiradas há mais de 90 dias.
create or replace function exibicao_limpar(p_limite integer) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a integer; v_b integer;
begin
  if p_limite is null or p_limite < 1 or p_limite > 100000 then
    raise exception 'p_limite fora da faixa permitida (1..100000): %', p_limite using errcode = 'invalid_parameter_value';
  end if;
  delete from public.pareamentos_exibicao where id in (
    select x.id from public.pareamentos_exibicao x
     where (x.estado in ('consumido', 'expirado', 'cancelado') and x.criado_em < now() - interval '1 day')
        or (x.estado in ('pendente', 'aprovado') and x.expira_em < now() - interval '1 day')
     limit p_limite);
  get diagnostics v_a = row_count;
  delete from public.dispositivos_exibicao where id in (
    select d.id from public.dispositivos_exibicao d
     where (d.revogado_em is not null and d.revogado_em < now() - interval '90 days')
        or (d.revogado_em is null and d.expira_em < now() - interval '90 days')
     limit p_limite);
  get diagnostics v_b = row_count;
  return v_a + v_b;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privilégios: tabelas sem acesso direto para NENHUM papel; funções só para o service_role (backend)
-- ---------------------------------------------------------------------------
alter table pareamentos_exibicao enable row level security;
alter table dispositivos_exibicao enable row level security;
revoke all on pareamentos_exibicao from public, anon, authenticated, service_role;
revoke all on dispositivos_exibicao from public, anon, authenticated, service_role;

revoke all on function exibicao_conferir_tenant() from public, anon, authenticated, service_role;
revoke all on function exibicao_unidade_alterada() from public, anon, authenticated, service_role;
revoke all on function exibicao_unidade_elegivel(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function exibicao_pareamento_iniciar(text, text, integer, text, text) from public, anon, authenticated;
revoke all on function exibicao_pareamento_estado(text) from public, anon, authenticated;
revoke all on function exibicao_pareamento_consultar(text) from public, anon, authenticated;
revoke all on function exibicao_pareamento_aprovar(text, uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function exibicao_pareamento_consumir(text, text, integer, integer, integer) from public, anon, authenticated;
revoke all on function exibicao_pareamento_cancelar(text) from public, anon, authenticated;
revoke all on function exibicao_dispositivo_resolver(text, text, text) from public, anon, authenticated;
revoke all on function exibicao_dispositivo_rotacionar(uuid, text, text) from public, anon, authenticated;
revoke all on function exibicao_dispositivo_desconectar(text) from public, anon, authenticated;
revoke all on function exibicao_dispositivos_listar(uuid, uuid) from public, anon, authenticated;
revoke all on function exibicao_dispositivo_renomear(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function exibicao_dispositivos_revogar(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function exibicao_limpar(integer) from public, anon, authenticated;

grant execute on function exibicao_pareamento_iniciar(text, text, integer, text, text) to service_role;
grant execute on function exibicao_pareamento_estado(text) to service_role;
grant execute on function exibicao_pareamento_consultar(text) to service_role;
grant execute on function exibicao_pareamento_aprovar(text, uuid, uuid, uuid, uuid, text, text) to service_role;
grant execute on function exibicao_pareamento_consumir(text, text, integer, integer, integer) to service_role;
grant execute on function exibicao_pareamento_cancelar(text) to service_role;
grant execute on function exibicao_dispositivo_resolver(text, text, text) to service_role;
grant execute on function exibicao_dispositivo_rotacionar(uuid, text, text) to service_role;
grant execute on function exibicao_dispositivo_desconectar(text) to service_role;
grant execute on function exibicao_dispositivos_listar(uuid, uuid) to service_role;
grant execute on function exibicao_dispositivo_renomear(uuid, uuid, uuid, text) to service_role;
grant execute on function exibicao_dispositivos_revogar(uuid, uuid, uuid, uuid) to service_role;
grant execute on function exibicao_limpar(integer) to service_role;

commit;
