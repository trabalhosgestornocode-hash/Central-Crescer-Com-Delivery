-- MOVA — RECUPERAÇÃO da 0011_mova_entregadores_rotina (volta ao estado da 0010). Uma transação; só DEFINIÇÕES.
-- Aborta sem mudar nada se já houver dado que dependa da 0011 (cadastro feito pela Central, leitura de nota, aviso/relatório
-- enviado, automação nova ou empresa preenchida): essas linhas não são apagadas por este arquivo — decidir antes.
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0011_mova_entregadores_rotina.sql') then raise exception 'MOVA recuperação: 0011 não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from mova.mova_migracao where nome > '0011_mova_entregadores_rotina.sql') then raise exception 'MOVA recuperação: há migrações depois da 0011'; end if;
  if exists (select 1 from mova.entregador_autorizado where cadastrado_por is not null or verificado_em is not null) then raise exception 'MOVA recuperação: há cadastro feito pela Central — nada foi feito'; end if;
  if exists (select 1 from mova.nota_entregador where leitura is not null or conferencia is not null) then raise exception 'MOVA recuperação: há nota lida/conferida — nada foi feito'; end if;
  if exists (select 1 from mova.entregador_envio where tipo in ('AVISO_LIBERACAO', 'RELATORIO_QUARTA')) then raise exception 'MOVA recuperação: há aviso/relatório registrado — nada foi feito'; end if;
  if exists (select 1 from mova.automacao where nome in ('ENTREGADORES_RELATORIO', 'ENTREGADORES_AVISO_GRUPO')) then raise exception 'MOVA recuperação: há automação nova cadastrada — nada foi feito'; end if;
  if exists (select 1 from mova.grupo_unidade where empresa is not null) then raise exception 'MOVA recuperação: há empresa preenchida — nada foi feito'; end if;
end $$;
alter table mova.automacao drop constraint automacao_nome_check;
alter table mova.automacao add constraint automacao_nome_check check (nome in ('ENTREGADORES_SEMANAL','ENTREGADORES_COBRANCA','RECONFERENCIA_EXTRATO'));
alter table mova.entregador_envio drop constraint entregador_envio_tipo_check;
alter table mova.entregador_envio add constraint entregador_envio_tipo_check check (tipo in ('SEMANAL','COBRANCA_NOTA','NOTA_RECEBIDA'));
revoke update (leitura, conferencia) on mova.nota_entregador from mova_app;
alter table mova.nota_entregador drop column conferencia, drop column leitura;
revoke insert (organizacao_id, unidade_id, chave, telefone_e164, privado, ids, nome, cadastrado_por, verificado_em) on mova.entregador_autorizado from mova_app;
revoke update (ativo, revogado_em, verificado_em) on mova.entregador_autorizado from mova_app;
alter table mova.entregador_autorizado drop column verificado_em, drop column cadastrado_por;
alter table mova.grupo_unidade drop column empresa;
delete from mova.mova_migracao where nome = '0011_mova_entregadores_rotina.sql';
