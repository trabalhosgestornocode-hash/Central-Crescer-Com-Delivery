-- Rollback da 151 (Financeiro 2.0). RECUSA se houver QUALQUER dado nas tabelas novas ou concessão com os níveis novos: nada de perda silenciosa.
-- Restaura a lista de tabelas por unidade da 120 e o domínio de níveis original. Idempotente.
begin;
set local lock_timeout = '5s';
do $$
declare n bigint := 0;
begin
  if to_regclass('public.fin_conciliacao_saidas') is not null then select n + count(*) into n from fin_conciliacao_saidas; end if;
  if to_regclass('public.fin_pagamentos') is not null then select n + count(*) into n from fin_pagamentos; end if;
  if to_regclass('public.fin_obrigacoes') is not null then select n + count(*) into n from fin_obrigacoes; end if;
  if to_regclass('public.fin_fornecedores') is not null then select n + count(*) into n from fin_fornecedores; end if;
  if n > 0 then raise exception 'ROLLBACK 151 recusado: ha % registro(s) de contas a pagar/conciliacao de saidas. Exporte e decida antes.', n; end if;
  if exists (select 1 from public.gestao_financeira_concessoes where nivel in ('contador', 'administrador')) then
    raise exception 'ROLLBACK 151 recusado: ha concessoes com nivel contador/administrador. Revogue/altere antes.';
  end if;
end $$;

drop trigger if exists trg_fin2_lancamentos_vinculo_saida on fin_lancamentos;
drop trigger if exists trg_fin2_periodos_bloqueia_fechamento on fin_periodos;
drop function if exists fin_conciliacao_saida_confirmar(uuid,uuid,uuid,uuid,text);
drop function if exists fin_conciliacao_saida_revogar(uuid,uuid,uuid,uuid,text);
drop function if exists fin_obrigacao_quitar(uuid,uuid,uuid,uuid);
drop function if exists fin_obrigacao_desfazer_quitacao(uuid,uuid,uuid,uuid,text);
drop function if exists fin_obrigacao_classificar(uuid,uuid,uuid,uuid,text);
drop function if exists fin_obrigacao_confirmar_registro(uuid,uuid,uuid,uuid);
drop function if exists fin_obrigacao_cancelar(uuid,uuid,uuid,uuid,text);
drop function if exists fin2_obter_obrigacao_para_alterar(uuid,uuid,uuid);
drop function if exists fin2_bloqueios_fechamento(uuid,uuid,date);

drop table if exists fin_conciliacao_saidas;
drop table if exists fin_pagamentos;
drop table if exists fin_obrigacoes;
drop table if exists fin_fornecedores;
-- funções de gatilho e auxiliares: só depois das tabelas (os gatilhos dependem delas); as que RETORNAM o tipo da tabela já saíram antes
drop function if exists fin2_periodos_bloqueia_fechamento();
drop function if exists fin2_lancamentos_vinculo_saida();
drop function if exists fin_conciliacao_saidas_guarda();
drop function if exists fin_pagamentos_guarda();
drop function if exists fin_obrigacoes_guarda();
drop function if exists fin_fornecedores_guarda();
drop function if exists fin2_travar_meses(uuid,uuid,date[]);
drop function if exists fin2_tolerancia_centavos();
drop function if exists fin2_tolerancia_dias();
-- guarda de transferência: corpo ORIGINAL da 120 (copiado literalmente)
create or replace function public.gestao_financeira_verificar_unidade_transferivel(p_unidade_id uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_tabela text; v_oid regclass; v_qtd bigint; v_achados text := ''; v_ignora_rls boolean;
  v_rotulo constant jsonb := jsonb_build_object(
    'gestao_financeira_concessoes', 'concessões de acesso', 'gestao_financeira_concessoes_auditoria', 'auditoria de concessões',
    'fin_contas', 'contas', 'fin_saldos_abertura', 'saldos de abertura', 'fin_lancamentos', 'lançamentos',
    'fin_transferencias', 'transferências', 'fin_periodos', 'períodos', 'fin_importacoes', 'importações',
    'fin_auditoria', 'auditoria financeira', 'fin_referencias', 'referências de conciliação',
    'fin_conciliacao_resolucoes', 'resoluções de conciliação', 'fin_sangria_excecoes', 'exceções de sangria',
    'fin_excecoes_fechamento', 'exceções de fechamento');
begin
  if p_unidade_id is null then
    raise exception 'Unidade não informada.' using errcode = '22023';
  end if;
  -- A contagem abaixo precisa de um snapshot NOVO (tirado depois da trava): só READ COMMITTED garante isso dentro da transação.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Transferência/promoção de unidade exige isolamento READ COMMITTED (atual: %). Nada foi alterado.',
      current_setting('transaction_isolation') using errcode = '25001';
  end if;
  perform 1 from public.unidades where id = p_unidade_id for update;
  select r.rolsuper or r.rolbypassrls into v_ignora_rls from pg_roles r where r.rolname = current_user;
  foreach v_tabela in array public.gestao_financeira_tabelas_da_unidade() loop
    v_oid := to_regclass('public.' || v_tabela);
    continue when v_oid is null;
    if not has_table_privilege(current_user, v_oid, 'select')
       or exists (select 1 from pg_class c where c.oid = v_oid and c.relrowsecurity and not coalesce(v_ignora_rls, false)
                    and (c.relforcerowsecurity or not pg_has_role(current_user, c.relowner, 'USAGE'))) then
      raise exception 'Não foi possível verificar o histórico financeiro da unidade (o papel % não lê % por inteiro). Nada foi alterado.',
        current_user, v_tabela using errcode = '42501';
    end if;
    execute format('select count(*) from public.%I where unidade_id = $1', v_tabela) into v_qtd using p_unidade_id;
    if v_qtd > 0 then
      v_achados := v_achados || case when v_achados = '' then '' else ', ' end || (v_rotulo ->> v_tabela) || ': ' || v_qtd;
    end if;
  end loop;
  if v_achados <> '' then
    raise exception 'Esta unidade possui registros no Financeiro (%) e não pode ser transferida nem promovida: o histórico financeiro pertence à empresa atual e não muda de empresa. Nada foi alterado.', v_achados
      using errcode = '22023';
  end if;
end $$;

create or replace function public.gestao_financeira_tabelas_da_unidade() returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array[
    'gestao_financeira_concessoes', 'gestao_financeira_concessoes_auditoria',                                     -- 120
    'fin_contas', 'fin_saldos_abertura', 'fin_lancamentos', 'fin_transferencias', 'fin_periodos', 'fin_importacoes',
    'fin_auditoria',                                                                                              -- 121
    'fin_referencias', 'fin_conciliacao_resolucoes', 'fin_sangria_excecoes', 'fin_excecoes_fechamento'            -- 122
  ]::text[]
$$;

do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.gestao_financeira_concessoes'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%nivel%' loop
    execute format('alter table public.gestao_financeira_concessoes drop constraint %I', c.conname);
  end loop;
  alter table public.gestao_financeira_concessoes add constraint gestao_financeira_concessoes_nivel_check check (nivel in ('leitura', 'operador', 'gestor'));
end $$;
-- (revisão #13) depois de restaurar a lista da 120, nenhuma tabela financeira com unidade_id pode ficar FORA dela (uma migration posterior pode
-- ter acrescentado tabelas; a lista restaurada as tiraria da guarda de transferência). Se houver, o rollback inteiro é desfeito.
do $$
declare v_fora text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into v_fora
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and (c.relname like 'fin\_%' or c.relname like 'gestao\_financeira\_%')
     and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'unidade_id' and a.attnum > 0 and not a.attisdropped)
     and c.relname::text <> all (public.gestao_financeira_tabelas_da_unidade());
  if v_fora is not null then raise exception 'ROLLBACK 151 abortado: tabelas financeiras ficariam fora da guarda de transferencia: %', v_fora; end if;
end $$;
commit;
