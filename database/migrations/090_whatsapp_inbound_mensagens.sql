-- =====================================================================
-- MIGRATION 090 — WhatsApp: persistência PRÓPRIA do inbound (Checkpoint F)
-- =====================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO SEM APROVAÇÃO EXPLÍCITA. Nunca foi aplicada em nenhum banco (nem TESTE) por quem a escreveu:
--     o Checkpoint F entrega o contrato e o código; a aplicação é um passo separado, com o backend NOVO no ar.
-- ✅  Puramente ADITIVA: uma tabela nova e uma função nova. Não altera nenhuma tabela/função existente.
-- 🔢  Número 090: a origem/main tem até 088; existe uma 089 (modelo_logistico_vigencia) ainda LOCAL em outro branch — 090 evita colidir com ela.
--
-- POR QUE UMA TABELA PRÓPRIA (e NÃO comunicacao_mensagens)
--   comunicacao_mensagens é a FILA DE OUTBOX. comunicacao_claim_mensagens (082/087) reivindica linhas por status ('SCHEDULED' ...) SEM filtrar
--   `direcao`. Uma linha inbound ali correria o risco de ser tratada como envio pendente. Aqui o inbound NUNCA compartilha tabela, status nem
--   função de claim com o outbox — e um teste estático trava que esta migration não referencia comunicacao_mensagens/claim.
--
-- O QUE A TABELA GUARDA (mínimo necessário — sem conteúdo de mensagem)
--   provider_message_id  chave de IDEMPOTÊNCIA (id do protocolo). É dado do WhatsApp, não do cliente; nunca é logado. UNIQUE por organização.
--   origem_tipo          LIVE | OFFLINE_NORMAL | OFFLINE_RECOVERY   (por mensagem, decidido no Gateway)
--   origem_jid_tipo      direct_pn | direct_lid_self | direct_lid_other | group | status | broadcast | newsletter | meta_ai | technical | unknown
--   telefone_e164        SÓ com PN real; telefone_origem diz de onde veio (JID_PN | SENDER_PN). LID/grupo/status/... nunca têm telefone.
--   from_me / falha_decrypt / motivo_falha_decrypt / stub_sistema   atribuição explícita (falha de decrypt NÃO é mensagem de cliente)
--   estado               RECEIVED | HISTORICO | QUARANTINED | IGNORED | PROCESSED (PROCESSED é reservado; nada o produz ainda)
--
-- DEFESA NO BANCO (além do schema do backend): CHECKs impõem as mesmas regras cross-field e a política de estado — nem um bug no Node consegue
-- gravar um LID como telefone, um recovery/fromMe/falha como RECEIVED, ou um telefone sem origem.
--
-- MULTI-TENANT / SEGURANÇA: organizacao_id NOT NULL + FK (cascade), sempre fornecido pelo backend (config), nunca pelo payload. RLS ligado e
-- todos os privilégios de anon/authenticated revogados (mesmo padrão da 082): só o service_role (backend) acessa, e apenas pela função
-- whatsapp_inbound_registrar (insert idempotente atômico). Não há leitura pela API pública.
-- =====================================================================

create table if not exists whatsapp_inbound_mensagens (
  id                    uuid primary key default gen_random_uuid(),
  organizacao_id        uuid not null references organizacoes(id) on delete cascade,
  provider_message_id   text not null,
  origem_tipo           text not null,
  origem_jid_tipo       text not null,
  telefone_e164         text,
  telefone_origem       text,
  from_me               boolean not null,
  falha_decrypt         boolean not null,
  motivo_falha_decrypt  text,
  stub_sistema          boolean not null,
  estado                text not null,
  recebido_em           timestamptz not null,
  created_at            timestamptz not null default now(),

  -- IDEMPOTÊNCIA: a mesma mensagem chegando de novo ⇒ UMA persistência lógica.
  constraint whatsapp_inbound_unico unique (organizacao_id, provider_message_id),

  constraint whatsapp_inbound_id_formato check (provider_message_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  constraint whatsapp_inbound_origem_tipo check (origem_tipo in ('LIVE', 'OFFLINE_NORMAL', 'OFFLINE_RECOVERY')),
  constraint whatsapp_inbound_jid_tipo check (origem_jid_tipo in (
    'direct_pn', 'direct_lid_self', 'direct_lid_other', 'group', 'status', 'broadcast', 'newsletter', 'meta_ai', 'technical', 'unknown'
  )),
  constraint whatsapp_inbound_estado check (estado in ('RECEIVED', 'HISTORICO', 'QUARANTINED', 'IGNORED', 'PROCESSED')),
  constraint whatsapp_inbound_motivo check (motivo_falha_decrypt is null or motivo_falha_decrypt in (
    'bad_mac', 'sem_sessao_compativel', 'sem_sessao', 'sem_conteudo', 'chave_ja_usada', 'prekey_invalida', 'sender_key', 'outro'
  )),

  -- TELEFONE: formato E.164 + origem obrigatória e coerente com o tipo de chat. Um LID de 15 dígitos passaria no regex — por isso a origem.
  constraint whatsapp_inbound_telefone_formato check (telefone_e164 is null or telefone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  constraint whatsapp_inbound_telefone_origem_valor check (telefone_origem is null or telefone_origem in ('JID_PN', 'SENDER_PN')),
  constraint whatsapp_inbound_telefone_par check ((telefone_e164 is null) = (telefone_origem is null)),
  constraint whatsapp_inbound_telefone_coerente check (
    telefone_e164 is null or (
      from_me = false and (
        (origem_jid_tipo = 'direct_pn' and telefone_origem = 'JID_PN') or
        (origem_jid_tipo = 'direct_lid_other' and telefone_origem = 'SENDER_PN')
      )
    )
  ),

  -- FALHA DE DECRYPT: explícita e com motivo fechado; nunca também "stub de sistema".
  constraint whatsapp_inbound_falha_motivo check (falha_decrypt = (motivo_falha_decrypt is not null)),
  constraint whatsapp_inbound_falha_ou_stub check (not (falha_decrypt and stub_sistema)),

  -- POLÍTICA DE ESTADO (espelha decidirEstadoInbound / motivoBloqueioAutomacao do backend):
  --   RECEIVED/PROCESSED ⇒ só LIVE, cliente direto, sem fromMe/falha/stub;  HISTORICO ⇒ só OFFLINE_NORMAL, mesmas condições;
  --   fromMe ⇒ IGNORED;  falha de decrypt ⇒ QUARANTINED|IGNORED;  OFFLINE_RECOVERY ⇒ QUARANTINED|IGNORED (nunca automação).
  constraint whatsapp_inbound_estado_elegivel check (
    estado not in ('RECEIVED', 'PROCESSED') or (
      origem_tipo = 'LIVE' and from_me = false and falha_decrypt = false and stub_sistema = false
      and origem_jid_tipo in ('direct_pn', 'direct_lid_other')
    )
  ),
  constraint whatsapp_inbound_estado_historico check (
    estado <> 'HISTORICO' or (
      origem_tipo = 'OFFLINE_NORMAL' and from_me = false and falha_decrypt = false and stub_sistema = false
      and origem_jid_tipo in ('direct_pn', 'direct_lid_other')
    )
  ),
  constraint whatsapp_inbound_from_me_ignorado check (from_me = false or estado = 'IGNORED'),
  constraint whatsapp_inbound_falha_quarentena check (falha_decrypt = false or estado in ('QUARANTINED', 'IGNORED')),
  constraint whatsapp_inbound_recovery_quarentena check (origem_tipo <> 'OFFLINE_RECOVERY' or estado in ('QUARANTINED', 'IGNORED'))
);

comment on table whatsapp_inbound_mensagens is
  'Inbound do WhatsApp (Checkpoint F). Tabela PRÓPRIA — nunca comunicacao_mensagens (outbox). Sem conteúdo. Idempotente por (organizacao_id, provider_message_id). Recovery/fromMe/falha de decrypt nunca são RECEIVED.';

create index if not exists idx_whatsapp_inbound_org_estado on whatsapp_inbound_mensagens (organizacao_id, estado, recebido_em desc);

alter table whatsapp_inbound_mensagens enable row level security;
revoke all on whatsapp_inbound_mensagens from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Insert idempotente e ATÔMICO. `on conflict do nothing` ⇒ a duplicata devolve inserido=false e o estado JÁ gravado (nunca sobrescreve).
-- SECURITY INVOKER (padrão): roda com os privilégios do chamador (service_role); não eleva nada.
-- ---------------------------------------------------------------------
create or replace function whatsapp_inbound_registrar(
  p_organizacao_id uuid,
  p_provider_message_id text,
  p_origem_tipo text,
  p_origem_jid_tipo text,
  p_telefone_e164 text,
  p_telefone_origem text,
  p_from_me boolean,
  p_falha_decrypt boolean,
  p_motivo_falha_decrypt text,
  p_stub_sistema boolean,
  p_estado text,
  p_recebido_em timestamptz
) returns table (inserido boolean, estado_atual text)
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into whatsapp_inbound_mensagens as m (
    organizacao_id, provider_message_id, origem_tipo, origem_jid_tipo, telefone_e164, telefone_origem,
    from_me, falha_decrypt, motivo_falha_decrypt, stub_sistema, estado, recebido_em
  ) values (
    p_organizacao_id, p_provider_message_id, p_origem_tipo, p_origem_jid_tipo, p_telefone_e164, p_telefone_origem,
    p_from_me, p_falha_decrypt, p_motivo_falha_decrypt, p_stub_sistema, p_estado, p_recebido_em
  )
  on conflict (organizacao_id, provider_message_id) do nothing
  returning m.id into v_id;

  if v_id is not null then
    return query select true, p_estado;
  else
    return query
      select false, x.estado
        from whatsapp_inbound_mensagens x
       where x.organizacao_id = p_organizacao_id and x.provider_message_id = p_provider_message_id;
  end if;
end;
$$;

comment on function whatsapp_inbound_registrar(uuid, text, text, text, text, text, boolean, boolean, text, boolean, text, timestamptz) is
  'Checkpoint F: registra um evento inbound de forma idempotente (dedupe por organizacao_id + provider_message_id). Só service_role.';

revoke all on function whatsapp_inbound_registrar(uuid, text, text, text, text, text, boolean, boolean, text, boolean, text, timestamptz) from public, anon, authenticated;
grant execute on function whatsapp_inbound_registrar(uuid, text, text, text, text, text, boolean, boolean, text, boolean, text, timestamptz) to service_role;

-- ---------------------------------------------------------------------
-- VERIFICAÇÃO pós-aplicação (rodar em TESTE primeiro):
--   select count(*) from information_schema.columns where table_name = 'whatsapp_inbound_mensagens';        -- 14
--   select relrowsecurity from pg_class where relname = 'whatsapp_inbound_mensagens';                         -- true
--   select grantee from information_schema.role_table_grants where table_name = 'whatsapp_inbound_mensagens'
--     and grantee in ('anon', 'authenticated', 'PUBLIC');                                                     -- 0 linhas
--   -- LID como telefone deve FALHAR (23514):
--   -- insert ... origem_jid_tipo='direct_lid_other', telefone_e164='+100000000000001', telefone_origem='JID_PN' ...
-- ---------------------------------------------------------------------
