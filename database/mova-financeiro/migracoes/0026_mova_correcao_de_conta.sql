-- MOVA (28/11/2026): CORREÇÃO CADASTRAL DE CONTA A PAGAR pelo WhatsApp (Operador Financeiro, fase 1) — fornecedor, vencimento,
-- descrição, observação e forma de pagamento, pela ação ESTREITA `corrigir_conta_a_pagar` do Financeiro (migração 0036).
-- Só acrescenta CORRECAO_DE_CONTA às listas fechadas de PROPOSTAS e EXECUÇÕES (a proposta guarda o antes/depois mostrado e a versão
-- da conta; a execução é única por proposta). NÃO entra na lista de POLÍTICAS: correção cadastral não tem limite monetário e sempre
-- exige a confirmação explícita de um FINANCEIRO da unidade no WhatsApp.
alter table mova.operacao_executada drop constraint operacao_executada_operacao_check;
alter table mova.operacao_executada add constraint operacao_executada_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL','PRESTACAO_DE_SANGRIA',
                      'CONTA_A_PAGAR_RELATADA','CONTA_PARCELADA_RELATADA','OPERACAO_ENTRE_EMPRESAS','CORRECAO_DE_CONTA'));
alter table mova.proposta drop constraint proposta_tipo_check;
alter table mova.proposta add constraint proposta_tipo_check
  check (tipo in ('BAIXA_DE_OBRIGACAO','DESPESA_PAGA','NOVA_OBRIGACAO','SOLICITACAO_DE_REVISAO','VINCULO_DE_DOCUMENTO','CONTA_RELATADA','INTERCOMPANY','CORRECAO_DE_CONTA'));
