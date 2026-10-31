-- 142 — Privilégio mínimo de `comunicacao_cota_valida(jsonb)`.
--
-- A 135 revogou o EXECUTE de todos os papéis nesta função, mas ela é usada no CHECK `comunicacao_categorias_cota_valida`: o PostgreSQL avalia o
-- CHECK com os privilégios de quem escreve, então QUALQUER insert/update em `comunicacao_categorias` pelo `service_role` falha com
-- "permission denied for function comunicacao_cota_valida". Correção MÍNIMA: devolver EXECUTE somente ao `service_role` (o único papel que escreve
-- na tabela). A função é pura (valida o formato de um jsonb), sem acesso a dados. anon/authenticated/public continuam SEM acesso.
-- Não altera dados, constraint, tabela nem outra função. Rollback: 142_rollback.sql.
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regprocedure('public.comunicacao_cota_valida(jsonb)') is null then raise exception '142: exige a migration 135'; end if;
end $$;
grant execute on function comunicacao_cota_valida(jsonb) to service_role;
do $$
begin
  if has_function_privilege('anon', 'public.comunicacao_cota_valida(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.comunicacao_cota_valida(jsonb)', 'execute') then
    raise exception '142: anon/authenticated não podem executar comunicacao_cota_valida';
  end if;
  if not has_function_privilege('service_role', 'public.comunicacao_cota_valida(jsonb)', 'execute') then
    raise exception '142: service_role deveria poder executar comunicacao_cota_valida';
  end if;
end $$;
commit;
