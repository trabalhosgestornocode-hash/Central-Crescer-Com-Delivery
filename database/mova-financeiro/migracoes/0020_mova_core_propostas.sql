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
