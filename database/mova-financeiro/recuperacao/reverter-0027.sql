-- MOVA — RECUPERAÇÃO da 0027_mova_correcao_de_conta (volta as listas fechadas de PROPOSTAS e EXECUÇÕES ao estado da 0025; a 0026 é da frente dos entregadores e não toca estas listas).
-- Uma transação; aborta sem mudar nada se já existir proposta ou execução de CORRECAO_DE_CONTA (o histórico nunca é apagado).
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0027_mova_correcao_de_conta.sql') then raise exception 'MOVA recuperação: 0027 não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from mova.operacao_executada where operacao = 'CORRECAO_DE_CONTA') then raise exception 'MOVA recuperação: existe correção de conta executada — nada foi feito'; end if;
  if exists (select 1 from mova.proposta where tipo = 'CORRECAO_DE_CONTA') then raise exception 'MOVA recuperação: existem propostas de correção de conta — nada foi feito'; end if;
end $$;
alter table mova.proposta drop constraint proposta_tipo_check;
alter table mova.proposta add constraint proposta_tipo_check
  check (tipo in ('BAIXA_DE_OBRIGACAO','DESPESA_PAGA','NOVA_OBRIGACAO','SOLICITACAO_DE_REVISAO','VINCULO_DE_DOCUMENTO','CONTA_RELATADA','INTERCOMPANY'));
alter table mova.operacao_executada drop constraint operacao_executada_operacao_check;
alter table mova.operacao_executada add constraint operacao_executada_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL','PRESTACAO_DE_SANGRIA',
                      'CONTA_A_PAGAR_RELATADA','CONTA_PARCELADA_RELATADA','OPERACAO_ENTRE_EMPRESAS'));
delete from mova.mova_migracao where nome = '0027_mova_correcao_de_conta.sql';
