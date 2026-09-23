-- Rollback da MIGRATION 093 (habilitação atômica da organização piloto). Não altera dados: organizações já habilitadas continuam habilitadas.
drop function if exists comunicacao_habilitar_organizacao_piloto(uuid, uuid);
notify pgrst, 'reload schema';
