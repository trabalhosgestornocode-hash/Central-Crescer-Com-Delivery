-- MOVA — 24/11/2026: contexto CURTO da conversa para perguntas de acompanhamento ("e na Subway?", "só as vencidas").
-- Guarda apenas o RECORTE da última consulta (período e, quando houver, o filtro de fornecedor/categoria) por participante e conversa, no mesmo
-- registro de continuidade que já expira em minutos. Nunca o texto da mensagem, valores ou documentos. Coluna nula = como era.
alter table mova.conversa_ativa add column contexto jsonb check (contexto is null or (jsonb_typeof(contexto) = 'object' and pg_column_size(contexto) <= 512));
