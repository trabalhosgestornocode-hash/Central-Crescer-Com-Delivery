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
