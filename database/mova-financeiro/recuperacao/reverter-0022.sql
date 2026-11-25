-- MOVA — RECUPERAÇÃO da 0022_mova_orcamento_uso (remove a parte guardada para documentos, o limite de chamadas de conversa
-- por dia e o tipo de uso do consumo). Uma transação. Com a política renovável ATIVA, aborta: desligue antes
-- (MOVA_ORCAMENTO_RENOVAVEL ausente e `update mova.orcamento_ia_politica set ativo = false`). O consumo (custos) fica.
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0022_mova_orcamento_uso.sql') then raise exception 'MOVA recuperação: 0022 não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from mova.mova_migracao where nome > '0022_mova_orcamento_uso.sql') then raise exception 'MOVA recuperação: há migrações depois da 0022'; end if;
  if exists (select 1 from mova.orcamento_ia_politica where ativo) then raise exception 'MOVA recuperação: a política renovável está ATIVA — desligue antes'; end if;
end $$;
alter table mova.consumo_ia drop column uso;
alter table mova.orcamento_ia_politica drop column reserva_documentos_mensal_microusd, drop column reserva_documentos_diario_microusd, drop column limite_chamadas_conversa_diario;
delete from mova.mova_migracao where nome = '0022_mova_orcamento_uso.sql';
