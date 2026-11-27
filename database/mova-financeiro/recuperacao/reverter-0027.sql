-- Reversão da migração 0027 (fila com prioridade e limites configuráveis). Só rodar com o envio DESLIGADO.
-- Mensagens EXPIRADA voltam a FALHOU (o estado antigo mais próximo) antes de remover o valor do check.
begin;
update mova.resposta set estado = 'FALHOU', ultimo_erro = coalesce(ultimo_erro, 'EXPIRADA') where estado = 'EXPIRADA';
alter table mova.resposta drop constraint resposta_estado_check;
alter table mova.resposta add constraint resposta_estado_check check (estado in ('PENDENTE', 'ENVIANDO', 'ENVIADA', 'FALHOU', 'SUPRIMIDA'));
drop index if exists mova.resposta_fila_prioridade;
drop index if exists mova.resposta_envio_dia;
alter table mova.resposta drop column if exists categoria, drop column if exists prioridade, drop column if exists valida_ate,
  drop column if exists liberar_em, drop column if exists motivo_adiamento, drop column if exists adiamentos,
  drop column if exists organizacao_id, drop column if exists unidade_id;
-- As tabelas de limites e alertas guardam histórico/auditoria: são preservadas (renomeadas), nunca apagadas.
alter table mova.limite_envio rename to limite_envio_revertida_0027;
alter table mova.limite_envio_historico rename to limite_envio_historico_revertida_0027;
alter table mova.alerta_envio rename to alerta_envio_revertida_0027;
commit;
