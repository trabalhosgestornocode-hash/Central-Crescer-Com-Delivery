-- MOVA — REVERSÃO das propostas do MOVA CORE em PRODUÇÃO (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão). Uma transação.
-- Antes: MOVA_CORE_OPERACOES=DESLIGADO. As propostas não são dado financeiro (o Financeiro guarda o executado, com chave idempotente).
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0020_mova_core_propostas.sql') then raise exception 'MOVA reversão 0020: não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from mova.mova_migracao where left(nome, 4) not in ('0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008', '0009', '0010', '0011', '0012', '0013', '0014', '0015', '0016', '0017', '0018', '0022', '0020')) then raise exception 'MOVA reversão 0020: há migração fora do estado conhecido — nada foi feito'; end if;
  if exists (select 1 from mova.core_proposta where estado = 'EXECUTANDO') then raise exception 'MOVA reversão 0020: há proposta EXECUTANDO — aguarde o desfecho'; end if;
end $$;
drop table mova.core_proposta;
delete from mova.mova_migracao where nome = '0020_mova_core_propostas.sql';
