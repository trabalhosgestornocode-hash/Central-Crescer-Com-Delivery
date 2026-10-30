-- Rollback da 129 — devolve os privilégios HERDADOS (default privileges do Supabase) às tabelas da integração iFood.
--
-- ATENÇÃO: reabre a exposição corrigida pela 129 (anon/authenticated com TRUNCATE etc.). Use só se algum fluxo depender,
-- comprovadamente, desses grants — e registre qual. Nenhum dado é tocado. Idempotente; tabela ausente é pulada.

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
    if to_regclass(format('public.%I', tabela)) is null then continue; end if;
    foreach papel in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = papel) then
        execute format('grant all on table public.%I to %s', tabela, papel);
      end if;
    end loop;
  end loop;
end $$;

commit;
