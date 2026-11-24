-- MOVA CORE — F2 (RASCUNHO, NÃO APLICADO EM PRODUÇÃO): vínculo WhatsApp ↔ plataforma e memória do fio de conversa.
-- Aplicação só com autorização específica, backup e janela própria (como 0011/0029). Nada aqui liga comportamento: sem linhas, o MOVA
-- se comporta como hoje (sem vínculo ⇒ só o que a lista de participantes já permite; sem memória ⇒ histórico curto atual).
--
-- Regras de identidade codificadas no esquema:
--   • vínculo nasce SÓ por CODIGO_AUTENTICADO (gerado na plataforma, confirmado no privado) ou APROVACAO_ADMIN (usuarios.gerenciar);
--   • a chave da pessoa no WhatsApp é a CANÔNICA da entrada da lista (pessoaId ou hash dos JIDs), nunca o telefone digitado;
--   • um vínculo ATIVO por (organização, chave canônica) e por (organização, perfil);
--   • o código é guardado só como hash com sal; uso único; expira em 10 min; 5 tentativas por hora;
--   • revogação é registro (estado REVOGADO + quem/quando), nunca delete; papel/permissões NÃO são copiados (relidos por requisição).
begin;

create schema if not exists mova_core;

create table mova_core.vinculo (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null,
  chave_canonica text not null check (length(chave_canonica) between 8 and 128),
  conta_id uuid not null,
  perfil_id uuid not null,
  metodo text not null check (metodo in ('CODIGO_AUTENTICADO', 'APROVACAO_ADMIN')),
  estado text not null default 'ATIVO' check (estado in ('ATIVO', 'REVOGADO')),
  aprovado_por uuid,
  criado_em timestamptz not null default now(),
  revogado_em timestamptz,
  revogado_por uuid,
  check ((estado = 'REVOGADO') = (revogado_em is not null)),
  check (metodo <> 'APROVACAO_ADMIN' or aprovado_por is not null)
);
create unique index vinculo_ativo_por_pessoa on mova_core.vinculo (organizacao_id, chave_canonica) where estado = 'ATIVO';
create unique index vinculo_ativo_por_perfil on mova_core.vinculo (organizacao_id, perfil_id) where estado = 'ATIVO';

create table mova_core.desafio_vinculo (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null,
  conta_id uuid not null,
  perfil_id uuid not null,
  codigo_hash text not null,
  sal text not null,
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null,
  consumido_em timestamptz,
  check (expira_em > criado_em and expira_em <= criado_em + interval '10 minutes')
);
create index desafio_aberto on mova_core.desafio_vinculo (organizacao_id) where consumido_em is null;

create table mova_core.tentativa_vinculo (
  chave_canonica text not null,
  em timestamptz not null default now()
);
create index tentativa_recente on mova_core.tentativa_vinculo (chave_canonica, em);

-- Memória do fio: chave = organização|conversa|participante (privado e grupo NUNCA compartilham linha).
-- Guarda resumos SEM valores, entidades, decisões e o mapa de referências opacas; fatos com valor expiram em 10 min e não
-- são fonte de resposta (o verificador exige consulta nova). Tamanho limitado; fio vence em 24 h (arquivo sem valores).
create table mova_core.memoria_conversa (
  chave text primary key check (length(chave) <= 300),
  organizacao_id uuid not null,
  estado jsonb not null check (jsonb_typeof(estado) = 'object' and pg_column_size(estado) <= 65536),
  atualizado_em timestamptz not null default now()
);
create index memoria_por_org on mova_core.memoria_conversa (organizacao_id, atualizado_em);

-- Acesso: só o papel de operação do MOVA; leitor (relatórios) não lê memória nem desafios.
revoke all on all tables in schema mova_core from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'mova_operacao') then
    grant usage on schema mova_core to mova_operacao;
    grant select, insert, update on mova_core.vinculo, mova_core.desafio_vinculo, mova_core.memoria_conversa to mova_operacao;
    grant select, insert, delete on mova_core.tentativa_vinculo to mova_operacao;
  end if;
end $$;

commit;
-- ROLLBACK (só antes de qualquer vínculo real): drop schema mova_core cascade;
