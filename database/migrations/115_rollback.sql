-- Rollback da 115 — ÚLTIMO RECURSO: REABRE o acesso direto às 4 views e às 7 funções. Prefira a correção para frente
-- (docs/plano-migration-115-correcao-de-seguranca.md, seção 8). Só rode com aprovação escrita e mitigação compensatória.
--
-- Devolve EXATAMENTE o estado que a auditoria de produção encontrou, sem ampliar além dele:
--   * views: SELECT para anon e authenticated (não devolve INSERT/UPDATE/DELETE);
--   * funções: EXECUTE para PUBLIC (que era o estado: anon, authenticated e PUBLIC executavam).
-- NÃO mexe em unidade_config: o RLS dela já estava ligado em produção ANTES da 115 e deve continuar ligado (a 115 só o liga se estiver desligado,
-- e o rollback não tem como saber qual foi o caso — por segurança, nunca o desliga).
begin;
set local lock_timeout = '5s';
do $$
declare r record;
begin
  for r in select c.oid::regclass as nome from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm')
           and c.relname in ('vw_estoque_critico', 'vw_faturamento_diario', 'vw_produto_margem', 'vw_produtos_vendidos') loop
    execute format('grant select on table %s to anon, authenticated', r.nome);
  end loop;
  for r in select p.oid::regprocedure as assinatura from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname in (
             'bonificacao_congelar_competencia', 'bonificacao_reabrir_competencia', 'converter_empresa_para_unidade',
             'excluir_organizacao_definitivamente', 'promover_unidade_para_empresa', 'remapear_organizacao_em_tabelas_de_unidade',
             'transferir_unidade_organizacao') loop
    execute format('grant execute on function %s to public', r.assinatura);
  end loop;
end $$;
commit;
