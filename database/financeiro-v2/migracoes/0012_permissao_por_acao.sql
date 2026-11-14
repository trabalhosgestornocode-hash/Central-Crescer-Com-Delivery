-- =====================================================================================================================
-- Financeiro v2 — migração 0012: autorização POR AÇÃO no caminho de persistência (Execução 08)
--
-- Só é aplicada no PostgreSQL local isolado. Não pertence a database/migrations/.
--
-- PROBLEMA (07B, risco R4): o banco exigia sessão válida, mas qualquer sessão com uma ação além de `ver` gravava em
-- qualquer tabela da unidade (ex.: quem só concilia podia gravar vendas; quem só importa podia mudar a competência).
--
-- CORREÇÃO:
--   * fv2_tem_acao(ações[]): a sessão de banco é operacional E o usuário DELA tem, AGORA (concessão gravada e ativa,
--     lida no comando — revogação concorrente vale no comando seguinte), alguma das ações pedidas na mesma unidade;
--   * cada tabela × operação exige o conjunto de ações que o núcleo realmente usa para gravá-la (mapa medido pela
--     suíte inteira instrumentada — docs/financeiro-v2/17, seção 4). Operação sem uso legítimo = recusada sempre;
--   * competência: gatilho espelha a matriz de transições do núcleo (dominio/fechamento.js): homologar exige
--     `homologar`; reabrir uma homologada exige `revisar`; as demais mudanças de estado exigem `fechar`;
--   * histórico: só quem tem alguma ação de escrita (ou a sessão de provisionamento, para a concessão atestada).
-- Leitura continua exigindo sessão operacional (07B). Superusuário/dono não passam pela regra (como no RLS).
-- =====================================================================================================================

create function fv2_tem_acao(p_acoes text[]) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (
    select 1
      from fv2__sessao_vigente() s
      join fv2_concessao c on c.organizacao_id = s.organizacao_id and c.unidade_id = s.unidade_id and c.usuario_id = s.usuario_id
     where s.finalidade = 'OPERACAO' and c.situacao = 'ATIVA' and c.acoes ?| p_acoes
  )
$$;
alter function fv2_tem_acao(text[]) owner to fv2_guardiao;
revoke all on function fv2_tem_acao(text[]) from public;
grant execute on function fv2_tem_acao(text[]) to fv2_app;

-- Mapa tabela × operação → ações (prefixo financeiro_v2. omitido aqui e acrescentado abaixo).
create temporary table fv2__mapa (tabela text, operacao text, acoes text[]) on commit drop;
insert into fv2__mapa values
  ('fv2_ajuste', 'I', '{cancelar,corrigir,revisar,registrar}'),
  ('fv2_atribuicao_pendencia', 'I', '{revisar}'), ('fv2_atribuicao_pendencia', 'U', '{revisar}'),
  ('fv2_canal_processador', 'I', '{configurar}'), ('fv2_canal_processador', 'U', '{configurar}'),
  ('fv2_categoria', 'I', '{configurar,registrar}'), ('fv2_categoria', 'U', '{configurar}'),
  ('fv2_competencia', 'I', '{fechar}'), ('fv2_competencia', 'U', '{fechar,homologar,revisar}'),
  ('fv2_configuracao_unidade', 'I', '{configurar}'), ('fv2_configuracao_unidade', 'U', '{configurar}'),
  ('fv2_conta', 'I', '{configurar}'), ('fv2_conta', 'U', '{configurar}'),
  ('fv2_contraparte', 'I', '{registrar,revisar}'), ('fv2_contraparte', 'U', '{registrar,configurar}'),
  ('fv2_correspondencia', 'I', '{conciliar}'), ('fv2_correspondencia', 'U', '{conciliar}'),
  ('fv2_divergencia_fonte', 'I', '{registrar,importar}'), ('fv2_divergencia_fonte', 'U', '{revisar}'),
  ('fv2_documento', 'I', '{importar,registrar}'), ('fv2_documento', 'U', '{importar,registrar}'),
  ('fv2_estorno', 'I', '{cancelar}'),
  ('fv2_importacao', 'I', '{importar}'), ('fv2_importacao', 'U', '{importar}'),
  ('fv2_lancamento', 'I', '{cancelar,corrigir,registrar,revisar}'), ('fv2_lancamento', 'U', '{cancelar,corrigir,revisar}'),
  ('fv2_liquidacao', 'I', '{registrar,revisar}'), ('fv2_liquidacao', 'U', '{cancelar}'),
  ('fv2_movimentacao', 'I', '{cancelar,registrar,revisar}'), ('fv2_movimentacao', 'U', '{cancelar,conciliar,registrar}'),
  ('fv2_obrigacao', 'I', '{registrar,revisar}'), ('fv2_obrigacao', 'U', '{cancelar,corrigir,registrar,revisar}'),
  ('fv2_pagamento_venda', 'I', '{registrar,revisar}'), ('fv2_pagamento_venda', 'U', '{cancelar}'),
  ('fv2_proposta', 'I', '{registrar,importar}'), ('fv2_proposta', 'U', '{cancelar,registrar,revisar}'),
  ('fv2_recebivel', 'I', '{registrar,revisar}'), ('fv2_recebivel', 'U', '{cancelar,corrigir,registrar,revisar}'),
  ('fv2_registro_fonte', 'I', '{importar}'), ('fv2_registro_fonte', 'U', '{importar}'),
  ('fv2_saldo_conta', 'I', '{registrar}'),
  ('fv2_sessao_caixa', 'I', '{registrar}'), ('fv2_sessao_caixa', 'U', '{registrar}'),
  ('fv2_transferencia', 'I', '{registrar}'), ('fv2_transferencia', 'U', '{cancelar}'),
  ('fv2_venda', 'I', '{registrar,revisar}'), ('fv2_venda', 'U', '{cancelar,registrar,revisar}'),
  ('fv2_versao_fechamento', 'I', '{fechar,homologar}'),
  ('fv2_vinculo_documental', 'I', '{registrar,importar}');

do $$
declare
  t record;
  acoes text;
  inc text;
  alt text;
begin
  for t in select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
            where ns.nspname = current_schema() and c.relkind = 'r' and c.relrowsecurity and c.relname like 'fv2\_%'
              and c.relname not in ('fv2_concessao', 'fv2_escopo', 'fv2_historico') loop
    select string_agg(format('%L', 'financeiro_v2.' || a), ', ') into acoes from fv2__mapa m, unnest(m.acoes) a where m.tabela = t.relname and m.operacao = 'I';
    inc := case when acoes is null then 'false' else format('(select fv2_tem_acao(array[%s]))', acoes) end;
    select string_agg(format('%L', 'financeiro_v2.' || a), ', ') into acoes from fv2__mapa m, unnest(m.acoes) a where m.tabela = t.relname and m.operacao = 'U';
    alt := case when acoes is null then 'false' else format('(select fv2_tem_acao(array[%s]))', acoes) end;
    -- USING de UPDATE também governa SELECT ... FOR UPDATE (reserva da linha numa operação que GRAVA a tabela ou a
    -- referencia): vale para quem pode incluir OU alterar. A ALTERAÇÃO em si é decidida no WITH CHECK (só as ações
    -- de alteração; sem uso legítimo = recusada com erro, nunca "sumida").
    select string_agg(distinct format('%L', 'financeiro_v2.' || a), ', ') into acoes from fv2__mapa m, unnest(m.acoes) a where m.tabela = t.relname;
    execute format('alter policy %I on %I with check (%s)', t.relname || '_incluir', t.relname, inc);
    execute format('alter policy %I on %I using (%s) with check (%s)', t.relname || '_alterar', t.relname,
      case when acoes is null then 'false' else format('(select fv2_tem_acao(array[%s]))', acoes) end, alt);
  end loop;
end $$;

alter policy fv2_historico_incluir on fv2_historico with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar',
    'financeiro_v2.fechar', 'financeiro_v2.homologar', 'financeiro_v2.revisar', 'financeiro_v2.configurar', 'financeiro_v2.importar',
    'financeiro_v2.conceder', 'financeiro_v2.documentos']))
  or ((select fv2_em_provisionamento()) and registro_tipo = 'CONCESSAO'));

-- Competência: a ação exigida depende da TRANSIÇÃO (espelho de dominio/fechamento.js).
create function fv2_exigir_acao_da_transicao() returns trigger language plpgsql as $$
declare
  exigida text;
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.estado = old.estado then
    return new;
  end if;
  exigida := case
    when new.estado = 'FECHAMENTO_HOMOLOGADO' then 'financeiro_v2.homologar'
    when tg_op = 'UPDATE' and old.estado = 'FECHAMENTO_HOMOLOGADO' then 'financeiro_v2.revisar'
    else 'financeiro_v2.fechar' end;
  if not fv2_tem_acao(array[exigida]) then
    raise exception 'Financeiro v2: a mudança de estado da competência exige %.', exigida using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_competencia_acao before insert or update on fv2_competencia for each row execute function fv2_exigir_acao_da_transicao();
