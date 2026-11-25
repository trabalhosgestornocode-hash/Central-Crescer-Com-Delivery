-- MOVA — PROPOSTAS DO MOVA CORE em PRODUÇÃO: aplica SÓ 0020_mova_core_propostas.sql (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo. Não aplica 0019 nem 0021.
-- Exige as já instaladas (nome + sha256): 0001, 0002, 0003, 0004, 0005, 0006, 0007, 0008, 0009, 0010, 0011, 0012, 0013, 0014, 0015, 0016, 0017, 0018, 0022. Reversão: producao/reverter-propostas-core.sql.
-- Compatibilidade: o código anterior não lê a tabela; o código novo só a usa com MOVA_CORE_OPERACOES ligado.

do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'mova') then raise exception 'MOVA 0020: schema mova não existe — nada foi feito'; end if;
  if coalesce((select shobj_description(d.oid, 'pg_database') from pg_database d where d.datname = current_database()), '') like 'MOVA\_HOMOLOGACAO:%' then
    raise exception 'MOVA 0020: banco de HOMOLOGAÇÃO — nada foi feito';
  end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0001_mova_fundacao.sql' and sha256 = '1d4c349167cd023012a2878421a69785b2eeb7da56c6f08d10615e4e3d9180d8') then raise exception 'MOVA 0020: 0001_mova_fundacao.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0002_mova_operacao.sql' and sha256 = '5cdb1d34ae6435ea44d5bc8c36b93e9cf91ebb56e5d62396546f02ed0f5c1e0f') then raise exception 'MOVA 0020: 0002_mova_operacao.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0003_mova_homologacao_privada.sql' and sha256 = '9b090ae2228c673e7fcae0b4dd976e78641d1e580b1cbb6b64c72876d3697ed3') then raise exception 'MOVA 0020: 0003_mova_homologacao_privada.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0004_mova_controle_orcamento.sql' and sha256 = 'd8e3065c8d6603b5707b4b6399c014cfdd665cf13e77f6876fedbc1c135c0c00') then raise exception 'MOVA 0020: 0004_mova_controle_orcamento.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0005_mova_grupos_reais.sql' and sha256 = '2f16af94be7e7c0914fb2550465c6629470257b8aba1580c992e980dbc80a47d') then raise exception 'MOVA 0020: 0005_mova_grupos_reais.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0006_mova_politica_resposta.sql' and sha256 = '1ecdc2f473854479b10487eddb1d1d842683ff3d0cf63d486764a46818261113') then raise exception 'MOVA 0020: 0006_mova_politica_resposta.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0007_mova_autonomia_operacoes.sql' and sha256 = 'cb13d733182446a34947d1b781430af21f654d5bb0f62309aa3a568ae8f1979d') then raise exception 'MOVA 0020: 0007_mova_autonomia_operacoes.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0008_mova_entregadores_automacoes.sql' and sha256 = 'e66e9c662dbfd1c7ddd60092ff5cab082fa7dc230ca08da2524b46821feb6182') then raise exception 'MOVA 0020: 0008_mova_entregadores_automacoes.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0009_mova_baixa_documental.sql' and sha256 = 'b690cafc5aedd8e5bc553ca886690de5d6e61bc88b0f3c95881a725b9a3f2754') then raise exception 'MOVA 0020: 0009_mova_baixa_documental.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0010_mova_despesa_documental.sql' and sha256 = 'f3aab5fe0574e86779b873e263551ebb8577049e3c0d3f3b58e753b8f731673c') then raise exception 'MOVA 0020: 0010_mova_despesa_documental.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0011_mova_entregadores_rotina.sql' and sha256 = 'ff74849e1f40ea2f799ee3c8a5a5be8562bfebf9ecdbde59d6c9e24c3d2ee0ca') then raise exception 'MOVA 0020: 0011_mova_entregadores_rotina.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0012_mova_juros_documental.sql' and sha256 = 'eff9660cdfe1a5a1d969eb3a75e709b5d486a4df6d6e6bcd0555ee9cc8780bba') then raise exception 'MOVA 0020: 0012_mova_juros_documental.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0013_mova_entregadores_cadastro.sql' and sha256 = '6a4f9f8b4214a03602fa74ad573485a29a69056386882a6597310b71614dea3d') then raise exception 'MOVA 0020: 0013_mova_entregadores_cadastro.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0014_mova_unidade_sem_grupo.sql' and sha256 = '8c7631710233123f85a0c1cb2752dcbb115606be299269e68bb9294f631e203b') then raise exception 'MOVA 0020: 0014_mova_unidade_sem_grupo.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0015_mova_pagadores_multiunidade.sql' and sha256 = 'cbcd5e4421952a876fcd0b22ad8c0af582d757096baf3aface6ad43aefea5a96') then raise exception 'MOVA 0020: 0015_mova_pagadores_multiunidade.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0016_mova_avisos_entregadores.sql' and sha256 = '76b39b7b74f4b4284b87a07c52cc4a3761fe7f5f49b6950a44587f8a93c377dc') then raise exception 'MOVA 0020: 0016_mova_avisos_entregadores.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0017_mova_conversa_contexto.sql' and sha256 = 'b4950c5592e7e19a53fa2916e5b368272ea7712d4137799479349ec096eb9b69') then raise exception 'MOVA 0020: 0017_mova_conversa_contexto.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0018_mova_orcamento_renovavel.sql' and sha256 = '34c8aa11626450c39523155a0a5ed0b55dc60cf381aceb064c5d1a60371d0a87') then raise exception 'MOVA 0020: 0018_mova_orcamento_renovavel.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0022_mova_orcamento_uso.sql' and sha256 = '5bb150ede6656e4da81669299e1bc8dd61c0409cf53617f125498e4e71f758b9') then raise exception 'MOVA 0020: 0022_mova_orcamento_uso.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0020_mova_core_propostas.sql') then raise exception 'MOVA 0020: já aplicada — nada foi feito'; end if;
  if to_regclass('mova.core_proposta') is not null then raise exception 'MOVA 0020: mova.core_proposta já existe — nada foi feito'; end if;
end $$;

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

do $$ begin
  if not (has_table_privilege('mova_app', 'mova.core_proposta', 'select') and has_table_privilege('mova_app', 'mova.core_proposta', 'insert') and has_table_privilege('mova_app', 'mova.core_proposta', 'update')) then
    raise exception 'MOVA 0020: mova_app sem permissão em mova.core_proposta — tudo desfeito'; end if;
  if has_table_privilege('mova_app', 'mova.core_proposta', 'delete') then raise exception 'MOVA 0020: mova_app não pode apagar propostas — tudo desfeito'; end if;
end $$;
