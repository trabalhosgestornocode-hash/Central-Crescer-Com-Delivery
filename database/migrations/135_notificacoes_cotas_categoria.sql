-- 135 — D-9: cotas INDEPENDENTES por categoria nova. As cotas do D-1 (comunicacao_reservar_envio, `limites`, cooldowns,
-- limite_diario_org) NÃO são alteradas: `pendencia_d1` fica com `cota = NULL` (segue exatamente a regra atual).
--
-- Nesta versão as categorias novas só existem em SIMULAÇÃO: a simulação grava em `operacional_mensagens_simuladas` (130) — nunca
-- em `comunicacao_mensagens` — então não entra na fila do D-1, não consome cota real e o worker do D-1 nunca a vê.
-- `comunicacao_cota_categoria_disponivel` é SÓ LEITURA: conta apenas envios REAIS da categoria (comunicacao_mensagens do tipo dela),
-- e serve para a prévia da simulação dizer se o envio caberia na cota. A reserva consumidora para envio real fica para a Etapa 6
-- (exige fila própria das categorias novas — ver docs/configuracoes-2-notificacoes/11 §5).
-- Rollback: 135_rollback.sql.

begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regclass('public.comunicacao_categorias') is null
     or not exists (select 1 from information_schema.columns where table_name = 'comunicacao_categorias' and column_name = 'estado') then
    raise exception '135: exige a migration 133';
  end if;
end $$;

alter table comunicacao_categorias add column if not exists cota jsonb;
comment on column comunicacao_categorias.cota is
  'D-9: cota própria da categoria nova {"por_destinatario_dia":n,"por_unidade_dia":n,"por_empresa_dia":n}. NULL em pendencia_d1 (o D-1 segue a regra atual, intacta).';

create or replace function comunicacao_cota_valida(p jsonb) returns boolean
language sql immutable set search_path = public as $$
  select p is null or (jsonb_typeof(p) = 'object'
    and (p ? 'por_destinatario_dia') and (p ? 'por_unidade_dia') and (p ? 'por_empresa_dia')
    and (p->>'por_destinatario_dia') ~ '^[1-9][0-9]{0,3}$' and (p->>'por_unidade_dia') ~ '^[1-9][0-9]{0,4}$'
    and (p->>'por_empresa_dia') ~ '^[1-9][0-9]{0,5}$');
$$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'comunicacao_categorias_cota_valida') then
    alter table comunicacao_categorias add constraint comunicacao_categorias_cota_valida check (comunicacao_cota_valida(cota));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'comunicacao_categorias_d1_sem_cota_propria') then
    alter table comunicacao_categorias add constraint comunicacao_categorias_d1_sem_cota_propria check (codigo <> 'pendencia_d1' or cota is null);
  end if;
end $$;

update comunicacao_categorias set cota = '{"por_destinatario_dia": 2, "por_unidade_dia": 20, "por_empresa_dia": 100}'::jsonb
 where codigo <> 'pendencia_d1' and cota is null;

/** Só leitura: a categoria ainda cabe na cota hoje? Conta só envios REAIS (não simulados) do tipo da categoria. */
create or replace function comunicacao_cota_categoria_disponivel(p_categoria text, p_contato_empresa_id uuid, p_unidade_id uuid,
  p_organizacao_id uuid, p_inicio_dia timestamptz) returns jsonb
language sql stable security invoker set search_path = public as $$
  with cat as (select tipo_alerta, cota from comunicacao_categorias where codigo = p_categoria),
  envios as (
    select m.contato_empresa_id, m.unidade_id, m.organizacao_id from comunicacao_mensagens m, cat
     where m.tipo = cat.tipo_alerta and m.organizacao_id = p_organizacao_id and m.direcao = 'saida'
       and m.status in ('SENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN') and coalesce(m.enviado_em, m.created_at) >= p_inicio_dia)
  select case
    when (select cota from cat) is null then jsonb_build_object('disponivel', false, 'motivo', 'CATEGORIA_SEM_COTA_PROPRIA')
    when (select count(*) from envios where contato_empresa_id = p_contato_empresa_id) >= ((select cota from cat)->>'por_destinatario_dia')::int
      then jsonb_build_object('disponivel', false, 'motivo', 'COTA_DESTINATARIO')
    when (select count(*) from envios where unidade_id = p_unidade_id) >= ((select cota from cat)->>'por_unidade_dia')::int
      then jsonb_build_object('disponivel', false, 'motivo', 'COTA_UNIDADE')
    when (select count(*) from envios) >= ((select cota from cat)->>'por_empresa_dia')::int
      then jsonb_build_object('disponivel', false, 'motivo', 'COTA_EMPRESA')
    else jsonb_build_object('disponivel', true, 'motivo', null) end;
$$;

do $$ declare papel text; begin
  foreach papel in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if papel = 'public' or exists (select 1 from pg_roles where rolname = papel) then
      execute format('revoke all on function comunicacao_cota_categoria_disponivel(text,uuid,uuid,uuid,timestamptz) from %s', papel);
      execute format('revoke all on function comunicacao_cota_valida(jsonb) from %s', papel);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function comunicacao_cota_categoria_disponivel(text,uuid,uuid,uuid,timestamptz) to service_role;
  end if;
end $$;

commit;
