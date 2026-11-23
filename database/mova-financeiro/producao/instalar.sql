-- MOVA — INSTALAÇÃO do schema PRÓPRIO `mova` no banco de PRODUÇÃO (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` numa ÚNICA transação (psql -v ON_ERROR_STOP=1 -1 -f instalar.sql). Qualquer falha desfaz tudo.
-- Aditivo: só cria o schema mova, o papel mova_app (sem login) e as tabelas do MOVA. Não toca em public nem no financeiro_v2.
-- Migrações: 0001_mova_fundacao.sql, 0002_mova_operacao.sql, 0003_mova_homologacao_privada.sql, 0004_mova_controle_orcamento.sql, 0005_mova_grupos_reais.sql, 0006_mova_politica_resposta.sql, 0007_mova_autonomia_operacoes.sql, 0008_mova_entregadores_automacoes.sql, 0009_mova_baixa_documental.sql, 0010_mova_despesa_documental.sql, 0011_mova_entregadores_rotina.sql, 0013_mova_entregadores_cadastro.sql

-- ===================================================================================== pré-condições (abortam)
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'mova') then raise exception 'MOVA instalação: schema mova já existe — nada foi feito'; end if;
  if coalesce((select shobj_description(d.oid, 'pg_database') from pg_database d where d.datname = current_database()), '') like 'MOVA\_HOMOLOGACAO:%' then
    raise exception 'MOVA instalação: este é o banco de HOMOLOGAÇÃO do MOVA — a operação usa o banco de produção; nada foi feito';
  end if;
  if exists (select 1 from pg_publication where puballtables) then
    raise exception 'MOVA instalação: existe publicação FOR ALL TABLES (%) — as tabelas do MOVA entrariam na replicação; nada foi feito',
      (select string_agg(pubname, ', ') from pg_publication where puballtables);
  end if;
  if current_setting('server_version_num')::int < 130000 then raise exception 'MOVA instalação: PostgreSQL 13+ exigido'; end if;
end $$;

-- ------------------------------------------------------------------------- 0001_mova_fundacao.sql (arquivo 1d4c349167cd023012a2878421a69785b2eeb7da56c6f08d10615e4e3d9180d8)
-- MOVA — Execução 02: persistência do Centro Financeiro Inteligente (schema PRÓPRIO `mova`).
--
-- APLICAR SOMENTE NO PostgreSQL LOCAL DE TESTE nesta execução. Nada aqui foi aplicado em produção.
--
-- Não duplica o Financeiro v2: nada de obrigação, lançamento, pagamento, plano de contas ou concessão aqui. A proposta guarda o
-- COMANDO no contrato do Financeiro v2; o efeito financeiro só existe quando uma pessoa autorizada aplica pelo serviço real, e o
-- vínculo de volta é o id da obrigação/movimentação devolvido pelo Financeiro (coluna `resultado`).
-- Dinheiro em centavos inteiros (bigint). Sem exclusão física: decisões, aprovações e auditoria são só de inserção (gatilhos).
-- Unidade = (organizacao_id, unidade_id) dos escopos do Financeiro v2; nenhum identificador real é semeado aqui.

create schema if not exists mova;

-- Instância do Gateway (um processo Baileys = uma sessão WhatsApp). Não guarda credencial nem auth state.
create table mova.instancia_gateway (
  id            text primary key check (id ~ '^[A-Za-z0-9_.-]{1,60}$'),
  descricao     text not null default '',
  criado_em     timestamptz not null default now()
);

-- Grupos autorizados. Participar de um grupo autorizado = conversar com o MOVA (Nível 1). Não dá poder administrativo.
create table mova.grupo_autorizado (
  grupo_jid        text primary key check (grupo_jid ~ '^[0-9]{5,40}(-[0-9]{1,20})?@g\.us$'),
  organizacao_id   uuid not null,
  instancia_id     text not null references mova.instancia_gateway(id),
  rotulo           text not null default '',
  ativo            boolean not null default false,          -- nasce DESLIGADO
  criado_em        timestamptz not null default now()
);

-- Unidades atendidas por um grupo, com os apelidos que identificam a unidade no texto e a situação das fontes.
-- `fontes` espelha o cadastro de fontes do Financeiro v2; A_CONFIRMAR = requisitos incompletos (bloqueia APLICAÇÃO).
create table mova.grupo_unidade (
  grupo_jid        text not null references mova.grupo_autorizado(grupo_jid),
  organizacao_id   uuid not null,
  unidade_id       uuid not null,
  nome             text not null,
  apelidos         text[] not null default '{}',
  documentos       text[] not null default '{}',
  fontes           jsonb not null default '{"situacao":"A_CONFIRMAR"}'::jsonb,
  primary key (grupo_jid, unidade_id)
);

-- Participantes vistos no grupo (registro AUTOMÁTICO na primeira mensagem). `nome_exibicao` é o pushName do WhatsApp:
-- serve para mostrar quem falou, NUNCA como prova de identidade administrativa.
create table mova.participante (
  grupo_jid         text not null references mova.grupo_autorizado(grupo_jid),
  participante_jid  text not null check (participante_jid ~ '^[A-Za-z0-9_.:@-]{1,160}$'),
  telefone_e164     text check (telefone_e164 is null or telefone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  nome_exibicao     text check (nome_exibicao is null or length(nome_exibicao) <= 60),
  primeiro_em       timestamptz not null default now(),
  ultimo_em         timestamptz not null default now(),
  mensagens         integer not null default 0,
  primary key (grupo_jid, participante_jid)
);

-- Evidências (conteúdo do arquivo) por hash. Em produção o destino é um bucket privado; aqui, bytea no banco de teste.
create table mova.evidencia (
  sha256       text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
  referencia   text not null unique,
  mime         text not null,
  tamanho      integer not null check (tamanho > 0 and tamanho <= 15728640),
  nome_arquivo text,
  conteudo     bytea not null,
  criado_em    timestamptz not null default now()
);

-- Eventos recebidos (um por mensagem do WhatsApp). `texto` é conteúdo do grupo: visível só no Centro Financeiro autenticado.
create table mova.evento (
  evento_id         text primary key check (evento_id ~ '^[A-Za-z0-9_.:@-]{1,160}$'),
  grupo_jid         text not null,
  mensagem_id       text not null,
  participante_jid  text,
  provedor          text not null,
  tipo              text not null check (tipo in ('TEXTO','IMAGEM','DOCUMENTO','AUDIO','OUTRO')),
  texto             text,
  resposta_a        text,
  documento_sha256  text references mova.evidencia(sha256),
  recebido_em       timestamptz not null,
  criado_em         timestamptz not null default now(),
  unique (grupo_jid, mensagem_id)
);

-- Documento financeiro recebido (idempotência por DOCUMENTO: o mesmo arquivo só é tratado uma vez).
create table mova.documento (
  sha256          text primary key references mova.evidencia(sha256),
  organizacao_id  uuid,
  unidade_id      uuid,
  evento_id       text not null references mova.evento(evento_id),
  proposta_id     uuid,
  leitura         jsonb,                                        -- dados extraídos (saída estrita da IA)
  criado_em       timestamptz not null default now()
);

-- Propostas. Estados: AGUARDANDO_REVISAO → APLICANDO → APLICADA | REJEITADA (APLICANDO volta a AGUARDANDO_REVISAO se a aplicação falha).
create table mova.proposta (
  id                    uuid primary key,
  seq                   bigint generated always as identity unique,
  organizacao_id        uuid not null,
  unidade_id            uuid not null,
  chave_idempotencia    text not null unique,
  tipo                  text not null check (tipo in ('BAIXA_DE_OBRIGACAO','DESPESA_PAGA','NOVA_OBRIGACAO','SOLICITACAO_DE_REVISAO')),
  estado                text not null check (estado in ('AGUARDANDO_REVISAO','APLICANDO','APLICADA','REJEITADA')),
  valor_centavos        bigint check (valor_centavos is null or valor_centavos > 0),
  evento_id             text not null references mova.evento(evento_id),
  participante_jid      text,
  dados                 jsonb not null,                         -- comando no contrato do Financeiro v2, datas, leitura, sugestões
  resultado             jsonb,                                  -- ids devolvidos pelo Financeiro v2 na aplicação
  versao                integer not null default 1,
  criada_em             timestamptz not null default now(),
  atualizada_em         timestamptz not null default now()
);
create index proposta_unidade on mova.proposta (organizacao_id, unidade_id, estado);

-- Histórico de processamento (decisão do motor por evento). Só códigos; nunca texto da mensagem.
create table mova.decisao (
  id                uuid primary key default gen_random_uuid(),
  seq               bigint generated always as identity unique,
  organizacao_id    uuid,
  unidade_id        uuid,
  evento_id         text not null,
  decisao           text not null,
  motivo            text not null,
  proposta_id       uuid,
  sinais_injecao    boolean not null default false,
  documento_sha256  text,
  extra             jsonb not null default '{}'::jsonb,
  em                timestamptz not null default now()
);
create index decisao_unidade on mova.decisao (organizacao_id, unidade_id, seq);
create index decisao_evento on mova.decisao (evento_id);

-- Mensagem que aguarda esclarecimento (ex.: unidade) — a resposta a ela retoma o processamento, mesmo após reinício.
create table mova.mensagem_pendente (
  mensagem_id   text primary key,
  grupo_jid     text not null,
  evento_id     text not null references mova.evento(evento_id),
  leitura       jsonb not null,
  criada_em     timestamptz not null default now(),
  resolvida_em  timestamptz
);

-- Respostas do agente (caixa de saída). Nesta execução nada é enviado: estado fica PENDENTE.
-- `provider_message_id` (quando enviada) permite reconhecer o eco da própria resposta e evitar laço.
create table mova.resposta (
  id                   uuid primary key default gen_random_uuid(),
  seq                  bigint generated always as identity unique,
  grupo_jid            text not null,
  resposta_a           text,
  evento_id            text,
  texto                text not null,
  estado               text not null default 'PENDENTE' check (estado in ('PENDENTE','ENVIADA','FALHOU','SUPRIMIDA')),
  provider_message_id  text unique,
  criada_em            timestamptz not null default now()
);

-- Aprovações/rejeições (Nível 2): sempre por usuário da plataforma com contexto verificado, nunca pelo WhatsApp.
create table mova.aprovacao (
  id             uuid primary key default gen_random_uuid(),
  seq            bigint generated always as identity unique,
  proposta_id    uuid not null references mova.proposta(id),
  acao           text not null check (acao in ('APLICADA','REJEITADA','FALHOU','RECUSADA')),
  usuario_id     uuid not null,
  motivo         text,
  resultado      jsonb,
  em             timestamptz not null default now()
);

-- Auditoria geral do MOVA (quem, o quê, sobre o quê). Ator: PARTICIPANTE (jid), USUARIO (uuid) ou SISTEMA.
create table mova.auditoria (
  id         uuid primary key default gen_random_uuid(),
  seq        bigint generated always as identity unique,
  acao       text not null,
  ator_tipo  text not null check (ator_tipo in ('PARTICIPANTE','USUARIO','SISTEMA')),
  ator_ref   text,
  alvo       text,
  dados      jsonb not null default '{}'::jsonb,
  em         timestamptz not null default now()
);

-- Fila persistente com LEASE (vários processos podem trabalhar sem pegar o mesmo item).
create table mova.fila (
  evento_id     text primary key,
  carga         jsonb not null,
  estado        text not null check (estado in ('PENDENTE','PROCESSANDO','CONCLUIDO','FALHOU')),
  tentativas    integer not null default 0,
  proxima_em    timestamptz not null default now(),
  lease_ate     timestamptz,
  ultimo_erro   text,
  resultado     jsonb,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index fila_pendentes on mova.fila (estado, proxima_em);

-- Sem exclusão física e sem reescrita do que é trilha.
create function mova.somente_insercao() returns trigger language plpgsql as $$
begin
  raise exception 'MOVA: % é somente inserção (%).', tg_table_name, tg_op using errcode = 'MV001';
end $$;
create trigger decisao_somente_insercao before update or delete on mova.decisao for each row execute function mova.somente_insercao();
create trigger aprovacao_somente_insercao before update or delete on mova.aprovacao for each row execute function mova.somente_insercao();
create trigger auditoria_somente_insercao before update or delete on mova.auditoria for each row execute function mova.somente_insercao();
create function mova.sem_exclusao() returns trigger language plpgsql as $$
begin
  raise exception 'MOVA: exclusão física proibida em %.', tg_table_name using errcode = 'MV002';
end $$;
create trigger proposta_sem_exclusao before delete on mova.proposta for each row execute function mova.sem_exclusao();
create trigger evento_sem_exclusao before delete on mova.evento for each row execute function mova.sem_exclusao();
create trigger documento_sem_exclusao before delete on mova.documento for each row execute function mova.sem_exclusao();

-- Proposta APLICADA ou REJEITADA é final.
create function mova.proposta_transicao() returns trigger language plpgsql as $$
begin
  if old.estado in ('APLICADA','REJEITADA') then
    raise exception 'MOVA: proposta % já está %.', old.id, old.estado using errcode = 'MV003';
  end if;
  if not ((old.estado = 'AGUARDANDO_REVISAO' and new.estado in ('APLICANDO','REJEITADA'))
       or (old.estado = 'APLICANDO' and new.estado in ('APLICADA','AGUARDANDO_REVISAO'))) then
    raise exception 'MOVA: transição % → % inválida.', old.estado, new.estado using errcode = 'MV004';
  end if;
  new.versao := old.versao + 1;
  new.atualizada_em := now();
  return new;
end $$;
create trigger proposta_transicao before update on mova.proposta for each row execute function mova.proposta_transicao();

-- ------------------------------------------------------------------------- 0002_mova_operacao.sql (arquivo 5cdb1d34ae6435ea44d5bc8c36b93e9cf91ebb56e5d62396546f02ed0f5c1e0f)
-- MOVA — Execução 03: operação (revisão de classificação, envio de respostas, retenção de evidências, papel restrito).
-- APLICAR SOMENTE NO PostgreSQL LOCAL DE TESTE nesta execução. Nada aqui foi aplicado em produção.

-- 1. Revisão de classificação: enquanto AGUARDANDO_REVISAO, o administrador pode ajustar os DADOS (ex.: categoria escolhida)
--    sem mudar o estado. Toda mudança sobe a versão (concorrência otimista na rota). Estados finais continuam imutáveis.
create or replace function mova.proposta_transicao() returns trigger language plpgsql as $$
begin
  if old.estado in ('APLICADA','REJEITADA') then
    raise exception 'MOVA: proposta % já está %.', old.id, old.estado using errcode = 'MV003';
  end if;
  if new.estado = old.estado then
    if old.estado <> 'AGUARDANDO_REVISAO' then
      raise exception 'MOVA: dados só mudam em AGUARDANDO_REVISAO.' using errcode = 'MV004';
    end if;
    if new.tipo <> old.tipo or new.unidade_id <> old.unidade_id or new.organizacao_id <> old.organizacao_id
       or new.valor_centavos is distinct from old.valor_centavos or new.evento_id <> old.evento_id then
      raise exception 'MOVA: revisão não altera tipo, unidade, valor nem origem.' using errcode = 'MV005';
    end if;
  elsif not ((old.estado = 'AGUARDANDO_REVISAO' and new.estado in ('APLICANDO','REJEITADA'))
          or (old.estado = 'APLICANDO' and new.estado in ('APLICADA','AGUARDANDO_REVISAO'))) then
    raise exception 'MOVA: transição % → % inválida.', old.estado, new.estado using errcode = 'MV004';
  end if;
  new.versao := old.versao + 1;
  new.atualizada_em := now();
  return new;
end $$;

-- 2. Envio de respostas: lease para o enviador (vários processos sem enviar duas vezes) e tentativas.
alter table mova.resposta drop constraint resposta_estado_check;
alter table mova.resposta add constraint resposta_estado_check check (estado in ('PENDENTE','ENVIANDO','ENVIADA','FALHOU','SUPRIMIDA'));
alter table mova.resposta add column tentativas integer not null default 0;
alter table mova.resposta add column lease_ate timestamptz;
alter table mova.resposta add column ultimo_erro text;
alter table mova.resposta add column enviada_em timestamptz;
create index resposta_pendentes on mova.resposta (estado, seq);

-- 3. Evidências: unidade dona (acesso por unidade), retenção e EXCLUSÃO SEGURA (apaga o conteúdo, mantém hash e trilha).
alter table mova.evidencia add column organizacao_id uuid;
alter table mova.evidencia add column unidade_id uuid;
alter table mova.evidencia add column expira_em timestamptz not null default (now() + interval '400 days');
alter table mova.evidencia add column removida_em timestamptz;
alter table mova.evidencia alter column conteudo drop not null;
alter table mova.evidencia add constraint evidencia_conteudo_ou_removida check ((conteudo is null) = (removida_em is not null));

-- Expurgo: só evidência VENCIDA e que NÃO sustenta proposta aplicada (essa fica como prova do lançamento). Registra auditoria.
create function mova.expurgar_evidencias(p_agora timestamptz) returns integer language plpgsql as $$
declare n integer;
begin
  with alvo as (
    select e.sha256 from mova.evidencia e
     where e.removida_em is null and e.expira_em <= p_agora
       and not exists (select 1 from mova.documento d join mova.proposta p on p.id = d.proposta_id where d.sha256 = e.sha256 and p.estado in ('APLICADA','APLICANDO','AGUARDANDO_REVISAO'))
  ), feito as (
    update mova.evidencia e set conteudo = null, removida_em = p_agora from alvo where e.sha256 = alvo.sha256 returning e.sha256
  ), trilha as (
    insert into mova.auditoria (acao, ator_tipo, alvo, dados) select 'EVIDENCIA_EXPURGADA', 'SISTEMA', sha256, '{}'::jsonb from feito returning 1
  )
  select count(*) into n from trilha;
  return n;
end $$;

-- 4. Papel restrito da aplicação MOVA: sem login próprio (o papel de login herda dele), sem DELETE, sem DDL, sem acesso ao
--    schema do Financeiro v2. O backend usaria um papel de login membro de mova_app (MOVA_DATABASE_URL).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'mova_app') then
    create role mova_app nologin nosuperuser nocreatedb nocreaterole noinherit;
  end if;
end $$;
revoke all on schema mova from public;
grant usage on schema mova to mova_app;
grant select, insert on all tables in schema mova to mova_app;
grant update on mova.participante, mova.proposta, mova.mensagem_pendente, mova.resposta, mova.fila, mova.evidencia to mova_app;
grant usage on all sequences in schema mova to mova_app;
grant execute on function mova.expurgar_evidencias(timestamptz) to mova_app;
revoke delete, truncate on all tables in schema mova from mova_app;

-- ------------------------------------------------------------------------- 0003_mova_homologacao_privada.sql (arquivo 9b090ae2228c673e7fcae0b4dd976e78641d1e580b1cbb6b64c72876d3697ed3)
-- MOVA — Execução 04B: homologação em UMA conversa privada autorizada (além dos grupos).
-- APLICAR SOMENTE NO PostgreSQL LOCAL DE TESTE / ambiente de homologação. Nada aqui foi aplicado em produção.
-- O número do contato NUNCA é semeado aqui: entra pela configuração do ambiente de homologação.

alter table mova.grupo_autorizado drop constraint grupo_autorizado_grupo_jid_check;
alter table mova.grupo_autorizado add column tipo text not null default 'GRUPO' check (tipo in ('GRUPO','PRIVADO_HOMOLOGACAO'));
alter table mova.grupo_autorizado add constraint grupo_autorizado_jid_por_tipo check (
  (tipo = 'GRUPO' and grupo_jid ~ '^[0-9]{5,40}(-[0-9]{1,20})?@g\.us$')
  or (tipo = 'PRIVADO_HOMOLOGACAO' and grupo_jid ~ '^[1-9][0-9]{7,14}@s\.whatsapp\.net$'));
-- No máximo UMA conversa privada de homologação ativa por vez.
create unique index grupo_autorizado_um_privado_ativo on mova.grupo_autorizado ((tipo)) where tipo = 'PRIVADO_HOMOLOGACAO' and ativo;
grant select, insert, update on mova.grupo_autorizado to mova_app;

-- ------------------------------------------------------------------------- 0004_mova_controle_orcamento.sql (arquivo d8e3065c8d6603b5707b4b6399c014cfdd665cf13e77f6876fedbc1c135c0c00)
-- MOVA — Execução 05: controles em tempo real (reversão funcional sem reiniciar nada) e orçamento PERSISTENTE da IA.
-- APLICAR SOMENTE no banco de HOMOLOGAÇÃO do MOVA (nunca no banco de produção). Aditiva: nada existente é alterado.

-- Interruptores em tempo real. Valem JUNTO com as variáveis de ambiente (efetivo = ambiente E banco E não suspenso).
-- Mudar uma linha aqui desliga na hora: sem deploy, sem reiniciar o Gateway, sem tocar na sessão do WhatsApp.
create table mova.controle (
  id             boolean primary key default true check (id),           -- linha única
  suspenso       boolean not null default false,                         -- desliga TUDO
  recebimento    boolean not null default true,
  processamento  boolean not null default true,
  ia             boolean not null default true,
  envio          boolean not null default true,
  motivo         text,
  atualizado_por text,
  atualizado_em  timestamptz not null default now()
);
insert into mova.controle (id) values (true);

-- Orçamento da IA (o menor limite atingido primeiro vence). Padrão da homologação: 200 chamadas e US$ 10.
create table mova.orcamento_ia (
  id                    boolean primary key default true check (id),
  limite_chamadas       integer not null default 200 check (limite_chamadas >= 0),
  limite_custo_microusd bigint  not null default 10000000 check (limite_custo_microusd >= 0),
  reserva_microusd      bigint  not null default 100000 check (reserva_microusd > 0)   -- reservado ANTES de cada chamada (US$ 0,10)
);
insert into mova.orcamento_ia (id) values (true);

-- Cada chamada: reservada antes (conta no orçamento mesmo se o processo cair), acertada depois com o uso real.
create table mova.consumo_ia (
  id            uuid primary key default gen_random_uuid(),
  seq           bigint generated always as identity unique,
  estado        text not null check (estado in ('RESERVADA','CONCLUIDA','FALHOU')),
  modelo        text,
  entrada       integer,
  saida         integer,
  custo_microusd bigint not null,
  em            timestamptz not null default now()
);

grant select on mova.controle, mova.orcamento_ia to mova_app;
grant update on mova.controle to mova_app;
grant select, insert, update on mova.consumo_ia to mova_app;

-- ------------------------------------------------------------------------- 0005_mova_grupos_reais.sql (arquivo 2f16af94be7e7c0914fb2550465c6629470257b8aba1580c992e980dbc80a47d)
-- MOVA — Agente 2 (Frente A): grupos REAIS com lista de participantes, conversas privadas derivadas e continuidade de conversa.
--
-- APLICAR SOMENTE NO PostgreSQL LOCAL DE TESTE / homologação até a publicação coordenada (ver COORDENACAO-AGENTES.md).
-- Não altera dados existentes: grupos já cadastrados continuam ABERTOS (Nível 1 da Execução 02) até alguém mudar para LISTA.
-- Nenhum participante é semeado aqui: a lista é cadastrada por um administrador; o MOVA (mova_app) só LÊ a lista.

-- Acesso do grupo: ABERTO (legado: todo participante) ou LISTA (só os participantes autorizados abaixo).
alter table mova.grupo_autorizado add column acesso text not null default 'ABERTO' check (acesso in ('ABERTO','LISTA'));
-- Consultas com valores que o grupo aceita receber no PRÓPRIO grupo (padrão: nenhuma; valores vão para o privado).
alter table mova.grupo_autorizado add column consultas_no_grupo text[] not null default '{}';

-- Conversa privada de PARTICIPANTE: derivada da lista (a pessoa autorizada num grupo), sempre por LISTA.
alter table mova.grupo_autorizado drop constraint grupo_autorizado_tipo_check;
alter table mova.grupo_autorizado add constraint grupo_autorizado_tipo_check check (tipo in ('GRUPO','PRIVADO_HOMOLOGACAO','PRIVADO_PARTICIPANTE'));
alter table mova.grupo_autorizado drop constraint grupo_autorizado_jid_por_tipo;
alter table mova.grupo_autorizado add constraint grupo_autorizado_jid_por_tipo check (
  (tipo = 'GRUPO' and grupo_jid ~ '^[0-9]{5,40}(-[0-9]{1,20})?@g\.us$')
  or (tipo in ('PRIVADO_HOMOLOGACAO','PRIVADO_PARTICIPANTE') and grupo_jid ~ '^[1-9][0-9]{7,14}@s\.whatsapp\.net$'));
alter table mova.grupo_autorizado add constraint grupo_autorizado_privado_participante_lista check (tipo <> 'PRIVADO_PARTICIPANTE' or acesso = 'LISTA');

-- Participantes AUTORIZADOS por grupo. A identidade é o JID (ou o telefone verificado pelo Gateway); o nome é só rótulo.
-- Revogar = ativo false (o histórico fica). Unidades vazias = todas as unidades do grupo.
create table mova.participante_autorizado (
  id            uuid primary key default gen_random_uuid(),
  grupo_jid     text not null references mova.grupo_autorizado(grupo_jid),
  ids           text[] not null default '{}',
  telefones     text[] not null default '{}',
  perfil        text not null check (perfil in ('FINANCEIRO','CONSULTA','OPERACIONAL')),
  unidades      uuid[] not null default '{}',
  privado       text check (privado is null or privado ~ '^[1-9][0-9]{7,14}@s\.whatsapp\.net$'),
  nome          text check (nome is null or length(nome) <= 60),
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  revogado_em   timestamptz,
  check (cardinality(ids) + cardinality(telefones) > 0),
  check (ativo or revogado_em is not null)
);
create index participante_autorizado_grupo on mova.participante_autorizado (grupo_jid) where ativo;

-- Continuidade: depois de responder a um participante, o MOVA escuta a próxima mensagem DELE (sem exigir o nome) até `ate`,
-- e lembra a unidade e a consulta da conversa (contexto curto, por participante e conversa; nunca entre conversas).
create table mova.conversa_ativa (
  grupo_jid         text not null,
  participante_jid  text not null check (participante_jid ~ '^[A-Za-z0-9_.:@-]{1,160}$'),
  ate               timestamptz not null,
  unidade_id        uuid,
  consulta          text,
  atualizado_em     timestamptz not null default now(),
  primary key (grupo_jid, participante_jid)
);

grant select on mova.participante_autorizado to mova_app;
grant select, insert, update, delete on mova.conversa_ativa to mova_app;

-- ------------------------------------------------------------------------- 0006_mova_politica_resposta.sql (arquivo 1ecdc2f473854479b10487eddb1d1d842683ff3d0cf63d486764a46818261113)
-- MOVA — Agente 2: POLÍTICA DE RESPOSTA por grupo e RETRATO DOS MEMBROS (base da política GRUPO_FINANCEIRO).
--
-- APLICAR SOMENTE no PostgreSQL local de teste / homologação até a publicação coordenada (COORDENACAO-AGENTES.md).
-- Padrão PRIVADO_RESTRITO: grupos existentes NÃO passam a mostrar valores. GRUPO_FINANCEIRO e OPERACIONAL só com lista (LISTA).

alter table mova.grupo_autorizado add column politica_resposta text not null default 'PRIVADO_RESTRITO'
  check (politica_resposta in ('PRIVADO_RESTRITO','GRUPO_FINANCEIRO','OPERACIONAL'));
alter table mova.grupo_autorizado add constraint grupo_autorizado_politica_com_lista check (politica_resposta = 'PRIVADO_RESTRITO' or acesso = 'LISTA');

-- Retrato dos membros ATUAIS do grupo, gravado pelo Gateway/relé (contrato: JIDs PN/LID de todos os membros, sem o próprio MOVA).
-- O MOVA só libera valores no grupo com retrato de no máximo 15 minutos e todos os membros autorizados; senão, privado.
create table mova.grupo_membros (
  grupo_jid      text primary key references mova.grupo_autorizado(grupo_jid),
  membros        text[] not null check (cardinality(membros) between 1 and 1024),
  verificado_em  timestamptz not null,
  fonte          text not null default 'GATEWAY' check (fonte ~ '^[A-Z_]{3,30}$')
);

grant select, insert, update on mova.grupo_membros to mova_app;

-- ------------------------------------------------------------------------- 0007_mova_autonomia_operacoes.sql (arquivo cb13d733182446a34947d1b781430af21f654d5bb0f62309aa3a568ae8f1979d)
-- MOVA — Agente 2 (Frente C): POLÍTICAS DE AUTONOMIA e OPERAÇÕES EXECUTADAS (idempotência, auditoria e reversão).
--
-- APLICAR SOMENTE no PostgreSQL local de teste / homologação até a publicação coordenada (COORDENACAO-AGENTES.md).
-- Sem política cadastrada o MOVA só PROPÕE. Nenhuma política é semeada aqui. Pagamento bancário não existe como operação.

create table mova.politica_autonomia (
  id               uuid primary key default gen_random_uuid(),
  operacao         text not null check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO')),
  organizacao_id   uuid not null,
  unidade_id       uuid,                                -- null = todas as unidades da empresa (a da unidade prevalece)
  nivel            text not null check (nivel in ('SOMENTE_PROPOR','APLICAR_COM_CONFIRMACAO','APLICAR_AUTOMATICO')),
  limite_centavos  bigint not null check (limite_centavos >= 0),
  responsavel      text not null check (length(btrim(responsavel)) between 1 and 120),
  motivo           text not null check (length(btrim(motivo)) between 10 and 500),
  vigente_de       date not null,
  vigente_ate      date check (vigente_ate is null or vigente_ate >= vigente_de),
  criada_por       uuid not null,
  criada_em        timestamptz not null default now(),
  revogada_em      timestamptz,
  revogada_por     uuid,
  check (nivel = 'SOMENTE_PROPOR' or limite_centavos > 0),
  check (not (nivel = 'APLICAR_AUTOMATICO' and operacao = 'CONTA_A_PAGAR')),
  check ((revogada_em is null) = (revogada_por is null))
);
-- Uma política ATIVA por (operação, empresa, unidade). Trocar = revogar a anterior e criar outra (o histórico fica).
create unique index politica_autonomia_ativa on mova.politica_autonomia (operacao, organizacao_id, coalesce(unidade_id, '00000000-0000-0000-0000-000000000000'::uuid)) where revogada_em is null;

-- Cada execução automática (ou confirmada) de uma proposta: chave única = idempotência; estado final auditável; reversão
-- pelo serviço oficial (estorno) por responsável autorizado, registrada aqui (nunca apaga).
create table mova.operacao_executada (
  id                     uuid primary key default gen_random_uuid(),
  chave                  text not null unique,
  proposta_id            uuid not null references mova.proposta(id),
  organizacao_id         uuid not null,
  unidade_id             uuid not null,
  operacao               text not null check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO')),
  nivel                  text not null check (nivel in ('APLICAR_COM_CONFIRMACAO','APLICAR_AUTOMATICO')),
  politica_id            uuid references mova.politica_autonomia(id),
  estado                 text not null check (estado in ('EXECUTANDO','EXECUTADA','FALHOU','REVERTIDA')),
  valor_centavos         bigint not null check (valor_centavos > 0),
  executada_por          uuid not null,             -- identidade operacional (automático) ou a pessoa que confirmou
  resultado              jsonb,
  motivo                 text,
  criada_em              timestamptz not null default now(),
  atualizada_em          timestamptz not null default now(),
  revertida_por          uuid,
  revertida_em           timestamptz,
  justificativa_reversao text check (justificativa_reversao is null or length(btrim(justificativa_reversao)) >= 10),
  check ((estado = 'REVERTIDA') = (revertida_em is not null))
);
create index operacao_executada_unidade on mova.operacao_executada (organizacao_id, unidade_id, criada_em desc);

-- Estado final não volta: EXECUTADA só vira REVERTIDA; REVERTIDA e FALHOU são finais (nova tentativa = nova chave).
create or replace function mova.operacao_transicao() returns trigger language plpgsql as $$
begin
  if old.estado in ('REVERTIDA','FALHOU') or not ((old.estado = 'EXECUTANDO' and new.estado in ('EXECUTADA','FALHOU')) or (old.estado = 'EXECUTADA' and new.estado = 'REVERTIDA')) then
    raise exception 'MOVA: operação % → % inválida.', old.estado, new.estado using errcode = 'MV006';
  end if;
  new.atualizada_em := now();
  return new;
end $$;
create trigger operacao_executada_transicao before update on mova.operacao_executada for each row execute function mova.operacao_transicao();

grant select, insert on mova.politica_autonomia to mova_app;
grant update (revogada_em, revogada_por) on mova.politica_autonomia to mova_app;
grant select, insert, update on mova.operacao_executada to mova_app;

-- ------------------------------------------------------------------------- 0008_mova_entregadores_automacoes.sql (arquivo e66e9c662dbfd1c7ddd60092ff5cab082fa7dc230ca08da2524b46821feb6182)
-- MOVA — Agente 2 (Frente D): ENTREGADORES pelo WhatsApp (rotina semanal) e AUTOMAÇÕES com pausa individual.
--
-- APLICAR SOMENTE no PostgreSQL local de teste / homologação até a publicação coordenada (COORDENACAO-AGENTES.md).
-- Não é um segundo módulo de entregadores: o fechamento, a nota e a liberação continuam no Financeiro (entregadoresProprios).
-- Aqui fica só quem pode falar com o MOVA como entregador (lista fechada, cadastrada por administrador), o que já foi enviado
-- (idempotência) e o que foi recebido. Nenhum entregador é semeado.

-- Conversa privada do ENTREGADOR: sempre por LISTA (só aquele número/LID).
alter table mova.grupo_autorizado drop constraint grupo_autorizado_tipo_check;
alter table mova.grupo_autorizado add constraint grupo_autorizado_tipo_check check (tipo in ('GRUPO','PRIVADO_HOMOLOGACAO','PRIVADO_PARTICIPANTE','PRIVADO_ENTREGADOR'));
alter table mova.grupo_autorizado drop constraint grupo_autorizado_jid_por_tipo;
alter table mova.grupo_autorizado add constraint grupo_autorizado_jid_por_tipo check (
  (tipo = 'GRUPO' and grupo_jid ~ '^[0-9]{5,40}(-[0-9]{1,20})?@g\.us$')
  or (tipo in ('PRIVADO_HOMOLOGACAO','PRIVADO_PARTICIPANTE','PRIVADO_ENTREGADOR') and grupo_jid ~ '^[1-9][0-9]{7,14}@s\.whatsapp\.net$'));
alter table mova.grupo_autorizado add constraint grupo_autorizado_privado_entregador_lista check (tipo <> 'PRIVADO_ENTREGADOR' or acesso = 'LISTA');

-- Entregador AUTORIZADO: a chave é a do fechamento oficial do Financeiro; identidade = privado (PN) e/ou LIDs cadastrados.
-- Telefone único por unidade entre os ativos. Revogar = ativo false (o histórico fica).
create table mova.entregador_autorizado (
  id               uuid primary key default gen_random_uuid(),
  organizacao_id   uuid not null,
  unidade_id       uuid not null,
  chave            text not null check (length(btrim(chave)) between 1 and 200),
  telefone_e164    text not null check (telefone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  privado          text not null check (privado ~ '^[1-9][0-9]{7,14}@s\.whatsapp\.net$'),
  ids              text[] not null default '{}',             -- LIDs (@lid) conhecidos do mesmo número
  nome             text check (nome is null or length(nome) <= 60),
  ativo            boolean not null default true,
  criado_em        timestamptz not null default now(),
  revogado_em      timestamptz,
  check (ativo or revogado_em is not null)
);
create unique index entregador_autorizado_telefone on mova.entregador_autorizado (unidade_id, telefone_e164) where ativo;
create unique index entregador_autorizado_chave on mova.entregador_autorizado (unidade_id, chave) where ativo;

-- Envios da rotina (mensagem de segunda, cobrança da nota): uma linha por chave ⇒ nunca repete.
create table mova.entregador_envio (
  chave            text primary key check (length(chave) between 10 and 300),
  organizacao_id   uuid not null,
  unidade_id       uuid not null,
  entregador       text not null,
  tipo             text not null check (tipo in ('SEMANAL','COBRANCA_NOTA','NOTA_RECEBIDA')),
  semana_inicio    date not null,
  criado_em        timestamptz not null default now()
);

-- Notas recebidas no privado: idempotentes pelo conteúdo (sha256) por entregador e semana; resultado do anexo oficial.
create table mova.nota_entregador (
  id               uuid primary key default gen_random_uuid(),
  organizacao_id   uuid not null,
  unidade_id       uuid not null,
  entregador       text not null,
  semana_inicio    date not null,
  sha256           text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  evento_id        text not null,
  estado           text not null check (estado in ('PENDENTE_ANEXO','ANEXADA','RECUSADA')),
  motivo           text,
  documento_id     uuid,
  situacao_documental text,
  criada_em        timestamptz not null default now(),
  atualizada_em    timestamptz not null default now(),
  unique (unidade_id, entregador, semana_inicio, sha256)
);

-- Automações: liga/desliga e pausa INDIVIDUAL por unidade (a ausência de linha = desligada).
create table mova.automacao (
  nome             text not null check (nome in ('ENTREGADORES_SEMANAL','ENTREGADORES_COBRANCA','RECONFERENCIA_EXTRATO')),
  unidade_id       uuid not null,
  organizacao_id   uuid not null,
  ativa            boolean not null default false,
  horario          text not null default '09:00' check (horario ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  pausada_em       timestamptz,
  pausada_por      uuid,
  motivo           text check (motivo is null or length(motivo) <= 300),
  ultima_execucao  timestamptz,
  atualizada_em    timestamptz not null default now(),
  primary key (nome, unidade_id)
);

grant select on mova.entregador_autorizado to mova_app;
grant select, insert on mova.entregador_envio to mova_app;
grant select, insert, update (estado, motivo, documento_id, situacao_documental, atualizada_em) on mova.nota_entregador to mova_app;
grant select, insert, update (ativa, horario, pausada_em, pausada_por, motivo, ultima_execucao, atualizada_em) on mova.automacao to mova_app;

-- ------------------------------------------------------------------------- 0009_mova_baixa_documental.sql (arquivo b690cafc5aedd8e5bc553ca886690de5d6e61bc88b0f3c95881a725b9a3f2754)
-- MOVA — Agente 2 (Execução 17): operação BAIXA_DOCUMENTAL (pagamento registrado POR COMPROVANTE, conciliação pendente).
--
-- Só amplia a lista fechada de operações das políticas e das execuções. Nenhuma política é semeada: sem política cadastrada
-- o MOVA só PROPÕE. A escrita real continua exigindo política explícita + identidade operacional com concessão no Financeiro.
alter table mova.politica_autonomia drop constraint politica_autonomia_operacao_check;
alter table mova.politica_autonomia add constraint politica_autonomia_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL'));
alter table mova.operacao_executada drop constraint operacao_executada_operacao_check;
alter table mova.operacao_executada add constraint operacao_executada_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL'));

-- ------------------------------------------------------------------------- 0010_mova_despesa_documental.sql (arquivo f3aab5fe0574e86779b873e263551ebb8577049e3c0d3f3b58e753b8f731673c)
-- MOVA — Agente 2 (23/11/2026): operação DESPESA_DOCUMENTAL (despesa sem conta prévia, paga por COMPROVANTE: registra a conta
-- a pagar pela ação estreita `registrar_obrigacao` do Financeiro e o pagamento por comprovante; conciliação pendente).
--
-- Só amplia a lista fechada de operações das políticas e das execuções. Nenhuma política é semeada: sem política cadastrada
-- o MOVA só PROPÕE (a pessoa aprova na Central).
alter table mova.politica_autonomia drop constraint politica_autonomia_operacao_check;
alter table mova.politica_autonomia add constraint politica_autonomia_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL'));
alter table mova.operacao_executada drop constraint operacao_executada_operacao_check;
alter table mova.operacao_executada add constraint operacao_executada_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL'));

-- ------------------------------------------------------------------------- 0011_mova_entregadores_rotina.sql (arquivo ff74849e1f40ea2f799ee3c8a5a5be8562bfebf9ecdbde59d6c9e24c3d2ee0ca)
-- MOVA — Agente 2 (23/11/2026): ROTINA SEMANAL DOS ENTREGADORES — cadastro simples pelo gestor, leitura da nota fiscal,
-- aviso de liberação no grupo da unidade e relatório de quarta-feira. Nada é apagado; nenhum entregador é semeado.
--
--   * cadastro: o gestor informa o entregador OFICIAL (chave do fechamento do Financeiro) e o número; o backend confere a chave no
--     Financeiro antes de gravar. O papel da aplicação ganha INSERT e UPDATE só das colunas de revogação/verificação.
--   * nota: o resultado da leitura e da conferência (emitente, tomador, valor, período) fica na própria linha da nota.
--   * envios: tipos novos (aviso de liberação no grupo, relatório de quarta); a chave única continua impedindo repetição.
--   * automações: RELATÓRIO (quarta) e AVISO no grupo, com a mesma pausa individual por unidade.

-- Empresa exibida nas mensagens (nome da organização); opcional.
alter table mova.grupo_unidade add column empresa text check (empresa is null or length(btrim(empresa)) between 1 and 120);

alter table mova.entregador_autorizado add column cadastrado_por uuid, add column verificado_em timestamptz;
grant insert (organizacao_id, unidade_id, chave, telefone_e164, privado, ids, nome, cadastrado_por, verificado_em) on mova.entregador_autorizado to mova_app;
grant update (ativo, revogado_em, verificado_em) on mova.entregador_autorizado to mova_app;

alter table mova.nota_entregador add column leitura jsonb, add column conferencia text check (conferencia is null or conferencia in ('CONFERE', 'DIVERGENTE', 'INCONCLUSIVA'));
grant update (leitura, conferencia) on mova.nota_entregador to mova_app;

alter table mova.entregador_envio drop constraint entregador_envio_tipo_check;
alter table mova.entregador_envio add constraint entregador_envio_tipo_check check (tipo in ('SEMANAL', 'COBRANCA_NOTA', 'NOTA_RECEBIDA', 'AVISO_LIBERACAO', 'RELATORIO_QUARTA'));

alter table mova.automacao drop constraint automacao_nome_check;
alter table mova.automacao add constraint automacao_nome_check check (nome in ('ENTREGADORES_SEMANAL', 'ENTREGADORES_COBRANCA', 'RECONFERENCIA_EXTRATO', 'ENTREGADORES_RELATORIO', 'ENTREGADORES_AVISO_GRUPO'));

-- ------------------------------------------------------------------------- 0013_mova_entregadores_cadastro.sql (arquivo 6a4f9f8b4214a03602fa74ad573485a29a69056386882a6597310b71614dea3d)
-- MOVA — Agente 2 (23/11/2026): CADASTRO COMPLETO DOS ENTREGADORES (fonte ÚNICA de contatos, usada pelo Financeiro e pelo MOVA).
-- Nada é apagado e nenhum dado existente muda. Toda alteração (troca de número, nome de exibição, observação, desativação)
-- ENCERRA a linha vigente (ativo = false, quem, quando e por quê) e, quando for o caso, abre uma linha nova: o histórico é a
-- própria sequência de linhas (valor anterior e novo, ator e horário), sem UPDATE de dado cadastral.
--
--   * observacoes: anotação operacional (opcional, até 500 caracteres). CPF, Pix e afins NÃO têm coluna (não são pedidos).
--   * revogado_por / motivo_revogacao: quem encerrou a linha e por quê.

alter table mova.entregador_autorizado
  add column observacoes text check (observacoes is null or length(observacoes) <= 500),
  add column revogado_por uuid,
  add column motivo_revogacao text check (motivo_revogacao is null or motivo_revogacao in ('DESATIVADO', 'TROCA_DE_NUMERO', 'EDICAO'));

grant insert (observacoes) on mova.entregador_autorizado to mova_app;
grant update (revogado_por, motivo_revogacao) on mova.entregador_autorizado to mova_app;

-- ================================================================================ registro, isolamento e conferência
create table mova.mova_migracao (nome text primary key, sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'), aplicada_em timestamptz not null default now());
insert into mova.mova_migracao (nome, sha256) values
  ('0001_mova_fundacao.sql', '1d4c349167cd023012a2878421a69785b2eeb7da56c6f08d10615e4e3d9180d8'),
  ('0002_mova_operacao.sql', '5cdb1d34ae6435ea44d5bc8c36b93e9cf91ebb56e5d62396546f02ed0f5c1e0f'),
  ('0003_mova_homologacao_privada.sql', '9b090ae2228c673e7fcae0b4dd976e78641d1e580b1cbb6b64c72876d3697ed3'),
  ('0004_mova_controle_orcamento.sql', 'd8e3065c8d6603b5707b4b6399c014cfdd665cf13e77f6876fedbc1c135c0c00'),
  ('0005_mova_grupos_reais.sql', '2f16af94be7e7c0914fb2550465c6629470257b8aba1580c992e980dbc80a47d'),
  ('0006_mova_politica_resposta.sql', '1ecdc2f473854479b10487eddb1d1d842683ff3d0cf63d486764a46818261113'),
  ('0007_mova_autonomia_operacoes.sql', 'cb13d733182446a34947d1b781430af21f654d5bb0f62309aa3a568ae8f1979d'),
  ('0008_mova_entregadores_automacoes.sql', 'e66e9c662dbfd1c7ddd60092ff5cab082fa7dc230ca08da2524b46821feb6182'),
  ('0009_mova_baixa_documental.sql', 'b690cafc5aedd8e5bc553ca886690de5d6e61bc88b0f3c95881a725b9a3f2754'),
  ('0010_mova_despesa_documental.sql', 'f3aab5fe0574e86779b873e263551ebb8577049e3c0d3f3b58e753b8f731673c'),
  ('0011_mova_entregadores_rotina.sql', 'ff74849e1f40ea2f799ee3c8a5a5be8562bfebf9ecdbde59d6c9e24c3d2ee0ca'),
  ('0013_mova_entregadores_cadastro.sql', '6a4f9f8b4214a03602fa74ad573485a29a69056386882a6597310b71614dea3d');
grant select on mova.mova_migracao to mova_app;
revoke all on schema mova from public;
do $$ begin
  -- Supabase: o schema do MOVA nunca fica acessível aos papéis da API pública.
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema mova from anon'; execute 'revoke all on all tables in schema mova from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on schema mova from authenticated'; execute 'revoke all on all tables in schema mova from authenticated'; end if;
end $$;
do $$ declare faltando text; begin
  select string_agg(t, ', ') into faltando from unnest(array['aprovacao', 'auditoria', 'automacao', 'consumo_ia', 'controle', 'conversa_ativa', 'decisao', 'documento', 'entregador_autorizado', 'entregador_envio', 'evento', 'evidencia', 'fila', 'grupo_autorizado', 'grupo_membros', 'grupo_unidade', 'instancia_gateway', 'mensagem_pendente', 'nota_entregador', 'operacao_executada', 'orcamento_ia', 'participante', 'participante_autorizado', 'politica_autonomia', 'proposta', 'resposta', 'mova_migracao']) t
   where not exists (select 1 from pg_tables where schemaname = 'mova' and tablename = t);
  if faltando is not null then raise exception 'MOVA instalação: tabelas ausentes: %', faltando; end if;
  -- Única exclusão permitida: mova.conversa_ativa (estado efêmero da conversa; 0005). Nada financeiro, nenhum histórico.
  if exists (select 1 from information_schema.role_table_grants where table_schema = 'mova' and grantee = 'mova_app'
             and (privilege_type = 'TRUNCATE' or (privilege_type = 'DELETE' and table_name <> 'conversa_ativa'))) then
    raise exception 'MOVA instalação: mova_app só pode excluir de mova.conversa_ativa';
  end if;
  if (select rolcanlogin from pg_roles where rolname = 'mova_app') then raise exception 'MOVA instalação: mova_app não pode ter login'; end if;
end $$;
