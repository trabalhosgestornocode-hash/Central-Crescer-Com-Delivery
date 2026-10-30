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

begin;
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

commit;

-- VERIFICAÇÃO (só leitura): select comunicacao_selecao_por_escopo_ligada();  -- false (nada foi ativado)
-- select count(*) from comunicacao_legado_snapshot;                           -- 0
