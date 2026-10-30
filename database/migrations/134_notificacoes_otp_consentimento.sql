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

begin;
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
create or replace function comunicacao_desafio_criar(p_tipo text, p_convite_id uuid, p_telefone_cifrado text, p_telefone_hmac text,
  p_codigo_hmac text, p_ip_hmac text, p_simulado boolean, p_chave_versao integer) returns jsonb
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
  insert into comunicacao_desafios_titular (tipo, convite_id, telefone_cifrado, telefone_hmac, codigo_hmac, chave_versao, expira_em, ip_hmac, simulado)
  values (p_tipo, p_convite_id, p_telefone_cifrado, p_telefone_hmac, p_codigo_hmac, coalesce(p_chave_versao, 1), now() + interval '5 minutes', p_ip_hmac, coalesce(p_simulado, false))
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
    'comunicacao_consentimento_vigente(uuid,text)', 'comunicacao_desafio_criar(text,uuid,text,text,text,text,boolean,integer)',
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

commit;
