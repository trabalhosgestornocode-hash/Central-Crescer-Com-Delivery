-- Rollback da 144 — remove a camada central Foody (piloto em sombra).
--
-- ATENÇÃO: APAGA conexões (tokens cifrados), execuções, pedidos saneados e o histórico de fechamentos logísticos. Exporte antes
-- se precisar:  copy (select * from foody_fechamentos_logisticos order by unidade_id, competencia, versao) to stdout with csv header;
-- Nenhuma outra tabela depende destas: Parser, Dashboard, Checklist, fechamentos operacionais, Performance, Agente e WhatsApp
-- seguem funcionando. Os pedidos podem ser sincronizados de novo a partir da API Foody. Idempotente.

begin;
set local lock_timeout = '5s';
drop function if exists public.foody_fechamento_registrar(uuid, uuid, date, text, text, uuid, uuid, integer, text, text, text, jsonb, jsonb, jsonb, jsonb, text);
drop table if exists public.foody_fechamentos_logisticos;
drop table if exists public.foody_pedidos;
drop table if exists public.foody_sync_execucoes;
drop table if exists public.foody_conexoes;
drop function if exists public.foody_registro_imutavel();
drop function if exists public.foody_validar_conexao_execucao();
drop function if exists public.foody_validar_vinculo_execucao();
drop function if exists public.foody_validar_tenant();
notify pgrst, 'reload schema';
commit;
