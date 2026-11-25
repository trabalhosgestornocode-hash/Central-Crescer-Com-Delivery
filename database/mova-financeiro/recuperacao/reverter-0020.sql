-- MOVA — RECUPERAÇÃO da 0020_mova_core_propostas (remove as propostas do MOVA CORE). Uma transação.
-- Só ANTES de qualquer proposta em andamento: com proposta EXECUTANDO, aborta (o desfecho real precisa ser gravado antes).
-- As propostas não são dado financeiro (o Financeiro guarda o que foi executado, com a chave idempotente na fonte).
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0020_mova_core_propostas.sql') then raise exception 'MOVA recuperação: 0020 não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from mova.mova_migracao where nome > '0020_mova_core_propostas.sql') then raise exception 'MOVA recuperação: há migrações depois da 0020'; end if;
  if exists (select 1 from mova.core_proposta where estado = 'EXECUTANDO') then raise exception 'MOVA recuperação: há proposta EXECUTANDO — aguarde o desfecho'; end if;
end $$;
drop table mova.core_proposta;
delete from mova.mova_migracao where nome = '0020_mova_core_propostas.sql';
