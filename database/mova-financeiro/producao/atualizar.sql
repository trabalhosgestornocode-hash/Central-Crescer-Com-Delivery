-- MOVA — ATUALIZAÇÃO do schema `mova` em PRODUÇÃO (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.
-- Já instaladas (conferidas por nome e sha256): 0001_mova_fundacao.sql, 0002_mova_operacao.sql, 0003_mova_homologacao_privada.sql, 0004_mova_controle_orcamento.sql, 0005_mova_grupos_reais.sql, 0006_mova_politica_resposta.sql, 0007_mova_autonomia_operacoes.sql, 0008_mova_entregadores_automacoes.sql, 0009_mova_baixa_documental.sql, 0010_mova_despesa_documental.sql, 0011_mova_entregadores_rotina.sql, 0012_mova_juros_documental.sql, 0013_mova_entregadores_cadastro.sql, 0014_mova_unidade_sem_grupo.sql
-- Novas: 0015_mova_pagadores_multiunidade.sql

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
  if exists (select 1 from mova.mova_migracao where nome = '0015_mova_pagadores_multiunidade.sql') then raise exception 'MOVA atualização: 0015_mova_pagadores_multiunidade.sql já aplicada — nada foi feito'; end if;
end $$;

-- ------------------------------------------------------------------------- 0015_mova_pagadores_multiunidade.sql (arquivo cbcd5e4421952a876fcd0b22ad8c0af582d757096baf3aface6ad43aefea5a96)
-- MOVA — 24/11/2026: IDENTIFICAÇÃO DA UNIDADE PELO PAGADOR e MOVA nas duas empresas (Açaí no Grau Saci + Subway Saci).
--
-- 1) `pagadores` no CADASTRO da unidade (grupo_unidade e unidade_sem_grupo): lista explícita dos titulares/documentos da CONTA
--    PAGADORA da unidade — ex.: [{"nome":"<titular da conta>"}] em cada unidade (valores reais só no cadastro, nunca no Git). O comprovante pago por essa conta
--    identifica a unidade (dominio/pagador.js). Nunca dá acesso: a conversa só atua nas unidades dela.
-- 2) Unidade SEM grupo (0014) ganha `participantes` (mesma forma da lista de um grupo: ids, telefones, perfil, privado, nome) e
--    `acesso_multiempresa` (padrão false). Com participantes, a pessoa ganha a unidade na conversa privada derivada; juntar duas
--    EMPRESAS na mesma conversa só com acesso_multiempresa = true (autorização explícita, com o motivo da linha).
-- 3) Conta a pagar NOVA (boleto/nota) pode ser AUTOMÁTICA quando uma política CONTA_A_PAGAR explícita o disser (antes era
--    proibido no banco). Nada é semeado: sem política, o MOVA só propõe — e a escrita ainda exige a concessão `registrar_obrigacao`
--    da identidade operacional na unidade (Financeiro v2 0030).
-- O app (mova_app) continua só LENDO o cadastro; gravar é ato do proprietário pelos kits (scripts/mova/*.mjs).

alter table mova.grupo_unidade add column pagadores jsonb not null default '[]'::jsonb
  check (jsonb_typeof(pagadores) = 'array' and jsonb_array_length(pagadores) <= 10);
alter table mova.unidade_sem_grupo add column pagadores jsonb not null default '[]'::jsonb
  check (jsonb_typeof(pagadores) = 'array' and jsonb_array_length(pagadores) <= 10);
alter table mova.unidade_sem_grupo add column participantes jsonb not null default '[]'::jsonb
  check (jsonb_typeof(participantes) = 'array' and jsonb_array_length(participantes) <= 50);
alter table mova.unidade_sem_grupo add column acesso_multiempresa boolean not null default false;

do $$ declare c text; begin
  select conname into c from pg_constraint
   where conrelid = 'mova.politica_autonomia'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) = 'CHECK ((NOT ((nivel = ''APLICAR_AUTOMATICO''::text) AND (operacao = ''CONTA_A_PAGAR''::text))))';
  if c is null then raise exception 'MOVA 0015: trava de conta a pagar automática não encontrada'; end if;
  execute format('alter table mova.politica_autonomia drop constraint %I', c);
end $$;

-- 4) Proposta VINCULO_DE_DOCUMENTO: nota fiscal de uma conta JÁ registrada — só anexa a nota à conta (nenhum valor muda).
do $$ declare c text; begin
  select conname into c from pg_constraint
   where conrelid = 'mova.proposta'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%BAIXA_DE_OBRIGACAO%SOLICITACAO_DE_REVISAO%';
  if c is null then raise exception 'MOVA 0015: lista de tipos de proposta não encontrada'; end if;
  execute format('alter table mova.proposta drop constraint %I', c);
end $$;
alter table mova.proposta add constraint proposta_tipo_check
  check (tipo in ('BAIXA_DE_OBRIGACAO','DESPESA_PAGA','NOVA_OBRIGACAO','SOLICITACAO_DE_REVISAO','VINCULO_DE_DOCUMENTO'));
insert into mova.mova_migracao (nome, sha256) values ('0015_mova_pagadores_multiunidade.sql', 'cbcd5e4421952a876fcd0b22ad8c0af582d757096baf3aface6ad43aefea5a96');
