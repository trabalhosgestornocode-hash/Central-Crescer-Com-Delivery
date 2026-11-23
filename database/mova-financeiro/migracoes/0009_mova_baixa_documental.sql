-- MOVA — Agente 2 (Execução 17): operação BAIXA_DOCUMENTAL (pagamento registrado POR COMPROVANTE, conciliação pendente).
--
-- Só amplia a lista fechada de operações das políticas e das execuções. Nenhuma política é semeada: sem política cadastrada
-- o MOVA só PROPÕE. A escrita real continua exigindo política explícita + identidade operacional com concessão no Financeiro.
alter table mova.politica_autonomia drop constraint politica_autonomia_operacao_check;
alter table mova.politica_autonomia add constraint politica_autonomia_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL'));
alter table mova.operacao_executada drop constraint operacao_executada_operacao_check;
alter table mova.operacao_executada add constraint operacao_executada_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL'));
