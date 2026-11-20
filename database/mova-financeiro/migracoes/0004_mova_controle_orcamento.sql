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
