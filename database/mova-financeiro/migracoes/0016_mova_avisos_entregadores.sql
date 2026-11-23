-- MOVA — 23/11/2026: avisos à GERÊNCIA no grupo da própria unidade, depois de cada envio privado de demonstrativo
-- (AVISO_DEMONSTRATIVO) e de cada nota fiscal recebida e conferida (AVISO_NOTA_RECEBIDA). Só amplia a lista fechada de
-- tipos de mova.entregador_envio (a chave única continua impedindo repetição). Nenhuma automação é ligada aqui: os avisos
-- só saem com ENTREGADORES_AVISO_GRUPO ativa na unidade e grupo exclusivo dela (sem grupo ⇒ pendente, nunca outro grupo).
-- (0015 é reservada ao PR #191.)
-- O aviso do demonstrativo só sai DEPOIS que o WhatsApp aceitou a mensagem privada (estado ENVIADA da mova.resposta): o envio
-- guarda o id da mensagem que gerou (resposta_id). O app só pode preencher esse vínculo uma vez (coluna nula ⇒ id).
alter table mova.entregador_envio drop constraint entregador_envio_tipo_check;
alter table mova.entregador_envio add constraint entregador_envio_tipo_check check (tipo in ('SEMANAL', 'COBRANCA_NOTA', 'NOTA_RECEBIDA', 'AVISO_LIBERACAO', 'RELATORIO_QUARTA', 'AVISO_DEMONSTRATIVO', 'AVISO_NOTA_RECEBIDA'));
alter table mova.entregador_envio add column resposta_id uuid references mova.resposta (id);
grant update (resposta_id) on mova.entregador_envio to mova_app;
