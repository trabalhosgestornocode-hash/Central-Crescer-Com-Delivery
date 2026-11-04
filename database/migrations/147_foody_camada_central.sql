-- 147 — Camada central Foody (PILOTO EM SOMBRA): conexão por unidade, execuções de sincronização, pedidos saneados e
-- fechamento logístico versionado.
--
-- ADITIVA: só cria tabelas/funções NOVAS com prefixo foody_. NÃO altera parser_fd_*, operacional_*, checklist, fechamentos,
-- Performance, Agente nem comunicação/WhatsApp. Nenhuma tabela existente ganha coluna, trigger ou FK nova.
-- Nesta fase NENHUM consumidor lê estas tabelas (o Parser, o Dashboard e o Checklist continuam com as fontes atuais).
--
-- 1. foody_conexoes — UMA conexão Foody por unidade. O token fica CIFRADO pela aplicação (AES-256-GCM com AAD amarrado à
--    unidade: um token cifrado para uma unidade não decifra em outra). O banco nunca vê o token em claro; `token_impressao`
--    é só um prefixo de SHA-256 para conferir "é o mesmo token?" sem revelá-lo.
-- 2. foody_sync_execucoes — prova de cobertura de cada sincronização (janela pedida, páginas, contagens, erro classificado).
-- 3. foody_pedidos — um registro por pedido Foody (upsert por unidade + uid), SEM dado pessoal: nada de cliente, telefone,
--    endereço, observações, link de rastreio nem nome de entregador (só um HMAC do nome, chave fora do banco).
--    Datas em HORA DE PAREDE de Brasília (timestamp sem fuso), igual ao Parser — não quebra a chave dos overrides.
-- 4. foody_fechamentos_logisticos — fechamento logístico diário VERSIONADO e IMUTÁVEL, em tabela PRÓPRIA (não usa
--    operacional_fechamentos: uma versão nova lá viraria REVISADO e poderia acionar aviso de correção no WhatsApp).
--    Gravação só pela função foody_fechamento_registrar (advisory lock por unidade+competência, idempotente).
--
-- SEGURANÇA: RLS ligado, NENHUMA policy, nenhum grant para anon/authenticated. service_role recebe só o necessário, inclusive
-- UPDATE em organizacao_id — exigido por remapear_organizacao_em_tabelas_de_unidade (transferência de unidade).
-- Funções de trigger próprias (foody_*), para que o rollback desta migration não dependa da 130 e vice-versa.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------------------------------------
-- Tenant: a unidade pertence à organização; a unidade de um registro nunca muda.
--
-- A pertença unidade ∈ organização é conferida no FIM DA TRANSAÇÃO (constraint trigger DEFERRABLE INITIALLY DEFERRED), contra o
-- estado de `unidades` naquele momento. Motivo: as duas operações que mudam a empresa de uma unidade fazem os passos em ORDENS
-- OPOSTAS — transferir_unidade_organizacao atualiza `unidades` e depois remapeia as tabelas; promover_unidade_para_empresa remapeia
-- as tabelas e só depois atualiza `unidades`. Uma checagem imediata quebraria a promoção; a checagem no commit aceita as duas e
-- continua recusando qualquer linha que termine a transação apontando para uma organização que não é a da unidade.
-- A imutabilidade da unidade é imediata (BEFORE), em foody_unidade_imutavel.
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function foody_validar_tenant() returns trigger
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from unidades u where u.id = new.unidade_id and u.organizacao_id = new.organizacao_id) then
    raise exception '%: a unidade % não pertence à organização %', tg_table_name, new.unidade_id, new.organizacao_id
      using errcode = '42501';
  end if;
  return null;
end $$;

create or replace function foody_unidade_imutavel() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.unidade_id is distinct from old.unidade_id then
    raise exception '%: a unidade de um registro não muda', tg_table_name using errcode = '42501';
  end if;
  return new;
end $$;

-- Registros filhos (pedido, fechamento) só podem apontar para uma execução da MESMA unidade. Compara só a unidade: a
-- organização já é garantida por foody_validar_tenant (a unidade pertence à organização) e comparar a organização aqui
-- quebraria a transferência de unidade, que remapeia organizacao_id tabela por tabela, em ordem alfabética.
create or replace function foody_validar_vinculo_execucao() returns trigger
language plpgsql set search_path = public as $$
declare
  col text := tg_argv[0];
  ref_id uuid;
begin
  ref_id := (to_jsonb(new) ->> col)::uuid;
  if ref_id is null then return new; end if;
  if not exists (select 1 from foody_sync_execucoes e where e.id = ref_id and e.unidade_id = new.unidade_id) then
    raise exception '%: % aponta para execução de outra unidade', tg_table_name, col using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Conexões (uma por unidade)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists foody_conexoes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  status text not null default 'PAUSADA' check (status in ('ATIVA', 'PAUSADA', 'REVOGADA', 'ERRO')),
  token_cifrado text not null check (token_cifrado ~ '^k[0-9]+:'),
  token_impressao text not null check (token_impressao ~ '^[0-9a-f]{12}$'),
  ponto_coleta_esperado text check (ponto_coleta_esperado is null or length(ponto_coleta_esperado) <= 120),
  ultimo_erro_codigo text check (ultimo_erro_codigo is null or ultimo_erro_codigo ~ '^[A-Z_]{2,40}$'),
  ultima_sync_em timestamptz,
  criado_por text,                                             -- id do usuário; nunca nome/e-mail
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint uq_foody_conexoes_unidade unique (unidade_id)
);
create index if not exists idx_foody_conexoes_tenant on foody_conexoes(organizacao_id, unidade_id);
-- Uma CONTA Foody (mesmo token) só pode estar ligada a UMA unidade não revogada. Sem isso, a mesma conta conectada à Subway e ao
-- Açaí (organizações diferentes) duplicaria cada pedido nas duas e gravaria dados de uma organização no tenant da outra.
create unique index if not exists uq_foody_conexoes_conta_ativa on foody_conexoes(token_impressao) where status <> 'REVOGADA';

drop trigger if exists trg_foody_conexoes_tenant on foody_conexoes;
create constraint trigger trg_foody_conexoes_tenant after insert or update on foody_conexoes
  deferrable initially deferred for each row execute function foody_validar_tenant();
drop trigger if exists trg_foody_conexoes_tenant_unidade on foody_conexoes;
create trigger trg_foody_conexoes_tenant_unidade before update on foody_conexoes
  for each row execute function foody_unidade_imutavel();

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Execuções de sincronização (prova de cobertura)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists foody_sync_execucoes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  conexao_id uuid not null references foody_conexoes(id) on delete cascade,
  competencia date not null,
  janela_inicio timestamptz not null,
  janela_fim timestamptz not null,
  origem text not null check (origem in ('manual', 'agendado', 'reprocessamento')),
  status text not null default 'EM_ANDAMENTO' check (status in ('EM_ANDAMENTO', 'CONCLUIDA', 'FALHOU')),
  paginas integer not null default 0 check (paginas >= 0),
  pedidos_recebidos integer not null default 0 check (pedidos_recebidos >= 0),
  pedidos_unicos integer not null default 0 check (pedidos_unicos >= 0),
  pedidos_fora_janela integer not null default 0 check (pedidos_fora_janela >= 0),
  pedidos_ponto_divergente integer not null default 0 check (pedidos_ponto_divergente >= 0),
  inseridos integer not null default 0 check (inseridos >= 0),
  atualizados integer not null default 0 check (atualizados >= 0),
  inalterados integer not null default 0 check (inalterados >= 0),
  erro_codigo text check (erro_codigo is null or erro_codigo ~ '^[A-Z_]{2,40}$'),
  regra_versao integer not null,
  iniciado_em timestamptz not null default now(),
  concluido_em timestamptz,
  constraint ck_foody_sync_janela check (janela_fim > janela_inicio)
);
create index if not exists idx_foody_sync_tenant on foody_sync_execucoes(organizacao_id, unidade_id, competencia desc, iniciado_em desc);

drop trigger if exists trg_foody_sync_tenant on foody_sync_execucoes;
create constraint trigger trg_foody_sync_tenant after insert or update on foody_sync_execucoes
  deferrable initially deferred for each row execute function foody_validar_tenant();
drop trigger if exists trg_foody_sync_tenant_unidade on foody_sync_execucoes;
create trigger trg_foody_sync_tenant_unidade before update on foody_sync_execucoes
  for each row execute function foody_unidade_imutavel();

-- A conexão usada pertence à mesma unidade da execução (a organização é garantida pela trigger de tenant; ver acima).
create or replace function foody_validar_conexao_execucao() returns trigger
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from foody_conexoes c where c.id = new.conexao_id and c.unidade_id = new.unidade_id) then
    raise exception 'foody_sync_execucoes: conexão de outra unidade' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_foody_sync_conexao on foody_sync_execucoes;
create trigger trg_foody_sync_conexao before insert or update on foody_sync_execucoes
  for each row execute function foody_validar_conexao_execucao();

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. Pedidos saneados (sem dado pessoal)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists foody_pedidos (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  foody_uid text not null check (length(foody_uid) between 1 and 80),
  numero_pedido text not null check (length(numero_pedido) between 1 and 40),
  competencia date not null,                                   -- dia (hora de parede de Brasília) de `data_hora`
  data_hora timestamp not null,                                -- hora de parede (sem fuso), igual ao Parser
  status_foody text not null check (length(status_foody) <= 40),
  situacao text not null check (length(situacao) <= 40),       -- vocabulário do relatório (Finalizado, Cancelado, ...)
  taxa_entregador numeric(10, 2) check (taxa_entregador is null or taxa_entregador >= 0),
  taxa_entrega numeric(10, 2),
  valor_total numeric(12, 2),
  forma_pagamento text check (forma_pagamento is null or length(forma_pagamento) <= 40),
  modo_despacho text check (modo_despacho is null or length(modo_despacho) <= 40),
  detalhes_pedido text check (detalhes_pedido is null or length(detalhes_pedido) <= 4000),
  operacao text not null check (operacao in ('subway', 'acai_no_grau', 'revisao_necessaria')),
  operacao_motivo text check (operacao_motivo is null or length(operacao_motivo) <= 500),
  entregador_presente boolean not null,
  entregador_hash text check (entregador_hash is null or entregador_hash ~ '^[0-9a-f]{16}$'),
  entregador_tipo text not null check (entregador_tipo in ('proprio', 'nao_classificado', 'sem_entregador')),
  entregador_tipo_bruto text check (entregador_tipo_bruto is null or length(entregador_tipo_bruto) <= 40),
  ponto_coleta text check (ponto_coleta is null or length(ponto_coleta) <= 120),
  data_aceito timestamp,
  data_pronto timestamp,
  data_despachado timestamp,
  data_coletado timestamp,
  data_entregue timestamp,
  data_finalizado timestamp,
  data_cancelado timestamp,
  prazo_entrega timestamp,
  cancelamento_razao text check (cancelamento_razao is null or length(cancelamento_razao) <= 80),
  cancelamento_justificativa text check (cancelamento_justificativa is null or length(cancelamento_justificativa) <= 300),
  fonte_hash text not null check (fonte_hash ~ '^[0-9a-f]{64}$'),
  primeira_execucao_id uuid not null references foody_sync_execucoes(id),
  ultima_execucao_id uuid not null references foody_sync_execucoes(id),
  sincronizado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint uq_foody_pedidos_uid unique (unidade_id, foody_uid),
  -- Pedido de OUTRA operação (outra organização, despachado por esta conta): só o mínimo logístico. Dados comerciais proibidos.
  constraint ck_foody_pedidos_outra_operacao_minima check (
    operacao in ('subway', 'revisao_necessaria')
    or (detalhes_pedido is null and valor_total is null and taxa_entrega is null and forma_pagamento is null
        and cancelamento_razao is null and cancelamento_justificativa is null)),
  constraint ck_foody_pedidos_entregador check (
    (entregador_presente and entregador_hash is not null and entregador_tipo <> 'sem_entregador')
    or (not entregador_presente and entregador_hash is null and entregador_tipo = 'sem_entregador'))
);
create index if not exists idx_foody_pedidos_competencia on foody_pedidos(organizacao_id, unidade_id, competencia);

drop trigger if exists trg_foody_pedidos_tenant on foody_pedidos;
create constraint trigger trg_foody_pedidos_tenant after insert or update on foody_pedidos
  deferrable initially deferred for each row execute function foody_validar_tenant();
drop trigger if exists trg_foody_pedidos_tenant_unidade on foody_pedidos;
create trigger trg_foody_pedidos_tenant_unidade before update on foody_pedidos
  for each row execute function foody_unidade_imutavel();
drop trigger if exists trg_foody_pedidos_exec1 on foody_pedidos;
create trigger trg_foody_pedidos_exec1 before insert or update on foody_pedidos
  for each row execute function foody_validar_vinculo_execucao('primeira_execucao_id');
drop trigger if exists trg_foody_pedidos_exec2 on foody_pedidos;
create trigger trg_foody_pedidos_exec2 before insert or update on foody_pedidos
  for each row execute function foody_validar_vinculo_execucao('ultima_execucao_id');

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. Fechamentos logísticos versionados (imutáveis)
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists foody_fechamentos_logisticos (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  competencia date not null,
  versao integer not null check (versao >= 1),
  status text not null check (status in ('PRELIMINAR', 'CONSOLIDADO', 'CORRIGIDO', 'INCOMPLETO')),
  estado_valores text not null check (estado_valores in ('SINCRONIZADO', 'PROVISORIO', 'CONCILIADO', 'CUSTO_REAL')),
  execucao_id uuid not null,
  sync_execucao_id uuid references foody_sync_execucoes(id),
  regra_versao integer not null,
  origem text not null check (origem in ('manual', 'agendado', 'reprocessamento')),
  gerado_por text,                                             -- id do usuário ou 'agendador'; nunca nome/e-mail
  motivo text check (motivo is null or length(motivo) <= 500),
  substitui_id uuid references foody_fechamentos_logisticos(id),
  cobertura jsonb not null,
  indicadores jsonb not null,
  outras_operacoes jsonb not null default '{}'::jsonb,         -- informativo: NUNCA somado ao custo da unidade
  pendencias jsonb not null default '[]'::jsonb,
  hash_conteudo text not null check (hash_conteudo ~ '^[0-9a-f]{64}$'),
  gerado_em timestamptz not null default now(),
  constraint uq_foody_fech_versao unique (unidade_id, competencia, versao),
  constraint uq_foody_fech_execucao unique (execucao_id)
);
create index if not exists idx_foody_fech_tenant on foody_fechamentos_logisticos(organizacao_id, unidade_id, competencia desc, versao desc);

drop trigger if exists trg_foody_fech_tenant on foody_fechamentos_logisticos;
create constraint trigger trg_foody_fech_tenant after insert or update on foody_fechamentos_logisticos
  deferrable initially deferred for each row execute function foody_validar_tenant();
drop trigger if exists trg_foody_fech_tenant_unidade on foody_fechamentos_logisticos;
create trigger trg_foody_fech_tenant_unidade before update on foody_fechamentos_logisticos
  for each row execute function foody_unidade_imutavel();
drop trigger if exists trg_foody_fech_exec on foody_fechamentos_logisticos;
create trigger trg_foody_fech_exec before insert or update on foody_fechamentos_logisticos
  for each row execute function foody_validar_vinculo_execucao('sync_execucao_id');

create or replace function foody_registro_imutavel() returns trigger
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

drop trigger if exists trg_foody_fech_imutavel on foody_fechamentos_logisticos;
create trigger trg_foody_fech_imutavel before update or delete on foody_fechamentos_logisticos
  for each row execute function foody_registro_imutavel();

/**
 * Registra uma versão do fechamento logístico. Serializa por unidade+competência (advisory lock da transação).
 * Resultados: JA_REGISTRADO (mesma execucao_id) · SEM_MUDANCA (mesmo conteúdo, status e estado) · REGISTRADO (versão nova).
 * Regras: depois de CONSOLIDADO/CORRIGIDO não existe PRELIMINAR; CORRIGIDO exige CONSOLIDADO/CORRIGIDO anterior E motivo;
 * INCOMPLETO pode ser registrado a qualquer momento.
 */
create or replace function foody_fechamento_registrar(
  p_organizacao_id uuid, p_unidade_id uuid, p_competencia date, p_status text, p_estado_valores text, p_execucao_id uuid,
  p_sync_execucao_id uuid, p_regra_versao integer, p_origem text, p_gerado_por text, p_motivo text,
  p_cobertura jsonb, p_indicadores jsonb, p_outras_operacoes jsonb, p_pendencias jsonb, p_hash text
) returns table (resultado text, fechamento_id uuid, versao_registrada integer, status_registrado text)
language plpgsql security definer set search_path = public as $$
declare
  ultima foody_fechamentos_logisticos%rowtype;
  existente foody_fechamentos_logisticos%rowtype;
  nova_versao integer;
  novo_id uuid;
begin
  if p_organizacao_id is null or p_unidade_id is null or p_competencia is null or p_execucao_id is null or p_hash is null then
    raise exception 'foody_fechamento_registrar: parâmetros obrigatórios ausentes' using errcode = '22023';
  end if;
  if p_status not in ('PRELIMINAR', 'CONSOLIDADO', 'CORRIGIDO', 'INCOMPLETO') then
    raise exception 'foody_fechamento_registrar: status inválido %', p_status using errcode = '22023';
  end if;
  if not exists (select 1 from unidades u where u.id = p_unidade_id and u.organizacao_id = p_organizacao_id) then
    raise exception 'foody_fechamento_registrar: unidade fora da organização' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('foody_fechamento:' || p_unidade_id::text || ':' || p_competencia::text, 0));

  select * into existente from foody_fechamentos_logisticos where execucao_id = p_execucao_id;
  if found then
    if existente.unidade_id <> p_unidade_id then
      raise exception 'foody_fechamento_registrar: execucao_id já usada por outra unidade' using errcode = '42501';
    end if;
    return query select 'JA_REGISTRADO'::text, existente.id, existente.versao, existente.status;
    return;
  end if;

  select * into ultima from foody_fechamentos_logisticos
   where unidade_id = p_unidade_id and competencia = p_competencia order by versao desc limit 1;

  if found and ultima.hash_conteudo = p_hash and ultima.status = p_status and ultima.estado_valores = p_estado_valores then
    return query select 'SEM_MUDANCA'::text, ultima.id, ultima.versao, ultima.status;
    return;
  end if;

  if found and ultima.status in ('CONSOLIDADO', 'CORRIGIDO') and p_status = 'PRELIMINAR' then
    raise exception 'foody_fechamento_registrar: competência já consolidada não volta a PRELIMINAR' using errcode = '22023';
  end if;
  if p_status = 'CORRIGIDO' then
    if not exists (select 1 from foody_fechamentos_logisticos f where f.unidade_id = p_unidade_id and f.competencia = p_competencia
                    and f.status in ('CONSOLIDADO', 'CORRIGIDO')) then
      raise exception 'foody_fechamento_registrar: CORRIGIDO exige uma versão CONSOLIDADO anterior' using errcode = '22023';
    end if;
    if coalesce(btrim(p_motivo), '') = '' then
      raise exception 'foody_fechamento_registrar: CORRIGIDO exige motivo' using errcode = '22023';
    end if;
  end if;

  nova_versao := coalesce(ultima.versao, 0) + 1;
  insert into foody_fechamentos_logisticos (
    organizacao_id, unidade_id, competencia, versao, status, estado_valores, execucao_id, sync_execucao_id, regra_versao, origem,
    gerado_por, motivo, substitui_id, cobertura, indicadores, outras_operacoes, pendencias, hash_conteudo
  ) values (
    p_organizacao_id, p_unidade_id, p_competencia, nova_versao, p_status, p_estado_valores, p_execucao_id, p_sync_execucao_id,
    p_regra_versao, p_origem, p_gerado_por, nullif(btrim(p_motivo), ''), ultima.id, p_cobertura, p_indicadores,
    coalesce(p_outras_operacoes, '{}'::jsonb), coalesce(p_pendencias, '[]'::jsonb), p_hash
  ) returning id into novo_id;

  return query select 'REGISTRADO'::text, novo_id, nova_versao, p_status;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- RLS e privilégios
-- ---------------------------------------------------------------------------------------------------------------------------
alter table foody_conexoes enable row level security;
alter table foody_sync_execucoes enable row level security;
alter table foody_pedidos enable row level security;
alter table foody_fechamentos_logisticos enable row level security;
-- NENHUMA policy: deny-all para anon/authenticated. Acesso só pelo backend.

do $$
declare
  fn_registrar constant text := 'foody_fechamento_registrar(uuid, uuid, date, text, text, uuid, uuid, integer, text, text, text, jsonb, jsonb, jsonb, jsonb, text)';
  t text;
  f text;
  papel text;
begin
  foreach papel in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if papel = 'public' or exists (select 1 from pg_roles where rolname = papel) then
      foreach t in array array['foody_conexoes', 'foody_sync_execucoes', 'foody_pedidos', 'foody_fechamentos_logisticos'] loop
        execute format('revoke all on table %I from %s', t, papel);
      end loop;
      foreach f in array array[fn_registrar, 'foody_validar_tenant()', 'foody_validar_vinculo_execucao()',
                               'foody_validar_conexao_execucao()', 'foody_registro_imutavel()', 'foody_unidade_imutavel()'] loop
        execute format('revoke all on function %s from %s', f, papel);
      end loop;
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- Conexões: o backend cria, lê e atualiza status/token (rotação). Sem DELETE: revogar = status REVOGADA.
    grant select, insert, update on table foody_conexoes to service_role;
    -- Execuções: abre (insert) e conclui (update). Sem DELETE: é a trilha de cobertura.
    grant select, insert, update on table foody_sync_execucoes to service_role;
    -- Pedidos: upsert por (unidade_id, foody_uid). Sem DELETE: pedido sumido da API vira pendência, não apagamento.
    grant select, insert, update on table foody_pedidos to service_role;
    -- Fechamentos: leitura + escrita SÓ pela função; UPDATE só de organizacao_id (transferência de unidade).
    grant select on table foody_fechamentos_logisticos to service_role;
    grant update (organizacao_id) on table foody_fechamentos_logisticos to service_role;
    execute format('grant execute on function %s to service_role', fn_registrar);
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
