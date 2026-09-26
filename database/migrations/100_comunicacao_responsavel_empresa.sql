-- =====================================================================
-- MIGRATION 100 — Comunicação: RESPONSÁVEL DE COMUNICAÇÃO por EMPRESA (substitui o modelo "perfil com acesso")
-- =====================================================================
-- PROBLEMA (auditado em produção): "quem é o destinatário autorizado desta empresa?" era respondido por um PERFIL (login) validado por
-- `usuarios_organizacoes`/`usuarios_unidades` — a relação genérica de ACESSO. O perfil "Jailton Matos" tem acesso ativo a 47 das 48 empresas
-- (administrador/mentor da rede), então qualquer consulta que cruze perfil ↔ empresa por acesso o mostrava em TODAS elas — inclusive na view
-- `comunicacao_roster_autorizado` (096), que alimenta a Central de Conversas, e nas RPCs de agendamento (088/092/094). Acesso NÃO é ser
-- responsável de comunicação.
--
-- REGRA DEFINITIVA:   EMPRESA -> RESPONSÁVEL DE COMUNICAÇÃO (ativo) -> TELEFONE (WhatsApp VALIDADO)      Nunca: empresa -> perfil com acesso -> telefone.
--   * comunicacao_contatos_empresa: `organizacao_id` OBRIGATÓRIO; o responsável NÃO precisa ser usuário; vários por empresa (`tipo`), 1 principal ativo.
--   * A habilitação aponta para o responsável por FK composta (id, organizacao_id): o banco impede apontar para contato de OUTRA empresa.
--   * UMA função é a fonte única da regra no banco: comunicacao_resolver_destinatario(organizacao). As RPCs 088 (agendar), 092 (reforço),
--     094 (aviso tardio) e 093 (habilitar piloto) e a view do roster (096) passam a usá-la / a ler o responsável — nenhuma lê mais perfil/acesso.
--   * A mensagem guarda SNAPSHOT (empresa/contato/telefone/data de referência): o histórico nunca é derivado depois de unidade/usuário.
--
-- BACKFILL (não destrutivo): cria o responsável de cada habilitação existente (contato correto = o da habilitação, nunca "outro contato do
-- mesmo perfil"), preenche o ponteiro e vincula as mensagens NÃO TERMINAIS (SCHEDULED/PROCESSING) ao responsável — sem isso elas cairiam em
-- SEM_VINCULO. Mensagens terminais/histórico ficam intocadas. Nenhuma empresa é habilitada/desabilitada por esta migration.
--
-- PRÉ-REQUISITOS: 082…099 aplicadas (verificado abaixo). TRANSACIONAL. ROLLBACK: 100_rollback.sql (restaura os corpos EXATOS de 088/092/094/093 e do roster 096).
-- SEGURANÇA: SECURITY INVOKER, search_path fixo, EXECUTE só para service_role.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 0. PRÉ-CHECAGEM (falha cedo se a base não é a 099)
-- ---------------------------------------------------------------------
do $$
begin
  if to_regprocedure('comunicacao_agendar_reforco_alerta(uuid,text,text,timestamptz,timestamptz,integer)') is null
     or to_regprocedure('comunicacao_agendar_aviso_tardio_d1(uuid,text,text,timestamptz,timestamptz,integer)') is null
     or to_regprocedure('comunicacao_habilitar_organizacao_piloto(uuid,uuid)') is null
     or to_regclass('public.comunicacao_roster_autorizado') is null
     or not exists (select 1 from information_schema.columns where table_name = 'comunicacao_mensagens' and column_name = 'metadados') then
    raise exception 'migration 100 exige as migrations 082..099 aplicadas (092 reforço, 093 habilitar piloto, 094 aviso tardio, 096 roster, metadados)';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. RESPONSÁVEL DE COMUNICAÇÃO POR EMPRESA
-- ---------------------------------------------------------------------
create table if not exists comunicacao_contatos_empresa (
  id                    uuid primary key default gen_random_uuid(),
  organizacao_id        uuid not null references organizacoes(id) on delete cascade,
  nome                  text not null check (length(btrim(nome)) > 0),
  telefone_e164         text not null check (telefone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  ddi                   text,
  tipo                  text not null default 'principal' check (tipo in ('principal', 'secundario', 'financeiro', 'operacional')),
  -- Registro do TELEFONE (consentimento/verificado/opt-out): continua sendo a autoridade dos portões de envio. Um mesmo número pode servir a
  -- mais de uma empresa; o VÍNCULO e a VALIDAÇÃO são daqui (por empresa).
  contato_whatsapp_id   uuid references contatos_whatsapp(id) on delete set null,
  whatsapp_status       text not null default 'NAO_VALIDADO' check (whatsapp_status in ('NAO_VALIDADO', 'AGUARDANDO_VALIDACAO', 'VALIDADO', 'ERRO')),
  whatsapp_validado_em  timestamptz,
  ativo                 boolean not null default true,
  observacoes           text,
  -- OPCIONAL e só informativo: ligar a um login é uma conveniência futura, nunca requisito (nenhuma decisão o consulta).
  perfil_operacional_id uuid references perfis_operacionais(id) on delete set null,
  criado_por            uuid references perfis_operacionais(id) on delete set null,
  atualizado_por        uuid references perfis_operacionais(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint comunicacao_contatos_empresa_validado_exige_data check (whatsapp_status <> 'VALIDADO' or whatsapp_validado_em is not null),
  constraint comunicacao_contatos_empresa_id_org_unico unique (id, organizacao_id)
);
comment on table comunicacao_contatos_empresa is
  'Responsável de COMUNICAÇÃO (WhatsApp) de uma EMPRESA (organizacoes). Vínculo explícito e independente de usuário/unidade/perfil ativo/sessão. organizacao_id é obrigatório.';

create unique index if not exists ux_contatos_empresa_principal_ativo on comunicacao_contatos_empresa (organizacao_id) where ativo and tipo = 'principal';
create unique index if not exists ux_contatos_empresa_telefone_ativo  on comunicacao_contatos_empresa (organizacao_id, telefone_e164) where ativo;
create index if not exists ix_contatos_empresa_org on comunicacao_contatos_empresa (organizacao_id);
create index if not exists ix_contatos_empresa_contato on comunicacao_contatos_empresa (contato_whatsapp_id);

drop trigger if exists trg_comunicacao_contatos_empresa_upd on comunicacao_contatos_empresa;
create trigger trg_comunicacao_contatos_empresa_upd before update on comunicacao_contatos_empresa
  for each row execute function set_updated_at();

alter table comunicacao_contatos_empresa enable row level security;
revoke all on comunicacao_contatos_empresa from authenticated, anon;

-- ---------------------------------------------------------------------
-- 2. A HABILITAÇÃO aponta para o RESPONSÁVEL da própria empresa (FK composta)
-- ---------------------------------------------------------------------
alter table comunicacao_habilitacoes add column if not exists destinatario_contato_empresa_id uuid;
do $$ begin
  alter table comunicacao_habilitacoes add constraint comunicacao_habilitacoes_contato_empresa_fk
    foreign key (destinatario_contato_empresa_id, organizacao_id) references comunicacao_contatos_empresa (id, organizacao_id);
exception when duplicate_object then null; end $$;

-- O par (contato, perfil) deixa de ser exigido: o responsável não precisa ser usuário.
alter table comunicacao_habilitacoes drop constraint if exists comunicacao_habilitacoes_destinatario_par;
alter table comunicacao_habilitacoes drop constraint if exists comunicacao_habilitacoes_destinatario_fk;

create or replace function comunicacao_habilitacoes_valida()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.timezone is not null and (
       not exists (select 1 from pg_timezone_names where name = new.timezone)
       or (new.timezone <> 'UTC' and (new.timezone not like '%/%' or new.timezone ilike 'etc/%'))) then
    raise exception 'timezone IANA invalido: %', new.timezone using errcode = '22023';
  end if;
  if new.janelas is not null and jsonb_typeof(new.janelas) <> 'object' then
    raise exception 'janelas deve ser um objeto jsonb' using errcode = '22023';
  end if;
  -- destinatário: o RESPONSÁVEL da própria empresa (nunca inferido de perfil/unidade/usuário).
  if new.destinatario_contato_empresa_id is not null then
    if not exists (select 1 from comunicacao_contatos_empresa ce
                    where ce.id = new.destinatario_contato_empresa_id and ce.organizacao_id = new.organizacao_id
                      and ce.ativo and ce.contato_whatsapp_id is not distinct from new.destinatario_contato_id) then
      raise exception 'responsavel de comunicacao inexistente, inativo ou de outra empresa' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function comunicacao_habilitacoes_valida() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. SNAPSHOT na mensagem (histórico: a empresa REAL usada no envio)
-- ---------------------------------------------------------------------
alter table comunicacao_mensagens add column if not exists contato_empresa_id    uuid references comunicacao_contatos_empresa(id) on delete set null;
alter table comunicacao_mensagens add column if not exists empresa_nome_snapshot text;
alter table comunicacao_mensagens add column if not exists contato_nome_snapshot text;
alter table comunicacao_mensagens add column if not exists telefone_snapshot     text;
alter table comunicacao_mensagens add column if not exists data_referencia       date;
comment on column comunicacao_mensagens.empresa_nome_snapshot is
  'Nome da empresa NO MOMENTO do agendamento — o histórico nunca deriva a empresa depois (unidade/usuário podem mudar).';

-- ---------------------------------------------------------------------
-- 4. BACKFILL (não destrutivo, idempotente)
-- ---------------------------------------------------------------------
-- 4a. o responsável de cada habilitação existente = o contato DA HABILITAÇÃO (nunca outro contato do mesmo perfil)
insert into comunicacao_contatos_empresa
  (organizacao_id, nome, telefone_e164, tipo, contato_whatsapp_id, whatsapp_status, whatsapp_validado_em, ativo, perfil_operacional_id, observacoes)
select h.organizacao_id, coalesce(nullif(btrim(po.nome), ''), 'Responsável'), c.telefone_e164, 'principal', c.id,
       case when c.verificado and c.consentimento then 'VALIDADO' else 'AGUARDANDO_VALIDACAO' end,
       case when c.verificado and c.consentimento then now() end,
       true, h.destinatario_perfil_id, 'Migrado da configuração anterior (100).'
  from comunicacao_habilitacoes h
  join contatos_whatsapp c on c.id = h.destinatario_contato_id
  left join perfis_operacionais po on po.id = h.destinatario_perfil_id
 where h.destinatario_contato_id is not null
   and not exists (select 1 from comunicacao_contatos_empresa x where x.organizacao_id = h.organizacao_id and x.tipo = 'principal' and x.ativo);

-- 4b. o ponteiro da habilitação
update comunicacao_habilitacoes h
   set destinatario_contato_empresa_id = ce.id
  from comunicacao_contatos_empresa ce
 where h.destinatario_contato_empresa_id is null and h.destinatario_contato_id is not null
   and ce.organizacao_id = h.organizacao_id and ce.contato_whatsapp_id = h.destinatario_contato_id and ce.ativo and ce.tipo = 'principal';

-- 4c. mensagens NÃO TERMINAIS de alerta (SCHEDULED/PROCESSING) -> vinculadas ao responsável + snapshot; sem isso cairiam em SEM_VINCULO.
--     Terminais (SENT/READ/...), manuais e de teste NÃO são tocadas (histórico preservado). Em função (idempotente) para ser testável e re-executável.
create or replace function comunicacao_vincular_mensagens_ao_responsavel()
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare n integer;
begin
  update comunicacao_mensagens m
     set contato_empresa_id    = ce.id,
         empresa_nome_snapshot = o.nome,
         contato_nome_snapshot = ce.nome,
         telefone_snapshot     = ce.telefone_e164,
         data_referencia       = (select a.data_referencia from comunicacao_alertas a where a.id = m.alerta_id)
    from comunicacao_contatos_empresa ce
    join organizacoes o on o.id = ce.organizacao_id
   where m.contato_empresa_id is null
     and m.status in ('SCHEDULED', 'PROCESSING')
     and m.alerta_id is not null
     and m.organizacao_id = ce.organizacao_id
     and m.contato_id = ce.contato_whatsapp_id
     and ce.ativo;
  get diagnostics n = row_count;
  return n;
end;
$$;
comment on function comunicacao_vincular_mensagens_ao_responsavel() is
  'Backfill da migration 100: vincula mensagens de alerta NÃO terminais (SCHEDULED/PROCESSING) ao responsável da MESMA empresa cujo telefone é o do contato da mensagem, e grava o snapshot. Idempotente; devolve quantas linhas mudou. Terminais/manuais/teste ficam intocadas.';
revoke all on function comunicacao_vincular_mensagens_ao_responsavel() from public, anon, authenticated;
grant execute on function comunicacao_vincular_mensagens_ao_responsavel() to service_role;
select comunicacao_vincular_mensagens_ao_responsavel();

-- 4d. só agora que o backfill apontou as habilitações existentes: contato e responsável andam juntos
do $$ begin
  alter table comunicacao_habilitacoes add constraint comunicacao_habilitacoes_destinatario_coerente
    check ((destinatario_contato_id is null) = (destinatario_contato_empresa_id is null));
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- 5. CONFIGURAÇÃO: disponibilidade dos dados do iFood (D-1) — configurável, sem hardcode
-- ---------------------------------------------------------------------
insert into comunicacao_configuracoes (chave, valor) values
  ('disponibilidade_ifood', '{"dados_disponiveis_apos": "10:00", "envios_permitidos_apos": "10:30"}'::jsonb)
on conflict (chave) do nothing;

-- ---------------------------------------------------------------------
-- 6. FONTE ÚNICA da regra "quem é o destinatário autorizado desta empresa?"
-- ---------------------------------------------------------------------
create or replace function comunicacao_resolver_destinatario(p_organizacao_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare h comunicacao_habilitacoes; ce comunicacao_contatos_empresa; c contatos_whatsapp;
begin
  select * into h from comunicacao_habilitacoes where organizacao_id = p_organizacao_id;
  if not found or h.destinatario_contato_empresa_id is null or h.destinatario_contato_id is null then
    return jsonb_build_object('acao', 'SEM_DESTINATARIO');
  end if;
  -- o responsável TEM de ser da MESMA empresa (nunca por unidade/usuário/perfil/telefone solto)
  select * into ce from comunicacao_contatos_empresa where id = h.destinatario_contato_empresa_id and organizacao_id = p_organizacao_id;
  select * into c from contatos_whatsapp where id = h.destinatario_contato_id;
  if ce.id is null or ce.ativo is not true or ce.whatsapp_status <> 'VALIDADO'
     or ce.contato_whatsapp_id is distinct from h.destinatario_contato_id
     or c.id is null or c.opt_out is not false or c.consentimento is not true or c.verificado is not true
     or c.telefone_e164 is distinct from ce.telefone_e164 then
    return jsonb_build_object('acao', 'DESTINATARIO_INELEGIVEL');
  end if;
  return jsonb_build_object('acao', 'OK', 'contato_id', c.id, 'contato_empresa_id', ce.id, 'perfil_id', ce.perfil_operacional_id,
                            'nome', ce.nome, 'telefone', ce.telefone_e164);
end;
$$;
comment on function comunicacao_resolver_destinatario(uuid) is
  'Fonte ÚNICA da regra empresa -> responsável de comunicação (ativo, mesma organização) -> telefone VALIDADO. Devolve {acao: OK|SEM_DESTINATARIO|DESTINATARIO_INELEGIVEL, ...}. Nunca perfil/usuário/unidade.';
revoke all on function comunicacao_resolver_destinatario(uuid) from public, anon, authenticated;
grant execute on function comunicacao_resolver_destinatario(uuid) to service_role;

-- ---------------------------------------------------------------------
-- 7. RPCs de agendamento: mesma lógica de 088/092/094, destinatário = responsável DA EMPRESA + snapshot
-- ---------------------------------------------------------------------
-- 7.1 agendamento principal (088)
create or replace function comunicacao_agendar_mensagem_alerta(
  p_alerta_id uuid, p_tipo text, p_conteudo text,
  p_idempotency_key text, p_disponivel_em timestamptz, p_expira_em timestamptz,
  p_max_tentativas integer default 5
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare a comunicacao_alertas; m comunicacao_mensagens; h comunicacao_habilitacoes; n integer; v_dest jsonb; v_org_nome text;
begin
  select * into a from comunicacao_alertas where id = p_alerta_id for update;  -- serializa por alerta
  if not found then return jsonb_build_object('acao', 'ALERTA_INEXISTENTE'); end if;

  select * into m from comunicacao_mensagens where idempotency_key = p_idempotency_key;
  if found then
    if m.alerta_id is distinct from a.id then return jsonb_build_object('acao', 'CHAVE_EM_USO'); end if;
    -- a mensagem deste evento lógico já EXPIROU: NÃO cria outra (lembrete/nova versão = regra explícita futura)
    if m.status = 'CANCELLED' and m.erro = 'EXPIRADA' then
      return jsonb_build_object('acao', 'MENSAGEM_EXPIRADA', 'mensagem_id', m.id);
    end if;
    if a.status = 'DETECTED' and m.status in ('SCHEDULED', 'PROCESSING', 'SENDING') then
      update comunicacao_alertas set status = 'SCHEDULED' where id = a.id; -- repara alerta preso
    end if;
    return jsonb_build_object('acao', 'JA_EXISTIA', 'mensagem_id', m.id, 'status', m.status);
  end if;

  -- entrega desconhecida/em curso para este evento lógico: nada novo até reconciliar
  select count(*) into n from comunicacao_mensagens where alerta_id = a.id and status in ('SENDING', 'DELIVERY_UNKNOWN');
  if n > 0 then return jsonb_build_object('acao', 'ENTREGA_DESCONHECIDA'); end if;

  if a.status <> 'DETECTED' then
    return jsonb_build_object('acao', 'ALERTA_NAO_DETECTED', 'status_alerta', a.status);
  end if;

  -- HABILITAÇÃO + RESPONSÁVEL DA EMPRESA (fail-closed): nenhuma escolha do chamador
  select * into h from comunicacao_habilitacoes where organizacao_id = a.organizacao_id;
  if not found or h.habilitado is not true or h.timezone is null then
    return jsonb_build_object('acao', 'NAO_HABILITADA');
  end if;
  if p_tipo is null or not (p_tipo = any (h.tipos_permitidos)) then
    return jsonb_build_object('acao', 'TIPO_NAO_PERMITIDO');
  end if;
  v_dest := comunicacao_resolver_destinatario(a.organizacao_id);
  if v_dest->>'acao' <> 'OK' then return jsonb_build_object('acao', v_dest->>'acao'); end if;

  select nome into v_org_nome from organizacoes where id = a.organizacao_id;

  insert into comunicacao_mensagens (alerta_id, organizacao_id, unidade_id, contato_id, destinatario_perfil_id,
                                     contato_empresa_id, empresa_nome_snapshot, contato_nome_snapshot, telefone_snapshot, data_referencia,
                                     tipo, conteudo, idempotency_key, status, disponivel_em, expira_em, max_tentativas)
  values (a.id, a.organizacao_id, a.unidade_id, (v_dest->>'contato_id')::uuid, (v_dest->>'perfil_id')::uuid,
          (v_dest->>'contato_empresa_id')::uuid, v_org_nome, v_dest->>'nome', v_dest->>'telefone', a.data_referencia,
          p_tipo, p_conteudo, p_idempotency_key, 'SCHEDULED', p_disponivel_em, p_expira_em, p_max_tentativas)
  returning * into m;
  update comunicacao_alertas set status = 'SCHEDULED' where id = a.id;
  return jsonb_build_object('acao', 'CRIADA', 'mensagem_id', m.id);
end;
$$;
comment on function comunicacao_agendar_mensagem_alerta(uuid, text, text, text, timestamptz, timestamptz, integer) is
  'Cria a mensagem (idempotente pela chave) e move o alerta DETECTED -> SCHEDULED na MESMA transação. O destinatário é o RESPONSÁVEL DE COMUNICAÇÃO da empresa do alerta (comunicacao_resolver_destinatario) — nunca perfil/usuário/unidade. Grava snapshot de empresa/contato/telefone/data. Recusa: ENTREGA_DESCONHECIDA, NAO_HABILITADA, TIPO_NAO_PERMITIDO, SEM_DESTINATARIO, DESTINATARIO_INELEGIVEL, MENSAGEM_EXPIRADA.';
revoke all on function comunicacao_agendar_mensagem_alerta(uuid, text, text, text, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function comunicacao_agendar_mensagem_alerta(uuid, text, text, text, timestamptz, timestamptz, integer) to service_role;

-- 7.2 reforço (092)
create or replace function comunicacao_agendar_reforco_alerta(
  p_alerta_id uuid, p_conteudo text, p_idempotency_key text,
  p_disponivel_em timestamptz, p_expira_em timestamptz,
  p_max_tentativas integer default 5
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  a comunicacao_alertas; m comunicacao_mensagens; ini comunicacao_mensagens;
  h comunicacao_habilitacoes; n integer; v_dest jsonb; v_org_nome text;
begin
  select * into a from comunicacao_alertas where id = p_alerta_id for update;  -- serializa por alerta
  if not found then return jsonb_build_object('acao', 'ALERTA_INEXISTENTE'); end if;

  -- A chave do reforço é DETERMINÍSTICA e validada aqui: impossível criar um 2º reforço com outra chave.
  if p_idempotency_key is distinct from ('wa:alerta:' || a.id::text || ':reforco:v1') then
    return jsonb_build_object('acao', 'CHAVE_INVALIDA');
  end if;

  select * into m from comunicacao_mensagens where idempotency_key = p_idempotency_key;
  if found then
    if m.alerta_id is distinct from a.id then return jsonb_build_object('acao', 'CHAVE_EM_USO'); end if;
    return jsonb_build_object('acao', 'JA_EXISTIA', 'mensagem_id', m.id, 'status', m.status);
  end if;

  -- Estado coerente com "o 1º aviso já saiu". DETECTED/SCHEDULED/PROCESSING/BLOCKED/FAILED/
  -- RESPONDED/RESOLVED/CANCELLED nunca recebem reforço.
  if a.status not in ('SENT', 'DELIVERED', 'READ') then
    return jsonb_build_object('acao', 'ALERTA_SEM_PRIMEIRO_ENVIO', 'status_alerta', a.status);
  end if;

  -- A 1ª mensagem precisa existir E ter saído de fato (DELIVERY_UNKNOWN = incerto -> fail-closed).
  select * into ini from comunicacao_mensagens where idempotency_key = ('wa:alerta:' || a.id::text || ':v1');
  if not found or ini.alerta_id is distinct from a.id or ini.status not in ('SENT', 'DELIVERED', 'READ') then
    return jsonb_build_object('acao', 'PRIMEIRA_MENSAGEM_NAO_ENVIADA');
  end if;

  select count(*) into n from comunicacao_mensagens
   where alerta_id = a.id and status in ('PROCESSING', 'SENDING', 'DELIVERY_UNKNOWN');
  if n > 0 then return jsonb_build_object('acao', 'ENTREGA_EM_CURSO'); end if;

  -- HABILITAÇÃO + RESPONSÁVEL DA EMPRESA (fail-closed) — MESMAS checagens da RPC NORMAL.
  select * into h from comunicacao_habilitacoes where organizacao_id = a.organizacao_id;
  if not found or h.habilitado is not true or h.timezone is null then
    return jsonb_build_object('acao', 'NAO_HABILITADA');
  end if;
  if not (a.tipo_alerta = any (h.tipos_permitidos)) then
    return jsonb_build_object('acao', 'TIPO_NAO_PERMITIDO');
  end if;
  v_dest := comunicacao_resolver_destinatario(a.organizacao_id);
  if v_dest->>'acao' <> 'OK' then return jsonb_build_object('acao', v_dest->>'acao'); end if;

  select nome into v_org_nome from organizacoes where id = a.organizacao_id;

  insert into comunicacao_mensagens (alerta_id, organizacao_id, unidade_id, contato_id, destinatario_perfil_id,
                                     contato_empresa_id, empresa_nome_snapshot, contato_nome_snapshot, telefone_snapshot, data_referencia,
                                     tipo, conteudo, idempotency_key, status, disponivel_em, expira_em, max_tentativas, metadados)
  values (a.id, a.organizacao_id, a.unidade_id, (v_dest->>'contato_id')::uuid, (v_dest->>'perfil_id')::uuid,
          (v_dest->>'contato_empresa_id')::uuid, v_org_nome, v_dest->>'nome', v_dest->>'telefone', a.data_referencia,
          a.tipo_alerta, p_conteudo, p_idempotency_key, 'SCHEDULED', p_disponivel_em, p_expira_em, p_max_tentativas,
          jsonb_build_object('proposito', 'reforco'))
  returning * into m;
  -- O status do ALERTA não muda aqui nem depois (ver o trigger da 092): o reforço tem fonte de verdade própria.
  return jsonb_build_object('acao', 'CRIADA', 'mensagem_id', m.id);
end;
$$;
comment on function comunicacao_agendar_reforco_alerta(uuid, text, text, timestamptz, timestamptz, integer) is
  'Cria o ÚNICO reforço (wa:alerta:{id}:reforco:v1) de um alerta cujo 1º aviso (…:v1) já saiu (SENT/DELIVERED/READ). Idempotente pela chave. Destinatário = responsável DA EMPRESA (comunicacao_resolver_destinatario). Recusa: ALERTA_INEXISTENTE, CHAVE_INVALIDA, ALERTA_SEM_PRIMEIRO_ENVIO, PRIMEIRA_MENSAGEM_NAO_ENVIADA, ENTREGA_EM_CURSO, NAO_HABILITADA, TIPO_NAO_PERMITIDO, SEM_DESTINATARIO, DESTINATARIO_INELEGIVEL. Não altera o status do alerta. Horário/cutoff/espaçamento/texto são do backend.';
revoke all on function comunicacao_agendar_reforco_alerta(uuid, text, text, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function comunicacao_agendar_reforco_alerta(uuid, text, text, timestamptz, timestamptz, integer) to service_role;

-- 7.3 aviso tardio D-1 (094)
create or replace function comunicacao_agendar_aviso_tardio_d1(
  p_alerta_id uuid, p_conteudo text, p_idempotency_key text,
  p_disponivel_em timestamptz, p_expira_em timestamptz,
  p_max_tentativas integer default 5
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  a comunicacao_alertas; m comunicacao_mensagens; h comunicacao_habilitacoes; n integer; v_dest jsonb; v_org_nome text;
begin
  select * into a from comunicacao_alertas where id = p_alerta_id for update;  -- serializa por alerta
  if not found then return jsonb_build_object('acao', 'ALERTA_INEXISTENTE'); end if;

  if a.tipo_alerta <> 'dashboard_ifood_d1' then return jsonb_build_object('acao', 'TIPO_NAO_SUPORTADO'); end if;

  -- MESMA identidade da 1ª mensagem: impossível uma 2ª identidade "tardia".
  if p_idempotency_key is distinct from ('wa:alerta:' || a.id::text || ':v1') then
    return jsonb_build_object('acao', 'CHAVE_INVALIDA');
  end if;

  select * into m from comunicacao_mensagens where idempotency_key = p_idempotency_key;
  if found then
    if m.alerta_id is distinct from a.id then return jsonb_build_object('acao', 'CHAVE_EM_USO'); end if;
    if m.status = 'CANCELLED' and m.erro = 'EXPIRADA' then
      return jsonb_build_object('acao', 'MENSAGEM_EXPIRADA', 'mensagem_id', m.id); -- expirou: NUNCA recria (nem amanhã)
    end if;
    return jsonb_build_object('acao', 'JA_EXISTIA', 'mensagem_id', m.id, 'status', m.status);
  end if;

  -- Nenhuma OUTRA mensagem inicial (de qualquer chave) e nenhuma entrega em curso/incerta para este alerta.
  select count(*) into n from comunicacao_mensagens
   where alerta_id = a.id and coalesce(metadados->>'proposito', 'inicial') = 'inicial';
  if n > 0 then return jsonb_build_object('acao', 'INICIAL_JA_EXISTE'); end if;
  select count(*) into n from comunicacao_mensagens
   where alerta_id = a.id and status in ('PROCESSING', 'SENDING', 'DELIVERY_UNKNOWN');
  if n > 0 then return jsonb_build_object('acao', 'ENTREGA_EM_CURSO'); end if;

  if a.status <> 'DETECTED' then
    return jsonb_build_object('acao', 'ALERTA_NAO_DETECTED', 'status_alerta', a.status);
  end if;

  -- HABILITAÇÃO + RESPONSÁVEL DA EMPRESA (fail-closed) — MESMAS checagens da RPC NORMAL.
  select * into h from comunicacao_habilitacoes where organizacao_id = a.organizacao_id;
  if not found or h.habilitado is not true or h.timezone is null then
    return jsonb_build_object('acao', 'NAO_HABILITADA');
  end if;
  if not (a.tipo_alerta = any (h.tipos_permitidos)) then
    return jsonb_build_object('acao', 'TIPO_NAO_PERMITIDO');
  end if;
  v_dest := comunicacao_resolver_destinatario(a.organizacao_id);
  if v_dest->>'acao' <> 'OK' then return jsonb_build_object('acao', v_dest->>'acao'); end if;

  select nome into v_org_nome from organizacoes where id = a.organizacao_id;

  insert into comunicacao_mensagens (alerta_id, organizacao_id, unidade_id, contato_id, destinatario_perfil_id,
                                     contato_empresa_id, empresa_nome_snapshot, contato_nome_snapshot, telefone_snapshot, data_referencia,
                                     tipo, conteudo, idempotency_key, status, disponivel_em, expira_em, max_tentativas, metadados)
  values (a.id, a.organizacao_id, a.unidade_id, (v_dest->>'contato_id')::uuid, (v_dest->>'perfil_id')::uuid,
          (v_dest->>'contato_empresa_id')::uuid, v_org_nome, v_dest->>'nome', v_dest->>'telefone', a.data_referencia,
          a.tipo_alerta, p_conteudo, p_idempotency_key, 'SCHEDULED', p_disponivel_em, p_expira_em, p_max_tentativas,
          jsonb_build_object('proposito', 'inicial', 'origem', 'prazo_final_d1'))
  returning * into m;
  update comunicacao_alertas set status = 'SCHEDULED' where id = a.id;
  return jsonb_build_object('acao', 'CRIADA', 'mensagem_id', m.id);
end;
$$;
comment on function comunicacao_agendar_aviso_tardio_d1(uuid, text, text, timestamptz, timestamptz, integer) is
  'Cria a PRIMEIRA mensagem (wa:alerta:{id}:v1, proposito=inicial, origem=prazo_final_d1) de um alerta dashboard_ifood_d1 DETECTED sem nenhuma inicial. Atômica e idempotente pela chave; exatamente uma inicial por alerta (normal OU tardia). Destinatário = responsável DA EMPRESA (comunicacao_resolver_destinatario). Recusa: ALERTA_INEXISTENTE, TIPO_NAO_SUPORTADO, CHAVE_INVALIDA, CHAVE_EM_USO, MENSAGEM_EXPIRADA, INICIAL_JA_EXISTE, ENTREGA_EM_CURSO, ALERTA_NAO_DETECTED, NAO_HABILITADA, TIPO_NAO_PERMITIDO, SEM_DESTINATARIO, DESTINATARIO_INELEGIVEL. D-1/horário/texto são do backend.';
revoke all on function comunicacao_agendar_aviso_tardio_d1(uuid, text, text, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function comunicacao_agendar_aviso_tardio_d1(uuid, text, text, timestamptz, timestamptz, integer) to service_role;

-- 7.4 habilitação atômica do piloto (093): o destinatário é o responsável DA EMPRESA (ativo, WhatsApp validado, consentido/verificado/sem opt-out)
create or replace function comunicacao_habilitar_organizacao_piloto(
  p_organizacao_id uuid, p_ator_perfil_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  h comunicacao_habilitacoes; v_modo text; n integer; v_ator uuid; v_dest jsonb;
begin
  -- Serializa TODAS as habilitações (mesmo de organizações diferentes): "nenhuma outra habilitada" só é
  -- verdade se duas habilitações concorrentes nunca leem o mesmo estado.
  perform pg_advisory_xact_lock(hashtext('comunicacao_habilitar_organizacao_piloto'));

  select trim(both '"' from (valor #>> '{}')) into v_modo from comunicacao_configuracoes where chave = 'modo';
  if coalesce(v_modo, 'DISABLED') <> 'DISABLED' then
    return jsonb_build_object('acao', 'MODO_NAO_DESABILITADO', 'modo', v_modo);
  end if;

  select * into h from comunicacao_habilitacoes where organizacao_id = p_organizacao_id for update;
  if not found then return jsonb_build_object('acao', 'SEM_CONFIGURACAO'); end if;
  if h.habilitado then return jsonb_build_object('acao', 'JA_HABILITADA'); end if;

  select count(*) into n from comunicacao_habilitacoes where habilitado and organizacao_id <> p_organizacao_id;
  if n > 0 then return jsonb_build_object('acao', 'OUTRA_ORGANIZACAO_HABILITADA'); end if;

  if h.timezone is null then return jsonb_build_object('acao', 'TIMEZONE_AUSENTE'); end if;
  if coalesce(array_length(h.tipos_permitidos, 1), 0) = 0 then return jsonb_build_object('acao', 'TIPO_AUSENTE'); end if;

  v_dest := comunicacao_resolver_destinatario(p_organizacao_id);
  if v_dest->>'acao' = 'SEM_DESTINATARIO' then return jsonb_build_object('acao', 'SEM_DESTINATARIO'); end if;
  if v_dest->>'acao' <> 'OK' then return jsonb_build_object('acao', 'DESTINATARIO_INELEGIVEL'); end if;

  -- atualizado_por tem FK para perfis_operacionais: um ator sem perfil operacional vira NULL (a auditoria do backend guarda o ator real).
  select id into v_ator from perfis_operacionais where id = p_ator_perfil_id;

  update comunicacao_habilitacoes
     set habilitado = true, atualizado_por = v_ator, updated_at = now()
   where organizacao_id = p_organizacao_id;
  return jsonb_build_object('acao', 'HABILITADA');
end;
$$;
comment on function comunicacao_habilitar_organizacao_piloto(uuid, uuid) is
  'Habilita ATOMICAMENTE (advisory lock) a organização piloto: modo=DISABLED, nenhuma outra habilitada, timezone/tipo configurados e responsável DA EMPRESA elegível (ativo, WhatsApp validado, consentido+verificado+sem opt-out). Recusa com acao = MODO_NAO_DESABILITADO | SEM_CONFIGURACAO | JA_HABILITADA | OUTRA_ORGANIZACAO_HABILITADA | TIMEZONE_AUSENTE | TIPO_AUSENTE | SEM_DESTINATARIO | DESTINATARIO_INELEGIVEL. Desabilitar é feito pelo backend (sempre permitido).';
revoke all on function comunicacao_habilitar_organizacao_piloto(uuid, uuid) from public, anon, authenticated;
grant execute on function comunicacao_habilitar_organizacao_piloto(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------
-- 8. ROSTER AUTORIZADO (096): contato autorizado = RESPONSÁVEL DE COMUNICAÇÃO ATIVO com WhatsApp VALIDADO de uma empresa.
--    Colunas antigas preservadas (mesma ordem/tipos) + responsavel_id/responsavel_nome ao fim. Unidades da empresa só para EXIBIÇÃO.
-- ---------------------------------------------------------------------
create or replace view comunicacao_roster_autorizado
with (security_invoker = true) as
select
  c.id                      as contato_id,
  c.telefone_e164,
  c.consentimento,
  c.verificado,
  c.opt_out,
  ce.perfil_operacional_id  as perfil_id,
  ce.nome                   as perfil_nome,
  o.id                      as organizacao_id,
  o.nome                    as organizacao_nome,
  ce.tipo::text             as papel,
  un.id                     as unidade_id,
  un.nome                   as unidade_nome,
  ce.id                     as responsavel_id,
  ce.nome                   as responsavel_nome
from comunicacao_contatos_empresa ce
join contatos_whatsapp c on c.id = ce.contato_whatsapp_id and c.telefone_e164 = ce.telefone_e164
join organizacoes o      on o.id = ce.organizacao_id
left join unidades un    on un.organizacao_id = o.id and un.ativo
where ce.ativo and ce.whatsapp_status = 'VALIDADO';

comment on view comunicacao_roster_autorizado is
  'Central de Comunicação: contatos que a Central reconhece = RESPONSÁVEIS DE COMUNICAÇÃO ativos, com WhatsApp validado, de uma empresa (migration 100). Nunca perfil com acesso. Unidades só para exibição.';
revoke all on comunicacao_roster_autorizado from public, anon, authenticated;
grant select on comunicacao_roster_autorizado to service_role;

notify pgrst, 'reload schema';
commit;
