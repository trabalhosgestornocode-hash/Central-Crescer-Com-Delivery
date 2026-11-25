-- MOVA (25/11/2026): operação PRESTACAO_DE_SANGRIA nas POLÍTICAS de autonomia e nas execuções (MOVA CORE F4; ação estreita
-- `prestar_sangria` do Financeiro, migração 0032). O código já trata a operação (dominio/autonomia.js); faltava a lista fechada
-- do banco aceitá-la. Só amplia as duas listas fechadas. Nenhuma política é semeada: sem política o MOVA só PROPÕE.
alter table mova.politica_autonomia drop constraint politica_autonomia_operacao_check;
alter table mova.politica_autonomia add constraint politica_autonomia_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL','PRESTACAO_DE_SANGRIA'));
alter table mova.operacao_executada drop constraint operacao_executada_operacao_check;
alter table mova.operacao_executada add constraint operacao_executada_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL','PRESTACAO_DE_SANGRIA'));
