-- =====================================================================
-- ROLLBACK da migration 101 (iFood Events). NÃO executar automaticamente.
-- Remove SOMENTE o que a 101 criou e devolve os CHECKs de app_type ao estado da 056.
-- As TABELAS e os dados da 056 (ifood_conexoes, ifood_credenciais, ifood_oauth_sessoes) NÃO são tocados.
--
-- ATENÇÃO: apaga o histórico de eventos e o estado oficial dos pedidos iFood recebidos.
-- Só faça em banco de TESTE, ou em produção com backup e ordem explícita.
-- =====================================================================

-- 0. TRAVA PRIMEIRO (antes de qualquer DROP): se existir alguma linha com app_type = 'order', o rollback
--    ABORTA sem mexer em nada — ele não apaga credenciais nem sessões. Converta/remova antes, conscientemente.
do $$
begin
  if exists (select 1 from ifood_credenciais where app_type = 'order')
     or exists (select 1 from ifood_oauth_sessoes where app_type = 'order') then
    raise exception 'rollback 101 abortado: existem linhas com app_type = order em ifood_credenciais/ifood_oauth_sessoes. Remova-as conscientemente antes.';
  end if;
end $$;

-- 1. app_type: volta ao CHECK original da 056 (analytics, financial).
alter table ifood_credenciais drop constraint if exists ifood_credenciais_app_type_check;
alter table ifood_credenciais add constraint ifood_credenciais_app_type_check
  check (app_type in ('analytics', 'financial'));

alter table ifood_oauth_sessoes drop constraint if exists ifood_oauth_sessoes_app_type_check;
alter table ifood_oauth_sessoes add constraint ifood_oauth_sessoes_app_type_check
  check (app_type in ('analytics', 'financial'));

-- 2. Objetos criados pela 101.
drop function if exists ifood_eventos_marcar_reentrega(text[]);
drop function if exists ifood_lease_liberar(text, text);
drop function if exists ifood_lease_adquirir(text, text, integer);

drop table if exists ifood_pedidos;
drop table if exists ifood_eventos;
drop table if exists ifood_poller_lease;
