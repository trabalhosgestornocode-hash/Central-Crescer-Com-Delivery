-- 162 — Núcleo Mentorados (Painel Administrativo).
--
-- ADITIVA. Cria só tabelas NOVAS; nenhuma tabela existente muda. O Dashboard iFood (lancamentos_financeiros_diarios) e o
-- Financeiro v2 continuam sendo as fontes oficiais e NUNCA são escritos por este módulo.
--
--   mentoria_participantes          quem É mentorado (cadastro explícito: nenhuma empresa vira mentorada por existir)
--   mentoria_importacoes            cada planilha de histórico recebida (hash do arquivo = idempotência e rastro)
--   mentoria_historico_mensal       valores mensais da planilha, por fonte; NULL = não informado (nunca zero)
--   mentoria_registros              diagnóstico, estratégias, metas, evidências e observações do mentor
--   mentoria_apresentacoes          versões das apresentações com o snapshot exato dos dados usados
--
-- Acesso: RLS ligado e SEM policy (só service_role, pelo backend sob requirePainelAdministrativo). anon/authenticated sem
-- grant: nenhum cliente de empresa alcança estas tabelas, nem a própria empresa mentorada.
-- Rollback: 162_rollback.sql.

begin;
set local lock_timeout = '5s';

create table if not exists public.mentoria_participantes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null unique references public.organizacoes(id) on delete cascade,
  status text not null default 'ativa' check (status in ('ativa', 'pausada', 'encerrada')),
  data_entrada date not null,
  data_renovacao date,
  mentor_nome text check (mentor_nome is null or length(mentor_nome) between 1 and 120),
  responsavel_nome text check (responsavel_nome is null or length(responsavel_nome) between 1 and 120),
  cidade text check (cidade is null or length(cidade) between 1 and 80),
  uf text check (uf is null or uf ~ '^[A-Z]{2}$'),
  modelo_operacao text check (modelo_operacao is null or modelo_operacao in ('marketplace', 'full_service', 'misto')),
  -- Qual fonte vence quando um mês existe na planilha E no Dashboard iFood (a outra aparece como divergência, nunca somada).
  fonte_preferencial text not null default 'importacao' check (fonte_preferencial in ('importacao', 'dashboard_ifood')),
  observacoes text check (observacoes is null or length(observacoes) <= 2000),
  criado_por uuid references public.perfis(id) on delete set null,
  atualizado_por uuid references public.perfis(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_mentoria_renovacao_depois check (data_renovacao is null or data_renovacao > data_entrada)
);

create table if not exists public.mentoria_importacoes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
  arquivo_nome text not null check (length(arquivo_nome) between 1 and 255),
  arquivo_sha256 text not null check (arquivo_sha256 ~ '^[0-9a-f]{64}$'),
  leitor_versao text not null,
  mes_inicio date not null,
  mes_fim date not null,
  meses int not null check (meses between 1 and 240),
  metas jsonb not null default '{}'::jsonb,
  diagnostico jsonb not null default '{}'::jsonb,
  importado_por uuid references public.perfis(id) on delete set null,
  importado_por_email text,
  created_at timestamptz not null default now(),
  unique (organizacao_id, arquivo_sha256)
);

create table if not exists public.mentoria_historico_mensal (
  organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
  mes date not null check (extract(day from mes) = 1),
  fonte text not null default 'importacao' check (fonte in ('importacao')),
  importacao_id uuid not null references public.mentoria_importacoes(id) on delete restrict,
  valor_vendas numeric(14,2),
  taxas_comissoes numeric(14,2),
  servicos_promocoes numeric(14,2),
  taxas_entregadores numeric(14,2),
  qtd_pedidos int check (qtd_pedidos is null or qtd_pedidos >= 0),
  valor_vendas_desempenho numeric(14,2),
  novos_clientes int check (novos_clientes is null or novos_clientes >= 0),
  precificacao_pct numeric(7,4),
  observacao text,
  atualizado_em timestamptz not null default now(),
  primary key (organizacao_id, mes, fonte)
);

create table if not exists public.mentoria_registros (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
  tipo text not null check (tipo in ('diagnostico', 'estrategia', 'meta', 'evidencia', 'observacao')),
  data_registro date not null,
  titulo text not null check (length(titulo) between 1 and 160),
  descricao text check (descricao is null or length(descricao) <= 4000),
  indicadores text[] not null default '{}',
  meta_indicador text,
  meta_valor numeric(14,4),
  meta_unidade text check (meta_unidade is null or meta_unidade in ('reais', 'percentual', 'quantidade')),
  privado boolean not null default true,
  autor_id uuid references public.perfis(id) on delete set null,
  autor_nome text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_mentoria_registros_org on public.mentoria_registros(organizacao_id, data_registro desc);

create table if not exists public.mentoria_apresentacoes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references public.organizacoes(id) on delete cascade,
  versao int not null check (versao >= 1),
  titulo text not null check (length(titulo) between 1 and 160),
  configuracao jsonb not null default '{}'::jsonb,
  snapshot jsonb not null,
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  criado_por uuid references public.perfis(id) on delete set null,
  criado_por_nome text,
  created_at timestamptz not null default now(),
  unique (organizacao_id, versao)
);

alter table public.mentoria_participantes enable row level security;
alter table public.mentoria_importacoes enable row level security;
alter table public.mentoria_historico_mensal enable row level security;
alter table public.mentoria_registros enable row level security;
alter table public.mentoria_apresentacoes enable row level security;

revoke all on public.mentoria_participantes, public.mentoria_importacoes, public.mentoria_historico_mensal,
  public.mentoria_registros, public.mentoria_apresentacoes from anon, authenticated;

-- Uma apresentação gerada é um registro histórico: não se edita (nova versão = nova linha).
create or replace function public.mentoria_apresentacao_imutavel() returns trigger language plpgsql as $$
begin
  raise exception 'mentoria_apresentacoes é somente inserção (gere uma nova versão)';
end $$;
drop trigger if exists trg_mentoria_apresentacao_imutavel on public.mentoria_apresentacoes;
create trigger trg_mentoria_apresentacao_imutavel before update on public.mentoria_apresentacoes
  for each row execute function public.mentoria_apresentacao_imutavel();

drop trigger if exists trg_mentoria_participantes_upd on public.mentoria_participantes;
create trigger trg_mentoria_participantes_upd before update on public.mentoria_participantes
  for each row execute function set_updated_at();
drop trigger if exists trg_mentoria_registros_upd on public.mentoria_registros;
create trigger trg_mentoria_registros_upd before update on public.mentoria_registros
  for each row execute function set_updated_at();

-- Importação ATÔMICA e IDEMPOTENTE: o mesmo arquivo (hash) na mesma empresa devolve a importação existente sem regravar;
-- um arquivo novo grava a importação e faz upsert dos meses (a versão mais nova da planilha substitui a anterior mês a mês).
create or replace function public.mentoria_importar_historico(p_org uuid, p_importacao jsonb, p_meses jsonb)
returns table (importacao_id uuid, ja_existia boolean, meses_gravados int)
language plpgsql set search_path = public as $$
declare
  v_id uuid;
  v_n int;
begin
  if not exists (select 1 from mentoria_participantes where organizacao_id = p_org) then
    raise exception 'empresa não é participante da mentoria' using errcode = 'P0002';
  end if;
  select i.id into v_id from mentoria_importacoes i
   where i.organizacao_id = p_org and i.arquivo_sha256 = p_importacao->>'arquivo_sha256';
  if v_id is not null then
    return query select v_id, true, 0;
    return;
  end if;
  insert into mentoria_importacoes (organizacao_id, arquivo_nome, arquivo_sha256, leitor_versao, mes_inicio, mes_fim, meses,
                                    metas, diagnostico, importado_por, importado_por_email)
  values (p_org, p_importacao->>'arquivo_nome', p_importacao->>'arquivo_sha256', p_importacao->>'leitor_versao',
          (p_importacao->>'mes_inicio')::date, (p_importacao->>'mes_fim')::date, (p_importacao->>'meses')::int,
          coalesce(p_importacao->'metas', '{}'::jsonb), coalesce(p_importacao->'diagnostico', '{}'::jsonb),
          nullif(p_importacao->>'importado_por', '')::uuid, p_importacao->>'importado_por_email')
  returning id into v_id;
  insert into mentoria_historico_mensal as h (organizacao_id, mes, fonte, importacao_id, valor_vendas, taxas_comissoes,
         servicos_promocoes, taxas_entregadores, qtd_pedidos, valor_vendas_desempenho, novos_clientes, precificacao_pct)
  select p_org, (m->>'mes')::date, 'importacao', v_id, (m->>'valor_vendas')::numeric, (m->>'taxas_comissoes')::numeric,
         (m->>'servicos_promocoes')::numeric, (m->>'taxas_entregadores')::numeric, (m->>'qtd_pedidos')::int,
         (m->>'valor_vendas_desempenho')::numeric, (m->>'novos_clientes')::int, (m->>'precificacao_pct')::numeric
    from jsonb_array_elements(p_meses) m
  on conflict (organizacao_id, mes, fonte) do update set
    importacao_id = excluded.importacao_id, valor_vendas = excluded.valor_vendas, taxas_comissoes = excluded.taxas_comissoes,
    servicos_promocoes = excluded.servicos_promocoes, taxas_entregadores = excluded.taxas_entregadores,
    qtd_pedidos = excluded.qtd_pedidos, valor_vendas_desempenho = excluded.valor_vendas_desempenho,
    novos_clientes = excluded.novos_clientes, precificacao_pct = excluded.precificacao_pct, atualizado_em = now();
  get diagnostics v_n = row_count;
  return query select v_id, false, v_n;
end $$;
revoke all on function public.mentoria_importar_historico(uuid, jsonb, jsonb) from public, anon, authenticated;

comment on table public.mentoria_historico_mensal is
  'Histórico mensal importado de planilha do mentor. NULL = não informado. Não é registro financeiro oficial.';

commit;
