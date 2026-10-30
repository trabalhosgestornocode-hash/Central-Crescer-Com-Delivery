-- 129 — Privilégios mínimos nas tabelas da integração iFood (achado S-1 da auditoria Order/Events, docs/auditoria-ifood-order-events/04).
--
-- PROBLEMA: as tabelas criadas antes da política "sem grants para clientes" (056, 101, 102, 103) herdaram os default privileges do Supabase:
-- `anon` e `authenticated` têm SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER. O RLS (ligado, sem policy) bloqueia
-- SELECT/INSERT/UPDATE/DELETE pelo PostgREST, mas TRUNCATE NÃO é coberto por RLS — e nada no sistema precisa desses privilégios:
--   * o frontend não lê nenhuma tabela direto (só a API do backend e o Realtime por broadcast);
--   * o backend usa `service_role` (ifood*.repository.js, checklistOperacional.repository.js).
--
-- O QUE FAZ (aditivo em segurança, sem tocar dados, sem tocar RLS/policies):
--   * REVOKE ALL de PUBLIC, anon e authenticated nas tabelas listadas;
--   * service_role mantém SELECT, INSERT, UPDATE, DELETE (o que o backend usa) e perde TRUNCATE/REFERENCES/TRIGGER (nunca usados);
--   * tabela ausente (banco com drift) é PULADA com NOTICE — nunca falha por isso.
-- A policy `rls_ifood_conexoes_tenant` (authenticated) continua existindo, mas sem GRANT ela não abre nada: é exatamente o
-- comportamento das tabelas mais novas (116–118, 124, 127). O Realtime da Central é broadcast (não postgres_changes): não depende disso.
--
-- O QUE NÃO FAZ: não muda o poller, o ACK, as funções do lease nem as RPCs (as EXECUTE já são só do service_role na 101).
-- Rollback: 129_rollback.sql (devolve os grants herdados — só para emergência; reabre a exposição).

begin;
set local lock_timeout = '5s';

do $$
declare
  tabela text;
  papel text;
  tabelas constant text[] := array[
    'ifood_eventos', 'ifood_pedidos', 'ifood_disputas', 'ifood_pedido_acoes', 'ifood_poller_lease',
    'ifood_credenciais', 'ifood_oauth_sessoes', 'ifood_conexoes'
  ];
begin
  foreach tabela in array tabelas loop
    if to_regclass(format('public.%I', tabela)) is null then
      raise notice '129: tabela % ausente neste banco — pulada', tabela;
      continue;
    end if;
    foreach papel in array array['public', 'anon', 'authenticated'] loop
      if papel = 'public' or exists (select 1 from pg_roles where rolname = papel) then
        execute format('revoke all on table public.%I from %s', tabela, papel);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke truncate, references, trigger on table public.%I from service_role', tabela);
      execute format('grant select, insert, update, delete on table public.%I to service_role', tabela);
    end if;
  end loop;
end $$;

commit;

-- VERIFICAÇÃO (só leitura) — deve voltar ZERO linhas:
-- select table_name, grantee, privilege_type from information_schema.role_table_grants
--  where table_schema = 'public' and grantee in ('anon','authenticated','PUBLIC')
--    and table_name in ('ifood_eventos','ifood_pedidos','ifood_disputas','ifood_pedido_acoes','ifood_poller_lease',
--                       'ifood_credenciais','ifood_oauth_sessoes','ifood_conexoes');
