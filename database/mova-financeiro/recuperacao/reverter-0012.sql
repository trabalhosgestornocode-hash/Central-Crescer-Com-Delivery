-- MOVA — RECUPERAÇÃO da 0012_mova_juros_documental (volta ao estado da 0011). Uma transação; aborta sem mudar nada se já
-- existir política ou operação JUROS_DOCUMENTAL (essas linhas não são apagadas por este arquivo: decidir antes).
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0012_mova_juros_documental.sql') then raise exception 'MOVA recuperação: 0012 não está aplicada — nada a desfazer'; end if;
  -- 0013 e 0014 (aplicadas antes da 0012 em produção) não tocam nas listas de operações: podem ficar.
  if exists (select 1 from mova.mova_migracao where nome > '0012_mova_juros_documental.sql' and nome not in ('0013_mova_entregadores_cadastro.sql', '0014_mova_unidade_sem_grupo.sql')) then raise exception 'MOVA recuperação: há migrações depois da 0012'; end if;
  if exists (select 1 from mova.politica_autonomia where operacao = 'JUROS_DOCUMENTAL') then raise exception 'MOVA recuperação: existe política JUROS_DOCUMENTAL — nada foi feito'; end if;
  if exists (select 1 from mova.operacao_executada where operacao = 'JUROS_DOCUMENTAL') then raise exception 'MOVA recuperação: existe operação JUROS_DOCUMENTAL — nada foi feito'; end if;
end $$;
alter table mova.politica_autonomia drop constraint politica_autonomia_operacao_check;
alter table mova.politica_autonomia add constraint politica_autonomia_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL'));
alter table mova.operacao_executada drop constraint operacao_executada_operacao_check;
alter table mova.operacao_executada add constraint operacao_executada_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL'));
delete from mova.mova_migracao where nome = '0012_mova_juros_documental.sql';
