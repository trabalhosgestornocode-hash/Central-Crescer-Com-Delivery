-- =====================================================================================================================
-- MOVA — RELÉ de homologação: FILA DE SAÍDA (Execução 15B). Aplicar SOMENTE no banco de HOMOLOGAÇÃO (depois da 0001) ou no
-- banco local de teste. Nunca em produção.
--
-- Por quê: o gateway-whatsapp é um SERVIÇO PRIVADO do Render (sem URL pública) — o backend de homologação não consegue
-- chamá-lo. O retorno usa o mesmo princípio da entrada: o Gateway só faz conexões de SAÍDA. Ele PERGUNTA ao relé se há
-- resposta a enviar (HMAC conferido aqui, como em `receber`), envia e CONFIRMA. Nenhum endpoint do Gateway é exposto.
--
--   backend MOVA ──(papel mova_rele_consumidor)──► publicar_saida(id estável) ──► mova_rele.saida
--   Gateway ──HTTPS assinado──► Edge Function `mova-rele` /internal/mova/saida ──► saida_gateway(): reservar | confirmar | falhar
--
-- DEDUPLICAÇÃO (G-1), persistente e independente da memória de qualquer processo:
--   * id = id da resposta no MOVA (estável): publicar duas vezes não cria duas saídas (PK);
--   * reservar é atômico (FOR UPDATE SKIP LOCKED): duas instâncias/requisições nunca pegam a mesma saída;
--   * ENVIADA nunca volta a ser reservada;
--   * RESERVADA com lease VENCIDO vira INCERTA (o Gateway pode ter enviado e caído antes de confirmar) — NUNCA é reenviada;
--   * falha COMPROVADAMENTE ANTES do envio volta a PENDENTE (até 3 vezes); qualquer outra falha vira INCERTA ou FALHOU;
--   * confirmação que chega depois do lease vencer ainda marca ENVIADA (é evidência de entrega ao provedor).
-- Não há garantia de "exatamente uma entrega": se o Gateway cair entre o envio ao WhatsApp e a confirmação, a saída fica
-- INCERTA e vai para revisão humana (pode ter sido entregue ou não). O que se garante é: nunca um SEGUNDO envio automático.
-- Interruptor: mova_rele.controle_saida.ligado (o backend liga/desliga; desligado ⇒ reservar devolve vazio).
-- =====================================================================================================================
do $$ begin
  if coalesce(shobj_description((select oid from pg_database where datname = current_database()), 'pg_database'), '') not like 'MOVA_HOMOLOGACAO:%'
     and current_database() not like 'fv2_teste_%' then
    raise exception 'MOVA relé (saída): só no banco de homologação ou no banco local de teste — nada foi feito';
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'mova_rele') then raise exception 'MOVA relé (saída): aplique antes a 0001'; end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'mova_rele' and c.relname = 'saida') then
    raise exception 'MOVA relé (saída): já aplicada — nada foi feito';
  end if;
end $$;

create table mova_rele.saida (
  id                  uuid primary key,                                   -- id da resposta no MOVA (estável)
  destino             text not null check (destino ~ '^[1-9][0-9]{7,14}@s\.whatsapp\.net$'),   -- só conversa PRIVADA
  texto               text not null check (length(texto) between 1 and 4096),
  criada_em           timestamptz not null default now(),
  estado              text not null default 'PENDENTE' check (estado in ('PENDENTE','RESERVADA','ENVIADA','INCERTA','FALHOU','CANCELADA')),
  tentativas          integer not null default 0,
  gateway             text,
  lease_ate           timestamptz,
  proxima_em          timestamptz not null default now(),
  provider_message_id text check (provider_message_id ~ '^[A-Za-z0-9_.:-]{1,120}$'),
  enviada_em          timestamptz,
  codigo              text check (codigo ~ '^[A-Z0-9_:]{1,80}$')
);
create index saida_disponivel on mova_rele.saida (proxima_em, criada_em) where estado = 'PENDENTE';
create index saida_reservada on mova_rele.saida (lease_ate) where estado = 'RESERVADA';

create table mova_rele.controle_saida (
  id           boolean primary key default true check (id),
  ligado       boolean not null default false,
  atualizado_por text,
  atualizado_em timestamptz not null default now()
);
insert into mova_rele.controle_saida (ligado, atualizado_por) values (false, 'instalacao');

alter table mova_rele.saida enable row level security;
alter table mova_rele.controle_saida enable row level security;
revoke all on mova_rele.saida, mova_rele.controle_saida from public;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on mova_rele.saida, mova_rele.controle_saida from %I', r); end if;
  end loop;
end $$;

-- ------------------------------------------------------------------------------------------------- autenticação (reuso)
-- Mesma conferência de `receber`: formato, janela ±60 s, HMAC do canal, nonce de uso único. Resultado: OK | NAO_AUTORIZADO | REPLAY.
create function mova_rele.autenticar(p_corpo text, p_ts text, p_nonce text, p_assinatura text, p_caminho text, p_origem text)
returns text language plpgsql security definer set search_path = pg_catalog, extensions, mova_rele_cripto, pg_temp as $$
declare v_segredo text; v_sha text; v_esperada text; v_agora timestamptz := clock_timestamp();
begin
  if p_corpo is null or p_ts !~ '^\d{10,13}$' or p_nonce !~ '^[A-Za-z0-9_-]{16,64}$' or p_assinatura !~ '^[0-9a-f]{64}$' or p_origem !~ '^[a-z0-9-]{1,40}$' then
    insert into mova_rele.auditoria (acao, ator, codigo) values ('RECUSADO', p_origem, 'FORMATO'); return 'NAO_AUTORIZADO';
  end if;
  select valor into v_segredo from mova_rele.segredo;
  if v_segredo is null then raise exception 'MOVA relé: segredo não configurado'; end if;
  if abs(extract(epoch from v_agora) * 1000 - p_ts::numeric) > 60000 then
    insert into mova_rele.auditoria (acao, ator, codigo) values ('RECUSADO', p_origem, 'JANELA'); return 'NAO_AUTORIZADO';
  end if;
  v_sha := encode(digest(convert_to(p_corpo, 'UTF8'), 'sha256'), 'hex');
  v_esperada := encode(hmac(convert_to(p_ts || E'\n' || p_nonce || E'\nPOST\n' || p_caminho || E'\n' || v_sha, 'UTF8'), convert_to(v_segredo, 'UTF8'), 'sha256'), 'hex');
  if digest(v_esperada, 'sha256') <> digest(p_assinatura, 'sha256') then
    insert into mova_rele.auditoria (acao, ator, codigo) values ('RECUSADO', p_origem, 'ASSINATURA'); return 'NAO_AUTORIZADO';
  end if;
  delete from mova_rele.nonce where expira_em < v_agora;
  insert into mova_rele.nonce (nonce, expira_em) values (p_nonce, v_agora + interval '2 minutes') on conflict do nothing;
  if not found then insert into mova_rele.auditoria (acao, ator, codigo) values ('RECUSADO', p_origem, 'REPLAY'); return 'REPLAY'; end if;
  return 'OK';
end $$;

-- ------------------------------------------------------------------------------------------------- lado do Gateway (Edge Function)
-- Corpo assinado: {"acao":"reservar","gateway":"<id>","lote":N}
--                 {"acao":"confirmar","gateway":"<id>","id":"<uuid>","providerMessageId":"<id>"}
--                 {"acao":"falhar","gateway":"<id>","id":"<uuid>","codigo":"<CODIGO>","antesDoEnvio":true|false}
create function mova_rele.saida_gateway(p_corpo text, p_ts text, p_nonce text, p_assinatura text, p_caminho text, p_origem text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, extensions, mova_rele_cripto, pg_temp as $$
declare
  v_aut text; c jsonb; v_acao text; v_gw text; v_id uuid; v_lote integer; v_itens jsonb; v_t integer; v_estado text; v_cod text; v_n integer;
begin
  if p_caminho <> '/internal/mova/saida' then return jsonb_build_object('resultado', 'NAO_AUTORIZADO'); end if;
  v_aut := mova_rele.autenticar(p_corpo, p_ts, p_nonce, p_assinatura, p_caminho, p_origem);
  if v_aut <> 'OK' then return jsonb_build_object('resultado', v_aut); end if;
  begin c := p_corpo::jsonb; exception when others then return jsonb_build_object('resultado', 'INVALIDO'); end;
  v_acao := c ->> 'acao'; v_gw := c ->> 'gateway';
  if v_gw is null or v_gw !~ '^[A-Za-z0-9_.:-]{1,80}$' then return jsonb_build_object('resultado', 'INVALIDO'); end if;

  if v_acao = 'reservar' then
    -- 15C (A-2): lote não numérico é corpo INVÁLIDO (400), nunca exceção (que viraria "banco indisponível").
    if coalesce(c ->> 'lote', '1') !~ '^[0-9]{1,3}$' then return jsonb_build_object('resultado', 'INVALIDO'); end if;
    -- 1) lease vencido = o Gateway pode ter enviado e caído antes de confirmar ⇒ INCERTA (nunca volta à fila)
    with venc as (update mova_rele.saida set estado = 'INCERTA', codigo = 'LEASE_VENCIDO', lease_ate = null
                   where estado = 'RESERVADA' and lease_ate < clock_timestamp() returning id, gateway)
    insert into mova_rele.auditoria (acao, evento_id, ator, codigo) select 'SAIDA_INCERTA', id::text, gateway, 'LEASE_VENCIDO' from venc;
    if not coalesce((select ligado from mova_rele.controle_saida), false) then return jsonb_build_object('resultado', 'OK', 'itens', '[]'::jsonb, 'desligado', true); end if;
    v_lote := least(greatest(coalesce((c ->> 'lote')::integer, 1), 1), 5);
    with alvo as (select s.id from mova_rele.saida s where s.estado = 'PENDENTE' and s.proxima_em <= clock_timestamp()
                   order by s.criada_em, s.id limit v_lote for update skip locked),
         res as (update mova_rele.saida s set estado = 'RESERVADA', gateway = v_gw, tentativas = s.tentativas + 1, lease_ate = clock_timestamp() + interval '120 seconds'
                   from alvo where s.id = alvo.id returning s.id, s.destino, s.texto, s.criada_em)
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'destino', destino, 'texto', texto) order by criada_em, id), '[]'::jsonb) into v_itens from res;
    insert into mova_rele.auditoria (acao, evento_id, ator) select 'SAIDA_RESERVADA', x ->> 'id', v_gw from jsonb_array_elements(v_itens) x;
    return jsonb_build_object('resultado', 'OK', 'itens', v_itens);
  end if;

  begin v_id := (c ->> 'id')::uuid; exception when others then return jsonb_build_object('resultado', 'INVALIDO'); end;

  if v_acao = 'confirmar' then
    if coalesce(c ->> 'providerMessageId', '') !~ '^[A-Za-z0-9_.:-]{1,120}$' then return jsonb_build_object('resultado', 'INVALIDO'); end if;
    -- RESERVADA por este Gateway, ou INCERTA (confirmação atrasada é evidência de envio); ENVIADA = idempotente.
    update mova_rele.saida set estado = 'ENVIADA', provider_message_id = c ->> 'providerMessageId', enviada_em = clock_timestamp(), lease_ate = null, codigo = null
     where id = v_id and ((estado = 'RESERVADA' and gateway = v_gw) or estado = 'INCERTA');
    get diagnostics v_n = row_count;
    if v_n = 1 then insert into mova_rele.auditoria (acao, evento_id, ator) values ('SAIDA_ENVIADA', v_id::text, v_gw); return jsonb_build_object('resultado', 'OK'); end if;
    return jsonb_build_object('resultado', case when exists (select 1 from mova_rele.saida where id = v_id and estado = 'ENVIADA') then 'OK' else 'SEM_RESERVA' end);
  end if;

  if v_acao = 'falhar' then
    v_cod := coalesce(c ->> 'codigo', 'FALHA');
    if v_cod !~ '^[A-Z0-9_:]{1,80}$' then v_cod := 'FALHA'; end if;
    select tentativas into v_t from mova_rele.saida where id = v_id and estado = 'RESERVADA' and gateway = v_gw for update;
    if not found then return jsonb_build_object('resultado', 'SEM_RESERVA'); end if;
    v_estado := case when (c ->> 'antesDoEnvio') = 'true' then (case when v_t < 3 then 'PENDENTE' else 'FALHOU' end) else 'INCERTA' end;
    update mova_rele.saida set estado = v_estado, codigo = v_cod, lease_ate = null,
           proxima_em = clock_timestamp() + make_interval(secs => 30 * greatest(v_t, 1)) where id = v_id;
    insert into mova_rele.auditoria (acao, evento_id, ator, codigo) values ('SAIDA_' || v_estado, v_id::text, v_gw, v_cod);
    return jsonb_build_object('resultado', 'OK', 'estado', v_estado);
  end if;
  return jsonb_build_object('resultado', 'INVALIDO');
end $$;

-- ------------------------------------------------------------------------------------------------- lado do backend MOVA
-- Publica a resposta (idempotente pela PK). Devolve o estado ATUAL (publicar de novo não muda nada).
create function mova_rele.publicar_saida(p_id uuid, p_destino text, p_texto text)
returns text language plpgsql security definer set search_path = pg_catalog, extensions, mova_rele_cripto, pg_temp as $$
declare v_estado text;
begin
  insert into mova_rele.saida (id, destino, texto) values (p_id, p_destino, p_texto) on conflict (id) do nothing;
  if found then insert into mova_rele.auditoria (acao, evento_id, ator) values ('SAIDA_PUBLICADA', p_id::text, 'backend-mova'); end if;
  select estado into v_estado from mova_rele.saida where id = p_id;
  return v_estado;
end $$;

create function mova_rele.estado_saidas(p_ids uuid[])
returns table (id uuid, estado text, provider_message_id text, codigo text)
language sql security definer set search_path = pg_catalog, extensions, mova_rele_cripto, pg_temp as $$
  select s.id, s.estado, s.provider_message_id, s.codigo from mova_rele.saida s where s.id = any(p_ids)
$$;

-- Liga/desliga a saída (suspensão imediata: o próximo `reservar` já devolve vazio). Desligar também CANCELA as pendentes.
create function mova_rele.definir_saida(p_ligado boolean, p_ator text)
returns integer language plpgsql security definer set search_path = pg_catalog, extensions, mova_rele_cripto, pg_temp as $$
declare n integer := 0;
begin
  update mova_rele.controle_saida set ligado = p_ligado, atualizado_por = left(p_ator, 80), atualizado_em = clock_timestamp();
  if not p_ligado then
    update mova_rele.saida set estado = 'CANCELADA', codigo = 'SAIDA_DESLIGADA' where estado = 'PENDENTE';
    get diagnostics n = row_count;
  end if;
  insert into mova_rele.auditoria (acao, ator, codigo) values (case when p_ligado then 'SAIDA_LIGADA' else 'SAIDA_DESLIGADA' end, left(p_ator, 80), n::text);
  return n;
end $$;

revoke all on function mova_rele.autenticar(text, text, text, text, text, text), mova_rele.saida_gateway(text, text, text, text, text, text),
  mova_rele.publicar_saida(uuid, text, text), mova_rele.estado_saidas(uuid[]), mova_rele.definir_saida(boolean, text) from public;
-- 15C (A-1): o Supabase concede EXECUTE a anon/authenticated/service_role por padrão — revogado (como na 0001).
do $$ declare r text; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function mova_rele.autenticar(text, text, text, text, text, text), mova_rele.saida_gateway(text, text, text, text, text, text), mova_rele.publicar_saida(uuid, text, text), mova_rele.estado_saidas(uuid[]), mova_rele.definir_saida(boolean, text) from %I', r);
    end if;
  end loop;
end $$;
grant execute on function mova_rele.saida_gateway(text, text, text, text, text, text) to mova_rele_gravador;
grant execute on function mova_rele.publicar_saida(uuid, text, text), mova_rele.estado_saidas(uuid[]), mova_rele.definir_saida(boolean, text) to mova_rele_consumidor;
