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

-- Fechamento com pendências: NÃO existe política geral (o gestor não flexibiliza o controle). A ÚNICA via é a EXCEÇÃO POR UNIDADE E COMPETÊNCIA,
-- concedida em caráter excepcional por SuperAdmin (fora do domínio; a função de concessão NÃO é executável pelo service_role até a validação do MFA):
-- justificada, auditada, com as pendências IDENTIFICADAS no ato, de validade curta (≤ 30 dias), de USO ÚNICO, nunca permanente. Conceder não altera,
-- apaga nem reclassifica nenhuma pendência. `fin_fechar_periodo` só consome exceção ativa que cubra TODAS as pendências do mês.
-- Evidência de MFA (A2/LD-009): lista FECHADA de chaves {aal, em, metodo, sessao_ref}. `em` = instante efetivo do 2º fator em ISO-8601 UTC (ex.: 2026-10-17T13:40:00Z).
-- `sessao_ref` = sha256 hex (64) do session_id — NUNCA o valor cru. Nenhum valor pode ter cara de JWT/segredo: o formato exato de cada chave já o impede, e a
-- checagem explícita abaixo recusa também qualquer texto com três segmentos base64url ou iniciado em "eyJ" (para que nem por erro um token entre no banco/auditoria).
create or replace function fin_mfa_evidencia_valida(j jsonb) returns boolean language sql immutable as $$
  select coalesce(jsonb_typeof(j) = 'object'
     and not exists (select 1 from jsonb_object_keys(j) k where k not in ('aal', 'em', 'metodo', 'sessao_ref'))
     and j->>'aal' = 'aal2'
     and jsonb_typeof(j->'em') = 'string' and (j->>'em') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
     and (not j ? 'metodo' or (jsonb_typeof(j->'metodo') = 'string' and j->>'metodo' in ('totp', 'webauthn', 'phone')))
     and (not j ? 'sessao_ref' or (jsonb_typeof(j->'sessao_ref') = 'string' and j->>'sessao_ref' ~ '^[0-9a-f]{64}$'))
     and not exists (select 1 from jsonb_each_text(j) e where e.value ~ '^eyJ' or e.value ~ '^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$'), false)   -- coalesce: qualquer NULL (chave ausente) é inválido
$$;

-- Pendências de CONCILIAÇÃO têm identidade estável: "escopo:chave" (ponte_mensal:AAAA-MM-01, caixa_dia:AAAA-MM-DD, sangria_dia:AAAA-MM-DD), calculadas pelo backend a partir
-- das referências e dos lançamentos. O banco não as recalcula (a conciliação é calculada na aplicação); ele exige ids válidos, sem repetição, e compara por CONJUNTO.
create or replace function fin_ids_conciliacao_validos(ids text[]) returns boolean language sql immutable as $$
  select coalesce(not exists (select 1 from unnest(ids) i where i is null or i !~ '^(ponte_mensal|caixa_dia|sangria_dia):\d{4}-\d{2}-\d{2}$')
                  and cardinality(ids) = (select count(distinct i) from unnest(ids) i), false)
$$;

create table if not exists fin_excecoes_fechamento (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete restrict,
  unidade_id uuid not null references unidades(id) on delete restrict,
  mes date not null check (mes = date_trunc('month', mes)::date),
  justificativa text not null check (length(btrim(justificativa)) >= 20),
  pendencias jsonb not null,                                   -- [{ "id": <lancamento>, "motivos": [...] }, ...] identificadas no ato
  pendencias_conciliacao_ids text[] not null default '{}' check (fin_ids_conciliacao_validos(pendencias_conciliacao_ids)),   -- ids estáveis das pendências de conciliação cobertas
  pendencias_hash text not null check (pendencias_hash ~ '^[0-9a-f]{64}$'),   -- sha256 do conjunto ordenado (ids de lançamentos # ids de conciliação) no ato da concessão: prova de cobertura
  quantidade int not null check (quantidade > 0 or cardinality(pendencias_conciliacao_ids) > 0),
  aprovada_por uuid not null,                                  -- SuperAdmin (auth.users.id; sem FK para sobreviver à conta)
  mfa_evidencia jsonb not null check (fin_mfa_evidencia_valida(mfa_evidencia)),   -- carimbo/AAL fornecido pela plataforma (Agente 1); sem MFA não há exceção
  aprovada_em timestamptz not null default now(),
  expira_em timestamptz not null,
  status text not null default 'ativa' check (status in ('ativa','consumida','revogada')),
  consumida_por uuid, consumida_em timestamptz,
  revogada_por uuid, revogada_em timestamptz, motivo_revogacao text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expira_em > aprovada_em and expira_em <= aprovada_em + interval '30 days'),
  check (jsonb_typeof(pendencias) = 'array' and jsonb_array_length(pendencias) = quantidade),
  check (status <> 'consumida' or (consumida_por is not null and consumida_em is not null)),
  check (status <> 'revogada' or (revogada_por is not null and revogada_em is not null and length(btrim(coalesce(motivo_revogacao, ''))) >= 10))
);
create unique index if not exists ux_fin_excecao_fechamento_ativa on fin_excecoes_fechamento (unidade_id, mes) where status = 'ativa';
create index if not exists ix_fin_excecao_fechamento_tenant on fin_excecoes_fechamento (organizacao_id, unidade_id, mes);

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
  foreach t in array array['fin_referencias','fin_conciliacao_resolucoes','fin_sangria_excecoes','fin_excecoes_fechamento'] loop
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
-- há pendências impeditivas SEM exceção ativa (unidade+competência, concedida por SuperAdmin) que cubra TODAS elas — e, havendo exceção, o chamador
-- precisa reconhecer as pendências. A exceção é de USO ÚNICO e é consumida no mesmo ato. Não existe política geral que o gestor possa ligar.
create or replace function fin_fechar_periodo(
  p_org uuid, p_unidade uuid, p_usuario uuid, p_mes date, p_versao int, p_fingerprint text, p_snapshot jsonb,
  p_pendencias_conciliacao_ids text[], p_reconheco_pendencias boolean
) returns jsonb language plpgsql as $$
declare v fin_periodos; n_pend int; ex fin_excecoes_fechamento; v_exc uuid; descobertas int;
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
  -- (validação inline: esta função roda como service_role, que NÃO tem EXECUTE no validador puro)
  if exists (select 1 from unnest(coalesce(p_pendencias_conciliacao_ids, '{}'::text[])) i where i is null or i !~ '^(ponte_mensal|caixa_dia|sangria_dia):\d{4}-\d{2}-\d{2}$')
     or cardinality(coalesce(p_pendencias_conciliacao_ids, '{}'::text[])) <> (select count(distinct i) from unnest(coalesce(p_pendencias_conciliacao_ids, '{}'::text[])) i) then
    raise exception 'fin_pendencia_conciliacao_invalida: ids invalidos ou repetidos' using errcode = '23514';
  end if;
  n_pend := n_pend + cardinality(coalesce(p_pendencias_conciliacao_ids, '{}'::text[]));
  if n_pend > 0 then
    select * into ex from fin_excecoes_fechamento e
     where e.organizacao_id = p_org and e.unidade_id = p_unidade and e.mes = p_mes and e.status = 'ativa' and e.expira_em > now();
    if not found then raise exception 'fin_periodo_pendencias: % pendencia(s) impedem o fechamento', n_pend using errcode = '23514'; end if;
    if p_reconheco_pendencias is not true then raise exception 'fin_periodo_pendencias_nao_reconhecidas: % pendencia(s)', n_pend using errcode = '23514'; end if;
    -- a exceção cobre SÓ o que foi identificado no ato da concessão, comparado por CONJUNTO (id + motivos nos lançamentos; "escopo:chave" na conciliação), nunca por quantidade:
    -- pendência nova — mesmo que outra tenha sido resolvida e o total seja igual — ou motivo novo numa pendência coberta invalida a cobertura. Resolver pendências coberta é
    -- permitido (o conjunto atual precisa ser SUBCONJUNTO do coberto). RISCO RESIDUAL: os ids de conciliação vêm da aplicação (service_role), que é quem calcula a conciliação.
    select count(*) into descobertas from fin_lancamentos l
     where l.organizacao_id = p_org and l.unidade_id = p_unidade and l.data_movimento >= p_mes and l.data_movimento < (p_mes + interval '1 month')::date
       and l.status <> 'cancelado' and (l.classificacao_pendente or l.categoria_id is null)
       and not exists (select 1 from jsonb_array_elements(ex.pendencias) x
                        where x->>'id' = l.id::text
                          and l.revisao_motivos <@ coalesce((select array_agg(m) from jsonb_array_elements_text(case when jsonb_typeof(x->'motivos') = 'array' then x->'motivos' else '[]'::jsonb end) m), '{}'::text[]));
    if descobertas > 0 or not (coalesce(p_pendencias_conciliacao_ids, '{}'::text[]) <@ ex.pendencias_conciliacao_ids) then
      raise exception 'fin_periodo_excecao_insuficiente: ha pendencia nao coberta pela excecao concedida' using errcode = '23514';
    end if;
    perform set_config('fin.fechando_periodo', v.id::text, true);          -- só vale nesta transação; autoriza o consumo da exceção
    perform fin_consumir_excecao_fechamento(ex.id, p_usuario);
    perform set_config('fin.fechando_periodo', '', true);
    v_exc := ex.id;
  end if;
  update fin_periodos set status = 'fechado', fechado_por = p_usuario, fechado_em = now(),
         snapshot = coalesce(p_snapshot, '{}'::jsonb) || jsonb_build_object('pendenciasNoFechamento', n_pend, 'fingerprint', p_fingerprint, 'excecaoFechamentoId', v_exc)
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
  foreach t in array array['fin_referencias','fin_conciliacao_resolucoes','fin_sangria_excecoes','fin_excecoes_fechamento'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from public', t);
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table %I from %I', t, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on table %I from service_role', t);
      if t = 'fin_excecoes_fechamento' then execute format('grant select on table %I to service_role', t);   -- só leitura: escrita só pelas funções DEFINER
      else execute format('grant select, insert, update on table %I to service_role', t); end if;
    end if;
  end loop;
  -- fin_reabrir_periodo NÃO entra aqui: reabertura desabilitada (sem EXECUTE para ninguém além do dono) até a política ser aprovada.
  foreach t in array array['fin_fingerprint_periodo(uuid,uuid,date)','fin_abrir_periodo(uuid,uuid,uuid,date)',
      'fin_fechar_periodo(uuid,uuid,uuid,date,int,text,jsonb,text[],boolean)',
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
  -- achado da revisão (F-B, endurecimento do Agente 1 incorporado): importacao_id precisa ser de uma importação do MESMO tenant.
  -- FK composta (organizacao_id, unidade_id, importacao_id); MATCH SIMPLE → lançamento manual (importacao_id nulo) não é afetado.
  if not exists (select 1 from pg_constraint where conname = 'fin_importacoes_tenant_uk') then
    alter table fin_importacoes add constraint fin_importacoes_tenant_uk unique (organizacao_id, unidade_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fin_lancamentos_importacao_tenant_fk') then
    alter table fin_lancamentos add constraint fin_lancamentos_importacao_tenant_fk
      foreign key (organizacao_id, unidade_id, importacao_id) references fin_importacoes (organizacao_id, unidade_id, id) on delete restrict not valid;
    alter table fin_lancamentos validate constraint fin_lancamentos_importacao_tenant_fk;
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

-- =====================================================================
-- REABERTURA DESABILITADA NO BANCO (F-A — endurecimento do Agente 1, incorporado à 122; a 122b deixa de existir como arquivo à parte)
-- =====================================================================
-- Limite honesto: a trava usa flag local de transação (como fin.cancelando_par). Defende contra o backend/API; NÃO defende contra quem já tem SQL
-- bruto como service_role. Para HABILITAR no futuro (após aprovação da política): fin_reabrir_periodo passa a executar
--   perform set_config('fin.reabertura_autorizada', v.id::text, true);  antes do UPDATE, e o EXECUTE volta ao service_role.
create or replace function fin_periodos_bloqueia_reabertura() returns trigger language plpgsql as $$
begin
  if old.status = 'fechado' and new.status is distinct from 'fechado'
     and coalesce(current_setting('fin.reabertura_autorizada', true), '') <> old.id::text then
    raise exception 'fin_reabertura_desabilitada: a reabertura de periodo ainda nao foi habilitada' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists trg_fin_periodos_bloqueia_reabertura on fin_periodos;
create trigger trg_fin_periodos_bloqueia_reabertura before update on fin_periodos for each row execute function fin_periodos_bloqueia_reabertura();

-- =====================================================================
-- EXCEÇÃO DE FECHAMENTO COM PENDÊNCIAS (LD-007) — por unidade + competência, SuperAdmin, uso único, desabilitada por padrão
-- =====================================================================
-- Toda escrita na tabela passa por uma das três funções abaixo (flag local `fin.excecao_op`); ninguém altera/apaga linha diretamente.
create or replace function fin_excecoes_fechamento_guarda() returns trigger language plpgsql as $$
declare op text := coalesce(current_setting('fin.excecao_op', true), '');
begin
  if tg_op = 'DELETE' then raise exception 'fin_excecao_imutavel: excecao nao pode ser apagada' using errcode = '23514'; end if;
  if tg_op = 'INSERT' then
    if op <> 'conceder' then raise exception 'fin_excecao_via_funcao: use a concessao autorizada' using errcode = '23514'; end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id
     or new.mes is distinct from old.mes or new.justificativa is distinct from old.justificativa or new.pendencias is distinct from old.pendencias
     or new.pendencias_conciliacao_ids is distinct from old.pendencias_conciliacao_ids or new.pendencias_hash is distinct from old.pendencias_hash or new.quantidade is distinct from old.quantidade
     or new.aprovada_por is distinct from old.aprovada_por or new.mfa_evidencia is distinct from old.mfa_evidencia or new.aprovada_em is distinct from old.aprovada_em or new.expira_em is distinct from old.expira_em then
    raise exception 'fin_excecao_imutavel: conteudo da excecao nao pode ser alterado (nem pendencias apagadas ou reclassificadas)' using errcode = '23514';
  end if;
  if old.status <> 'ativa' then raise exception 'fin_excecao_imutavel: excecao ja encerrada' using errcode = '23514'; end if;
  if new.status = 'consumida' and op = 'consumir' then return new; end if;
  if new.status = 'revogada' and op = 'revogar' then return new; end if;
  raise exception 'fin_excecao_via_funcao: transicao nao autorizada' using errcode = '23514';
end $$;
drop trigger if exists trg_fin_excecoes_fechamento_guarda on fin_excecoes_fechamento;
create trigger trg_fin_excecoes_fechamento_guarda before insert or update or delete on fin_excecoes_fechamento
  for each row execute function fin_excecoes_fechamento_guarda();

-- CONCEDE. Não altera, apaga nem reclassifica nenhuma pendência: só as REGISTRA (ids + motivos) no ato. Sem EXECUTE para o service_role.
create or replace function fin_conceder_excecao_fechamento(
  p_org uuid, p_unidade uuid, p_superadmin uuid, p_mes date, p_justificativa text, p_validade_dias int, p_pendencias_conciliacao_ids text[], p_mfa jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_per fin_periodos; v_pend jsonb; v_qtd int; v_conc_ids text[] := coalesce(p_pendencias_conciliacao_ids, '{}'::text[]); v_hash text; v_just text := btrim(coalesce(p_justificativa, '')); r fin_excecoes_fechamento;
begin
  if p_mes <> date_trunc('month', p_mes)::date then raise exception 'fin_periodo_mes_invalido' using errcode = '23514'; end if;
  if p_superadmin is null then raise exception 'fin_excecao_responsavel_obrigatorio' using errcode = '23514'; end if;
  if length(v_just) < 20 then raise exception 'fin_excecao_justificativa_obrigatoria: minimo 20 caracteres' using errcode = '23514'; end if;
  if p_validade_dias is null or p_validade_dias < 1 or p_validade_dias > 30 then raise exception 'fin_excecao_validade_invalida: 1 a 30 dias' using errcode = '23514'; end if;
  if not fin_ids_conciliacao_validos(v_conc_ids) then raise exception 'fin_excecao_pendencias_invalidas: ids de conciliacao invalidos ou repetidos' using errcode = '23514'; end if;
  -- MFA RECENTE: a plataforma entrega a evidência (AAL2 + instante efetivo do 2º fator); aqui se exige formato válido e <= 10 min (60 s de tolerância no futuro). A prova do MFA é do Agente 1.
  if p_mfa is null or not fin_mfa_evidencia_valida(p_mfa) then raise exception 'fin_excecao_mfa_invalida: evidencia ausente ou fora do formato permitido' using errcode = '23514'; end if;
  if (p_mfa->>'em')::timestamptz < now() - interval '10 minutes' or (p_mfa->>'em')::timestamptz > now() + interval '1 minute' then
    raise exception 'fin_excecao_mfa_invalida: exige verificacao MFA (AAL2) recente (ate 10 minutos)' using errcode = '23514';
  end if;
  insert into fin_periodos (organizacao_id, unidade_id, mes, status) values (p_org, p_unidade, p_mes, 'aberto') on conflict (unidade_id, mes) do nothing;
  select * into v_per from fin_periodos where unidade_id = p_unidade and mes = p_mes and organizacao_id = p_org for update;
  if not found then raise exception 'fin_periodo_nao_encontrado' using errcode = 'P0002'; end if;
  if v_per.status = 'fechado' then raise exception 'fin_periodo_ja_fechado' using errcode = '23514'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'motivos', to_jsonb(l.revisao_motivos)) order by l.id), '[]'::jsonb), count(*)::int into v_pend, v_qtd
    from fin_lancamentos l
   where l.organizacao_id = p_org and l.unidade_id = p_unidade and l.data_movimento >= p_mes and l.data_movimento < (p_mes + interval '1 month')::date
     and l.status <> 'cancelado' and (l.classificacao_pendente or l.categoria_id is null);
  v_hash := encode(sha256(convert_to(coalesce((select string_agg(x->>'id', '|' order by x->>'id') from jsonb_array_elements(v_pend) x), '') || '#' ||
                          coalesce((select string_agg(i, '|' order by i) from unnest(v_conc_ids) i), ''), 'UTF8')), 'hex');
  if v_qtd = 0 and cardinality(v_conc_ids) = 0 then raise exception 'fin_excecao_sem_pendencias: nao ha pendencia a excepcionar' using errcode = '23514'; end if;
  -- exceção anterior vencida e não usada deixa de ocupar a vaga (registro preservado como revogada)
  perform set_config('fin.excecao_op', 'revogar', true);
  update fin_excecoes_fechamento set status = 'revogada', revogada_por = p_superadmin, revogada_em = now(), motivo_revogacao = 'Excecao vencida sem uso, substituida por nova concessao'
   where unidade_id = p_unidade and mes = p_mes and status = 'ativa' and expira_em <= now();
  perform set_config('fin.excecao_op', 'conceder', true);
  insert into fin_excecoes_fechamento (organizacao_id, unidade_id, mes, justificativa, pendencias, pendencias_conciliacao_ids, pendencias_hash, quantidade, aprovada_por, mfa_evidencia, expira_em)
  values (p_org, p_unidade, p_mes, v_just, v_pend, v_conc_ids, v_hash, v_qtd, p_superadmin, p_mfa, now() + make_interval(days => p_validade_dias)) returning * into r;
  perform set_config('fin.excecao_op', '', true);
  return to_jsonb(r);
end $$;

create or replace function fin_revogar_excecao_fechamento(p_org uuid, p_unidade uuid, p_superadmin uuid, p_excecao uuid, p_motivo text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare r fin_excecoes_fechamento; v_motivo text := btrim(coalesce(p_motivo, ''));
begin
  if length(v_motivo) < 10 then raise exception 'fin_excecao_motivo_obrigatorio: minimo 10 caracteres' using errcode = '23514'; end if;
  select * into r from fin_excecoes_fechamento where id = p_excecao and organizacao_id = p_org and unidade_id = p_unidade for update;
  if not found then return false; end if;
  if r.status <> 'ativa' then raise exception 'fin_excecao_imutavel: excecao ja encerrada' using errcode = '23514'; end if;
  perform set_config('fin.excecao_op', 'revogar', true);
  update fin_excecoes_fechamento set status = 'revogada', revogada_por = p_superadmin, revogada_em = now(), motivo_revogacao = v_motivo where id = r.id;
  perform set_config('fin.excecao_op', '', true);
  return true;
end $$;

-- CONSOME (uso único). Só dentro de fin_fechar_periodo do MESMO período (flag local com o id do período); exceção deve estar ativa e vigente.
create or replace function fin_consumir_excecao_fechamento(p_excecao uuid, p_usuario uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r fin_excecoes_fechamento; v_per uuid;
begin
  select * into r from fin_excecoes_fechamento where id = p_excecao for update;
  if not found or r.status <> 'ativa' or r.expira_em <= now() then raise exception 'fin_periodo_excecao_insuficiente: excecao inexistente, vencida ou ja usada' using errcode = '23514'; end if;
  select id into v_per from fin_periodos where organizacao_id = r.organizacao_id and unidade_id = r.unidade_id and mes = r.mes;
  if coalesce(current_setting('fin.fechando_periodo', true), '') <> v_per::text then raise exception 'fin_excecao_via_funcao: consumo so no fechamento do proprio periodo' using errcode = '23514'; end if;
  perform set_config('fin.excecao_op', 'consumir', true);
  update fin_excecoes_fechamento set status = 'consumida', consumida_por = p_usuario, consumida_em = now() where id = r.id;
  perform set_config('fin.excecao_op', '', true);
end $$;

-- Privilégios: conceder/revogar NÃO são executáveis pelo service_role (bloqueadas até a validação do MFA e a ligação do SuperAdmin pelo Agente 1);
-- consumir é chamada só por fin_fechar_periodo; reabrir também sem EXECUTE (reabertura desabilitada).
do $$
declare f text; r text;
begin
  foreach f in array array['fin_conceder_excecao_fechamento(uuid,uuid,uuid,date,text,int,text[],jsonb)','fin_revogar_excecao_fechamento(uuid,uuid,uuid,uuid,text)',
                           'fin_consumir_excecao_fechamento(uuid,uuid)','fin_excecoes_fechamento_guarda()','fin_mfa_evidencia_valida(jsonb)','fin_ids_conciliacao_validos(text[])','fin_periodos_bloqueia_reabertura()',
                           'fin_reabrir_periodo(uuid,uuid,uuid,date,int,text)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  -- fin_fechar_periodo roda como service_role (invoker) e precisa consumir a exceção: único EXECUTE concedido, protegido pela flag do período
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function fin_consumir_excecao_fechamento(uuid,uuid) to service_role;
  end if;
end $$;

-- PÓS-CONDIÇÃO
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    if has_function_privilege('service_role', 'fin_reabrir_periodo(uuid,uuid,uuid,date,int,text)', 'execute') then raise exception '122 abortada: service_role ainda executa fin_reabrir_periodo.'; end if;
    if has_function_privilege('service_role', 'fin_conceder_excecao_fechamento(uuid,uuid,uuid,date,text,int,text[],jsonb)', 'execute') then raise exception '122 abortada: service_role executa conceder excecao.'; end if;
    if has_function_privilege('service_role', 'fin_revogar_excecao_fechamento(uuid,uuid,uuid,uuid,text)', 'execute') then raise exception '122 abortada: service_role executa revogar excecao.'; end if;
    if not exists (select 1 from pg_trigger where tgname = 'trg_fin_periodos_bloqueia_reabertura' and tgrelid = 'fin_periodos'::regclass and tgenabled = 'O') then raise exception '122 abortada: gatilho de reabertura desabilitada ausente.'; end if;
    if has_function_privilege('service_role', 'fin_mfa_evidencia_valida(jsonb)', 'execute') or has_function_privilege('anon', 'fin_mfa_evidencia_valida(jsonb)', 'execute') or has_function_privilege('authenticated', 'fin_mfa_evidencia_valida(jsonb)', 'execute')
       or has_function_privilege('service_role', 'fin_ids_conciliacao_validos(text[])', 'execute') then raise exception '122 abortada: validadores puros expostos como RPC.'; end if;
    if has_table_privilege('service_role', 'fin_excecoes_fechamento', 'insert') or has_table_privilege('service_role', 'fin_excecoes_fechamento', 'update') then raise exception '122 abortada: service_role escreve em fin_excecoes_fechamento.'; end if;
  end if;
end $$;
