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
