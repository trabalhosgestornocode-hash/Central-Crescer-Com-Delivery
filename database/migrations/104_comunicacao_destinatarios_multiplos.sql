-- =====================================================================
-- MIGRATION 104 — Comunicação WhatsApp: FIM DO PILOTO -> configuração definitiva por EMPRESA, VÁRIOS destinatários
-- =====================================================================
-- O QUE MUDA
--   1. Envio automático é uma decisão EXPLÍCITA da empresa (`comunicacao_habilitacoes.envio_automatico`), SEMPRE false na migration.
--      `habilitado` é PRESERVADO como está; envio real exige habilitado E envio_automatico (além de destinatário, consentimento, categoria, janela, limites).
--   2. VÁRIOS destinatários por empresa (`comunicacao_contatos_empresa`), cada um tratado individualmente:
--        * idempotência por  alerta + destinatário + propósito  (índice único parcial);
--        * uma mensagem por destinatário, criadas juntas numa única transação (`comunicacao_agendar_mensagens_alerta`);
--        * cooldown POR DESTINATÁRIO (antes: por organização+unidade+tipo — o 2º destinatário seria bloqueado pelo envio ao 1º);
--        * limite diário por ORGANIZAÇÃO (novo) além do limite por contato/dia;
--        * teto de destinatários ativos por empresa, CONFIGURÁVEL (`comunicacao_configuracoes.destinatarios`).
--   3. CATEGORIAS de aviso extensíveis (`comunicacao_categorias` + `comunicacao_destinatario_categorias`). Seed: SÓ o que já existe funcionalmente
--      (pendencia_d1 -> dashboard_ifood_d1). Adicionar categoria = inserir uma linha no catálogo (+ o monitor que a produz); sem reformular nada.
--   4. Status do ALERTA agregado a partir de TODAS as mensagens iniciais, com precedência explícita (`comunicacao_status_agregado_alerta`).
--   5. Habilitar a empresa deixa de exigir "modo DISABLED" e "nenhuma outra empresa habilitada" (regras do piloto) — exige destinatário elegível.
--   6. As 3 RPCs de agendamento de destinatário ÚNICO (088/092/094/100) perdem o EXECUTE: contornariam envio_automatico e a idempotência por destinatário.
--
-- SEGURANÇA DE TRANSIÇÃO
--   * Nenhuma empresa é habilitada nem tem envio automático ligado por esta migration (pós-check aborta a transação se isso acontecer).
--   * Destinatários já cadastrados ganham a categoria pendencia_d1 SÓ se a empresa já a permitia em `tipos_permitidos` (preserva a configuração atual;
--     sem envio_automatico nada é enviado). Nenhum dado é apagado nem reinterpretado.
--
-- PRÉ-REQUISITOS: 082…100 aplicadas. TRANSACIONAL. ROLLBACK: 104_rollback.sql (restaura os corpos EXATOS de 088/092/100).
-- SEGURANÇA: SECURITY INVOKER, search_path fixo, EXECUTE só para service_role, RLS ligado nas tabelas novas.
-- =====================================================================
begin;

do $$
begin
  if to_regclass('public.comunicacao_contatos_empresa') is null
     or to_regprocedure('comunicacao_resolver_destinatario(uuid)') is null
     or (to_regprocedure('comunicacao_reservar_envio(uuid,text,bigint,integer,numeric,integer,integer,integer,timestamptz)') is null
         and to_regprocedure('comunicacao_reservar_envio(uuid,text,bigint,integer,numeric,integer,integer,integer,timestamptz,integer)') is null)
     or to_regprocedure('comunicacao_habilitar_organizacao_piloto(uuid,uuid)') is null then
    raise exception 'migration 104 exige as migrations 082..100 aplicadas';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. ENVIO AUTOMÁTICO + limites por empresa (na habilitação)
-- ---------------------------------------------------------------------
alter table comunicacao_habilitacoes add column if not exists envio_automatico boolean not null default false;
alter table comunicacao_habilitacoes add column if not exists limite_diario_org integer;
alter table comunicacao_habilitacoes add column if not exists cooldown_minutos integer;
alter table comunicacao_habilitacoes add column if not exists envio_automatico_atualizado_em timestamptz;
alter table comunicacao_habilitacoes add column if not exists envio_automatico_atualizado_por uuid references perfis_operacionais(id) on delete set null;

do $$ begin
  alter table comunicacao_habilitacoes add constraint comunicacao_habilitacoes_limite_diario_org_positivo check (limite_diario_org is null or limite_diario_org > 0);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table comunicacao_habilitacoes add constraint comunicacao_habilitacoes_cooldown_positivo check (cooldown_minutos is null or cooldown_minutos > 0);
exception when duplicate_object then null; end $$;
-- envio automático só existe para empresa habilitada (desabilitar a empresa desliga o automático junto)
do $$ begin
  alter table comunicacao_habilitacoes add constraint comunicacao_habilitacoes_automatico_exige_habilitado check (not envio_automatico or habilitado);
exception when duplicate_object then null; end $$;

comment on column comunicacao_habilitacoes.envio_automatico is
  'Opt-in EXPLÍCITO do envio automático da empresa. Nasce false SEMPRE (inclusive para empresas já habilitadas). Envio real exige habilitado E envio_automatico.';
comment on column comunicacao_habilitacoes.limite_diario_org is
  'Teto de mensagens de alerta por DIA (calendário local) para a empresa toda (todos os destinatários somados). NULL = padrão global (comunicacao_configuracoes.limites.max_por_organizacao_por_dia).';
comment on column comunicacao_habilitacoes.cooldown_minutos is
  'Cooldown por DESTINATÁRIO em minutos. NULL = padrão global por severidade (comunicacao_configuracoes.cooldowns_horas).';

-- O destinatário não é mais UM ponteiro na habilitação: são TODOS os ativos da empresa. O ponteiro vira legado informativo.
alter table comunicacao_habilitacoes drop constraint if exists comunicacao_habilitacoes_habilitado_exige_destinatario;

-- O ponteiro legado deixa de exigir que o principal esteja ATIVO (desativar um destinatário não pode travar a linha da empresa).
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
  if new.destinatario_contato_empresa_id is not null then
    if not exists (select 1 from comunicacao_contatos_empresa ce
                    where ce.id = new.destinatario_contato_empresa_id and ce.organizacao_id = new.organizacao_id
                      and ce.contato_whatsapp_id is not distinct from new.destinatario_contato_id) then
      raise exception 'responsavel de comunicacao inexistente ou de outra empresa' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function comunicacao_habilitacoes_valida() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. CATEGORIAS de aviso (extensível) + categorias POR DESTINATÁRIO
-- ---------------------------------------------------------------------
create table if not exists comunicacao_categorias (
  codigo      text primary key check (codigo ~ '^[a-z][a-z0-9_]{1,63}$'),
  rotulo      text not null check (length(btrim(rotulo)) > 0),
  descricao   text,
  tipo_alerta text not null check (length(btrim(tipo_alerta)) > 0),
  ativo       boolean not null default true,
  created_at  timestamptz not null default now()
);
comment on table comunicacao_categorias is
  'Catálogo de categorias de aviso. Cada categoria mapeia UM tipo_alerta do motor. Nova categoria = nova linha (+ o monitor que gera o tipo); destinatários, idempotência e banco não mudam.';
alter table comunicacao_categorias enable row level security;
revoke all on comunicacao_categorias from authenticated, anon;

-- SEED: apenas o que já existe funcionalmente (reforço e aviso tardio são ESTÁGIOS desta mesma categoria).
insert into comunicacao_categorias (codigo, rotulo, descricao, tipo_alerta)
values ('pendencia_d1', 'Pendência D-1', 'Lançamento do dia anterior (D-1) pendente no Dashboard iFood, incluindo o reforço e o aviso de prazo final.', 'dashboard_ifood_d1')
on conflict (codigo) do nothing;

create table if not exists comunicacao_destinatario_categorias (
  contato_empresa_id uuid not null,
  organizacao_id     uuid not null,
  categoria          text not null references comunicacao_categorias(codigo),
  habilitado         boolean not null default true,
  habilitado_em      timestamptz not null default now(),
  habilitado_por     uuid references perfis_operacionais(id) on delete set null,
  updated_at         timestamptz not null default now(),
  primary key (contato_empresa_id, categoria),
  -- o banco impede categoria de destinatário de OUTRA empresa
  constraint comunicacao_dest_categorias_ce_fk foreign key (contato_empresa_id, organizacao_id)
    references comunicacao_contatos_empresa (id, organizacao_id) on delete cascade
);
create index if not exists ix_dest_categorias_org on comunicacao_destinatario_categorias (organizacao_id);
alter table comunicacao_destinatario_categorias enable row level security;
revoke all on comunicacao_destinatario_categorias from authenticated, anon;
drop trigger if exists trg_comunicacao_dest_categorias_upd on comunicacao_destinatario_categorias;
create trigger trg_comunicacao_dest_categorias_upd before update on comunicacao_destinatario_categorias
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- 3. Destinatário: autorização registrada + teto configurável de ativos por empresa
-- ---------------------------------------------------------------------
alter table comunicacao_contatos_empresa add column if not exists ativado_em timestamptz;
alter table comunicacao_contatos_empresa add column if not exists autorizacao_registrada_em timestamptz;
alter table comunicacao_contatos_empresa add column if not exists autorizacao_registrada_por uuid references perfis_operacionais(id) on delete set null;
comment on column comunicacao_contatos_empresa.autorizacao_registrada_em is
  'Quando um operador registrou (validação explícita) que este destinatário autorizou receber os avisos. O consentimento em si continua em contatos_whatsapp.';

-- BACKFILL (não destrutivo): preserva datas já conhecidas
update comunicacao_contatos_empresa set ativado_em = created_at where ativo and ativado_em is null;
update comunicacao_contatos_empresa set autorizacao_registrada_em = whatsapp_validado_em
 where whatsapp_status = 'VALIDADO' and autorizacao_registrada_em is null;
update comunicacao_contatos_empresa set autorizacao_registrada_por = atualizado_por
 where whatsapp_status = 'VALIDADO' and autorizacao_registrada_por is null;
-- categoria dos destinatários EXISTENTES: só o que a empresa já permitia (nada novo é liberado; sem envio_automatico nada sai)
insert into comunicacao_destinatario_categorias (contato_empresa_id, organizacao_id, categoria, habilitado)
select ce.id, ce.organizacao_id, cat.codigo, true
  from comunicacao_contatos_empresa ce
  join comunicacao_habilitacoes h on h.organizacao_id = ce.organizacao_id
  join comunicacao_categorias cat on cat.tipo_alerta = any (h.tipos_permitidos)
on conflict do nothing;

insert into comunicacao_configuracoes (chave, valor) values ('destinatarios', '{"max_ativos_por_organizacao": 5}'::jsonb)
on conflict (chave) do nothing;

create or replace function comunicacao_max_destinatarios_ativos()
returns integer
language sql
stable
set search_path = public
as $$
  select coalesce((select nullif((valor->>'max_ativos_por_organizacao')::integer, 0) from comunicacao_configuracoes where chave = 'destinatarios'), 5);
$$;
revoke all on function comunicacao_max_destinatarios_ativos() from public, anon, authenticated;
grant execute on function comunicacao_max_destinatarios_ativos() to service_role;

create or replace function comunicacao_contatos_empresa_limite()
returns trigger
language plpgsql
set search_path = public
as $$
declare n integer;
begin
  if new.ativo is true then
    perform pg_advisory_xact_lock(hashtext('comunicacao_contatos_empresa_limite:' || new.organizacao_id::text));
    select count(*) into n from comunicacao_contatos_empresa where organizacao_id = new.organizacao_id and ativo and id <> new.id;
    if n >= comunicacao_max_destinatarios_ativos() then
      raise exception 'MAX_DESTINATARIOS_ATIVOS: a empresa ja tem % destinatarios ativos', n using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function comunicacao_contatos_empresa_limite() from public, anon, authenticated;
drop trigger if exists trg_comunicacao_contatos_empresa_limite on comunicacao_contatos_empresa;
create trigger trg_comunicacao_contatos_empresa_limite before insert or update of ativo, organizacao_id on comunicacao_contatos_empresa
  for each row execute function comunicacao_contatos_empresa_limite();

-- ---------------------------------------------------------------------
-- 4. IDEMPOTÊNCIA por  alerta + destinatário + propósito  (o banco é a última palavra, mesmo com 2 workers)
-- ---------------------------------------------------------------------
create unique index if not exists ux_mensagens_alerta_destinatario_proposito
  on comunicacao_mensagens (alerta_id, contato_empresa_id, (coalesce(metadados->>'proposito', 'inicial')))
  where alerta_id is not null and contato_empresa_id is not null and direcao = 'saida';
create index if not exists ix_mensagens_org_enviado
  on comunicacao_mensagens (organizacao_id, enviado_em) where alerta_id is not null;

-- ---------------------------------------------------------------------
-- 5. RESOLVEDOR de destinatários (fonte ÚNICA no banco): TODOS os destinatários da empresa, elegíveis ou não, com o MOTIVO
-- ---------------------------------------------------------------------
create or replace function comunicacao_resolver_destinatarios(p_organizacao_id uuid, p_tipo_alerta text)
returns jsonb
language sql
stable
security invoker
set search_path = public
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
             else null
           end as motivo
      from comunicacao_contatos_empresa ce
      left join contatos_whatsapp c on c.id = ce.contato_whatsapp_id
     where ce.organizacao_id = p_organizacao_id
  ) x;
$$;
comment on function comunicacao_resolver_destinatarios(uuid, text) is
  'Fonte ÚNICA de "quem recebe este tipo de alerta nesta empresa": TODOS os destinatários da empresa (nunca perfil/usuário/unidade) com elegivel e motivo (DESTINATARIO_INATIVO | WHATSAPP_NAO_VALIDADO | SEM_CONTATO | TELEFONE_DIVERGENTE | OPT_OUT | SEM_CONSENTIMENTO | TELEFONE_NAO_VERIFICADO | CATEGORIA_NAO_HABILITADA). Só leitura.';
revoke all on function comunicacao_resolver_destinatarios(uuid, text) from public, anon, authenticated;
grant execute on function comunicacao_resolver_destinatarios(uuid, text) to service_role;

-- ---------------------------------------------------------------------
-- 6. STATUS AGREGADO do alerta — máquina de estados FORMAL (sem ordenação textual, sem enum implícito)
-- ---------------------------------------------------------------------
-- Entrada: as mensagens INICIAIS do alerta (reforço nunca entra: a fonte de verdade do reforço é a própria mensagem).
-- Precedência (a 1ª regra que casa vence):
--   R0  nenhuma mensagem inicial ........................ NULL  (mantém o status atual)
--   R1  alguma ainda a caminho (SCHEDULED|PROCESSING|SENDING) .. SCHEDULED   (João enviado + Maria pendente NÃO é "concluído")
--   R2  alguma entregue à conta do provedor, em ordem EXPLÍCITA de progresso: READ(3) > DELIVERED(2) > SENT(1)
--       (a falha/bloqueio/expiração de OUTRO destinatário não rebaixa um sucesso: fica visível na própria mensagem)
--   R3  alguma DELIVERY_UNKNOWN (e nenhum sucesso) ...... NULL  (incerteza de transporte fica na mensagem; o alerta não muda)
--   R4  alguma FAILED ................................... FAILED
--   R5  alguma BLOCKED .................................. BLOCKED
--   R6  todas CANCELLED (expiradas) ..................... DETECTED (a pendência de negócio continua)
create or replace function comunicacao_status_agregado_alerta(p_alerta_id uuid)
returns text
language sql
stable
security invoker
set search_path = public
as $$
  with c as (
    select count(*) as total,
           count(*) filter (where status in ('SCHEDULED', 'PROCESSING', 'SENDING')) as a_caminho,
           count(*) filter (where status = 'READ') as lidas,
           count(*) filter (where status = 'DELIVERED') as entregues,
           count(*) filter (where status = 'SENT') as enviadas,
           count(*) filter (where status = 'DELIVERY_UNKNOWN') as incertas,
           count(*) filter (where status = 'FAILED') as falhas,
           count(*) filter (where status = 'BLOCKED') as bloqueadas
      from comunicacao_mensagens
     where alerta_id = p_alerta_id and direcao = 'saida' and coalesce(metadados->>'proposito', 'inicial') = 'inicial'
  )
  select case
    when total = 0 then null
    when a_caminho > 0 then 'SCHEDULED'
    when lidas > 0 then 'READ'
    when entregues > 0 then 'DELIVERED'
    when enviadas > 0 then 'SENT'
    when incertas > 0 then null
    when falhas > 0 then 'FAILED'
    when bloqueadas > 0 then 'BLOCKED'
    else 'DETECTED'
  end
  from c;
$$;
comment on function comunicacao_status_agregado_alerta(uuid) is
  'Status do alerta derivado das mensagens INICIAIS, por precedência explícita R0..R6 (ver o cabeçalho da migration 104). NULL = não alterar.';
revoke all on function comunicacao_status_agregado_alerta(uuid) from public, anon, authenticated;
grant execute on function comunicacao_status_agregado_alerta(uuid) to service_role;

create or replace function comunicacao_mensagens_sincroniza_alerta()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_agregado text;
begin
  if new.metadados->>'proposito' = 'reforco' then
    return null; -- fonte de verdade do reforço = a própria mensagem
  end if;
  v_agregado := comunicacao_status_agregado_alerta(new.alerta_id);
  if v_agregado is not null then
    update comunicacao_alertas set status = v_agregado, updated_at = now()
     where id = new.alerta_id and status not in ('RESOLVED', 'CANCELLED') and status <> v_agregado;
  end if;
  return null;
end;
$$;
revoke all on function comunicacao_mensagens_sincroniza_alerta() from public, anon, authenticated;

drop trigger if exists trg_comunicacao_mensagens_sincroniza_alerta on comunicacao_mensagens;
create trigger trg_comunicacao_mensagens_sincroniza_alerta
  after update of status on comunicacao_mensagens
  for each row
  when (old.status is distinct from new.status and new.alerta_id is not null
        and (new.status in ('SENT', 'DELIVERED', 'READ', 'FAILED', 'BLOCKED')
             or (new.status = 'CANCELLED' and new.erro = 'EXPIRADA')))
  execute function comunicacao_mensagens_sincroniza_alerta();

-- ---------------------------------------------------------------------
-- 7. AGENDAMENTO por destinatário — UMA transação, UMA mensagem por destinatário elegível
-- ---------------------------------------------------------------------
-- p_itens: [{contato_empresa_id, conteudo, disponivel_em, expira_em}]. O backend só ESCOLHE horário/texto; a elegibilidade é REVALIDADA aqui.
-- A chave de idempotência é derivada AQUI (nunca vem do chamador): wa:alerta:{id}:dest:{destinatario}:v1  |  …:reforco:v1
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

  v_dest := comunicacao_resolver_destinatarios(a.organizacao_id, a.tipo_alerta);
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

-- As RPCs de destinatário ÚNICO deixam de ser chamáveis (contornariam envio_automatico e a idempotência por destinatário).
revoke execute on function comunicacao_agendar_mensagem_alerta(uuid, text, text, text, timestamptz, timestamptz, integer) from service_role;
revoke execute on function comunicacao_agendar_reforco_alerta(uuid, text, text, timestamptz, timestamptz, integer) from service_role;
revoke execute on function comunicacao_agendar_aviso_tardio_d1(uuid, text, text, timestamptz, timestamptz, integer) from service_role;

-- ---------------------------------------------------------------------
-- 8. RESERVA de capacidade: cooldown POR DESTINATÁRIO + limite diário por ORGANIZAÇÃO
-- ---------------------------------------------------------------------
drop function if exists comunicacao_reservar_envio(uuid, text, bigint, integer, numeric, integer, integer, integer, timestamptz);
create or replace function comunicacao_reservar_envio(
  p_id uuid, p_worker text, p_claim_geracao bigint, p_lease_segundos integer,
  p_cooldown_horas numeric, p_max_por_contato_dia integer,
  p_max_por_minuto integer, p_max_por_minuto_org integer, p_inicio_dia timestamptz,
  p_max_por_org_dia integer default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare m comunicacao_mensagens; r comunicacao_mensagens; n integer;
begin
  perform pg_advisory_xact_lock(hashtext('comunicacao_capacidade'));

  select * into m from comunicacao_mensagens where id = p_id;
  if not found or m.status <> 'PROCESSING' or m.claimed_by is distinct from p_worker
     or m.claim_geracao <> p_claim_geracao or m.claim_expira_em is null or m.claim_expira_em <= now()
     or m.tentativas >= m.max_tentativas then
    return jsonb_build_object('resultado', 'POSSE_PERDIDA');
  end if;
  if m.expira_em is not null and m.expira_em <= now() then
    update comunicacao_mensagens set status = 'CANCELLED', erro = 'EXPIRADA', updated_at = now() where id = m.id;
    return jsonb_build_object('resultado', 'EXPIRADA');
  end if;

  -- COOLDOWN POR DESTINATÁRIO (mesmo contato) na mesma organização/unidade/tipo: o envio ao João nunca adia a Maria
  if p_cooldown_horas is not null then
    select count(*) into n from comunicacao_mensagens x
     where x.id <> m.id and x.direcao = 'saida' and x.organizacao_id = m.organizacao_id
       and x.contato_id is not distinct from m.contato_id
       and x.unidade_id is not distinct from m.unidade_id and x.tipo = m.tipo
       and ( x.status in ('SENDING', 'DELIVERY_UNKNOWN')
          or (x.status in ('SENT', 'DELIVERED', 'READ') and x.enviado_em >= now() - make_interval(secs => p_cooldown_horas * 3600)) );
    if n > 0 then return jsonb_build_object('resultado', 'COOLDOWN'); end if;
  end if;

  -- LIMITE POR DESTINATÁRIO / dia
  if p_max_por_contato_dia is not null and m.contato_id is not null then
    select count(*) into n from comunicacao_mensagens x
     where x.id <> m.id and x.direcao = 'saida' and x.contato_id = m.contato_id
       and x.status in ('SENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN')
       and (x.enviado_em >= p_inicio_dia or x.entrega_incerta_em >= p_inicio_dia or (x.status = 'SENDING' and x.claimed_at >= p_inicio_dia));
    if n >= p_max_por_contato_dia then return jsonb_build_object('resultado', 'RATE_LIMIT_DIA'); end if;
  end if;

  -- LIMITE POR ORGANIZAÇÃO / dia (todos os destinatários somados; só mensagens de ALERTA — resposta humana não consome)
  if p_max_por_org_dia is not null and m.alerta_id is not null then
    select count(*) into n from comunicacao_mensagens x
     where x.id <> m.id and x.direcao = 'saida' and x.organizacao_id = m.organizacao_id and x.alerta_id is not null
       and x.status in ('SENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN')
       and (x.enviado_em >= p_inicio_dia or x.entrega_incerta_em >= p_inicio_dia or (x.status = 'SENDING' and x.claimed_at >= p_inicio_dia));
    if n >= p_max_por_org_dia then return jsonb_build_object('resultado', 'RATE_LIMIT_DIA_ORGANIZACAO'); end if;
  end if;

  if p_max_por_minuto_org is not null then
    select count(*) into n from comunicacao_mensagens x
     where x.id <> m.id and x.direcao = 'saida' and x.organizacao_id = m.organizacao_id
       and x.status in ('SENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN')
       and (x.enviado_em >= now() - interval '1 minute' or x.entrega_incerta_em >= now() - interval '1 minute'
            or (x.status = 'SENDING' and x.claimed_at >= now() - interval '1 minute'));
    if n >= p_max_por_minuto_org then return jsonb_build_object('resultado', 'RATE_LIMIT_MINUTO_ORGANIZACAO'); end if;
  end if;

  if p_max_por_minuto is not null then
    select count(*) into n from comunicacao_mensagens x
     where x.id <> m.id and x.direcao = 'saida'
       and x.status in ('SENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN')
       and (x.enviado_em >= now() - interval '1 minute' or x.entrega_incerta_em >= now() - interval '1 minute'
            or (x.status = 'SENDING' and x.claimed_at >= now() - interval '1 minute'));
    if n >= p_max_por_minuto then return jsonb_build_object('resultado', 'RATE_LIMIT_MINUTO'); end if;
  end if;

  update comunicacao_mensagens
     set status = 'SENDING', tentativas = tentativas + 1,
         claim_expira_em = now() + make_interval(secs => greatest(p_lease_segundos, 1)), updated_at = now()
   where id = p_id and status = 'PROCESSING' and claimed_by = p_worker and claim_geracao = p_claim_geracao
     and claim_expira_em > now() and tentativas < max_tentativas
  returning * into r;
  if not found then return jsonb_build_object('resultado', 'POSSE_PERDIDA'); end if;
  return jsonb_build_object('resultado', 'INICIADO', 'mensagem', to_jsonb(r));
end;
$$;
comment on function comunicacao_reservar_envio(uuid, text, bigint, integer, numeric, integer, integer, integer, timestamptz, integer) is
  'Reserva ATÔMICA (advisory lock) + PROCESSING -> SENDING. Limites separados: cooldown e cota diária POR DESTINATÁRIO; cota diária POR ORGANIZAÇÃO (alertas); taxa por minuto por ORGANIZAÇÃO e GLOBAL. Resultados: INICIADO | POSSE_PERDIDA | EXPIRADA | COOLDOWN | RATE_LIMIT_DIA | RATE_LIMIT_DIA_ORGANIZACAO | RATE_LIMIT_MINUTO_ORGANIZACAO | RATE_LIMIT_MINUTO.';
revoke all on function comunicacao_reservar_envio(uuid, text, bigint, integer, numeric, integer, integer, integer, timestamptz, integer) from public, anon, authenticated;
grant execute on function comunicacao_reservar_envio(uuid, text, bigint, integer, numeric, integer, integer, integer, timestamptz, integer) to service_role;

-- ---------------------------------------------------------------------
-- 9. HABILITAR a empresa (sem regras do piloto) e ENVIO AUTOMÁTICO (opt-in separado)
-- ---------------------------------------------------------------------
create or replace function comunicacao_habilitar_organizacao(p_organizacao_id uuid, p_ator_perfil_id uuid default null)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare h comunicacao_habilitacoes; v_ator uuid; v_tipo text; v_total integer := 0; v_eleg integer := 0; v_lista jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('comunicacao_habilitar:' || p_organizacao_id::text));
  select * into h from comunicacao_habilitacoes where organizacao_id = p_organizacao_id for update;
  if not found then return jsonb_build_object('acao', 'SEM_CONFIGURACAO'); end if;
  if h.habilitado then return jsonb_build_object('acao', 'JA_HABILITADA'); end if;
  if h.timezone is null then return jsonb_build_object('acao', 'TIMEZONE_AUSENTE'); end if;
  if coalesce(array_length(h.tipos_permitidos, 1), 0) = 0 then return jsonb_build_object('acao', 'TIPO_AUSENTE'); end if;

  foreach v_tipo in array h.tipos_permitidos loop
    v_lista := comunicacao_resolver_destinatarios(p_organizacao_id, v_tipo);
    v_total := greatest(v_total, jsonb_array_length(v_lista));
    v_eleg := v_eleg + (select count(*) from jsonb_array_elements(v_lista) e where (e->>'elegivel')::boolean);
  end loop;
  if v_total = 0 then return jsonb_build_object('acao', 'SEM_DESTINATARIO'); end if;
  if v_eleg = 0 then return jsonb_build_object('acao', 'DESTINATARIO_INELEGIVEL'); end if;

  select id into v_ator from perfis_operacionais where id = p_ator_perfil_id;
  -- habilitar NÃO liga o envio automático: são decisões separadas
  update comunicacao_habilitacoes set habilitado = true, atualizado_por = v_ator, updated_at = now() where organizacao_id = p_organizacao_id;
  return jsonb_build_object('acao', 'HABILITADA');
end;
$$;
comment on function comunicacao_habilitar_organizacao(uuid, uuid) is
  'Habilita a empresa (NÃO liga envio_automatico). Exige timezone, tipo permitido e ao menos um destinatário elegível. Recusas: SEM_CONFIGURACAO | JA_HABILITADA | TIMEZONE_AUSENTE | TIPO_AUSENTE | SEM_DESTINATARIO | DESTINATARIO_INELEGIVEL.';
revoke all on function comunicacao_habilitar_organizacao(uuid, uuid) from public, anon, authenticated;
grant execute on function comunicacao_habilitar_organizacao(uuid, uuid) to service_role;

-- a função do piloto vira um alias (regras "1 empresa" e "modo DISABLED" morreram)
create or replace function comunicacao_habilitar_organizacao_piloto(p_organizacao_id uuid, p_ator_perfil_id uuid default null)
returns jsonb
language sql
security invoker
set search_path = public
as $$ select comunicacao_habilitar_organizacao(p_organizacao_id, p_ator_perfil_id); $$;
revoke all on function comunicacao_habilitar_organizacao_piloto(uuid, uuid) from public, anon, authenticated;
grant execute on function comunicacao_habilitar_organizacao_piloto(uuid, uuid) to service_role;

create or replace function comunicacao_definir_envio_automatico(p_organizacao_id uuid, p_ligar boolean, p_ator_perfil_id uuid default null)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare h comunicacao_habilitacoes; v_ator uuid; v_tipo text; v_eleg integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('comunicacao_habilitar:' || p_organizacao_id::text));
  select * into h from comunicacao_habilitacoes where organizacao_id = p_organizacao_id for update;
  if not found then return jsonb_build_object('acao', 'SEM_CONFIGURACAO'); end if;
  select id into v_ator from perfis_operacionais where id = p_ator_perfil_id;

  if p_ligar is not true then
    if h.envio_automatico is not true then return jsonb_build_object('acao', 'JA_DESLIGADO'); end if;
    update comunicacao_habilitacoes set envio_automatico = false, envio_automatico_atualizado_em = now(), envio_automatico_atualizado_por = v_ator, atualizado_por = v_ator
     where organizacao_id = p_organizacao_id;
    return jsonb_build_object('acao', 'DESLIGADO');
  end if;

  if h.habilitado is not true then return jsonb_build_object('acao', 'EMPRESA_NAO_HABILITADA'); end if;
  if h.envio_automatico then return jsonb_build_object('acao', 'JA_LIGADO'); end if;
  foreach v_tipo in array coalesce(h.tipos_permitidos, '{}') loop
    v_eleg := v_eleg + (select count(*) from jsonb_array_elements(comunicacao_resolver_destinatarios(p_organizacao_id, v_tipo)) e where (e->>'elegivel')::boolean);
  end loop;
  if v_eleg = 0 then return jsonb_build_object('acao', 'SEM_DESTINATARIO_ELEGIVEL'); end if;
  update comunicacao_habilitacoes set envio_automatico = true, envio_automatico_atualizado_em = now(), envio_automatico_atualizado_por = v_ator, atualizado_por = v_ator
   where organizacao_id = p_organizacao_id;
  return jsonb_build_object('acao', 'LIGADO');
end;
$$;
comment on function comunicacao_definir_envio_automatico(uuid, boolean, uuid) is
  'Liga/desliga o envio automático da empresa. Desligar é sempre permitido. Ligar exige empresa habilitada e ao menos um destinatário elegível. Resultados: LIGADO | DESLIGADO | JA_LIGADO | JA_DESLIGADO | SEM_CONFIGURACAO | EMPRESA_NAO_HABILITADA | SEM_DESTINATARIO_ELEGIVEL.';
revoke all on function comunicacao_definir_envio_automatico(uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function comunicacao_definir_envio_automatico(uuid, boolean, uuid) to service_role;

-- ---------------------------------------------------------------------
-- 10. PÓS-CHECK: esta migration NÃO habilita ninguém nem liga envio automático
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from comunicacao_habilitacoes where envio_automatico) then
    raise exception 'migration 104: nenhuma empresa pode nascer com envio_automatico=true';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
