-- MOVA CORE — 25/11/2026: orçamento RENOVÁVEL com controle POR TIPO DE USO (exige a 0018).
-- Aditiva: nenhum limite financeiro muda (continua US$ 10/mês, US$ 1/dia, US$ 0,10/solicitação, presos também no código).
--   * Parte do mesmo limite fica GUARDADA para leitura de documentos: a conversa nunca consome essa parte, então conversar
--     muito não impede o MOVA de ler um comprovante. Padrão: US$ 2 do mês e US$ 0,20 do dia (dentro dos US$ 10 / US$ 1).
--   * Limite RENOVÁVEL de chamadas de conversa por dia (substitui o teto acumulado de 500 chamadas): 300/dia, renova à meia-noite.
--   * Cada chamada registra o uso (CONVERSA ou DOCUMENTO); linhas antigas ficam nulas (= como era).
-- Nada é ligado aqui: a política continua `ativo = false` até a autorização, e o código só usa o renovável com
-- MOVA_ORCAMENTO_RENOVAVEL=1.

alter table mova.orcamento_ia_politica
  add column reserva_documentos_mensal_microusd bigint  not null default 2000000 check (reserva_documentos_mensal_microusd >= 0),
  add column reserva_documentos_diario_microusd bigint  not null default 200000  check (reserva_documentos_diario_microusd >= 0),
  add column limite_chamadas_conversa_diario   integer not null default 300     check (limite_chamadas_conversa_diario between 1 and 2000);

alter table mova.consumo_ia
  add column uso text check (uso is null or uso in ('CONVERSA', 'DOCUMENTO'));
