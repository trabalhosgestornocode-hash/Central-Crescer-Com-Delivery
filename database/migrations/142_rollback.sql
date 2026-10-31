-- Rollback da 142: volta ao estado da 135 (sem EXECUTE para o service_role). Atenção: isso volta a impedir escrita em comunicacao_categorias pelo service_role.
begin;
revoke execute on function comunicacao_cota_valida(jsonb) from service_role;
commit;
