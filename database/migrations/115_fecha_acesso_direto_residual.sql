-- =====================================================================
-- MIGRATION 115 — Fecha o acesso DIRETO (REST/RPC) residual: 4 views e 7 RPCs de negócio — PROPOSTA (6B.7, v2)
-- =====================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO SEM APROVAÇÃO EXPLÍCITA. Escrita e testada SÓ contra um Postgres local descartável.
-- INDEPENDENTE das migrations 112–114 (pode ser aplicada antes, depois ou sem elas). Escopo MÍNIMO e SOMENTE-REMOÇÃO.
--
-- ACHADOS CONFIRMADOS NA AUDITORIA DE PRODUÇÃO (Postgres 17.6, 6B.6):
--   1. 4 views `vw_*` rodam com o privilégio do DONO (sem security_invoker) e têm SELECT para `anon` e `authenticated` ⇒ ignoram o RLS
--      das tabelas-base: o faturamento/estoque/margens de TODAS as unidades ficam legíveis por quem tem a chave `anon` pública.
--   2. 7 funções de negócio SECURITY INVOKER estão executáveis por `anon`, `authenticated` e PUBLIC (hoje só o RLS as segura).
--   (`unidade_config` JÁ tem RLS ligado e sem policies em produção — nega tudo a anon/authenticated; por isso esta migration NÃO a toca
--    quando o RLS já está ligado. Em ambientes sem RLS nela (ex.: banco novo montado só pelas migrations do repositório), liga-o;
--    nunca cria, altera nem remove policy.)
--
-- O QUE FAZ (e SÓ isso):
--   * REVOKE ALL nas 4 views e nas 7 funções (TODAS as sobrecargas, por nome) de PUBLIC, anon e authenticated;
--   * NÃO AMPLIA nada: nenhum GRANT novo. Única exceção defensiva: se, depois da revogação, a `service_role` (o backend) tiver perdido o acesso
--     efetivo (ex.: o acesso dela vinha só via PUBLIC), devolve a ELA o mesmo acesso que já tinha (SELECT / EXECUTE) — nunca a outra role;
--   * `unidade_config`: só liga o RLS se estiver DESLIGADO; se já estiver ligado, não faz nada (nem toma lock);
--   * PRÉ-CONDIÇÃO (falha segura): se a role que executa não administra algum objeto-alvo (não é dono nem membro do dono) ⇒ ABORTA com a lista;
--   * PÓS-CONDIÇÃO (falha segura), por privilégio EFETIVO: se `anon` ou `authenticated` ainda tiverem QUALQUER acesso a algum alvo — por grant de OUTRA
--     role (que a REVOKE do dono não alcança) ou por HERANÇA de outra role — ⇒ ABORTA e DESFAZ TUDO, listando objeto, role e origem; basta tratar a origem e repetir.
--   * Tudo numa transação, `lock_timeout` de 5 s: se algo segurar um objeto, FALHA sem aplicar nada. Idempotente.
-- NÃO MEXE em: dados, policies, funções auxiliares de RLS (auth_*, is_platform_superadmin, tem_grant_realtime), fn_custo_*, nenhuma outra tabela/view/função.
-- ROLLBACK: 115_rollback.sql (reabre — último recurso; ver docs/plano-migration-115-correcao-de-seguranca.md para a contingência).
-- =====================================================================
begin;
set local lock_timeout = '5s';

do $$
declare
  views text[] := array['vw_estoque_critico', 'vw_faturamento_diario', 'vw_produto_margem', 'vw_produtos_vendidos'];
  rpcs  text[] := array['bonificacao_congelar_competencia', 'bonificacao_reabrir_competencia', 'converter_empresa_para_unidade',
                        'excluir_organizacao_definitivamente', 'promover_unidade_para_empresa', 'remapear_organizacao_em_tabelas_de_unidade',
                        'transferir_unidade_organizacao'];
  r record;
  lista text := '';
  n_views int := 0; n_rpcs int := 0;
begin
  -- 0) PRÉ-CONDIÇÃO: quem executa precisa administrar cada alvo (dono ou membro do papel dono)
  for r in
    select c.oid::regclass::text as nome, c.relowner as dono from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm') and c.relname = any(views)
    union all
    select p.oid::regprocedure::text, p.proowner from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname = any(rpcs)
  loop
    if not pg_has_role(current_user, r.dono, 'USAGE') then
      lista := lista || E'\n  - ' || r.nome || ' (dono: ' || pg_get_userbyid(r.dono) || ')';
    end if;
  end loop;
  if lista <> '' then
    raise exception 'MIGRATION 115 abortada: a role % não administra estes objetos (nada foi alterado):%', current_user, lista
      using hint = 'Execute com a role dona (normalmente postgres no SQL Editor). Não mude o dono dos objetos como parte desta migration.';
  end if;

  -- 1) As 4 views: revoga de PUBLIC/anon/authenticated
  for r in select c.oid, c.oid::regclass as nome from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm') and c.relname = any(views) loop
    execute format('revoke all on table %s from public, anon, authenticated', r.nome);
    if not has_table_privilege('service_role', r.oid, 'select') then          -- só devolve a service_role o que ela já tinha (via PUBLIC)
      execute format('grant select on table %s to service_role', r.nome);
    end if;
    n_views := n_views + 1;
  end loop;

  -- 2) unidade_config: só liga o RLS se estiver desligado (em produção já está ligado: nada a fazer, nenhum lock). Nunca toca em policies.
  if exists (select 1 from pg_class where oid = to_regclass('public.unidade_config') and not relrowsecurity) then
    execute 'alter table public.unidade_config enable row level security';
  end if;

  -- 3) As 7 RPCs (todas as sobrecargas): revoga de PUBLIC/anon/authenticated
  for r in select p.oid, p.oid::regprocedure as assinatura from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname = any(rpcs) loop
    execute format('revoke all on function %s from public, anon, authenticated', r.assinatura);
    if not has_function_privilege('service_role', r.oid, 'execute') then
      execute format('grant execute on function %s to service_role', r.assinatura);
    end if;
    n_rpcs := n_rpcs + 1;
  end loop;

  -- 4) PÓS-CONDIÇÃO (privilégio EFETIVO, inclui PUBLIC, herança por associação a outras roles e grants de outras roles): anon e authenticated
  --    não podem ter NENHUM privilégio sobre os alvos. Se tiverem, desfaz TUDO e diz quem concede (ACL) ou de que role herdam.
  lista := '';
  for r in
    select c.oid::regclass::text as nome, x.papel,
           coalesce((select string_agg(distinct (a).grantee::regrole::text || ' concedido por ' || pg_get_userbyid((a).grantor), '; ')
                       from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where (a).grantee <> c.relowner and (a).grantee <> coalesce(to_regrole('service_role')::oid, 0::oid)), '(só herdado)') as quem
      from pg_class c, unnest(array['anon', 'authenticated']) x(papel)
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm') and c.relname = any(views) and to_regrole(x.papel) is not null
        and has_table_privilege(x.papel, c.oid, 'select,insert,update,delete,truncate,references,trigger')
    union all
    select p.oid::regprocedure::text, x.papel,
           coalesce((select string_agg(distinct (a).grantee::regrole::text || ' concedido por ' || pg_get_userbyid((a).grantor), '; ')
                       from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where (a).grantee <> p.proowner and (a).grantee <> coalesce(to_regrole('service_role')::oid, 0::oid)), '(só herdado)')
      from pg_proc p, unnest(array['anon', 'authenticated']) x(papel)
      where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname = any(rpcs) and to_regrole(x.papel) is not null
        and has_function_privilege(x.papel, p.oid, 'execute')
  loop
    lista := lista || E'\n  - ' || r.nome || ' ← ' || r.papel || ' ainda teria acesso; origem: ' || r.quem;
  end loop;
  if lista <> '' then
    raise exception 'MIGRATION 115 abortada e DESFEITA: anon/authenticated ainda teriam acesso efetivo (grant de outra role ou herança):%', lista
      using hint = 'Revogue do concedente (REVOKE ALL ON <objeto> FROM <concedente> CASCADE) ou retire a associação que concede a herança, e repita. A consulta 6b8 mostra ACL completa e associações.';
  end if;

  raise notice 'MIGRATION 115: % views e % funções (todas as sobrecargas) fechadas para PUBLIC/anon/authenticated.', n_views, n_rpcs;
end $$;

commit;
