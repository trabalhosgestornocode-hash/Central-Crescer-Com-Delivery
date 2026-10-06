-- =====================================================================
-- MIGRATION 108 — Dashboard iFood: múltiplos canais por unidade
-- =====================================================================
-- OBJETIVO
--   Permitir que uma unidade tenha mais de um canal/loja no iFood (ex.:
--   Sanduíches + Saladas) lançados SEPARADAMENTE no lançamento manual e
--   consolidados numa única unidade. Genérico e configurável por unidade
--   pelo SuperAdmin — nenhuma regra por marca, nenhuma coluna específica
--   de canal ("saladas_*").
--
-- DECISÃO CENTRAL DE ARQUITETURA
--   `lancamentos_financeiros_diarios` CONTINUA sendo o CONSOLIDADO DA
--   UNIDADE (1 linha por unidade + dia, acumulados do mês). Todo consumidor
--   atual — Visão Geral, snapshot, período misto, reconciliação, metas,
--   diagnóstico, Agente, Painel Administrativo, bonificação — segue lendo
--   essa linha sem nenhuma mudança. O detalhe por canal vive numa tabela
--   FILHA; o backend calcula o consolidado a partir dos canais e grava as
--   duas coisas na mesma transação (função `dashboard_ifood_salvar_
--   lancamento_multicanal`, abaixo).
--
--   A taxa de entregadores COMPARTILHADA pela unidade é exatamente a
--   coluna `taxas_entregadores` da linha consolidada — nunca é repetida nos
--   canais (nada a somar duas vezes).
--
-- OBJETOS
--   1. dashboard_ifood_unidade_config — estrutura do lançamento por unidade.
--      AUSÊNCIA DE LINHA = 'padrao' (comportamento de hoje, byte a byte).
--   2. dashboard_ifood_canais — canais configurados da unidade.
--   3. lancamentos_financeiros_diarios.estrutura_lancamento — COMO aquele
--      dia foi lançado ('padrao' | 'multicanal'). Imutável depois de criado.
--   4. lancamentos_financeiros_canais — valores de cada canal num dia.
--   5. Triggers de integridade (imutabilidade / coerência).
--   6. Função atômica de gravação do LANÇAMENTO (consolidado + canais).
--   7. Versão + função atômica da CONFIGURAÇÃO da unidade (SuperAdmin):
--      estrutura, escopo de entregadores e canais numa única transação,
--      com concorrência otimista.
--   8. RLS (leitura por tenant, padrão do projeto).
--   9. Grants: anon sem acesso; authenticated só SELECT; escrita só service_role.
--
-- REQUISITOS FORMAIS GARANTIDOS NO BANCO
--   * Canal com histórico NUNCA é excluído fisicamente: a FK da tabela de
--     valores para o canal é NO ACTION (o DELETE do canal falha enquanto
--     houver qualquer valor lançado para ele). Só desativar (`ativo=false`).
--   * Mudar a unidade de 'multicanal' para 'padrao' só mexe em
--     `dashboard_ifood_unidade_config` — nada nesta migration reage a essa
--     troca: os valores por canal já gravados ficam intocados.
--   * `estrutura_lancamento` de um dia é IMUTÁVEL (trigger) — um lançamento
--     antigo sempre reabre na estrutura com que foi criado.
--   * Valores por canal só existem para um dia 'multicanal' (trigger) e só
--     para canais DA MESMA unidade do lançamento (FKs compostas).
--
-- COMPATIBILIDADE COM O HISTÓRICO
--   Todo lançamento existente recebe `estrutura_lancamento = 'padrao'` pelo
--   DEFAULT. Nenhum valor existente muda, nenhum backfill, nenhuma linha
--   filha é criada. Nenhuma unidade é configurada por esta migration
--   (nenhum INSERT de configuração ou canal — nem para unidades Subway).
--
-- TRANSFERÊNCIA DE UNIDADE ENTRE EMPRESAS (migrations 053/054)
--   `remapear_organizacao_em_tabelas_de_unidade` atualiza `organizacao_id`
--   em TODA tabela pública com `organizacao_id` + `unidade_id` — as três
--   tabelas novas entram nessa lista automaticamente. Por isso as FKs
--   compostas usam só (id, unidade_id), NUNCA organizacao_id: o remapeamento
--   roda tabela a tabela e uma FK com organizacao_id falharia no meio dele.
--
-- NÃO DESTRUTIVO / IDEMPOTENTE. Rollback: 108_rollback.sql.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
--   NÃO executar automaticamente em produção.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. CONFIGURAÇÃO POR UNIDADE
-- ---------------------------------------------------------------------
create table if not exists dashboard_ifood_unidade_config (
  unidade_id                 uuid primary key references unidades(id) on delete cascade,
  organizacao_id             uuid not null references organizacoes(id) on delete cascade,
  estrutura                  text not null default 'padrao'
                               check (estrutura in ('padrao', 'multicanal')),
  -- 'unidade' = informada uma vez só no lançamento (custo compartilhado);
  -- 'canal'   = informada em cada canal e somada.
  taxas_entregadores_escopo  text not null default 'unidade'
                               check (taxas_entregadores_escopo in ('unidade', 'canal')),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  atualizado_por             uuid,   -- auth.users.id; sem FK (sobrevive à exclusão da conta)
  atualizado_por_nome        text,
  atualizado_por_email       text
);

create index if not exists idx_difuc_org on dashboard_ifood_unidade_config(organizacao_id);

drop trigger if exists trg_difuc_upd on dashboard_ifood_unidade_config;
create trigger trg_difuc_upd before update on dashboard_ifood_unidade_config
  for each row execute function set_updated_at();

comment on table dashboard_ifood_unidade_config is
  'Estrutura do lançamento manual do Dashboard iFood por unidade. Ausência de linha = padrao (comportamento original). Alterada só pelo SuperAdmin.';
comment on column dashboard_ifood_unidade_config.estrutura is
  'padrao = um único conjunto de valores por dia; multicanal = valores por canal (dashboard_ifood_canais) consolidados na unidade.';
comment on column dashboard_ifood_unidade_config.taxas_entregadores_escopo is
  'unidade = taxa de entregadores informada uma vez (custo compartilhado, gravada só na linha consolidada); canal = informada por canal e somada.';

-- ---------------------------------------------------------------------
-- 2. CANAIS DA UNIDADE
-- ---------------------------------------------------------------------
create table if not exists dashboard_ifood_canais (
  id              uuid primary key default gen_random_uuid(),
  organizacao_id  uuid not null references organizacoes(id) on delete cascade,
  unidade_id      uuid not null references unidades(id) on delete cascade,
  nome            text not null check (length(btrim(nome)) between 1 and 60),
  ordem           int  not null default 0 check (ordem >= 0),
  ativo           boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  criado_por      uuid,
  criado_por_nome text,
  -- Alvo da FK composta de lancamentos_financeiros_canais: garante no banco
  -- que um valor de canal nunca aponta para um canal de OUTRA unidade.
  constraint dashboard_ifood_canais_id_unidade_key unique (id, unidade_id)
);

-- Nome único por unidade (sem diferenciar maiúsculas/espaços nas pontas),
-- inclusive entre inativos — evita dois "Saladas" no histórico.
create unique index if not exists dashboard_ifood_canais_nome_unico
  on dashboard_ifood_canais (unidade_id, lower(btrim(nome)));
create index if not exists idx_difc_unidade_ordem on dashboard_ifood_canais(unidade_id, ordem);
create index if not exists idx_difc_org on dashboard_ifood_canais(organizacao_id);

drop trigger if exists trg_difc_upd on dashboard_ifood_canais;
create trigger trg_difc_upd before update on dashboard_ifood_canais
  for each row execute function set_updated_at();

comment on table dashboard_ifood_canais is
  'Canais/lojas iFood de uma unidade no lançamento multicanal. Canal com histórico nunca é apagado — só desativado (ativo=false).';

-- ---------------------------------------------------------------------
-- 3. ESTRUTURA DE CADA LANÇAMENTO (histórico = 'padrao' pelo default)
-- ---------------------------------------------------------------------
alter table lancamentos_financeiros_diarios
  add column if not exists estrutura_lancamento text not null default 'padrao';

alter table lancamentos_financeiros_diarios drop constraint if exists lfd_estrutura_lancamento_check;
alter table lancamentos_financeiros_diarios add constraint lfd_estrutura_lancamento_check
  check (estrutura_lancamento in ('padrao', 'multicanal'));

-- Alvo da FK composta dos valores por canal (id já é PK; isto só cria o
-- índice único (id, unidade_id) — não muda nenhuma linha). Criada só se
-- ainda não existir: depois da 1ª execução a FK de
-- lancamentos_financeiros_canais depende dela, então "drop + add" quebraria
-- a reexecução (idempotência).
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'lfd_id_unidade_key' and conrelid = 'lancamentos_financeiros_diarios'::regclass
  ) then
    alter table lancamentos_financeiros_diarios add constraint lfd_id_unidade_key unique (id, unidade_id);
  end if;
end $$;

comment on column lancamentos_financeiros_diarios.estrutura_lancamento is
  'Como este dia foi lançado. Imutável (trigger trg_lfd_estrutura_imutavel). Os valores desta linha são SEMPRE o consolidado da unidade; em multicanal o detalhe está em lancamentos_financeiros_canais.';

-- Escopo da taxa de entregadores COM QUE O DIA FOI LANÇADO (Checkpoint D).
-- Pelo mesmo motivo de `estrutura_lancamento`: se o SuperAdmin trocar o
-- escopo da unidade depois, editar um dia antigo ou montar a composição dele
-- não pode reinterpretá-lo pela configuração atual. NULL em todo dia padrão
-- (inclusive o histórico); obrigatório num dia multicanal; imutável.
alter table lancamentos_financeiros_diarios
  add column if not exists escopo_entregadores_lancamento text;
alter table lancamentos_financeiros_diarios drop constraint if exists lfd_escopo_entregadores_lancamento_check;
alter table lancamentos_financeiros_diarios add constraint lfd_escopo_entregadores_lancamento_check
  check (
    (estrutura_lancamento = 'padrao' and escopo_entregadores_lancamento is null)
    or (estrutura_lancamento = 'multicanal' and escopo_entregadores_lancamento in ('unidade', 'canal'))
  );
comment on column lancamentos_financeiros_diarios.escopo_entregadores_lancamento is
  'Só em dia multicanal: unidade = taxa de entregadores compartilhada (só nesta linha); canal = informada por canal e somada. Imutável.';

-- ---------------------------------------------------------------------
-- 4. VALORES DE CADA CANAL NUM DIA
--    Mesmos nomes de coluna da linha consolidada — as funções de cálculo
--    existentes (calc.js) rodam por canal sem adaptação. Todos ACUMULADOS
--    do mês até a data; NULL = não informado (nunca 0).
-- ---------------------------------------------------------------------
create table if not exists lancamentos_financeiros_canais (
  id                  uuid primary key default gen_random_uuid(),
  organizacao_id      uuid not null references organizacoes(id) on delete cascade,
  unidade_id          uuid not null,
  lancamento_id       uuid not null,
  canal_id            uuid not null,
  situacao_canal      text not null check (situacao_canal in ('com_vendas', 'sem_vendas', 'nao_informado')),

  qtd_vendas          int           check (qtd_vendas is null or qtd_vendas >= 0),
  valor_vendas_bruto  numeric(14,2) check (valor_vendas_bruto is null or valor_vendas_bruto >= 0),
  novos_clientes      int           check (novos_clientes is null or novos_clientes >= 0),

  valor_vendas_ifood  numeric(14,2) check (valor_vendas_ifood is null or valor_vendas_ifood >= 0),
  taxas_comissoes     numeric(14,2) check (taxas_comissoes is null or taxas_comissoes >= 0),
  servicos_promocoes  numeric(14,2) check (servicos_promocoes is null or servicos_promocoes >= 0),
  -- Só preenchida quando o escopo da unidade é 'canal'. No escopo 'unidade'
  -- fica NULL aqui e o valor vive só na linha consolidada.
  taxas_entregadores  numeric(14,2) check (taxas_entregadores is null or taxas_entregadores >= 0),
  ajustes_favor_loja  numeric(14,2) check (ajustes_favor_loja is null or ajustes_favor_loja >= 0),
  ajustes_contra_loja numeric(14,2) check (ajustes_contra_loja is null or ajustes_contra_loja >= 0),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- "Não informado" não carrega número nenhum — distinção explícita de R$ 0,00.
  constraint lfc_nao_informado_sem_valores check (
    situacao_canal <> 'nao_informado' or (
      qtd_vendas is null and valor_vendas_bruto is null and novos_clientes is null
      and valor_vendas_ifood is null and taxas_comissoes is null and servicos_promocoes is null
      and taxas_entregadores is null and ajustes_favor_loja is null and ajustes_contra_loja is null
    )
  ),
  -- Mesma unidade do lançamento consolidado; apagar o dia apaga os canais dele.
  constraint lfc_lancamento_fk foreign key (lancamento_id, unidade_id)
    references lancamentos_financeiros_diarios(id, unidade_id) on delete cascade,
  -- Mesma unidade do canal. NO ACTION (não RESTRICT): bloqueia apagar um
  -- canal com histórico, mas permite a cascata de exclusão da unidade
  -- inteira (checada no fim do comando, quando os valores já saíram).
  constraint lfc_canal_fk foreign key (canal_id, unidade_id)
    references dashboard_ifood_canais(id, unidade_id) on delete no action,
  constraint lfc_lancamento_canal_unico unique (lancamento_id, canal_id)
);

create index if not exists idx_lfc_unidade on lancamentos_financeiros_canais(unidade_id);
create index if not exists idx_lfc_canal on lancamentos_financeiros_canais(canal_id);
create index if not exists idx_lfc_org on lancamentos_financeiros_canais(organizacao_id);

drop trigger if exists trg_lfc_upd on lancamentos_financeiros_canais;
create trigger trg_lfc_upd before update on lancamentos_financeiros_canais
  for each row execute function set_updated_at();

comment on table lancamentos_financeiros_canais is
  'Valores ACUMULADOS do mês de cada canal num dia multicanal. A soma (mais a taxa de entregadores compartilhada) é a linha consolidada em lancamentos_financeiros_diarios, calculada pelo backend.';

-- ---------------------------------------------------------------------
-- 5. TRIGGERS DE INTEGRIDADE
-- ---------------------------------------------------------------------

-- 5.1 estrutura_lancamento e escopo_entregadores_lancamento são imutáveis:
--     um dia sempre reabre exatamente como foi criado.
create or replace function lfd_estrutura_imutavel() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.estrutura_lancamento is distinct from old.estrutura_lancamento then
    raise exception 'ESTRUTURA_LANCAMENTO_IMUTAVEL: o lançamento % foi criado como % e não pode virar %.',
      old.id, old.estrutura_lancamento, new.estrutura_lancamento;
  end if;
  if new.escopo_entregadores_lancamento is distinct from old.escopo_entregadores_lancamento then
    raise exception 'ESCOPO_ENTREGADORES_IMUTAVEL: o lançamento % foi criado com escopo % e não pode virar %.',
      old.id, old.escopo_entregadores_lancamento, new.escopo_entregadores_lancamento;
  end if;
  return new;
end $$;

drop trigger if exists trg_lfd_estrutura_imutavel on lancamentos_financeiros_diarios;
create trigger trg_lfd_estrutura_imutavel before update of estrutura_lancamento, escopo_entregadores_lancamento on lancamentos_financeiros_diarios
  for each row execute function lfd_estrutura_imutavel();

-- 5.2 Valor por canal só num dia multicanal; canal/lançamento de uma linha
--     filha nunca são trocados depois (corrigir = editar os valores).
create or replace function lfc_coerencia() returns trigger
language plpgsql set search_path = public as $$
declare
  v_estrutura text;
begin
  if tg_op = 'UPDATE' and (new.lancamento_id <> old.lancamento_id or new.canal_id <> old.canal_id or new.unidade_id <> old.unidade_id) then
    raise exception 'CANAL_LANCAMENTO_IMUTAVEL: lançamento/canal/unidade de um valor por canal não podem ser alterados.';
  end if;
  select estrutura_lancamento into v_estrutura from lancamentos_financeiros_diarios where id = new.lancamento_id;
  if v_estrutura is distinct from 'multicanal' then
    raise exception 'LANCAMENTO_NAO_MULTICANAL: o lançamento % não é multicanal.', new.lancamento_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_lfc_coerencia on lancamentos_financeiros_canais;
create trigger trg_lfc_coerencia before insert or update on lancamentos_financeiros_canais
  for each row execute function lfc_coerencia();

-- 5.3 Um canal nunca muda de unidade (o histórico dele é daquela unidade).
create or replace function difc_unidade_imutavel() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.unidade_id <> old.unidade_id then
    raise exception 'CANAL_UNIDADE_IMUTAVEL: um canal não pode ser movido para outra unidade.';
  end if;
  return new;
end $$;

drop trigger if exists trg_difc_unidade_imutavel on dashboard_ifood_canais;
create trigger trg_difc_unidade_imutavel before update of unidade_id on dashboard_ifood_canais
  for each row execute function difc_unidade_imutavel();

-- ---------------------------------------------------------------------
-- 6. GRAVAÇÃO ATÔMICA: consolidado + canais na MESMA transação
--    Quem calcula e valida é o backend (dashboardExecutivo.canais.js +
--    normalizarDadosLancamento); esta função só garante que as duas
--    escritas nunca fiquem pela metade e reaplica as travas de tenant.
--
--    p_lancamento_id NULL  -> cria o dia (estrutura 'multicanal'); exige
--                             `escopo_entregadores_lancamento` em p_lancamento.
--    p_lancamento_id       -> edita o dia; exige que ele já seja multicanal,
--                             da mesma empresa/unidade, e p_versao igual ao
--                             updated_at atual (concorrência otimista — a
--                             versão protege o dia INTEIRO, consolidado e
--                             canais, porque toda gravação passa por aqui e
--                             sempre atualiza a linha consolidada).
--    p_lancamento          -> colunas snake_case da linha consolidada.
--                             status/finalizado_em/usuario_* só são tocados
--                             numa edição quando a chave vier no JSON.
--    p_canais              -> array de objetos snake_case (canal_id,
--                             situacao_canal e os valores). Numa edição,
--                             TODO canal já gravado no dia precisa vir de
--                             novo (nenhum canal some de um dia já lançado).
-- ---------------------------------------------------------------------
create or replace function dashboard_ifood_salvar_lancamento_multicanal(
  p_organizacao_id uuid,
  p_unidade_id     uuid,
  p_lancamento_id  uuid,
  p_versao         timestamptz,
  p_lancamento     jsonb,
  p_canais         jsonb
) returns lancamentos_financeiros_diarios
language plpgsql set search_path = public as $$
declare
  r        lancamentos_financeiros_diarios;
  v_linha  lancamentos_financeiros_diarios;
  v_canal  jsonb;
  c        lancamentos_financeiros_canais;
begin
  if p_canais is null or jsonb_typeof(p_canais) <> 'array' or jsonb_array_length(p_canais) = 0 then
    raise exception 'CANAIS_OBRIGATORIOS: informe os valores dos canais.';
  end if;

  r := jsonb_populate_record(null::lancamentos_financeiros_diarios, p_lancamento);

  if p_lancamento_id is null then
    if r.escopo_entregadores_lancamento is null or r.escopo_entregadores_lancamento not in ('unidade', 'canal') then
      raise exception 'ESCOPO_OBRIGATORIO: informe o escopo da taxa de entregadores do dia.';
    end if;
    insert into lancamentos_financeiros_diarios (
      organizacao_id, unidade_id, data_lancamento, estrutura_lancamento, escopo_entregadores_lancamento,
      situacao, motivo_sem_operacao, observacao,
      qtd_vendas, valor_vendas_bruto, novos_clientes,
      valor_vendas_ifood, taxas_comissoes, servicos_promocoes, taxas_entregadores,
      ajustes_favor_loja, ajustes_contra_loja, justificativa_ajuste,
      status, usuario_id, usuario_nome, usuario_email, finalizado_em
    ) values (
      p_organizacao_id, p_unidade_id, r.data_lancamento, 'multicanal', r.escopo_entregadores_lancamento,
      r.situacao, r.motivo_sem_operacao, r.observacao,
      r.qtd_vendas, r.valor_vendas_bruto, r.novos_clientes,
      r.valor_vendas_ifood, r.taxas_comissoes, r.servicos_promocoes, r.taxas_entregadores,
      r.ajustes_favor_loja, r.ajustes_contra_loja, r.justificativa_ajuste,
      coalesce(r.status, 'rascunho'), r.usuario_id, r.usuario_nome, r.usuario_email, r.finalizado_em
    ) returning * into v_linha;
  else
    select * into v_linha from lancamentos_financeiros_diarios
      where id = p_lancamento_id and organizacao_id = p_organizacao_id and unidade_id = p_unidade_id
      for update;
    if not found then
      raise exception 'LANCAMENTO_NAO_ENCONTRADO';
    end if;
    if v_linha.estrutura_lancamento <> 'multicanal' then
      raise exception 'LANCAMENTO_NAO_MULTICANAL: o lançamento % foi criado como %.', p_lancamento_id, v_linha.estrutura_lancamento;
    end if;
    if p_versao is null or v_linha.updated_at <> p_versao then
      raise exception 'LANCAMENTO_DESATUALIZADO';
    end if;
    -- Nenhum canal já gravado neste dia pode sumir dele.
    if exists (
      select 1 from lancamentos_financeiros_canais f
      where f.lancamento_id = p_lancamento_id
        and not exists (select 1 from jsonb_array_elements(p_canais) e where (e->>'canal_id')::uuid = f.canal_id)
    ) then
      raise exception 'CANAL_AUSENTE: todo canal já lançado neste dia precisa continuar presente.';
    end if;

    update lancamentos_financeiros_diarios set
      situacao            = r.situacao,
      motivo_sem_operacao = r.motivo_sem_operacao,
      observacao          = r.observacao,
      qtd_vendas          = r.qtd_vendas,
      valor_vendas_bruto  = r.valor_vendas_bruto,
      novos_clientes      = r.novos_clientes,
      valor_vendas_ifood  = r.valor_vendas_ifood,
      taxas_comissoes     = r.taxas_comissoes,
      servicos_promocoes  = r.servicos_promocoes,
      taxas_entregadores  = r.taxas_entregadores,
      ajustes_favor_loja  = r.ajustes_favor_loja,
      ajustes_contra_loja = r.ajustes_contra_loja,
      justificativa_ajuste = r.justificativa_ajuste,
      status        = case when p_lancamento ? 'status'        then r.status        else status end,
      finalizado_em = case when p_lancamento ? 'finalizado_em' then r.finalizado_em else finalizado_em end,
      usuario_id    = case when p_lancamento ? 'usuario_id'    then r.usuario_id    else usuario_id end,
      usuario_nome  = case when p_lancamento ? 'usuario_nome'  then r.usuario_nome  else usuario_nome end,
      usuario_email = case when p_lancamento ? 'usuario_email' then r.usuario_email else usuario_email end
    where id = p_lancamento_id
    returning * into v_linha;
  end if;

  for v_canal in select * from jsonb_array_elements(p_canais) loop
    c := jsonb_populate_record(null::lancamentos_financeiros_canais, v_canal);
    insert into lancamentos_financeiros_canais (
      organizacao_id, unidade_id, lancamento_id, canal_id, situacao_canal,
      qtd_vendas, valor_vendas_bruto, novos_clientes,
      valor_vendas_ifood, taxas_comissoes, servicos_promocoes, taxas_entregadores,
      ajustes_favor_loja, ajustes_contra_loja
    ) values (
      p_organizacao_id, p_unidade_id, v_linha.id, c.canal_id, c.situacao_canal,
      c.qtd_vendas, c.valor_vendas_bruto, c.novos_clientes,
      c.valor_vendas_ifood, c.taxas_comissoes, c.servicos_promocoes, c.taxas_entregadores,
      c.ajustes_favor_loja, c.ajustes_contra_loja
    )
    on conflict (lancamento_id, canal_id) do update set
      situacao_canal      = excluded.situacao_canal,
      qtd_vendas          = excluded.qtd_vendas,
      valor_vendas_bruto  = excluded.valor_vendas_bruto,
      novos_clientes      = excluded.novos_clientes,
      valor_vendas_ifood  = excluded.valor_vendas_ifood,
      taxas_comissoes     = excluded.taxas_comissoes,
      servicos_promocoes  = excluded.servicos_promocoes,
      taxas_entregadores  = excluded.taxas_entregadores,
      ajustes_favor_loja  = excluded.ajustes_favor_loja,
      ajustes_contra_loja = excluded.ajustes_contra_loja;
  end loop;

  return v_linha;
end $$;

revoke all on function dashboard_ifood_salvar_lancamento_multicanal(uuid, uuid, uuid, timestamptz, jsonb, jsonb) from public, anon, authenticated;
grant execute on function dashboard_ifood_salvar_lancamento_multicanal(uuid, uuid, uuid, timestamptz, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------
-- 7. CONFIGURAÇÃO DA UNIDADE (SuperAdmin) — ATÔMICA E COM VERSÃO
--
-- 7.1 Versão do estado de configuração de UMA unidade: hash da linha de
--     configuração + de todos os canais (inclusive inativos), com o
--     updated_at de cada um (o trigger set_updated_at muda a cada UPDATE).
--     Qualquer alteração — inclusive um canal novo — muda a versão. Usa
--     epoch (não updated_at::text) para não depender do fuso da sessão.
--     Mesmo papel do `seVersao`/updated_at do lançamento diário, estendido
--     a um conjunto de linhas (configuração + N canais).
-- ---------------------------------------------------------------------
create or replace function dashboard_ifood_config_versao(p_unidade_id uuid) returns text
language sql stable set search_path = public as $$
  select md5(
    coalesce((
      select c.estrutura || '|' || c.taxas_entregadores_escopo || '|' || extract(epoch from c.updated_at)::text
      from dashboard_ifood_unidade_config c where c.unidade_id = p_unidade_id
    ), '-')
    || '#' ||
    coalesce((
      select string_agg(k.id::text || '|' || k.nome || '|' || k.ordem::text || '|' || k.ativo::text || '|' || extract(epoch from k.updated_at)::text, ';' order by k.id)
      from dashboard_ifood_canais k where k.unidade_id = p_unidade_id
    ), '')
  )
$$;

-- 7.2 Grava a configuração da unidade INTEIRA numa única transação.
--     Ou tudo persiste (canais criados/renomeados/ativados/desativados/
--     reordenados + configuração), ou nada — qualquer `raise` desfaz tudo.
--
--     p_versao      -> versão lida pelo cliente (dashboard_ifood_config_versao).
--                      Diferente da atual = CONFIG_DESATUALIZADA (HTTP 409):
--                      quem salva com uma tela antiga nunca sobrescreve em
--                      silêncio o que outro SuperAdmin já gravou.
--     p_estrutura   -> 'padrao' | 'multicanal'.
--     p_escopo      -> 'unidade' | 'canal' | NULL (mantém o atual).
--     p_canais      -> NULL = canais intocados; senão a lista COMPLETA, na
--                      ordem desejada: [{id?, nome, ativo}] (sem id = novo).
--                      ordem gravada = posição na lista (0..n-1).
--
--     Revalida no banco tudo que o backend já validou (defesa em
--     profundidade): unidade/empresa, canal de outra unidade, omissão de
--     canal existente (exclusão), nome 1..60 e único sem diferenciar
--     maiúsculas, limite de 20 canais, mínimo de 2 ativos em multicanal.
--     A regra do modelo logístico (Full Service não usa escopo de
--     entregadores) depende da linha do tempo de vigências e fica só no
--     backend (dashboardExecutivo.modeloTemporal.js), como já é hoje.
--
--     Troca de nomes entre canais (A↔B) é suportada: os renomeados passam
--     por um nome temporário interno ('~' || id) antes do nome final, tudo
--     na mesma transação — o índice único nunca vê dois nomes iguais e o
--     temporário nunca sobrevive ao fim da função.
--
--     Retorna o que DE FATO mudou (para a auditoria do backend, gravada só
--     depois do commit) e a versão nova.
--
--     Erros (prefixo estável, o backend mapeia para HTTP):
--       UNIDADE_NAO_ENCONTRADA (404) · CONFIG_DESATUALIZADA (409) ·
--       ORGANIZACAO_DIVERGENTE, ESTRUTURA_INVALIDA, ESCOPO_INVALIDO,
--       CANAIS_INVALIDOS, CANAL_DE_OUTRA_UNIDADE, CANAL_DUPLICADO,
--       CANAL_AUSENTE, NOME_CANAL_INVALIDO, NOME_CANAL_DUPLICADO,
--       LIMITE_CANAIS, MULTICANAL_MINIMO_CANAIS (400).
-- ---------------------------------------------------------------------
create or replace function dashboard_ifood_salvar_config_unidade(
  p_unidade_id     uuid,
  p_organizacao_id uuid,
  p_versao         text,
  p_estrutura      text,
  p_escopo         text,
  p_canais         jsonb,
  p_usuario_id     uuid,
  p_usuario_nome   text,
  p_usuario_email  text
) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_org           uuid;
  v_cfg           dashboard_ifood_unidade_config;
  v_estrutura_ant text;
  v_escopo_ant    text;
  v_escopo        text;
  v_item          jsonb;
  v_pos           int := 0;
  v_id            uuid;
  v_nome          text;
  v_ativo         boolean;
  v_canal         dashboard_ifood_canais;
  v_ativos        int;
  v_novo_id       uuid;
  v_ordem_antes   text;
  v_ordem_depois  text;
  v_criados       jsonb := '[]'::jsonb;
  v_renomeados    jsonb := '[]'::jsonb;
  v_ativados      jsonb := '[]'::jsonb;
  v_desativados   jsonb := '[]'::jsonb;
  v_mudou_cfg     boolean;
begin
  select organizacao_id into v_org from unidades where id = p_unidade_id;
  if v_org is null then
    raise exception 'UNIDADE_NAO_ENCONTRADA: unidade %.', p_unidade_id;
  end if;
  if p_organizacao_id is distinct from v_org then
    raise exception 'ORGANIZACAO_DIVERGENTE: a unidade não pertence a esta empresa.';
  end if;

  -- Um salvamento por unidade de cada vez (dois SuperAdmins ao mesmo tempo
  -- serializam aqui; o segundo encontra a versão nova e recebe conflito).
  perform pg_advisory_xact_lock(hashtext('dashboard_ifood_config:' || p_unidade_id::text));

  if p_versao is null or p_versao is distinct from dashboard_ifood_config_versao(p_unidade_id) then
    raise exception 'CONFIG_DESATUALIZADA: a configuração desta unidade foi alterada por outra pessoa.';
  end if;

  if p_estrutura is null or p_estrutura not in ('padrao', 'multicanal') then
    raise exception 'ESTRUTURA_INVALIDA: %.', p_estrutura;
  end if;
  if p_escopo is not null and p_escopo not in ('unidade', 'canal') then
    raise exception 'ESCOPO_INVALIDO: %.', p_escopo;
  end if;

  select * into v_cfg from dashboard_ifood_unidade_config where unidade_id = p_unidade_id;
  v_estrutura_ant := coalesce(v_cfg.estrutura, 'padrao');
  v_escopo_ant    := coalesce(v_cfg.taxas_entregadores_escopo, 'unidade');
  v_escopo        := coalesce(p_escopo, v_escopo_ant);

  select string_agg(id::text, ',' order by ordem, nome, id) into v_ordem_antes
    from dashboard_ifood_canais where unidade_id = p_unidade_id;

  if p_canais is not null then
    if jsonb_typeof(p_canais) <> 'array' then
      raise exception 'CANAIS_INVALIDOS: lista de canais inválida.';
    end if;
    if jsonb_array_length(p_canais) > 20 then
      raise exception 'LIMITE_CANAIS: no máximo 20 canais por unidade.';
    end if;

    -- Lista desejada normalizada (validada ANTES de qualquer escrita).
    create temporary table if not exists pg_temp.difc_desejado (
      pos int, id uuid, nome text, ativo boolean
    ) on commit drop;
    -- `where true`: o PostgREST (papel authenticator) carrega `safeupdate`, que recusa DELETE sem WHERE.
    delete from pg_temp.difc_desejado where true;

    for v_item in select * from jsonb_array_elements(p_canais) loop
      v_id := nullif(v_item->>'id', '')::uuid;
      v_nome := btrim(coalesce(v_item->>'nome', ''));
      v_ativo := coalesce((v_item->>'ativo')::boolean, true);
      if length(v_nome) < 1 or length(v_nome) > 60 then
        raise exception 'NOME_CANAL_INVALIDO: o nome do canal deve ter de 1 a 60 caracteres.';
      end if;
      if v_id is not null then
        if not exists (select 1 from dashboard_ifood_canais where id = v_id and unidade_id = p_unidade_id) then
          raise exception 'CANAL_DE_OUTRA_UNIDADE: canal não pertence a esta unidade.';
        end if;
        if exists (select 1 from pg_temp.difc_desejado where id = v_id) then
          raise exception 'CANAL_DUPLICADO: canal informado mais de uma vez.';
        end if;
      end if;
      insert into pg_temp.difc_desejado values (v_pos, v_id, v_nome, v_ativo);
      v_pos := v_pos + 1;
    end loop;

    if exists (
      select 1 from dashboard_ifood_canais k
      where k.unidade_id = p_unidade_id
        and not exists (select 1 from pg_temp.difc_desejado d where d.id = k.id)
    ) then
      raise exception 'CANAL_AUSENTE: canais não podem ser excluídos — desative em vez de remover.';
    end if;
    if exists (
      select 1 from pg_temp.difc_desejado group by lower(nome) having count(*) > 1
    ) then
      raise exception 'NOME_CANAL_DUPLICADO: já existe um canal com este nome nesta unidade.';
    end if;

    v_ativos := (select count(*) from pg_temp.difc_desejado where ativo);

    -- Diff (antes de escrever) — é exatamente o que vai ser aplicado.
    select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'de', k.nome, 'para', d.nome) order by d.pos), '[]'::jsonb)
      into v_renomeados
      from pg_temp.difc_desejado d join dashboard_ifood_canais k on k.id = d.id
      where k.nome <> d.nome;
    select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'nome', d.nome) order by d.pos), '[]'::jsonb)
      into v_ativados
      from pg_temp.difc_desejado d join dashboard_ifood_canais k on k.id = d.id
      where d.ativo and not k.ativo;
    select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'nome', d.nome) order by d.pos), '[]'::jsonb)
      into v_desativados
      from pg_temp.difc_desejado d join dashboard_ifood_canais k on k.id = d.id
      where not d.ativo and k.ativo;

    -- Renomeação em duas fases (suporta trocar nomes entre canais).
    update dashboard_ifood_canais k set nome = '~' || k.id::text
      from pg_temp.difc_desejado d
      where d.id = k.id and k.nome <> d.nome;
    update dashboard_ifood_canais k set nome = d.nome, ordem = d.pos, ativo = d.ativo
      from pg_temp.difc_desejado d
      where d.id = k.id and (k.nome <> d.nome or k.ordem <> d.pos or k.ativo <> d.ativo);

    -- Canais novos (depois das renomeações: podem reusar um nome liberado).
    for v_item in select to_jsonb(d) from pg_temp.difc_desejado d where d.id is null order by d.pos loop
      insert into dashboard_ifood_canais (organizacao_id, unidade_id, nome, ordem, ativo, criado_por, criado_por_nome)
        values (v_org, p_unidade_id, v_item->>'nome', (v_item->>'pos')::int, (v_item->>'ativo')::boolean, p_usuario_id, coalesce(p_usuario_nome, p_usuario_email))
        returning id into v_novo_id;
      v_criados := v_criados || jsonb_build_object('id', v_novo_id, 'nome', v_item->>'nome', 'ativo', (v_item->>'ativo')::boolean);
    end loop;
  else
    v_ativos := (select count(*) from dashboard_ifood_canais where unidade_id = p_unidade_id and ativo);
  end if;

  if p_estrutura = 'multicanal' and v_ativos < 2 then
    raise exception 'MULTICANAL_MINIMO_CANAIS: múltiplos canais exige pelo menos 2 canais ativos (hoje: %).', v_ativos;
  end if;

  -- Configuração: só grava quando muda algo. Salvar o próprio padrão numa
  -- unidade sem linha NÃO cria linha (ausência = padrão).
  v_mudou_cfg := p_estrutura <> v_estrutura_ant or v_escopo <> v_escopo_ant;
  if v_mudou_cfg then
    insert into dashboard_ifood_unidade_config
      (unidade_id, organizacao_id, estrutura, taxas_entregadores_escopo, atualizado_por, atualizado_por_nome, atualizado_por_email)
    values (p_unidade_id, v_org, p_estrutura, v_escopo, p_usuario_id, p_usuario_nome, p_usuario_email)
    on conflict (unidade_id) do update set
      organizacao_id = excluded.organizacao_id,
      estrutura = excluded.estrutura,
      taxas_entregadores_escopo = excluded.taxas_entregadores_escopo,
      atualizado_por = excluded.atualizado_por,
      atualizado_por_nome = excluded.atualizado_por_nome,
      atualizado_por_email = excluded.atualizado_por_email;
  end if;

  select string_agg(id::text, ',' order by ordem, nome, id) into v_ordem_depois
    from dashboard_ifood_canais where unidade_id = p_unidade_id and id::text = any (string_to_array(coalesce(v_ordem_antes, ''), ','));

  return jsonb_build_object(
    'versao', dashboard_ifood_config_versao(p_unidade_id),
    'estrutura', case when p_estrutura <> v_estrutura_ant then jsonb_build_object('de', v_estrutura_ant, 'para', p_estrutura) end,
    'escopo', case when v_escopo <> v_escopo_ant then jsonb_build_object('de', v_escopo_ant, 'para', v_escopo) end,
    'criados', v_criados,
    'renomeados', v_renomeados,
    'ativados', v_ativados,
    'desativados', v_desativados,
    -- Sequência relativa dos canais que JÁ existiam mudou? (normalizar 5,9 -> 0,1 não conta)
    'ordemAlterada', coalesce(v_ordem_antes, '') <> coalesce(v_ordem_depois, ''),
    'ordem', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'nome', nome) order by ordem, nome, id), '[]'::jsonb)
              from dashboard_ifood_canais where unidade_id = p_unidade_id)
  );
end $$;

revoke all on function dashboard_ifood_config_versao(uuid) from public, anon, authenticated;
grant execute on function dashboard_ifood_config_versao(uuid) to service_role;
revoke all on function dashboard_ifood_salvar_config_unidade(uuid, uuid, text, text, text, jsonb, uuid, text, text) from public, anon, authenticated;
grant execute on function dashboard_ifood_salvar_config_unidade(uuid, uuid, text, text, text, jsonb, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------
-- 8. RLS — padrão do projeto (backend usa service_role; estas policies só
--    valem para eventual acesso autenticado direto: leitura por tenant).
-- ---------------------------------------------------------------------
alter table dashboard_ifood_unidade_config enable row level security;
drop policy if exists rls_difuc_tenant on dashboard_ifood_unidade_config;
create policy rls_difuc_tenant on dashboard_ifood_unidade_config
  for select to authenticated
  using (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin());

alter table dashboard_ifood_canais enable row level security;
drop policy if exists rls_difc_tenant on dashboard_ifood_canais;
create policy rls_difc_tenant on dashboard_ifood_canais
  for select to authenticated
  using (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin());

alter table lancamentos_financeiros_canais enable row level security;
drop policy if exists rls_lfc_tenant on lancamentos_financeiros_canais;
create policy rls_lfc_tenant on lancamentos_financeiros_canais
  for select to authenticated
  using (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin());

-- ---------------------------------------------------------------------
-- 9. GRANTS — os default privileges do Supabase dão GRANT ALL (inclusive
--    TRUNCATE, que NÃO passa por RLS) a anon/authenticated em toda tabela
--    nova de `public`. Aqui: anon sem nada; authenticated só SELECT (o que
--    as policies de leitura acima precisam); escrita só pelo backend
--    (service_role), via RPCs. Idempotente (mesma convenção da 106/107).
-- ---------------------------------------------------------------------
revoke all on dashboard_ifood_unidade_config, dashboard_ifood_canais, lancamentos_financeiros_canais
  from anon, authenticated;
grant select on dashboard_ifood_unidade_config, dashboard_ifood_canais, lancamentos_financeiros_canais
  to authenticated;
grant select, insert, update, delete on dashboard_ifood_unidade_config, dashboard_ifood_canais, lancamentos_financeiros_canais
  to service_role;

-- =====================================================================
-- VERIFICAÇÃO (rode separadamente; nada aqui escreve):
--
--   -- todo o histórico ficou 'padrao' e nenhuma unidade foi configurada:
--   select estrutura_lancamento, count(*) from lancamentos_financeiros_diarios group by 1;
--   -- esperado: só 'padrao'.
--   select count(*) from dashboard_ifood_unidade_config;   -- esperado: 0
--   select count(*) from dashboard_ifood_canais;            -- esperado: 0
--   select count(*) from lancamentos_financeiros_canais;    -- esperado: 0
--
--   -- a função ficou restrita ao service_role:
--   select has_function_privilege('authenticated',
--     'dashboard_ifood_salvar_lancamento_multicanal(uuid,uuid,uuid,timestamptz,jsonb,jsonb)', 'execute');
--   -- esperado: false
-- =====================================================================
-- FIM
-- =====================================================================
