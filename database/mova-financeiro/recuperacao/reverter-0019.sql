-- MOVA — RECUPERAÇÃO da 0019_mova_core_identidade_memoria (remove vínculo, desafios, tentativas e memória do MOVA CORE).
-- Uma transação. Só ANTES de qualquer vínculo real: com vínculo ATIVO, aborta (revogue antes — a revogação fica registrada
-- na auditoria do serviço). A memória do fio é contexto, não dado financeiro: some junto.
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0019_mova_core_identidade_memoria.sql') then raise exception 'MOVA recuperação: 0019 não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from mova.mova_migracao where nome > '0019_mova_core_identidade_memoria.sql') then raise exception 'MOVA recuperação: há migrações depois da 0019'; end if;
  if exists (select 1 from mova.core_vinculo where estado = 'ATIVO') then raise exception 'MOVA recuperação: há vínculo ATIVO — revogue antes'; end if;
end $$;
drop table mova.core_memoria_conversa;
drop table mova.core_tentativa_vinculo;
drop table mova.core_desafio_vinculo;
drop table mova.core_vinculo;
delete from mova.mova_migracao where nome = '0019_mova_core_identidade_memoria.sql';
