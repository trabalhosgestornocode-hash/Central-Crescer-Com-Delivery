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
