-- Rollback da 130 — remove a camada analítica operacional, os fechamentos e as simulações de WhatsApp.
--
-- ATENÇÃO: APAGA o histórico de fechamentos (todas as versões) e de simulações. Exporte antes se precisar:
--   copy (select * from operacional_fechamentos order by unidade_id, competencia, versao) to stdout with csv header;
-- A projeção (operacional_pedidos) é derivada e reconstruível a partir de ifood_pedidos/ifood_eventos, que NÃO são tocados.
-- Sem as tabelas, as rotas novas respondem 503 (indisponível) e o Dashboard/Checklist existentes seguem funcionando. Idempotente.

begin;
set local lock_timeout = '5s';
drop table if exists public.operacional_mensagens_simuladas;
drop function if exists public.operacional_fechamento_registrar(uuid, uuid, date, text, uuid, integer, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, text);
drop table if exists public.operacional_fechamentos;
drop table if exists public.operacional_projecao_cursor;
drop table if exists public.operacional_pedidos;
drop function if exists public.operacional_registro_imutavel();
drop function if exists public.operacional_validar_tenant();
commit;
