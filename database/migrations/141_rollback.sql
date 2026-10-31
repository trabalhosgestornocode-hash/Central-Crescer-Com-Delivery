-- Rollback da 141: remove a fila/auditoria dos relatórios operacionais e os resumos semanais (exportar antes se houver dados). Não toca no D-1.
begin;
set local lock_timeout = '5s';
drop function if exists operacional_relatorio_finalizar(uuid, text, text, text, text, integer);
drop function if exists operacional_relatorio_reservar(uuid, text, integer, timestamptz, integer);
drop table if exists operacional_relatorios_envios;
drop table if exists operacional_resumos_semanais;
notify pgrst, 'reload schema';
commit;
