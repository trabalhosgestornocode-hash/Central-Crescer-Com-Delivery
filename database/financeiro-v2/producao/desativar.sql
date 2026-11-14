-- Financeiro v2 — DESATIVAÇÃO NÃO DESTRUTIVA. Nada é apagado: dados, tabelas, funções e histórico ficam.
-- 1) A liberação por unidade é desligada pela própria aplicação (fv2_liberacao_alterar, com a autoridade).
-- 2) Este arquivo corta o acesso dos papéis de conexão do módulo (se existirem) e o uso do schema.
do $$ declare r text; begin
  for r in select rolname from pg_roles where rolname like 'fv2\_%' and rolcanlogin loop
    execute format('alter role %I nologin', r);
  end loop;
end $$;
revoke usage on schema financeiro_v2 from fv2_app, fv2_autoridade;
-- Reativar: grant usage on schema financeiro_v2 to fv2_app, fv2_autoridade; alter role <papel de conexão> login;
