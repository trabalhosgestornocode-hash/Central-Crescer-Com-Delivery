-- MOVA — RECUPERAÇÃO da 0016_mova_avisos_entregadores (volta a lista de tipos de envio anterior). Uma transação; só DEFINIÇÕES.
-- Aborta se já houver aviso registrado com os tipos novos (o histórico de envio não é apagado) ou migração posterior.
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0016_mova_avisos_entregadores.sql') then raise exception 'MOVA recuperação: 0016 não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from mova.mova_migracao where nome > '0016_mova_avisos_entregadores.sql') then raise exception 'MOVA recuperação: há migrações depois da 0016'; end if;
  if exists (select 1 from mova.entregador_envio where tipo in ('AVISO_DEMONSTRATIVO', 'AVISO_NOTA_RECEBIDA')) then raise exception 'MOVA recuperação: já há avisos registrados — nada foi feito'; end if;
end $$;
alter table mova.entregador_envio drop constraint entregador_envio_tipo_check;
alter table mova.entregador_envio add constraint entregador_envio_tipo_check check (tipo in ('SEMANAL', 'COBRANCA_NOTA', 'NOTA_RECEBIDA', 'AVISO_LIBERACAO', 'RELATORIO_QUARTA'));
delete from mova.mova_migracao where nome = '0016_mova_avisos_entregadores.sql';
