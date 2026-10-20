-- =====================================================================
-- ROLLBACK 126 — volta à regra da 120 (nenhuma conta, nem o SuperAdmin, se autoconcede).
-- Concessões próprias já gravadas NÃO são apagadas nem revogadas: revogue pela tela, se for o caso.
-- =====================================================================
begin;
set local lock_timeout = '5s';

create or replace function public.gfc_validar() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_org_unidade uuid;
  v_conta uuid;
  v_perfil_ativo boolean;
begin
  if tg_op = 'UPDATE' then
    -- Identidade da concessão é imutável: para mudar perfil/unidade/org, revogue e conceda de novo.
    if new.organizacao_id is distinct from old.organizacao_id or new.unidade_id is distinct from old.unidade_id
       or new.perfil_id is distinct from old.perfil_id or new.concedida_por is distinct from old.concedida_por
       or new.concedida_em is distinct from old.concedida_em then
      raise exception 'Concessão financeira: organização, unidade, perfil e concedente são imutáveis.';
    end if;
    if old.revogada_em is not null then
      raise exception 'Concessão financeira já revogada não pode ser alterada.';
    end if;
    -- Revogação não precisa revalidar vínculos (o vínculo pode ter sido removido — é justamente o caso de revogar).
    if new.revogada_em is not null then return new; end if;
  end if;

  -- FOR SHARE: serializa com transferir/promover (que travam a unidade) — ver 5b.
  select u.organizacao_id into v_org_unidade from public.unidades u where u.id = new.unidade_id for share;
  if v_org_unidade is null or v_org_unidade <> new.organizacao_id then
    raise exception 'Concessão financeira: a unidade não pertence à organização informada.';
  end if;

  select po.conta_id, po.ativo into v_conta, v_perfil_ativo from public.perfis_operacionais po where po.id = new.perfil_id;
  if v_conta is null or v_perfil_ativo is not true then
    raise exception 'Concessão financeira: perfil inexistente ou inativo.';
  end if;

  -- PROIBIDO autoconceder: o concedente não pode ser a conta dona do perfil beneficiado.
  if new.concedida_por = v_conta then
    raise exception 'Concessão financeira: autoconcessão é proibida.';
  end if;

  -- O perfil precisa ter vínculo ativo com a unidade OU com a empresa.
  if tg_op = 'INSERT' and not (
       exists (select 1 from public.usuarios_unidades uu where uu.usuario_id = v_conta and uu.unidade_id = new.unidade_id and uu.ativo)
    or exists (select 1 from public.usuarios_organizacoes uo where uo.usuario_id = v_conta and uo.organizacao_id = new.organizacao_id and uo.ativo)
  ) then
    raise exception 'Concessão financeira: o perfil não tem vínculo ativo com a unidade/empresa.';
  end if;
  return new;
end $$;

commit;
