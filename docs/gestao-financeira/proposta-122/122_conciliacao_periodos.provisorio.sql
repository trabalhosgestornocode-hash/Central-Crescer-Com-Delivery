-- =====================================================================
-- PROVISÓRIO (NÃO EXECUTÁVEL PELO PIPELINE) — Conciliação (B7) e Períodos/Fechamento (B8). Depende do 121 provisório.
-- =====================================================================
-- Fica FORA de database/migrations. Numeração final coordenada com o Agente 1 (sugestão: 122, logo após a do domínio).
-- Validado só em PostgreSQL DESCARTÁVEL (backend/testes-financeiro-pg). NUNCA aplicar em produção a partir deste arquivo.

-- ---------------------------------------------------------------------
-- Colunas novas nas tabelas do domínio
-- ---------------------------------------------------------------------
-- Motivos de revisão preservados da importação (a_identificar, valor_por_formula, identica_no_arquivo, ...). Códigos, não texto livre.
alter table fin_lancamentos add column if not exists revisao_motivos text[] not null default '{}';
-- Canal de venda que a conta recebe (ex.: STONE). Opcional; vínculo explícito, nunca inferido pelo nome.
alter table fin_contas add column if not exists canal_referencia text;
-- Controle de concorrência otimista dos períodos.
alter table fin_periodos add column if not exists versao int not null default 1;

-- ---------------------------------------------------------------------
-- Dados de REFERÊNCIA da conciliação (vendas, taxas, sangrias, caixa em espécie) — vindos de fonte externa (PDV, planilha
-- complementar, manual). Nada é inventado: ausência de referência = "sem referência", nunca zero.
-- ---------------------------------------------------------------------
create table if not exists fin_referencias (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  data date not null,
  tipo text not null check (tipo in ('venda','taxa','sangria','dinheiro')),
  canal text,                                   -- ex.: STONE, IFOOD (normalizado em maiúsculas pelo backend)
  valor_centavos bigint not null check (valor_centavos >= 0),
  fonte text not null check (length(btrim(fonte)) > 0),   -- 'manual', 'pdv', 'planilha_complementar'...
  referencia_origem text,
  chave_origem text,                            -- idempotência de importações de referência
  nota text,
  status text not null default 'ativa' check (status in ('ativa','cancelada')),
  cancelada_por uuid, cancelada_em timestamptz, motivo_cancelamento text,
  criado_por uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'cancelada' or (motivo_cancelamento is not null and length(btrim(motivo_cancelamento)) > 0))
);
create unique index if not exists ux_fin_referencias_chave on fin_referencias (organizacao_id, unidade_id, chave_origem) where chave_origem is not null;
create index if not exists ix_fin_referencias_periodo on fin_referencias (organizacao_id, unidade_id, data);

-- Classificação MANUAL e autorizada de uma diferença (nunca automática). Não se apaga: revoga-se com motivo.
create table if not exists fin_conciliacao_resolucoes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  escopo text not null check (escopo in ('ponte_mensal','caixa_dia','sangria_dia')),
  chave date not null,                          -- dia (caixa/sangria) ou 1º dia do mês (ponte)
  classificacao text not null check (classificacao in ('prazo','taxa','ajuste','estorno','divergencia','outros')),
  valor_centavos bigint not null check (valor_centavos <> 0),   -- parcela da diferença que esta classificação explica (com sinal)
  diferenca_no_momento_centavos bigint not null,                -- diferença calculada quando foi classificada
  nota text not null check (length(btrim(nota)) >= 5),
  status text not null default 'vigente' check (status in ('vigente','revogada')),
  revogada_por uuid, revogada_em timestamptz, motivo_revogacao text,
  criado_por uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (escopo <> 'ponte_mensal' or chave = date_trunc('month', chave)::date),
  check (status <> 'revogada' or (motivo_revogacao is not null and length(btrim(motivo_revogacao)) > 0))
);
create index if not exists ix_fin_resolucoes_chave on fin_conciliacao_resolucoes (organizacao_id, unidade_id, escopo, chave);

-- Exceções configuráveis da conferência de sangrias (ex.: uma categoria paga em espécie que não é sangria). Auditáveis e aprovadas.
create table if not exists fin_sangria_excecoes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  categoria_id uuid not null references fin_plano_contas(id) on delete restrict,
  motivo text not null check (length(btrim(motivo)) >= 5),
  ativa boolean not null default true,
  aprovada_por uuid not null, aprovada_em timestamptz not null default now(),
  desativada_por uuid, desativada_em timestamptz, motivo_desativacao text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ativa or (motivo_desativacao is not null and length(btrim(motivo_desativacao)) > 0))
);
create unique index if not exists ux_fin_sangria_excecao_ativa on fin_sangria_excecoes (unidade_id, categoria_id) where ativa;

-- Política de fechamento por unidade. Padrão: NÃO permite fechar com pendências. Mudar exige aprovação explícita registrada.
create table if not exists fin_config (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  permite_fechar_com_pendencias boolean not null default false,
  aprovado_por uuid, aprovado_em timestamptz, nota_aprovacao text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (unidade_id),
  check (permite_fechar_com_pendencias = false or (aprovado_por is not null and aprovado_em is not null and nota_aprovacao is not null and length(btrim(nota_aprovacao)) >= 10))
);

-- ---------------------------------------------------------------------
-- Guardas
-- ---------------------------------------------------------------------
-- Lançamento (e demais datas): garante a LINHA do período (aberto) e a trava em modo compartilhado. O fechamento usa FOR UPDATE nessa linha:
-- escritas em andamento terminam antes do fechamento calcular a impressão (conflito detectado), e escritas posteriores veem o mês fechado.
create or replace function fin_periodo_travar_e_checar(p_org uuid, p_unidade uuid, p_data date) returns void language plpgsql as $$
declare v_mes date := date_trunc('month', p_data)::date; v_status text;
begin
  insert into fin_periodos (organizacao_id, unidade_id, mes, status) values (p_org, p_unidade, v_mes, 'aberto') on conflict (unidade_id, mes) do nothing;
  select status into v_status from fin_periodos where unidade_id = p_unidade and mes = v_mes for share;
  if v_status = 'fechado' then raise exception 'fin_periodo_fechado' using errcode = '23514'; end if;
end $$;

create or replace function fin_lancamentos_guarda() returns trigger language plpgsql as $$
declare v_par uuid;
begin
  if tg_op = 'UPDATE' then
    if new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id
       or new.origem is distinct from old.origem or new.chave_origem is distinct from old.chave_origem
       or new.importacao_id is distinct from old.importacao_id or new.criado_por is distinct from old.criado_por then
      raise exception 'fin_campo_imutavel' using errcode = '23514';
    end if;
    -- Perna de transferência VINCULADA: valor/sentido/conta/data/CATEGORIA só mudam desvinculando o par (achado da revisão da 121: a categoria
    -- podia sair de "transferência" e deixar o par inconsistente). O STATUS só muda pelo cancelamento ATÔMICO do par (flag local da função).
    select t.id into v_par from fin_transferencias t where t.lancamento_saida_id = old.id or t.lancamento_entrada_id = old.id;
    if v_par is not null then
      if new.valor_centavos is distinct from old.valor_centavos or new.sentido is distinct from old.sentido or new.conta_id is distinct from old.conta_id
         or new.data_movimento is distinct from old.data_movimento or new.categoria_id is distinct from old.categoria_id then
        raise exception 'fin_transferencia_vinculada: desvincule o par antes de alterar este lancamento' using errcode = '23514';
      end if;
      if new.status is distinct from old.status and coalesce(current_setting('fin.cancelando_par', true), '') <> v_par::text then
        raise exception 'fin_transferencia_vinculada: use o cancelamento da transferencia inteira' using errcode = '23514';
      end if;
    end if;
    if date_trunc('month', old.data_movimento) <> date_trunc('month', new.data_movimento) then
      perform fin_periodo_travar_e_checar(old.organizacao_id, old.unidade_id, old.data_movimento);
    end if;
  end if;
  perform fin_periodo_travar_e_checar(new.organizacao_id, new.unidade_id, new.data_movimento);
  return new;
end $$;

-- Tabelas com coluna de data (argumento do gatilho): referências, resoluções, aberturas — mês fechado também é intocável.
create or replace function fin_guarda_periodo_data() returns trigger language plpgsql as $$
declare j jsonb := to_jsonb(new); v_data date := nullif(j->>tg_argv[0], '')::date;
begin
  if v_data is not null then perform fin_periodo_travar_e_checar(new.organizacao_id, new.unidade_id, v_data); end if;
  return new;
end $$;

-- Transições permitidas: aberto/reaberto → fechado (via função); fechado → reaberto (com motivo). Snapshot de período fechado é imutável.
create or replace function fin_periodos_guarda() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id or new.mes is distinct from old.mes then
      raise exception 'fin_campo_imutavel' using errcode = '23514';
    end if;
    if old.status = 'fechado' then
      if new.status = 'fechado' then
        if new.snapshot is distinct from old.snapshot or new.fechado_em is distinct from old.fechado_em or new.fechado_por is distinct from old.fechado_por then
          raise exception 'fin_snapshot_imutavel' using errcode = '23514';
        end if;
      elsif new.status <> 'reaberto' then
        raise exception 'fin_periodo_transicao_invalida' using errcode = '23514';
      end if;
    end if;
    if new.status = 'fechado' and old.status <> 'fechado' and (new.snapshot is null or new.fechado_por is null or new.fechado_em is null) then
      raise exception 'fin_periodo_fechamento_incompleto: snapshot, responsavel e data sao obrigatorios' using errcode = '23514';
    end if;
    new.versao := old.versao + 1;
  end if;
  return new;
end $$;
drop trigger if exists trg_fin_periodos_guarda on fin_periodos;
create trigger trg_fin_periodos_guarda before update on fin_periodos for each row execute function fin_periodos_guarda();

do $$
declare t text;
begin
  foreach t in array array['fin_referencias','fin_conciliacao_resolucoes','fin_sangria_excecoes','fin_config'] loop
    execute format('drop trigger if exists trg_%1$s_auditar on %1$s', t);
    execute format('create trigger trg_%1$s_auditar after insert or update or delete on %1$s for each row execute function fin_auditar()', t);
    execute format('drop trigger if exists trg_%1$s_upd on %1$s', t);
    execute format('create trigger trg_%1$s_upd before update on %1$s for each row execute function fin_touch_updated_at()', t);
    execute format('drop trigger if exists trg_%1$s_escopo on %1$s', t);
    execute format('create trigger trg_%1$s_escopo before insert or update on %1$s for each row execute function fin_validar_escopo()', t);
  end loop;
end $$;
drop trigger if exists trg_fin_referencias_periodo on fin_referencias;
create trigger trg_fin_referencias_periodo before insert or update on fin_referencias for each row execute function fin_guarda_periodo_data('data');
drop trigger if exists trg_fin_resolucoes_periodo on fin_conciliacao_resolucoes;
create trigger trg_fin_resolucoes_periodo before insert or update on fin_conciliacao_resolucoes for each row execute function fin_guarda_periodo_data('chave');
drop trigger if exists trg_fin_saldos_periodo on fin_saldos_abertura;
create trigger trg_fin_saldos_periodo before insert or update on fin_saldos_abertura for each row execute function fin_guarda_periodo_data('data_referencia');

-- ---------------------------------------------------------------------
-- Operações de período (atômicas, com controle de concorrência)
-- ---------------------------------------------------------------------
-- Impressão digital do conteúdo que alimenta o fechamento do mês (lançamentos, referências, resoluções, aberturas).
create or replace function fin_fingerprint_periodo(p_org uuid, p_unidade uuid, p_mes date) returns text language sql stable as $$
  select md5(
    coalesce((select string_agg(l.id::text || ':' || l.valor_centavos || ':' || l.sentido || ':' || l.status || ':' || coalesce(l.categoria_id::text, '-') || ':' || l.conta_id::text || ':' || l.classificacao_pendente::text || ':' || l.data_movimento::text, '|' order by l.id)
              from fin_lancamentos l where l.organizacao_id = p_org and l.unidade_id = p_unidade and l.data_movimento >= p_mes and l.data_movimento < (p_mes + interval '1 month')::date), '')
    || '#' ||
    coalesce((select string_agg(r.id::text || ':' || r.valor_centavos || ':' || r.status || ':' || r.tipo || ':' || coalesce(r.canal, '-'), '|' order by r.id)
              from fin_referencias r where r.organizacao_id = p_org and r.unidade_id = p_unidade and r.data >= p_mes and r.data < (p_mes + interval '1 month')::date), '')
    || '#' ||
    coalesce((select string_agg(x.id::text || ':' || x.valor_centavos || ':' || x.status, '|' order by x.id)
              from fin_conciliacao_resolucoes x where x.organizacao_id = p_org and x.unidade_id = p_unidade and x.chave >= p_mes and x.chave < (p_mes + interval '1 month')::date), '')
    || '#' ||
    coalesce((select string_agg(a.id::text || ':' || a.valor_centavos, '|' order by a.id)
              from fin_saldos_abertura a where a.organizacao_id = p_org and a.unidade_id = p_unidade and a.data_referencia >= p_mes and a.data_referencia < (p_mes + interval '1 month')::date), ''))
$$;

create or replace function fin_abrir_periodo(p_org uuid, p_unidade uuid, p_usuario uuid, p_mes date) returns jsonb language plpgsql as $$
declare v fin_periodos;
begin
  if p_mes <> date_trunc('month', p_mes)::date then raise exception 'fin_periodo_mes_invalido' using errcode = '23514'; end if;
  insert into fin_periodos (organizacao_id, unidade_id, mes, status) values (p_org, p_unidade, p_mes, 'aberto') on conflict (unidade_id, mes) do nothing;
  select * into v from fin_periodos where unidade_id = p_unidade and mes = p_mes and organizacao_id = p_org;
  if not found then raise exception 'fin_periodo_nao_encontrado' using errcode = 'P0002'; end if;
  return to_jsonb(v);
end $$;

-- Fecha o mês: tudo ou nada. Falha se: já fechado; versão desatualizada; conteúdo mudou desde a impressão que gerou o snapshot;
-- há pendências impeditivas e a política (aprovada) não permite — e, se permite, o chamador precisa reconhecê-las explicitamente.
create or replace function fin_fechar_periodo(
  p_org uuid, p_unidade uuid, p_usuario uuid, p_mes date, p_versao int, p_fingerprint text, p_snapshot jsonb,
  p_pendencias_conciliacao int, p_reconheco_pendencias boolean
) returns jsonb language plpgsql as $$
declare v fin_periodos; n_pend int; permite boolean := false;
begin
  if p_mes <> date_trunc('month', p_mes)::date then raise exception 'fin_periodo_mes_invalido' using errcode = '23514'; end if;
  insert into fin_periodos (organizacao_id, unidade_id, mes, status) values (p_org, p_unidade, p_mes, 'aberto') on conflict (unidade_id, mes) do nothing;
  select * into v from fin_periodos where unidade_id = p_unidade and mes = p_mes and organizacao_id = p_org for update;
  if not found then raise exception 'fin_periodo_nao_encontrado' using errcode = 'P0002'; end if;
  if v.status = 'fechado' then raise exception 'fin_periodo_ja_fechado' using errcode = '23514'; end if;
  if v.versao <> p_versao then raise exception 'fin_periodo_conflito_versao: o periodo mudou, recarregue' using errcode = '23514'; end if;
  if fin_fingerprint_periodo(p_org, p_unidade, p_mes) <> p_fingerprint then
    raise exception 'fin_periodo_conflito_dados: ha lancamentos ou referencias alterados desde a pre-visualizacao; recalcule' using errcode = '23514';
  end if;
  select count(*) into n_pend from fin_lancamentos l
   where l.organizacao_id = p_org and l.unidade_id = p_unidade and l.data_movimento >= p_mes and l.data_movimento < (p_mes + interval '1 month')::date
     and l.status <> 'cancelado' and (l.classificacao_pendente or l.categoria_id is null);
  n_pend := n_pend + coalesce(p_pendencias_conciliacao, 0);
  if n_pend > 0 then
    select c.permite_fechar_com_pendencias into permite from fin_config c where c.unidade_id = p_unidade and c.organizacao_id = p_org;
    permite := coalesce(permite, false);
    if not permite then raise exception 'fin_periodo_pendencias: % pendencia(s) impedem o fechamento', n_pend using errcode = '23514'; end if;
    if p_reconheco_pendencias is not true then raise exception 'fin_periodo_pendencias_nao_reconhecidas: % pendencia(s)', n_pend using errcode = '23514'; end if;
  end if;
  update fin_periodos set status = 'fechado', fechado_por = p_usuario, fechado_em = now(),
         snapshot = coalesce(p_snapshot, '{}'::jsonb) || jsonb_build_object('pendenciasNoFechamento', n_pend, 'fingerprint', p_fingerprint, 'politicaPermitiaPendencias', permite)
   where id = v.id returning * into v;
  return to_jsonb(v);
end $$;

create or replace function fin_reabrir_periodo(p_org uuid, p_unidade uuid, p_usuario uuid, p_mes date, p_versao int, p_motivo text)
returns jsonb language plpgsql as $$
declare v fin_periodos;
begin
  if p_motivo is null or length(btrim(p_motivo)) < 10 then raise exception 'fin_periodo_motivo_obrigatorio: informe o motivo (minimo 10 caracteres)' using errcode = '23514'; end if;
  select * into v from fin_periodos where unidade_id = p_unidade and mes = p_mes and organizacao_id = p_org for update;
  if not found then raise exception 'fin_periodo_nao_encontrado' using errcode = 'P0002'; end if;
  if v.status <> 'fechado' then raise exception 'fin_periodo_nao_fechado' using errcode = '23514'; end if;
  if v.versao <> p_versao then raise exception 'fin_periodo_conflito_versao: o periodo mudou, recarregue' using errcode = '23514'; end if;
  update fin_periodos set status = 'reaberto', reaberto_por = p_usuario, reaberto_em = now(), motivo_reabertura = btrim(p_motivo) where id = v.id returning * into v;
  return to_jsonb(v);
end $$;

-- Importação: passa a gravar também os motivos de revisão (códigos). Demais regras idênticas à versão do 121.
create or replace function fin_confirmar_importacao(p_org uuid, p_unidade uuid, p_usuario uuid, p_importacao uuid)
returns jsonb language plpgsql as $$
declare v fin_importacoes; n_lanc int; n_dup int; n_saldos int; n_pares int; r jsonb;
begin
  select * into v from fin_importacoes where id = p_importacao and organizacao_id = p_org and unidade_id = p_unidade for update;
  if not found then raise exception 'fin_importacao_nao_encontrada' using errcode = 'P0002'; end if;
  if v.status = 'confirmada' then return coalesce(v.resumo, '{}'::jsonb) || jsonb_build_object('jaConfirmada', true); end if;
  if v.status <> 'previa' then raise exception 'fin_importacao_estado_invalido: %', v.status using errcode = '23514'; end if;

  insert into fin_contas (organizacao_id, unidade_id, nome, tipo_conta, criado_por, atualizado_por)
  select p_org, p_unidade, c->>'nome', coalesce(c->>'tipo_conta','outra'), p_usuario, p_usuario
  from jsonb_array_elements(coalesce(v.previa->'contas','[]')) c on conflict (unidade_id, nome) do nothing;

  insert into fin_plano_contas (organizacao_id, tipo, natureza, nome, papel, criado_por, atualizado_por)
  select p_org, c->>'tipo', c->>'natureza', c->>'nome', c->>'papel', p_usuario, p_usuario
  from jsonb_array_elements(coalesce(v.previa->'categorias','[]')) c on conflict (organizacao_id, tipo, natureza, nome) do nothing;

  insert into fin_saldos_abertura (organizacao_id, unidade_id, conta_id, data_referencia, valor_centavos, origem, criado_por)
  select p_org, p_unidade, c.id, (s->>'data')::date, (s->>'valor_centavos')::bigint, 'importacao', p_usuario
  from jsonb_array_elements(coalesce(v.previa->'saldos','[]')) s
  join fin_contas c on c.unidade_id = p_unidade and c.nome = s->>'conta'
  on conflict (conta_id, data_referencia) do nothing;
  get diagnostics n_saldos = row_count;

  insert into fin_lancamentos (organizacao_id, unidade_id, conta_id, categoria_id, descricao, sentido, valor_centavos, data_movimento,
                               origem, importacao_id, chave_origem, referencia_origem, classificacao_pendente, nota_revisao, revisao_motivos, criado_por, atualizado_por)
  select p_org, p_unidade, c.id, pc.id, l->>'descricao', l->>'sentido', (l->>'valor_centavos')::bigint, (l->>'data')::date,
         'importacao', p_importacao, l->>'chave', l->>'referencia', coalesce((l->>'pendente')::boolean, false) or pc.id is null,
         nullif(l->>'nota',''),
         coalesce((select array_agg(m) from jsonb_array_elements_text(case when jsonb_typeof(l->'motivos') = 'array' then l->'motivos' else '[]'::jsonb end) m), '{}'),
         p_usuario, p_usuario
  from jsonb_array_elements(coalesce(v.previa->'lancamentos','[]')) l
  join fin_contas c on c.unidade_id = p_unidade and c.nome = l->>'conta'
  left join fin_plano_contas pc on pc.organizacao_id = p_org and l->'categoria' is not null and jsonb_typeof(l->'categoria') = 'object'
       and pc.tipo = l#>>'{categoria,tipo}' and pc.natureza = l#>>'{categoria,natureza}' and pc.nome = l#>>'{categoria,nome}'
  where coalesce((l->>'importar')::boolean, true)
  on conflict (organizacao_id, unidade_id, chave_origem) where chave_origem is not null do nothing;
  get diagnostics n_lanc = row_count;
  n_dup := (select count(*) from jsonb_array_elements(coalesce(v.previa->'lancamentos','[]')) l where coalesce((l->>'importar')::boolean, true)) - n_lanc;

  insert into fin_transferencias (organizacao_id, unidade_id, lancamento_saida_id, lancamento_entrada_id, origem, criado_por)
  select p_org, p_unidade, ls.id, le.id, 'importacao', p_usuario
  from jsonb_array_elements(coalesce(v.previa->'pares','[]')) p
  join fin_lancamentos ls on ls.organizacao_id = p_org and ls.unidade_id = p_unidade and ls.chave_origem = p->>'saida'
  join fin_lancamentos le on le.organizacao_id = p_org and le.unidade_id = p_unidade and le.chave_origem = p->>'entrada'
  where coalesce((p->>'confirmado')::boolean, false)
  on conflict do nothing;
  get diagnostics n_pares = row_count;

  r := jsonb_build_object('lancamentosGravados', n_lanc, 'jaExistentes', n_dup, 'saldosGravados', n_saldos, 'paresVinculados', n_pares);
  update fin_importacoes set status = 'confirmada', resumo = r, confirmado_por = p_usuario, confirmado_em = now() where id = p_importacao;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- Privilégios: backend-only (RLS ligada, nenhuma policy), sem DELETE.
-- ---------------------------------------------------------------------
do $$
declare t text; r text;
begin
  foreach t in array array['fin_referencias','fin_conciliacao_resolucoes','fin_sangria_excecoes','fin_config'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from public', t);
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table %I from %I', t, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on table %I from service_role', t);
      execute format('grant select, insert, update on table %I to service_role', t);
    end if;
  end loop;
  foreach t in array array['fin_fingerprint_periodo(uuid,uuid,date)','fin_abrir_periodo(uuid,uuid,uuid,date)',
      'fin_fechar_periodo(uuid,uuid,uuid,date,int,text,jsonb,int,boolean)','fin_reabrir_periodo(uuid,uuid,uuid,date,int,text)',
      'fin_periodo_travar_e_checar(uuid,uuid,date)','fin_confirmar_importacao(uuid,uuid,uuid,uuid)'] loop
    execute format('revoke all on function %s from public', t);
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', t, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', t); end if;
  end loop;
end $$;

-- =====================================================================
-- CANCELAMENTO ATÔMICO DE TRANSFERÊNCIA + CORREÇÕES DA REVISÃO FORMAL DA 121
-- =====================================================================
-- Três operações, três regras (nenhuma apaga nada):
--   1) Cancelar lançamento isolado  → perna VINCULADA é recusada pelo banco (use 2 ou 3).
--   2) Desvincular par incorreto    → fin_desvincular_transferencia_motivada (motivo obrigatório; as pernas ficam ATIVAS e PENDENTES).
--   3) Cancelar transferência inteira → fin_cancelar_transferencia (motivo; as DUAS pernas e o par, na mesma transação, ou nada).

alter table fin_transferencias add column if not exists status text not null default 'vinculada';
alter table fin_transferencias add column if not exists cancelada_por uuid;
alter table fin_transferencias add column if not exists cancelada_em timestamptz;
alter table fin_transferencias add column if not exists motivo_cancelamento text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fin_transferencias_status_check') then
    alter table fin_transferencias add constraint fin_transferencias_status_check check (status in ('vinculada','cancelada'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fin_transferencias_cancelamento_check') then
    alter table fin_transferencias add constraint fin_transferencias_cancelamento_check
      check (status <> 'cancelada' or (cancelada_por is not null and cancelada_em is not null and length(btrim(coalesce(motivo_cancelamento, ''))) >= 10));
  end if;
  -- achado da revisão: importacao_id sem FK permitia apontar para importação de outro tenant
  if not exists (select 1 from pg_constraint where conname = 'fin_lancamentos_importacao_fk') then
    alter table fin_lancamentos add constraint fin_lancamentos_importacao_fk foreign key (importacao_id) references fin_importacoes(id) on delete restrict not valid;
    alter table fin_lancamentos validate constraint fin_lancamentos_importacao_fk;
  end if;
end $$;

-- O par só muda de 'vinculada' para 'cancelada' (e depois fica imutável); pernas/tenant nunca mudam.
create or replace function fin_transferencias_guarda() returns trigger language plpgsql as $$
begin
  if new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id
     or new.lancamento_saida_id is distinct from old.lancamento_saida_id or new.lancamento_entrada_id is distinct from old.lancamento_entrada_id then
    raise exception 'fin_campo_imutavel' using errcode = '23514';
  end if;
  if old.status = 'cancelada' and new.status is distinct from old.status then raise exception 'fin_transferencia_cancelada_imutavel' using errcode = '23514'; end if;
  if old.status = 'cancelada' and (new.motivo_cancelamento is distinct from old.motivo_cancelamento or new.cancelada_em is distinct from old.cancelada_em) then
    raise exception 'fin_transferencia_cancelada_imutavel' using errcode = '23514';
  end if;
  if new.status = 'cancelada' and old.status <> 'cancelada' and coalesce(current_setting('fin.cancelando_par', true), '') <> old.id::text then
    raise exception 'fin_transferencia_vinculada: use o cancelamento da transferencia inteira' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists trg_fin_transferencias_guarda on fin_transferencias;
create trigger trg_fin_transferencias_guarda before update on fin_transferencias for each row execute function fin_transferencias_guarda();

-- Rede de segurança NO COMMIT: as duas pernas de um par sempre terminam com o MESMO status (cancelamento parcial é impossível,
-- mesmo que alguém contorne a flag da função).
create or replace function fin_par_status_consistente() returns trigger language plpgsql as $$
declare v_outro text;
begin
  select l2.status into v_outro
    from fin_transferencias t join fin_lancamentos l2 on l2.id = case when t.lancamento_saida_id = new.id then t.lancamento_entrada_id else t.lancamento_saida_id end
   where new.id in (t.lancamento_saida_id, t.lancamento_entrada_id);
  if found and v_outro is distinct from new.status then
    raise exception 'fin_transferencia_parcial: as duas pernas do par precisam ter o mesmo status' using errcode = '23514';
  end if;
  return null;
end $$;
drop trigger if exists trg_fin_par_status_consistente on fin_lancamentos;
create constraint trigger trg_fin_par_status_consistente after update of status on fin_lancamentos
  deferrable initially deferred for each row execute function fin_par_status_consistente();

-- Cancela a transferência INTEIRA. Ordem de travas: par → pernas (por id) → período (via gatilho). Idempotente.
create or replace function fin_cancelar_transferencia(p_org uuid, p_unidade uuid, p_usuario uuid, p_transferencia uuid, p_motivo text)
returns jsonb language plpgsql as $$
declare t fin_transferencias; ls fin_lancamentos; le fin_lancamentos; v_motivo text := btrim(coalesce(p_motivo, ''));
begin
  if length(v_motivo) < 10 then raise exception 'fin_transferencia_motivo_obrigatorio: informe o motivo (minimo 10 caracteres)' using errcode = '23514'; end if;
  select * into t from fin_transferencias where id = p_transferencia and organizacao_id = p_org and unidade_id = p_unidade for update;
  if not found then raise exception 'fin_transferencia_nao_encontrada' using errcode = 'P0002'; end if;
  perform 1 from fin_lancamentos where id in (t.lancamento_saida_id, t.lancamento_entrada_id) order by id for update;
  select * into ls from fin_lancamentos where id = t.lancamento_saida_id;
  select * into le from fin_lancamentos where id = t.lancamento_entrada_id;
  if t.status = 'cancelada' then
    if ls.status = 'cancelado' and le.status = 'cancelado' then
      return jsonb_build_object('id', t.id, 'status', 'cancelada', 'jaCancelada', true, 'lancamentos', jsonb_build_array(ls.id, le.id));   -- idempotente
    end if;
    raise exception 'fin_transferencia_estado_inconsistente' using errcode = '23514';
  end if;
  if ls.status = 'cancelado' or le.status = 'cancelado' then raise exception 'fin_transferencia_estado_inconsistente: ha perna ja cancelada isoladamente' using errcode = '23514'; end if;
  if ls.status <> 'realizado' or le.status <> 'realizado' then raise exception 'fin_transferencia_nao_cancelavel: as duas pernas precisam estar realizadas' using errcode = '23514'; end if;
  perform fin_periodo_travar_e_checar(ls.organizacao_id, ls.unidade_id, ls.data_movimento);      -- meses das duas pernas precisam estar abertos
  perform fin_periodo_travar_e_checar(le.organizacao_id, le.unidade_id, le.data_movimento);
  perform set_config('fin.cancelando_par', t.id::text, true);                                     -- vale só nesta transação
  update fin_transferencias set status = 'cancelada', cancelada_por = p_usuario, cancelada_em = now(), motivo_cancelamento = v_motivo where id = t.id;
  update fin_lancamentos set status = 'cancelado', atualizado_por = p_usuario,
         nota_revisao = case when nota_revisao is null or nota_revisao = '' then 'Transferencia cancelada: ' || v_motivo else nota_revisao || ' | Transferencia cancelada: ' || v_motivo end
   where id in (ls.id, le.id);
  perform set_config('fin.cancelando_par', '', true);
  return jsonb_build_object('id', t.id, 'status', 'cancelada', 'jaCancelada', false, 'lancamentos', jsonb_build_array(ls.id, le.id));
end $$;

-- Desvincula (par incorreto) COM motivo, só de par ATIVO. As pernas continuam ativas e voltam a pendentes; o motivo fica na nota de ambas (auditada).
create or replace function fin_desvincular_transferencia_motivada(p_org uuid, p_unidade uuid, p_usuario uuid, p_transferencia uuid, p_motivo text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare t fin_transferencias; v_motivo text := btrim(coalesce(p_motivo, ''));
begin
  if length(v_motivo) < 10 then raise exception 'fin_transferencia_motivo_obrigatorio: informe o motivo (minimo 10 caracteres)' using errcode = '23514'; end if;
  select * into t from fin_transferencias where id = p_transferencia and organizacao_id = p_org and unidade_id = p_unidade for update;
  if not found then return false; end if;
  if t.status <> 'vinculada' then raise exception 'fin_transferencia_cancelada_imutavel: transferencia cancelada nao pode ser desvinculada' using errcode = '23514'; end if;
  perform 1 from fin_lancamentos where id in (t.lancamento_saida_id, t.lancamento_entrada_id) order by id for update;
  if exists (select 1 from fin_lancamentos where id in (t.lancamento_saida_id, t.lancamento_entrada_id) and status <> 'realizado') then
    raise exception 'fin_transferencia_estado_inconsistente' using errcode = '23514';
  end if;
  delete from fin_transferencias where id = t.id;
  update fin_lancamentos set classificacao_pendente = true, atualizado_por = p_usuario,
         nota_revisao = case when nota_revisao is null or nota_revisao = '' then 'Par desfeito: ' || v_motivo else nota_revisao || ' | Par desfeito: ' || v_motivo end,
         revisao_motivos = case when 'transferencia_sem_contraparte' = any(revisao_motivos) then revisao_motivos else array_append(revisao_motivos, 'transferencia_sem_contraparte') end
   where id in (t.lancamento_saida_id, t.lancamento_entrada_id);
  return true;
end $$;

-- ---------------------------------------------------------------------
-- Privilégios das novas funções + endurecimento apontado pela revisão da 121
-- ---------------------------------------------------------------------
do $$
declare f text; r text;
begin
  foreach f in array array['fin_cancelar_transferencia(uuid,uuid,uuid,uuid,text)','fin_desvincular_transferencia_motivada(uuid,uuid,uuid,uuid,text)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  -- desvínculo SEM motivo (121) deixa de ser chamável pelo backend: a regra própria exige motivo
  revoke all on function fin_desvincular_transferencia(uuid,uuid,uuid,uuid) from public;
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function fin_desvincular_transferencia(uuid,uuid,uuid,uuid) from %I', r); end if;
  end loop;
  -- funções de gatilho não são para ninguém chamar (paridade com a 120): sem EXECUTE para PUBLIC/anon/authenticated
  foreach f in array array['fin_touch_updated_at()','fin_validar_escopo()','fin_lancamentos_guarda()','fin_plano_contas_guarda()','fin_transferencias_validar()','fin_auditar()',
                           'fin_auditoria_imutavel()','fin_guarda_periodo_data()','fin_periodos_guarda()','fin_transferencias_guarda()','fin_par_status_consistente()'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  -- a sequência da auditoria não deve ser alcançável por papéis públicos (Supabase concede por default privileges)
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on sequence fin_auditoria_id_seq from %I', r); end if;
  end loop;
  revoke all on sequence fin_auditoria_id_seq from public;
end $$;
