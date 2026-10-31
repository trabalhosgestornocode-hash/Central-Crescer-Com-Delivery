-- 138 — OTP pelo Baileys: livro de RESERVAS de envio (fila lógica + cota própria + deduplicação + prioridade do D-1).
--
-- O código em claro NUNCA vai ao banco (só o HMAC, 134), então o envio acontece na mesma requisição que criou o desafio; esta tabela
-- decide SE ele pode sair (reserva atômica, serializada entre instâncias) e guarda só o RESULTADO: id do desafio, estado e um motivo de
-- vocabulário fixo. Sem número, sem código, sem texto. Não toca em comunicacao_mensagens (a fila e as cotas do D-1 não são lidas por
-- escrita nem consumidas): a cota do OTP é INDEPENDENTE e o D-1 tem PRIORIDADE (OTP adia se há D-1 sendo enviado/recém-vencido).
-- Rollback: 138_rollback.sql.
begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regclass('public.comunicacao_desafios_titular') is null or to_regclass('public.comunicacao_mensagens') is null then
    raise exception '138: exige a migration 134 (desafios do titular) e a fila do D-1';
  end if;
end $$;

create table if not exists comunicacao_otp_envios (
  desafio_id    uuid primary key references comunicacao_desafios_titular(id) on delete cascade,   -- 1 desafio = no máximo 1 reserva (dedupe)
  status        text not null check (status in ('ENVIANDO', 'ENVIADO', 'FALHOU', 'INCERTO', 'LIMITE', 'ADIADO')),
  motivo        text check (motivo is null or motivo ~ '^[A-Z0-9_]{1,40}$'),
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists comunicacao_otp_envios_cota_idx on comunicacao_otp_envios (criado_em) where status in ('ENVIANDO', 'ENVIADO', 'INCERTO');
alter table comunicacao_otp_envios enable row level security;

-- Reserva atômica. Os limites vêm do chamador (ajustáveis por variável sem nova migration) e são validados aqui.
-- Resultados: RESERVADO | JA_RESERVADO | LIMITE_ATINGIDO | SATURADO | ADIADO_PRIORIDADE_D1.
create or replace function comunicacao_otp_reservar(p_desafio_id uuid, p_max_hora integer, p_max_dia integer, p_max_simultaneos integer)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_n integer; v_hora integer; v_dia integer; v_sim integer; v_d1 boolean;
begin
  if p_max_hora not between 1 and 1000 or p_max_dia not between 1 and 10000 or p_max_simultaneos not between 1 and 20 then
    raise exception 'limites inválidos' using errcode = '22023';
  end if;
  if not exists (select 1 from comunicacao_desafios_titular where id = p_desafio_id) then
    raise exception 'desafio inexistente' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('comunicacao_otp_reservar', 0));   -- serializa a decisão de cota entre instâncias
  insert into comunicacao_otp_envios (desafio_id, status) values (p_desafio_id, 'ENVIANDO') on conflict (desafio_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('resultado', 'JA_RESERVADO'); end if;

  select count(*) filter (where criado_em > now() - interval '1 hour'),
         count(*) filter (where criado_em > now() - interval '1 day'),
         count(*) filter (where status = 'ENVIANDO' and criado_em > now() - interval '30 seconds')
    into v_hora, v_dia, v_sim
    from comunicacao_otp_envios
   where desafio_id <> p_desafio_id and status in ('ENVIANDO', 'ENVIADO', 'INCERTO') and criado_em > now() - interval '1 day';
  if v_hora >= p_max_hora or v_dia >= p_max_dia then
    update comunicacao_otp_envios set status = 'LIMITE', motivo = 'LIMITE_ATINGIDO', atualizado_em = now() where desafio_id = p_desafio_id;
    return jsonb_build_object('resultado', 'LIMITE_ATINGIDO');
  end if;
  if v_sim >= p_max_simultaneos then
    update comunicacao_otp_envios set status = 'ADIADO', motivo = 'SATURADO', atualizado_em = now() where desafio_id = p_desafio_id;
    return jsonb_build_object('resultado', 'SATURADO');
  end if;
  -- PRIORIDADE DO D-1 (somente leitura da fila): há mensagem sendo processada/enviada agora, ou que venceu nos últimos 2 minutos e o
  -- worker está prestes a pegar. Um backlog antigo/parado NÃO bloqueia o OTP (sem inanição).
  select exists (
    select 1 from comunicacao_mensagens
     where (status in ('PROCESSING', 'SENDING') and updated_at > now() - interval '90 seconds')
        or (status = 'SCHEDULED' and disponivel_em <= now() and disponivel_em > now() - interval '2 minutes'
            and (expira_em is null or expira_em > now()))
  ) into v_d1;
  if v_d1 then
    update comunicacao_otp_envios set status = 'ADIADO', motivo = 'PRIORIDADE_D1', atualizado_em = now() where desafio_id = p_desafio_id;
    return jsonb_build_object('resultado', 'ADIADO_PRIORIDADE_D1');
  end if;
  return jsonb_build_object('resultado', 'RESERVADO');
end $$;

-- Resultado do envio: só a reserva em ENVIANDO pode mudar (idempotente; um resultado final nunca é sobrescrito).
create or replace function comunicacao_otp_registrar_resultado(p_desafio_id uuid, p_status text, p_motivo text)
returns boolean language plpgsql security invoker set search_path = public as $$
declare v_n integer;
begin
  if p_status not in ('ENVIADO', 'FALHOU', 'INCERTO') then raise exception 'estado inválido' using errcode = '22023'; end if;
  update comunicacao_otp_envios set status = p_status, motivo = p_motivo, atualizado_em = now()
   where desafio_id = p_desafio_id and status = 'ENVIANDO';
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

do $$
declare papel text; fn text;
  fns constant text[] := array['comunicacao_otp_reservar(uuid,integer,integer,integer)', 'comunicacao_otp_registrar_resultado(uuid,text,text)'];
begin
  foreach papel in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if papel = 'public' or exists (select 1 from pg_roles where rolname = papel) then
      execute format('revoke all on table comunicacao_otp_envios from %s', papel);
      foreach fn in array fns loop execute format('revoke all on function %s from %s', fn, papel); end loop;
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on table comunicacao_otp_envios to service_role;
    grant update (status, motivo, atualizado_em) on table comunicacao_otp_envios to service_role;
    foreach fn in array fns loop execute format('grant execute on function %s to service_role', fn); end loop;
  end if;
end $$;
commit;
