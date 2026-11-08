-- =====================================================================
-- 154 — Financeiro 2.0: ORIGEM DO PAGAMENTO (reconhecer a despesa sem inventar saída bancária).
-- NÃO APLICADA EM PRODUÇÃO (preparada e testada só em banco local descartável). Depende da 151.
--
-- Hoje todo pagamento exige uma conta financeira de saída. Dois casos documentados não têm saída bancária da empresa:
--   • 'origem_pendente' — a despesa foi paga e é reconhecida no resultado (pela data do pagamento), mas SE SAIU de qual conta ainda não se sabe
--     (ex.: um benefício pago sem que se saiba de qual conta). Nasce PROVISÓRIO (bloqueia o fechamento até ser resolvido) e NUNCA é conciliado
--     com extrato. Quando a conta for descoberta, resolve-se UMA vez: origem_pendente → conta.
--   • 'terceiro' — pago por terceiro (ex.: sócia pagou o fornecedor com a conta pessoal). Exige o terceiro e o vínculo com a DÍVIDA
--     (obrigação de reembolso). Não cria movimentação bancária da empresa e não altera o CMV (que é pela competência da obrigação).
-- Reconhecimento de despesa ≠ saída de caixa: pagamentos 'origem_pendente' e 'terceiro' não entram em saldos de conta nem em conciliação de saídas.
-- Idempotente. Rollback: 154_rollback.sql (recusa se houver pagamento fora de 'conta').
-- =====================================================================
begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.fin_pagamentos') is null or to_regclass('public.fin_dividas') is null or to_regclass('public.fin_conciliacao_saidas') is null then
    raise exception 'MIGRATION 154 abortada: requer as migrations 151 e 152 aplicadas.';
  end if;
end $$;

alter table fin_pagamentos alter column conta_id drop not null;
alter table fin_pagamentos add column if not exists origem_pagamento text not null default 'conta';
alter table fin_pagamentos add column if not exists terceiro_nome text;
alter table fin_pagamentos add column if not exists divida_id uuid references fin_dividas(id) on delete restrict;
alter table fin_pagamentos drop constraint if exists fin_pag_origem_valida;
alter table fin_pagamentos add constraint fin_pag_origem_valida check (origem_pagamento in ('conta', 'origem_pendente', 'terceiro'));
alter table fin_pagamentos drop constraint if exists fin_pag_origem_coerente;
alter table fin_pagamentos add constraint fin_pag_origem_coerente check (
  (origem_pagamento = 'conta' and conta_id is not null and terceiro_nome is null and divida_id is null)
  or (origem_pagamento = 'origem_pendente' and conta_id is null and terceiro_nome is null and divida_id is null)
  or (origem_pagamento = 'terceiro' and conta_id is null and divida_id is not null and length(btrim(coalesce(terceiro_nome, ''))) between 2 and 120));
alter table fin_pagamentos drop constraint if exists fin_pag_origem_documentada;
alter table fin_pagamentos add constraint fin_pag_origem_documentada check (origem_pagamento = 'conta' or length(btrim(coalesce(observacao, ''))) >= 10);   -- sem conta, a fonte do pagamento fica escrita
create index if not exists ix_fin_pagamentos_divida on fin_pagamentos (divida_id) where divida_id is not null;

-- Guarda: dívida do mesmo tenant e ativa; origem só muda de 'origem_pendente' para 'conta' (uma vez, com a conta informada); o resto é imutável.
create or replace function fin2_pagamentos_origem_guarda() returns trigger language plpgsql as $$
declare v_div fin_dividas;
begin
  if new.divida_id is not null then
    select * into v_div from fin_dividas d where d.id = new.divida_id for share;
    if v_div.id is null or v_div.organizacao_id <> new.organizacao_id or v_div.unidade_id <> new.unidade_id then
      raise exception 'fin_escopo_invalido: divida de outro tenant' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    if new.origem_pagamento is distinct from old.origem_pagamento then
      if not (old.origem_pagamento = 'origem_pendente' and new.origem_pagamento = 'conta' and new.conta_id is not null) then
        raise exception 'fin_campo_imutavel: a origem do pagamento so evolui de origem_pendente para conta (informando a conta)' using errcode = '23514';
      end if;
    elsif new.terceiro_nome is distinct from old.terceiro_nome or new.divida_id is distinct from old.divida_id then
      raise exception 'fin_campo_imutavel: terceiro e divida nao mudam (cancele o pagamento e registre outro)' using errcode = '23514';
    end if;
  elsif new.origem_pagamento = 'origem_pendente' and not new.provisorio then
    raise exception 'fin2_origem_pendente_provisorio: pagamento com origem pendente nasce provisorio' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists trg_fin_pagamentos_origem on fin_pagamentos;
create trigger trg_fin_pagamentos_origem before insert or update on fin_pagamentos for each row execute function fin2_pagamentos_origem_guarda();

-- Conciliação de saídas: só pagamento com conta (saída bancária da empresa). Os demais nunca são vinculados a extrato.
create or replace function fin2_conciliacao_origem_guarda() returns trigger language plpgsql as $$
declare v_origem text;
begin
  select origem_pagamento into v_origem from fin_pagamentos where id = new.pagamento_id;
  if coalesce(v_origem, 'conta') <> 'conta' then
    raise exception 'fin2_pagamento_sem_saida_bancaria: pagamento com origem pendente ou pago por terceiro nao e conciliado com extrato' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists trg_fin_conciliacao_saidas_origem on fin_conciliacao_saidas;
create trigger trg_fin_conciliacao_saidas_origem before insert on fin_conciliacao_saidas for each row execute function fin2_conciliacao_origem_guarda();

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function fin2_pagamentos_origem_guarda() from %I', r);
      execute format('revoke all on function fin2_conciliacao_origem_guarda() from %I', r);
    end if;
  end loop;
  execute 'revoke all on function fin2_pagamentos_origem_guarda() from public';
  execute 'revoke all on function fin2_conciliacao_origem_guarda() from public';
end $$;

-- Pós-condições
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'fin_pagamentos' and column_name = 'conta_id' and is_nullable = 'NO') then raise exception '154 pós-condição: conta_id ainda obrigatória'; end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_fin_pagamentos_origem') or not exists (select 1 from pg_trigger where tgname = 'trg_fin_conciliacao_saidas_origem') then raise exception '154 pós-condição: gatilhos ausentes'; end if;
end $$;
commit;
