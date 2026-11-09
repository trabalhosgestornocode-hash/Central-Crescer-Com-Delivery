-- =====================================================================
-- MIGRATION 157 — Catálogo técnico de EMPRESA INDEPENDENTE
--   (rendimento da receita · mão de obra separada · homologação ·
--    rastreabilidade de importação · importação transacional e idempotente)
--
-- POR QUE EXISTE
--   O catálogo já é por organização (insumos/produtos/canais_venda têm
--   organizacao_id; ficha_tecnica herda via produto). O que impedia uma empresa
--   que NÃO é franquia Subway de usar o mesmo motor era:
--     (1) fn_custo_produto assume que 1 ficha = 1 unidade vendida (não há
--         rendimento: uma receita de 8 empadões custaria o lote inteiro);
--     (2) não existe mão de obra separada do CMV de ingredientes;
--     (3) não existe homologação nem rastreabilidade de carga por planilha.
--
-- COMPATIBILIDADE COM AS SUBWAYS (princípio inegociável)
--   * Toda coluna nova é nullable OU tem default neutro (rendimento = 1,
--     homologacao = 'nao_aplicavel'). Com rendimento = 1 a nova fn_custo_produto
--     devolve EXATAMENTE o mesmo valor da anterior (testado em
--     backend/testes-seguros/catalogo-pg/).
--   * Nada é lido nem alterado em dados de nenhuma empresa por esta migration.
--     Ela NÃO libera módulo algum para ninguém (isso é dado em organizacao_modulos
--     e é uma decisão separada, de produção).
--   * Idempotente: pode ser reaplicada sem efeito colateral.
--
-- Rollback: 157_rollback.sql (recusa se já houver dados de importação).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. PRODUTOS — rendimento, unidade do rendimento e homologação
-- ---------------------------------------------------------------------
-- rendimento: quantas unidades (ou gramas/ml, conforme unidade_rendimento) a
--   receita rende. Custo UNITÁRIO = custo do lote / rendimento.
--   Preparação intermediária usada por peso: rendimento = 1554, unidade 'g'
--   e a ficha que a usa informa quantidade em gramas.
alter table produtos add column if not exists rendimento numeric(14,5) not null default 1;
alter table produtos add column if not exists unidade_rendimento unidade_medida_enum;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'produtos_rendimento_positivo') then
    alter table produtos add constraint produtos_rendimento_positivo check (rendimento > 0);
  end if;
end $$;

-- homologacao: 'nao_aplicavel' = comportamento legado (Subways e cadastro manual);
--   'pendente' = carga importada ainda não conferida pela empresa;
--   'homologada' = conferida por um administrador. CMV "homologado" exige
--   ficha completa E (homologada OU nao_aplicavel) — regra no backend (custo.js).
alter table produtos add column if not exists homologacao text not null default 'nao_aplicavel';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'produtos_homologacao_valida') then
    alter table produtos add constraint produtos_homologacao_valida
      check (homologacao in ('nao_aplicavel','pendente','homologada'));
  end if;
end $$;
alter table produtos add column if not exists homologado_em timestamptz;
alter table produtos add column if not exists homologado_por uuid references perfis(id) on delete set null;

-- ---------------------------------------------------------------------
-- 2. FN_CUSTO_PRODUTO — passa a considerar o rendimento (custo UNITÁRIO)
--    Mantém: custo_manual, linhas inativas ignoradas (021), recursão.
--    Novidade: cada nível divide pela produção do seu produto.
--      * raiz:        qtd = quantidade / rendimento_da_raiz
--      * submontagem: qtd = qtd_acumulada * quantidade / rendimento_da_sub
--    Com rendimento = 1 em todos os produtos, o resultado é idêntico ao anterior.
-- ---------------------------------------------------------------------
create or replace function fn_custo_produto(p_produto_id uuid)
returns numeric language sql stable as $$
  select coalesce(
    (select custo_manual from produtos where id = p_produto_id),
    (
      with recursive expl as (
        select ft.insumo_id, ft.subproduto_id,
               ft.quantidade::numeric / pr.rendimento as qtd, 1 as nivel
        from ficha_tecnica ft
        join produtos pr on pr.id = ft.produto_id
        where ft.produto_id = p_produto_id and coalesce(ft.ativo, true)
        union all
        select ft.insumo_id, ft.subproduto_id,
               e.qtd * ft.quantidade / ps.rendimento, e.nivel + 1
        from expl e
        join produtos ps on ps.id = e.subproduto_id
        join ficha_tecnica ft on ft.produto_id = e.subproduto_id and coalesce(ft.ativo, true)
        where e.subproduto_id is not null and e.nivel < 12   -- trava contra ciclo (espelha PROF_MAX do custo.js)
      )
      select coalesce(sum(e.qtd * i.preco_unitario), 0)
      from expl e
      join insumos i on i.id = e.insumo_id
      where e.insumo_id is not null
    )
  );
$$;

-- ---------------------------------------------------------------------
-- 3. MÃO DE OBRA — separada do CMV de ingredientes/embalagens
--    Nunca entra em fn_custo_produto. O backend expõe "custo técnico com MOD"
--    como indicador À PARTE, com a composição explícita.
-- ---------------------------------------------------------------------
create table if not exists ficha_mao_de_obra (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  produto_id uuid not null references produtos(id) on delete cascade,
  funcao text not null,
  minutos numeric(10,2) not null check (minutos >= 0),     -- minutos dedicados POR RECEITA (lote)
  custo_minuto numeric(12,6) check (custo_minuto is null or custo_minuto >= 0),
  ordem int not null default 0,
  created_at timestamptz not null default now(),
  unique (produto_id, funcao)
);
create index if not exists idx_ficha_mod_produto on ficha_mao_de_obra(produto_id);
create index if not exists idx_ficha_mod_org on ficha_mao_de_obra(organizacao_id);
alter table ficha_mao_de_obra enable row level security;

-- ---------------------------------------------------------------------
-- 4. RASTREABILIDADE DA IMPORTAÇÃO
-- ---------------------------------------------------------------------
create table if not exists catalogo_importacoes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  fonte text not null,                       -- ex.: 'caramelle-fichas-v1'
  arquivos jsonb not null default '[]',      -- [{nome, sha256}]
  status text not null default 'aplicada' check (status in ('aplicada','falhou')),
  resumo jsonb not null default '{}',
  criado_por uuid references perfis(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_catalogo_imp_org on catalogo_importacoes(organizacao_id, created_at desc);
alter table catalogo_importacoes enable row level security;

-- Uma linha por registro importado: é a CHAVE DE IDEMPOTÊNCIA (reimportar o
-- mesmo arquivo encontra a linha e atualiza, nunca duplica).
create table if not exists catalogo_origem (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  entidade text not null check (entidade in ('insumo','produto')),
  entidade_id uuid not null,
  fonte text not null,
  chave text not null,
  referencia jsonb not null default '{}',    -- arquivo, aba, linha, preço/custo ORIGINAL da planilha
  pendencias jsonb not null default '[]',    -- inconsistências detectadas na carga
  importacao_id uuid references catalogo_importacoes(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organizacao_id, fonte, entidade, chave)
);
create index if not exists idx_catalogo_origem_entidade on catalogo_origem(entidade, entidade_id);
alter table catalogo_origem enable row level security;

-- ---------------------------------------------------------------------
-- 5. FN_CATALOGO_IMPORTAR — importação TRANSACIONAL e IDEMPOTENTE
--
--    Um único chamado = uma transação (a função inteira faz rollback em erro).
--    TODA escrita é filtrada por p_org; nada toca outra organização.
--
--    Política de reprocessamento (decisão deliberada, ver docs):
--      * insumo existente: NADA é alterado (preço vigente, nome e categoria podem
--        ter sido editados pela empresa depois da carga); a diferença de preço
--        vai em `precos_divergentes` no retorno.
--      * produto existente: só reescreve ficha/MOD se p_sobrescrever_fichas=true
--        OU se o produto ainda não tem nenhuma linha de ficha.
--    Payload esperado (validado pelo backend ANTES — planejarCatalogo()):
--      { insumos:[{chave,nome,tipo,unidade_medida,preco_caixa,rendimento,referencia,pendencias}],
--        produtos:[{chave,nome,tipo,vendavel,rendimento,unidade_rendimento,preco_venda?,
--                   homologacao,referencia,pendencias,
--                   linhas:[{ref:'insumo'|'produto',chave,quantidade,ordem}],
--                   mao_de_obra:[{funcao,minutos,custo_minuto}]}] }
-- ---------------------------------------------------------------------
create or replace function fn_catalogo_importar(
  p_org uuid, p_fonte text, p_payload jsonb, p_usuario uuid default null,
  p_arquivos jsonb default '[]', p_sobrescrever_fichas boolean default false
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_imp uuid;
  r jsonb; l jsonb;
  v_id uuid; v_existe boolean;
  v_custo numeric;
  v_ins_novos int := 0; v_ins_existentes int := 0;
  v_prod_novos int := 0; v_prod_existentes int := 0; v_prod_fichas_preservadas int := 0;
  v_linhas int := 0;
  v_divergentes jsonb := '[]'::jsonb;
  v_map_ins jsonb := '{}'::jsonb;      -- chave -> uuid
  v_map_prod jsonb := '{}'::jsonb;
  v_prod_id uuid; v_ref_id uuid; v_reescreve boolean;
  v_preco_atual numeric;
begin
  if p_org is null or not exists (select 1 from organizacoes where id = p_org) then
    raise exception 'Organização inválida para importação de catálogo.' using errcode = '22023';
  end if;
  if coalesce(p_fonte,'') = '' then raise exception 'fonte obrigatória' using errcode = '22023'; end if;

  -- serializa importações concorrentes da MESMA organização (duas execuções simultâneas não duplicam)
  perform pg_advisory_xact_lock(hashtextextended('catalogo_importar:' || p_org::text, 0));

  insert into catalogo_importacoes (organizacao_id, fonte, arquivos, criado_por)
  values (p_org, p_fonte, coalesce(p_arquivos,'[]'), p_usuario) returning id into v_imp;

  -- ---- INSUMOS ----------------------------------------------------
  for r in select * from jsonb_array_elements(coalesce(p_payload->'insumos','[]'::jsonb)) loop
    select o.entidade_id into v_id from catalogo_origem o
      where o.organizacao_id = p_org and o.fonte = p_fonte and o.entidade = 'insumo' and o.chave = r->>'chave';
    v_existe := v_id is not null
                and exists (select 1 from insumos where id = v_id and organizacao_id = p_org);
    if v_existe then
      select preco_caixa into v_preco_atual from insumos where id = v_id and organizacao_id = p_org;
      -- compara na MESMA precisão da coluna (numeric(12,4)): evita falso positivo de arredondamento
      if nullif(r->>'preco_caixa','') is not null and v_preco_atual is distinct from round((r->>'preco_caixa')::numeric, 4) then
        v_divergentes := v_divergentes || jsonb_build_object('chave', r->>'chave', 'nome', r->>'nome',
          'vigente', v_preco_atual, 'planilha', (r->>'preco_caixa')::numeric);
      end if;
      -- (nada é alterado no insumo existente: nome/categoria podem ter sido editados pela empresa)
      v_ins_existentes := v_ins_existentes + 1;
    else
      insert into insumos (organizacao_id, nome, tipo, unidade_medida, preco_caixa, rendimento, fator_correcao,
                           preco_unitario, preco_atualizado_em, ativo)
      values (p_org, r->>'nome', (r->>'tipo')::tipo_insumo, (r->>'unidade_medida')::unidade_medida_enum,
              nullif(r->>'preco_caixa','')::numeric, nullif(r->>'rendimento','')::numeric, 1,
              case when nullif(r->>'preco_caixa','') is not null and coalesce(nullif(r->>'rendimento','')::numeric,0) > 0
                   then (r->>'preco_caixa')::numeric / (r->>'rendimento')::numeric else 0 end,
              case when nullif(r->>'preco_caixa','') is not null then now() end, true)
      returning id into v_id;
      -- histórico: preserva o custo informado na planilha como ponto de partida
      insert into insumo_historico (organizacao_id, insumo_id, preco_anterior, preco_novo, custo_anterior, custo_novo,
                                    unidade_medida_nova, usuario_id, observacao)
      select p_org, v_id, null, i.preco_caixa, null, i.preco_unitario, i.unidade_medida, p_usuario,
             'Carga inicial da planilha ' || p_fonte
        from insumos i where i.id = v_id and i.preco_caixa is not null;
      v_ins_novos := v_ins_novos + 1;
    end if;
    insert into catalogo_origem (organizacao_id, entidade, entidade_id, fonte, chave, referencia, pendencias, importacao_id)
    values (p_org, 'insumo', v_id, p_fonte, r->>'chave', coalesce(r->'referencia','{}'), coalesce(r->'pendencias','[]'), v_imp)
    on conflict (organizacao_id, fonte, entidade, chave)
    do update set entidade_id = excluded.entidade_id, referencia = excluded.referencia,
                  pendencias = excluded.pendencias, importacao_id = excluded.importacao_id, updated_at = now();
    v_map_ins := v_map_ins || jsonb_build_object(r->>'chave', v_id);
  end loop;

  -- ---- PRODUTOS (1ª passada: cria/atualiza o cabeçalho) -------------
  for r in select * from jsonb_array_elements(coalesce(p_payload->'produtos','[]'::jsonb)) loop
    select o.entidade_id into v_id from catalogo_origem o
      where o.organizacao_id = p_org and o.fonte = p_fonte and o.entidade = 'produto' and o.chave = r->>'chave';
    v_existe := v_id is not null
                and exists (select 1 from produtos where id = v_id and organizacao_id = p_org);
    if v_existe then
      -- (cabeçalho do produto existente não é alterado: pode ter sido editado/homologado)
      v_prod_existentes := v_prod_existentes + 1;
    else
      insert into produtos (organizacao_id, tipo, nome, vendavel, rendimento, unidade_rendimento, homologacao, ativo)
      values (p_org, (r->>'tipo')::tipo_produto, r->>'nome', coalesce((r->>'vendavel')::boolean, true),
              coalesce(nullif(r->>'rendimento','')::numeric, 1),
              nullif(r->>'unidade_rendimento','')::unidade_medida_enum,
              coalesce(r->>'homologacao','pendente'), true)
      returning id into v_id;
      v_prod_novos := v_prod_novos + 1;
    end if;
    insert into catalogo_origem (organizacao_id, entidade, entidade_id, fonte, chave, referencia, pendencias, importacao_id)
    values (p_org, 'produto', v_id, p_fonte, r->>'chave', coalesce(r->'referencia','{}'), coalesce(r->'pendencias','[]'), v_imp)
    on conflict (organizacao_id, fonte, entidade, chave)
    do update set entidade_id = excluded.entidade_id, referencia = excluded.referencia,
                  pendencias = excluded.pendencias, importacao_id = excluded.importacao_id, updated_at = now();
    v_map_prod := v_map_prod || jsonb_build_object(r->>'chave', v_id);
  end loop;

  -- ---- PRODUTOS (2ª passada: ficha e mão de obra) --------------------
  for r in select * from jsonb_array_elements(coalesce(p_payload->'produtos','[]'::jsonb)) loop
    v_prod_id := (v_map_prod->>(r->>'chave'))::uuid;
    v_reescreve := p_sobrescrever_fichas
                   or not exists (select 1 from ficha_tecnica where produto_id = v_prod_id);
    if not v_reescreve then
      v_prod_fichas_preservadas := v_prod_fichas_preservadas + 1;
      continue;
    end if;
    delete from ficha_tecnica where produto_id = v_prod_id
      and exists (select 1 from produtos where id = v_prod_id and organizacao_id = p_org);
    delete from ficha_mao_de_obra where produto_id = v_prod_id and organizacao_id = p_org;

    for l in select * from jsonb_array_elements(coalesce(r->'linhas','[]'::jsonb)) loop
      if l->>'ref' = 'insumo' then
        v_ref_id := (v_map_ins->>(l->>'chave'))::uuid;
        if v_ref_id is null then raise exception 'insumo "%" não encontrado no payload', l->>'chave' using errcode = '22023'; end if;
        insert into ficha_tecnica (produto_id, insumo_id, quantidade, ordem)
        values (v_prod_id, v_ref_id, (l->>'quantidade')::numeric, coalesce((l->>'ordem')::int, 0));
      else
        v_ref_id := (v_map_prod->>(l->>'chave'))::uuid;
        if v_ref_id is null then raise exception 'preparação "%" não encontrada no payload', l->>'chave' using errcode = '22023'; end if;
        insert into ficha_tecnica (produto_id, subproduto_id, quantidade, ordem)
        values (v_prod_id, v_ref_id, (l->>'quantidade')::numeric, coalesce((l->>'ordem')::int, 0));
      end if;
      v_linhas := v_linhas + 1;
    end loop;

    for l in select * from jsonb_array_elements(coalesce(r->'mao_de_obra','[]'::jsonb)) loop
      insert into ficha_mao_de_obra (organizacao_id, produto_id, funcao, minutos, custo_minuto)
      values (p_org, v_prod_id, l->>'funcao', (l->>'minutos')::numeric, nullif(l->>'custo_minuto','')::numeric)
      on conflict (produto_id, funcao) do update set minutos = excluded.minutos, custo_minuto = excluded.custo_minuto;
    end loop;
  end loop;

  -- ---- custo em cache (recursivo; ordem irrelevante) -----------------
  for r in select * from jsonb_array_elements(coalesce(p_payload->'produtos','[]'::jsonb)) loop
    perform fn_recalc_custo((v_map_prod->>(r->>'chave'))::uuid);
  end loop;

  update catalogo_importacoes set resumo = jsonb_build_object(
    'insumos_novos', v_ins_novos, 'insumos_existentes', v_ins_existentes,
    'produtos_novos', v_prod_novos, 'produtos_existentes', v_prod_existentes,
    'fichas_preservadas', v_prod_fichas_preservadas, 'linhas_ficha', v_linhas,
    'precos_divergentes', v_divergentes) where id = v_imp;

  return (select resumo || jsonb_build_object('importacao_id', v_imp) from catalogo_importacoes where id = v_imp);
end;
$$;

-- Só o backend (service_role) executa. anon/authenticated nunca.
revoke all on function fn_catalogo_importar(uuid, text, jsonb, uuid, jsonb, boolean) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function fn_catalogo_importar(uuid, text, jsonb, uuid, jsonb, boolean) to service_role;
  end if;
end $$;
