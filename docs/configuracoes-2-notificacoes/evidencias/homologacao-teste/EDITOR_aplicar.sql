-- PROJETO DE TESTE APENAS (wiqqsxnysbzhcrzrrean / teste-multiempresarial). Uma transação: tudo ou nada.
begin;
-- Pacote APLICAR 132→135 — gerado de database/migrations em 2026-10-30T17:04:19.423Z. SOMENTE projeto de TESTE.

-- ===== 132_configuracoes2_fuso_unidade_convites_usuario.sql =====
-- 132 — Configurações 2.0: fuso e horário de funcionamento por unidade (D-15) e convite de usuário por e-mail (D-14).
--
-- ADITIVA. Não altera dados existentes nem comportamento: `unidades.timezone` nasce NULO (a regra de fuso só usa o fuso da unidade
-- depois de uma DATA DE CORTE configurada fora do banco — desligada por padrão), e o convite de usuário é uma tabela nova.
--
-- D-11 (transferência de unidade): nenhuma tabela nova tem o par de colunas `organizacao_id` + `unidade_id` — `usuarios_convites`
-- usa `unidade_alvo_id` —, então `remapear_organizacao_em_tabelas_de_unidade` não a enxerga (critério da função: as duas colunas).
-- As colunas novas de `unidades` também não interferem: a função atualiza OUTRAS tabelas.
--
-- D-14: token de convite = 32 bytes aleatórios gerados no backend; aqui só o SHA-256 (hex). E-mail: HMAC (busca/dedupe) +
-- cifrado (AES-256-GCM, chave fora do banco). Uso único atômico por `usuarios_convite_consumir`. 72 h de validade.
-- Rollback: 132_rollback.sql.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Fuso IANA e horário de funcionamento da unidade (D-15)
-- ---------------------------------------------------------------------------------------------------------------------------
alter table unidades add column if not exists timezone text;
alter table unidades add column if not exists horario_funcionamento jsonb;

comment on column unidades.timezone is
  'Fuso IANA da unidade (ex.: America/Porto_Velho). NULO = fuso da plataforma. Só passa a valer para competências a partir da data de corte configurada (OPERACIONAL_FUSO_UNIDADE_CORTE); antes disso o comportamento é o anterior. Histórico nunca é reprocessado.';
comment on column unidades.horario_funcionamento is
  'Horário de funcionamento: {"seg":[{"inicio":"HH:MM","fim":"HH:MM"}], …, "dom":[]}. Informativo (nenhuma regra de envio o usa nesta versão).';

create or replace function unidades_validar_fuso_horario() returns trigger
language plpgsql set search_path = public as $$
declare
  dia text; faixa jsonb; dias constant text[] := array['seg','ter','qua','qui','sex','sab','dom'];
begin
  if new.timezone is not null and not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'unidades: fuso inválido (%)', new.timezone using errcode = '22023';
  end if;
  if new.horario_funcionamento is not null then
    if jsonb_typeof(new.horario_funcionamento) <> 'object' then
      raise exception 'unidades: horario_funcionamento deve ser um objeto' using errcode = '22023';
    end if;
    for dia in select jsonb_object_keys(new.horario_funcionamento) loop
      if not (dia = any (dias)) then raise exception 'unidades: dia inválido (%)', dia using errcode = '22023'; end if;
      if jsonb_typeof(new.horario_funcionamento -> dia) <> 'array' or jsonb_array_length(new.horario_funcionamento -> dia) > 3 then
        raise exception 'unidades: o dia % deve ter de 0 a 3 faixas', dia using errcode = '22023';
      end if;
      for faixa in select value from jsonb_array_elements(new.horario_funcionamento -> dia) loop
        if coalesce(faixa->>'inicio', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(faixa->>'fim', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
           or faixa->>'inicio' = faixa->>'fim' then
          raise exception 'unidades: faixa inválida em % (use HH:MM, início diferente do fim)', dia using errcode = '22023';
        end if;
      end loop;
    end loop;
  end if;
  return new;
end $$;

drop trigger if exists trg_unidades_validar_fuso_horario on unidades;
create trigger trg_unidades_validar_fuso_horario before insert or update of timezone, horario_funcionamento on unidades
  for each row execute function unidades_validar_fuso_horario();
revoke all on function unidades_validar_fuso_horario() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Convite de usuário por e-mail (D-14)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists usuarios_convites (
  id               uuid primary key default gen_random_uuid(),
  token_hash       text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  organizacao_id   uuid not null references organizacoes(id) on delete cascade,
  unidade_alvo_id  uuid references unidades(id) on delete cascade,      -- NULO = acesso à empresa; nunca "unidade_id" (D-11)
  papel            text not null check (papel in ('organization_admin', 'unit_manager', 'finance', 'operations', 'viewer')),
  nome             text check (nome is null or length(nome) <= 160),
  email_hmac       text not null check (email_hmac ~ '^[0-9a-f]{64}$'),
  email_cifrado    text not null,
  email_mascarado  text check (email_mascarado is null or email_mascarado ~ '^[^@]{1,3}[*]+@'),   -- só exibição (ex.: an***@x.com)
  chave_versao     integer not null default 1,
  criado_por       uuid,                                                 -- auth.users.id de quem convidou (sem FK: sobrevive à exclusão)
  criado_perfil_id uuid,
  criado_em        timestamptz not null default now(),
  expira_em        timestamptz not null,
  envio_status     text not null default 'DESLIGADO' check (envio_status in ('DESLIGADO', 'ENVIADO', 'FALHOU')),
  envio_tentado_em timestamptz,
  usado_em         timestamptz,
  usado_por        uuid,
  revogado_em      timestamptz,
  revogado_por     uuid,
  constraint usuarios_convites_token_unico unique (token_hash),
  constraint usuarios_convites_validade check (expira_em > criado_em and expira_em <= criado_em + interval '72 hours'),
  constraint usuarios_convites_uso_ou_revogacao check (not (usado_em is not null and revogado_em is not null))
);
create unique index if not exists ux_usuarios_convites_pendente
  on usuarios_convites (organizacao_id, email_hmac) where usado_em is null and revogado_em is null;
create index if not exists ix_usuarios_convites_org on usuarios_convites (organizacao_id, criado_em desc);

comment on table usuarios_convites is
  'Convite de acesso por e-mail (D-14). Token: só o SHA-256. E-mail: HMAC + cifrado. Uso único (usuarios_convite_consumir). Nenhuma senha passa por aqui.';

create or replace function usuarios_convites_coerencia() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.unidade_alvo_id is not null
     and not exists (select 1 from unidades u where u.id = new.unidade_alvo_id and u.organizacao_id = new.organizacao_id) then
    raise exception 'usuarios_convites: a unidade não pertence à empresa' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and ((to_jsonb(new) - array['usado_em','usado_por','revogado_em','revogado_por','envio_status','envio_tentado_em'])
                           is distinct from (to_jsonb(old) - array['usado_em','usado_por','revogado_em','revogado_por','envio_status','envio_tentado_em'])) then
    raise exception 'usuarios_convites: só o estado (uso, revogação, envio) muda' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (old.usado_em is not null or old.revogado_em is not null)
     and (new.usado_em is distinct from old.usado_em or new.revogado_em is distinct from old.revogado_em) then
    raise exception 'usuarios_convites: convite já encerrado' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_usuarios_convites_coerencia on usuarios_convites;
create trigger trg_usuarios_convites_coerencia before insert or update on usuarios_convites
  for each row execute function usuarios_convites_coerencia();

/** Consome o convite de forma ATÔMICA (uso único): confere token, e-mail (HMAC), prazo e estado. */
create or replace function usuarios_convite_consumir(p_token_hash text, p_email_hmac text, p_usuario_id uuid)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare c usuarios_convites;
begin
  if p_token_hash is null or p_email_hmac is null or p_usuario_id is null then return jsonb_build_object('resultado', 'INVALIDO'); end if;
  select * into c from usuarios_convites where token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('resultado', 'INVALIDO'); end if;
  if c.revogado_em is not null then return jsonb_build_object('resultado', 'REVOGADO'); end if;
  if c.usado_em is not null then return jsonb_build_object('resultado', 'JA_USADO'); end if;
  if c.expira_em <= now() then return jsonb_build_object('resultado', 'EXPIRADO'); end if;
  if c.email_hmac <> p_email_hmac then return jsonb_build_object('resultado', 'EMAIL_DIVERGENTE'); end if;
  if c.unidade_alvo_id is not null
     and not exists (select 1 from unidades u where u.id = c.unidade_alvo_id and u.organizacao_id = c.organizacao_id) then
    return jsonb_build_object('resultado', 'UNIDADE_MUDOU_DE_EMPRESA');
  end if;
  update usuarios_convites set usado_em = now(), usado_por = p_usuario_id where id = c.id;
  return jsonb_build_object('resultado', 'CONSUMIDO', 'convite_id', c.id, 'organizacao_id', c.organizacao_id,
                            'unidade_alvo_id', c.unidade_alvo_id, 'papel', c.papel, 'nome', c.nome);
end $$;

alter table usuarios_convites enable row level security;
do $$ begin
  revoke all on table usuarios_convites from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table usuarios_convites from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table usuarios_convites from authenticated; end if;
  revoke all on function usuarios_convite_consumir(text, text, uuid) from public;
  revoke all on function usuarios_convites_coerencia() from public;
  -- funções de gatilho também: o Supabase concede EXECUTE em funções novas a anon/authenticated por default privileges
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function usuarios_convite_consumir(text, text, uuid) from anon;
    revoke all on function usuarios_convites_coerencia() from anon;
    revoke all on function unidades_validar_fuso_horario() from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function usuarios_convite_consumir(text, text, uuid) from authenticated;
    revoke all on function usuarios_convites_coerencia() from authenticated;
    revoke all on function unidades_validar_fuso_horario() from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function usuarios_convites_coerencia() from service_role;
    revoke all on function unidades_validar_fuso_horario() from service_role;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table usuarios_convites from service_role;
    grant select, insert on table usuarios_convites to service_role;
    grant update (usado_em, usado_por, revogado_em, revogado_por, envio_status, envio_tentado_em) on table usuarios_convites to service_role;
    grant execute on function usuarios_convite_consumir(text, text, uuid) to service_role;
  end if;
end $$;


-- VERIFICAÇÃO (só leitura):
-- select column_name from information_schema.columns where table_name='unidades' and column_name in ('timezone','horario_funcionamento');
-- select has_table_privilege('authenticated','usuarios_convites','SELECT'), has_table_privilege('service_role','usuarios_convites','DELETE'); -- f | f


-- ===== 133_notificacoes_escopos_snapshot_m3.sql =====
-- 133 — Central de Notificações: escopo por unidade, snapshot dos legados (D-16) e ativação M3 (CRIADA, NUNCA EXECUTADA AQUI).
--
-- PRESERVAÇÃO DO D-1 (decisão de 30/10/2026 + D-16):
--   * `comunicacao_resolver_destinatarios(org, tipo)` NÃO muda (Painel ADM, habilitação e o JS do D-1 continuam idênticos).
--   * Nova `comunicacao_resolver_destinatarios_unidade(org, unidade, tipo)`: com a seleção por escopo DESLIGADA (padrão — nem existe
--     a chave), devolve EXATAMENTE `comunicacao_resolver_destinatarios(org, tipo)`. Ligada (só pela ativação M3), aplica o escopo.
--   * `comunicacao_agendar_mensagens_alerta` (104) é recriada com o corpo IDÊNTICO, exceto UMA linha: a revalidação dos
--     destinatários passa a chamar a versão por unidade (o alerta é por unidade). Com a chave desligada o resultado é o mesmo.
--   * Nenhuma linha existente é alterada. Legados NÃO ganham escopo aqui: o snapshot e os escopos LEGACY_ACTIVE só nascem na
--     ativação M3 (`comunicacao_ativar_selecao_por_escopo`), que exige autorização específica e não é chamada por migration.
--
-- D-11: nenhuma tabela nova tem o par `organizacao_id` + `unidade_id` (escopo: `unidade_escopo_id`; snapshot:
-- `organizacao_na_migracao_id`/`unidade_na_migracao_id`) — a função de transferência não as enxerga e NÃO é modificada.
-- Depois de uma transferência, o escopo deixa de valer sozinho: a resolução exige a unidade na MESMA empresa do destinatário.
--
-- Rollback: 133_rollback.sql (restaura o corpo exato da 104 e remove o que é novo).

set local lock_timeout = '5s';

do $$ begin
  if to_regclass('public.comunicacao_contatos_empresa') is null or to_regclass('public.comunicacao_categorias') is null
     or to_regprocedure('public.comunicacao_resolver_destinatarios(uuid,text)') is null
     or to_regprocedure('public.comunicacao_agendar_mensagens_alerta(uuid,text,text,jsonb,integer)') is null then
    raise exception '133: exige a migration 104 (comunicação com vários destinatários)';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Catálogo de categorias: atributos da Central (o D-1 continua `pendencia_d1`, ATIVA, transporte atual)
-- ---------------------------------------------------------------------------------------------------------------------------
alter table comunicacao_categorias add column if not exists grupo text not null default 'dashboard_ifood'
  check (grupo in ('dashboard_ifood', 'operacao', 'financeiro', 'gestao'));
alter table comunicacao_categorias add column if not exists exige_consentimento boolean not null default true;
alter table comunicacao_categorias add column if not exists estado text not null default 'ATIVA'
  check (estado in ('ATIVA', 'SIMULACAO', 'EM_BREVE', 'INTERNA'));
alter table comunicacao_categorias add column if not exists transporte text not null default 'baileys'
  check (transporte in ('baileys', 'noop', 'oficial'));
alter table comunicacao_categorias add column if not exists prioridade text not null default 'padrao'
  check (prioridade in ('critico', 'padrao', 'informativo'));
alter table comunicacao_categorias add column if not exists ordem integer not null default 100;

-- Categorias novas nascem INATIVAS (`ativo = false`): o Painel ADM e o resolvedor do D-1 só enxergam categorias ativas, então
-- nenhuma delas pode ser ligada para um destinatário legado por fora do fluxo de consentimento (regra 6/7 da decisão).
insert into comunicacao_categorias (codigo, rotulo, descricao, tipo_alerta, ativo, grupo, estado, transporte, ordem)
values
  ('fechamento_operacional_diario', 'Fechamento operacional diário', 'Resumo do dia operacional consolidado (Dashboard Operacional 2.0). Em simulação.', 'fechamento_operacional_diario', false, 'operacao', 'SIMULACAO', 'noop', 20),
  ('resumo_semanal', 'Resumo semanal', 'Resumo da semana operacional.', 'resumo_semanal', false, 'operacao', 'EM_BREVE', 'noop', 30),
  ('cancelamentos_relevantes', 'Cancelamentos relevantes', 'Alerta de cancelamentos acima do normal.', 'cancelamentos_relevantes', false, 'operacao', 'EM_BREVE', 'noop', 40),
  ('atrasos_operacionais', 'Atrasos operacionais', 'Alerta de atrasos de preparo/entrega.', 'atrasos_operacionais', false, 'operacao', 'EM_BREVE', 'noop', 50),
  ('disputas', 'Disputas', 'Disputas abertas ou expirando.', 'disputas', false, 'operacao', 'EM_BREVE', 'noop', 60),
  ('falha_integracao', 'Falha de integração', 'Integração iFood desconectada ou parada.', 'falha_integracao', false, 'operacao', 'EM_BREVE', 'noop', 70),
  ('financeiro_divergencias', 'Divergências financeiras', 'Divergências de conciliação e repasses.', 'financeiro_divergencias', false, 'financeiro', 'EM_BREVE', 'noop', 80),
  ('gestao_metas', 'Metas e diagnósticos', 'Metas, diagnósticos e planos de ação.', 'gestao_metas', false, 'gestao', 'EM_BREVE', 'noop', 90)
on conflict (codigo) do nothing;
update comunicacao_categorias set ordem = 10 where codigo = 'pendencia_d1' and ordem = 100;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Snapshot IMUTÁVEL dos vínculos legados (D-16) — preenchido SÓ pela ativação M3
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists comunicacao_legado_snapshot (
  id                          uuid primary key default gen_random_uuid(),
  migracao_id                 uuid not null,
  migrado_em                  timestamptz not null default now(),
  contato_empresa_id          uuid not null,                 -- sem FK: o registro histórico sobrevive ao destinatário
  organizacao_na_migracao_id  uuid not null,                 -- nunca "organizacao_id"/"unidade_id": fora do remapeamento (D-11)
  unidade_na_migracao_id      uuid not null,
  contato_whatsapp_id         uuid,
  telefone_mascarado          text,
  ativo                       boolean,
  whatsapp_status             text,
  opt_out                     boolean,
  consentimento_legado        boolean,
  verificado_legado           boolean,
  empresa_habilitada          boolean,
  envio_automatico            boolean,
  autorizacao_registrada_em   timestamptz,
  autorizacao_registrada_por  uuid,
  hash_linha                  text not null,
  constraint uq_comunicacao_legado_snapshot unique (migracao_id, contato_empresa_id, unidade_na_migracao_id)
);
comment on table comunicacao_legado_snapshot is
  'D-16: vínculos legados (destinatário × empresa × unidade) reconhecidos na ativação M3 = "data da migração". IMUTÁVEL. Mudanças posteriores ficam no escopo + auditoria.';

create or replace function comunicacao_registro_imutavel() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception '% é imutável (%).', tg_table_name, tg_op using errcode = '42501';
end $$;
drop trigger if exists trg_comunicacao_legado_snapshot_imutavel on comunicacao_legado_snapshot;
create trigger trg_comunicacao_legado_snapshot_imutavel before update or delete on comunicacao_legado_snapshot
  for each row execute function comunicacao_registro_imutavel();

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. Escopo destinatário × unidade × categoria (estado ATUAL, mutável)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists comunicacao_destinatario_escopos (
  id                  uuid primary key default gen_random_uuid(),
  contato_empresa_id  uuid not null references comunicacao_contatos_empresa(id) on delete cascade,
  unidade_escopo_id   uuid not null references unidades(id) on delete cascade,      -- nunca "unidade_id" (D-11)
  categoria           text not null references comunicacao_categorias(codigo),
  habilitado          boolean not null default true,
  origem_autorizacao  text not null check (origem_autorizacao in ('LEGACY_ACTIVE', 'CONVITE_OTP')),
  origem_vinculo      text not null check (origem_vinculo in ('SNAPSHOT_MIGRACAO', 'INCLUSAO_ADMIN', 'CONVITE')),
  snapshot_id         uuid references comunicacao_legado_snapshot(id),
  suspenso_em         timestamptz,
  suspenso_por        uuid,
  suspenso_motivo     text check (suspenso_motivo is null or length(suspenso_motivo) <= 300),
  janela              jsonb,
  silencio            jsonb,
  notificar_correcao  boolean not null default false,
  criado_em           timestamptz not null default now(),
  criado_por          uuid,
  atualizado_em       timestamptz not null default now(),
  atualizado_por      uuid,
  constraint uq_comunicacao_destinatario_escopo unique (contato_empresa_id, unidade_escopo_id, categoria),
  constraint comunicacao_escopo_legado_so_d1 check (origem_autorizacao <> 'LEGACY_ACTIVE' or categoria = 'pendencia_d1'),
  constraint comunicacao_escopo_snapshot_exige_id check (origem_vinculo <> 'SNAPSHOT_MIGRACAO' or snapshot_id is not null),
  constraint comunicacao_escopo_legado_origem check (origem_autorizacao <> 'LEGACY_ACTIVE' or origem_vinculo in ('SNAPSHOT_MIGRACAO', 'INCLUSAO_ADMIN')),
  constraint comunicacao_escopo_convite_origem check (origem_autorizacao <> 'CONVITE_OTP' or origem_vinculo = 'CONVITE')
);
create index if not exists ix_comunicacao_escopos_unidade on comunicacao_destinatario_escopos (unidade_escopo_id, categoria);
create index if not exists ix_comunicacao_escopos_snapshot on comunicacao_destinatario_escopos (snapshot_id);

create or replace function comunicacao_faixa_horaria_valida(p jsonb) returns boolean
language sql immutable set search_path = public as $$
  select p is null or (jsonb_typeof(p) = 'object'
    and coalesce(p->>'inicio', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    and coalesce(p->>'fim', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    and p->>'inicio' <> p->>'fim');
$$;

create or replace function comunicacao_escopos_coerencia() returns trigger
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from unidades u join comunicacao_contatos_empresa ce on ce.organizacao_id = u.organizacao_id
                  where u.id = new.unidade_escopo_id and ce.id = new.contato_empresa_id) then
    raise exception 'comunicacao_destinatario_escopos: a unidade não pertence à empresa do destinatário' using errcode = '42501';
  end if;
  if not comunicacao_faixa_horaria_valida(new.janela) or not comunicacao_faixa_horaria_valida(new.silencio) then
    raise exception 'comunicacao_destinatario_escopos: janela/silêncio inválidos (use {"inicio":"HH:MM","fim":"HH:MM"})' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' and (new.contato_empresa_id, new.unidade_escopo_id, new.categoria, new.origem_autorizacao, new.origem_vinculo, new.snapshot_id)
                         is distinct from (old.contato_empresa_id, old.unidade_escopo_id, old.categoria, old.origem_autorizacao, old.origem_vinculo, old.snapshot_id) then
    raise exception 'comunicacao_destinatario_escopos: destinatário, unidade, categoria e origem não mudam' using errcode = '42501';
  end if;
  new.atualizado_em := now();
  return new;
end $$;
drop trigger if exists trg_comunicacao_escopos_coerencia on comunicacao_destinatario_escopos;
create trigger trg_comunicacao_escopos_coerencia before insert or update on comunicacao_destinatario_escopos
  for each row execute function comunicacao_escopos_coerencia();

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. Seleção de destinatários: a do D-1 intacta + a versão POR UNIDADE (decide pela chave de ativação)
-- ---------------------------------------------------------------------------------------------------------------------------
/** Seleção por escopo: mesmas condições (e mesmos códigos de motivo) do resolvedor da 104, com a categoria vindo do ESCOPO da unidade. */
create or replace function comunicacao_resolver_destinatarios_por_escopo(p_organizacao_id uuid, p_unidade_id uuid, p_tipo_alerta text)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'contato_empresa_id', x.ce_id, 'contato_id', x.contato_id, 'perfil_id', x.perfil_id,
           'nome', x.nome, 'telefone', x.telefone, 'elegivel', x.motivo is null, 'motivo', x.motivo
         ) order by x.criado_em, x.ce_id), '[]'::jsonb)
  from (
    select ce.id as ce_id, c.id as contato_id, ce.perfil_operacional_id as perfil_id, ce.nome, ce.telefone_e164 as telefone, ce.created_at as criado_em,
           case
             when ce.ativo is not true then 'DESTINATARIO_INATIVO'
             when ce.whatsapp_status <> 'VALIDADO' then 'WHATSAPP_NAO_VALIDADO'
             when ce.contato_whatsapp_id is null or c.id is null then 'SEM_CONTATO'
             when c.telefone_e164 is distinct from ce.telefone_e164 then 'TELEFONE_DIVERGENTE'
             when c.opt_out is not false then 'OPT_OUT'
             when c.consentimento is not true then 'SEM_CONSENTIMENTO'
             when c.verificado is not true then 'TELEFONE_NAO_VERIFICADO'
             when not exists (select 1 from comunicacao_destinatario_categorias dc
                                join comunicacao_categorias cat on cat.codigo = dc.categoria
                               where dc.contato_empresa_id = ce.id and dc.habilitado and cat.ativo and cat.tipo_alerta = p_tipo_alerta) then 'CATEGORIA_NAO_HABILITADA'
             when not exists (select 1 from comunicacao_destinatario_escopos e
                                join comunicacao_categorias cat on cat.codigo = e.categoria
                                join unidades u on u.id = e.unidade_escopo_id
                               where e.contato_empresa_id = ce.id and e.habilitado and e.suspenso_em is null
                                 and cat.ativo and cat.tipo_alerta = p_tipo_alerta
                                 and u.organizacao_id = ce.organizacao_id                       -- transferência: o escopo deixa de valer
                                 and (p_unidade_id is null or e.unidade_escopo_id = p_unidade_id)) then 'CATEGORIA_NAO_HABILITADA'
             else null
           end as motivo
      from comunicacao_contatos_empresa ce
      left join contatos_whatsapp c on c.id = ce.contato_whatsapp_id
     where ce.organizacao_id = p_organizacao_id
  ) x;
$$;

/** Chave de ativação da seleção por escopo (comunicacao_configuracoes['selecao_por_escopo'].ligada). Ausente = desligada. */
create or replace function comunicacao_selecao_por_escopo_ligada() returns boolean
language sql stable security invoker set search_path = public as $$
  select coalesce((select (valor->>'ligada')::boolean from comunicacao_configuracoes where chave = 'selecao_por_escopo'), false);
$$;

/** Resolução POR UNIDADE usada pelo agendamento do D-1. Desligada (padrão) = exatamente a função da 104. Um único comando. */
create or replace function comunicacao_resolver_destinatarios_unidade(p_organizacao_id uuid, p_unidade_id uuid, p_tipo_alerta text)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  select case when comunicacao_selecao_por_escopo_ligada()
              then comunicacao_resolver_destinatarios_por_escopo(p_organizacao_id, p_unidade_id, p_tipo_alerta)
              else comunicacao_resolver_destinatarios(p_organizacao_id, p_tipo_alerta) end;
$$;
comment on function comunicacao_resolver_destinatarios_unidade(uuid, uuid, text) is
  'D-16: com a seleção por escopo desligada (padrão) devolve exatamente comunicacao_resolver_destinatarios(org, tipo). Ligada pela ativação M3: só destinatários com escopo habilitado da unidade (mesma empresa).';

-- ---------------------------------------------------------------------------------------------------------------------------
-- 5. Agendamento do D-1: corpo IDÊNTICO ao da 104, exceto a linha da revalidação (agora por unidade)
create or replace function comunicacao_agendar_mensagens_alerta(
  p_alerta_id uuid, p_proposito text, p_origem text, p_itens jsonb, p_max_tentativas integer default 5
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  a comunicacao_alertas; h comunicacao_habilitacoes; m comunicacao_mensagens; ex comunicacao_mensagens; ini comunicacao_mensagens;
  it jsonb; r jsonb; v_dest jsonb; v_org_nome text; v_ce uuid; v_chave text; v_criadas integer := 0; v_itens jsonb := '[]'::jsonb;
  v_meta jsonb; v_contato uuid; v_reparar boolean := false;
begin
  if p_proposito is null or p_proposito not in ('inicial', 'reforco') then return jsonb_build_object('acao', 'PROPOSITO_INVALIDO'); end if;
  if p_origem is not null and (p_origem <> 'prazo_final_d1' or p_proposito <> 'inicial') then return jsonb_build_object('acao', 'ORIGEM_INVALIDA'); end if;
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 or jsonb_array_length(p_itens) > 50 then
    return jsonb_build_object('acao', 'ITENS_INVALIDOS');
  end if;

  select * into a from comunicacao_alertas where id = p_alerta_id for update;  -- serializa por alerta
  if not found then return jsonb_build_object('acao', 'ALERTA_INEXISTENTE'); end if;
  if p_origem = 'prazo_final_d1' and a.tipo_alerta <> 'dashboard_ifood_d1' then return jsonb_build_object('acao', 'TIPO_NAO_SUPORTADO'); end if;

  -- EMPRESA (fail-closed): habilitada E com envio automático ligado
  select * into h from comunicacao_habilitacoes where organizacao_id = a.organizacao_id;
  if not found or h.habilitado is not true or h.timezone is null then return jsonb_build_object('acao', 'NAO_HABILITADA'); end if;
  if h.envio_automatico is not true then return jsonb_build_object('acao', 'ENVIO_AUTOMATICO_DESLIGADO'); end if;
  if not (a.tipo_alerta = any (h.tipos_permitidos)) then return jsonb_build_object('acao', 'TIPO_NAO_PERMITIDO'); end if;

  if p_proposito = 'inicial' and a.status <> 'DETECTED' then return jsonb_build_object('acao', 'ALERTA_NAO_DETECTED', 'status_alerta', a.status); end if;
  if p_proposito = 'reforco' and a.status not in ('SCHEDULED', 'SENT', 'DELIVERED', 'READ') then
    return jsonb_build_object('acao', 'ALERTA_SEM_PRIMEIRO_ENVIO', 'status_alerta', a.status);
  end if;

  v_dest := comunicacao_resolver_destinatarios_unidade(a.organizacao_id, a.unidade_id, a.tipo_alerta);  -- 133: única linha alterada (D-16)
  select nome into v_org_nome from organizacoes where id = a.organizacao_id;
  v_meta := case when p_proposito = 'reforco' then jsonb_build_object('proposito', 'reforco')
                 when p_origem is not null then jsonb_build_object('proposito', 'inicial', 'origem', p_origem)
                 else '{}'::jsonb end;

  for it in select value from jsonb_array_elements(p_itens) loop
    if it->>'contato_empresa_id' is null or it->>'contato_empresa_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(it->>'conteudo', '') = '' or it->>'disponivel_em' is null then
      v_itens := v_itens || jsonb_build_array(jsonb_build_object('acao', 'ITEM_INVALIDO')); continue;
    end if;
    v_ce := (it->>'contato_empresa_id')::uuid;
    select e into r from jsonb_array_elements(v_dest) e where (e->>'contato_empresa_id')::uuid = v_ce limit 1;
    if r is null then v_itens := v_itens || jsonb_build_array(jsonb_build_object('contato_empresa_id', v_ce, 'acao', 'DESTINATARIO_INEXISTENTE')); continue; end if;
    if (r->>'elegivel')::boolean is not true then
      v_itens := v_itens || jsonb_build_array(jsonb_build_object('contato_empresa_id', v_ce, 'acao', 'DESTINATARIO_INELEGIVEL', 'motivo', r->>'motivo')); continue;
    end if;
    v_contato := (r->>'contato_id')::uuid;

    -- já existe uma mensagem DESTE destinatário para ESTE propósito? (inclui as legadas, pré-100, sem contato_empresa_id, casadas pelo contato)
    select * into ex from comunicacao_mensagens x
     where x.alerta_id = a.id and x.direcao = 'saida' and coalesce(x.metadados->>'proposito', 'inicial') = p_proposito
       and (x.contato_empresa_id = v_ce or (x.contato_empresa_id is null and x.contato_id = v_contato))
     order by x.created_at limit 1;
    if found then
      -- REPARO: mensagem inicial já viva (resíduo de fluxo não atômico) com o alerta ainda DETECTED -> o alerta acompanha (sem duplicar nada)
      if p_proposito = 'inicial' and ex.status in ('SCHEDULED', 'PROCESSING', 'SENDING') then v_reparar := true; end if;
      v_itens := v_itens || jsonb_build_array(jsonb_build_object('contato_empresa_id', v_ce, 'mensagem_id', ex.id, 'status', ex.status,
        'acao', case when ex.status = 'CANCELLED' and ex.erro = 'EXPIRADA' then 'MENSAGEM_EXPIRADA' else 'JA_EXISTIA' end));
      continue;
    end if;

    if p_proposito = 'reforco' then
      -- o reforço deste destinatário exige a inicial DELE já enviada e nenhuma entrega dele em curso/incerta
      select * into ini from comunicacao_mensagens x
       where x.alerta_id = a.id and x.direcao = 'saida' and coalesce(x.metadados->>'proposito', 'inicial') = 'inicial'
         and (x.contato_empresa_id = v_ce or (x.contato_empresa_id is null and x.contato_id = v_contato))
       order by x.created_at limit 1;
      if not found or ini.status not in ('SENT', 'DELIVERED', 'READ') then
        v_itens := v_itens || jsonb_build_array(jsonb_build_object('contato_empresa_id', v_ce, 'acao', 'PRIMEIRA_MENSAGEM_NAO_ENVIADA')); continue;
      end if;
    end if;

    v_chave := 'wa:alerta:' || a.id::text || ':dest:' || v_ce::text || case when p_proposito = 'reforco' then ':reforco:v1' else ':v1' end;
    begin
      insert into comunicacao_mensagens (alerta_id, organizacao_id, unidade_id, contato_id, destinatario_perfil_id,
                                         contato_empresa_id, empresa_nome_snapshot, contato_nome_snapshot, telefone_snapshot, data_referencia,
                                         tipo, conteudo, idempotency_key, status, disponivel_em, expira_em, max_tentativas, metadados)
      values (a.id, a.organizacao_id, a.unidade_id, v_contato, (r->>'perfil_id')::uuid,
              v_ce, v_org_nome, r->>'nome', r->>'telefone', a.data_referencia,
              a.tipo_alerta, it->>'conteudo', v_chave, 'SCHEDULED', (it->>'disponivel_em')::timestamptz, nullif(it->>'expira_em', '')::timestamptz,
              coalesce(p_max_tentativas, 5), v_meta)
      returning * into m;
      v_criadas := v_criadas + 1;
      v_itens := v_itens || jsonb_build_array(jsonb_build_object('contato_empresa_id', v_ce, 'acao', 'CRIADA', 'mensagem_id', m.id));
    exception when unique_violation then
      v_itens := v_itens || jsonb_build_array(jsonb_build_object('contato_empresa_id', v_ce, 'acao', 'JA_EXISTIA'));
    end;
  end loop;

  if p_proposito = 'inicial' and (v_criadas > 0 or v_reparar) and a.status = 'DETECTED' then
    update comunicacao_alertas set status = 'SCHEDULED' where id = a.id;
  end if;
  return jsonb_build_object('acao', 'OK', 'criadas', v_criadas, 'itens', v_itens);
end;
$$;
comment on function comunicacao_agendar_mensagens_alerta(uuid, text, text, jsonb, integer) is
  'Cria, NUMA transação, uma mensagem por destinatário ELEGÍVEL (revalidado aqui) de um alerta. Idempotência por alerta+destinatário+propósito (índice único parcial + chave derivada no banco). proposito = inicial|reforco; origem = NULL|prazo_final_d1 (1ª mensagem tardia). Recusas do conjunto: PROPOSITO_INVALIDO, ORIGEM_INVALIDA, ITENS_INVALIDOS, ALERTA_INEXISTENTE, TIPO_NAO_SUPORTADO, NAO_HABILITADA, ENVIO_AUTOMATICO_DESLIGADO, TIPO_NAO_PERMITIDO, ALERTA_NAO_DETECTED, ALERTA_SEM_PRIMEIRO_ENVIO. Por item: CRIADA | JA_EXISTIA | MENSAGEM_EXPIRADA | DESTINATARIO_INELEGIVEL | DESTINATARIO_INEXISTENTE | PRIMEIRA_MENSAGEM_NAO_ENVIADA | ITEM_INVALIDO.';
revoke all on function comunicacao_agendar_mensagens_alerta(uuid, text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function comunicacao_agendar_mensagens_alerta(uuid, text, text, jsonb, integer) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 6. Ativação M3 (D-16) — atômica, idempotente, com equivalência verificada ANTES do commit. NUNCA chamada por migration.
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function comunicacao_ativar_selecao_por_escopo(p_migracao_id uuid, p_universo jsonb, p_modulo_id text, p_ator uuid)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_cfg jsonb; it jsonb; v_un uuid; v_org uuid; v_snap integer := 0; v_esc integer := 0; v_div integer := 0; v_hash text;
  r record; v_snap_id uuid;
begin
  if p_migracao_id is null or p_universo is null or jsonb_typeof(p_universo) <> 'array' or p_modulo_id is null then
    raise exception 'ATIVACAO_PARAMETROS_INVALIDOS' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('comunicacao_selecao_por_escopo'));
  select valor into v_cfg from comunicacao_configuracoes where chave = 'selecao_por_escopo';
  if coalesce((v_cfg->>'ligada')::boolean, false) then
    if (v_cfg->>'migracao_id') = p_migracao_id::text then return jsonb_build_object('resultado', 'JA_ATIVADA', 'migracao_id', p_migracao_id); end if;
    raise exception 'ATIVACAO_JA_LIGADA_COM_OUTRA_MIGRACAO' using errcode = '55000';
  end if;
  if exists (select 1 from comunicacao_legado_snapshot where migracao_id = p_migracao_id) then
    raise exception 'ATIVACAO_MIGRACAO_JA_USADA' using errcode = '55000';
  end if;

  -- universo = o MESMO do monitor D-1 (montado no backend pela função do monitor); o banco confere cada unidade
  create temporary table _universo (unidade_id uuid primary key, organizacao_id uuid not null) on commit drop;
  for it in select value from jsonb_array_elements(p_universo) loop
    v_un := (it->>'unidade_id')::uuid; v_org := (it->>'organizacao_id')::uuid;
    if not exists (select 1 from unidades u join organizacoes o on o.id = u.organizacao_id
                    where u.id = v_un and u.organizacao_id = v_org and u.ativo is true and coalesce(u.eh_teste, false) = false
                      and o.status = 'ativa' and coalesce(o.eh_modelo, false) = false
                      and exists (select 1 from organizacao_modulos om where om.organizacao_id = v_org and om.modulo_id = p_modulo_id)
                      and exists (select 1 from unidade_modulos um where um.unidade_id = v_un and um.modulo_id = p_modulo_id)) then
      raise exception 'ATIVACAO_UNIVERSO_INVALIDO: unidade % fora do universo monitorado', v_un using errcode = '22023';
    end if;
    insert into _universo values (v_un, v_org) on conflict do nothing;
  end loop;

  -- snapshot + escopos LEGACY_ACTIVE: todo destinatário com a categoria do D-1 habilitada × cada unidade do universo da empresa
  for r in
    select ce.*, c.opt_out, c.consentimento, c.verificado, h.habilitado as hab, h.envio_automatico as auto, uv.unidade_id as un
      from comunicacao_contatos_empresa ce
      join comunicacao_destinatario_categorias dc on dc.contato_empresa_id = ce.id and dc.categoria = 'pendencia_d1' and dc.habilitado
      join _universo uv on uv.organizacao_id = ce.organizacao_id
      left join contatos_whatsapp c on c.id = ce.contato_whatsapp_id
      left join comunicacao_habilitacoes h on h.organizacao_id = ce.organizacao_id
     order by ce.organizacao_id, ce.id, uv.unidade_id
  loop
    insert into comunicacao_legado_snapshot (migracao_id, contato_empresa_id, organizacao_na_migracao_id, unidade_na_migracao_id,
      contato_whatsapp_id, telefone_mascarado, ativo, whatsapp_status, opt_out, consentimento_legado, verificado_legado,
      empresa_habilitada, envio_automatico, autorizacao_registrada_em, autorizacao_registrada_por, hash_linha)
    values (p_migracao_id, r.id, r.organizacao_id, r.un, r.contato_whatsapp_id,
      left(r.telefone_e164, 4) || repeat('*', greatest(length(r.telefone_e164) - 6, 0)) || right(r.telefone_e164, 2),
      r.ativo, r.whatsapp_status, r.opt_out, r.consentimento, r.verificado, r.hab, r.auto, r.autorizacao_registrada_em, r.autorizacao_registrada_por,
      md5(concat_ws('|', p_migracao_id, r.id, r.organizacao_id, r.un, r.ativo, r.whatsapp_status, r.opt_out, r.consentimento, r.verificado, r.hab, r.auto)))
    returning id into v_snap_id;
    v_snap := v_snap + 1;
    insert into comunicacao_destinatario_escopos (contato_empresa_id, unidade_escopo_id, categoria, habilitado, origem_autorizacao, origem_vinculo, snapshot_id, criado_por)
    values (r.id, r.un, 'pendencia_d1', true, 'LEGACY_ACTIVE', 'SNAPSHOT_MIGRACAO', v_snap_id, p_ator)
    on conflict (contato_empresa_id, unidade_escopo_id, categoria) do nothing;
    v_esc := v_esc + 1;
  end loop;

  insert into comunicacao_configuracoes (chave, valor, atualizado_em)
  values ('selecao_por_escopo', jsonb_build_object('ligada', true, 'migracao_id', p_migracao_id, 'ativada_em', now(), 'ator', p_ator), now())
  on conflict (chave) do update set valor = excluded.valor, atualizado_em = now();

  -- EQUIVALÊNCIA antes do commit: para cada unidade do universo, os ELEGÍVEIS do D-1 pela seleção nova == pela seleção anterior
  for r in select uv.unidade_id, uv.organizacao_id from _universo uv loop
    if (select coalesce(jsonb_agg(e->'contato_empresa_id' order by e->>'contato_empresa_id'), '[]'::jsonb)
          from jsonb_array_elements(comunicacao_resolver_destinatarios_unidade(r.organizacao_id, r.unidade_id, 'dashboard_ifood_d1')) e
         where (e->>'elegivel')::boolean)
       is distinct from
       (select coalesce(jsonb_agg(e->'contato_empresa_id' order by e->>'contato_empresa_id'), '[]'::jsonb)
          from jsonb_array_elements(comunicacao_resolver_destinatarios(r.organizacao_id, 'dashboard_ifood_d1')) e
         where (e->>'elegivel')::boolean) then
      v_div := v_div + 1;
    end if;
  end loop;
  if v_div > 0 then
    raise exception 'ATIVACAO_EQUIVALENCIA_FALHOU: % unidade(s) com destinatários do D-1 diferentes — nada foi gravado', v_div using errcode = 'P0001';
  end if;

  select md5(coalesce(string_agg(hash_linha, ',' order by hash_linha), '')) into v_hash from comunicacao_legado_snapshot where migracao_id = p_migracao_id;
  return jsonb_build_object('resultado', 'ATIVADA', 'migracao_id', p_migracao_id, 'snapshot', v_snap, 'escopos', v_esc,
                            'unidades', (select count(*) from _universo), 'hash_snapshot', v_hash);
end $$;

/** Reversão: desliga a seleção por escopo (volta ao comportamento anterior). Snapshot e escopos ficam como registro. */
create or replace function comunicacao_desativar_selecao_por_escopo(p_ator uuid) returns jsonb
language plpgsql security invoker set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext('comunicacao_selecao_por_escopo'));
  update comunicacao_configuracoes
     set valor = valor || jsonb_build_object('ligada', false, 'desligada_em', now(), 'desligada_por', p_ator), atualizado_em = now()
   where chave = 'selecao_por_escopo' and coalesce((valor->>'ligada')::boolean, false);
  return jsonb_build_object('resultado', case when found then 'DESLIGADA' else 'JA_DESLIGADA' end);
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 7. Escrita de escopo pelo gestor (D-3): a unidade permitida vem do BACKEND (nula só para vínculo de empresa); o banco confere
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function comunicacao_escopo_gestor_permitido(p_organizacao_id uuid, p_unidade_permitida uuid, p_contato_empresa_id uuid, p_unidade_id uuid)
returns boolean language sql stable security invoker set search_path = public as $$
  select exists (select 1 from comunicacao_contatos_empresa ce join unidades u on u.organizacao_id = ce.organizacao_id
                  where ce.id = p_contato_empresa_id and u.id = p_unidade_id and ce.organizacao_id = p_organizacao_id)
     and (p_unidade_permitida is null or p_unidade_permitida = p_unidade_id);
$$;

/** Suspende/reativa um escopo (destinatário × unidade × categoria). Suspender CANCELA, no mesmo instante, as mensagens ainda
 *  não enviadas daquele destinatário naquela unidade e tipo (SCHEDULED; e PROCESSING, cuja reserva então falha pelo fencing). */
create or replace function comunicacao_escopo_suspender(p_organizacao_id uuid, p_unidade_permitida uuid, p_contato_empresa_id uuid,
  p_unidade_id uuid, p_categoria text, p_suspender boolean, p_motivo text, p_ator uuid) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare e comunicacao_destinatario_escopos; v_tipo text; v_canceladas integer := 0;
begin
  if not comunicacao_escopo_gestor_permitido(p_organizacao_id, p_unidade_permitida, p_contato_empresa_id, p_unidade_id) then
    raise exception 'ESCOPO_FORA_DO_SEU_ALCANCE' using errcode = '42501';
  end if;
  select * into e from comunicacao_destinatario_escopos
   where contato_empresa_id = p_contato_empresa_id and unidade_escopo_id = p_unidade_id and categoria = p_categoria for update;
  if not found then return jsonb_build_object('resultado', 'ESCOPO_INEXISTENTE'); end if;
  if p_suspender then
    update comunicacao_destinatario_escopos set suspenso_em = now(), suspenso_por = p_ator, suspenso_motivo = left(coalesce(p_motivo, 'Suspenso pelo gestor'), 300), atualizado_por = p_ator
     where id = e.id;
    select tipo_alerta into v_tipo from comunicacao_categorias where codigo = p_categoria;
    update comunicacao_mensagens set status = 'CANCELLED', erro = 'SUSPENSO_PELO_GESTOR'
     where contato_empresa_id = p_contato_empresa_id and unidade_id = p_unidade_id and tipo = v_tipo and status in ('SCHEDULED', 'PROCESSING');
    get diagnostics v_canceladas = row_count;
    return jsonb_build_object('resultado', 'SUSPENSO', 'mensagens_canceladas', v_canceladas);
  end if;
  update comunicacao_destinatario_escopos set suspenso_em = null, suspenso_por = null, suspenso_motivo = null, atualizado_por = p_ator where id = e.id;
  return jsonb_build_object('resultado', 'REATIVADO');
end $$;

/** Preferências do escopo (só restringem: janela, silêncio, aviso de correção, habilitado=false). Nunca cria categoria nem consente. */
create or replace function comunicacao_escopo_preferencias(p_organizacao_id uuid, p_unidade_permitida uuid, p_contato_empresa_id uuid,
  p_unidade_id uuid, p_categoria text, p_habilitado boolean, p_janela jsonb, p_silencio jsonb, p_notificar_correcao boolean, p_ator uuid) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare e comunicacao_destinatario_escopos;
begin
  if not comunicacao_escopo_gestor_permitido(p_organizacao_id, p_unidade_permitida, p_contato_empresa_id, p_unidade_id) then
    raise exception 'ESCOPO_FORA_DO_SEU_ALCANCE' using errcode = '42501';
  end if;
  select * into e from comunicacao_destinatario_escopos
   where contato_empresa_id = p_contato_empresa_id and unidade_escopo_id = p_unidade_id and categoria = p_categoria for update;
  if not found then return jsonb_build_object('resultado', 'ESCOPO_INEXISTENTE'); end if;
  -- reabilitar uma categoria exige que ela já estivesse autorizada no escopo: o gestor nunca AMPLIA (desligar é sempre permitido)
  update comunicacao_destinatario_escopos
     set habilitado = coalesce(p_habilitado, habilitado), janela = p_janela, silencio = p_silencio,
         notificar_correcao = coalesce(p_notificar_correcao, notificar_correcao), atualizado_por = p_ator
   where id = e.id;
  return jsonb_build_object('resultado', 'ATUALIZADO');
end $$;

/** D-16: vincula um destinatário LEGADO a uma unidade (nova) da MESMA empresa, só para o D-1, só com a seleção por escopo ligada. */
create or replace function comunicacao_legado_vincular_unidade(p_organizacao_id uuid, p_unidade_permitida uuid, p_contato_empresa_id uuid,
  p_unidade_id uuid, p_ator uuid) returns jsonb
language plpgsql security invoker set search_path = public as $$
begin
  if not comunicacao_selecao_por_escopo_ligada() then return jsonb_build_object('resultado', 'SELECAO_POR_ESCOPO_DESLIGADA'); end if;
  if not comunicacao_escopo_gestor_permitido(p_organizacao_id, p_unidade_permitida, p_contato_empresa_id, p_unidade_id) then
    raise exception 'ESCOPO_FORA_DO_SEU_ALCANCE' using errcode = '42501';
  end if;
  if not exists (select 1 from comunicacao_destinatario_escopos where contato_empresa_id = p_contato_empresa_id and origem_autorizacao = 'LEGACY_ACTIVE') then
    return jsonb_build_object('resultado', 'NAO_E_LEGADO');
  end if;
  insert into comunicacao_destinatario_escopos (contato_empresa_id, unidade_escopo_id, categoria, habilitado, origem_autorizacao, origem_vinculo, criado_por, atualizado_por)
  values (p_contato_empresa_id, p_unidade_id, 'pendencia_d1', true, 'LEGACY_ACTIVE', 'INCLUSAO_ADMIN', p_ator, p_ator)
  on conflict (contato_empresa_id, unidade_escopo_id, categoria) do update set habilitado = true, atualizado_por = p_ator
    where comunicacao_destinatario_escopos.origem_autorizacao = 'LEGACY_ACTIVE';
  return jsonb_build_object('resultado', 'VINCULADO');
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 8. RLS e privilégios mínimos
-- ---------------------------------------------------------------------------------------------------------------------------
alter table comunicacao_legado_snapshot enable row level security;
alter table comunicacao_destinatario_escopos enable row level security;
do $$
declare papel text; fn text;
  fns constant text[] := array[
    'comunicacao_resolver_destinatarios_por_escopo(uuid,uuid,text)', 'comunicacao_selecao_por_escopo_ligada()',
    'comunicacao_resolver_destinatarios_unidade(uuid,uuid,text)', 'comunicacao_ativar_selecao_por_escopo(uuid,jsonb,text,uuid)',
    'comunicacao_desativar_selecao_por_escopo(uuid)', 'comunicacao_escopo_gestor_permitido(uuid,uuid,uuid,uuid)',
    'comunicacao_escopo_suspender(uuid,uuid,uuid,uuid,text,boolean,text,uuid)',
    'comunicacao_escopo_preferencias(uuid,uuid,uuid,uuid,text,boolean,jsonb,jsonb,boolean,uuid)',
    'comunicacao_legado_vincular_unidade(uuid,uuid,uuid,uuid,uuid)', 'comunicacao_faixa_horaria_valida(jsonb)',
    'comunicacao_registro_imutavel()', 'comunicacao_escopos_coerencia()'];
begin
  foreach papel in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if papel = 'public' or exists (select 1 from pg_roles where rolname = papel) then
      execute format('revoke all on table comunicacao_legado_snapshot, comunicacao_destinatario_escopos from %s', papel);
      foreach fn in array fns loop execute format('revoke all on function %s from %s', fn, papel); end loop;
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on table comunicacao_legado_snapshot to service_role;
    grant select, insert, update on table comunicacao_destinatario_escopos to service_role;
    foreach fn in array fns loop
      if fn not in ('comunicacao_registro_imutavel()', 'comunicacao_escopos_coerencia()') then
        execute format('grant execute on function %s to service_role', fn);
      end if;
    end loop;
  end if;
end $$;


-- VERIFICAÇÃO (só leitura): select comunicacao_selecao_por_escopo_ligada();  -- false (nada foi ativado)
-- select count(*) from comunicacao_legado_snapshot;                           -- 0


-- ===== 134_notificacoes_otp_consentimento.sql =====
-- 134 — Central de Notificações: convite do titular, desafio OTP, livro-razão de consentimento e termos versionados.
--
-- Quatro coisas separadas (doc 05 §1): POSSE do número (desafio OTP consumido), CONSENTIMENTO (livro-razão, por empresa e
-- categoria, com a versão e o hash do texto exibido), AUTORIZAÇÃO da unidade (escopo, decidido pelo gestor) e PERMISSÃO
-- administrativa (papel do usuário). Nenhuma RPC de gestor grava CONCEDIDO; nenhuma reativa uma revogação do titular.
--
-- D-4: telefone só cifrado (AES-256-GCM, chave fora do banco) + HMAC; código OTP só como HMAC. Nada em claro aqui.
-- D-11: nenhuma tabela nova tem o par `organizacao_id` + `unidade_id` (usa `unidade_escopo_id` / `unidades_pretendidas`).
-- SIMULAÇÃO: desafios criados com transporte simulado ficam `simulado = true`, e tudo o que deriva deles (consentimento,
-- escopo) também — a seleção para envio real os ignora. Em produção não há transporte de OTP habilitado (nada é verificado).
-- Os LEGADOS não ganham nenhuma linha aqui (decisão de 30/10/2026). Rollback: 134_rollback.sql.

set local lock_timeout = '5s';

do $$ begin
  if to_regclass('public.comunicacao_destinatario_escopos') is null then
    raise exception '134: exige a migration 133 (escopo por unidade)';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Termos versionados (imutáveis)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists comunicacao_termos (
  versao        integer primary key check (versao >= 1),
  vigente_desde timestamptz not null default now(),
  texto         text not null check (length(btrim(texto)) > 0),
  hash          text not null,
  rascunho      boolean not null default true,
  criado_em     timestamptz not null default now(),
  constraint comunicacao_termos_hash check (hash = encode(sha256(convert_to(texto, 'UTF8')), 'hex'))
);
drop trigger if exists trg_comunicacao_termos_imutavel on comunicacao_termos;
create trigger trg_comunicacao_termos_imutavel before update or delete on comunicacao_termos
  for each row execute function comunicacao_registro_imutavel();

insert into comunicacao_termos (versao, texto, hash, rascunho)
select 1, t, encode(sha256(convert_to(t, 'UTF8')), 'hex'), true
  from (select 'RASCUNHO — SOMENTE SIMULAÇÃO (texto jurídico pendente, D-1). Ao confirmar, você autoriza {empresa} a enviar para este número de WhatsApp os avisos das categorias marcadas abaixo, nas unidades indicadas. Você pode sair a qualquer momento pela página de gestão de notificações ou respondendo SAIR.'::text t) x
on conflict (versao) do nothing;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Convite do titular (gerado pelo gestor; o titular verifica e consente no próprio aparelho)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists comunicacao_convites (
  id                     uuid primary key default gen_random_uuid(),
  token_hash             text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  organizacao_id         uuid not null references organizacoes(id) on delete cascade,
  unidades_pretendidas   uuid[] not null check (cardinality(unidades_pretendidas) between 1 and 50),
  categorias_pretendidas text[] not null check (cardinality(categorias_pretendidas) between 1 and 20),
  contato_empresa_id     uuid references comunicacao_contatos_empresa(id) on delete set null,   -- adesão voluntária de um legado
  nome                   text not null check (length(btrim(nome)) between 1 and 120),
  tipo_destinatario      text not null default 'operacional' check (tipo_destinatario in ('principal', 'secundario', 'financeiro', 'operacional')),
  telefone_cifrado       text not null,
  telefone_hmac          text not null check (telefone_hmac ~ '^[0-9a-f]{64}$'),
  telefone_mascarado     text not null check (telefone_mascarado ~ '^[+][0-9]{3}[*]+[0-9]{2}$'),   -- só a máscara (exibição), nunca o número
  chave_versao           integer not null default 1,
  criado_por             uuid,
  criado_perfil_id       uuid,
  unidade_permitida      uuid,                     -- a unidade do gestor que convidou (nula = administrador da empresa)
  criado_em              timestamptz not null default now(),
  expira_em              timestamptz not null,
  status                 text not null default 'PENDENTE' check (status in ('PENDENTE', 'VERIFICADO', 'CONCLUIDO', 'CANCELADO')),
  verificado_em          timestamptz,
  concluido_em           timestamptz,
  cancelado_em           timestamptz,
  simulado               boolean not null default false,
  constraint comunicacao_convites_token_unico unique (token_hash),
  constraint comunicacao_convites_validade check (expira_em > criado_em and expira_em <= criado_em + interval '72 hours')
);
create index if not exists ix_comunicacao_convites_org on comunicacao_convites (organizacao_id, criado_em desc);
create index if not exists ix_comunicacao_convites_tel on comunicacao_convites (telefone_hmac, criado_em desc);

create or replace function comunicacao_convites_coerencia() returns trigger
language plpgsql set search_path = public as $$
begin
  if exists (select 1 from unnest(new.unidades_pretendidas) u(id)
              where not exists (select 1 from unidades x where x.id = u.id and x.organizacao_id = new.organizacao_id)) then
    raise exception 'comunicacao_convites: unidade fora da empresa' using errcode = '42501';
  end if;
  if new.unidade_permitida is not null and not (new.unidades_pretendidas <@ array[new.unidade_permitida]) then
    raise exception 'comunicacao_convites: o gestor de unidade só convida para a própria unidade' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(new.categorias_pretendidas) c(codigo)
              where not exists (select 1 from comunicacao_categorias k where k.codigo = c.codigo and k.estado in ('ATIVA', 'SIMULACAO'))) then
    raise exception 'comunicacao_convites: categoria indisponível' using errcode = '22023';
  end if;
  if new.contato_empresa_id is not null and not exists (select 1 from comunicacao_contatos_empresa ce where ce.id = new.contato_empresa_id and ce.organizacao_id = new.organizacao_id) then
    raise exception 'comunicacao_convites: destinatário de outra empresa' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and ((to_jsonb(new) - array['status','verificado_em','concluido_em','cancelado_em','contato_empresa_id'])
                           is distinct from (to_jsonb(old) - array['status','verificado_em','concluido_em','cancelado_em','contato_empresa_id'])) then
    raise exception 'comunicacao_convites: só o estado muda' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_comunicacao_convites_coerencia on comunicacao_convites;
create trigger trg_comunicacao_convites_coerencia before insert or update on comunicacao_convites
  for each row execute function comunicacao_convites_coerencia();

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. Desafio OTP (posse do número)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists comunicacao_desafios_titular (
  id               uuid primary key default gen_random_uuid(),
  tipo             text not null check (tipo in ('verificacao', 'gestao')),
  convite_id       uuid references comunicacao_convites(id) on delete cascade,
  telefone_cifrado text not null,
  telefone_hmac    text not null check (telefone_hmac ~ '^[0-9a-f]{64}$'),
  codigo_hmac      text not null check (codigo_hmac ~ '^[0-9a-f]{64}$'),
  chave_versao     integer not null default 1,
  tentativas       integer not null default 0 check (tentativas >= 0),
  max_tentativas   integer not null default 5 check (max_tentativas between 1 and 10),
  criado_em        timestamptz not null default now(),
  expira_em        timestamptz not null,
  ultimo_envio_em  timestamptz not null default now(),
  consumido_em     timestamptz,
  invalidado_em    timestamptz,
  ip_hmac          text,
  simulado         boolean not null default false,
  constraint comunicacao_desafios_validade check (expira_em > criado_em and expira_em <= criado_em + interval '5 minutes'),
  constraint comunicacao_desafios_convite check ((tipo = 'verificacao') = (convite_id is not null))
);
create index if not exists ix_comunicacao_desafios_tel on comunicacao_desafios_titular (telefone_hmac, criado_em desc);
create index if not exists ix_comunicacao_desafios_ip on comunicacao_desafios_titular (ip_hmac, criado_em desc);

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. Livro-razão de consentimento (append-only)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists comunicacao_consentimentos (
  id                 uuid primary key default gen_random_uuid(),
  telefone_hmac      text not null check (telefone_hmac ~ '^[0-9a-f]{64}$'),
  contato_empresa_id uuid,                                   -- sem FK: o registro sobrevive
  organizacao_id     uuid not null,
  unidade_escopo_id  uuid,                                   -- nula = empresa toda (nunca "unidade_id": D-11)
  categoria          text not null,
  acao               text not null check (acao in ('CONCEDIDO', 'REVOGADO', 'PREFERENCIA_ALTERADA')),
  termo_versao       integer references comunicacao_termos(versao),
  termo_hash         text,
  origem             text not null check (origem in ('link_convite_otp', 'pagina_gestao_otp', 'palavra_chave_inbound', 'pedido_registrado_gestor')),
  evidencia_id       uuid,
  registrado_por     uuid,
  ip_hmac            text,
  user_agent_resumo  text check (user_agent_resumo is null or length(user_agent_resumo) <= 120),
  simulado           boolean not null default false,
  ocorreu_em         timestamptz not null default now(),
  constraint comunicacao_consent_concedido_prova check (
    acao <> 'CONCEDIDO' or (termo_versao is not null and termo_hash is not null and evidencia_id is not null
                           and origem in ('link_convite_otp', 'pagina_gestao_otp')))
);
create index if not exists ix_comunicacao_consent_ce on comunicacao_consentimentos (contato_empresa_id, categoria, ocorreu_em desc);
create index if not exists ix_comunicacao_consent_tel on comunicacao_consentimentos (telefone_hmac, organizacao_id, ocorreu_em desc);
drop trigger if exists trg_comunicacao_consentimentos_imutavel on comunicacao_consentimentos;
create trigger trg_comunicacao_consentimentos_imutavel before update or delete on comunicacao_consentimentos
  for each row execute function comunicacao_registro_imutavel();

alter table comunicacao_destinatario_escopos add column if not exists verificacao_simulada boolean not null default false;

/** Última ação do titular (ou registrada a pedido dele) para destinatário × categoria: 'CONCEDIDO' | 'REVOGADO' | null. */
create or replace function comunicacao_consentimento_vigente(p_contato_empresa_id uuid, p_categoria text) returns text
language sql stable security invoker set search_path = public as $$
  select acao from comunicacao_consentimentos
   where contato_empresa_id = p_contato_empresa_id and categoria = p_categoria and acao in ('CONCEDIDO', 'REVOGADO')
   order by ocorreu_em desc, id desc limit 1;
$$;

-- Nenhum gestor (nem o Painel ADM) reativa o que o TITULAR revogou: reabilitar categoria/escopo exige um novo CONCEDIDO.
create or replace function comunicacao_bloquear_reativacao_revogada() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.habilitado is true and (tg_op = 'INSERT' or old.habilitado is distinct from true)
     and comunicacao_consentimento_vigente(new.contato_empresa_id, new.categoria) = 'REVOGADO' then
    raise exception 'O titular revogou esta categoria: só um novo consentimento dele reativa.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_comunicacao_dest_cat_revogada on comunicacao_destinatario_categorias;
create trigger trg_comunicacao_dest_cat_revogada before insert or update of habilitado on comunicacao_destinatario_categorias
  for each row execute function comunicacao_bloquear_reativacao_revogada();
drop trigger if exists trg_comunicacao_escopo_revogada on comunicacao_destinatario_escopos;
create trigger trg_comunicacao_escopo_revogada before insert or update of habilitado on comunicacao_destinatario_escopos
  for each row execute function comunicacao_bloquear_reativacao_revogada();

-- ---------------------------------------------------------------------------------------------------------------------------
-- 5. RPCs do desafio (atômicas)
-- ---------------------------------------------------------------------------------------------------------------------------
/** Cria um desafio: intervalo de 60 s, 5/hora e 10/dia por telefone, 20/hora por IP; invalida os anteriores do mesmo alvo. */
-- p_id: o backend pode escolher o id (gerado ANTES de saber se o número existe) para responder à gestão sem esperar o banco —
-- assim o tempo de resposta não revela a existência do número (anti-enumeração). Nulo = id gerado aqui.
create or replace function comunicacao_desafio_criar(p_tipo text, p_convite_id uuid, p_telefone_cifrado text, p_telefone_hmac text,
  p_codigo_hmac text, p_ip_hmac text, p_simulado boolean, p_chave_versao integer, p_id uuid default null) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare v_ult timestamptz; v_id uuid; c comunicacao_convites;
begin
  perform pg_advisory_xact_lock(hashtext('comunicacao_desafio:' || p_telefone_hmac));
  if p_tipo = 'verificacao' then
    select * into c from comunicacao_convites where id = p_convite_id for update;
    if not found or c.status <> 'PENDENTE' or c.expira_em <= now() then return jsonb_build_object('resultado', 'CONVITE_INVALIDO'); end if;
    if c.telefone_hmac <> p_telefone_hmac then return jsonb_build_object('resultado', 'CONVITE_INVALIDO'); end if;
  end if;
  select max(ultimo_envio_em) into v_ult from comunicacao_desafios_titular where telefone_hmac = p_telefone_hmac and tipo = p_tipo;
  if v_ult is not null and v_ult > now() - interval '60 seconds' then
    return jsonb_build_object('resultado', 'AGUARDE', 'segundos', ceil(extract(epoch from (v_ult + interval '60 seconds' - now())))::int);
  end if;
  if (select count(*) from comunicacao_desafios_titular where telefone_hmac = p_telefone_hmac and criado_em > now() - interval '1 hour') >= 5
     or (select count(*) from comunicacao_desafios_titular where telefone_hmac = p_telefone_hmac and criado_em > now() - interval '1 day') >= 10
     or (p_ip_hmac is not null and (select count(*) from comunicacao_desafios_titular where ip_hmac = p_ip_hmac and criado_em > now() - interval '1 hour') >= 20) then
    return jsonb_build_object('resultado', 'LIMITE');
  end if;
  update comunicacao_desafios_titular set invalidado_em = now()
   where telefone_hmac = p_telefone_hmac and tipo = p_tipo and consumido_em is null and invalidado_em is null
     and (p_convite_id is null or convite_id = p_convite_id);
  insert into comunicacao_desafios_titular (id, tipo, convite_id, telefone_cifrado, telefone_hmac, codigo_hmac, chave_versao, expira_em, ip_hmac, simulado)
  values (coalesce(p_id, gen_random_uuid()), p_tipo, p_convite_id, p_telefone_cifrado, p_telefone_hmac, p_codigo_hmac, coalesce(p_chave_versao, 1), now() + interval '5 minutes', p_ip_hmac, coalesce(p_simulado, false))
  returning id into v_id;
  return jsonb_build_object('resultado', 'CRIADO', 'desafio_id', v_id);
end $$;

/** Verifica o código: uso único, 5 tentativas, 5 minutos. A tentativa conta ANTES da comparação (na mesma transação). */
create or replace function comunicacao_desafio_verificar(p_desafio_id uuid, p_codigo_hmac text) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare d comunicacao_desafios_titular;
begin
  select * into d from comunicacao_desafios_titular where id = p_desafio_id for update;
  if not found or d.consumido_em is not null or d.invalidado_em is not null then return jsonb_build_object('resultado', 'INVALIDO'); end if;
  if d.expira_em <= now() then return jsonb_build_object('resultado', 'EXPIRADO'); end if;
  if d.tentativas >= d.max_tentativas then return jsonb_build_object('resultado', 'BLOQUEADO'); end if;
  update comunicacao_desafios_titular set tentativas = tentativas + 1 where id = d.id;
  if d.codigo_hmac = p_codigo_hmac then
    update comunicacao_desafios_titular set consumido_em = now() where id = d.id;
    if d.convite_id is not null then
      update comunicacao_convites set status = 'VERIFICADO', verificado_em = now() where id = d.convite_id and status = 'PENDENTE';
    end if;
    return jsonb_build_object('resultado', 'VERIFICADO', 'simulado', d.simulado);
  end if;
  if d.tentativas + 1 >= d.max_tentativas then
    update comunicacao_desafios_titular set invalidado_em = now() where id = d.id;
    return jsonb_build_object('resultado', 'BLOQUEADO');
  end if;
  return jsonb_build_object('resultado', 'INCORRETO', 'restantes', d.max_tentativas - d.tentativas - 1);
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 6. Consentimento do titular (convite) e conclusão do vínculo
-- ---------------------------------------------------------------------------------------------------------------------------
/** O TITULAR aceita categorias do convite (subconjunto das pretendidas). Exige desafio de verificação consumido há ≤ 15 min e o
 *  termo vigente. Cria (ou adota) o destinatário — SEM tocar `contatos_whatsapp` e com whatsapp_status NAO_VALIDADO (o D-1 legado
 *  não o enxerga) —, grava CONCEDIDO por categoria e cria os escopos CONVITE_OTP nas unidades pretendidas. */
create or replace function comunicacao_titular_consentir(p_convite_id uuid, p_desafio_id uuid, p_categorias text[], p_termo_versao integer,
  p_telefone_e164 text, p_ip_hmac text, p_user_agent text) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare c comunicacao_convites; d comunicacao_desafios_titular; t comunicacao_termos; v_ce uuid; v_cat text; v_un uuid; v_n integer := 0;
begin
  select * into c from comunicacao_convites where id = p_convite_id for update;
  if not found or c.status <> 'VERIFICADO' or c.expira_em <= now() then return jsonb_build_object('resultado', 'CONVITE_INVALIDO'); end if;
  select * into d from comunicacao_desafios_titular where id = p_desafio_id;
  if not found or d.convite_id <> c.id or d.consumido_em is null or d.consumido_em < now() - interval '15 minutes' then
    return jsonb_build_object('resultado', 'VERIFICACAO_EXPIRADA');
  end if;
  select * into t from comunicacao_termos where versao = p_termo_versao;
  if not found or t.versao <> (select max(versao) from comunicacao_termos) then return jsonb_build_object('resultado', 'TERMO_DESATUALIZADO'); end if;
  if p_categorias is null or cardinality(p_categorias) = 0 then
    update comunicacao_convites set status = 'CONCLUIDO', concluido_em = now() where id = c.id;
    return jsonb_build_object('resultado', 'RECUSADO_PELO_TITULAR');
  end if;
  if not (p_categorias <@ c.categorias_pretendidas) then return jsonb_build_object('resultado', 'CATEGORIA_NAO_CONVIDADA'); end if;
  if p_telefone_e164 is null or p_telefone_e164 !~ '^\+[1-9][0-9]{7,14}$' then return jsonb_build_object('resultado', 'TELEFONE_INVALIDO'); end if;

  v_ce := c.contato_empresa_id;
  if v_ce is null then
    select id into v_ce from comunicacao_contatos_empresa where organizacao_id = c.organizacao_id and telefone_e164 = p_telefone_e164 and ativo limit 1;
  end if;
  if v_ce is null then
    insert into comunicacao_contatos_empresa (organizacao_id, nome, telefone_e164, tipo, whatsapp_status, ativo, observacoes, criado_por)
    values (c.organizacao_id, c.nome, p_telefone_e164, c.tipo_destinatario, 'NAO_VALIDADO', true,
            case when d.simulado then 'Criado pela Central de Notificações (SIMULAÇÃO)' else 'Criado pela Central de Notificações (OTP + consentimento)' end,
            c.criado_perfil_id)
    returning id into v_ce;
  end if;

  foreach v_cat in array p_categorias loop
    insert into comunicacao_consentimentos (telefone_hmac, contato_empresa_id, organizacao_id, categoria, acao, termo_versao, termo_hash, origem,
                                            evidencia_id, ip_hmac, user_agent_resumo, simulado)
    values (c.telefone_hmac, v_ce, c.organizacao_id, v_cat, 'CONCEDIDO', t.versao, t.hash, 'link_convite_otp', d.id, p_ip_hmac, left(p_user_agent, 120), d.simulado);
    foreach v_un in array c.unidades_pretendidas loop
      insert into comunicacao_destinatario_escopos (contato_empresa_id, unidade_escopo_id, categoria, habilitado, origem_autorizacao, origem_vinculo,
                                                    criado_por, verificacao_simulada)
      values (v_ce, v_un, v_cat, true, 'CONVITE_OTP', 'CONVITE', c.criado_por, d.simulado)
      on conflict (contato_empresa_id, unidade_escopo_id, categoria) do nothing;
      v_n := v_n + 1;
    end loop;
  end loop;
  update comunicacao_convites set status = 'CONCLUIDO', concluido_em = now(), contato_empresa_id = v_ce where id = c.id;
  return jsonb_build_object('resultado', 'CONSENTIDO', 'contato_empresa_id', v_ce, 'escopos', v_n, 'simulado', d.simulado);
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 7. Revogação (titular ou pedido registrado pelo gestor) — efeito IMEDIATO, inclusive para legados e mensagens enfileiradas
-- ---------------------------------------------------------------------------------------------------------------------------
/** Revoga categorias (nulo = todas) de destinatários já resolvidos pelo backend (o banco não conhece o telefone em claro).
 *  `p_unidade_escopo_id` restringe à unidade (pedido do gestor de unidade): desliga só os escopos dela; sem ela, a revogação vale
 *  para a empresa inteira e também desliga a categoria legada (`comunicacao_destinatario_categorias`) — o portão do envio real.
 *  `p_sair_de_tudo` = o titular pediu para não receber mais NADA: registra também o opt-out do número (mecanismo existente). */
create or replace function comunicacao_revogar(p_telefone_hmac text, p_contatos_empresa uuid[], p_categorias text[], p_unidade_escopo_id uuid,
  p_origem text, p_evidencia_id uuid, p_registrado_por uuid, p_sair_de_tudo boolean, p_ip_hmac text) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare v_ce uuid; ce comunicacao_contatos_empresa; v_cat text; v_cats text[]; v_canc integer := 0; v_n integer := 0; v_tipos text[];
begin
  if p_origem not in ('pagina_gestao_otp', 'palavra_chave_inbound', 'pedido_registrado_gestor') then return jsonb_build_object('resultado', 'ORIGEM_INVALIDA'); end if;
  foreach v_ce in array coalesce(p_contatos_empresa, '{}') loop
    select * into ce from comunicacao_contatos_empresa where id = v_ce for update;
    if not found then continue; end if;
    v_cats := coalesce(p_categorias, array(select codigo from comunicacao_categorias));
    foreach v_cat in array v_cats loop
      insert into comunicacao_consentimentos (telefone_hmac, contato_empresa_id, organizacao_id, unidade_escopo_id, categoria, acao, origem, evidencia_id, registrado_por, ip_hmac)
      values (p_telefone_hmac, v_ce, ce.organizacao_id, p_unidade_escopo_id, v_cat, 'REVOGADO', p_origem, p_evidencia_id, p_registrado_por, p_ip_hmac);
      v_n := v_n + 1;
    end loop;
    update comunicacao_destinatario_escopos set habilitado = false, atualizado_por = p_registrado_por
     where contato_empresa_id = v_ce and categoria = any (v_cats) and (p_unidade_escopo_id is null or unidade_escopo_id = p_unidade_escopo_id);
    if p_unidade_escopo_id is null then
      update comunicacao_destinatario_categorias set habilitado = false, updated_at = now() where contato_empresa_id = v_ce and categoria = any (v_cats);
    end if;
    v_tipos := array(select tipo_alerta from comunicacao_categorias where codigo = any (v_cats));
    update comunicacao_mensagens set status = 'CANCELLED', erro = 'REVOGADO_PELO_TITULAR'
     where contato_empresa_id = v_ce and tipo = any (v_tipos) and status in ('SCHEDULED', 'PROCESSING')
       and (p_unidade_escopo_id is null or unidade_id = p_unidade_escopo_id);
    get diagnostics v_canc = row_count;
    if coalesce(p_sair_de_tudo, false) and ce.contato_whatsapp_id is not null then
      update contatos_whatsapp set opt_out = true, opt_out_em = coalesce(opt_out_em, now()), updated_at = now() where id = ce.contato_whatsapp_id;
    end if;
  end loop;
  return jsonb_build_object('resultado', 'REVOGADO', 'registros', v_n, 'mensagens_canceladas', v_canc);
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 8. RLS e privilégios mínimos
-- ---------------------------------------------------------------------------------------------------------------------------
alter table comunicacao_termos enable row level security;
alter table comunicacao_convites enable row level security;
alter table comunicacao_desafios_titular enable row level security;
alter table comunicacao_consentimentos enable row level security;
do $$
declare papel text; fn text;
  fns constant text[] := array[
    'comunicacao_consentimento_vigente(uuid,text)', 'comunicacao_desafio_criar(text,uuid,text,text,text,text,boolean,integer,uuid)',
    'comunicacao_desafio_verificar(uuid,text)', 'comunicacao_titular_consentir(uuid,uuid,text[],integer,text,text,text)',
    'comunicacao_revogar(text,uuid[],text[],uuid,text,uuid,uuid,boolean,text)',
    'comunicacao_bloquear_reativacao_revogada()', 'comunicacao_convites_coerencia()'];
begin
  foreach papel in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if papel = 'public' or exists (select 1 from pg_roles where rolname = papel) then
      execute format('revoke all on table comunicacao_termos, comunicacao_convites, comunicacao_desafios_titular, comunicacao_consentimentos from %s', papel);
      foreach fn in array fns loop execute format('revoke all on function %s from %s', fn, papel); end loop;
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on table comunicacao_termos, comunicacao_consentimentos to service_role;
    grant select, insert on table comunicacao_convites to service_role;
    grant update (status, cancelado_em) on table comunicacao_convites to service_role;
    grant select on table comunicacao_desafios_titular to service_role;      -- escrita só pelas RPCs (security invoker + grants abaixo)
    grant insert on table comunicacao_desafios_titular to service_role;
    grant update (tentativas, consumido_em, invalidado_em, ultimo_envio_em) on table comunicacao_desafios_titular to service_role;
    grant update (status, verificado_em, concluido_em, contato_empresa_id) on table comunicacao_convites to service_role;
    foreach fn in array fns loop
      if fn not in ('comunicacao_bloquear_reativacao_revogada()', 'comunicacao_convites_coerencia()') then
        execute format('grant execute on function %s to service_role', fn);
      end if;
    end loop;
  end if;
end $$;



-- ===== 135_notificacoes_cotas_categoria.sql =====
-- 135 — D-9: cotas INDEPENDENTES por categoria nova. As cotas do D-1 (comunicacao_reservar_envio, `limites`, cooldowns,
-- limite_diario_org) NÃO são alteradas: `pendencia_d1` fica com `cota = NULL` (segue exatamente a regra atual).
--
-- Nesta versão as categorias novas só existem em SIMULAÇÃO: a simulação grava em `operacional_mensagens_simuladas` (130) — nunca
-- em `comunicacao_mensagens` — então não entra na fila do D-1, não consome cota real e o worker do D-1 nunca a vê.
-- `comunicacao_cota_categoria_disponivel` é SÓ LEITURA: conta apenas envios REAIS da categoria (comunicacao_mensagens do tipo dela),
-- e serve para a prévia da simulação dizer se o envio caberia na cota. A reserva consumidora para envio real fica para a Etapa 6
-- (exige fila própria das categorias novas — ver docs/configuracoes-2-notificacoes/11 §5).
-- Rollback: 135_rollback.sql.

set local lock_timeout = '5s';

do $$ begin
  if to_regclass('public.comunicacao_categorias') is null
     or not exists (select 1 from information_schema.columns where table_name = 'comunicacao_categorias' and column_name = 'estado') then
    raise exception '135: exige a migration 133';
  end if;
end $$;

alter table comunicacao_categorias add column if not exists cota jsonb;
comment on column comunicacao_categorias.cota is
  'D-9: cota própria da categoria nova {"por_destinatario_dia":n,"por_unidade_dia":n,"por_empresa_dia":n}. NULL em pendencia_d1 (o D-1 segue a regra atual, intacta).';

create or replace function comunicacao_cota_valida(p jsonb) returns boolean
language sql immutable set search_path = public as $$
  select p is null or (jsonb_typeof(p) = 'object'
    and (p ? 'por_destinatario_dia') and (p ? 'por_unidade_dia') and (p ? 'por_empresa_dia')
    and (p->>'por_destinatario_dia') ~ '^[1-9][0-9]{0,3}$' and (p->>'por_unidade_dia') ~ '^[1-9][0-9]{0,4}$'
    and (p->>'por_empresa_dia') ~ '^[1-9][0-9]{0,5}$');
$$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'comunicacao_categorias_cota_valida') then
    alter table comunicacao_categorias add constraint comunicacao_categorias_cota_valida check (comunicacao_cota_valida(cota));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'comunicacao_categorias_d1_sem_cota_propria') then
    alter table comunicacao_categorias add constraint comunicacao_categorias_d1_sem_cota_propria check (codigo <> 'pendencia_d1' or cota is null);
  end if;
end $$;

update comunicacao_categorias set cota = '{"por_destinatario_dia": 2, "por_unidade_dia": 20, "por_empresa_dia": 100}'::jsonb
 where codigo <> 'pendencia_d1' and cota is null;

/** Só leitura: a categoria ainda cabe na cota hoje? Conta só envios REAIS (não simulados) do tipo da categoria. */
create or replace function comunicacao_cota_categoria_disponivel(p_categoria text, p_contato_empresa_id uuid, p_unidade_id uuid,
  p_organizacao_id uuid, p_inicio_dia timestamptz) returns jsonb
language sql stable security invoker set search_path = public as $$
  with cat as (select tipo_alerta, cota from comunicacao_categorias where codigo = p_categoria),
  envios as (
    select m.contato_empresa_id, m.unidade_id, m.organizacao_id from comunicacao_mensagens m, cat
     where m.tipo = cat.tipo_alerta and m.organizacao_id = p_organizacao_id and m.direcao = 'saida'
       and m.status in ('SENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN') and coalesce(m.enviado_em, m.created_at) >= p_inicio_dia)
  select case
    when (select cota from cat) is null then jsonb_build_object('disponivel', false, 'motivo', 'CATEGORIA_SEM_COTA_PROPRIA')
    when (select count(*) from envios where contato_empresa_id = p_contato_empresa_id) >= ((select cota from cat)->>'por_destinatario_dia')::int
      then jsonb_build_object('disponivel', false, 'motivo', 'COTA_DESTINATARIO')
    when (select count(*) from envios where unidade_id = p_unidade_id) >= ((select cota from cat)->>'por_unidade_dia')::int
      then jsonb_build_object('disponivel', false, 'motivo', 'COTA_UNIDADE')
    when (select count(*) from envios) >= ((select cota from cat)->>'por_empresa_dia')::int
      then jsonb_build_object('disponivel', false, 'motivo', 'COTA_EMPRESA')
    else jsonb_build_object('disponivel', true, 'motivo', null) end;
$$;

do $$ declare papel text; begin
  foreach papel in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if papel = 'public' or exists (select 1 from pg_roles where rolname = papel) then
      execute format('revoke all on function comunicacao_cota_categoria_disponivel(text,uuid,uuid,uuid,timestamptz) from %s', papel);
      execute format('revoke all on function comunicacao_cota_valida(jsonb) from %s', papel);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function comunicacao_cota_categoria_disponivel(text,uuid,uuid,uuid,timestamptz) to service_role;
  end if;
end $$;


commit;
