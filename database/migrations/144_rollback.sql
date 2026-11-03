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
-- Objetos da 146 (administração da conexão) e da 145 (conexão compartilhada), se aplicadas: este rollback remove a camada INTEIRA.
drop function if exists public.foody_conexao_administrar(text, uuid, uuid, uuid, text, text, text, text);
drop table if exists public.foody_conexoes_eventos;
drop table if exists public.foody_triagem_decisoes;
drop table if exists public.foody_destinos_eventos;
drop table if exists public.foody_conexao_destinos;
drop table if exists public.foody_sync_execucoes;
drop table if exists public.foody_conexoes;
-- Funções da 146 e da 145 (depois das tabelas que as usam em triggers).
drop function if exists public.foody_conexao_auditar_transferencia();
drop function if exists public.foody_conexao_guardas();
drop function if exists public.foody_triagem_decisao_validar();
drop function if exists public.foody_fech_exigir_destino_ativo();
drop function if exists public.foody_pedido_validar_destino();
drop function if exists public.foody_destino_auditar();
drop function if exists public.foody_conexao_revogar_destinos();
drop function if exists public.foody_destino_validar();
drop function if exists public.foody_eh_admin_da_organizacao(uuid, uuid);
drop function if exists public.foody_registro_imutavel();
drop function if exists public.foody_unidade_imutavel();
drop function if exists public.foody_validar_conexao_execucao();
drop function if exists public.foody_validar_vinculo_execucao();
drop function if exists public.foody_validar_tenant();
notify pgrst, 'reload schema';
commit;
