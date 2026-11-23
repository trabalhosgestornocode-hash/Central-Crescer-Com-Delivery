-- MOVA (23/11/2026): operação JUROS_DOCUMENTAL — pagamento por comprovante COM juros/multa confirmados pela pessoa (ação estreita
-- `registrar_juros` do Financeiro, migração 0031). O limite da política é o ENCARGO máximo por pagamento.
--
-- Só amplia a lista fechada de operações das políticas e das execuções. Nenhuma política é semeada: sem política cadastrada
-- o MOVA só PROPÕE (o Financeiro aplica o pagamento com juros na Central).
alter table mova.politica_autonomia drop constraint politica_autonomia_operacao_check;
alter table mova.politica_autonomia add constraint politica_autonomia_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL'));
alter table mova.operacao_executada drop constraint operacao_executada_operacao_check;
alter table mova.operacao_executada add constraint operacao_executada_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL'));
