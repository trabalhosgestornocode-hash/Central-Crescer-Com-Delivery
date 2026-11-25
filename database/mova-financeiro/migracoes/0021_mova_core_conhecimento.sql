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
