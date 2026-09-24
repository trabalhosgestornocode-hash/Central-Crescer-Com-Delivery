-- =====================================================================
-- MIGRATION 096 — Central de Comunicação: conversas com responsáveis autorizados
-- =====================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO SEM APROVAÇÃO EXPLÍCITA. Escrita para o redesign da Central (aba Conversas); nunca aplicada em banco algum por
--     quem a escreveu. Depende da 082 (contatos), da 060 (perfis operacionais / perfil_id nos vínculos) e da 090 (inbound técnico).
-- ✅  Puramente ADITIVA: 1 view, 2 tabelas, 3 funções e 3 colunas nullable. NÃO altera comunicacao_mensagens (outbox), o claim, os recibos (095)
--     nem whatsapp_inbound_mensagens (090).
--
-- POR QUE UMA TABELA PRÓPRIA DE CONTEÚDO (e NÃO a 090)
--   A 090 é o LIVRO-RAZÃO técnico do inbound e foi desenhada SEM conteúdo, de propósito. O chat precisa do texto — mas SÓ de responsáveis
--   cadastrados. `comunicacao_inbox_mensagens` guarda texto exclusivamente de contatos que a view `comunicacao_roster_autorizado` reconhece; o
--   backend resolve o contato ANTES de gravar e descarta o resto (número desconhecido nunca chega aqui: sem linha, sem conversa, sem busca).
--
-- PRIVACIDADE
--   * Texto retido por p_retencao_dias (padrão 30) — purga OPORTUNISTA dentro da própria função de registro (sem job novo, em lotes limitados).
--   * Mídia: só o TIPO é registrado (tipo_conteudo='midia'), nunca o binário nem legenda. Grupo/status/broadcast/newsletter: nunca chegam aqui.
--   * RLS ligado e privilégios de anon/authenticated revogados (padrão 082/090): só o service_role do backend acessa.
--
-- ROLLBACK: 096_rollback.sql.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. FOTO DE PERFIL (cache de metadado, nunca o binário)
-- ---------------------------------------------------------------------
alter table contatos_whatsapp add column if not exists foto_url text;
alter table contatos_whatsapp add column if not exists foto_atualizada_em timestamptz;
-- Quando a foto não existe / a privacidade do contato a esconde: não perguntar de novo ao WhatsApp antes deste instante.
alter table contatos_whatsapp add column if not exists foto_indisponivel_ate timestamptz;

comment on column contatos_whatsapp.foto_url is
  'URL da foto de perfil informada pelo WhatsApp (expira). Cache — a ausência NUNCA quebra a interface (avatar com iniciais).';

-- ---------------------------------------------------------------------
-- 2. ROSTER AUTORIZADO — fonte ÚNICA de "quem a Central reconhece"
-- ---------------------------------------------------------------------
-- Um contato é AUTORIZADO se tem vínculo ATIVO com um perfil operacional ATIVO que, por sua vez, tem vínculo ATIVO com uma organização.
-- Unidades entram quando há vínculo direto (usuarios_unidades) ou, na falta dele, por herança da organização (todas as unidades ativas).
-- Um telefone ligado a várias unidades aparece em várias linhas — a Central agrupa por contato_id (UMA conversa).
create or replace view comunicacao_roster_autorizado
with (security_invoker = true) as
select
  c.id                      as contato_id,
  c.telefone_e164,
  c.consentimento,
  c.verificado,
  c.opt_out,
  po.id                     as perfil_id,
  po.nome                   as perfil_nome,
  o.id                      as organizacao_id,
  o.nome                    as organizacao_nome,
  uo.papel::text            as papel,
  un.id                     as unidade_id,
  un.nome                   as unidade_nome
from contatos_whatsapp c
join contatos_whatsapp_perfis cp on cp.contato_id = c.id and cp.ativo
join perfis_operacionais po      on po.id = cp.perfil_operacional_id and po.ativo
join usuarios_organizacoes uo    on uo.perfil_id = po.id and uo.ativo
join organizacoes o              on o.id = uo.organizacao_id
left join unidades un            on un.organizacao_id = o.id and un.ativo
                                 and (
                                   exists (select 1 from usuarios_unidades uu where uu.perfil_id = po.id and uu.unidade_id = un.id and uu.ativo)
                                   or not exists (select 1 from usuarios_unidades uu2 join unidades u2 on u2.id = uu2.unidade_id
                                                   where uu2.perfil_id = po.id and u2.organizacao_id = o.id and uu2.ativo)
                                 );

comment on view comunicacao_roster_autorizado is
  'Central de Comunicação: contatos que a Central reconhece (responsáveis cadastrados). Fonte única — inbound, lista de conversas e envio manual leem daqui.';

revoke all on comunicacao_roster_autorizado from public, anon, authenticated;
grant select on comunicacao_roster_autorizado to service_role;

-- ---------------------------------------------------------------------
-- 3. MENSAGENS RECEBIDAS (conteúdo, SÓ de autorizados)
-- ---------------------------------------------------------------------
create table if not exists comunicacao_inbox_mensagens (
  id                   uuid primary key default gen_random_uuid(),
  -- organização da CONEXÃO do WhatsApp (mesma semântica da 090), vinda da config do backend — nunca do payload.
  organizacao_id       uuid not null references organizacoes(id) on delete cascade,
  contato_id           uuid not null references contatos_whatsapp(id) on delete cascade,
  provider_message_id  text not null,
  origem_tipo          text not null,
  tipo_conteudo        text not null,
  texto                text,
  recebido_em          timestamptz not null,
  created_at           timestamptz not null default now(),

  constraint comunicacao_inbox_unico unique (organizacao_id, provider_message_id),
  constraint comunicacao_inbox_id_formato check (provider_message_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  -- OFFLINE_RECOVERY nunca entra na Central (recovery segue desligado e em quarentena).
  constraint comunicacao_inbox_origem check (origem_tipo in ('LIVE', 'OFFLINE_NORMAL')),
  constraint comunicacao_inbox_tipo check (tipo_conteudo in ('texto', 'midia', 'outro')),
  constraint comunicacao_inbox_texto_coerente check (
    (tipo_conteudo = 'texto' and texto is not null and char_length(texto) between 1 and 4096)
    or (tipo_conteudo <> 'texto' and texto is null)
  )
);

comment on table comunicacao_inbox_mensagens is
  'Central de Comunicação: mensagens recebidas de responsáveis CADASTRADOS. Nunca contém número desconhecido, grupo, status, broadcast ou newsletter. Retenção limitada (purga oportunista).';

create index if not exists idx_comunicacao_inbox_contato on comunicacao_inbox_mensagens (contato_id, recebido_em desc);
create index if not exists idx_comunicacao_inbox_org_tempo on comunicacao_inbox_mensagens (organizacao_id, recebido_em desc);

alter table comunicacao_inbox_mensagens enable row level security;
revoke all on comunicacao_inbox_mensagens from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. LEITURA POR CONVERSA (caixa de entrada compartilhada da equipe)
-- ---------------------------------------------------------------------
-- Por (organização da CONEXÃO, contato): duas conexões/organizações nunca compartilham o estado "lida".
create table if not exists comunicacao_inbox_leituras (
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  contato_id  uuid not null references contatos_whatsapp(id) on delete cascade,
  lida_ate    timestamptz not null,
  lida_por    uuid references perfis_operacionais(id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (organizacao_id, contato_id)
);

alter table comunicacao_inbox_leituras enable row level security;
revoke all on comunicacao_inbox_leituras from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. REGISTRO IDEMPOTENTE + PURGA OPORTUNISTA
-- ---------------------------------------------------------------------
create or replace function comunicacao_inbox_registrar(
  p_organizacao_id uuid,
  p_contato_id uuid,
  p_provider_message_id text,
  p_origem_tipo text,
  p_tipo_conteudo text,
  p_texto text,
  p_recebido_em timestamptz,
  p_retencao_dias integer default 30
) returns table (inserido boolean, id uuid)
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Defesa em profundidade (o backend já resolve o contato pelo roster ANTES de chamar): o banco também recusa gravar texto de quem NÃO é
  -- responsável cadastrado (contato sem perfil, perfil/vínculo inativo). Fail-closed. Atenção: p_organizacao_id é a organização da CONEXÃO do
  -- WhatsApp (a Crescer), NÃO a do responsável — os responsáveis pertencem às organizações-cliente do roster; por isso a checagem é "está no roster".
  if not exists (select 1 from comunicacao_roster_autorizado r where r.contato_id = p_contato_id) then
    raise exception 'contato nao autorizado' using errcode = 'P0001';
  end if;

  insert into comunicacao_inbox_mensagens as m (
    organizacao_id, contato_id, provider_message_id, origem_tipo, tipo_conteudo, texto, recebido_em
  ) values (
    p_organizacao_id, p_contato_id, p_provider_message_id, p_origem_tipo, p_tipo_conteudo, p_texto, p_recebido_em
  )
  on conflict (organizacao_id, provider_message_id) do nothing
  returning m.id into v_id;

  -- Purga oportunista, em lote pequeno e indexado: nenhum job novo; o custo é proporcional ao que expirou.
  delete from comunicacao_inbox_mensagens d
   where d.id in (
     select x.id from comunicacao_inbox_mensagens x
      where x.organizacao_id = p_organizacao_id
        and x.recebido_em < now() - make_interval(days => greatest(coalesce(p_retencao_dias, 30), 1))
      limit 200
   );

  if v_id is not null then
    return query select true, v_id;
  else
    return query select false, x.id from comunicacao_inbox_mensagens x
      where x.organizacao_id = p_organizacao_id and x.provider_message_id = p_provider_message_id;
  end if;
end;
$$;

-- Marca a conversa como lida até um instante (nunca retrocede).
create or replace function comunicacao_inbox_marcar_lida(p_organizacao_id uuid, p_contato_id uuid, p_ate timestamptz, p_por uuid default null)
returns void
language sql
set search_path = public
as $$
  insert into comunicacao_inbox_leituras (organizacao_id, contato_id, lida_ate, lida_por)
  values (p_organizacao_id, p_contato_id, p_ate, p_por)
  on conflict (organizacao_id, contato_id) do update
    set lida_ate = greatest(comunicacao_inbox_leituras.lida_ate, excluded.lida_ate),
        lida_por = excluded.lida_por,
        updated_at = now();
$$;

-- Resumo por conversa: última recebida (com a prévia), quantas ainda não foram lidas.
create or replace function comunicacao_inbox_resumo(p_organizacao_id uuid, p_retencao_dias integer default 30)
returns table (contato_id uuid, nao_lidas integer, ultima_recebida_em timestamptz, ultima_texto text, ultimo_tipo text)
language sql
stable
set search_path = public
as $$
  select m.contato_id,
         count(*) filter (where l.lida_ate is null or m.recebido_em > l.lida_ate)::integer as nao_lidas,
         max(m.recebido_em) as ultima_recebida_em,
         (array_agg(m.texto order by m.recebido_em desc))[1] as ultima_texto,
         (array_agg(m.tipo_conteudo order by m.recebido_em desc))[1] as ultimo_tipo
    from comunicacao_inbox_mensagens m
    left join comunicacao_inbox_leituras l on l.organizacao_id = m.organizacao_id and l.contato_id = m.contato_id
   where m.organizacao_id = p_organizacao_id
     -- o texto vencido nunca aparece, mesmo antes de a purga rodar
     and m.recebido_em >= now() - make_interval(days => greatest(coalesce(p_retencao_dias, 30), 1))
   group by m.contato_id;
$$;

-- Purga PERIÓDICA (chamada pelo backend em intervalo fixo, independente de haver tráfego novo e independente do worker de automação).
-- Apaga só texto/marcadores VENCIDOS da caixa de entrada; devolve quantas linhas removeu (nunca conteúdo). Em lotes limitados.
create or replace function comunicacao_inbox_purgar(p_retencao_dias integer default 30, p_limite integer default 5000)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_n integer;
begin
  with vencidas as (
    select x.id from comunicacao_inbox_mensagens x
     where x.recebido_em < now() - make_interval(days => greatest(coalesce(p_retencao_dias, 30), 1))
     order by x.recebido_em
     limit greatest(least(coalesce(p_limite, 5000), 20000), 1)
  ), apagadas as (
    delete from comunicacao_inbox_mensagens d using vencidas v where d.id = v.id returning 1
  )
  select count(*)::integer into v_n from apagadas;
  return v_n;
end;
$$;

revoke all on function comunicacao_inbox_registrar(uuid, uuid, text, text, text, text, timestamptz, integer) from public, anon, authenticated;
revoke all on function comunicacao_inbox_marcar_lida(uuid, uuid, timestamptz, uuid) from public, anon, authenticated;
revoke all on function comunicacao_inbox_resumo(uuid, integer) from public, anon, authenticated;
revoke all on function comunicacao_inbox_purgar(integer, integer) from public, anon, authenticated;
grant execute on function comunicacao_inbox_registrar(uuid, uuid, text, text, text, text, timestamptz, integer) to service_role;
grant execute on function comunicacao_inbox_marcar_lida(uuid, uuid, timestamptz, uuid) to service_role;
grant execute on function comunicacao_inbox_resumo(uuid, integer) to service_role;
grant execute on function comunicacao_inbox_purgar(integer, integer) to service_role;

commit;

-- ---------------------------------------------------------------------
-- VERIFICAÇÃO pós-aplicação (rodar em TESTE primeiro):
--   select count(*) from comunicacao_roster_autorizado;                                                        -- só responsáveis cadastrados
--   select relrowsecurity from pg_class where relname in ('comunicacao_inbox_mensagens','comunicacao_inbox_leituras'); -- true, true
--   select grantee from information_schema.role_table_grants where table_name in ('comunicacao_inbox_mensagens','comunicacao_inbox_leituras','comunicacao_roster_autorizado')
--     and grantee in ('anon','authenticated','PUBLIC');                                                        -- 0 linhas
--   -- texto em mídia deve FALHAR (23514): insert ... tipo_conteudo='midia', texto='x' ...
-- ---------------------------------------------------------------------
