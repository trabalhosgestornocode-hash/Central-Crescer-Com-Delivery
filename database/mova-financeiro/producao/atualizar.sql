-- MOVA — ATUALIZAÇÃO do schema `mova` em PRODUÇÃO (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.
-- Já instaladas (conferidas por nome e sha256): 0001_mova_fundacao.sql, 0002_mova_operacao.sql, 0003_mova_homologacao_privada.sql, 0004_mova_controle_orcamento.sql, 0005_mova_grupos_reais.sql, 0006_mova_politica_resposta.sql, 0007_mova_autonomia_operacoes.sql, 0008_mova_entregadores_automacoes.sql, 0009_mova_baixa_documental.sql, 0010_mova_despesa_documental.sql, 0011_mova_entregadores_rotina.sql, 0012_mova_juros_documental.sql, 0013_mova_entregadores_cadastro.sql, 0014_mova_unidade_sem_grupo.sql, 0015_mova_pagadores_multiunidade.sql
-- Novas: 0016_mova_avisos_entregadores.sql, 0017_mova_conversa_contexto.sql, 0018_mova_orcamento_renovavel.sql

do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'mova') then raise exception 'MOVA atualização: schema mova não existe — nada foi feito'; end if;
  if coalesce((select shobj_description(d.oid, 'pg_database') from pg_database d where d.datname = current_database()), '') like 'MOVA\_HOMOLOGACAO:%' then
    raise exception 'MOVA atualização: banco de HOMOLOGAÇÃO — nada foi feito';
  end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0001_mova_fundacao.sql' and sha256 = '1d4c349167cd023012a2878421a69785b2eeb7da56c6f08d10615e4e3d9180d8') then raise exception 'MOVA atualização: 0001_mova_fundacao.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0002_mova_operacao.sql' and sha256 = '5cdb1d34ae6435ea44d5bc8c36b93e9cf91ebb56e5d62396546f02ed0f5c1e0f') then raise exception 'MOVA atualização: 0002_mova_operacao.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0003_mova_homologacao_privada.sql' and sha256 = '9b090ae2228c673e7fcae0b4dd976e78641d1e580b1cbb6b64c72876d3697ed3') then raise exception 'MOVA atualização: 0003_mova_homologacao_privada.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0004_mova_controle_orcamento.sql' and sha256 = 'd8e3065c8d6603b5707b4b6399c014cfdd665cf13e77f6876fedbc1c135c0c00') then raise exception 'MOVA atualização: 0004_mova_controle_orcamento.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0005_mova_grupos_reais.sql' and sha256 = '2f16af94be7e7c0914fb2550465c6629470257b8aba1580c992e980dbc80a47d') then raise exception 'MOVA atualização: 0005_mova_grupos_reais.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0006_mova_politica_resposta.sql' and sha256 = '1ecdc2f473854479b10487eddb1d1d842683ff3d0cf63d486764a46818261113') then raise exception 'MOVA atualização: 0006_mova_politica_resposta.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0007_mova_autonomia_operacoes.sql' and sha256 = 'cb13d733182446a34947d1b781430af21f654d5bb0f62309aa3a568ae8f1979d') then raise exception 'MOVA atualização: 0007_mova_autonomia_operacoes.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0008_mova_entregadores_automacoes.sql' and sha256 = 'e66e9c662dbfd1c7ddd60092ff5cab082fa7dc230ca08da2524b46821feb6182') then raise exception 'MOVA atualização: 0008_mova_entregadores_automacoes.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0009_mova_baixa_documental.sql' and sha256 = 'b690cafc5aedd8e5bc553ca886690de5d6e61bc88b0f3c95881a725b9a3f2754') then raise exception 'MOVA atualização: 0009_mova_baixa_documental.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0010_mova_despesa_documental.sql' and sha256 = 'f3aab5fe0574e86779b873e263551ebb8577049e3c0d3f3b58e753b8f731673c') then raise exception 'MOVA atualização: 0010_mova_despesa_documental.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0011_mova_entregadores_rotina.sql' and sha256 = 'ff74849e1f40ea2f799ee3c8a5a5be8562bfebf9ecdbde59d6c9e24c3d2ee0ca') then raise exception 'MOVA atualização: 0011_mova_entregadores_rotina.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0012_mova_juros_documental.sql' and sha256 = 'eff9660cdfe1a5a1d969eb3a75e709b5d486a4df6d6e6bcd0555ee9cc8780bba') then raise exception 'MOVA atualização: 0012_mova_juros_documental.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0013_mova_entregadores_cadastro.sql' and sha256 = '6a4f9f8b4214a03602fa74ad573485a29a69056386882a6597310b71614dea3d') then raise exception 'MOVA atualização: 0013_mova_entregadores_cadastro.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0014_mova_unidade_sem_grupo.sql' and sha256 = '8c7631710233123f85a0c1cb2752dcbb115606be299269e68bb9294f631e203b') then raise exception 'MOVA atualização: 0014_mova_unidade_sem_grupo.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0015_mova_pagadores_multiunidade.sql' and sha256 = 'cbcd5e4421952a876fcd0b22ad8c0af582d757096baf3aface6ad43aefea5a96') then raise exception 'MOVA atualização: 0015_mova_pagadores_multiunidade.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0016_mova_avisos_entregadores.sql') then raise exception 'MOVA atualização: 0016_mova_avisos_entregadores.sql já aplicada — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0017_mova_conversa_contexto.sql') then raise exception 'MOVA atualização: 0017_mova_conversa_contexto.sql já aplicada — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0018_mova_orcamento_renovavel.sql') then raise exception 'MOVA atualização: 0018_mova_orcamento_renovavel.sql já aplicada — nada foi feito'; end if;
end $$;

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
insert into mova.mova_migracao (nome, sha256) values ('0016_mova_avisos_entregadores.sql', '76b39b7b74f4b4284b87a07c52cc4a3761fe7f5f49b6950a44587f8a93c377dc');

-- ------------------------------------------------------------------------- 0017_mova_conversa_contexto.sql (arquivo b4950c5592e7e19a53fa2916e5b368272ea7712d4137799479349ec096eb9b69)
-- MOVA — 24/11/2026: contexto CURTO da conversa para perguntas de acompanhamento ("e na Subway?", "só as vencidas").
-- Guarda apenas o RECORTE da última consulta (período e, quando houver, o filtro de fornecedor/categoria) por participante e conversa, no mesmo
-- registro de continuidade que já expira em minutos. Nunca o texto da mensagem, valores ou documentos. Coluna nula = como era.
alter table mova.conversa_ativa add column contexto jsonb check (contexto is null or (jsonb_typeof(contexto) = 'object' and pg_column_size(contexto) <= 512));
insert into mova.mova_migracao (nome, sha256) values ('0017_mova_conversa_contexto.sql', 'b4950c5592e7e19a53fa2916e5b368272ea7712d4137799479349ec096eb9b69');

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
insert into mova.mova_migracao (nome, sha256) values ('0018_mova_orcamento_renovavel.sql', '34c8aa11626450c39523155a0a5ed0b55dc60cf381aceb064c5d1a60371d0a87');
