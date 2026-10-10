-- Rollback da 114: devolve o corpo ORIGINAL de auth_unidade_ids() (migration 015/000). Atenção: ao reverter, a conta de
-- exibição volta a ser enxergada pelas policies de unidade — só reverta junto com a retirada do papel de exibição.
begin;
set local lock_timeout = '5s';
create or replace function public.auth_unidade_ids()
returns setof uuid
language sql stable security definer
set search_path to 'public'
as $$
  select unidade_id from usuarios_unidades
  where usuario_id = auth.uid() and ativo;
$$;
commit;
