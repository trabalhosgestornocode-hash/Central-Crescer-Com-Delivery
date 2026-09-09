-- =====================================================================
-- MIGRATION 079 — Parser Food Delivery: custo operacional real com
-- entregadores (cadastro mestre + lançamentos + override idempotente)
-- =====================================================================
-- OBJETIVO
--   Até aqui o Parser Food Delivery representava SOMENTE o que o relatório
--   do iFood registrou. Esta migration adiciona a camada de AJUSTES
--   OPERACIONAIS, sem tocar na lógica de importação:
--
--   1. parser_fd_entregadores — cadastro MESTRE de entregadores por unidade
--      (dedup por nome normalizado; ativar/inativar sem apagar histórico;
--      isolamento por unidade). `parser_fd_pedidos` ganha `entregador_id`
--      NULLABLE, preenchido progressivamente por reconhecimento — NUNCA
--      obrigatório, o nome-texto do relatório continua a fonte histórica.
--
--   2. parser_fd_lancamentos — TABELA ÚNICA de ajustes com origem
--      ('manual' | 'taxa_adicional' | 'avulso'). NUNCA representa um pedido
--      do iFood (esses continuam exclusivamente em parser_fd_pedidos).
--      Soft-delete (excluido/excluido_em/excluido_por/motivo_exclusao).
--      Entram no "custo real com entregadores" (composição por origem),
--      calculado na aplicação — `parser_fd_importacoes.taxas_validas`
--      CONTINUA representando exclusivamente o iFood (Central de
--      Performance não muda).
--
--   3. parser_fd_pedido_overrides — override manual de classificação
--      (recebe/não recebe taxa) com IDENTIDADE ESTÁVEL do pedido
--      (unidade + numero_pedido + hora operacional). Isto torna o override
--      IDEMPOTENTE contra reimportação: reimportar o período não apaga a
--      decisão humana. Backfill a partir das colunas
--      `classificacao_override_*` já existentes em parser_fd_pedidos.
--
--   4. parser_fd_auditoria — novas ações + colunas antes/depois;
--      `importacao_id` deixa de ser NOT NULL (ações de lançamento/
--      entregador não têm importação). Função transacional
--      `parser_fd_lancamento_hard_delete` (snapshot + delete na mesma
--      transação, só para uso do backend/SuperAdmin).
--
-- PRÉ-REQUISITOS: migrations 037, 038, 039, 040, 046 aplicadas.
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- SEM novas extensões (só `pgcrypto`, já instalada).
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- ROLLBACK: 079_rollback.sql
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. ENTREGADORES — cadastro mestre por unidade.
--    `nome_chave` = normalização feita pela aplicação (lower + sem acento
--    + espaços colapsados); a unicidade por (unidade_id, nome_chave)
--    impede duplicidade por caixa/acento/espaço. `nome_original` guarda
--    o 1º nome como veio do relatório iFood (auditoria).
-- ---------------------------------------------------------------------
create table if not exists parser_fd_entregadores (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  nome text not null,
  nome_chave text not null,
  nome_original text,
  ativo boolean not null default true,
  origem_cadastro text not null default 'manual'
    check (origem_cadastro in ('manual', 'reconhecido_ifood')),
  criado_por uuid references perfis(id) on delete set null,
  criado_por_nome text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create unique index if not exists uq_pfdentr_unidade_chave on parser_fd_entregadores(unidade_id, nome_chave);
create index if not exists idx_pfdentr_unidade_ativo on parser_fd_entregadores(unidade_id, ativo);
create index if not exists idx_pfdentr_org on parser_fd_entregadores(organizacao_id);

drop trigger if exists trg_pfdentr_atualizado_em on parser_fd_entregadores;
create trigger trg_pfdentr_atualizado_em before update on parser_fd_entregadores
  for each row execute function parser_fd_set_atualizado_em();

-- Vínculo progressivo do pedido importado ao cadastro mestre. NULLABLE,
-- NUNCA obrigatório: o ranking usa entregador_id quando existe, senão
-- cai no nome-texto normalizado (comportamento atual, sem regressão).
alter table parser_fd_pedidos
  add column if not exists entregador_id uuid references parser_fd_entregadores(id) on delete set null;
create index if not exists idx_pfdped_entregador_id on parser_fd_pedidos(entregador_id);

-- ---------------------------------------------------------------------
-- 2. LANÇAMENTOS — ajustes operacionais (origem SEMPRE ≠ iFood).
--    CHECK de forma por origem:
--      taxa_adicional -> numero_pedido not null + motivo not null
--                        (pedido_id pode virar NULL se o pedido for
--                         excluído depois — o lançamento é preservado e a
--                         UI mostra "pedido original indisponível";
--                         NUNCA vira 'avulso')
--      avulso         -> sem vínculo com pedido; motivo not null
--      manual         -> motivo not null (a app usa 'inclusao_manual'
--                        como default quando não informado)
-- ---------------------------------------------------------------------
create table if not exists parser_fd_lancamentos (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  origem text not null check (origem in ('manual', 'taxa_adicional', 'avulso')),
  pedido_id uuid references parser_fd_pedidos(id) on delete set null,
  numero_pedido text,
  importacao_id uuid,                                -- snapshot, sem FK (sobrevive à exclusão da importação)
  entregador_id uuid not null references parser_fd_entregadores(id) on delete restrict,
  entregador_nome_snapshot text not null,
  data date not null,
  hora time,
  valor numeric(14,2) not null check (valor >= 0 and valor <> 'NaN'::numeric),
  motivo text,
  motivo_descricao text,
  observacao text,
  situacao text,
  classificacao text check (classificacao in ('recebe_taxa', 'nao_recebe_taxa')),
  criado_por uuid references perfis(id) on delete set null,
  criado_por_nome text,
  criado_por_email text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  atualizado_por_nome text,
  excluido boolean not null default false,
  excluido_em timestamptz,
  excluido_por_nome text,
  motivo_exclusao text,
  constraint pfdlanc_forma_por_origem check (
    case origem
      when 'taxa_adicional' then numero_pedido is not null and motivo is not null
                                 and situacao is null and classificacao is null
      when 'avulso'         then pedido_id is null and numero_pedido is null and importacao_id is null
                                 and situacao is null and classificacao is null and motivo is not null
      when 'manual'         then motivo is not null
      else false
    end
  )
);
create index if not exists idx_pfdlanc_unidade_data on parser_fd_lancamentos(unidade_id, data) where not excluido;
create index if not exists idx_pfdlanc_org on parser_fd_lancamentos(organizacao_id);
create index if not exists idx_pfdlanc_pedido on parser_fd_lancamentos(pedido_id) where pedido_id is not null;
create index if not exists idx_pfdlanc_entregador on parser_fd_lancamentos(entregador_id);
create index if not exists idx_pfdlanc_importacao on parser_fd_lancamentos(importacao_id) where importacao_id is not null;

drop trigger if exists trg_pfdlanc_atualizado_em on parser_fd_lancamentos;
create trigger trg_pfdlanc_atualizado_em before update on parser_fd_lancamentos
  for each row execute function parser_fd_set_atualizado_em();

-- ---------------------------------------------------------------------
-- 3. OVERRIDE DE CLASSIFICAÇÃO com identidade ESTÁVEL do pedido.
--    `data_hora_chave` = string estável sem fuso (equivale ao
--    horaOperacional() do backend — os primeiros 19 chars do ISO local).
--    Sobrevive a delete+reimport do pedido, tornando o override idempotente.
-- ---------------------------------------------------------------------
create table if not exists parser_fd_pedido_overrides (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  numero_pedido text not null,
  data_hora_chave text not null,
  classificacao_final text not null check (classificacao_final in ('recebe_taxa', 'nao_recebe_taxa')),
  classificacao_original text,
  motivo text not null,
  usuario_id uuid references perfis(id) on delete set null,
  usuario_nome text,
  usuario_email text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create unique index if not exists uq_pfdovr_identidade on parser_fd_pedido_overrides(unidade_id, numero_pedido, data_hora_chave);
create index if not exists idx_pfdovr_org on parser_fd_pedido_overrides(organizacao_id);

drop trigger if exists trg_pfdovr_atualizado_em on parser_fd_pedido_overrides;
create trigger trg_pfdovr_atualizado_em before update on parser_fd_pedido_overrides
  for each row execute function parser_fd_set_atualizado_em();

-- Backfill: overrides que hoje moram nas colunas de parser_fd_pedidos.
-- `left(data_hora::text, 19)` reproduz os 19 primeiros chars (AAAA-MM-DD
-- HH:MM:SS) — o backend gera a mesma chave via horaOperacional(). Idempotente.
insert into parser_fd_pedido_overrides
  (organizacao_id, unidade_id, numero_pedido, data_hora_chave, classificacao_final,
   classificacao_original, motivo, usuario_id, usuario_nome, usuario_email, criado_em, atualizado_em)
select p.organizacao_id, p.unidade_id, p.numero_pedido,
       replace(left(p.data_hora::text, 19), ' ', 'T'),
       case when p.status_conciliacao = 'excluido' then 'nao_recebe_taxa' else 'recebe_taxa' end,
       coalesce(p.classificacao_original, p.classificacao_cancelamento),
       coalesce(p.classificacao_override_motivo, 'Override anterior à migration 079'),
       p.classificacao_override_usuario_id, p.classificacao_override_usuario_nome,
       p.classificacao_override_usuario_email, p.classificacao_override_em, now()
  from parser_fd_pedidos p
 where p.classificacao_override_em is not null
   and p.data_hora is not null
   and p.numero_pedido is not null
on conflict (unidade_id, numero_pedido, data_hora_chave) do nothing;

-- ---------------------------------------------------------------------
-- 4. AUDITORIA — novas ações + colunas antes/depois. `importacao_id`
--    deixa de ser NOT NULL (ações de lançamento/entregador não têm
--    importação de origem). Dado existente já tem valor — seguro.
-- ---------------------------------------------------------------------
alter table parser_fd_auditoria alter column importacao_id drop not null;

alter table parser_fd_auditoria drop constraint if exists parser_fd_auditoria_acao_check;
alter table parser_fd_auditoria add constraint parser_fd_auditoria_acao_check
  check (acao in (
    'importacao_criada', 'codigos_alterados', 'excluida', 'classificacao_alterada',
    'lancamento_criado', 'lancamento_editado', 'lancamento_excluido',
    'lancamento_restaurado', 'lancamento_hard_delete',
    'entregador_criado', 'entregador_editado', 'entregador_status_alterado',
    'classificacao_override_definido', 'classificacao_override_removido'
  ));

alter table parser_fd_auditoria add column if not exists lancamento_id uuid;
alter table parser_fd_auditoria add column if not exists entregador_id uuid;
alter table parser_fd_auditoria add column if not exists valor_antes numeric(14,2);
alter table parser_fd_auditoria add column if not exists valor_depois numeric(14,2);
alter table parser_fd_auditoria add column if not exists dados_antes jsonb;
alter table parser_fd_auditoria add column if not exists dados_depois jsonb;

create index if not exists idx_pfdaud_lancamento on parser_fd_auditoria(lancamento_id) where lancamento_id is not null;
create index if not exists idx_pfdaud_entregador on parser_fd_auditoria(entregador_id) where entregador_id is not null;

-- ---------------------------------------------------------------------
-- 5. HARD DELETE TRANSACIONAL de um lançamento (só SuperAdmin, via
--    backend service_role). Grava o snapshot em auditoria e remove a
--    linha na MESMA transação — nunca some sem deixar rastro.
--    search_path fixo (evita o lint 0011); EXECUTE revogado de
--    anon/authenticated (o backend chama como service_role).
-- ---------------------------------------------------------------------
create or replace function parser_fd_lancamento_hard_delete(
  p_id uuid, p_org uuid, p_unidade uuid,
  p_usuario_id uuid, p_usuario_nome text, p_usuario_email text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row parser_fd_lancamentos%rowtype;
begin
  select * into v_row from parser_fd_lancamentos
   where id = p_id and organizacao_id = p_org and unidade_id = p_unidade
   for update;
  if not found then
    raise exception 'Lançamento % não encontrado nesta unidade.', p_id
      using errcode = 'no_data_found';
  end if;

  insert into parser_fd_auditoria
    (importacao_id, organizacao_id, unidade_id, acao, motivo,
     lancamento_id, entregador_id, valor_antes, dados_antes,
     numero_pedido, usuario_id, usuario_nome, usuario_email)
  values
    (v_row.importacao_id, p_org, p_unidade, 'lancamento_hard_delete', v_row.motivo_exclusao,
     v_row.id, v_row.entregador_id, v_row.valor, to_jsonb(v_row),
     v_row.numero_pedido, p_usuario_id, p_usuario_nome, p_usuario_email);

  delete from parser_fd_lancamentos where id = p_id;
end;
$fn$;

revoke all on function parser_fd_lancamento_hard_delete(uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. RLS — mesmo padrão das tabelas existentes (migration 037 §6).
--    Backend usa service_role e ignora RLS; policies valem para acesso
--    autenticado direto.
-- ---------------------------------------------------------------------
alter table parser_fd_entregadores enable row level security;
drop policy if exists rls_parser_fd_entregadores_tenant on parser_fd_entregadores;
create policy rls_parser_fd_entregadores_tenant on parser_fd_entregadores
  for all to authenticated
  using      (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin())
  with check (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin());

alter table parser_fd_lancamentos enable row level security;
drop policy if exists rls_parser_fd_lancamentos_tenant on parser_fd_lancamentos;
create policy rls_parser_fd_lancamentos_tenant on parser_fd_lancamentos
  for all to authenticated
  using      (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin())
  with check (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin());

alter table parser_fd_pedido_overrides enable row level security;
drop policy if exists rls_parser_fd_pedido_overrides_tenant on parser_fd_pedido_overrides;
create policy rls_parser_fd_pedido_overrides_tenant on parser_fd_pedido_overrides
  for all to authenticated
  using      (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin())
  with check (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin());

commit;

-- =====================================================================
-- VERIFICAÇÃO pós-migration (rode separadamente):
--   select to_regclass('parser_fd_entregadores');       -- não-nulo
--   select to_regclass('parser_fd_lancamentos');        -- não-nulo
--   select to_regclass('parser_fd_pedido_overrides');   -- não-nulo
--   select count(*) from parser_fd_pedido_overrides;    -- == nº de pedidos com override antigo
--   \df parser_fd_lancamento_hard_delete
-- =====================================================================
