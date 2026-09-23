-- =====================================================================
-- MIGRATION 093 — Comunicação WhatsApp: habilitação ATÔMICA da organização piloto
-- =====================================================================
-- Checkpoint H.4-B.1. A habilitação (habilitado=false -> true) passa a existir SÓ como ação
-- administrativa do Painel (ator humano autenticado). Esta RPC é o núcleo transacional dela:
-- serializa habilitações concorrentes e aplica, na MESMA transação, os gates que dependem de
-- estado do banco (o backend aplica antes os que dependem do process.env do piloto):
--   * modo global = DISABLED (nunca habilita com a automação já ligada);
--   * NENHUMA outra organização habilitada (piloto = 1 empresa por vez);
--   * timezone, tipo permitido e destinatário explícito configurados;
--   * destinatário com consentimento=true, verificado=true, opt_out=false.
-- Desabilitar (true -> false) NÃO passa por aqui: é sempre permitido e feito pelo backend.
--
-- Aditiva: sem tabela/coluna nova, sem alterar nenhuma função existente.
-- PRÉ-REQUISITOS: 082, 088. TRANSACIONAL/IDEMPOTENTE. ROLLBACK: 093_rollback.sql.
-- SEGURANÇA: SECURITY INVOKER, search_path fixo, EXECUTE só para service_role.
-- Nenhuma organização é habilitada por esta migration.
-- =====================================================================
begin;

create or replace function comunicacao_habilitar_organizacao_piloto(
  p_organizacao_id uuid, p_ator_perfil_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  h comunicacao_habilitacoes; c contatos_whatsapp; v_modo text; n integer; v_ator uuid;
begin
  -- Serializa TODAS as habilitações (mesmo de organizações diferentes): "nenhuma outra habilitada" só é
  -- verdade se duas habilitações concorrentes nunca leem o mesmo estado.
  perform pg_advisory_xact_lock(hashtext('comunicacao_habilitar_organizacao_piloto'));

  select trim(both '"' from (valor #>> '{}')) into v_modo from comunicacao_configuracoes where chave = 'modo';
  if coalesce(v_modo, 'DISABLED') <> 'DISABLED' then
    return jsonb_build_object('acao', 'MODO_NAO_DESABILITADO', 'modo', v_modo);
  end if;

  select * into h from comunicacao_habilitacoes where organizacao_id = p_organizacao_id for update;
  if not found then return jsonb_build_object('acao', 'SEM_CONFIGURACAO'); end if;
  if h.habilitado then return jsonb_build_object('acao', 'JA_HABILITADA'); end if;

  select count(*) into n from comunicacao_habilitacoes where habilitado and organizacao_id <> p_organizacao_id;
  if n > 0 then return jsonb_build_object('acao', 'OUTRA_ORGANIZACAO_HABILITADA'); end if;

  if h.timezone is null then return jsonb_build_object('acao', 'TIMEZONE_AUSENTE'); end if;
  if coalesce(array_length(h.tipos_permitidos, 1), 0) = 0 then return jsonb_build_object('acao', 'TIPO_AUSENTE'); end if;
  if h.destinatario_contato_id is null or h.destinatario_perfil_id is null then
    return jsonb_build_object('acao', 'SEM_DESTINATARIO');
  end if;

  select * into c from contatos_whatsapp where id = h.destinatario_contato_id;
  if not found or c.opt_out is not false or c.consentimento is not true or c.verificado is not true then
    return jsonb_build_object('acao', 'DESTINATARIO_INELEGIVEL');
  end if;

  -- atualizado_por tem FK para perfis_operacionais: um ator sem perfil operacional vira NULL (a auditoria do backend guarda o ator real).
  select id into v_ator from perfis_operacionais where id = p_ator_perfil_id;

  update comunicacao_habilitacoes
     set habilitado = true, atualizado_por = v_ator, updated_at = now()
   where organizacao_id = p_organizacao_id;
  return jsonb_build_object('acao', 'HABILITADA');
end;
$$;
comment on function comunicacao_habilitar_organizacao_piloto(uuid, uuid) is
  'Habilita ATOMICAMENTE (advisory lock) a organização piloto: modo=DISABLED, nenhuma outra habilitada, timezone/tipo/destinatário configurados, destinatário consentido+verificado+sem opt-out. Recusa com acao = MODO_NAO_DESABILITADO | SEM_CONFIGURACAO | JA_HABILITADA | OUTRA_ORGANIZACAO_HABILITADA | TIMEZONE_AUSENTE | TIPO_AUSENTE | SEM_DESTINATARIO | DESTINATARIO_INELEGIVEL. Desabilitar é feito pelo backend (sempre permitido).';
revoke all on function comunicacao_habilitar_organizacao_piloto(uuid, uuid) from public, anon, authenticated;
grant execute on function comunicacao_habilitar_organizacao_piloto(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
commit;
