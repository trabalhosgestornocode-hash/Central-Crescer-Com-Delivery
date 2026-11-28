-- MOVA (28/11/2026): IDENTIDADE FISCAL APRENDIDA DAS NOTAS (sem cadastro manual).
--
-- O MOVA passa a guardar, internamente, quem é o prestador (CPF/CNPJ) de cada entregador, deduzido das notas que o Financeiro já tem
-- ligadas às obrigações. Nada é digitado por gestor ou entregador; cada informação guarda a NOTA que a fundamentou (evidência).
--   identidade_fiscal            o prestador (CPF/CNPJ único) e o que se sabe dele (razão social, fantasia, município)
--   identidade_fiscal_vinculo    quem (unidade + entregador) usa esse prestador e em que situação (CONSOLIDADA | EM_REVISAO)
--   identidade_fiscal_evidencia  cada nota analisada: hash, número, chave, valor, tomador, avaliação FORTE/FRACA e motivos
--   identidade_fiscal_tomador    a empresa tomadora de cada unidade (configurada ou aprendida das notas aprovadas)
--   nota_leitura_fiscal          cache da leitura por hash: a mesma nota nunca é lida (nem paga em IA) duas vezes
-- Uma nota continua pertencendo SÓ à empresa tomadora da sua obrigação; o vínculo é por unidade. Sem DELETE para o app.
-- Aditiva e reversível (recuperacao/reverter-0028.sql). Não altera nenhum dado existente.

create table mova.identidade_fiscal (
  id uuid primary key default gen_random_uuid(),
  documento text not null unique check (documento ~ '^[0-9]{11}$' or documento ~ '^[0-9]{14}$'),
  tipo text not null check (tipo in ('CPF', 'CNPJ')),
  razao_social text check (razao_social is null or length(razao_social) <= 200),
  nome_fantasia text check (nome_fantasia is null or length(nome_fantasia) <= 200),
  municipio text check (municipio is null or length(municipio) <= 120),
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now()
);

create table mova.identidade_fiscal_vinculo (
  id uuid primary key default gen_random_uuid(),
  identidade_id uuid references mova.identidade_fiscal (id),
  organizacao_id uuid not null,
  unidade_id uuid not null,
  entregador text not null check (length(entregador) between 1 and 200),
  situacao text not null check (situacao in ('CONSOLIDADA', 'EM_REVISAO')),
  motivo text check (motivo is null or length(motivo) <= 80),
  origem text not null check (origem in ('HISTORICO', 'PRIMEIRA_NOTA', 'NOTA_RECEBIDA', 'REVISAO_ADMINISTRATIVA')),
  candidatos text[] not null default '{}',   -- documentos em disputa (só quando EM_REVISAO)
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now(),
  unique (unidade_id, entregador),
  check ((situacao = 'CONSOLIDADA') = (identidade_id is not null))
);
create index identidade_fiscal_vinculo_identidade on mova.identidade_fiscal_vinculo (identidade_id);
create index identidade_fiscal_vinculo_revisao on mova.identidade_fiscal_vinculo (organizacao_id) where situacao = 'EM_REVISAO';

create table mova.identidade_fiscal_evidencia (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null,
  unidade_id uuid not null,
  entregador text not null,
  semana_inicio date,
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),           -- a nota do Financeiro (histórico) pode não ter o hash do arquivo aqui
  documento_id uuid,
  chave_dedupe text not null check (length(chave_dedupe) between 5 and 100),   -- sha256 do arquivo ou 'doc:<id do documento>': uma nota, uma evidência por unidade
  numero text,
  chave_acesso text,
  prestador_documento text check (prestador_documento is null or prestador_documento ~ '^([0-9]{11}|[0-9]{14})$'),
  tomador_documento text check (tomador_documento is null or tomador_documento ~ '^([0-9]{11}|[0-9]{14})$'),
  valor_centavos bigint,
  competencia date,
  fonte text not null check (fonte in ('FINANCEIRO', 'XML', 'PDF_TEXTO', 'IA')),
  forca text not null check (forca in ('FORTE', 'FRACA')),
  motivos jsonb not null default '[]'::jsonb,
  criada_em timestamptz not null default now(),
  unique (unidade_id, chave_dedupe),
  check (sha256 is not null or documento_id is not null)
);
create index identidade_fiscal_evidencia_entregador on mova.identidade_fiscal_evidencia (unidade_id, entregador);
create index identidade_fiscal_evidencia_chave on mova.identidade_fiscal_evidencia (chave_acesso) where chave_acesso is not null;

create table mova.identidade_fiscal_tomador (
  unidade_id uuid primary key,
  organizacao_id uuid not null,
  documento text check (documento is null or documento ~ '^[0-9]{14}$'),
  situacao text not null check (situacao in ('CONFIGURADO', 'APRENDIDO', 'CONFLITO', 'EVIDENCIA_INSUFICIENTE')),
  notas integer not null default 0,
  entregadores integer not null default 0,
  atualizada_em timestamptz not null default now()
);

create table mova.nota_leitura_fiscal (
  sha256 text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
  fonte text not null check (fonte in ('FINANCEIRO', 'XML', 'PDF_TEXTO', 'IA')),
  dados jsonb not null,
  chamadas_ia integer not null default 0,
  tokens_entrada integer not null default 0,
  tokens_saida integer not null default 0,
  criada_em timestamptz not null default now()
);

grant select, insert on mova.identidade_fiscal, mova.identidade_fiscal_vinculo, mova.identidade_fiscal_evidencia, mova.identidade_fiscal_tomador, mova.nota_leitura_fiscal to mova_app;
grant update (razao_social, nome_fantasia, municipio, atualizada_em) on mova.identidade_fiscal to mova_app;
grant update (identidade_id, situacao, motivo, origem, candidatos, atualizada_em) on mova.identidade_fiscal_vinculo to mova_app;
grant update (documento, situacao, notas, entregadores, atualizada_em) on mova.identidade_fiscal_tomador to mova_app;
