-- =====================================================================
-- SUBWAY SACI — Sistema de Gestão Inteligente
-- Schema principal (PostgreSQL / Supabase)
-- Versão: 0.2.0 (MVP) — modelo derivado das planilhas reais
--
-- Mudanças da v0.1 -> v0.2 (após análise das planilhas):
--   * `ingredientes` -> `insumos`, enriquecido (preço-caixa, rendimento,
--     fator de correção, custo unitário efetivo).
--   * Ficha técnica AUTO-REFERENCIÁVEL (BOM): um produto pode ser composto
--     de insumos E/OU de outros produtos (sub-montagens e combos).
--   * `produto_precos`: múltiplas tabelas por canal (balcão A–F/AERO, iFood A–Z, Uber).
--   * `canais_venda`: comissão por canal -> permite lucro líquido.
--   * Custo e baixa de estoque são RECURSIVOS (explodem a árvore até o insumo cru).
--
-- Como usar:
--   1. Supabase -> SQL Editor -> cole e execute este arquivo
--   2. Execute os seeds em database/seeds/
--   Para reexecutar do zero, resete o schema antes (os CREATE TYPE não são idempotentes).
-- =====================================================================

create extension if not exists pgcrypto;

-- =====================================================================
-- 0. HELPER
-- =====================================================================
create or replace function set_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

-- =====================================================================
-- 1. ENUMS
-- =====================================================================
create type papel_usuario      as enum ('admin', 'gerente', 'operador', 'financeiro');
create type unidade_medida_enum as enum ('g', 'kg', 'ml', 'l', 'un', 'fatia', 'porcao', 'folha');
create type tipo_categoria     as enum ('produto', 'insumo');

create type tipo_insumo        as enum (
  'proteina','queijo','molho','vegetal','pao','embalagem',
  'bebida','descartavel','doce','chips','outro'
);
create type tipo_produto       as enum (
  'sanduiche','salada','bebida','sobremesa','chips',
  'adicional','acompanhamento','combo','submontagem','outro'
);
create type tamanho_produto    as enum ('15cm','30cm','salada','unico');

create type canal              as enum ('balcao','ifood','uber','app','outro');
create type forma_pagamento    as enum ('dinheiro','credito','debito','pix','ifood','voucher','outro');
create type status_venda       as enum ('concluida','cancelada','pendente');

create type tipo_fornecedor    as enum ('distribuidora','local','outro');
create type tipo_movimentacao  as enum (
  'entrada_manual','entrada_fornecedor','saida_venda','perda',
  'vencimento','transferencia_saida','transferencia_entrada','ajuste_inventario'
);
create type status_pedido      as enum (
  'rascunho','enviado','confirmado','entregue_parcial','entregue','cancelado'
);
create type tipo_divergencia   as enum ('falta','sobra','avaria','preco','produto_errado');

create type tipo_alerta        as enum (
  'estoque_critico','ruptura_prevista','cmv_alto','margem_baixa','desperdicio',
  'faturamento_baixo','compra_necessaria','anomalia','vencimento_proximo'
);
create type severidade_alerta  as enum ('info','atencao','critico');
create type status_alerta      as enum ('novo','lido','resolvido','ignorado');
create type canal_notificacao  as enum ('whatsapp','email','sistema');
create type status_notificacao as enum ('pendente','enviado','falha');

-- =====================================================================
-- 2. NÚCLEO MULTI-TENANT
-- =====================================================================
create table organizacoes (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  cnpj text unique,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table unidades (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  nome text not null,
  cnpj text unique,
  endereco text,
  telefone text,
  responsavel text,     -- nome do responsável pela loja (migration 057)
  email text,           -- e-mail de contato da loja (migration 057) — nunca o e-mail do usuário logado
  cidade text,          -- migration 034
  estado text,          -- UF, 2 letras (migration 034)
  tabela_balcao text,   -- qual tabela de preço balcão esta loja usa (ex: 'A','AERO A')
  tabela_ifood  text,   -- qual tabela iFood esta loja usa (ex: 'A','Z1')
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_unidades_org on unidades(organizacao_id);

-- Configuração operacional por unidade (Configurações -> Metas e Limites de
-- CMV). Migration 058. Uma linha por loja; ausência de linha = defaults do
-- sistema (cmv_saudavel=32, cmv_atencao=40; metas/margem = null). Isolamento
-- por unidade_id (PK/FK); o backend filtra sempre por req.tenant.unidadeId.
create table unidade_config (
  unidade_id uuid primary key references unidades(id) on delete cascade,
  cmv_saudavel  numeric(5,2),
  cmv_atencao   numeric(5,2),
  meta_fat_dia  numeric(14,2),
  meta_fat_mes  numeric(14,2),
  margem_minima numeric(5,2),
  updated_at    timestamptz not null default now(),
  atualizado_por uuid
);

create table perfis (
  id uuid primary key references auth.users(id) on delete cascade,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid references unidades(id) on delete set null,
  nome text not null,
  email text,
  papel papel_usuario not null default 'operador',
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_perfis_org on perfis(organizacao_id);

-- =====================================================================
-- 3. CATÁLOGO (escopo: organização)
-- =====================================================================
create table categorias (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  nome text not null,
  tipo tipo_categoria not null default 'produto',
  ordem int not null default 0,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organizacao_id, nome, tipo)
);
create index idx_categorias_org on categorias(organizacao_id);

create table fornecedores (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  nome text not null,
  tipo tipo_fornecedor not null default 'local',
  cnpj text, contato text, email text, telefone text,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_fornecedores_org on fornecedores(organizacao_id);

-- Insumos (matéria-prima). Espelha a aba "Base" da planilha de CMV.
create table insumos (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  categoria_id uuid references categorias(id) on delete set null,
  fornecedor_id uuid references fornecedores(id) on delete set null,
  codigo text,                     -- código interno (ex: 1000891)
  nome text not null,
  tipo tipo_insumo not null default 'outro',
  unidade_medida unidade_medida_enum not null default 'kg',
  preco_caixa numeric(12,4),       -- informativo: preço da caixa/pacote comprado
  rendimento numeric(12,4),        -- informativo: qtd de unidade_medida por caixa
  fator_correcao numeric(8,4) not null default 1, -- perda/limpeza (ex: 1.25 alface)
  preco_unitario numeric(12,6) not null default 0, -- custo EFETIVO por unidade_medida
  estoque_minimo numeric(14,3) not null default 0,
  validade_dias int,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organizacao_id, codigo)
);
create index idx_insumos_org on insumos(organizacao_id);
create index idx_insumos_tipo on insumos(tipo);

-- Produtos: vendáveis (BMT 15cm, Combo...) OU sub-montagens (Vegetais completos,
-- Recheio BMT, Sanduíche sem recheio...) quando vendavel = false.
create table produtos (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  categoria_id uuid references categorias(id) on delete set null,
  tipo tipo_produto not null default 'outro',
  nome text not null,
  sku text,
  codigo_pdv text,                 -- COD INT do PDV/iFood
  tamanho tamanho_produto,
  vendavel boolean not null default true,
  custo_cache numeric(12,4),       -- custo calculado (mantido por fn_recalc_custo)
  imagem_url text,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organizacao_id, sku)
);
create index idx_produtos_org on produtos(organizacao_id);
create index idx_produtos_vendavel on produtos(vendavel);

-- Ficha técnica (BOM). Cada linha usa insumo_id XOR subproduto_id.
create table ficha_tecnica (
  id uuid primary key default gen_random_uuid(),
  produto_id uuid not null references produtos(id) on delete cascade,
  insumo_id uuid references insumos(id) on delete restrict,
  subproduto_id uuid references produtos(id) on delete restrict,
  quantidade numeric(14,5) not null,
  observacao text,
  created_at timestamptz not null default now(),
  constraint ficha_um_componente check ((insumo_id is null) <> (subproduto_id is null)),
  constraint ficha_nao_recursivo check (subproduto_id is null or subproduto_id <> produto_id)
);
create index idx_ficha_produto on ficha_tecnica(produto_id);
create index idx_ficha_insumo on ficha_tecnica(insumo_id);
create index idx_ficha_subproduto on ficha_tecnica(subproduto_id);
create unique index uq_ficha_insumo on ficha_tecnica(produto_id, insumo_id) where insumo_id is not null;
create unique index uq_ficha_subproduto on ficha_tecnica(produto_id, subproduto_id) where subproduto_id is not null;

-- Preços: várias tabelas por canal (balcão A–F/AERO, iFood A–Z, Uber).
create table produto_precos (
  id uuid primary key default gen_random_uuid(),
  produto_id uuid not null references produtos(id) on delete cascade,
  canal canal not null,
  tabela text,                     -- 'A','B','AERO A','Z1'... (null = tabela única)
  preco numeric(12,2) not null,
  desatualizado boolean not null default false, -- ex: preços iFood de 2024
  atualizado_em timestamptz not null default now(),
  unique (produto_id, canal, tabela)
);
create index idx_precos_produto on produto_precos(produto_id);
create index idx_precos_canal on produto_precos(canal, tabela);

-- Comissão/taxa por canal (para lucro líquido)
create table canais_venda (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  canal canal not null,
  comissao_pct numeric(6,4) not null default 0,  -- 0.2700 = 27%
  ativo boolean not null default true,
  unique (organizacao_id, canal)
);

-- =====================================================================
-- 4. ESTOQUE (escopo: unidade) — sobre insumos
-- =====================================================================
create table estoque (
  id uuid primary key default gen_random_uuid(),
  unidade_id uuid not null references unidades(id) on delete cascade,
  insumo_id uuid not null references insumos(id) on delete cascade,
  quantidade_atual numeric(14,3) not null default 0,
  estoque_minimo numeric(14,3) not null default 0,
  atualizado_em timestamptz not null default now(),
  unique (unidade_id, insumo_id)
);
create index idx_estoque_unidade on estoque(unidade_id);

create table movimentacoes_estoque (
  id uuid primary key default gen_random_uuid(),
  unidade_id uuid not null references unidades(id) on delete cascade,
  insumo_id uuid not null references insumos(id) on delete restrict,
  tipo tipo_movimentacao not null,
  quantidade numeric(14,3) not null,   -- + entrada / - saída
  custo_unitario numeric(12,6),
  saldo_apos numeric(14,3),
  referencia_tipo text,
  referencia_id uuid,
  observacao text,
  usuario_id uuid references perfis(id) on delete set null,
  created_at timestamptz not null default now()
);
create index idx_mov_unidade on movimentacoes_estoque(unidade_id);
create index idx_mov_insumo on movimentacoes_estoque(insumo_id);
create index idx_mov_data on movimentacoes_estoque(created_at);

create table lotes (
  id uuid primary key default gen_random_uuid(),
  unidade_id uuid not null references unidades(id) on delete cascade,
  insumo_id uuid not null references insumos(id) on delete cascade,
  quantidade numeric(14,3) not null,
  data_validade date,
  custo_unitario numeric(12,6),
  pedido_compra_id uuid,
  created_at timestamptz not null default now()
);
create index idx_lotes_unidade on lotes(unidade_id);
create index idx_lotes_validade on lotes(data_validade);

-- =====================================================================
-- 5. DISTRIBUIDORA / COMPRAS (escopo: unidade)
-- =====================================================================
create table pedidos_compra (
  id uuid primary key default gen_random_uuid(),
  unidade_id uuid not null references unidades(id) on delete cascade,
  fornecedor_id uuid not null references fornecedores(id) on delete restrict,
  status status_pedido not null default 'rascunho',
  data_pedido date not null default current_date,
  data_entrega_prevista date,
  data_entrega_real date,
  valor_total numeric(14,2) not null default 0,
  observacao text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_pedidos_unidade on pedidos_compra(unidade_id);

create table pedidos_compra_itens (
  id uuid primary key default gen_random_uuid(),
  pedido_compra_id uuid not null references pedidos_compra(id) on delete cascade,
  insumo_id uuid not null references insumos(id) on delete restrict,
  quantidade numeric(14,3) not null,
  quantidade_recebida numeric(14,3),
  custo_unitario numeric(12,6) not null default 0,
  created_at timestamptz not null default now()
);
create index idx_pedidos_itens_pedido on pedidos_compra_itens(pedido_compra_id);

create table notas_fiscais (
  id uuid primary key default gen_random_uuid(),
  unidade_id uuid not null references unidades(id) on delete cascade,
  pedido_compra_id uuid references pedidos_compra(id) on delete set null,
  numero text, chave_acesso text, valor_total numeric(14,2),
  arquivo_url text, emitida_em date,
  created_at timestamptz not null default now()
);
create index idx_nf_unidade on notas_fiscais(unidade_id);

create table divergencias_compra (
  id uuid primary key default gen_random_uuid(),
  pedido_compra_id uuid not null references pedidos_compra(id) on delete cascade,
  insumo_id uuid references insumos(id) on delete set null,
  tipo tipo_divergencia not null,
  quantidade_divergente numeric(14,3),
  descricao text,
  resolvida boolean not null default false,
  created_at timestamptz not null default now()
);
create index idx_diverg_pedido on divergencias_compra(pedido_compra_id);

-- =====================================================================
-- 6. VENDAS (escopo: unidade)
-- =====================================================================
create table vendas (
  id uuid primary key default gen_random_uuid(),
  unidade_id uuid not null references unidades(id) on delete cascade,
  origem canal not null default 'balcao',
  external_id text,                -- id no SWFast/iFood (idempotência)
  data_hora timestamptz not null default now(),
  valor_total numeric(14,2) not null default 0,
  forma_pagamento forma_pagamento,
  status status_venda not null default 'concluida',
  created_at timestamptz not null default now(),
  unique (unidade_id, origem, external_id)
);
create index idx_vendas_unidade on vendas(unidade_id);
create index idx_vendas_data on vendas(data_hora);

create table vendas_itens (
  id uuid primary key default gen_random_uuid(),
  venda_id uuid not null references vendas(id) on delete cascade,
  produto_id uuid not null references produtos(id) on delete restrict,
  quantidade numeric(12,3) not null default 1,
  preco_unitario numeric(12,2) not null default 0,
  valor_total numeric(14,2) not null default 0,
  custo_unitario_snapshot numeric(12,6), -- custo congelado no momento da venda
  created_at timestamptz not null default now()
);
create index idx_vendas_itens_venda on vendas_itens(venda_id);
create index idx_vendas_itens_produto on vendas_itens(produto_id);

-- =====================================================================
-- 7. IA / ALERTAS / NOTIFICAÇÕES / PARÂMETROS (escopo: unidade)
-- =====================================================================
create table alertas (
  id uuid primary key default gen_random_uuid(),
  unidade_id uuid not null references unidades(id) on delete cascade,
  tipo tipo_alerta not null,
  severidade severidade_alerta not null default 'atencao',
  titulo text not null,
  mensagem text not null,
  dados jsonb,
  status status_alerta not null default 'novo',
  gerado_por text not null default 'sistema',
  created_at timestamptz not null default now()
);
create index idx_alertas_unidade on alertas(unidade_id);
create index idx_alertas_status on alertas(status);

create table notificacoes (
  id uuid primary key default gen_random_uuid(),
  unidade_id uuid not null references unidades(id) on delete cascade,
  alerta_id uuid references alertas(id) on delete set null,
  canal canal_notificacao not null default 'whatsapp',
  destinatario text,
  mensagem text not null,
  status status_notificacao not null default 'pendente',
  enviado_em timestamptz, erro text,
  created_at timestamptz not null default now()
);
create index idx_notif_unidade on notificacoes(unidade_id);

create table insights_ia (
  id uuid primary key default gen_random_uuid(),
  unidade_id uuid not null references unidades(id) on delete cascade,
  tipo text not null, conteudo text, dados jsonb,
  periodo_inicio date, periodo_fim date,
  created_at timestamptz not null default now()
);

create table parametros (
  id uuid primary key default gen_random_uuid(),
  unidade_id uuid not null references unidades(id) on delete cascade,
  chave text not null,
  valor jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (unidade_id, chave)
);

-- =====================================================================
-- 8. FUNÇÕES DE CUSTO / CMV (recursivas sobre o BOM)
-- =====================================================================

-- Custo total de um produto: explode a ficha técnica até os insumos crus.
create or replace function fn_custo_produto(p_produto_id uuid)
returns numeric language sql stable as $$
  with recursive expl as (
    select ft.insumo_id, ft.subproduto_id, ft.quantidade::numeric as qtd
    from ficha_tecnica ft
    where ft.produto_id = p_produto_id
    union all
    select ft.insumo_id, ft.subproduto_id, e.qtd * ft.quantidade
    from expl e
    join ficha_tecnica ft on ft.produto_id = e.subproduto_id
    where e.subproduto_id is not null
  )
  select coalesce(sum(e.qtd * i.preco_unitario), 0)
  from expl e
  join insumos i on i.id = e.insumo_id
  where e.insumo_id is not null;
$$;

-- Recalcula e grava o custo_cache de um produto
create or replace function fn_recalc_custo(p_produto_id uuid)
returns void language sql as $$
  update produtos set custo_cache = fn_custo_produto(p_produto_id), updated_at = now()
  where id = p_produto_id;
$$;

-- =====================================================================
-- 9. TRIGGERS
-- =====================================================================
create trigger trg_org_upd     before update on organizacoes for each row execute function set_updated_at();
create trigger trg_und_upd     before update on unidades     for each row execute function set_updated_at();
create trigger trg_perfis_upd  before update on perfis       for each row execute function set_updated_at();
create trigger trg_forn_upd    before update on fornecedores for each row execute function set_updated_at();
create trigger trg_insumos_upd before update on insumos      for each row execute function set_updated_at();
create trigger trg_prod_upd    before update on produtos     for each row execute function set_updated_at();
create trigger trg_pedidos_upd before update on pedidos_compra for each row execute function set_updated_at();
create trigger trg_param_upd   before update on parametros   for each row execute function set_updated_at();

-- BAIXA AUTOMÁTICA DE ESTOQUE POR VENDA (explode o BOM até o insumo cru)
create or replace function fn_baixa_estoque_venda()
returns trigger as $$
declare
  v_unidade_id uuid;
  rec record;
  v_saldo numeric(14,3);
begin
  select unidade_id into v_unidade_id from vendas where id = new.venda_id;

  for rec in
    with recursive expl as (
      select ft.insumo_id, ft.subproduto_id, ft.quantidade::numeric as qtd
      from ficha_tecnica ft
      where ft.produto_id = new.produto_id
      union all
      select ft.insumo_id, ft.subproduto_id, e.qtd * ft.quantidade
      from expl e
      join ficha_tecnica ft on ft.produto_id = e.subproduto_id
      where e.subproduto_id is not null
    )
    select insumo_id, sum(qtd * new.quantidade) as total
    from expl
    where insumo_id is not null
    group by insumo_id
  loop
    insert into estoque (unidade_id, insumo_id, quantidade_atual, estoque_minimo)
    values (v_unidade_id, rec.insumo_id, 0, 0)
    on conflict (unidade_id, insumo_id) do nothing;

    update estoque
       set quantidade_atual = quantidade_atual - rec.total, atualizado_em = now()
     where unidade_id = v_unidade_id and insumo_id = rec.insumo_id
    returning quantidade_atual into v_saldo;

    insert into movimentacoes_estoque
      (unidade_id, insumo_id, tipo, quantidade, saldo_apos, referencia_tipo, referencia_id)
    values
      (v_unidade_id, rec.insumo_id, 'saida_venda', -rec.total, v_saldo, 'venda_item', new.id);
  end loop;

  return new;
end;
$$ language plpgsql;

create trigger trg_baixa_estoque_venda
after insert on vendas_itens
for each row execute function fn_baixa_estoque_venda();

-- =====================================================================
-- 10. VIEWS (dashboard / CMV / margem)
-- =====================================================================

-- Margem e CMV por produto x canal x tabela (com comissão -> lucro líquido)
create or replace view vw_produto_margem as
select
  p.id as produto_id,
  p.organizacao_id,
  p.nome,
  p.tamanho,
  pp.canal,
  pp.tabela,
  pp.preco,
  pp.desatualizado,
  fn_custo_produto(p.id) as custo,
  coalesce(cv.comissao_pct, 0) as comissao_pct,
  round(pp.preco * (1 - coalesce(cv.comissao_pct,0)) - fn_custo_produto(p.id), 2) as lucro_liquido,
  case when pp.preco > 0
       then round(fn_custo_produto(p.id) / pp.preco * 100, 2) end as cmv_pct
from produtos p
join produto_precos pp on pp.produto_id = p.id
left join canais_venda cv on cv.organizacao_id = p.organizacao_id and cv.canal = pp.canal
where p.vendavel;

create or replace view vw_estoque_critico as
select e.unidade_id, e.insumo_id, i.nome as insumo,
       e.quantidade_atual, e.estoque_minimo, i.unidade_medida
from estoque e
join insumos i on i.id = e.insumo_id
where e.quantidade_atual <= e.estoque_minimo;

create or replace view vw_faturamento_diario as
select unidade_id,
       (data_hora at time zone 'America/Sao_Paulo')::date as dia,
       origem,
       count(*) as qtd_vendas,
       sum(valor_total) as faturamento
from vendas
where status = 'concluida'
group by unidade_id, dia, origem;

create or replace view vw_produtos_vendidos as
select v.unidade_id, vi.produto_id, p.nome,
       sum(vi.quantidade) as qtd_total,
       sum(vi.valor_total) as receita_total
from vendas_itens vi
join vendas v on v.id = vi.venda_id and v.status = 'concluida'
join produtos p on p.id = vi.produto_id
group by v.unidade_id, vi.produto_id, p.nome;

-- =====================================================================
-- 11. RLS (base — backend usa service role; refinar antes de expor ao front)
-- =====================================================================
create or replace function auth_organizacao_id()
returns uuid language sql stable security definer as $$
  select organizacao_id from perfis where id = auth.uid();
$$;

-- Policies de exemplo (org e produtos) para quando o frontend acessar direto:
create policy org_isolada on organizacoes for all using (id = auth_organizacao_id());
create policy produtos_por_org on produtos for all using (organizacao_id = auth_organizacao_id());

-- Liga RLS em TODAS as tabelas (deny-by-default para anon). O backend usa
-- service_role, que ignora RLS. Ver database/migrations/001_rls_lockdown.sql.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;
end $$;
-- NOTA: crie policies por organização/unidade antes de o frontend usar a chave anon.

-- =====================================================================
-- FIM
-- =====================================================================
