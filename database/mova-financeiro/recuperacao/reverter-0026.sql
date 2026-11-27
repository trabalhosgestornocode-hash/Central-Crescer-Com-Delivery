-- MOVA — RECUPERAÇÃO da 0026_mova_entregador_notificacoes_pagamento (notificação automática de pagamento + métricas do atendimento privado).
-- Uma transação; aborta sem mudar nada se a automação ENTREGADORES_PAGAMENTO existir (remover antes) ou se houver notificação gravada.
-- As tabelas guardam só o histórico de avisos e contagens do atendimento: removê-las apaga esse histórico — exportar antes, se preciso.
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0026_mova_entregador_notificacoes_pagamento.sql') then raise exception 'MOVA recuperação: 0026 não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from mova.automacao where nome = 'ENTREGADORES_PAGAMENTO') then raise exception 'MOVA recuperação: existe automação ENTREGADORES_PAGAMENTO (mesmo desligada) — nada foi feito'; end if;
  if exists (select 1 from mova.notificacao_pagamento) then raise exception 'MOVA recuperação: existem notificações de pagamento gravadas — exportar antes de desfazer'; end if;
end $$;
drop table mova.notificacao_pagamento_item;
drop table mova.notificacao_pagamento;
drop table mova.pagamento_marco;
drop table mova.atendimento_metrica;
alter table mova.automacao drop constraint automacao_nome_check;
alter table mova.automacao add constraint automacao_nome_check check (nome in ('ENTREGADORES_SEMANAL', 'ENTREGADORES_COBRANCA', 'RECONFERENCIA_EXTRATO', 'ENTREGADORES_RELATORIO', 'ENTREGADORES_AVISO_GRUPO'));
delete from mova.mova_migracao where nome = '0026_mova_entregador_notificacoes_pagamento.sql';
