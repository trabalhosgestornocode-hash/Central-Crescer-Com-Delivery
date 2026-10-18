-- =====================================================================
-- 124 — iFood: FINALIDADE e AMBIENTE por conexão (coexistência de Financial de homologação e Order de produção na mesma unidade)
-- =====================================================================
-- Hoje uma unidade tem UMA conexão viva (índice uq_ifood_conexao_unidade_viva, migration 056). Para a mesma unidade ter o Financial de
-- homologação (loja de teste, app de teste) e, ao lado, o Order de produção (loja real, app distribuído) sem que um interfira no outro,
-- cada conexão passa a declarar a sua FINALIDADE e o seu AMBIENTE:
--
--   finalidade `legado`                 -> a conexão única de antes (ex.: Subway Saci). Serve a qualquer app. Padrão de TODAS as linhas existentes.
--   finalidade `financeiro_homologacao` -> só apps financial/analytics; ambiente `homologacao`; NUNCA recebe credencial `order`,
--                                          nunca entra no polling de pedidos.
--   finalidade `pedidos_producao`       -> só o app `order`; ambiente `producao`.
--
-- O QUE ESTA MIGRATION FAZ (100% aditiva — nenhuma linha, índice ou credencial existente é alterado ou removido):
--   1. ifood_conexoes.finalidade (default 'legado') e ifood_conexoes.ambiente (default 'nao_informado'), com CHECKs de coerência;
--   2. índice único parcial uq_ifood_conexao_unidade_finalidade_viva (unidade_id, finalidade) onde status <> 'revogada';
--   3. ifood_oauth_sessoes.finalidade (nullable): a sessão OAuth carrega a finalidade da conexão-alvo;
--   4. triggers: credencial só entra em conexão de finalidade compatível; loja adicional não entra em conexão financeira;
--      a finalidade só muda de/para 'legado' (rotulagem supervisionada e seu rollback), nunca de uma finalidade para outra.
--
-- O QUE ELA NÃO FAZ: não remove uq_ifood_conexao_unidade_viva (isso é a 125, separada, só depois de o código novo estar no ar e homologado);
-- não rotula nenhuma conexão (database/operacoes/ifood-conexao-rotular.sql, supervisionado); não toca em credenciais, merchants nem pedidos.
-- Enquanto a 125 não for aplicada, o índice antigo continua impedindo a 2ª conexão viva — o comportamento em produção é IDÊNTICO ao de antes.
--
-- Idempotente. Rollback: 124_rollback.sql (recusa-se se houver conexão rotulada ou duas conexões vivas na mesma unidade).

begin;
set local lock_timeout = '5s';

alter table ifood_conexoes add column if not exists finalidade text not null default 'legado';
alter table ifood_conexoes add column if not exists ambiente text not null default 'nao_informado';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ck_ifood_conexao_finalidade') then
    alter table ifood_conexoes add constraint ck_ifood_conexao_finalidade
      check (finalidade in ('legado', 'financeiro_homologacao', 'pedidos_producao'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ck_ifood_conexao_ambiente') then
    alter table ifood_conexoes add constraint ck_ifood_conexao_ambiente
      check (ambiente in ('nao_informado', 'homologacao', 'producao'));
  end if;
  -- Coerência: finalidade e ambiente andam juntos. `legado` aceita qualquer ambiente (inclusive 'nao_informado').
  if not exists (select 1 from pg_constraint where conname = 'ck_ifood_conexao_finalidade_ambiente') then
    alter table ifood_conexoes add constraint ck_ifood_conexao_finalidade_ambiente
      check (finalidade = 'legado'
             or (finalidade = 'financeiro_homologacao' and ambiente = 'homologacao')
             or (finalidade = 'pedidos_producao' and ambiente = 'producao'));
  end if;
end $$;

-- Uma conexão viva por (unidade, finalidade). Coexiste com o índice antigo (por unidade) até a 125.
create unique index if not exists uq_ifood_conexao_unidade_finalidade_viva
  on ifood_conexoes(unidade_id, finalidade) where status <> 'revogada';

alter table ifood_oauth_sessoes add column if not exists finalidade text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ck_ifood_oauth_sessao_finalidade') then
    alter table ifood_oauth_sessoes add constraint ck_ifood_oauth_sessao_finalidade
      check (finalidade is null or finalidade in ('legado', 'financeiro_homologacao', 'pedidos_producao'));
  end if;
end $$;

-- Credencial só entra em conexão de finalidade compatível.
create or replace function ifood_credencial_confere_finalidade() returns trigger
language plpgsql as $$
declare v_fin text;
begin
  select finalidade into v_fin from ifood_conexoes where id = new.conexao_id;
  if v_fin = 'pedidos_producao' and new.app_type <> 'order' then
    raise exception 'ifood: conexao de pedidos_producao aceita apenas credencial order (recebido %)', new.app_type
      using errcode = '23514';
  end if;
  if v_fin = 'financeiro_homologacao' and new.app_type = 'order' then
    raise exception 'ifood: conexao financeiro_homologacao nunca recebe credencial order'
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists trg_ifood_credencial_finalidade on ifood_credenciais;
create trigger trg_ifood_credencial_finalidade
  before insert or update of conexao_id, app_type on ifood_credenciais
  for each row execute function ifood_credencial_confere_finalidade();

-- A finalidade só muda de/para 'legado' (rotulagem e rollback) e só se as credenciais existentes forem compatíveis com a nova.
create or replace function ifood_conexao_confere_finalidade() returns trigger
language plpgsql as $$
begin
  if new.finalidade is distinct from old.finalidade then
    if old.finalidade <> 'legado' and new.finalidade <> 'legado' then
      raise exception 'ifood: a finalidade da conexao nao muda de % para % (volte a legado antes)', old.finalidade, new.finalidade
        using errcode = '23514';
    end if;
    if new.finalidade = 'pedidos_producao'
       and exists (select 1 from ifood_credenciais c where c.conexao_id = new.id and c.app_type <> 'order') then
      raise exception 'ifood: conexao com credencial financial/analytics nao pode virar pedidos_producao'
        using errcode = '23514';
    end if;
    if new.finalidade = 'financeiro_homologacao'
       and exists (select 1 from ifood_credenciais c where c.conexao_id = new.id and c.app_type = 'order') then
      raise exception 'ifood: conexao com credencial order nao pode virar financeiro_homologacao'
        using errcode = '23514';
    end if;
    if new.finalidade = 'financeiro_homologacao'
       and to_regclass('ifood_conexao_lojas') is not null
       and exists (select 1 from ifood_conexao_lojas l where l.conexao_id = new.id) then
      raise exception 'ifood: conexao com lojas adicionais nao pode virar financeiro_homologacao'
        using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_ifood_conexao_finalidade on ifood_conexoes;
create trigger trg_ifood_conexao_finalidade
  before update of finalidade on ifood_conexoes
  for each row execute function ifood_conexao_confere_finalidade();

-- Loja adicional (117) não entra em conexão financeira de homologação (o polling de pedidos nunca a enxerga).
do $$
begin
  if to_regclass('ifood_conexao_lojas') is not null then
    execute $f$
      create or replace function ifood_conexao_loja_confere_finalidade() returns trigger
      language plpgsql as $b$
      declare v_fin text;
      begin
        select finalidade into v_fin from ifood_conexoes where id = new.conexao_id;
        if v_fin = 'financeiro_homologacao' then
          raise exception 'ifood: loja adicional nao pode ser vinculada a conexao financeiro_homologacao'
            using errcode = '23514';
        end if;
        return new;
      end $b$ $f$;
    execute 'drop trigger if exists trg_ifood_loja_finalidade on ifood_conexao_lojas';
    execute 'create trigger trg_ifood_loja_finalidade before insert or update of conexao_id on ifood_conexao_lojas
             for each row execute function ifood_conexao_loja_confere_finalidade()';
  end if;
end $$;

-- As funções dos triggers não são chamáveis por PUBLIC/anon/authenticated (o trigger dispara com ou sem este privilégio; o EXECUTE só é
-- conferido na criação do trigger). Mesmo padrão da 117.
do $$
declare
  v_fn text;
  v_role text;
begin
  foreach v_fn in array array['ifood_credencial_confere_finalidade()', 'ifood_conexao_confere_finalidade()', 'ifood_conexao_loja_confere_finalidade()'] loop
    if to_regprocedure(v_fn) is not null then
      execute format('revoke all on function %s from public', v_fn);
      foreach v_role in array array['anon', 'authenticated'] loop
        if exists (select 1 from pg_roles where rolname = v_role) then
          execute format('revoke all on function %s from %I', v_fn, v_role);
        end if;
      end loop;
    end if;
  end loop;
end $$;

commit;
