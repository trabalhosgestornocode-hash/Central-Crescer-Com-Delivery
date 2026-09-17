-- =====================================================================
-- MIGRATION 082 — Comunicação WhatsApp: fundação (Checkpoint B)
-- =====================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO SEM APROVAÇÃO EXPLÍCITA.
--
-- OBJETIVO
--   Base de dados do módulo de comunicação via WhatsApp (Checkpoint A/B do
--   plano aprovado): fila persistente de envio com claim atômico, alertas
--   deduplicados a partir das pendências já calculadas pelo Painel
--   Administrativo (dashboard_ifood/D-1 — ver administrativo.status.js),
--   contatos desacoplados de perfil (um telefone pode estar ligado a mais
--   de um perfil operacional), e configuração central (modo/janelas/
--   cooldowns) editável sem redeploy.
--
--   Esta migration é SÓ SCHEMA ADITIVO. Nenhuma tabela existente é alterada.
--   NÃO reaproveita `alertas`/`notificacoes` (schema base, mortas, sem
--   organizacao_id — decisão registrada no Checkpoint A) nem estende
--   `agente_conversas` (decisão do Checkpoint B — ver seção 5 abaixo).
--
--   NÃO conecta Baileys, não cria QR, não abre socket. Isso é Checkpoint C.
--
-- POR QUE TELEFONE NÃO É PERFIL (ajuste aprovado do Checkpoint A)
--   `contatos_whatsapp` é a PESSOA-COM-TELEFONE; `contatos_whatsapp_perfis`
--   é o vínculo N:N com `perfis_operacionais`. Um número pode legitimamente
--   representar mais de um perfil (ex.: dono que também opera uma unidade
--   como gerente) — a escolha de QUAL perfil vale para uma conversa é
--   sempre uma decisão explícita da camada de resolução (Checkpoint F),
--   nunca um `LIMIT 1` silencioso. O telefone NUNCA autentica por si só.
--
-- POR QUE `UNIQUE NULLS NOT DISTINCT` (ajuste aprovado — dedup real)
--   A chave lógica de um alerta é (organizacao_id, unidade_id, tipo_alerta,
--   data_referencia, destinatario_perfil_id). `unidade_id` e
--   `destinatario_perfil_id` são NULLABLE (nem toda pendência tem unidade
--   sozinha nem destinatário resolvido no momento da detecção). Uma UNIQUE
--   comum trata cada NULL como distinto — duas linhas com a MESMA
--   organização e tipo, ambas com unidade_id NULL, passariam pela
--   constraint como se fossem diferentes (é o mesmo defeito já conhecido
--   no projeto em `martin_brower_filtros`, registrado em memória). Postgres
--   15+ resolve isso nativamente com `NULLS NOT DISTINCT`.
--   PRÉ-CHECK OBRIGATÓRIO antes de aplicar: `select version();` — se o
--   Postgres for < 15, PARE e avise (a sintaxe abaixo falha na criação da
--   constraint, a migration inteira faz rollback — nada fica pela metade).
--
-- POR QUE CLAIM ATÔMICO VIA FUNÇÃO (mesmo padrão da migration 067)
--   `comunicacao_claim_mensagens` usa `FOR UPDATE SKIP LOCKED` dentro de uma
--   função SQL de uma instrução só (CTE + UPDATE + RETURNING) — dois
--   workers chamando ao mesmo tempo nunca reivindicam a mesma linha; um
--   worker que reinicia no meio de um lote simplesmente não devolve nada
--   para as linhas já reivindicadas por outro. SEM isto, um
--   "SELECT próximo -> depois UPDATE" feito em dois passos separados do
--   Node teria uma janela de corrida entre as duas chamadas.
--
-- POR QUE NENHUM `setInterval`/poller AQUI (ajuste aprovado)
--   O Checkpoint A concluiu que o serviço web atual do Render não deve ser
--   tratado como worker persistente confiável. Esta migration só cria a
--   TABELA e a FUNÇÃO de claim — quem chama `comunicacao_claim_mensagens`
--   em loop é o processo persistente do Checkpoint C, ainda não decidido.
--
-- ESCOPO DO PRIMEIRO MONITOR (ajuste aprovado)
--   `tipo_alerta` desta fase é SOMENTE 'dashboard_ifood_d1' (o motor D-1 do
--   Painel Administrativo). O campo é `text` livre (não enum) para não
--   exigir uma migration nova quando outro monitor for ligado — mas o
--   CÓDIGO da Fase 1 (comunicacao.alertas.service.js) só gera esse valor.
--
-- PRÉ-REQUISITOS: migrations 000 (organizacoes/unidades), 060
--   (perfis_operacionais), 048 (agente_conversas) aplicadas.
-- TRANSACIONAL: todo o arquivo roda em uma transação.
-- IDEMPOTENTE: reexecutável com segurança (if not exists / on conflict).
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
--   NÃO executar automaticamente em produção. NÃO rodar contra o banco de
--   produção sem aprovação explícita.
-- ROLLBACK: database/migrations/082_rollback.sql.
-- =====================================================================

-- =====================================================================
-- PRÉ-CHECK OBRIGATÓRIO (execute isoladamente ANTES; nada aqui escreve)
-- =====================================================================
--   select version();                                    -- precisa ser PG >= 15
--   select to_regclass('public.comunicacao_alertas');     -- precisa ser NULL (ainda não existe)
--   select to_regprocedure('public.set_updated_at()');    -- precisa existir (migration 000)
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. CONTATOS (a pessoa-com-telefone — nunca um perfil por si só)
-- ---------------------------------------------------------------------
create table if not exists contatos_whatsapp (
  id                 uuid primary key default gen_random_uuid(),
  telefone_e164      text not null,
  ddi                text,
  ddd                text,
  verificado         boolean not null default false,
  verificado_em      timestamptz,
  consentimento      boolean not null default false,
  consentimento_em   timestamptz,
  opt_out            boolean not null default false,
  opt_out_em         timestamptz,
  preferencias       jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint contatos_whatsapp_telefone_formato check (telefone_e164 ~ '^\+[1-9][0-9]{7,14}$')
);

comment on table contatos_whatsapp is
  'CONTATO (a pessoa com um telefone), nunca um perfil por si só. O telefone identifica, não autentica nem autoriza — ver contatos_whatsapp_perfis para o vínculo (N:N) com perfis_operacionais.';
comment on column contatos_whatsapp.telefone_e164 is
  'E.164 completo (+DDI DDD número), único. Fonte de verdade do telefone.';
comment on column contatos_whatsapp.opt_out is
  'true = a pessoa pediu para parar de receber mensagens proativas. Nunca reativado automaticamente.';

create unique index if not exists ux_contatos_whatsapp_telefone on contatos_whatsapp (telefone_e164);

drop trigger if exists trg_contatos_whatsapp_upd on contatos_whatsapp;
create trigger trg_contatos_whatsapp_upd before update on contatos_whatsapp
  for each row execute function set_updated_at();

alter table contatos_whatsapp enable row level security;
revoke all on contatos_whatsapp from authenticated, anon;


-- ---------------------------------------------------------------------
-- 2. VÍNCULO contato <-> perfil operacional (N:N — ajuste aprovado)
-- ---------------------------------------------------------------------
create table if not exists contatos_whatsapp_perfis (
  id                     uuid primary key default gen_random_uuid(),
  contato_id             uuid not null references contatos_whatsapp(id) on delete cascade,
  perfil_operacional_id  uuid not null references perfis_operacionais(id) on delete cascade,
  ativo                  boolean not null default true,
  -- Sinal de UX ("provável perfil"), NUNCA autoridade — a resolução (Checkpoint
  -- F) sempre revalida o vínculo contra a organização/unidade do contexto real;
  -- `principal` nunca escolhe sozinho um contexto sensível (teste 20).
  principal              boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint contatos_whatsapp_perfis_par_unico unique (contato_id, perfil_operacional_id)
);

comment on table contatos_whatsapp_perfis is
  'Vínculo N:N entre um contato (telefone) e os perfis operacionais que ele pode representar. Um telefone pode estar ligado a mais de um perfil (ex.: dono que também opera como gerente). A escolha de qual perfil vale numa conversa é sempre explícita — nunca um LIMIT 1 silencioso.';
comment on column contatos_whatsapp_perfis.principal is
  'Sinal de UX (qual perfil sugerir primeiro), nunca autorização. A resolução de contexto sempre revalida contra organização/unidade reais.';

-- No máximo 1 vínculo "principal" por contato — índice único PARCIAL (só
-- conta as linhas com principal = true; várias linhas com principal = false
-- convivem normalmente).
create unique index if not exists ux_contatos_whatsapp_perfis_principal
  on contatos_whatsapp_perfis (contato_id) where principal;

create index if not exists idx_contatos_whatsapp_perfis_perfil
  on contatos_whatsapp_perfis (perfil_operacional_id);

drop trigger if exists trg_contatos_whatsapp_perfis_upd on contatos_whatsapp_perfis;
create trigger trg_contatos_whatsapp_perfis_upd before update on contatos_whatsapp_perfis
  for each row execute function set_updated_at();

alter table contatos_whatsapp_perfis enable row level security;
revoke all on contatos_whatsapp_perfis from authenticated, anon;


-- ---------------------------------------------------------------------
-- 3. ALERTAS (pendência detectada -> ciclo de vida da comunicação)
-- ---------------------------------------------------------------------
create table if not exists comunicacao_alertas (
  id                       uuid primary key default gen_random_uuid(),
  organizacao_id           uuid not null references organizacoes(id) on delete cascade,
  unidade_id               uuid references unidades(id) on delete cascade,
  tipo_alerta              text not null,
  data_referencia          date not null,
  destinatario_perfil_id   uuid references perfis_operacionais(id) on delete set null,
  -- Reaproveita o vocabulário de administrativo.status.js#ROLLUP — nunca uma
  -- segunda classificação paralela.
  severidade               text not null check (severidade in ('atencao', 'critico')),
  status                   text not null default 'DETECTED' check (status in (
    'DETECTED', 'SCHEDULED', 'PROCESSING', 'SENT', 'DELIVERED', 'READ',
    'RESPONDED', 'RESOLVED', 'CANCELLED', 'BLOCKED', 'FAILED'
  )),
  motivo                   text,
  detectado_em             timestamptz not null default now(),
  resolvido_em             timestamptz,
  cancelado_em             timestamptz,
  motivo_cancelamento      text,
  metadados                jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- Dedup real (ajuste aprovado): NULLS NOT DISTINCT cobre unidade_id E
  -- destinatario_perfil_id nulos sem abrir brecha de duplicidade lógica.
  -- Requer Postgres 15+ (ver PRÉ-CHECK no topo do arquivo).
  constraint comunicacao_alertas_chave_unica
    unique nulls not distinct (organizacao_id, unidade_id, tipo_alerta, data_referencia, destinatario_perfil_id)
);

comment on table comunicacao_alertas is
  'Um alerta por ocorrência real de pendência (chave lógica com dedup garantido no banco, não só em código). Ciclo de vida: DETECTED -> SCHEDULED -> PROCESSING -> SENT -> ... -> RESOLVED/CANCELLED/BLOCKED/FAILED. Nunca recalcula a regra de pendência — só reflete o que administrativo.status.js já decidiu.';
comment on column comunicacao_alertas.tipo_alerta is
  'Fase 1: SOMENTE "dashboard_ifood_d1" (monitor D-1 do Painel Administrativo). Texto livre para não exigir migration ao ligar outro monitor, mas o código desta fase só gera este valor.';
comment on column comunicacao_alertas.destinatario_perfil_id is
  'Perfil resolvido para receber a mensagem. NULLABLE — pode não haver contato/perfil resolvido no momento da detecção (fica DETECTED até a resolução acontecer).';

create index if not exists idx_comunicacao_alertas_organizacao on comunicacao_alertas (organizacao_id);
create index if not exists idx_comunicacao_alertas_ativos
  on comunicacao_alertas (unidade_id, tipo_alerta)
  where status not in ('RESOLVED', 'CANCELLED');

drop trigger if exists trg_comunicacao_alertas_upd on comunicacao_alertas;
create trigger trg_comunicacao_alertas_upd before update on comunicacao_alertas
  for each row execute function set_updated_at();

alter table comunicacao_alertas enable row level security;
revoke all on comunicacao_alertas from authenticated, anon;


-- ---------------------------------------------------------------------
-- 4. MENSAGENS (a fila real de envio — o que o claim processa)
-- ---------------------------------------------------------------------
create table if not exists comunicacao_mensagens (
  id                       uuid primary key default gen_random_uuid(),
  alerta_id                uuid references comunicacao_alertas(id) on delete cascade,
  organizacao_id           uuid not null references organizacoes(id) on delete cascade,
  unidade_id               uuid references unidades(id) on delete cascade,
  contato_id               uuid references contatos_whatsapp(id) on delete set null,
  destinatario_perfil_id   uuid references perfis_operacionais(id) on delete set null,
  canal                    text not null default 'whatsapp',
  direcao                  text not null default 'saida' check (direcao in ('saida', 'entrada')),
  tipo                     text not null,
  conteudo                 text not null,
  -- Idempotência real (ajuste aprovado): gerada UMA VEZ no agendamento,
  -- nunca regenerada num retry. Um retry do MESMO job nunca cria um
  -- segundo envio lógico — a UNIQUE abaixo garante isso no banco.
  idempotency_key          text not null,
  -- SENDING é o estado-chave do Checkpoint B.1 (ajuste 5/6): gravado ANTES
  -- de chamar o provider, para que um crash a meio do envio deixe um
  -- rastro durável. DELIVERY_UNKNOWN é para onde um SENDING vai se o lease
  -- expirar sem resolução — NUNCA volta sozinho para SCHEDULED (isso seria
  -- reenvio cego de algo que pode já ter chegado ao WhatsApp).
  status                   text not null default 'SCHEDULED' check (status in (
    'SCHEDULED', 'PROCESSING', 'SENDING', 'SENT', 'DELIVERED', 'READ',
    'DELIVERY_UNKNOWN', 'FAILED', 'CANCELLED', 'BLOCKED'
  )),
  -- Momento em que este job PODE ser reivindicado — é tanto o horário
  -- calculado pelo Scheduler (agendamento inicial) quanto o horário de
  -- retry após backoff (mesma coluna, um único conceito: "disponível a
  -- partir de").
  disponivel_em            timestamptz not null,
  claimed_by               text,
  claimed_at               timestamptz,
  -- LEASE (ajuste aprovado — worker que morre após o claim). Enquanto
  -- claim_expira_em > now(), a linha está "emprestada" a claimed_by e
  -- NINGUÉM mais pode reivindicá-la (nem o próprio claim function tenta —
  -- ver a cláusula WHERE de comunicacao_claim_mensagens). Se expirar:
  --   - status = PROCESSING (nunca chegou a chamar o provider) -> pode ser
  --     reivindicada de novo pelo PRÓXIMO claim, com segurança total (nenhum
  --     efeito colateral externo foi tentado ainda).
  --   - status = SENDING (já estava chamando o provider quando morreu) ->
  --     NUNCA reivindicada de novo automaticamente. Uma varredura separada
  --     (comunicacao.fila.repo.js#expirarEntregasIncertas) move para
  --     DELIVERY_UNKNOWN — aí exige reconciliação (fora do escopo do B.1).
  claim_expira_em          timestamptz,
  tentativas               integer not null default 0 check (tentativas >= 0),
  max_tentativas           integer not null default 5 check (max_tentativas > 0),
  enviado_em               timestamptz,
  entregue_em              timestamptz,
  lido_em                  timestamptz,
  falhou_em                timestamptz,
  entrega_incerta_em       timestamptz,
  erro                     text,
  erro_permanente          boolean not null default false,
  provider_message_id      text,
  metadados                jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint comunicacao_mensagens_idempotency_unica unique (idempotency_key)
);

comment on table comunicacao_mensagens is
  'Fila persistente de envio (Postgres + polling — sem Redis/BullMQ nesta fase). Claim atômico via comunicacao_claim_mensagens(), com lease (claim_expira_em) contra worker que morre a meio do processamento. NUNCA escrita direta de Provider.send* — só whatsapp.service.js chama o provider, depois de comunicacao.policy.js#avaliarEnvio aprovar.';
comment on column comunicacao_mensagens.idempotency_key is
  'Gerada uma única vez ao agendar (ex.: alerta:<id>:v1). Retry do mesmo job reusa a MESMA chave — nunca cria um segundo envio lógico.';
comment on column comunicacao_mensagens.disponivel_em is
  'Horário a partir do qual o job pode ser reivindicado. Agendamento inicial = janela calculada pelo Scheduler; após falha transitória = now() + backoff.';
comment on column comunicacao_mensagens.claim_expira_em is
  'Fim do lease do worker atual. PROCESSING expirado é reivindicável de novo (seguro — nenhum efeito externo tentado). SENDING expirado NUNCA é reivindicado pelo claim — vira DELIVERY_UNKNOWN por uma varredura separada.';
comment on column comunicacao_mensagens.entrega_incerta_em is
  'Quando esta linha virou DELIVERY_UNKNOWN (lease de um SENDING expirou sem resolução). Idempotência garante um único JOB LÓGICO — NÃO garante uma única ENTREGA FÍSICA no WhatsApp quando o provider é externo (ver comentário no topo da migration).';

-- Índices que o claim usa: SCHEDULED (fila normal) e PROCESSING (leases
-- abandonados) são caminhos distintos na cláusula WHERE da função — cada
-- um com seu próprio índice parcial, mais barato que um índice largo com
-- `status in (...)` (que teria que escanear SENDING/SENT/etc. também).
create index if not exists idx_comunicacao_mensagens_fila
  on comunicacao_mensagens (disponivel_em)
  where status = 'SCHEDULED';
create index if not exists idx_comunicacao_mensagens_lease_expirado
  on comunicacao_mensagens (claim_expira_em)
  where status = 'PROCESSING';
-- Idem para a varredura de SENDING com lease expirado (DELIVERY_UNKNOWN).
create index if not exists idx_comunicacao_mensagens_sending_expirado
  on comunicacao_mensagens (claim_expira_em)
  where status = 'SENDING';

create index if not exists idx_comunicacao_mensagens_organizacao on comunicacao_mensagens (organizacao_id);
create index if not exists idx_comunicacao_mensagens_contato on comunicacao_mensagens (contato_id, enviado_em);
create index if not exists idx_comunicacao_mensagens_alerta on comunicacao_mensagens (alerta_id);

drop trigger if exists trg_comunicacao_mensagens_upd on comunicacao_mensagens;
create trigger trg_comunicacao_mensagens_upd before update on comunicacao_mensagens
  for each row execute function set_updated_at();

alter table comunicacao_mensagens enable row level security;
revoke all on comunicacao_mensagens from authenticated, anon;


-- ---------------------------------------------------------------------
-- 4.1 TENTATIVAS (histórico por tentativa — Checkpoint B.1)
-- ---------------------------------------------------------------------
-- `comunicacao_mensagens` guarda só o ESTADO ATUAL (claimed_by/claimed_at/
-- tentativas/erro — um único valor cada, sobrescrito a cada tentativa). Isso
-- basta para a MECÂNICA (claim/retry/lease funcionam sem esta tabela), mas
-- não para AUDITORIA: depois de 3 tentativas por 2 workers diferentes, a
-- pergunta "o que aconteceu em cada uma" não tem resposta sem histórico —
-- e é exatamente essa pergunta que os cenários de worker-que-morre e
-- entrega incerta do B.1 exigem responder. Por isso criada agora (não é
-- "tabela por criar": ela é o registro que os testes D/E/F/G/H verificam).
create table if not exists comunicacao_tentativas (
  id                  uuid primary key default gen_random_uuid(),
  mensagem_id         uuid not null references comunicacao_mensagens(id) on delete cascade,
  tentativa_numero    integer not null check (tentativa_numero > 0),
  worker_id           text not null,
  iniciado_em         timestamptz not null default now(),
  finalizado_em       timestamptz,
  -- NULL enquanto em andamento (iniciado_em preenchido, finalizado_em não).
  resultado           text check (resultado in ('SENT', 'FAILED', 'DELIVERY_UNKNOWN', 'BLOCKED', 'ABANDONADA')),
  provider_message_id text,
  -- Espelha comunicacao.entrega.js#classificarErroEnvio — nunca uma string livre.
  erro_classificacao  text check (erro_classificacao in ('RETRYAVEL', 'PERMANENTE', 'INCERTO')),
  -- SANITIZADO: nunca token/credencial/PII além do necessário para diagnosticar.
  erro_sanitizado     text,
  constraint comunicacao_tentativas_numero_unico unique (mensagem_id, tentativa_numero)
);

comment on table comunicacao_tentativas is
  'Histórico de cada TENTATIVA de processar uma mensagem — 1 linha por (mensagem, número da tentativa). comunicacao_mensagens continua sendo a autoridade sobre o estado ATUAL; esta tabela é só trilha histórica/auditoria (quem tentou, quando, com que resultado). Nunca lida pelo claim nem pelo Policy Engine.';
comment on column comunicacao_tentativas.erro_sanitizado is
  'Nunca token/credencial/payload sensível — só o suficiente para diagnosticar (mesmo princípio de shared/auditoria.js).';

create index if not exists idx_comunicacao_tentativas_mensagem on comunicacao_tentativas (mensagem_id);

alter table comunicacao_tentativas enable row level security;
revoke all on comunicacao_tentativas from authenticated, anon;


-- ---------------------------------------------------------------------
-- 5. CONVERSAS (binding para agente_conversas — NÃO altera a tabela do Agente)
-- ---------------------------------------------------------------------
-- Ajuste aprovado do Checkpoint A: NÃO adicionar coluna `canal` em
-- `agente_conversas`. Auditoria (migration 060, docs/agente-crescer.md)
-- mostra que `agente_conversas`/`agente_mensagens` têm um invariante fino
-- (isolamento SEMPRE por perfil_id + organizacao_id + unidade_id juntos,
-- nunca só pelo id) que já funciona hoje para o chat in-app. Misturar um
-- histórico de WhatsApp na mesma tabela mudaria o contrato de uma tabela
-- que outro módulo já depende sem necessidade — mais barato e reversível
-- criar uma tabela de VÍNCULO que aponta para uma linha existente de
-- agente_conversas do que redesenhar a tabela do Agente.
create table if not exists comunicacao_conversas (
  id                       uuid primary key default gen_random_uuid(),
  organizacao_id           uuid not null references organizacoes(id) on delete cascade,
  unidade_id               uuid references unidades(id) on delete cascade,
  contato_id               uuid not null references contatos_whatsapp(id) on delete cascade,
  perfil_operacional_id    uuid references perfis_operacionais(id) on delete set null,
  agente_conversa_id       uuid references agente_conversas(id) on delete set null,
  canal                    text not null default 'whatsapp',
  status                   text not null default 'ATIVA' check (status in ('ATIVA', 'ENCERRADA')),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on table comunicacao_conversas is
  'Thread de WhatsApp associada a UMA conversa do Agente Crescer (agente_conversa_id), sem alterar agente_conversas. Ver justificativa completa no comentário da seção 5 desta migration.';

create index if not exists idx_comunicacao_conversas_contato on comunicacao_conversas (contato_id, status);
create index if not exists idx_comunicacao_conversas_organizacao on comunicacao_conversas (organizacao_id, unidade_id);

drop trigger if exists trg_comunicacao_conversas_upd on comunicacao_conversas;
create trigger trg_comunicacao_conversas_upd before update on comunicacao_conversas
  for each row execute function set_updated_at();

alter table comunicacao_conversas enable row level security;
revoke all on comunicacao_conversas from authenticated, anon;


-- ---------------------------------------------------------------------
-- 6. CONFIGURAÇÃO CENTRAL (modo/janelas/cooldowns — editável sem redeploy)
-- ---------------------------------------------------------------------
create table if not exists comunicacao_configuracoes (
  chave          text primary key,
  valor          jsonb not null,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid references perfis_operacionais(id) on delete set null
);

comment on table comunicacao_configuracoes is
  'Configuração central do módulo de comunicação (modo, janelas de horário, cooldowns, limites) — chave/valor, editável pelo Painel Administrativo (Checkpoint D) sem redeploy. .env só fornece o valor de bootstrap (ver comunicacao.config.js); esta tabela é a autoridade em runtime.';

alter table comunicacao_configuracoes enable row level security;
revoke all on comunicacao_configuracoes from authenticated, anon;

-- Seed idempotente — MODO SEMPRE NASCE DESLIGADO. Nunca DISABLED->NORMAL
-- por default: ligar é uma decisão explícita de quem administra o painel.
insert into comunicacao_configuracoes (chave, valor) values
  ('modo', '"DISABLED"'::jsonb),
  ('janelas', '{
     "seg_sex": {"inicio": "08:00", "fim": "18:00"},
     "sab":     {"inicio": "08:00", "fim": "13:00"},
     "dom":     null
   }'::jsonb),
  ('cooldowns_horas', '{"atencao": 8, "critico": 4}'::jsonb),
  ('limites', '{
     "max_proativas_por_minuto": 5,
     "max_por_contato_por_dia": 3
   }'::jsonb)
on conflict (chave) do nothing;


-- ---------------------------------------------------------------------
-- 7. CLAIM ATÔMICO COM LEASE (mesmo padrão de segurança da migration 067)
-- ---------------------------------------------------------------------
-- AUDITORIA DE SEGURANÇA DA FUNÇÃO (ajuste 8 — respostas explícitas):
--   * SECURITY INVOKER, escolha CONSCIENTE (não DEFINER): só o service_role
--     chama esta função (grant explícito abaixo), e ele já tem acesso pleno
--     à tabela de qualquer forma — INVOKER não amplia privilégio nenhum.
--     Se um dia for concedida a `authenticated`/`anon` por engano, o RLS
--     deny-by-default de comunicacao_mensagens faz a função não enxergar
--     NADA (modo de falha seguro). Um DEFINER faria o oposto: escreveria
--     mesmo sem a policy, porque rodaria com o privilégio de quem CRIOU a
--     função — é exatamente o erro que este desenho evita.
--   * search_path fixado (= public) — sem hijack via search_path do chamador.
--   * EXECUTE revogado explicitamente de public/anon/authenticated (grants
--     de PUBLIC em função nova são o padrão do Postgres — revogar só
--     anon/authenticated não bastaria); GRANT explícito só para service_role.
--   * Cross-tenant: a função NÃO recebe organizacao_id/unidade_id — ela
--     reivindica através de TODA a frota, de propósito (a distribuição de
--     horários do Scheduler é global, não por empresa — ver
--     comunicacao.alertas.service.js#agendarEnviosPendentes). Isso NÃO é
--     um bypass: quem chama já É o service_role, que por definição já
--     enxerga todos os tenants no resto do backend (mesmo modelo de
--     confiança de administrativo.service.js). A função não abre um
--     caminho novo para um papel menos privilegiado ver dado cross-tenant
--     — ela só pode ser chamada por quem já podia.
--   * A função só lê/escreve `comunicacao_mensagens` — nunca toca outra
--     tabela, nunca devolve dado que o chamador (service_role) não teria
--     de qualquer forma. Não é uma via de bypass de autorização.
--
-- LEASE (ajuste aprovado — worker que morre depois do claim, ver comentário
-- na coluna claim_expira_em): a cláusula WHERE tem DOIS caminhos —
--   (a) SCHEDULED disponível agora (fila normal);
--   (b) PROCESSING cujo lease expirou (abandonado — seguro reivindicar de
--       novo, porque PROCESSING significa "ainda não tentei o efeito
--       externo"). SENDING NUNCA aparece aqui — ver
--       comunicacao_expirar_entregas_incertas() logo abaixo.
create or replace function comunicacao_claim_mensagens(p_limite integer, p_worker text, p_lease_segundos integer default 120)
returns setof comunicacao_mensagens
language sql
security invoker
set search_path = public
as $$
  with candidatos as (
    select id
    from comunicacao_mensagens
    where (status = 'SCHEDULED' and disponivel_em <= now())
       or (status = 'PROCESSING' and claim_expira_em < now())
    order by disponivel_em asc
    limit greatest(p_limite, 0)
    for update skip locked
  )
  update comunicacao_mensagens m
  set status = 'PROCESSING',
      claimed_by = p_worker,
      claimed_at = now(),
      claim_expira_em = now() + make_interval(secs => greatest(p_lease_segundos, 1)),
      tentativas = m.tentativas + 1,
      updated_at = now()
  from candidatos c
  where m.id = c.id
  returning m.*;
$$;

comment on function comunicacao_claim_mensagens(integer, text, integer) is
  'Claim ATÔMICO de até p_limite mensagens elegíveis (SCHEDULED disponíveis, ou PROCESSING com lease expirado — worker abandonado), via FOR UPDATE SKIP LOCKED numa única instrução. Concede um lease de p_lease_segundos (default 120s). Dois workers chamando ao mesmo tempo nunca reivindicam a mesma linha. NUNCA reivindica SENDING (ver comunicacao_expirar_entregas_incertas). Chamada só pelo backend (service_role) — ver auditoria de segurança no comentário acima.';

revoke all on function comunicacao_claim_mensagens(integer, text, integer) from public, anon, authenticated;
grant execute on function comunicacao_claim_mensagens(integer, text, integer) to service_role;


-- ---------------------------------------------------------------------
-- 7.1 EXPIRAÇÃO DE ENTREGA INCERTA (ajuste 5/6 — NUNCA reenvio cego)
-- ---------------------------------------------------------------------
-- Não precisa do mesmo cuidado de SKIP LOCKED do claim: mover para
-- DELIVERY_UNKNOWN é IDEMPOTENTE por natureza (duas chamadas concorrentes
-- marcando a mesma linha produzem o mesmo resultado, sem duplo efeito
-- colateral) — diferente de reivindicar para PROCESSAR, que precisa de
-- exclusividade. Mesmo modelo de segurança do claim (INVOKER, só
-- service_role).
create or replace function comunicacao_expirar_entregas_incertas(p_worker text)
returns setof comunicacao_mensagens
language sql
security invoker
set search_path = public
as $$
  update comunicacao_mensagens
  set status = 'DELIVERY_UNKNOWN',
      entrega_incerta_em = now(),
      updated_at = now()
  where status = 'SENDING'
    and claim_expira_em < now()
  returning *;
$$;

comment on function comunicacao_expirar_entregas_incertas(text) is
  'Move para DELIVERY_UNKNOWN toda mensagem SENDING cujo lease expirou sem resolução (worker morreu depois de chamar o provider — não sabemos se chegou). NUNCA volta para SCHEDULED sozinha: exige reconciliação explícita (fora do escopo do Checkpoint B.1). p_worker é só rótulo de auditoria (quem detectou), não um filtro.';

revoke all on function comunicacao_expirar_entregas_incertas(text) from public, anon, authenticated;
grant execute on function comunicacao_expirar_entregas_incertas(text) to service_role;


-- ---------------------------------------------------------------------
-- 8. PÓS-CHECK (execute isoladamente DEPOIS; nada aqui escreve)
-- ---------------------------------------------------------------------
--   select conname from pg_constraint where conname = 'comunicacao_alertas_chave_unica'; -- 1 linha
--   select proname from pg_proc where proname = 'comunicacao_claim_mensagens';           -- 1 linha
--   select proname from pg_proc where proname = 'comunicacao_expirar_entregas_incertas'; -- 1 linha
--   select to_regclass('public.comunicacao_tentativas');                                 -- não NULL
--   select chave, valor from comunicacao_configuracoes order by chave;                    -- 4 linhas, modo = "DISABLED"
--   -- RLS/grants: nenhuma linha deve aparecer (anon/authenticated não têm privilégio de tabela):
--   select grantee, table_name, privilege_type from information_schema.role_table_grants
--     where table_name like 'comunicacao_%' or table_name like 'contatos_whatsapp%'
--     and grantee in ('anon', 'authenticated');
--   -- EXECUTE das funções: só service_role deve aparecer:
--   select grantee, routine_name from information_schema.role_routine_grants
--     where routine_name in ('comunicacao_claim_mensagens', 'comunicacao_expirar_entregas_incertas');
--   -- teste rápido do claim (não deixa lixo: cancela a mensagem de teste depois):
--   -- select * from comunicacao_claim_mensagens(10, 'teste-manual');
--   -- teste rápido do lease (worker morto): claim, backdate claim_expira_em,
--   -- reivindicar de novo deve funcionar (PROCESSING) e comunicacao_expirar_entregas_incertas
--   -- não deve pegar nada (SENDING é um caminho separado, testado pela suíte de integração).
-- =====================================================================

commit;
