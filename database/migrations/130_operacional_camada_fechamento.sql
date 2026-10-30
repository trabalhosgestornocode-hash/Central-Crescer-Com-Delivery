-- 130 — Dashboard Operacional 2.0: camada analítica derivada, fechamento diário versionado e simulações de WhatsApp.
--
-- ADITIVA: só cria tabelas/funções novas. NÃO altera ifood_eventos/ifood_pedidos, o poller nem o ACK.
--
-- 1. operacional_pedidos — PROJEÇÃO por pedido, SEM dado pessoal (nada de nome, telefone, documento, endereço, entregador,
--    código de coleta/entrega). Derivada de ifood_pedidos + ifood_eventos (já persistidos); reconstruível a qualquer momento a
--    partir do bruto (idempotente por `fonte_hash`). Escrita só pelo backend (service_role); leitura só pelo backend.
-- 2. operacional_projecao_cursor — onde o projetor incremental parou (por nome de execução).
-- 3. operacional_fechamentos — fechamento diário por unidade e competência, VERSIONADO e IMUTÁVEL: cada geração que muda o
--    conteúdo vira uma versão nova (nunca sobrescreve). Gravação só pela função operacional_fechamento_registrar, que serializa
--    por unidade+competência (advisory lock) e é idempotente por execucao_id e por conteúdo.
-- 4. operacional_mensagens_simuladas — histórico das SIMULAÇÕES de WhatsApp. `transporte` só aceita 'noop': a tabela não
--    consegue representar um envio real, e fica separada de comunicacao_mensagens (registros reais).
--
-- SEGURANÇA: RLS ligado, NENHUMA policy, nenhum grant para anon/authenticated. service_role recebe só o necessário, inclusive
-- UPDATE na coluna organizacao_id — exigido por remapear_organizacao_em_tabelas_de_unidade (transferência/promoção de unidade,
-- que atualiza toda tabela com organizacao_id + unidade_id como service_role).

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------------------------------------
-- Tenant: a unidade pertence à organização; a unidade nunca muda (a organização pode mudar só por transferência da unidade).
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function operacional_validar_tenant() returns trigger
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from unidades u where u.id = new.unidade_id and u.organizacao_id = new.organizacao_id) then
    raise exception '%: a unidade % não pertence à organização %', tg_table_name, new.unidade_id, new.organizacao_id
      using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.unidade_id is distinct from old.unidade_id then
    raise exception '%: a unidade de um registro não muda', tg_table_name using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Projeção por pedido
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists operacional_pedidos (
  order_id text primary key,                                   -- mesmo order_id de ifood_pedidos (único entre tenants)
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  chave text not null,                                         -- id opaco usado pela tela (o orderId não sai do servidor)
  merchant_id text not null,
  display_id text,
  order_type text,
  order_timing text,
  delivery_by text,
  delivery_mode text,
  sales_channel text,
  is_test boolean,
  status_oficial text,
  -- carimbos oficiais (createdAt do PRIMEIRO evento de cada código; nunca estimados)
  pedido_criado_em timestamptz,
  plc_em timestamptz, cfm_em timestamptz, prs_em timestamptz, rtp_em timestamptz,
  adr_em timestamptz, gto_em timestamptz, aao_em timestamptz, clt_em timestamptz,
  dsp_em timestamptz, aad_em timestamptz, con_em timestamptz, can_em timestamptz,
  preparo_recomendado_em timestamptz,                          -- Details preparationStartDateTime
  previsao_entrega_em timestamptz,                             -- Details delivery.deliveryDateTime
  -- cancelamento (metadata OFICIAL do CAN — nunca traduzido nem inferido)
  cancel_codigo text, cancel_descricao text, cancel_origem text, cancel_estagio text,
  -- valores OPERACIONAIS (Order Details; não são repasse)
  valor_itens numeric(12,2), valor_taxa_entrega numeric(12,2), valor_taxas_adicionais numeric(12,2),
  valor_descontos numeric(12,2), valor_total numeric(12,2),
  desconto_loja numeric(12,2), desconto_ifood numeric(12,2), desconto_rede numeric(12,2), desconto_externo numeric(12,2),
  cliente_pedidos_anteriores integer,                          -- customer.ordersCountOnMerchant (contagem, não identifica ninguém)
  itens_qtd integer,
  itens jsonb,                                                 -- lista saneada: nome, código PDV, qtd, valores, adicionais; SEM o texto das observações
  pagamento_metodos text[] not null default '{}',
  pagamento_na_entrega boolean,
  alteracoes integer not null default 0,                       -- eventos ORDER_PATCHED
  ultima_alteracao_em timestamptz,
  detalhes_desatualizados boolean not null default false,      -- houve ORDER_PATCHED depois da última busca dos detalhes
  eventos_qtd integer not null default 0,
  linha_do_tempo jsonb not null default '[]'::jsonb,           -- [{codigo, em, recebidoEm}] — sem metadata pessoal
  integridade jsonb not null default '[]'::jsonb,              -- [{codigo, mensagem}] problemas de dado (nunca escondidos)
  fonte jsonb not null default '{}'::jsonb,                    -- rastreabilidade: hash dos detalhes, último evento, contagem
  fonte_hash text not null,
  regra_versao integer not null,
  projetado_em timestamptz not null default now()
);
create unique index if not exists uq_operacional_pedidos_chave on operacional_pedidos(chave);
create index if not exists idx_operacional_pedidos_tenant_plc on operacional_pedidos(organizacao_id, unidade_id, plc_em);
create index if not exists idx_operacional_pedidos_tenant_con on operacional_pedidos(organizacao_id, unidade_id, con_em) where con_em is not null;
create index if not exists idx_operacional_pedidos_tenant_can on operacional_pedidos(organizacao_id, unidade_id, can_em) where can_em is not null;

drop trigger if exists trg_operacional_pedidos_tenant on operacional_pedidos;
create trigger trg_operacional_pedidos_tenant before insert or update on operacional_pedidos
  for each row execute function operacional_validar_tenant();

create table if not exists operacional_projecao_cursor (
  nome text primary key,
  ate timestamptz not null,
  atualizado_em timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. Fechamentos versionados
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists operacional_fechamentos (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  competencia date not null,
  versao integer not null check (versao >= 1),
  status text not null check (status in ('PRELIMINAR', 'CONSOLIDADO', 'REVISADO', 'INCOMPLETO')),
  execucao_id uuid not null,
  regra_versao integer not null,
  fuso text not null,
  fuso_origem text not null,
  origem text not null check (origem in ('manual', 'agendado', 'reprocessamento')),
  gerado_por text,                                             -- id do usuário (manual) ou 'agendador'; nunca nome/e-mail
  motivo text check (motivo is null or length(motivo) <= 500),
  substitui_id uuid references operacional_fechamentos(id),
  fonte jsonb not null,
  cobertura jsonb not null,
  indicadores jsonb not null,
  diagnostico jsonb not null,
  pendencias jsonb not null default '[]'::jsonb,
  hash_conteudo text not null,
  gerado_em timestamptz not null default now(),
  constraint uq_operacional_fechamentos_versao unique (unidade_id, competencia, versao),
  constraint uq_operacional_fechamentos_execucao unique (execucao_id)
);
create index if not exists idx_operacional_fechamentos_tenant on operacional_fechamentos(organizacao_id, unidade_id, competencia desc, versao desc);

drop trigger if exists trg_operacional_fechamentos_tenant on operacional_fechamentos;
create trigger trg_operacional_fechamentos_tenant before insert or update on operacional_fechamentos
  for each row execute function operacional_validar_tenant();

-- Imutável: nenhuma versão é apagada nem reescrita. Única exceção: organizacao_id, quando a UNIDADE é transferida de empresa
-- (remapear_organizacao_em_tabelas_de_unidade) — o conteúdo do fechamento continua idêntico.
create or replace function operacional_registro_imutavel() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception '% é somente inclusão (DELETE recusado).', tg_table_name using errcode = '42501';
  end if;
  if (to_jsonb(new) - 'organizacao_id') is distinct from (to_jsonb(old) - 'organizacao_id') then
    raise exception '% é somente inclusão: só organizacao_id muda (transferência de unidade).', tg_table_name using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_operacional_fechamentos_imutavel on operacional_fechamentos;
create trigger trg_operacional_fechamentos_imutavel before update or delete on operacional_fechamentos
  for each row execute function operacional_registro_imutavel();

/**
 * Registra uma versão de fechamento. Serializa por unidade+competência (advisory lock da transação).
 * Resultados:
 *   JA_REGISTRADO  — esta execucao_id já gravou (retentativa da mesma execução): devolve a versão gravada;
 *   SEM_MUDANCA    — a última versão tem o MESMO conteúdo e status: nada é criado (idempotência por conteúdo);
 *   REGISTRADO     — versão nova criada.
 * Regras de status:
 *   * depois de CONSOLIDADO/REVISADO não existe PRELIMINAR (o dia não "reabre");
 *   * REVISADO exige uma versão CONSOLIDADO/REVISADO anterior E motivo;
 *   * INCOMPLETO pode ser registrado a qualquer momento (dados ruins nunca viram "sem problemas").
 */
create or replace function operacional_fechamento_registrar(
  p_organizacao_id uuid, p_unidade_id uuid, p_competencia date, p_status text, p_execucao_id uuid,
  p_regra_versao integer, p_fuso text, p_fuso_origem text, p_origem text, p_gerado_por text, p_motivo text,
  p_fonte jsonb, p_cobertura jsonb, p_indicadores jsonb, p_diagnostico jsonb, p_pendencias jsonb, p_hash text
) returns table (resultado text, fechamento_id uuid, versao_registrada integer, status_registrado text)
language plpgsql security definer set search_path = public as $$
declare
  ultima operacional_fechamentos%rowtype;
  existente operacional_fechamentos%rowtype;
  nova_versao integer;
  novo_id uuid;
begin
  if p_organizacao_id is null or p_unidade_id is null or p_competencia is null or p_execucao_id is null or p_hash is null then
    raise exception 'operacional_fechamento_registrar: parâmetros obrigatórios ausentes' using errcode = '22023';
  end if;
  if p_status not in ('PRELIMINAR', 'CONSOLIDADO', 'REVISADO', 'INCOMPLETO') then
    raise exception 'operacional_fechamento_registrar: status inválido %', p_status using errcode = '22023';
  end if;
  if not exists (select 1 from unidades u where u.id = p_unidade_id and u.organizacao_id = p_organizacao_id) then
    raise exception 'operacional_fechamento_registrar: unidade fora da organização' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('operacional_fechamento:' || p_unidade_id::text || ':' || p_competencia::text, 0));

  select * into existente from operacional_fechamentos where execucao_id = p_execucao_id;
  if found then
    return query select 'JA_REGISTRADO'::text, existente.id, existente.versao, existente.status;
    return;
  end if;

  select * into ultima from operacional_fechamentos
   where unidade_id = p_unidade_id and competencia = p_competencia order by versao desc limit 1;

  if found and ultima.hash_conteudo = p_hash and ultima.status = p_status then
    return query select 'SEM_MUDANCA'::text, ultima.id, ultima.versao, ultima.status;
    return;
  end if;

  if found and ultima.status in ('CONSOLIDADO', 'REVISADO') and p_status = 'PRELIMINAR' then
    raise exception 'operacional_fechamento_registrar: competência já consolidada não volta a PRELIMINAR' using errcode = '22023';
  end if;
  if p_status = 'REVISADO' then
    if not exists (select 1 from operacional_fechamentos f where f.unidade_id = p_unidade_id and f.competencia = p_competencia
                    and f.status in ('CONSOLIDADO', 'REVISADO')) then
      raise exception 'operacional_fechamento_registrar: REVISADO exige uma versão CONSOLIDADO anterior' using errcode = '22023';
    end if;
    if coalesce(btrim(p_motivo), '') = '' then
      raise exception 'operacional_fechamento_registrar: REVISADO exige motivo' using errcode = '22023';
    end if;
  end if;

  nova_versao := coalesce(ultima.versao, 0) + 1;
  insert into operacional_fechamentos (
    organizacao_id, unidade_id, competencia, versao, status, execucao_id, regra_versao, fuso, fuso_origem, origem, gerado_por,
    motivo, substitui_id, fonte, cobertura, indicadores, diagnostico, pendencias, hash_conteudo
  ) values (
    p_organizacao_id, p_unidade_id, p_competencia, nova_versao, p_status, p_execucao_id, p_regra_versao, p_fuso, p_fuso_origem,
    p_origem, p_gerado_por, nullif(btrim(p_motivo), ''), ultima.id, p_fonte, p_cobertura, p_indicadores, p_diagnostico,
    coalesce(p_pendencias, '[]'::jsonb), p_hash
  ) returning id into novo_id;

  return query select 'REGISTRADO'::text, novo_id, nova_versao, p_status;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. Simulações de WhatsApp (nunca envio real)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists operacional_mensagens_simuladas (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  fechamento_id uuid not null references operacional_fechamentos(id),
  fechamento_versao integer not null,
  canal text not null default 'whatsapp' check (canal = 'whatsapp'),
  transporte text not null default 'noop' check (transporte = 'noop'),   -- a tabela NÃO representa envio real
  status text not null check (status in ('SIMULATED', 'READY_FOR_REVIEW', 'BLOCKED', 'ERROR')),
  chave_idempotencia text not null,
  mensagem text,
  tamanho integer,
  validacao jsonb not null default '{}'::jsonb,
  erro text check (erro is null or length(erro) <= 500),
  criado_por text,
  criado_em timestamptz not null default now(),
  constraint uq_operacional_mensagens_simuladas_chave unique (chave_idempotencia)
);
create index if not exists idx_operacional_msg_sim_tenant on operacional_mensagens_simuladas(organizacao_id, unidade_id, criado_em desc);
create index if not exists idx_operacional_msg_sim_fechamento on operacional_mensagens_simuladas(fechamento_id);

drop trigger if exists trg_operacional_msg_sim_tenant on operacional_mensagens_simuladas;
create trigger trg_operacional_msg_sim_tenant before insert or update on operacional_mensagens_simuladas
  for each row execute function operacional_validar_tenant();
drop trigger if exists trg_operacional_msg_sim_imutavel on operacional_mensagens_simuladas;
create trigger trg_operacional_msg_sim_imutavel before update or delete on operacional_mensagens_simuladas
  for each row execute function operacional_registro_imutavel();

-- ---------------------------------------------------------------------------------------------------------------------------
-- RLS e privilégios
-- ---------------------------------------------------------------------------------------------------------------------------
alter table operacional_pedidos enable row level security;
alter table operacional_projecao_cursor enable row level security;
alter table operacional_fechamentos enable row level security;
alter table operacional_mensagens_simuladas enable row level security;
-- NENHUMA policy: deny-all para anon/authenticated. Acesso só pelo backend.

do $$
declare
  fn_registrar constant text := 'operacional_fechamento_registrar(uuid, uuid, date, text, uuid, integer, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, text)';
  t text;
  papel text;
begin
  foreach papel in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if papel = 'public' or exists (select 1 from pg_roles where rolname = papel) then
      foreach t in array array['operacional_pedidos', 'operacional_projecao_cursor', 'operacional_fechamentos', 'operacional_mensagens_simuladas'] loop
        execute format('revoke all on table %I from %s', t, papel);
      end loop;
      execute format('revoke all on function %s from %s', fn_registrar, papel);
      execute format('revoke all on function operacional_validar_tenant() from %s', papel);
      execute format('revoke all on function operacional_registro_imutavel() from %s', papel);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- Projeção: derivada e reconstruível — o backend lê, insere, atualiza e pode apagar (reconstrução).
    grant select, insert, update, delete on table operacional_pedidos to service_role;
    grant select, insert, update on table operacional_projecao_cursor to service_role;
    -- Fechamentos: leitura + escrita SÓ pela função; UPDATE só da coluna organizacao_id (transferência de unidade).
    grant select on table operacional_fechamentos to service_role;
    grant update (organizacao_id) on table operacional_fechamentos to service_role;
    execute format('grant execute on function %s to service_role', fn_registrar);
    -- Simulações: inclusão (dedupe pela UNIQUE) + leitura; UPDATE só de organizacao_id.
    grant select, insert on table operacional_mensagens_simuladas to service_role;
    grant update (organizacao_id) on table operacional_mensagens_simuladas to service_role;
  end if;
end $$;

commit;
