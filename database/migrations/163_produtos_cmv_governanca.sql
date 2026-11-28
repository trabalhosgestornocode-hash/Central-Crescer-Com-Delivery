-- 163 — Produtos / CMV: custo zero declarado, aproveitamento (peso bruto/líquido), rascunhos do assistente,
--        origem/vigência do preço de venda e correções coletivas auditáveis (rendimento, custo zero).
--
-- RETROCOMPATÍVEL: só ADICIONA colunas opcionais, tabelas e funções. Nenhum dado existente é alterado ou
-- reinterpretado; fn_custo_produto NÃO muda (as Subways seguem idênticas). Idempotente. Rollback: 163_rollback.sql.
--
-- Semântica (documentada também em docs/produtos-cmv/02-arquitetura-final.md):
--  * insumos.preco_unitario é NOT NULL no schema: 0 SEM declaração = custo DESCONHECIDO (legado "sem custo";
--    pendência crítica, nunca tratado como zero válido).
--    custo_zero_declarado = true  = custo ZERO DECLARADO (motivo, responsável, data; preço é 0 de propósito).
--  * ficha_tecnica.quantidade continua sendo a quantidade COBRADA (peso bruto, na unidade-base do insumo).
--    peso_bruto/peso_liquido são opcionais e documentam o aproveitamento; quando informados, a aplicação grava
--    quantidade = peso_bruto (sem mudar a fórmula). Linhas antigas (nulos) mantêm o significado de sempre.
--  * insumos.aproveitamento_pct é o padrão do insumo (ex.: salmão inteiro 62%); a ficha pode ter exceção com
--    justificativa. Se o insumo já tem fator_correcao > 1 aplicado NO PREÇO, a ficha não pode aplicar perda de novo
--    (validação "perda_duplicada" no backend).

begin;
-- Locks: ADD COLUMN com default constante é só metadado (PG ≥ 11). As CHECKs entram NOT VALID e são validadas depois
-- (VALIDATE usa SHARE UPDATE EXCLUSIVE: não bloqueia leituras nem escritas). Se outra transação segurar a tabela, a
-- migration desiste em 5 s em vez de enfileirar o tráfego da plataforma atrás dela.
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------- 1. custo zero declarado (D1)
alter table insumos add column if not exists custo_zero_declarado boolean not null default false;
alter table insumos add column if not exists custo_zero_motivo text;
alter table insumos add column if not exists custo_zero_por text;
alter table insumos add column if not exists custo_zero_em timestamptz;
alter table insumos add column if not exists custo_zero_preco_anterior numeric;
do $$ begin
  alter table insumos add constraint insumos_custo_zero_coerente
    check (not custo_zero_declarado or (coalesce(preco_unitario, 0) = 0 and nullif(trim(custo_zero_motivo), '') is not null)) not valid;
exception when duplicate_object then null; end $$;
alter table insumos validate constraint insumos_custo_zero_coerente;

-- Compatibilidade com a tela ANTIGA de Insumos: informar um preço de compra (> 0) num insumo com custo zero declarado
-- encerra a declaração (o preço passa a valer) em vez de falhar na constraint. Auditado em catalogo_correcoes.
create or replace function trg_insumo_custo_zero_preco() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.custo_zero_declarado and new.custo_zero_declarado and coalesce(new.preco_unitario, 0) > 0
     and new.preco_unitario is distinct from old.preco_unitario then
    new.custo_zero_declarado := false; new.custo_zero_motivo := null; new.custo_zero_por := null;
    new.custo_zero_em := null; new.custo_zero_preco_anterior := null;
    insert into catalogo_correcoes (organizacao_id, lote_id, tipo, entidade, entidade_id, antes, depois, justificativa)
    values (new.organizacao_id, gen_random_uuid(), 'custo_zero_revogar', 'insumo', new.id,
            jsonb_build_object('preco_unitario', 0, 'motivo', old.custo_zero_motivo),
            jsonb_build_object('preco_unitario', new.preco_unitario), 'preço de compra informado no cadastro do insumo');
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- 2. aproveitamento (D3)
alter table insumos add column if not exists aproveitamento_pct numeric(7,4);
do $$ begin
  alter table insumos add constraint insumos_aproveitamento_valido check (aproveitamento_pct is null or (aproveitamento_pct > 0 and aproveitamento_pct <= 100)) not valid;
exception when duplicate_object then null; end $$;
alter table insumos validate constraint insumos_aproveitamento_valido;

alter table ficha_tecnica add column if not exists peso_bruto numeric(14,6);
alter table ficha_tecnica add column if not exists peso_liquido numeric(14,6);
alter table ficha_tecnica add column if not exists indice_coccao numeric(8,4);
alter table ficha_tecnica add column if not exists aproveitamento_justificativa text;
do $$ begin
  alter table ficha_tecnica add constraint ficha_pesos_coerentes check (
    (peso_bruto is null or peso_bruto > 0) and (peso_liquido is null or peso_liquido > 0)
    and (peso_bruto is null or peso_liquido is null or peso_liquido <= peso_bruto)
    and (indice_coccao is null or indice_coccao > 0)) not valid;
exception when duplicate_object then null; end $$;
alter table ficha_tecnica validate constraint ficha_pesos_coerentes;

-- ---------------------------------------------------------------- 3. preço de venda: origem e vigência (D4)
alter table produto_precos add column if not exists origem text;           -- 'manual' | 'importacao:<arquivo>' | 'integracao:<fonte>'
alter table produto_precos add column if not exists vigente_desde date;
alter table produto_precos add column if not exists informado_por text;

create table if not exists produto_precos_historico (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  produto_id uuid not null references produtos(id) on delete cascade,
  canal text not null, tabela text,
  preco_anterior numeric, preco_novo numeric,
  origem text, vigente_desde date, informado_por text,
  created_at timestamptz not null default now()
);
create index if not exists ix_precos_hist_prod on produto_precos_historico (organizacao_id, produto_id, created_at desc);

-- ---------------------------------------------------------------- 4. rascunhos do assistente
create table if not exists produto_rascunhos (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  produto_id uuid references produtos(id) on delete cascade,   -- null = ficha nova; preenchido = recuperação
  natureza text not null check (natureza in ('produto_final', 'preparacao', 'revenda')),
  etapa text not null default 'identificacao',
  dados jsonb not null default '{}'::jsonb,
  criado_por text, atualizado_por text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ix_rascunhos_org on produto_rascunhos (organizacao_id, updated_at desc);
create unique index if not exists ux_rascunho_produto on produto_rascunhos (organizacao_id, produto_id) where produto_id is not null;

-- ---------------------------------------------------------------- 5. correções coletivas auditáveis
create table if not exists catalogo_correcoes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  lote_id uuid not null,
  tipo text not null check (tipo in ('rendimento', 'custo_zero_declarar', 'custo_zero_revogar')),
  entidade text not null check (entidade in ('produto', 'insumo')),
  entidade_id uuid not null,
  antes jsonb not null, depois jsonb not null,
  justificativa text,
  usuario_nome text, usuario_email text,
  created_at timestamptz not null default now()
);
create index if not exists ix_correcoes_org on catalogo_correcoes (organizacao_id, created_at desc);
create index if not exists ix_correcoes_entidade on catalogo_correcoes (entidade_id, created_at desc);

-- RLS: tabelas novas só pelo backend (service role). Sem políticas para anon/authenticated = sem acesso direto.
alter table produto_precos_historico enable row level security;
alter table produto_rascunhos enable row level security;
alter table catalogo_correcoes enable row level security;
revoke all on produto_precos_historico, produto_rascunhos, catalogo_correcoes from anon, authenticated;

-- ---------------------------------------------------------------- 6. correção coletiva de rendimento (transacional)
-- p_itens: [{"produto_id": uuid, "rendimento_atual": num, "rendimento_novo": num, "justificativa": text}]
-- Tudo ou nada. Recusa: produto de outra organização, não-preparação, valor atual divergente (concorrência),
-- novo valor inválido. O gatilho da 158 invalida a homologação do produto e dos dependentes.
create or replace function fn_corrigir_rendimentos(p_org uuid, p_itens jsonb, p_usuario_nome text, p_usuario_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare it jsonb; v_lote uuid := gen_random_uuid(); v_p record; v_novo numeric; v_atual numeric; n int := 0;
begin
  if p_org is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 then
    raise exception 'CORRECAO_VAZIA' using errcode = '22023';
  end if;
  if jsonb_array_length(p_itens) > 200 then raise exception 'CORRECAO_GRANDE_DEMAIS' using errcode = '22023'; end if;
  for it in select * from jsonb_array_elements(p_itens) loop
    v_novo := (it->>'rendimento_novo')::numeric; v_atual := (it->>'rendimento_atual')::numeric;
    select id, nome, rendimento, unidade_rendimento, tipo, homologacao into v_p
      from produtos where id = (it->>'produto_id')::uuid and organizacao_id = p_org for update;
    if not found then raise exception 'PRODUTO_FORA_DA_ORGANIZACAO %', it->>'produto_id' using errcode = '42501'; end if;
    if v_p.tipo::text <> 'submontagem' then raise exception 'NAO_E_PREPARACAO %', v_p.nome using errcode = '22023'; end if;
    if v_p.homologacao = 'nao_aplicavel' then raise exception 'FICHA_PADRONIZADA %', v_p.nome using errcode = '22023'; end if;
    if v_novo is null or v_novo <= 0 then raise exception 'RENDIMENTO_INVALIDO %', v_p.nome using errcode = '22023'; end if;
    if v_atual is null or v_p.rendimento is distinct from v_atual then raise exception 'RENDIMENTO_MUDOU %', v_p.nome using errcode = '40001'; end if;
    if nullif(trim(coalesce(it->>'justificativa', '')), '') is null then raise exception 'JUSTIFICATIVA_OBRIGATORIA %', v_p.nome using errcode = '22023'; end if;
    update produtos set rendimento = v_novo, updated_at = now() where id = v_p.id;
    insert into catalogo_correcoes (organizacao_id, lote_id, tipo, entidade, entidade_id, antes, depois, justificativa, usuario_nome, usuario_email)
    values (p_org, v_lote, 'rendimento', 'produto', v_p.id,
            jsonb_build_object('rendimento', v_p.rendimento, 'unidade', v_p.unidade_rendimento),
            jsonb_build_object('rendimento', v_novo, 'unidade', v_p.unidade_rendimento), it->>'justificativa', p_usuario_nome, p_usuario_email);
    insert into produto_historico (organizacao_id, produto_id, alteracao_id, campo, rotulo, valor_anterior, valor_novo, usuario_nome, usuario_email)
    values (p_org, v_p.id, v_lote, 'rendimento', 'Rendimento (correção revisada)', v_p.rendimento::text, v_novo::text, p_usuario_nome, p_usuario_email);
    n := n + 1;
  end loop;
  return jsonb_build_object('lote_id', v_lote, 'corrigidos', n);
end $$;

-- ---------------------------------------------------------------- 7. declarar / revogar custo zero
create or replace function fn_custo_zero(p_org uuid, p_insumo uuid, p_declarar boolean, p_motivo text, p_usuario_nome text, p_usuario_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_i record; v_lote uuid := gen_random_uuid(); v_restaura numeric;
begin
  select id, nome, preco_unitario, custo_zero_declarado, custo_zero_motivo, custo_zero_preco_anterior into v_i
    from insumos where id = p_insumo and organizacao_id = p_org for update;
  if not found then raise exception 'INSUMO_FORA_DA_ORGANIZACAO' using errcode = '42501'; end if;
  if p_declarar then
    if nullif(trim(coalesce(p_motivo, '')), '') is null then raise exception 'MOTIVO_OBRIGATORIO' using errcode = '22023'; end if;
    if v_i.custo_zero_declarado then return jsonb_build_object('alterado', false); end if;
    update insumos set custo_zero_declarado = true, custo_zero_motivo = trim(p_motivo), custo_zero_por = coalesce(p_usuario_nome, p_usuario_email),
                       custo_zero_em = now(), custo_zero_preco_anterior = preco_unitario, preco_unitario = 0, updated_at = now()
     where id = v_i.id;
    insert into catalogo_correcoes (organizacao_id, lote_id, tipo, entidade, entidade_id, antes, depois, justificativa, usuario_nome, usuario_email)
    values (p_org, v_lote, 'custo_zero_declarar', 'insumo', v_i.id, jsonb_build_object('preco_unitario', v_i.preco_unitario),
            jsonb_build_object('preco_unitario', 0, 'custo_zero_declarado', true), trim(p_motivo), p_usuario_nome, p_usuario_email);
  else
    if not v_i.custo_zero_declarado then return jsonb_build_object('alterado', false); end if;
    -- Restaura o preço anterior. preco_unitario é NOT NULL: 0 SEM declaração = desconhecido (semântica legada), nunca "zero válido".
    v_restaura := coalesce(v_i.custo_zero_preco_anterior, 0);
    update insumos set custo_zero_declarado = false, custo_zero_motivo = null, custo_zero_por = null, custo_zero_em = null,
                       custo_zero_preco_anterior = null, preco_unitario = v_restaura, updated_at = now()
     where id = v_i.id;
    insert into catalogo_correcoes (organizacao_id, lote_id, tipo, entidade, entidade_id, antes, depois, justificativa, usuario_nome, usuario_email)
    values (p_org, v_lote, 'custo_zero_revogar', 'insumo', v_i.id, jsonb_build_object('preco_unitario', 0, 'motivo', v_i.custo_zero_motivo),
            jsonb_build_object('preco_unitario', v_restaura), coalesce(p_motivo, 'revogado'), p_usuario_nome, p_usuario_email);
  end if;
  return jsonb_build_object('alterado', true, 'lote_id', v_lote);
end $$;

-- ---------------------------------------------------------------- 8. módulo de ativação gradual (nasce desligado p/ todos)
do $$ begin
  if to_regclass('public.modulos') is not null then
    insert into modulos (id, nome, categoria, ordem) values ('products_cmv_v2', 'Produtos / CMV 2.0 (piloto)', 'operacao', 19)
    on conflict (id) do update set nome = excluded.nome, categoria = excluded.categoria, ordem = excluded.ordem;
  end if;
end $$;

drop trigger if exists trg_insumo_custo_zero_preco on insumos;
create trigger trg_insumo_custo_zero_preco before update of preco_unitario on insumos
  for each row execute function trg_insumo_custo_zero_preco();

revoke all on function fn_corrigir_rendimentos(uuid, jsonb, text, text) from public, anon, authenticated;
revoke all on function fn_custo_zero(uuid, uuid, boolean, text, text, text) from public, anon, authenticated;

commit;
