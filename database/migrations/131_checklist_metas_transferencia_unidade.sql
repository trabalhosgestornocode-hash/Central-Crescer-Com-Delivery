-- 131 — Corrige a transferência/promoção de unidades quebrada pela 127 (metas do Checklist). Não altera a 127.
--
-- DEFEITO (reproduzido com a cadeia real da main em Postgres descartável — backend/testes-seguros/pg/transferencia_unidades.sh):
--   transferir_unidade_organizacao / promover_unidade_para_empresa chamam remapear_organizacao_em_tabelas_de_unidade (054, SECURITY
--   INVOKER), que executa, COMO service_role, "update <tabela> set organizacao_id = ... where unidade_id = ... and organizacao_id = ..."
--   em toda tabela com organizacao_id + unidade_id VISÍVEL ao papel em information_schema.columns. A 127 deu ao service_role só SELECT
--   em checklist_metas e checklist_metas_historico (visíveis, mas sem UPDATE) => "permission denied for table checklist_metas" e a
--   transferência inteira é desfeita, para QUALQUER unidade (mesmo sem metas). Além disso, os gatilhos da 127 proíbem qualquer troca de
--   organização (metas) e qualquer UPDATE (histórico).
--
-- CORREÇÃO MÍNIMA:
--   1. service_role recebe UPDATE SOMENTE na coluna organizacao_id das duas tabelas (nenhuma outra coluna, nenhum INSERT/DELETE);
--   2. checklist_metas_validar_tenant: a unidade nunca muda; a organização só pode mudar PARA A ORGANIZAÇÃO ATUAL DA UNIDADE (a checagem
--      unidade ∈ organização já existia) — ou seja, só acompanhando uma transferência/promoção já feita em `unidades`;
--   3. checklist_metas_historico_imutavel: continua somente inclusão (DELETE e qualquer alteração de conteúdo recusados); a única
--      exceção é trocar organizacao_id para a organização atual da unidade, com todas as outras colunas idênticas.
-- anon/authenticated continuam sem nenhum privilégio. A escrita de metas continua só pela função checklist_metas_salvar (127).
--
-- ORDEM: exige a 127. Se a 127 for reaplicada depois desta (ela recria as duas funções), reaplique a 131. Idempotente.
-- Rollback: 131_rollback.sql (volta o comportamento da 127 — e o defeito).

begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regclass('public.checklist_metas') is null or to_regclass('public.checklist_metas_historico') is null then
    raise exception '131: exige a migration 127 (checklist_metas e checklist_metas_historico ausentes)';
  end if;
end $$;

create or replace function checklist_metas_validar_tenant() returns trigger
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from unidades u where u.id = new.unidade_id and u.organizacao_id = new.organizacao_id) then
    raise exception 'checklist_metas: a unidade % não pertence à organização %', new.unidade_id, new.organizacao_id
      using errcode = '42501';
  end if;
  -- A unidade nunca muda. A organização só muda acompanhando a unidade (transferência/promoção): a checagem acima garante que a
  -- organização nova é a organização ATUAL da unidade — nenhuma linha pode ser movida para uma empresa que não é a da unidade.
  if tg_op = 'UPDATE' and new.unidade_id is distinct from old.unidade_id then
    raise exception 'checklist_metas: a unidade não muda' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function checklist_metas_historico_imutavel() returns trigger
language plpgsql set search_path = public as $$
begin
  -- Única exceção ao "somente inclusão": a transferência da unidade troca organizacao_id (para a organização atual da unidade) e nada mais.
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'organizacao_id') = (to_jsonb(old) - 'organizacao_id')
     and exists (select 1 from unidades u where u.id = new.unidade_id and u.organizacao_id = new.organizacao_id) then
    return new;
  end if;
  raise exception 'checklist_metas_historico é somente inclusão (%).', tg_op using errcode = '42501';
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant update (organizacao_id) on table checklist_metas to service_role;
    grant update (organizacao_id) on table checklist_metas_historico to service_role;
  end if;
end $$;

commit;

-- VERIFICAÇÃO (só leitura) — esperado: t | t | f | f | f
-- select has_column_privilege('service_role','checklist_metas','organizacao_id','UPDATE'),
--        has_column_privilege('service_role','checklist_metas_historico','organizacao_id','UPDATE'),
--        has_column_privilege('service_role','checklist_metas','preparo_meta_min','UPDATE'),
--        has_table_privilege('service_role','checklist_metas_historico','DELETE'),
--        has_table_privilege('authenticated','checklist_metas','SELECT');
