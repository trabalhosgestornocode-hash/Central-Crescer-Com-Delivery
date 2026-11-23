-- MOVA — RECUPERAÇÃO da 0009_mova_baixa_documental (volta ao estado da 0008). Uma transação; aborta sem mudar nada se já
-- existir política ou operação BAIXA_DOCUMENTAL (essas linhas não são apagadas por este arquivo: decidir antes).
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0009_mova_baixa_documental.sql') then raise exception 'MOVA recuperação: 0009 não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from mova.mova_migracao where nome > '0009_mova_baixa_documental.sql') then raise exception 'MOVA recuperação: há migrações depois da 0009'; end if;
  if exists (select 1 from mova.politica_autonomia where operacao = 'BAIXA_DOCUMENTAL') then raise exception 'MOVA recuperação: existe política BAIXA_DOCUMENTAL — nada foi feito'; end if;
  if exists (select 1 from mova.operacao_executada where operacao = 'BAIXA_DOCUMENTAL') then raise exception 'MOVA recuperação: existe operação BAIXA_DOCUMENTAL — nada foi feito'; end if;
end $$;
alter table mova.politica_autonomia drop constraint politica_autonomia_operacao_check;
alter table mova.politica_autonomia add constraint politica_autonomia_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO'));
alter table mova.operacao_executada drop constraint operacao_executada_operacao_check;
alter table mova.operacao_executada add constraint operacao_executada_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO'));
delete from mova.mova_migracao where nome = '0009_mova_baixa_documental.sql';
