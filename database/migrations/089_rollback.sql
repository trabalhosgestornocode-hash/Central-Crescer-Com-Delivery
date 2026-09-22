-- ROLLBACK da migration 089. Remove apenas o que a 089 criou (trigger, função, índice,
-- constraint e a coluna vigencia_inicio). A tabela e as linhas de auditoria da 024 NÃO são
-- tocadas. ATENÇÃO: descartar a coluna apaga as datas de vigência já registradas — a partir
-- daí toda a história volta a ser lida pelo modelo ATUAL da unidade (comportamento pré-089).
-- Reverta o deploy do backend ANTES (o backend da 089 lê/escreve vigencia_inicio).
begin;
drop trigger if exists trg_umlh_valida_vigencia on unidade_modelo_logistico_historico;
drop function if exists umlh_valida_vigencia();
drop index if exists uq_umlh_unidade_vigencia;
alter table unidade_modelo_logistico_historico drop constraint if exists umlh_vigencia_troca_real;
alter table unidade_modelo_logistico_historico drop column if exists vigencia_inicio;
commit;
