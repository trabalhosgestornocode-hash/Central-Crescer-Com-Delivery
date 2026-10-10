-- =====================================================================
-- 116 — iFood: vínculo MANUAL do merchant para unidades só com o app Order
-- =====================================================================
-- O app distribuído de pedidos (Order + Events) não tem o módulo Merchant: não dá para listar nem
-- validar a loja pela Merchant API, como o fluxo antigo faz com o token Financial. Nesse caso o gestor
-- INFORMA o ID da loja (Portal do Parceiro) e o vínculo passa por estados explícitos:
--
--   informado            -> ID digitado; falta a conferência visual do responsável
--   aguardando_validacao -> responsável conferiu; falta a validação final (operacional, com autorização)
--   validado             -> validação final concluída; SÓ AQUI o merchant vai para ifood_conexoes
--   rejeitado            -> o iFood recusou (a autorização não cobre a loja) ou o merchant já tem dono
--   cancelado            -> o gestor desistiu/trocou o ID, ou a conexão foi desfeita
--
-- DE PROPÓSITO fora de ifood_conexoes: enquanto não for `validado`, ifood_conexoes.merchant_id continua
-- NULL e a conexão continua `pendente` — o poller de Events, o Checklist e o fluxo Financial não enxergam
-- nada. Nenhuma coluna existente muda; a migration é só aditiva.
--
-- As linhas nunca são apagadas pelo backend: cada tentativa fica como histórico (quem, quando, resultado).
-- Sem token, sem segredo, sem payload do iFood.
--
-- Idempotente. Rollback: 116_rollback.sql.

create table if not exists ifood_merchant_vinculos (
  id uuid primary key default gen_random_uuid(),
  conexao_id uuid not null references ifood_conexoes(id) on delete cascade,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,

  merchant_id text not null check (length(merchant_id) between 1 and 128),

  estado text not null default 'informado'
    check (estado in ('informado', 'aguardando_validacao', 'validado', 'rejeitado', 'cancelado')),

  informado_por uuid references perfis(id) on delete set null,
  informado_em timestamptz not null default now(),
  confirmado_por uuid references perfis(id) on delete set null,   -- conferência visual do responsável
  confirmado_em timestamptz,

  -- Checagem de autorização no iFood (o token Order cobre este merchant?). Evidência NECESSÁRIA, nunca
  -- suficiente: resposta positiva não prova a identidade da loja.
  autorizacao_tentativas integer not null default 0 check (autorizacao_tentativas >= 0),
  autorizacao_ultima_tentativa_em timestamptz,
  autorizacao_verificada_em timestamptz,

  validado_por uuid references perfis(id) on delete set null,
  validado_em timestamptz,
  rejeitado_em timestamptz,
  encerrado_motivo text,                                          -- código curto (ex.: SEM_AUTORIZACAO)

  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),

  constraint ck_ifood_merchant_vinculos_confirmacao
    check (estado <> 'aguardando_validacao' or confirmado_em is not null),
  constraint ck_ifood_merchant_vinculos_validado
    check (estado <> 'validado' or (confirmado_em is not null and autorizacao_verificada_em is not null and validado_em is not null))
);

-- Um vínculo EM ABERTO por conexão, e um merchant em aberto em UMA conexão só (em todo o SaaS).
create unique index if not exists uq_ifood_merchant_vinculo_aberto_conexao
  on ifood_merchant_vinculos(conexao_id) where estado in ('informado', 'aguardando_validacao');
create unique index if not exists uq_ifood_merchant_vinculo_aberto_merchant
  on ifood_merchant_vinculos(merchant_id) where estado in ('informado', 'aguardando_validacao');
create index if not exists idx_ifood_merchant_vinculos_tenant
  on ifood_merchant_vinculos(organizacao_id, unidade_id, criado_em desc);

drop trigger if exists trg_ifood_merchant_vinculos_upd on ifood_merchant_vinculos;
create trigger trg_ifood_merchant_vinculos_upd before update on ifood_merchant_vinculos
  for each row execute function ifood_touch_atualizado_em();

-- Backend-only: RLS ligada, NENHUMA policy (deny-all para anon/authenticated). Só o service_role acessa.
alter table ifood_merchant_vinculos enable row level security;

do $$
begin
  revoke all on table ifood_merchant_vinculos from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table ifood_merchant_vinculos from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table ifood_merchant_vinculos from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update on table ifood_merchant_vinculos to service_role;
  end if;
end $$;
