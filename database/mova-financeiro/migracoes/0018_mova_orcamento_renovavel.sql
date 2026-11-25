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
