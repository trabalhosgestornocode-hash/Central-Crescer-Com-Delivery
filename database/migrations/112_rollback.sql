-- Rollback da 112. O Postgres NÃO remove valores de enum: o valor 'display_operator' permanece no tipo (inofensivo).
-- O que este arquivo faz é GARANTIR que ninguém ficou com o papel — se alguém tem, aborta e diz quem precisa mudar.
-- Depois disso, reverter o deploy do código desativa o papel de fato (o enum nunca é consultado sem o código).
-- (Compara por texto: com o valor ausente, a comparação direta com o enum daria erro de tipo.)
do $$
declare
  v_unidades integer;
  v_orgs integer;
begin
  select count(*) into v_unidades from usuarios_unidades where papel::text = 'display_operator';
  select count(*) into v_orgs from usuarios_organizacoes where papel::text = 'display_operator';
  if v_unidades + v_orgs > 0 then
    raise exception 'ROLLBACK 112 abortado: % vínculo(s) de unidade e % de empresa ainda usam o papel display_operator. Remova ou troque o papel antes.', v_unidades, v_orgs;
  end if;
  raise notice 'Nenhum vínculo usa display_operator. O valor permanece no enum papel_acesso (o Postgres não remove valores de enum).';
end $$;
