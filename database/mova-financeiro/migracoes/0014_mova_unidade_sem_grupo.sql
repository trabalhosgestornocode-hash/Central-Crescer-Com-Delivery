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
