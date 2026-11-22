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
