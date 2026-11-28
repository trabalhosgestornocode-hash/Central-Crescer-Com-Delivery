-- MOVA — INSTALAÇÃO do schema PRÓPRIO `mova` no banco de PRODUÇÃO (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` numa ÚNICA transação (psql -v ON_ERROR_STOP=1 -1 -f instalar.sql). Qualquer falha desfaz tudo.
-- Aditivo: só cria o schema mova, o papel mova_app (sem login) e as tabelas do MOVA. Não toca em public nem no financeiro_v2.
-- Migrações: 0001_mova_fundacao.sql, 0002_mova_operacao.sql, 0003_mova_homologacao_privada.sql, 0004_mova_controle_orcamento.sql, 0005_mova_grupos_reais.sql, 0006_mova_politica_resposta.sql, 0007_mova_autonomia_operacoes.sql, 0008_mova_entregadores_automacoes.sql, 0009_mova_baixa_documental.sql, 0010_mova_despesa_documental.sql, 0011_mova_entregadores_rotina.sql, 0012_mova_juros_documental.sql, 0013_mova_entregadores_cadastro.sql, 0014_mova_unidade_sem_grupo.sql, 0015_mova_pagadores_multiunidade.sql, 0016_mova_avisos_entregadores.sql, 0017_mova_conversa_contexto.sql, 0018_mova_orcamento_renovavel.sql, 0019_mova_core_identidade_memoria.sql, 0020_mova_core_propostas.sql, 0021_mova_core_conhecimento.sql, 0022_mova_orcamento_uso.sql, 0023_mova_politica_sangria.sql, 0024_mova_grupo_multiempresa.sql, 0025_mova_contas_relatadas_intercompany_avisos.sql, 0026_mova_entregador_notificacoes_pagamento.sql, 0027_mova_fila_prioridade_limites.sql, 0028_mova_identidade_fiscal.sql

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

-- ------------------------------------------------------------------------- 0012_mova_juros_documental.sql (arquivo eff9660cdfe1a5a1d969eb3a75e709b5d486a4df6d6e6bcd0555ee9cc8780bba)
-- MOVA (23/11/2026): operação JUROS_DOCUMENTAL — pagamento por comprovante COM juros/multa confirmados pela pessoa (ação estreita
-- `registrar_juros` do Financeiro, migração 0031). O limite da política é o ENCARGO máximo por pagamento.
--
-- Só amplia a lista fechada de operações das políticas e das execuções. Nenhuma política é semeada: sem política cadastrada
-- o MOVA só PROPÕE (o Financeiro aplica o pagamento com juros na Central).
alter table mova.politica_autonomia drop constraint politica_autonomia_operacao_check;
alter table mova.politica_autonomia add constraint politica_autonomia_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL'));
alter table mova.operacao_executada drop constraint operacao_executada_operacao_check;
alter table mova.operacao_executada add constraint operacao_executada_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL'));

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

-- ------------------------------------------------------------------------- 0014_mova_unidade_sem_grupo.sql (arquivo 8c7631710233123f85a0c1cb2752dcbb115606be299269e68bb9294f631e203b)
-- MOVA — 23/11/2026: UNIDADE ATENDIDA SEM GRUPO (ex.: Subway Saci). Até aqui uma unidade só existia no MOVA pelo grupo
-- autorizado dela (mova.grupo_unidade). Esta tabela registra a unidade SEM grupo, para o cadastro e a rotina PRIVADA dos
-- entregadores e para as leituras da identidade de serviço — sem criar conversa nenhuma:
--   * nenhum grupo é cadastrado aqui; sem grupo não há aviso nem relatório em grupo (a rotina pula: SEM_GRUPO_DA_UNIDADE);
--   * a unidade ainda precisa estar em MOVA_OPERACAO_UNIDADES e ter a concessão "ver" da identidade do MOVA no Financeiro;
--   * fontes de faturamento próprias da unidade (Subway: SWF no balcão; iFood e 99Food só pelos relatórios oficiais);
--   * se a mesma unidade também estiver num grupo ativo, vale o cadastro do grupo (esta linha é ignorada).
-- O app (mova_app) só LÊ. Gravar é ato do proprietário pelo kit gerado (scripts/mova/unidadeSemGrupo.mjs), revisado antes.

create table mova.unidade_sem_grupo (
  unidade_id       uuid primary key,
  organizacao_id   uuid not null,
  nome             text not null check (length(nome) between 1 and 80),
  empresa          text check (empresa is null or length(empresa) <= 80),
  apelidos         text[] not null default '{}',
  documentos       text[] not null default '{}',
  fontes           jsonb not null default '{"situacao":"A_CONFIRMAR"}'::jsonb,
  ativo            boolean not null default false,
  motivo           text not null check (length(motivo) between 10 and 300),
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now()
);

grant select on mova.unidade_sem_grupo to mova_app;

-- ------------------------------------------------------------------------- 0015_mova_pagadores_multiunidade.sql (arquivo cbcd5e4421952a876fcd0b22ad8c0af582d757096baf3aface6ad43aefea5a96)
-- MOVA — 24/11/2026: IDENTIFICAÇÃO DA UNIDADE PELO PAGADOR e MOVA nas duas empresas (Açaí no Grau Saci + Subway Saci).
--
-- 1) `pagadores` no CADASTRO da unidade (grupo_unidade e unidade_sem_grupo): lista explícita dos titulares/documentos da CONTA
--    PAGADORA da unidade — ex.: [{"nome":"<titular da conta>"}] em cada unidade (valores reais só no cadastro, nunca no Git). O comprovante pago por essa conta
--    identifica a unidade (dominio/pagador.js). Nunca dá acesso: a conversa só atua nas unidades dela.
-- 2) Unidade SEM grupo (0014) ganha `participantes` (mesma forma da lista de um grupo: ids, telefones, perfil, privado, nome) e
--    `acesso_multiempresa` (padrão false). Com participantes, a pessoa ganha a unidade na conversa privada derivada; juntar duas
--    EMPRESAS na mesma conversa só com acesso_multiempresa = true (autorização explícita, com o motivo da linha).
-- 3) Conta a pagar NOVA (boleto/nota) pode ser AUTOMÁTICA quando uma política CONTA_A_PAGAR explícita o disser (antes era
--    proibido no banco). Nada é semeado: sem política, o MOVA só propõe — e a escrita ainda exige a concessão `registrar_obrigacao`
--    da identidade operacional na unidade (Financeiro v2 0030).
-- O app (mova_app) continua só LENDO o cadastro; gravar é ato do proprietário pelos kits (scripts/mova/*.mjs).

alter table mova.grupo_unidade add column pagadores jsonb not null default '[]'::jsonb
  check (jsonb_typeof(pagadores) = 'array' and jsonb_array_length(pagadores) <= 10);
alter table mova.unidade_sem_grupo add column pagadores jsonb not null default '[]'::jsonb
  check (jsonb_typeof(pagadores) = 'array' and jsonb_array_length(pagadores) <= 10);
alter table mova.unidade_sem_grupo add column participantes jsonb not null default '[]'::jsonb
  check (jsonb_typeof(participantes) = 'array' and jsonb_array_length(participantes) <= 50);
alter table mova.unidade_sem_grupo add column acesso_multiempresa boolean not null default false;

do $$ declare c text; begin
  select conname into c from pg_constraint
   where conrelid = 'mova.politica_autonomia'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) = 'CHECK ((NOT ((nivel = ''APLICAR_AUTOMATICO''::text) AND (operacao = ''CONTA_A_PAGAR''::text))))';
  if c is null then raise exception 'MOVA 0015: trava de conta a pagar automática não encontrada'; end if;
  execute format('alter table mova.politica_autonomia drop constraint %I', c);
end $$;

-- 4) Proposta VINCULO_DE_DOCUMENTO: nota fiscal de uma conta JÁ registrada — só anexa a nota à conta (nenhum valor muda).
do $$ declare c text; begin
  select conname into c from pg_constraint
   where conrelid = 'mova.proposta'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%BAIXA_DE_OBRIGACAO%SOLICITACAO_DE_REVISAO%';
  if c is null then raise exception 'MOVA 0015: lista de tipos de proposta não encontrada'; end if;
  execute format('alter table mova.proposta drop constraint %I', c);
end $$;
alter table mova.proposta add constraint proposta_tipo_check
  check (tipo in ('BAIXA_DE_OBRIGACAO','DESPESA_PAGA','NOVA_OBRIGACAO','SOLICITACAO_DE_REVISAO','VINCULO_DE_DOCUMENTO'));

-- ------------------------------------------------------------------------- 0016_mova_avisos_entregadores.sql (arquivo 76b39b7b74f4b4284b87a07c52cc4a3761fe7f5f49b6950a44587f8a93c377dc)
-- MOVA — 23/11/2026: avisos à GERÊNCIA no grupo da própria unidade, depois de cada envio privado de demonstrativo
-- (AVISO_DEMONSTRATIVO) e de cada nota fiscal recebida e conferida (AVISO_NOTA_RECEBIDA). Só amplia a lista fechada de
-- tipos de mova.entregador_envio (a chave única continua impedindo repetição). Nenhuma automação é ligada aqui: os avisos
-- só saem com ENTREGADORES_AVISO_GRUPO ativa na unidade e grupo exclusivo dela (sem grupo ⇒ pendente, nunca outro grupo).
-- (0015 é reservada ao PR #191.)
-- O aviso do demonstrativo só sai DEPOIS que o WhatsApp aceitou a mensagem privada (estado ENVIADA da mova.resposta): o envio
-- guarda o id da mensagem que gerou (resposta_id). O app só pode preencher esse vínculo uma vez (coluna nula ⇒ id).
alter table mova.entregador_envio drop constraint entregador_envio_tipo_check;
alter table mova.entregador_envio add constraint entregador_envio_tipo_check check (tipo in ('SEMANAL', 'COBRANCA_NOTA', 'NOTA_RECEBIDA', 'AVISO_LIBERACAO', 'RELATORIO_QUARTA', 'AVISO_DEMONSTRATIVO', 'AVISO_NOTA_RECEBIDA'));
alter table mova.entregador_envio add column resposta_id uuid references mova.resposta (id);
grant update (resposta_id) on mova.entregador_envio to mova_app;

-- ------------------------------------------------------------------------- 0017_mova_conversa_contexto.sql (arquivo b4950c5592e7e19a53fa2916e5b368272ea7712d4137799479349ec096eb9b69)
-- MOVA — 24/11/2026: contexto CURTO da conversa para perguntas de acompanhamento ("e na Subway?", "só as vencidas").
-- Guarda apenas o RECORTE da última consulta (período e, quando houver, o filtro de fornecedor/categoria) por participante e conversa, no mesmo
-- registro de continuidade que já expira em minutos. Nunca o texto da mensagem, valores ou documentos. Coluna nula = como era.
alter table mova.conversa_ativa add column contexto jsonb check (contexto is null or (jsonb_typeof(contexto) = 'object' and pg_column_size(contexto) <= 512));

-- ------------------------------------------------------------------------- 0018_mova_orcamento_renovavel.sql (arquivo 34c8aa11626450c39523155a0a5ed0b55dc60cf381aceb064c5d1a60371d0a87)
-- MOVA CORE — F0 (24/11/2026): orçamento de IA RENOVÁVEL, somente para HOMOLOGAÇÃO.
-- Aditiva: nada existente é alterado. O orçamento acumulado (mova.orcamento_ia) continua valendo onde está em uso (produção).
-- A política só vale com MOVA_ORCAMENTO_RENOVAVEL=1 no ambiente, em modo HOMOLOGACAO, E `ativo` nesta tabela (padrão: desligado).
-- Limites aprovados pelo proprietário: mensal US$ 10, diário US$ 1, por requisição US$ 0,10; alertas em 50/80/100%.
-- O código ainda prende cada limite a um teto máximo; o banco pode configurar valores menores, nunca maiores.

create table mova.orcamento_ia_politica (
  id                       boolean primary key default true check (id),
  ativo                    boolean not null default false,
  limite_mensal_microusd   bigint  not null default 10000000 check (limite_mensal_microusd >= 0),
  limite_diario_microusd   bigint  not null default 1000000  check (limite_diario_microusd >= 0),
  limite_requisicao_microusd bigint not null default 100000  check (limite_requisicao_microusd >= 0),
  reserva_microusd         bigint  not null default 20000    check (reserva_microusd > 0),   -- reservado ANTES de cada chamada
  max_passos_requisicao    integer not null default 6        check (max_passos_requisicao between 1 and 12),
  alertas_percentuais      integer[] not null default '{50,80,100}',
  fuso                     text    not null default 'America/Fortaleza',
  atualizado_por           text,
  atualizado_em            timestamptz not null default now()
);
insert into mova.orcamento_ia_politica (id) values (true);

-- Dimensões de controle em cada chamada (nulas nas linhas antigas = como era).
alter table mova.consumo_ia
  add column organizacao_id uuid,
  add column unidade_id     uuid,
  add column requisicao_id  text check (requisicao_id is null or length(requisicao_id) <= 120),
  add column cache_leitura  integer,
  add column cache_escrita  integer,
  add column regime         text check (regime is null or regime in ('ACUMULADO','RENOVAVEL'));
create index consumo_ia_em_idx on mova.consumo_ia (em);
create index consumo_ia_requisicao_idx on mova.consumo_ia (requisicao_id) where requisicao_id is not null;

-- Cada alerta dispara UMA vez por período (o histórico de meses anteriores é preservado; renovar não apaga nada).
create table mova.orcamento_ia_alerta (
  periodo     text not null check (periodo ~ '^(M|D):\d{4}-\d{2}(-\d{2})?$'),   -- M:2026-11 ou D:2026-11-24
  percentual  integer not null check (percentual between 1 and 100),
  consumo_microusd bigint not null,
  limite_microusd  bigint not null,
  em          timestamptz not null default now(),
  primary key (periodo, percentual)
);

grant select on mova.orcamento_ia_politica to mova_app;
grant select, insert on mova.orcamento_ia_alerta to mova_app;

-- ------------------------------------------------------------------------- 0019_mova_core_identidade_memoria.sql (arquivo b0346dc3c70f5ab415c73c764ae7af5d667928159528c7e4eb9359d20372963b)
-- MOVA CORE — F2 (24/11/2026): VÍNCULO participante do WhatsApp ↔ usuário da plataforma e MEMÓRIA persistente do fio.
-- Revisão do rascunho docs/mova-core/rascunhos (agora no schema próprio `mova`, prefixo core_, papel mova_app).
-- Aditiva: nenhuma tabela existente muda. Sem linhas, o MOVA se comporta como hoje (sem vínculo ⇒ só o que a lista de
-- participantes já permite; sem memória ⇒ continuidade curta atual). APLICAÇÃO: só no banco ISOLADO de homologação até
-- autorização específica para produção (backup + janela própria, como 0011/0029).
--
-- Regras codificadas no esquema (o código repete todas; o banco é a última barreira):
--   • vínculo nasce SÓ por CODIGO_AUTENTICADO (gerado na plataforma, confirmado no privado) ou APROVACAO_ADMIN (usuarios.gerenciar);
--   • a pessoa no WhatsApp é a chave CANÔNICA da entrada da lista (pessoaId ou hash dos JIDs), nunca telefone digitado;
--   • no máximo UM vínculo ATIVO por (organização, chave) e por (organização, perfil) — índice único parcial (concorrência);
--   • o código só existe como hash com sal; uso ÚNICO (consumido_em, consumo condicional); validade ≤ 10 min no próprio CHECK;
--   • tentativas: registro por chave; o limite por hora é contado sob trava consultiva da chave (atômico entre processos);
--   • revogação é registro (estado REVOGADO + quem/quando/motivo), nunca DELETE; papel/permissões NÃO são copiados;
--   • memória: chave organização|conversa|participante (privado e grupo nunca dividem linha), versão para escrita concorrente
--     (compare-and-set), tamanho limitado, validade (expira_em) para a política de retenção e exclusão a pedido.

create table mova.core_vinculo (
  id              uuid primary key default gen_random_uuid(),
  organizacao_id  uuid not null,
  chave_canonica  text not null check (length(chave_canonica) between 8 and 128),
  conta_id        uuid,
  perfil_id       uuid not null,
  metodo          text not null check (metodo in ('CODIGO_AUTENTICADO', 'APROVACAO_ADMIN')),
  estado          text not null default 'ATIVO' check (estado in ('ATIVO', 'REVOGADO')),
  criado_por      text,
  criado_em       timestamptz not null default now(),
  revogado_em     timestamptz,
  revogado_por    text,
  motivo_revogacao text check (motivo_revogacao is null or length(motivo_revogacao) <= 120),
  check ((estado = 'REVOGADO') = (revogado_em is not null)),
  check (metodo <> 'APROVACAO_ADMIN' or criado_por is not null)
);
create unique index core_vinculo_ativo_por_pessoa on mova.core_vinculo (organizacao_id, chave_canonica) where estado = 'ATIVO';
create unique index core_vinculo_ativo_por_perfil on mova.core_vinculo (organizacao_id, perfil_id) where estado = 'ATIVO';

create table mova.core_desafio_vinculo (
  id              uuid primary key default gen_random_uuid(),
  organizacao_id  uuid not null,
  conta_id        uuid,
  perfil_id       uuid not null,
  codigo_hash     text not null check (codigo_hash ~ '^[0-9a-f]{64}$'),
  sal             text not null check (length(sal) between 16 and 64),
  criado_em       timestamptz not null default now(),
  expira_em       timestamptz not null,
  consumido_em    timestamptz,
  substituido_em  timestamptz,
  check (expira_em > criado_em and expira_em <= criado_em + interval '10 minutes')
);
create index core_desafio_aberto on mova.core_desafio_vinculo (organizacao_id) where consumido_em is null and substituido_em is null;

create table mova.core_tentativa_vinculo (
  id              bigint generated always as identity primary key,
  chave_canonica  text not null check (length(chave_canonica) between 8 and 128),
  em              timestamptz not null default now()
);
create index core_tentativa_recente on mova.core_tentativa_vinculo (chave_canonica, em);

create table mova.core_memoria_conversa (
  chave           text primary key check (length(chave) <= 300),
  organizacao_id  uuid not null,
  conversa_id     text not null check (length(conversa_id) <= 160),
  participante_id text not null check (length(participante_id) <= 160),
  estado          jsonb not null check (jsonb_typeof(estado) = 'object' and pg_column_size(estado) <= 262144),
  versao          bigint not null default 1 check (versao >= 1),
  atualizado_em   timestamptz not null default now(),
  expira_em       timestamptz not null,
  check (chave = organizacao_id::text || '|' || conversa_id || '|' || participante_id)
);
create index core_memoria_por_org on mova.core_memoria_conversa (organizacao_id, atualizado_em);
create index core_memoria_vencida on mova.core_memoria_conversa (expira_em);

-- Acesso: só o papel de operação do MOVA, SEM DELETE em nenhuma (a regra da instalação continua: mova_app só exclui de
-- mova.conversa_ativa). Revogação e consumo são registro; EXCLUSÃO de memória (a pedido ou pela retenção) é APAGAMENTO do
-- conteúdo: estado vira '{}' com apagada_em/motivo — a linha fica só como prova de que foi apagada, sem nenhum dado.
-- Tentativas antigas não contam (janela de 1 h na consulta); o expurgo físico é tarefa de manutenção do proprietário.
alter table mova.core_memoria_conversa
  add column apagada_em timestamptz,
  add column motivo_apagamento text check (motivo_apagamento is null or motivo_apagamento in ('PEDIDO', 'RETENCAO', 'REVOGACAO')),
  add constraint core_memoria_apagada_sem_conteudo check (apagada_em is null or estado = '{}'::jsonb);
grant select, insert, update on mova.core_vinculo, mova.core_desafio_vinculo, mova.core_memoria_conversa to mova_app;
grant select, insert on mova.core_tentativa_vinculo to mova_app;

-- ------------------------------------------------------------------------- 0020_mova_core_propostas.sql (arquivo 1b7bd5f36f302ec80af081f9f0a2c383ad4c4764d21315ec9967f6313f4a8bd8)
-- MOVA CORE — F4 integrada (24/11/2026): PROPOSTAS de operação persistentes (sobrevivem a reinício e valem entre instâncias).
-- Aditiva: nenhuma tabela existente muda. Sem linhas, nada muda. APLICAÇÃO: só no banco ISOLADO de homologação até
-- autorização específica para produção (backup + janela própria).
--
-- A proposta NÃO é dado financeiro: é o pedido da pessoa e o seu desfecho. O Financeiro só é alterado pela porta operacional
-- (lista fechada), com chave idempotente; esta tabela guarda o estado da conversa e o resultado REAL devolvido pela transação.
--   • revisão para compare-and-set: duas instâncias confirmando a mesma proposta ⇒ só uma passa para EXECUTANDO;
--   • (raiz, versao) único: cada correção é uma versão nova; só a vigente é confirmável;
--   • o comprovante fica em `anexo` só enquanto a proposta pode ser executada; em estado final o conteúdo é apagado (o
--     Financeiro guardou a cópia oficial no cofre de documentos);
--   • sem DELETE para o papel da aplicação.
create table mova.core_proposta (
  id               text primary key check (id ~ '^[0-9a-f-]{36}:v[0-9]{1,4}$'),
  raiz             uuid not null,
  versao           integer not null check (versao between 1 and 1000),
  conversa_chave   text not null check (length(conversa_chave) <= 300),
  organizacao_id   uuid not null,
  unidade_id       uuid not null,
  autor            text not null check (length(autor) between 1 and 160),
  tipo             text not null check (tipo in ('COMPRA_JA_PAGA', 'PRESTACAO_DE_SANGRIA')),
  estado           text not null check (estado in ('AGUARDANDO_DADOS', 'AGUARDANDO_CONFIRMACAO', 'EM_REVISAO_HUMANA', 'EXECUTANDO', 'EXECUTADA',
                     'EXECUTADA_PARCIAL', 'FALHOU', 'CANCELADA', 'SUBSTITUIDA', 'EXPIRADA', 'RECUSADA', 'DESATUALIZADA')),
  revisao          bigint not null default 1 check (revisao >= 1),
  favorecido_chave text check (favorecido_chave is null or length(favorecido_chave) <= 200),
  valor_centavos   bigint check (valor_centavos is null or valor_centavos >= 0),
  executada_em     timestamptz,
  criada_em        timestamptz not null,
  expira_em        timestamptz not null check (expira_em > criada_em and expira_em <= criada_em + interval '2 hours'),
  atualizada_em    timestamptz not null default now(),
  proposta         jsonb not null check (jsonb_typeof(proposta) = 'object' and pg_column_size(proposta) <= 262144),
  anexo            bytea check (anexo is null or octet_length(anexo) <= 10485760),
  unique (raiz, versao),
  check (estado not in ('EXECUTADA', 'EXECUTADA_PARCIAL') or executada_em is not null)
);
create index core_proposta_da_conversa on mova.core_proposta (conversa_chave, criada_em desc, versao desc);
create index core_proposta_acumulado on mova.core_proposta (organizacao_id, unidade_id, favorecido_chave, executada_em)
  where estado in ('EXECUTADA', 'EXECUTADA_PARCIAL');

grant select, insert, update on mova.core_proposta to mova_app;

-- ------------------------------------------------------------------------- 0021_mova_core_conhecimento.sql (arquivo 8374fcaa31978caf36f8e52faf9dc160f0c4f9f03305b33d93d3972de0fadd69)
-- MOVA CORE — F5 (24/11/2026): CONHECIMENTO CORPORATIVO versionado, com origem, escopo, validade, responsável, aprovação,
-- revogação e trilha. Aditiva. APLICAÇÃO: só no banco ISOLADO de homologação até autorização específica para produção.
--
-- O que É conhecimento: como o sistema funciona, metodologias, regras e políticas APROVADAS, procedimentos, particularidades
-- das unidades. O que NÃO é: saldo, obrigação, valor em aberto, venda do dia — isso vem SEMPRE das ferramentas oficiais
-- (o serviço recusa conteúdo com cara de dado dinâmico).
--   • organizacao_id nulo = conhecimento do SISTEMA (vale para todas as empresas); unidade_id só junto com organizacao_id;
--   • PENDENTE nunca é oficial; APROVADO exige aprovador humano diferente de quem sugeriu (a IA sugere, nunca aprova);
--   • no máximo UMA versão APROVADA por (escopo, chave); aprovar a nova versão SUBSTITUI a anterior (registro, não DELETE);
--   • revogação é registro (quem/quando/motivo); a trilha (core_conhecimento_evento) só recebe INSERT.
create table mova.core_conhecimento (
  id               uuid primary key default gen_random_uuid(),
  chave            text not null check (chave ~ '^[a-z0-9][a-z0-9._-]{2,80}$'),
  versao           integer not null check (versao between 1 and 10000),
  organizacao_id   uuid,
  unidade_id       uuid,
  tipo             text not null check (tipo in ('FUNCIONAMENTO', 'REGRA_FINANCEIRA', 'METODOLOGIA', 'PROCEDIMENTO', 'POLITICA',
                     'INTEGRACAO', 'GLOSSARIO', 'PARTICULARIDADE_DA_UNIDADE', 'DECISAO')),
  titulo           text not null check (length(titulo) between 3 and 160),
  conteudo         text not null check (length(conteudo) between 10 and 8000),
  palavras         text[] not null default '{}' check (cardinality(palavras) <= 40),
  texto_busca      text not null check (length(texto_busca) <= 12000),
  busca            tsvector generated always as (to_tsvector('portuguese', texto_busca)) stored,
  origem           text not null check (length(origem) between 3 and 300),
  responsavel      text not null check (length(responsavel) between 2 and 120),
  estado           text not null default 'PENDENTE' check (estado in ('PENDENTE', 'APROVADO', 'RECUSADO', 'SUBSTITUIDO', 'REVOGADO')),
  sugerido_por     text not null check (length(sugerido_por) between 2 and 160),
  sugerido_pela_ia boolean not null default false,
  aprovado_por     text,
  aprovado_em      timestamptz,
  vigente_de       date,
  vigente_ate      date,
  revogado_em      timestamptz,
  revogado_por     text,
  motivo_revogacao text check (motivo_revogacao is null or length(motivo_revogacao) <= 300),
  criado_em        timestamptz not null default now(),
  check (unidade_id is null or organizacao_id is not null),
  check (vigente_ate is null or vigente_de is null or vigente_ate >= vigente_de),
  check (estado <> 'APROVADO' or (aprovado_por is not null and aprovado_em is not null and aprovado_por <> sugerido_por)),
  check ((estado = 'REVOGADO') = (revogado_em is not null))
);
create unique index core_conhecimento_versao on mova.core_conhecimento (coalesce(organizacao_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(unidade_id, '00000000-0000-0000-0000-000000000000'::uuid), chave, versao);
create unique index core_conhecimento_um_aprovado on mova.core_conhecimento (coalesce(organizacao_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(unidade_id, '00000000-0000-0000-0000-000000000000'::uuid), chave) where estado = 'APROVADO';
create index core_conhecimento_busca on mova.core_conhecimento using gin (busca);
create index core_conhecimento_escopo on mova.core_conhecimento (organizacao_id, unidade_id, estado);

create table mova.core_conhecimento_evento (
  id               bigint generated always as identity primary key,
  conhecimento_id  uuid not null references mova.core_conhecimento (id),
  acao             text not null check (acao in ('SUGERIDO', 'APROVADO', 'RECUSADO', 'SUBSTITUIDO', 'REVOGADO')),
  por              text not null check (length(por) between 2 and 160),
  em               timestamptz not null default now(),
  detalhes         jsonb not null default '{}'::jsonb check (jsonb_typeof(detalhes) = 'object' and pg_column_size(detalhes) <= 16384)
);
create index core_conhecimento_evento_de on mova.core_conhecimento_evento (conhecimento_id, em);

grant select, insert, update on mova.core_conhecimento to mova_app;
grant select, insert on mova.core_conhecimento_evento to mova_app;

-- ------------------------------------------------------------------------- 0022_mova_orcamento_uso.sql (arquivo 5bb150ede6656e4da81669299e1bc8dd61c0409cf53617f125498e4e71f758b9)
-- MOVA CORE — 25/11/2026: orçamento RENOVÁVEL com controle POR TIPO DE USO (exige a 0018).
-- Aditiva: nenhum limite financeiro muda (continua US$ 10/mês, US$ 1/dia, US$ 0,10/solicitação, presos também no código).
--   * Parte do mesmo limite fica GUARDADA para leitura de documentos: a conversa nunca consome essa parte, então conversar
--     muito não impede o MOVA de ler um comprovante. Padrão: US$ 2 do mês e US$ 0,20 do dia (dentro dos US$ 10 / US$ 1).
--   * Limite RENOVÁVEL de chamadas de conversa por dia (substitui o teto acumulado de 500 chamadas): 300/dia, renova à meia-noite.
--   * Cada chamada registra o uso (CONVERSA ou DOCUMENTO); linhas antigas ficam nulas (= como era).
-- Nada é ligado aqui: a política continua `ativo = false` até a autorização, e o código só usa o renovável com
-- MOVA_ORCAMENTO_RENOVAVEL=1.

alter table mova.orcamento_ia_politica
  add column reserva_documentos_mensal_microusd bigint  not null default 2000000 check (reserva_documentos_mensal_microusd >= 0),
  add column reserva_documentos_diario_microusd bigint  not null default 200000  check (reserva_documentos_diario_microusd >= 0),
  add column limite_chamadas_conversa_diario   integer not null default 300     check (limite_chamadas_conversa_diario between 1 and 2000);

alter table mova.consumo_ia
  add column uso text check (uso is null or uso in ('CONVERSA', 'DOCUMENTO'));

-- ------------------------------------------------------------------------- 0023_mova_politica_sangria.sql (arquivo 7855261f01a9363397032937ea2dbf6cfb62a5f6cabedc2a5ffcda346c513631)
-- MOVA (25/11/2026): operação PRESTACAO_DE_SANGRIA nas POLÍTICAS de autonomia e nas execuções (MOVA CORE F4; ação estreita
-- `prestar_sangria` do Financeiro, migração 0032). O código já trata a operação (dominio/autonomia.js); faltava a lista fechada
-- do banco aceitá-la. Só amplia as duas listas fechadas. Nenhuma política é semeada: sem política o MOVA só PROPÕE.
alter table mova.politica_autonomia drop constraint politica_autonomia_operacao_check;
alter table mova.politica_autonomia add constraint politica_autonomia_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL','PRESTACAO_DE_SANGRIA'));
alter table mova.operacao_executada drop constraint operacao_executada_operacao_check;
alter table mova.operacao_executada add constraint operacao_executada_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL','PRESTACAO_DE_SANGRIA'));

-- ------------------------------------------------------------------------- 0024_mova_grupo_multiempresa.sql (arquivo 441327e033f00fa8a032da0be652c747f45b509ebc3199ba0167a2ba4eff9c47)
-- MOVA (25/11/2026): GRUPO COMPARTILHADO por duas empresas (caso real: "Contas à Pagar Subway / Açaí").
-- Marca EXPLÍCITA e auditável no grupo: sem ela, um grupo com unidades de duas organizações é recusado na montagem
-- (dominio/configuracao.js). Com ela, cada mensagem continua resolvendo UMA unidade (titular/CNPJ do comprovante, apelido ou
-- pergunta) e o escopo nunca junta organizações; a conversa privada derivada dos participantes passa a poder ter as duas.
-- Só acrescenta a coluna (padrão false): nenhum grupo muda de comportamento até ser marcado.
alter table mova.grupo_autorizado add column if not exists multiempresa boolean not null default false;
comment on column mova.grupo_autorizado.multiempresa is 'Grupo compartilhado por unidades de organizações diferentes (autorização explícita do proprietário). Cada mensagem resolve uma única unidade.';

-- ------------------------------------------------------------------------- 0025_mova_contas_relatadas_intercompany_avisos.sql (arquivo 3cbc7d7db7c79e6e159d309a950aa66071f2346dc4205538addfa81bd690209a)
-- MOVA (26/11/2026; revisada 27/11): (1) operações CONTA_A_PAGAR_RELATADA (conta ÚNICA relatada, sem documento), CONTA_PARCELADA_RELATADA
-- (2 a 24 parcelas; limite sobre a compra inteira) — ambas pela ação estreita
-- `registrar_conta_parcelada` do Financeiro, migração 0033) e OPERACAO_ENTRE_EMPRESAS (pagamento feito por outra empresa do grupo;
-- ação `registrar_intercompany`, migração 0034) nas listas fechadas das POLÍTICAS e das EXECUÇÕES. Nenhuma política é semeada: sem
-- política o MOVA só PROPÕE (as políticas existentes — conta por boleto/nota, despesa paga — NÃO cobrem estas operações).
-- (2) AVISO DIÁRIO de contas a pagar no grupo (10h/15h, America/Fortaleza): UMA linha por grupo + data + janela (chave única) — a
-- idempotência sobrevive a reinício e a mais de uma instância. Só metadados (contagens/totais por unidade); nada de texto livre.
alter table mova.politica_autonomia drop constraint politica_autonomia_operacao_check;
alter table mova.politica_autonomia add constraint politica_autonomia_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL','PRESTACAO_DE_SANGRIA',
                      'CONTA_A_PAGAR_RELATADA','CONTA_PARCELADA_RELATADA','OPERACAO_ENTRE_EMPRESAS'));
alter table mova.operacao_executada drop constraint operacao_executada_operacao_check;
alter table mova.operacao_executada add constraint operacao_executada_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL','PRESTACAO_DE_SANGRIA',
                      'CONTA_A_PAGAR_RELATADA','CONTA_PARCELADA_RELATADA','OPERACAO_ENTRE_EMPRESAS'));
alter table mova.proposta drop constraint proposta_tipo_check;
alter table mova.proposta add constraint proposta_tipo_check
  check (tipo in ('BAIXA_DE_OBRIGACAO','DESPESA_PAGA','NOVA_OBRIGACAO','SOLICITACAO_DE_REVISAO','VINCULO_DE_DOCUMENTO','CONTA_RELATADA','INTERCOMPANY'));

create table mova.aviso_diario (
  id uuid primary key default gen_random_uuid(),
  grupo_jid text not null references mova.grupo_autorizado (grupo_jid),
  data date not null,
  janela text not null check (janela ~ '^[0-2][0-9]:[0-5][0-9]$'),
  -- ENVIADO = mensagem na fila de saída (mesma transação); SEM_MENSAGEM = janela conferida sem nada a dizer (ex.: 15h sem contas)
  situacao text not null default 'RESERVADO' check (situacao in ('RESERVADO', 'ENVIADO', 'SEM_MENSAGEM', 'FALHOU')),
  check ((situacao = 'ENVIADO') = (resposta_id is not null)),
  resumo jsonb not null default '{}'::jsonb check (jsonb_typeof(resumo) = 'object'),
  resposta_id uuid references mova.resposta (id),
  tentativas integer not null default 1 check (tentativas between 1 and 20),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (grupo_jid, data, janela)
);
comment on table mova.aviso_diario is 'Aviso diário de contas a pagar no grupo: uma linha por grupo/data/janela (idempotência). Sem texto livre.';
grant select, insert on mova.aviso_diario to mova_app;
grant update (situacao, resumo, resposta_id, tentativas, atualizado_em) on mova.aviso_diario to mova_app;
-- sem DELETE para o app (histórico do que foi avisado)

-- ------------------------------------------------------------------------- 0026_mova_entregador_notificacoes_pagamento.sql (arquivo 287bd901d7f3fc90c826a9d1832b7091cd2d6ca22845b90184cda4802cac3fee)
-- MOVA (27/11/2026): NOTIFICAÇÃO AUTOMÁTICA DE PAGAMENTO ao entregador + aviso consolidado no grupo financeiro + métricas de atendimento.
--
-- Arquitetura (Transactional Outbox "por leitura confirmada"): o fato é a LIQUIDAÇÃO persistida no Financeiro v2 (qualquer origem:
-- tela, comprovante no grupo, extrato, baixa agrupada, integração futura). O MOVA só lê fatos já confirmados (transação revertida
-- não deixa liquidação), grava aqui UM evento por baixa/destinatário (chave única) e só depois enfileira a mensagem. O estado
-- financeiro nunca depende do WhatsApp; o estado da mensagem (PENDENTE, ENFILEIRADO, ENVIADO, FALHOU...) é só deste módulo.
-- Nada é semeado e nenhuma automação é ligada aqui: sem ENTREGADORES_PAGAMENTO ativa na unidade nada é criado nem enviado.
-- Sem DELETE para o app (histórico auditável).

-- 1) Nova automação por unidade (liga/desliga e pausa individuais, como as demais).
alter table mova.automacao drop constraint automacao_nome_check;
alter table mova.automacao add constraint automacao_nome_check check (nome in ('ENTREGADORES_SEMANAL', 'ENTREGADORES_COBRANCA', 'RECONFERENCIA_EXTRATO', 'ENTREGADORES_RELATORIO', 'ENTREGADORES_AVISO_GRUPO', 'ENTREGADORES_PAGAMENTO'));

-- 2) Marco: a PRIMEIRA passada de uma unidade só fixa o instante; nada anterior vira mensagem (sem disparo retroativo).
create table mova.pagamento_marco (
  unidade_id      uuid primary key,
  organizacao_id  uuid not null,
  marco_em        timestamptz not null default now(),
  criado_em       timestamptz not null default now()
);
grant select, insert on mova.pagamento_marco to mova_app;
grant update (marco_em) on mova.pagamento_marco to mova_app; -- desligada/pausada: o marco acompanha o tempo (religar nao dispara o intervalo)

-- 3) Eventos de notificação (a "caixa de saída" persistente).
create table mova.notificacao_pagamento (
  id               uuid primary key default gen_random_uuid(),
  chave            text not null unique check (length(chave) between 10 and 300),   -- idempotência: fato + destinatário + tipo
  organizacao_id   uuid not null,
  unidade_id       uuid not null,
  entregador       text not null check (length(btrim(entregador)) between 1 and 200),
  destino          text not null check (destino in ('ENTREGADOR', 'GRUPO')),
  tipo             text not null check (tipo in ('PAGAMENTO', 'PAGAMENTO_PARCIAL', 'ESTORNO', 'AVISO_GRUPO')),
  -- PENDENTE: criado, ainda não enfileirado (pagamento com data futura nem chega a ser criado: espera a data) · AGUARDANDO_ENTREGADOR (só o aviso
  -- do grupo): espera o desfecho da mensagem do entregador · ENFILEIRADO: na fila de saída do MOVA · ENVIADO: o Gateway/WhatsApp
  -- aceitou a mensagem · FALHOU: desistência após as tentativas da fila · SEM_TELEFONE / SEM_GRUPO: sem destino cadastrado/autorizado.
  -- Não existe "ENTREGUE": o MOVA ainda não recebe o recibo de entrega do Gateway (ver docs).
  estado           text not null default 'PENDENTE' check (estado in ('PENDENTE', 'AGUARDANDO_ENTREGADOR', 'ENFILEIRADO', 'ENVIADO', 'FALHOU', 'SEM_TELEFONE', 'SEM_GRUPO', 'CANCELADO')),
  evento_pai_id    uuid references mova.notificacao_pagamento (id),     -- aviso do grupo → evento do entregador
  dados            jsonb not null check (jsonb_typeof(dados) = 'object'),  -- retrato persistido do pagamento (a mensagem sai SÓ daqui)
  resposta_id      uuid references mova.resposta (id),                   -- mensagem atual na fila de saída
  tentativas_envio integer not null default 0 check (tentativas_envio between 0 and 20),
  reenvios         integer not null default 0 check (reenvios between 0 and 5),
  ultimo_erro      text check (ultimo_erro is null or length(ultimo_erro) <= 120),
  enviado_em       timestamptz,
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now(),
  check ((estado = 'ENVIADO') = (enviado_em is not null))
);
create index notificacao_pagamento_unidade on mova.notificacao_pagamento (unidade_id, criado_em desc);
create index notificacao_pagamento_pendentes on mova.notificacao_pagamento (estado) where estado in ('PENDENTE', 'AGUARDANDO_ENTREGADOR', 'ENFILEIRADO');
comment on table mova.notificacao_pagamento is 'Caixa de saída das notificações financeiras: uma linha por fato de pagamento e destinatário (chave única). Texto composto só de dados persistidos.';

-- 4) Cada FATO (liquidação + natureza) entra em UM evento só — mesmo que a leitura rode duas vezes ou em duas instâncias.
create table mova.notificacao_pagamento_item (
  liquidacao_id    uuid not null,
  fato             text not null check (fato ~ '^(BAIXA|ESTORNO:[0-9]{1,12})$'),
  unidade_id       uuid not null,
  evento_id        uuid not null references mova.notificacao_pagamento (id),
  criado_em        timestamptz not null default now(),
  primary key (liquidacao_id, fato)
);
create index notificacao_pagamento_item_evento on mova.notificacao_pagamento_item (evento_id);

-- 5) Métricas de atendimento (sem texto de conversa, sem dado financeiro): quanto foi resolvido sem IA.
create table mova.atendimento_metrica (
  dia              date not null,
  unidade_id       uuid not null,
  via              text not null check (via in ('DETERMINISTICA', 'IA', 'FALHA', 'BLOQUEADA')),
  intencao         text not null check (intencao ~ '^[A-Z_]{2,40}$'),
  respostas        integer not null default 0 check (respostas >= 0),
  chamadas_ia      integer not null default 0 check (chamadas_ia >= 0),
  tokens_entrada   bigint not null default 0 check (tokens_entrada >= 0),
  tokens_saida     bigint not null default 0 check (tokens_saida >= 0),
  atualizado_em    timestamptz not null default now(),
  primary key (dia, unidade_id, via, intencao)
);

grant select, insert on mova.notificacao_pagamento, mova.notificacao_pagamento_item, mova.atendimento_metrica to mova_app;
grant update (estado, resposta_id, tentativas_envio, reenvios, ultimo_erro, enviado_em, atualizado_em) on mova.notificacao_pagamento to mova_app;
grant update (respostas, chamadas_ia, tokens_entrada, tokens_saida, atualizado_em) on mova.atendimento_metrica to mova_app;

-- ------------------------------------------------------------------------- 0027_mova_fila_prioridade_limites.sql (arquivo a2052ce4517b25a5d9fc028d77342dc3a7178602398b9103ceda05510aa48cc0)
-- MOVA (28/11/2026): FILA DE SAÍDA COM PRIORIDADE, CATEGORIAS, VALIDADE, ADIAMENTO E LIMITES CONFIGURÁVEIS (sem deploy).
--
-- Reaproveita a fila persistente que já existe (mova.resposta é a caixa de saída: estado, tentativas, lease, id do provedor).
-- Não cria uma segunda fila. Acrescenta, por mensagem: categoria, prioridade, validade, liberação (adiamento) e escopo (empresa/unidade).
-- Atingir um limite NÃO descarta: a mensagem continua PENDENTE com `liberar_em` no futuro; só expira (EXPIRADA, visível e auditável)
-- depois da validade da sua prioridade. Os limites ficam em tabela (por empresa, unidade, grupo e finalidade) e cada mudança é auditada.
-- Nada é semeado: sem regras na tabela valem os limites padrão do código (2.000 / 100 / 500, reserva para a prioridade crítica).
-- Sem DELETE para o app. Aditiva e reversível (recuperacao/reverter-0027.sql).

-- 1) Colunas da fila (defaults compatíveis com o que já existia).
alter table mova.resposta add column categoria text not null default 'PROATIVA'
  check (categoria in ('RESPOSTA', 'ERRO', 'TRANSACIONAL', 'PROATIVA', 'ADMINISTRATIVA', 'ACOMPANHAMENTO', 'REENVIO'));
alter table mova.resposta add column prioridade smallint not null default 1 check (prioridade between 0 and 2);   -- 0 crítica · 1 alta · 2 normal
alter table mova.resposta add column valida_ate timestamptz;                                                      -- após isto: EXPIRADA (nunca some em silêncio)
alter table mova.resposta add column liberar_em timestamptz;                                                      -- adiada até este instante (limite, ritmo, circuito, backoff)
alter table mova.resposta add column motivo_adiamento text check (motivo_adiamento is null or length(motivo_adiamento) <= 60);
alter table mova.resposta add column adiamentos integer not null default 0 check (adiamentos >= 0);
alter table mova.resposta add column organizacao_id uuid;
alter table mova.resposta add column unidade_id uuid;

alter table mova.resposta drop constraint resposta_estado_check;
alter table mova.resposta add constraint resposta_estado_check check (estado in ('PENDENTE', 'ENVIANDO', 'ENVIADA', 'FALHOU', 'SUPRIMIDA', 'EXPIRADA'));

-- A fila é lida por prioridade e depois por ordem de criação, só do que já pode sair.
create index resposta_fila_prioridade on mova.resposta (prioridade, seq) where estado = 'PENDENTE';
create index resposta_envio_dia on mova.resposta (criada_em, categoria) where estado in ('ENVIADA', 'ENVIANDO');

grant update (categoria, prioridade, valida_ate, liberar_em, motivo_adiamento, adiamentos, organizacao_id, unidade_id) on mova.resposta to mova_app;

-- 2) Limites configuráveis. Escopos: GLOBAL ('*'), EMPRESA (organizacao_id), UNIDADE (unidade_id), GRUPO (jid do destino), FINALIDADE (categoria).
create table mova.limite_envio (
  id             uuid primary key default gen_random_uuid(),
  escopo         text not null check (escopo in ('GLOBAL', 'EMPRESA', 'UNIDADE', 'GRUPO', 'FINALIDADE')),
  chave          text not null check (length(chave) between 1 and 120 and (escopo <> 'GLOBAL' or chave = '*')),
  campo          text not null check (campo ~ '^[A-Za-z]{3,40}$'),
  valor          text not null check (length(valor) between 1 and 40),
  ativo          boolean not null default true,
  atualizado_por text not null check (length(atualizado_por) between 1 and 80),
  atualizado_em  timestamptz not null default now(),
  unique (escopo, chave, campo)
);
create table mova.limite_envio_historico (
  seq            bigint generated always as identity primary key,
  escopo         text not null,
  chave          text not null,
  campo          text not null,
  valor_antes    text,
  valor_depois   text,
  ativo_depois   boolean not null,
  ator           text not null,
  justificativa  text not null check (length(btrim(justificativa)) >= 10),
  em             timestamptz not null default now()
);
-- 3) Alertas de uso (70/85/95%) e de represamento: um por faixa/escopo/dia.
create table mova.alerta_envio (
  dia            date not null,
  tipo           text not null check (tipo in ('USO_DIARIO', 'USO_CONVERSA', 'REPRESAMENTO', 'CIRCUITO', 'EXPIRADA')),
  chave          text not null check (length(chave) between 1 and 160),
  faixa          integer not null default 0,
  detalhe        jsonb not null default '{}'::jsonb,
  criado_em      timestamptz not null default now(),
  primary key (dia, tipo, chave, faixa)
);

grant select, insert on mova.limite_envio, mova.limite_envio_historico, mova.alerta_envio to mova_app;
grant update (valor, ativo, atualizado_por, atualizado_em) on mova.limite_envio to mova_app;
grant usage on all sequences in schema mova to mova_app;
comment on table mova.limite_envio is 'Limites de envio do WhatsApp por escopo. Sem linhas valem os padrões do código. Cada alteração grava mova.limite_envio_historico.';

-- ------------------------------------------------------------------------- 0028_mova_identidade_fiscal.sql (arquivo 97bafe89946451a198229db2f0da87d235c5dc92af1ad7ad6209ce6f2d5b6781)
-- MOVA (28/11/2026): IDENTIDADE FISCAL APRENDIDA DAS NOTAS (sem cadastro manual).
--
-- O MOVA passa a guardar, internamente, quem é o prestador (CPF/CNPJ) de cada entregador, deduzido das notas que o Financeiro já tem
-- ligadas às obrigações. Nada é digitado por gestor ou entregador; cada informação guarda a NOTA que a fundamentou (evidência).
--   identidade_fiscal            o prestador (CPF/CNPJ único) e o que se sabe dele (razão social, fantasia, município)
--   identidade_fiscal_vinculo    quem (unidade + entregador) usa esse prestador e em que situação (CONSOLIDADA | EM_REVISAO)
--   identidade_fiscal_evidencia  cada nota analisada: hash, número, chave, valor, tomador, avaliação FORTE/FRACA e motivos
--   identidade_fiscal_tomador    a empresa tomadora de cada unidade (configurada ou aprendida das notas aprovadas)
--   nota_leitura_fiscal          cache da leitura por hash: a mesma nota nunca é lida (nem paga em IA) duas vezes
-- Uma nota continua pertencendo SÓ à empresa tomadora da sua obrigação; o vínculo é por unidade. Sem DELETE para o app.
-- Aditiva e reversível (recuperacao/reverter-0028.sql). Não altera nenhum dado existente.

create table mova.identidade_fiscal (
  id uuid primary key default gen_random_uuid(),
  documento text not null unique check (documento ~ '^[0-9]{11}$' or documento ~ '^[0-9]{14}$'),
  tipo text not null check (tipo in ('CPF', 'CNPJ')),
  razao_social text check (razao_social is null or length(razao_social) <= 200),
  nome_fantasia text check (nome_fantasia is null or length(nome_fantasia) <= 200),
  municipio text check (municipio is null or length(municipio) <= 120),
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now()
);

create table mova.identidade_fiscal_vinculo (
  id uuid primary key default gen_random_uuid(),
  identidade_id uuid references mova.identidade_fiscal (id),
  organizacao_id uuid not null,
  unidade_id uuid not null,
  entregador text not null check (length(entregador) between 1 and 200),
  situacao text not null check (situacao in ('CONSOLIDADA', 'EM_REVISAO')),
  motivo text check (motivo is null or length(motivo) <= 80),
  origem text not null check (origem in ('HISTORICO', 'PRIMEIRA_NOTA', 'NOTA_RECEBIDA', 'REVISAO_ADMINISTRATIVA')),
  candidatos text[] not null default '{}',   -- documentos em disputa (só quando EM_REVISAO)
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now(),
  unique (unidade_id, entregador),
  check ((situacao = 'CONSOLIDADA') = (identidade_id is not null))
);
create index identidade_fiscal_vinculo_identidade on mova.identidade_fiscal_vinculo (identidade_id);
create index identidade_fiscal_vinculo_revisao on mova.identidade_fiscal_vinculo (organizacao_id) where situacao = 'EM_REVISAO';

create table mova.identidade_fiscal_evidencia (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null,
  unidade_id uuid not null,
  entregador text not null,
  semana_inicio date,
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),           -- a nota do Financeiro (histórico) pode não ter o hash do arquivo aqui
  documento_id uuid,
  chave_dedupe text not null check (length(chave_dedupe) between 5 and 100),   -- sha256 do arquivo ou 'doc:<id do documento>': uma nota, uma evidência por unidade
  numero text,
  chave_acesso text,
  prestador_documento text check (prestador_documento is null or prestador_documento ~ '^([0-9]{11}|[0-9]{14})$'),
  tomador_documento text check (tomador_documento is null or tomador_documento ~ '^([0-9]{11}|[0-9]{14})$'),
  valor_centavos bigint,
  competencia date,
  fonte text not null check (fonte in ('FINANCEIRO', 'XML', 'PDF_TEXTO', 'IA')),
  forca text not null check (forca in ('FORTE', 'FRACA')),
  motivos jsonb not null default '[]'::jsonb,
  criada_em timestamptz not null default now(),
  unique (unidade_id, chave_dedupe),
  check (sha256 is not null or documento_id is not null)
);
create index identidade_fiscal_evidencia_entregador on mova.identidade_fiscal_evidencia (unidade_id, entregador);
create index identidade_fiscal_evidencia_chave on mova.identidade_fiscal_evidencia (chave_acesso) where chave_acesso is not null;

create table mova.identidade_fiscal_tomador (
  unidade_id uuid primary key,
  organizacao_id uuid not null,
  documento text check (documento is null or documento ~ '^[0-9]{14}$'),
  situacao text not null check (situacao in ('CONFIGURADO', 'APRENDIDO', 'CONFLITO', 'EVIDENCIA_INSUFICIENTE')),
  notas integer not null default 0,
  entregadores integer not null default 0,
  atualizada_em timestamptz not null default now()
);

create table mova.nota_leitura_fiscal (
  sha256 text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
  fonte text not null check (fonte in ('FINANCEIRO', 'XML', 'PDF_TEXTO', 'IA')),
  dados jsonb not null,
  chamadas_ia integer not null default 0,
  tokens_entrada integer not null default 0,
  tokens_saida integer not null default 0,
  criada_em timestamptz not null default now()
);

grant select, insert on mova.identidade_fiscal, mova.identidade_fiscal_vinculo, mova.identidade_fiscal_evidencia, mova.identidade_fiscal_tomador, mova.nota_leitura_fiscal to mova_app;
grant update (razao_social, nome_fantasia, municipio, atualizada_em) on mova.identidade_fiscal to mova_app;
grant update (identidade_id, situacao, motivo, origem, candidatos, atualizada_em) on mova.identidade_fiscal_vinculo to mova_app;
grant update (documento, situacao, notas, entregadores, atualizada_em) on mova.identidade_fiscal_tomador to mova_app;

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
  ('0012_mova_juros_documental.sql', 'eff9660cdfe1a5a1d969eb3a75e709b5d486a4df6d6e6bcd0555ee9cc8780bba'),
  ('0013_mova_entregadores_cadastro.sql', '6a4f9f8b4214a03602fa74ad573485a29a69056386882a6597310b71614dea3d'),
  ('0014_mova_unidade_sem_grupo.sql', '8c7631710233123f85a0c1cb2752dcbb115606be299269e68bb9294f631e203b'),
  ('0015_mova_pagadores_multiunidade.sql', 'cbcd5e4421952a876fcd0b22ad8c0af582d757096baf3aface6ad43aefea5a96'),
  ('0016_mova_avisos_entregadores.sql', '76b39b7b74f4b4284b87a07c52cc4a3761fe7f5f49b6950a44587f8a93c377dc'),
  ('0017_mova_conversa_contexto.sql', 'b4950c5592e7e19a53fa2916e5b368272ea7712d4137799479349ec096eb9b69'),
  ('0018_mova_orcamento_renovavel.sql', '34c8aa11626450c39523155a0a5ed0b55dc60cf381aceb064c5d1a60371d0a87'),
  ('0019_mova_core_identidade_memoria.sql', 'b0346dc3c70f5ab415c73c764ae7af5d667928159528c7e4eb9359d20372963b'),
  ('0020_mova_core_propostas.sql', '1b7bd5f36f302ec80af081f9f0a2c383ad4c4764d21315ec9967f6313f4a8bd8'),
  ('0021_mova_core_conhecimento.sql', '8374fcaa31978caf36f8e52faf9dc160f0c4f9f03305b33d93d3972de0fadd69'),
  ('0022_mova_orcamento_uso.sql', '5bb150ede6656e4da81669299e1bc8dd61c0409cf53617f125498e4e71f758b9'),
  ('0023_mova_politica_sangria.sql', '7855261f01a9363397032937ea2dbf6cfb62a5f6cabedc2a5ffcda346c513631'),
  ('0024_mova_grupo_multiempresa.sql', '441327e033f00fa8a032da0be652c747f45b509ebc3199ba0167a2ba4eff9c47'),
  ('0025_mova_contas_relatadas_intercompany_avisos.sql', '3cbc7d7db7c79e6e159d309a950aa66071f2346dc4205538addfa81bd690209a'),
  ('0026_mova_entregador_notificacoes_pagamento.sql', '287bd901d7f3fc90c826a9d1832b7091cd2d6ca22845b90184cda4802cac3fee'),
  ('0027_mova_fila_prioridade_limites.sql', 'a2052ce4517b25a5d9fc028d77342dc3a7178602398b9103ceda05510aa48cc0'),
  ('0028_mova_identidade_fiscal.sql', '97bafe89946451a198229db2f0da87d235c5dc92af1ad7ad6209ce6f2d5b6781');
grant select on mova.mova_migracao to mova_app;
revoke all on schema mova from public;
do $$ begin
  -- Supabase: o schema do MOVA nunca fica acessível aos papéis da API pública.
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema mova from anon'; execute 'revoke all on all tables in schema mova from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on schema mova from authenticated'; execute 'revoke all on all tables in schema mova from authenticated'; end if;
end $$;
do $$ declare faltando text; begin
  select string_agg(t, ', ') into faltando from unnest(array['aprovacao', 'auditoria', 'aviso_diario', 'core_conhecimento', 'core_conhecimento_evento', 'core_desafio_vinculo', 'core_memoria_conversa', 'core_proposta', 'core_tentativa_vinculo', 'core_vinculo', 'automacao', 'consumo_ia', 'controle', 'conversa_ativa', 'decisao', 'documento', 'entregador_autorizado', 'entregador_envio', 'evento', 'evidencia', 'fila', 'grupo_autorizado', 'grupo_membros', 'grupo_unidade', 'instancia_gateway', 'mensagem_pendente', 'nota_entregador', 'operacao_executada', 'orcamento_ia', 'orcamento_ia_alerta', 'orcamento_ia_politica', 'participante', 'participante_autorizado', 'politica_autonomia', 'proposta', 'resposta', 'unidade_sem_grupo', 'mova_migracao', 'pagamento_marco', 'notificacao_pagamento', 'notificacao_pagamento_item', 'atendimento_metrica', 'limite_envio', 'limite_envio_historico', 'alerta_envio', 'identidade_fiscal', 'identidade_fiscal_vinculo', 'identidade_fiscal_evidencia', 'identidade_fiscal_tomador', 'nota_leitura_fiscal']) t
   where not exists (select 1 from pg_tables where schemaname = 'mova' and tablename = t);
  if faltando is not null then raise exception 'MOVA instalação: tabelas ausentes: %', faltando; end if;
  -- Única exclusão permitida: mova.conversa_ativa (estado efêmero da conversa; 0005). Nada financeiro, nenhum histórico.
  if exists (select 1 from information_schema.role_table_grants where table_schema = 'mova' and grantee = 'mova_app'
             and (privilege_type = 'TRUNCATE' or (privilege_type = 'DELETE' and table_name <> 'conversa_ativa'))) then
    raise exception 'MOVA instalação: mova_app só pode excluir de mova.conversa_ativa';
  end if;
  if (select rolcanlogin from pg_roles where rolname = 'mova_app') then raise exception 'MOVA instalação: mova_app não pode ter login'; end if;
end $$;
