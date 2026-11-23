-- MOVA — ATUALIZAÇÃO do schema `mova` em PRODUÇÃO (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.
-- Já instaladas (conferidas por nome e sha256): 0001_mova_fundacao.sql, 0002_mova_operacao.sql, 0003_mova_homologacao_privada.sql, 0004_mova_controle_orcamento.sql, 0005_mova_grupos_reais.sql, 0006_mova_politica_resposta.sql, 0007_mova_autonomia_operacoes.sql, 0008_mova_entregadores_automacoes.sql, 0009_mova_baixa_documental.sql, 0011_mova_entregadores_rotina.sql
-- Novas: 0013_mova_entregadores_cadastro.sql, 0014_mova_unidade_sem_grupo.sql

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
  if not exists (select 1 from mova.mova_migracao where nome = '0011_mova_entregadores_rotina.sql' and sha256 = 'ff74849e1f40ea2f799ee3c8a5a5be8562bfebf9ecdbde59d6c9e24c3d2ee0ca') then raise exception 'MOVA atualização: 0011_mova_entregadores_rotina.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0013_mova_entregadores_cadastro.sql') then raise exception 'MOVA atualização: 0013_mova_entregadores_cadastro.sql já aplicada — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0014_mova_unidade_sem_grupo.sql') then raise exception 'MOVA atualização: 0014_mova_unidade_sem_grupo.sql já aplicada — nada foi feito'; end if;
end $$;

-- ------------------------------------------------------------------------- 0013_mova_entregadores_cadastro.sql (arquivo 6a4f9f8b4214a03602fa74ad573485a29a69056386882a6597310b71614dea3d)
-- MOVA — Agente 2 (23/11/2026): CADASTRO COMPLETO DOS ENTREGADORES (fonte ÚNICA de contatos, usada pelo Financeiro e pelo MOVA).
-- Nada é apagado e nenhum dado existente muda. Toda alteração (troca de número, nome de exibição, observação, desativação)
-- ENCERRA a linha vigente (ativo = false, quem, quando e por quê) e, quando for o caso, abre uma linha nova: o histórico é a
-- própria sequência de linhas (valor anterior e novo, ator e horário), sem UPDATE de dado cadastral.
--
--   * observacoes: anotação operacional (opcional, até 500 caracteres). CPF, Pix e afins NÃO têm coluna (não são pedidos).
--   * revogado_por / motivo_revogacao: quem encerrou a linha e por quê.

alter table mova.entregador_autorizado
  add column observacoes text check (observacoes is null or length(observacoes) <= 500),
  add column revogado_por uuid,
  add column motivo_revogacao text check (motivo_revogacao is null or motivo_revogacao in ('DESATIVADO', 'TROCA_DE_NUMERO', 'EDICAO'));

grant insert (observacoes) on mova.entregador_autorizado to mova_app;
grant update (revogado_por, motivo_revogacao) on mova.entregador_autorizado to mova_app;
insert into mova.mova_migracao (nome, sha256) values ('0013_mova_entregadores_cadastro.sql', '6a4f9f8b4214a03602fa74ad573485a29a69056386882a6597310b71614dea3d');

-- ------------------------------------------------------------------------- 0014_mova_unidade_sem_grupo.sql (arquivo 8c7631710233123f85a0c1cb2752dcbb115606be299269e68bb9294f631e203b)
-- MOVA — 23/11/2026: UNIDADE ATENDIDA SEM GRUPO (ex.: Subway Saci). Até aqui uma unidade só existia no MOVA pelo grupo
-- autorizado dela (mova.grupo_unidade). Esta tabela registra a unidade SEM grupo, para o cadastro e a rotina PRIVADA dos
-- entregadores e para as leituras da identidade de serviço — sem criar conversa nenhuma:
--   * nenhum grupo é cadastrado aqui; sem grupo não há aviso nem relatório em grupo (a rotina pula: SEM_GRUPO_DA_UNIDADE);
--   * a unidade ainda precisa estar em MOVA_OPERACAO_UNIDADES e ter a concessão "ver" da identidade do MOVA no Financeiro;
--   * fontes de faturamento próprias da unidade (Subway: SWF no balcão; iFood e 99Food só pelos relatórios oficiais);
--   * se a mesma unidade também estiver num grupo ativo, vale o cadastro do grupo (esta linha é ignorada).
-- O app (mova_app) só LÊ. Gravar é ato do proprietário pelo kit gerado (scripts/mova/unidadeSemGrupo.mjs), revisado antes.

create table mova.unidade_sem_grupo (
  unidade_id       uuid primary key,
  organizacao_id   uuid not null,
  nome             text not null check (length(nome) between 1 and 80),
  empresa          text check (empresa is null or length(empresa) <= 80),
  apelidos         text[] not null default '{}',
  documentos       text[] not null default '{}',
  fontes           jsonb not null default '{"situacao":"A_CONFIRMAR"}'::jsonb,
  ativo            boolean not null default false,
  motivo           text not null check (length(motivo) between 10 and 300),
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now()
);

grant select on mova.unidade_sem_grupo to mova_app;
insert into mova.mova_migracao (nome, sha256) values ('0014_mova_unidade_sem_grupo.sql', '8c7631710233123f85a0c1cb2752dcbb115606be299269e68bb9294f631e203b');
