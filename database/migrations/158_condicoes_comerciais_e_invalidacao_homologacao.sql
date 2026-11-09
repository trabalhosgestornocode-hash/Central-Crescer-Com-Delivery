-- =====================================================================
-- MIGRATION 158 — Condições comerciais por empresa/canal + invalidação da homologação
--
-- Depende da 157 (colunas de homologação em produtos).
-- Aditiva e idempotente. NÃO altera nenhum valor existente de canais_venda (as comissões das
-- Subways ficam exatamente como estão) e NÃO insere linha em canais_venda para ninguém.
--
-- 1) canais_venda ganha as demais condições (taxas, promoções, tributos, entrega, outras deduções).
--    Todas NULL = "não configurado": o simulador e o dashboard tratam ausência como dado faltante,
--    nunca como zero.
-- 2) canais_venda_historico: quem mudou o quê (antes/depois).
-- 3) Homologação: alteração de COMPOSIÇÃO (ficha_tecnica) ou de RENDIMENTO/custo manual invalida a
--    homologação do produto e de todos que o usam como preparação, com registro no histórico.
--    (Mudança de PREÇO de insumo é tratada no backend por comparação com o custo homologado.)
-- Rollback: 158_rollback.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. CONDIÇÕES COMERCIAIS
-- ---------------------------------------------------------------------
alter table canais_venda add column if not exists taxas_pct numeric(6,4);
alter table canais_venda add column if not exists promocao_pct numeric(6,4);
alter table canais_venda add column if not exists tributos_pct numeric(6,4);
alter table canais_venda add column if not exists entrega_responsavel text;
alter table canais_venda add column if not exists entrega_custo numeric(10,2);
alter table canais_venda add column if not exists outras_deducoes jsonb not null default '[]'::jsonb;
alter table canais_venda add column if not exists observacao text;
alter table canais_venda add column if not exists updated_by uuid references perfis(id) on delete set null;
alter table canais_venda add column if not exists updated_at timestamptz not null default now();

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'canais_venda_pcts_validos') then
    alter table canais_venda add constraint canais_venda_pcts_validos check (
      (taxas_pct is null or (taxas_pct >= 0 and taxas_pct < 1)) and
      (promocao_pct is null or (promocao_pct >= 0 and promocao_pct < 1)) and
      (tributos_pct is null or (tributos_pct >= 0 and tributos_pct < 1)) and
      (entrega_custo is null or entrega_custo >= 0)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'canais_venda_entrega_resp_valida') then
    alter table canais_venda add constraint canais_venda_entrega_resp_valida
      check (entrega_responsavel is null or entrega_responsavel in ('loja','plataforma','terceiro')) not valid;
  end if;
end $$;
-- NOT VALID: não revalida linhas antigas (nenhuma tem esses campos); vale para tudo que for gravado daqui em diante.

create table if not exists canais_venda_historico (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  canal canal not null,
  antes jsonb,
  depois jsonb not null,
  usuario_id uuid references perfis(id) on delete set null,
  usuario_nome text,
  created_at timestamptz not null default now()
);
create index if not exists idx_canais_hist_org on canais_venda_historico(organizacao_id, created_at desc);
alter table canais_venda_historico enable row level security;

-- ---------------------------------------------------------------------
-- 2. HOMOLOGAÇÃO — custo homologado (snapshot) e motivo da invalidação
-- ---------------------------------------------------------------------
alter table produtos add column if not exists homologado_custo numeric(14,6);
alter table produtos add column if not exists homologacao_motivo text;
-- Snapshot do NOME de quem homologou (o FK homologado_por pode não existir para usuários multi-empresa).
alter table produtos add column if not exists homologado_por_nome text;

-- Invalida o produto e TODOS os que o usam (direta ou indiretamente) como preparação.
create or replace function fn_invalida_homologacao(p_produto uuid, p_motivo text)
returns void language plpgsql set search_path = public as $$
declare r record;
begin
  for r in
    with recursive anc(id) as (
      select p_produto
      union
      select ft.produto_id from ficha_tecnica ft join anc a on ft.subproduto_id = a.id
    )
    select p.id, p.organizacao_id from produtos p join anc on anc.id = p.id where p.homologacao = 'homologada'
  loop
    update produtos set homologacao = 'pendente', homologacao_motivo = p_motivo,
                        homologado_em = null, homologado_por = null, homologado_por_nome = null, homologado_custo = null
     where id = r.id;
    insert into produto_historico (organizacao_id, produto_id, alteracao_id, campo, rotulo, valor_anterior, valor_novo)
    values (r.organizacao_id, r.id, gen_random_uuid(), 'homologacao', 'Homologação da ficha', 'homologada', 'pendente (' || p_motivo || ')');
  end loop;
end $$;

create or replace function trg_ficha_invalida_homologacao() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then perform fn_invalida_homologacao(old.produto_id, 'composicao_alterada');
  else perform fn_invalida_homologacao(new.produto_id, 'composicao_alterada');
       if tg_op = 'UPDATE' and old.produto_id is distinct from new.produto_id then
         perform fn_invalida_homologacao(old.produto_id, 'composicao_alterada');
       end if;
  end if;
  return null;
end $$;

drop trigger if exists trg_ficha_homologacao on ficha_tecnica;
create trigger trg_ficha_homologacao after insert or update or delete on ficha_tecnica
  for each row execute function trg_ficha_invalida_homologacao();

create or replace function trg_produto_invalida_homologacao() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.rendimento is distinct from old.rendimento then
    perform fn_invalida_homologacao(new.id, 'rendimento_alterado');
  elsif new.custo_manual is distinct from old.custo_manual then
    perform fn_invalida_homologacao(new.id, 'custo_manual_alterado');
  end if;
  return null;
end $$;

drop trigger if exists trg_produto_homologacao on produtos;
create trigger trg_produto_homologacao after update of rendimento, custo_manual on produtos
  for each row execute function trg_produto_invalida_homologacao();
