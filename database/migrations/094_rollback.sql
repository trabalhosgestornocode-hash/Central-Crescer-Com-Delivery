-- Rollback da MIGRATION 094 (primeiro aviso tardio D-1). Mensagens já criadas permanecem como linhas normais.
drop function if exists comunicacao_agendar_aviso_tardio_d1(uuid, text, text, timestamptz, timestamptz, integer);
notify pgrst, 'reload schema';
