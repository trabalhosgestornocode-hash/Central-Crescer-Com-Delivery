-- 139 — Piloto da Central: trava de convites por UNIDADE, também no banco (defesa em profundidade; o backend valida antes).
--
-- Fonte única: a chave `convites_unidades_piloto` de `comunicacao_configuracoes` (jsonb = array de ids de unidade).
--   * chave AUSENTE  → sem restrição (estado geral; quem exige o piloto é o backend, fail-closed por padrão);
--   * chave presente → TODA unidade de um convite novo precisa estar na lista; lista vazia ou formato inválido = ninguém (fail-closed).
-- A migration NÃO insere a chave: ligar o piloto é um ato de dados com autorização própria. Não toca no D-1, em cotas, destinatários,
-- consentimentos, nem em convites já existentes (só INSERT). Rollback: 139_rollback.sql.
begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regclass('public.comunicacao_convites') is null or to_regclass('public.comunicacao_configuracoes') is null then
    raise exception '139: exige a migration 134 (convites) e a configuração da Central de Comunicação';
  end if;
end $$;

create or replace function comunicacao_convites_piloto_guard() returns trigger
language plpgsql set search_path = public as $$
declare v_cfg jsonb; v_ids uuid[];
begin
  select valor into v_cfg from comunicacao_configuracoes where chave = 'convites_unidades_piloto';
  if not found then return new; end if;                                  -- sem piloto configurado: sem restrição (o backend decide)
  -- fail-closed: precisa ser array e TODOS os elementos strings (um null/número/objeto viraria NULL no array e faria "<> all" dar NULL = trava aberta)
  if jsonb_typeof(v_cfg) <> 'array' then
    raise exception 'CONVITE_UNIDADE_FORA_DO_PILOTO' using errcode = '42501';
  end if;
  if exists (select 1 from jsonb_array_elements(v_cfg) e where jsonb_typeof(e) <> 'string') then
    raise exception 'CONVITE_UNIDADE_FORA_DO_PILOTO' using errcode = '42501';
  end if;
  begin
    select coalesce(array_agg(x::uuid), '{}') into v_ids from jsonb_array_elements_text(v_cfg) x;
  exception when invalid_text_representation then
    raise exception 'CONVITE_UNIDADE_FORA_DO_PILOTO' using errcode = '42501';   -- elemento que não é uuid: fail-closed
  end;
  if exists (select 1 from unnest(new.unidades_pretendidas) u(id) where u.id <> all (v_ids)) then
    raise exception 'CONVITE_UNIDADE_FORA_DO_PILOTO' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_comunicacao_convites_piloto on comunicacao_convites;
create trigger trg_comunicacao_convites_piloto before insert on comunicacao_convites
  for each row execute function comunicacao_convites_piloto_guard();

do $$
declare papel text;
begin
  foreach papel in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if papel = 'public' or exists (select 1 from pg_roles where rolname = papel) then
      execute format('revoke all on function comunicacao_convites_piloto_guard() from %s', papel);
    end if;
  end loop;
end $$;
commit;
