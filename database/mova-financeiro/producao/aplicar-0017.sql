-- MOVA — APLICAÇÃO ISOLADA da 0017_mova_conversa_contexto.sql em PRODUÇÃO (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo. Não aplica nenhuma outra migração.
-- Exige as já instaladas (nome + sha256): 0001, 0002, 0003, 0004, 0005, 0006, 0007, 0008, 0009, 0010, 0011, 0012, 0013, 0014, 0015.
-- Compatibilidade: o código ANTERIOR não referencia a coluna nova (INSERT/SELECT por lista de colunas) e continua funcionando.

do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'mova') then raise exception 'MOVA 0017: schema mova não existe — nada foi feito'; end if;
  if coalesce((select shobj_description(d.oid, 'pg_database') from pg_database d where d.datname = current_database()), '') like 'MOVA\_HOMOLOGACAO:%' then
    raise exception 'MOVA 0017: banco de HOMOLOGAÇÃO — nada foi feito';
  end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0001_mova_fundacao.sql' and sha256 = '1d4c349167cd023012a2878421a69785b2eeb7da56c6f08d10615e4e3d9180d8') then raise exception 'MOVA 0017: 0001_mova_fundacao.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0002_mova_operacao.sql' and sha256 = '5cdb1d34ae6435ea44d5bc8c36b93e9cf91ebb56e5d62396546f02ed0f5c1e0f') then raise exception 'MOVA 0017: 0002_mova_operacao.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0003_mova_homologacao_privada.sql' and sha256 = '9b090ae2228c673e7fcae0b4dd976e78641d1e580b1cbb6b64c72876d3697ed3') then raise exception 'MOVA 0017: 0003_mova_homologacao_privada.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0004_mova_controle_orcamento.sql' and sha256 = 'd8e3065c8d6603b5707b4b6399c014cfdd665cf13e77f6876fedbc1c135c0c00') then raise exception 'MOVA 0017: 0004_mova_controle_orcamento.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0005_mova_grupos_reais.sql' and sha256 = '2f16af94be7e7c0914fb2550465c6629470257b8aba1580c992e980dbc80a47d') then raise exception 'MOVA 0017: 0005_mova_grupos_reais.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0006_mova_politica_resposta.sql' and sha256 = '1ecdc2f473854479b10487eddb1d1d842683ff3d0cf63d486764a46818261113') then raise exception 'MOVA 0017: 0006_mova_politica_resposta.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0007_mova_autonomia_operacoes.sql' and sha256 = 'cb13d733182446a34947d1b781430af21f654d5bb0f62309aa3a568ae8f1979d') then raise exception 'MOVA 0017: 0007_mova_autonomia_operacoes.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0008_mova_entregadores_automacoes.sql' and sha256 = 'e66e9c662dbfd1c7ddd60092ff5cab082fa7dc230ca08da2524b46821feb6182') then raise exception 'MOVA 0017: 0008_mova_entregadores_automacoes.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0009_mova_baixa_documental.sql' and sha256 = 'b690cafc5aedd8e5bc553ca886690de5d6e61bc88b0f3c95881a725b9a3f2754') then raise exception 'MOVA 0017: 0009_mova_baixa_documental.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0010_mova_despesa_documental.sql' and sha256 = 'f3aab5fe0574e86779b873e263551ebb8577049e3c0d3f3b58e753b8f731673c') then raise exception 'MOVA 0017: 0010_mova_despesa_documental.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0011_mova_entregadores_rotina.sql' and sha256 = 'ff74849e1f40ea2f799ee3c8a5a5be8562bfebf9ecdbde59d6c9e24c3d2ee0ca') then raise exception 'MOVA 0017: 0011_mova_entregadores_rotina.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0012_mova_juros_documental.sql' and sha256 = 'eff9660cdfe1a5a1d969eb3a75e709b5d486a4df6d6e6bcd0555ee9cc8780bba') then raise exception 'MOVA 0017: 0012_mova_juros_documental.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0013_mova_entregadores_cadastro.sql' and sha256 = '6a4f9f8b4214a03602fa74ad573485a29a69056386882a6597310b71614dea3d') then raise exception 'MOVA 0017: 0013_mova_entregadores_cadastro.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0014_mova_unidade_sem_grupo.sql' and sha256 = '8c7631710233123f85a0c1cb2752dcbb115606be299269e68bb9294f631e203b') then raise exception 'MOVA 0017: 0014_mova_unidade_sem_grupo.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0015_mova_pagadores_multiunidade.sql' and sha256 = 'cbcd5e4421952a876fcd0b22ad8c0af582d757096baf3aface6ad43aefea5a96') then raise exception 'MOVA 0017: 0015_mova_pagadores_multiunidade.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0017_mova_conversa_contexto.sql') then raise exception 'MOVA 0017: já aplicada — nada foi feito'; end if;
  if to_regclass('mova.conversa_ativa') is null then raise exception 'MOVA 0017: tabela mova.conversa_ativa não existe — nada foi feito'; end if;
end $$;

-- ------------------------------------------------------------------------- 0017_mova_conversa_contexto.sql (arquivo b4950c5592e7e19a53fa2916e5b368272ea7712d4137799479349ec096eb9b69)
-- MOVA — 24/11/2026: contexto CURTO da conversa para perguntas de acompanhamento ("e na Subway?", "só as vencidas").
-- Guarda apenas o RECORTE da última consulta (período e, quando houver, o filtro de fornecedor/categoria) por participante e conversa, no mesmo
-- registro de continuidade que já expira em minutos. Nunca o texto da mensagem, valores ou documentos. Coluna nula = como era.
alter table mova.conversa_ativa add column contexto jsonb check (contexto is null or (jsonb_typeof(contexto) = 'object' and pg_column_size(contexto) <= 512));
insert into mova.mova_migracao (nome, sha256) values ('0017_mova_conversa_contexto.sql', 'b4950c5592e7e19a53fa2916e5b368272ea7712d4137799479349ec096eb9b69');
