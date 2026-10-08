-- ROLLBACK da migration 109. NÃO aplicar sem autorização.
-- Remove só o registro de envios ao grupo interno (teste e relatório diário). Nenhuma outra tabela depende dela.
drop trigger if exists trg_comunicacao_envios_grupo_upd on comunicacao_envios_grupo;
drop table if exists comunicacao_envios_grupo;
drop function if exists comunicacao_envios_grupo_touch();
