-- MOVA — RECUPERAÇÃO da 0010_mova_despesa_documental (volta ao estado da 0009). Uma transação; aborta sem mudar nada se já
-- existir política ou operação DESPESA_DOCUMENTAL (essas linhas não são apagadas por este arquivo: decidir antes).
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0010_mova_despesa_documental.sql') then raise exception 'MOVA recuperação: 0010 não está aplicada — nada a desfazer'; end if;
  -- A 0011 (rotina de entregadores) foi aplicada em produção ANTES da 0010 e não toca nas listas de operações: pode ficar.
  if exists (select 1 from mova.mova_migracao where nome > '0010_mova_despesa_documental.sql' and nome <> '0011_mova_entregadores_rotina.sql') then raise exception 'MOVA recuperação: há migrações depois da 0010'; end if;
  if exists (select 1 from mova.politica_autonomia where operacao = 'DESPESA_DOCUMENTAL') then raise exception 'MOVA recuperação: existe política DESPESA_DOCUMENTAL — nada foi feito'; end if;
  if exists (select 1 from mova.operacao_executada where operacao = 'DESPESA_DOCUMENTAL') then raise exception 'MOVA recuperação: existe operação DESPESA_DOCUMENTAL — nada foi feito'; end if;
end $$;
alter table mova.politica_autonomia drop constraint politica_autonomia_operacao_check;
alter table mova.politica_autonomia add constraint politica_autonomia_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL'));
alter table mova.operacao_executada drop constraint operacao_executada_operacao_check;
alter table mova.operacao_executada add constraint operacao_executada_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL'));
delete from mova.mova_migracao where nome = '0010_mova_despesa_documental.sql';
