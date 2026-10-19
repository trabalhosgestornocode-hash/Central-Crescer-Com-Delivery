-- T3 COMPARTILHADO — encerramento (A6). Só roda pelo t3c.mjs (passo "encerrar"), dentro do embrulho (transação + conferência da allowlist).
-- SEM rollback de migration e SEM apagar dados financeiros (imutáveis por desenho): desabilita o módulo e inativa as organizações/unidades [T3-FIN].
-- O esquema financeiro fica no banco, inerte: nenhuma empresa real tem o módulo, nenhuma concessão existe, a flag de concessões segue desligada.
delete from public.unidade_modulos
 where modulo_id = 'gestao_financeira'
   and unidade_id in (select id from public.unidades where organizacao_id in ('00000000-0000-0000-0000-0000000f1a01', '00000000-0000-0000-0000-0000000f1a02'));
delete from public.organizacao_modulos
 where modulo_id = 'gestao_financeira' and organizacao_id in ('00000000-0000-0000-0000-0000000f1a01', '00000000-0000-0000-0000-0000000f1a02');
update public.unidades set ativo = false where organizacao_id in ('00000000-0000-0000-0000-0000000f1a01', '00000000-0000-0000-0000-0000000f1a02');
update public.organizacoes set ativo = false where id in ('00000000-0000-0000-0000-0000000f1a01', '00000000-0000-0000-0000-0000000f1a02');
do $encerrar$
begin
  if exists (select 1 from public.organizacao_modulos where modulo_id = 'gestao_financeira')
     or exists (select 1 from public.unidade_modulos where modulo_id = 'gestao_financeira') then
    raise exception 'ENCERRAMENTO: o módulo financeiro continua habilitado em algum lugar — nada foi gravado';
  end if;
  if exists (select 1 from public.gestao_financeira_concessoes where revogada_em is null) then
    raise exception 'ENCERRAMENTO: há concessão financeira ativa — revogue pela rotina própria antes de encerrar';
  end if;
  raise notice 'PASS  encerramento: módulo desabilitado em todo o banco; organizações e unidades [T3-FIN] inativas; dados financeiros preservados (inertes)';
end $encerrar$;
