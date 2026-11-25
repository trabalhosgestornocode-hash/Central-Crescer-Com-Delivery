-- MOVA CORE — F2 (24/11/2026): VÍNCULO participante do WhatsApp ↔ usuário da plataforma e MEMÓRIA persistente do fio.
-- Revisão do rascunho docs/mova-core/rascunhos (agora no schema próprio `mova`, prefixo core_, papel mova_app).
-- Aditiva: nenhuma tabela existente muda. Sem linhas, o MOVA se comporta como hoje (sem vínculo ⇒ só o que a lista de
-- participantes já permite; sem memória ⇒ continuidade curta atual). APLICAÇÃO: só no banco ISOLADO de homologação até
-- autorização específica para produção (backup + janela própria, como 0011/0029).
--
-- Regras codificadas no esquema (o código repete todas; o banco é a última barreira):
--   • vínculo nasce SÓ por CODIGO_AUTENTICADO (gerado na plataforma, confirmado no privado) ou APROVACAO_ADMIN (usuarios.gerenciar);
--   • a pessoa no WhatsApp é a chave CANÔNICA da entrada da lista (pessoaId ou hash dos JIDs), nunca telefone digitado;
--   • no máximo UM vínculo ATIVO por (organização, chave) e por (organização, perfil) — índice único parcial (concorrência);
--   • o código só existe como hash com sal; uso ÚNICO (consumido_em, consumo condicional); validade ≤ 10 min no próprio CHECK;
--   • tentativas: registro por chave; o limite por hora é contado sob trava consultiva da chave (atômico entre processos);
--   • revogação é registro (estado REVOGADO + quem/quando/motivo), nunca DELETE; papel/permissões NÃO são copiados;
--   • memória: chave organização|conversa|participante (privado e grupo nunca dividem linha), versão para escrita concorrente
--     (compare-and-set), tamanho limitado, validade (expira_em) para a política de retenção e exclusão a pedido.

create table mova.core_vinculo (
  id              uuid primary key default gen_random_uuid(),
  organizacao_id  uuid not null,
  chave_canonica  text not null check (length(chave_canonica) between 8 and 128),
  conta_id        uuid,
  perfil_id       uuid not null,
  metodo          text not null check (metodo in ('CODIGO_AUTENTICADO', 'APROVACAO_ADMIN')),
  estado          text not null default 'ATIVO' check (estado in ('ATIVO', 'REVOGADO')),
  criado_por      text,
  criado_em       timestamptz not null default now(),
  revogado_em     timestamptz,
  revogado_por    text,
  motivo_revogacao text check (motivo_revogacao is null or length(motivo_revogacao) <= 120),
  check ((estado = 'REVOGADO') = (revogado_em is not null)),
  check (metodo <> 'APROVACAO_ADMIN' or criado_por is not null)
);
create unique index core_vinculo_ativo_por_pessoa on mova.core_vinculo (organizacao_id, chave_canonica) where estado = 'ATIVO';
create unique index core_vinculo_ativo_por_perfil on mova.core_vinculo (organizacao_id, perfil_id) where estado = 'ATIVO';

create table mova.core_desafio_vinculo (
  id              uuid primary key default gen_random_uuid(),
  organizacao_id  uuid not null,
  conta_id        uuid,
  perfil_id       uuid not null,
  codigo_hash     text not null check (codigo_hash ~ '^[0-9a-f]{64}$'),
  sal             text not null check (length(sal) between 16 and 64),
  criado_em       timestamptz not null default now(),
  expira_em       timestamptz not null,
  consumido_em    timestamptz,
  substituido_em  timestamptz,
  check (expira_em > criado_em and expira_em <= criado_em + interval '10 minutes')
);
create index core_desafio_aberto on mova.core_desafio_vinculo (organizacao_id) where consumido_em is null and substituido_em is null;

create table mova.core_tentativa_vinculo (
  id              bigint generated always as identity primary key,
  chave_canonica  text not null check (length(chave_canonica) between 8 and 128),
  em              timestamptz not null default now()
);
create index core_tentativa_recente on mova.core_tentativa_vinculo (chave_canonica, em);

create table mova.core_memoria_conversa (
  chave           text primary key check (length(chave) <= 300),
  organizacao_id  uuid not null,
  conversa_id     text not null check (length(conversa_id) <= 160),
  participante_id text not null check (length(participante_id) <= 160),
  estado          jsonb not null check (jsonb_typeof(estado) = 'object' and pg_column_size(estado) <= 262144),
  versao          bigint not null default 1 check (versao >= 1),
  atualizado_em   timestamptz not null default now(),
  expira_em       timestamptz not null,
  check (chave = organizacao_id::text || '|' || conversa_id || '|' || participante_id)
);
create index core_memoria_por_org on mova.core_memoria_conversa (organizacao_id, atualizado_em);
create index core_memoria_vencida on mova.core_memoria_conversa (expira_em);

-- Acesso: só o papel de operação do MOVA, SEM DELETE em nenhuma (a regra da instalação continua: mova_app só exclui de
-- mova.conversa_ativa). Revogação e consumo são registro; EXCLUSÃO de memória (a pedido ou pela retenção) é APAGAMENTO do
-- conteúdo: estado vira '{}' com apagada_em/motivo — a linha fica só como prova de que foi apagada, sem nenhum dado.
-- Tentativas antigas não contam (janela de 1 h na consulta); o expurgo físico é tarefa de manutenção do proprietário.
alter table mova.core_memoria_conversa
  add column apagada_em timestamptz,
  add column motivo_apagamento text check (motivo_apagamento is null or motivo_apagamento in ('PEDIDO', 'RETENCAO', 'REVOGACAO')),
  add constraint core_memoria_apagada_sem_conteudo check (apagada_em is null or estado = '{}'::jsonb);
grant select, insert, update on mova.core_vinculo, mova.core_desafio_vinculo, mova.core_memoria_conversa to mova_app;
grant select, insert on mova.core_tentativa_vinculo to mova_app;
