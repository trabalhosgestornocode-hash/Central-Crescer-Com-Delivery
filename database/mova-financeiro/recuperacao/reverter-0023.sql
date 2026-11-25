-- MOVA — RECUPERAÇÃO da 0023_mova_politica_sangria (volta as listas fechadas ao estado da 0012). Uma transação; aborta sem mudar
-- nada se já existir política ou operação PRESTACAO_DE_SANGRIA (essas linhas não são apagadas por este arquivo: revogar antes).
-- As outras migrações não tocam nas listas de operações: podem ficar.
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0023_mova_politica_sangria.sql') then raise exception 'MOVA recuperação: 0023 não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from mova.politica_autonomia where operacao = 'PRESTACAO_DE_SANGRIA') then raise exception 'MOVA recuperação: existe política PRESTACAO_DE_SANGRIA (mesmo revogada) — nada foi feito'; end if;
  if exists (select 1 from mova.operacao_executada where operacao = 'PRESTACAO_DE_SANGRIA') then raise exception 'MOVA recuperação: existe operação PRESTACAO_DE_SANGRIA — nada foi feito'; end if;
end $$;
alter table mova.politica_autonomia drop constraint politica_autonomia_operacao_check;
alter table mova.politica_autonomia add constraint politica_autonomia_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL'));
alter table mova.operacao_executada drop constraint operacao_executada_operacao_check;
alter table mova.operacao_executada add constraint operacao_executada_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL'));
delete from mova.mova_migracao where nome = '0023_mova_politica_sangria.sql';
