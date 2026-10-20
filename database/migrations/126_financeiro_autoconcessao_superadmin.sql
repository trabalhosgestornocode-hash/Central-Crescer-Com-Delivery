-- =====================================================================
-- MIGRATION 126 — Dashboard Financeiro: o SuperAdmin da plataforma pode definir o próprio acesso
-- =====================================================================
-- MOTIVO
--   A 120 recusa qualquer concessão em que o concedente é a conta dona do perfil. Com uma única conta SuperAdmin,
--   ninguém consegue receber o primeiro acesso. Decisão do proprietário (2026-10-20, gestão simples de acessos):
--   o SuperAdmin da plataforma — a autoridade máxima, que já administra os acessos de todos — pode definir também o
--   próprio. Qualquer outra conta continua proibida de se autoconceder.
--
-- O QUE FAZ
--   Substitui public.gfc_validar() pelo corpo da 120, trocando só a regra de autoconcessão:
--     antes:  concedida_por = conta do perfil                              -> recusa
--     agora:  concedida_por = conta do perfil E concedente NÃO é SuperAdmin -> recusa
--   "SuperAdmin" = linha ATIVA em public.plataforma_admins (mesma fonte de is_platform_superadmin(), migration 015).
--   Continuam valendo: unidade da organização, perfil ativo e com vínculo, identidade imutável, revogação com motivo,
--   uma concessão ativa por perfil+unidade e a trilha de auditoria (a concessão própria fica registrada como qualquer outra).
--
-- NÃO FAZ: não concede acesso, não habilita módulo, não altera dados, grants, RLS nem outros gatilhos.
-- PRÉ-REQUISITOS: 015 (plataforma_admins), 120. IDEMPOTENTE. ROLLBACK: 126_rollback.sql (volta à regra da 120).
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

  -- FOR SHARE: serializa com transferir/promover (que travam a unidade) — ver 120, 5b.
  select u.organizacao_id into v_org_unidade from public.unidades u where u.id = new.unidade_id for share;
  if v_org_unidade is null or v_org_unidade <> new.organizacao_id then
    raise exception 'Concessão financeira: a unidade não pertence à organização informada.';
  end if;

  select po.conta_id, po.ativo into v_conta, v_perfil_ativo from public.perfis_operacionais po where po.id = new.perfil_id;
  if v_conta is null or v_perfil_ativo is not true then
    raise exception 'Concessão financeira: perfil inexistente ou inativo.';
  end if;

  -- Autoconcessão: só o SuperAdmin ATIVO da plataforma pode definir o próprio acesso (126). Qualquer outra conta, não.
  if new.concedida_por = v_conta
     and not exists (select 1 from public.plataforma_admins pa where pa.usuario_id = new.concedida_por and pa.ativo) then
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
