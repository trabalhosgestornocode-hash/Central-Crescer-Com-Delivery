-- =====================================================================
-- MIGRATION 074 — Fechamento mensal OFICIAL do Mix de Vendas
-- (Bebidas / Adicionais / Diversos da Performance Comercial)
-- =====================================================================
-- POR QUE ESTA MIGRATION EXISTE
--   Diagnóstico de 05/09/2026 (Subway Saci — Matriz, agosto/2026):
--     Central (Σ dos 24 "Relatório de Produtos" DIÁRIOS da Visio):
--       Sanduíches/Saladas 2542 | Bebidas 1086 | Adicionais 613 | Diversos 508
--     Visio (1 "Relatório de Produtos" MENSAL, mesmo período/canal):
--       Sanduíches/Saladas 2533 | Bebidas 1086 | Adicionais 613 | Diversos 508
--     Δ = +9 vendas principais (+0,36%), ZERO nos acompanhamentos.
--
--   Não é bug da Central nem do parser (os 24 PDFs foram re-parseados e
--   conferem 100% com o texto do PDF e com o banco; sem duplicados, sem
--   data errada, sem edição manual de quantidade). É a diferença entre a
--   agregação DIÁRIA e a MENSAL da PRÓPRIA Visio no campo "vendas
--   principais" — a Visio consolida 9 a menos no fechamento do mês do que a
--   soma dos seus próprios relatórios diários.
--
--   `mixMensalPonderado()` (bonificacaoMensal.calc.js) continua sendo a
--   melhor projeção DENTRO do mês corrente (é o que se tem dia a dia). Mas
--   para o MÊS FECHADO a referência oficial da Bonificação é o
--   consolidado da Visio — e ele nunca fecha exatamente com a soma diária.
--
--   Esta tabela guarda 1 fechamento por (unidade, ano, mês), lido de UM
--   "Relatório de Produtos" mensal da Visio (mesmo formato e mesmo parser
--   do relatório Loja diário — parseVisioProductReport; só muda o filtro de
--   data aplicado na Visio antes de exportar). Quando existe, ele é a fonte
--   de verdade de Bebidas/Adicionais/Diversos em obterMes(); quando não
--   existe, cai no ponderado dos diários, exatamente como hoje.
--
--   Mesmo padrão de granularidade e de RLS de bonificacao_rev_mensal
--   (migration 052): unidade + ano + mês = 1 registro.
--
-- IMPACTO EM DADO EXISTENTE: nenhum. Tabela nova, vazia. Enquanto ninguém
--   importar um fechamento mensal, obterMes() se comporta 100% como antes
--   (fallback para mixMensalPonderado). Meses fechados só mudam de número
--   SE e QUANDO um fechamento oficial for importado para eles — e aí é
--   justamente o número oficial da Visio, o que se quer.
--
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

create table if not exists bonificacao_mix_mensal (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  ano int not null check (ano between 2000 and 2100),
  mes int not null check (mes between 1 and 12),

  -- Quantidades do "% de acompanhamentos em vendas principais" do
  -- Relatório de Produtos MENSAL (Loja/Balcão). Inteiras, como no diário.
  qtd_sanduiches int not null check (qtd_sanduiches >= 0),
  qtd_bebidas    int not null check (qtd_bebidas    >= 0),
  qtd_adicionais int not null check (qtd_adicionais >= 0),
  qtd_diversos   int not null check (qtd_diversos   >= 0),

  -- Percentuais que o PRÓPRIO PDF trouxe — só validação cruzada (item 11),
  -- NUNCA entram no cálculo (mesma regra do lançamento diário).
  percentual_bebidas_pdf    numeric(6,3),
  percentual_adicionais_pdf numeric(6,3),
  percentual_diversos_pdf   numeric(6,3),

  -- Contexto do relatório (auditoria / detecção de inversão), sem uso no cálculo.
  faturamento_loja numeric(14,2),
  ppd_loja numeric(10,2),
  estabelecimento text,

  hash_arquivo text,
  arquivo_storage text,

  -- 'visio'  = 100% extração automática do PDF
  -- 'misto'  = extração + correção manual de algum número na prévia
  -- 'manual' = lançado à mão, sem PDF
  origem text not null default 'visio' check (origem in ('visio', 'manual', 'misto')),
  manual_override jsonb not null default '{}'::jsonb,

  usuario_id uuid references perfis(id) on delete set null,
  usuario_nome text,

  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),

  unique (unidade_id, ano, mes)
);

create index if not exists idx_bmm_unidade on bonificacao_mix_mensal(unidade_id, ano desc, mes desc);
create index if not exists idx_bmm_org on bonificacao_mix_mensal(organizacao_id);

-- Reaproveita a function criada pela migration 028 (mesma de rev_mensal).
drop trigger if exists trg_bmm_upd on bonificacao_mix_mensal;
create trigger trg_bmm_upd before update on bonificacao_mix_mensal
  for each row execute function bonificacao_set_atualizado_em();

alter table bonificacao_mix_mensal enable row level security;
drop policy if exists rls_bonificacao_mix_mensal_tenant on bonificacao_mix_mensal;
create policy rls_bonificacao_mix_mensal_tenant on bonificacao_mix_mensal
  for all to authenticated
  using (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin())
  with check (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin());

-- =====================================================================
-- VERIFICAÇÃO (rode separadamente):
--   \d bonificacao_mix_mensal
--   select * from bonificacao_mix_mensal;   -- esperado: 0 linhas
-- =====================================================================
