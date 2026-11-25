-- MOVA — ATUALIZAÇÃO do schema `mova` em PRODUÇÃO (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.
-- Já instaladas (conferidas por nome e sha256): 0001_mova_fundacao.sql, 0002_mova_operacao.sql, 0003_mova_homologacao_privada.sql, 0004_mova_controle_orcamento.sql, 0005_mova_grupos_reais.sql, 0006_mova_politica_resposta.sql, 0007_mova_autonomia_operacoes.sql, 0008_mova_entregadores_automacoes.sql, 0009_mova_baixa_documental.sql, 0010_mova_despesa_documental.sql, 0011_mova_entregadores_rotina.sql, 0012_mova_juros_documental.sql, 0013_mova_entregadores_cadastro.sql, 0014_mova_unidade_sem_grupo.sql, 0015_mova_pagadores_multiunidade.sql
-- Novas: 0016_mova_avisos_entregadores.sql, 0017_mova_conversa_contexto.sql, 0018_mova_orcamento_renovavel.sql, 0020_mova_core_propostas.sql, 0021_mova_core_conhecimento.sql, 0022_mova_orcamento_uso.sql, 0023_mova_politica_sangria.sql, 0024_mova_grupo_multiempresa.sql

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
  if exists (select 1 from mova.mova_migracao where nome = '0020_mova_core_propostas.sql') then raise exception 'MOVA atualização: 0020_mova_core_propostas.sql já aplicada — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0021_mova_core_conhecimento.sql') then raise exception 'MOVA atualização: 0021_mova_core_conhecimento.sql já aplicada — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0022_mova_orcamento_uso.sql') then raise exception 'MOVA atualização: 0022_mova_orcamento_uso.sql já aplicada — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0023_mova_politica_sangria.sql') then raise exception 'MOVA atualização: 0023_mova_politica_sangria.sql já aplicada — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0024_mova_grupo_multiempresa.sql') then raise exception 'MOVA atualização: 0024_mova_grupo_multiempresa.sql já aplicada — nada foi feito'; end if;
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
insert into mova.mova_migracao (nome, sha256) values ('0020_mova_core_propostas.sql', '1b7bd5f36f302ec80af081f9f0a2c383ad4c4764d21315ec9967f6313f4a8bd8');

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
insert into mova.mova_migracao (nome, sha256) values ('0021_mova_core_conhecimento.sql', '8374fcaa31978caf36f8e52faf9dc160f0c4f9f03305b33d93d3972de0fadd69');

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
insert into mova.mova_migracao (nome, sha256) values ('0022_mova_orcamento_uso.sql', '5bb150ede6656e4da81669299e1bc8dd61c0409cf53617f125498e4e71f758b9');

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
insert into mova.mova_migracao (nome, sha256) values ('0023_mova_politica_sangria.sql', '7855261f01a9363397032937ea2dbf6cfb62a5f6cabedc2a5ffcda346c513631');

-- ------------------------------------------------------------------------- 0024_mova_grupo_multiempresa.sql (arquivo 441327e033f00fa8a032da0be652c747f45b509ebc3199ba0167a2ba4eff9c47)
-- MOVA (25/11/2026): GRUPO COMPARTILHADO por duas empresas (caso real: "Contas à Pagar Subway / Açaí").
-- Marca EXPLÍCITA e auditável no grupo: sem ela, um grupo com unidades de duas organizações é recusado na montagem
-- (dominio/configuracao.js). Com ela, cada mensagem continua resolvendo UMA unidade (titular/CNPJ do comprovante, apelido ou
-- pergunta) e o escopo nunca junta organizações; a conversa privada derivada dos participantes passa a poder ter as duas.
-- Só acrescenta a coluna (padrão false): nenhum grupo muda de comportamento até ser marcado.
alter table mova.grupo_autorizado add column if not exists multiempresa boolean not null default false;
comment on column mova.grupo_autorizado.multiempresa is 'Grupo compartilhado por unidades de organizações diferentes (autorização explícita do proprietário). Cada mensagem resolve uma única unidade.';
insert into mova.mova_migracao (nome, sha256) values ('0024_mova_grupo_multiempresa.sql', '441327e033f00fa8a032da0be652c747f45b509ebc3199ba0167a2ba4eff9c47');
