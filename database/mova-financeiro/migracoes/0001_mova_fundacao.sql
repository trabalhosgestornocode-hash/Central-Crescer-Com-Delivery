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
