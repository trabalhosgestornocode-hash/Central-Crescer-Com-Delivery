-- MOVA — RECUPERAÇÃO da 0025_mova_contas_relatadas_intercompany_avisos (volta as listas fechadas ao estado da 0023 e remove a tabela
-- de avisos diários). Uma transação; aborta sem mudar nada se já existir política ou operação das novas operações (revogar antes).
-- A tabela mova.aviso_diario só guarda metadados de envio (contagens/totais): removê-la apaga esse histórico — exportar antes, se preciso.
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0025_mova_contas_relatadas_intercompany_avisos.sql') then raise exception 'MOVA recuperação: 0025 não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from mova.politica_autonomia where operacao in ('CONTA_A_PAGAR_RELATADA', 'CONTA_PARCELADA_RELATADA', 'OPERACAO_ENTRE_EMPRESAS')) then raise exception 'MOVA recuperação: existe política das operações da 0025 (mesmo revogada) — nada foi feito'; end if;
  if exists (select 1 from mova.operacao_executada where operacao in ('CONTA_A_PAGAR_RELATADA', 'CONTA_PARCELADA_RELATADA', 'OPERACAO_ENTRE_EMPRESAS')) then raise exception 'MOVA recuperação: existe operação executada da 0025 — nada foi feito'; end if;
  if exists (select 1 from mova.proposta where tipo in ('CONTA_RELATADA', 'INTERCOMPANY')) then raise exception 'MOVA recuperação: existem propostas dos tipos da 0025 — nada foi feito'; end if;
end $$;
drop table mova.aviso_diario;
alter table mova.proposta drop constraint proposta_tipo_check;
alter table mova.proposta add constraint proposta_tipo_check
  check (tipo in ('BAIXA_DE_OBRIGACAO','DESPESA_PAGA','NOVA_OBRIGACAO','SOLICITACAO_DE_REVISAO','VINCULO_DE_DOCUMENTO'));
alter table mova.politica_autonomia drop constraint politica_autonomia_operacao_check;
alter table mova.politica_autonomia add constraint politica_autonomia_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL','PRESTACAO_DE_SANGRIA'));
alter table mova.operacao_executada drop constraint operacao_executada_operacao_check;
alter table mova.operacao_executada add constraint operacao_executada_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL','PRESTACAO_DE_SANGRIA'));
delete from mova.mova_migracao where nome = '0025_mova_contas_relatadas_intercompany_avisos.sql';
