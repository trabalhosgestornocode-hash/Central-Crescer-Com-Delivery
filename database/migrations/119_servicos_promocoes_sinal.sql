-- =====================================================================
-- 119 — Dashboard iFood: Serviços e Promoções pode ser CRÉDITO (negativo)
-- =====================================================================
-- O extrato do iFood às vezes traz "Serviços e promoções" a favor da loja
-- (ex.: promoção custeada pelo iFood). O formulário ganhou um seletor
-- (+)/(−); a coluna CONTINUA significando "custo":
--
--   (−) custo / desconto  -> grava  +valor   (como sempre foi)
--   (+) crédito à loja    -> grava  −valor
--
-- Assim `totalDeducoes`/`receitaLiquida` (calc.js) seguem iguais: um valor
-- negativo reduz as deduções e aumenta a receita líquida. Nenhum lançamento
-- histórico muda — todos já são >= 0 e continuam significando custo.
--
-- Remove SÓ os CHECK de coluna única `servicos_promocoes >= 0` das duas
-- tabelas (linha consolidada e por canal). Constraints de várias colunas
-- (ex.: lfc_nao_informado_sem_valores) e os demais campos ficam intactos.
-- Busca por pg_constraint porque o CHECK da 108 foi criado inline (nome
-- gerado pelo Postgres).
--
-- Idempotente. Rollback: 119_rollback.sql.

do $$
declare
  r record;
begin
  for r in
    select c.conrelid::regclass as tabela, c.conname
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'c'
       and c.conrelid in ('public.lancamentos_financeiros_diarios'::regclass, 'public.lancamentos_financeiros_canais'::regclass)
       and array_length(c.conkey, 1) = 1
       and a.attname = 'servicos_promocoes'
  loop
    execute format('alter table %s drop constraint %I', r.tabela, r.conname);
  end loop;
end $$;

comment on column lancamentos_financeiros_diarios.servicos_promocoes is
  'Acumulado do mês. Positivo = custo (dedução); negativo = crédito a favor da loja (seletor + no formulário). Ver migration 119.';
comment on column lancamentos_financeiros_canais.servicos_promocoes is
  'Acumulado do mês no canal. Positivo = custo (dedução); negativo = crédito a favor da loja. Ver migration 119.';
