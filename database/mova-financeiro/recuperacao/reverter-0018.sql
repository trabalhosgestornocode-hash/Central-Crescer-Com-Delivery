-- MOVA — RECUPERAÇÃO da 0018_mova_orcamento_renovavel (remove a política renovável, os alertas e as dimensões novas do consumo).
-- Uma transação. ATENÇÃO: apaga as colunas de dimensão do consumo (unidade, requisição, cache) — o custo e o total acumulado ficam.
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0018_mova_orcamento_renovavel.sql') then raise exception 'MOVA recuperação: 0018 não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from mova.mova_migracao where nome > '0018_mova_orcamento_renovavel.sql') then raise exception 'MOVA recuperação: há migrações depois da 0018'; end if;
  if exists (select 1 from mova.orcamento_ia_politica where ativo) then raise exception 'MOVA recuperação: a política renovável está ATIVA — desligue antes'; end if;
end $$;
drop table mova.orcamento_ia_alerta;
drop table mova.orcamento_ia_politica;
drop index mova.consumo_ia_em_idx;
drop index mova.consumo_ia_requisicao_idx;
alter table mova.consumo_ia drop column organizacao_id, drop column unidade_id, drop column requisicao_id, drop column cache_leitura, drop column cache_escrita, drop column regime;
delete from mova.mova_migracao where nome = '0018_mova_orcamento_renovavel.sql';
