-- =====================================================================
-- MIGRATION 087 — Comunicação WhatsApp: CLAIM × ATTEMPT + fencing (C3.5-D.3-R)
-- =====================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO SEM APROVAÇÃO EXPLÍCITA.
-- ⚠️  Esta migration NÃO é só aditiva: ela (a) ADICIONA uma coluna e
--     (b) SUBSTITUI o corpo de comunicacao_claim_mensagens (mesma assinatura),
--     mudando o contrato de `tentativas`. Ver "COMPATIBILIDADE" abaixo.
--
-- PROBLEMA (auditado no código real, D.3 e D.3-R)
--   1. Toda transição posterior ao claim (PROCESSING -> SENDING -> ...) era um
--      UPDATE por `id`, sem provar que o worker ainda era o dono da linha:
--      worker A lento + lease vencido + worker B reivindica => A ainda enviava.
--   2. O claim (082) incrementava `tentativas`. Isso mistura duas coisas:
--        CLAIM   = quem pode processar a linha AGORA;
--        ATTEMPT = qual execução chegou à FRONTEIRA DE ENVIO (sendMessage).
--      Um adiamento (fora da janela, cooldown, rate limit, provider offline
--      ANTES de enviar) gera um claim e ZERO attempts — mas consumia uma
--      "tentativa" e, esgotado `max_tentativas`, matava uma mensagem que nunca
--      foi enviada.
--
-- MODELO
--   claim_geracao (NOVA, bigint)  token do CLAIM. Incrementado SÓ pelo claim,
--                                 na mesma instrução que grava claimed_by.
--   tentativas    (existente)     contador de ATTEMPTS REAIS. Incrementado SÓ
--                                 por comunicacao_iniciar_envio, na mesma
--                                 instrução que faz PROCESSING -> SENDING.
--   O token de um attempt é o par (claim_geracao, tentativas).
--
--   Prova de unicidade (formal):
--     (i)  claim_geracao e tentativas só mudam por UPDATE, que toma o lock da
--          linha; logo as mudanças são serializadas.
--     (ii) claim_geracao só sobe (+1) no claim; tentativas só sobe (+1) em
--          iniciar_envio; nenhuma função os decrementa e o trigger
--          trg_comunicacao_mensagens_tokens_monotonicos rejeita qualquer UPDATE
--          que diminua um dos dois. Logo os valores são estritamente crescentes
--          por linha e nunca se repetem.
--     (iii) iniciar_envio exige status='PROCESSING' e claim_geracao = o do
--          chamador; ao vencer, a linha vira SENDING. Como o claim só seleciona
--          SCHEDULED ou PROCESSING (nunca SENDING), depois de SENDING nenhum
--          outro worker consegue criar outro attempt para a mesma linha sem
--          antes passar por SCHEDULED (retry pré-envio, que exige finalização
--          do attempt anterior) e por um NOVO claim (claim_geracao+1).
--     (iv) portanto dois workers nunca compartilham um attempt: o token do
--          attempt de A tem (claim_geracao=a, tentativas=n); qualquer claim
--          posterior tem claim_geracao>a, e qualquer attempt posterior tem
--          tentativas>n. Um callback antigo só casa com o estado em que foi
--          criado.
--
-- FUNÇÕES (todas devolvem 0 linhas quando o token/estado não confere:
--   "perdeu a posse" — o chamador ABORTA; relógio = o do BANCO)
--   comunicacao_claim_mensagens      [substituída] não incrementa tentativas;
--                                    incrementa claim_geracao
--   comunicacao_iniciar_envio        PROCESSING -> SENDING; ATTEMPT nasce aqui
--   comunicacao_finalizar_envio      SENDING -> SENT | DELIVERY_UNKNOWN | FAILED |
--                                    SCHEDULED(retry pré-envio); e
--                                    DELIVERY_UNKNOWN -> SENT (confirmação
--                                    TARDIA do MESMO attempt)
--   comunicacao_encerrar_processamento
--                                    PROCESSING -> BLOCKED | CANCELLED | FAILED |
--                                    SCHEDULED (adiamento: NÃO consome attempt)
--
-- SEMÂNTICA DE ESTADOS
--   BLOCKED           só veto PERMANENTE de política (sem consentimento, opt-out,
--                     contato inválido, empresa desabilitada, tipo não permitido).
--   FAILED            falha definitiva de transporte/processamento OU esgotamento
--                     da política de retries de falha PRÉ-ENVIO comprovada.
--   DELIVERY_UNKNOWN  resultado ambíguo. NUNCA volta a retry por aqui: a única
--                     saída é a confirmação tardia SENT do mesmo attempt.
--   SCHEDULED         condição transitória/deferida — sem attempt consumido.
--
-- COMPATIBILIDADE
--   * Nenhuma tabela/coluna existente é removida ou alterada além do
--     ADD COLUMN (default 0, not null): linhas existentes seguem válidas.
--   * O corpo do claim muda: `tentativas` deixa de subir no claim. Código que
--     dependa de "cada claim conta como tentativa" (o pipeline anterior ao D.3-R
--     e testes antigos) muda de comportamento. Em PRODUÇÃO nenhum código chama o
--     claim (sem worker/scheduler; tabelas de comunicação vazias; modo DISABLED).
--
-- SEGURANÇA (mesmo modelo de 082): SECURITY INVOKER, search_path fixo, EXECUTE
-- só para service_role.
--
-- PRÉ-REQUISITO: migration 082 aplicada.
-- TRANSACIONAL / IDEMPOTENTE. ROLLBACK: 087_rollback.sql (restaura o claim da 082).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Limpa assinaturas de iterações de desenvolvimento anteriores (só
--    existiram no banco de TESTE; em produção estes drops são no-op).
-- ---------------------------------------------------------------------
drop function if exists comunicacao_iniciar_envio(uuid, text, integer, integer);
drop function if exists comunicacao_finalizar_envio(uuid, text, integer, text, text, text, integer);
drop function if exists comunicacao_encerrar_processamento(uuid, text, integer, text, text, timestamptz);

-- ---------------------------------------------------------------------
-- 1. Token do CLAIM
-- ---------------------------------------------------------------------
alter table comunicacao_mensagens
  add column if not exists claim_geracao bigint not null default 0;

comment on column comunicacao_mensagens.claim_geracao is
  'Token do CLAIM (quem pode processar a linha agora). +1 a cada claim; nunca decrementa. Junto de `tentativas` (ATTEMPTS reais) forma o token de fencing do envio. Ver comentário da migration 087.';
comment on column comunicacao_mensagens.tentativas is
  'Número de ATTEMPTS REAIS: só sobe em comunicacao_iniciar_envio (PROCESSING -> SENDING), a fronteira do sendMessage. Um adiamento (deferimento) NÃO consome tentativa. Nunca decrementa.';

-- Invariante do token, imposta no banco (não só por convenção).
create or replace function comunicacao_mensagens_tokens_monotonicos()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.claim_geracao < old.claim_geracao then
    raise exception 'comunicacao_mensagens.claim_geracao nao pode diminuir (% -> %)', old.claim_geracao, new.claim_geracao
      using errcode = '23514';
  end if;
  if new.tentativas < old.tentativas then
    raise exception 'comunicacao_mensagens.tentativas nao pode diminuir (% -> %)', old.tentativas, new.tentativas
      using errcode = '23514';
  end if;
  return new;
end;
$$;

-- (função de trigger: não é chamável diretamente, mas o Supabase concede EXECUTE por padrão — revoga por higiene)
revoke all on function comunicacao_mensagens_tokens_monotonicos() from public, anon, authenticated;

drop trigger if exists trg_comunicacao_mensagens_tokens_monotonicos on comunicacao_mensagens;
create trigger trg_comunicacao_mensagens_tokens_monotonicos
  before update on comunicacao_mensagens
  for each row execute function comunicacao_mensagens_tokens_monotonicos();

-- ---------------------------------------------------------------------
-- 2. CLAIM — agora só reivindica (não consome attempt)
-- ---------------------------------------------------------------------
create or replace function comunicacao_claim_mensagens(p_limite integer, p_worker text, p_lease_segundos integer default 120)
returns setof comunicacao_mensagens
language sql
security invoker
set search_path = public
as $$
  with candidatos as (
    select id
    from comunicacao_mensagens
    where (status = 'SCHEDULED' and disponivel_em <= now())
       or (status = 'PROCESSING' and claim_expira_em < now())
    order by disponivel_em asc
    limit greatest(p_limite, 0)
    for update skip locked
  )
  update comunicacao_mensagens m
  set status = 'PROCESSING',
      claimed_by = p_worker,
      claimed_at = now(),
      claim_expira_em = now() + make_interval(secs => greatest(p_lease_segundos, 1)),
      claim_geracao = m.claim_geracao + 1,
      updated_at = now()
  from candidatos c
  where m.id = c.id
  returning m.*;
$$;

comment on function comunicacao_claim_mensagens(integer, text, integer) is
  'Claim ATÔMICO de até p_limite mensagens elegíveis (SCHEDULED disponíveis, ou PROCESSING com lease expirado), via FOR UPDATE SKIP LOCKED. Incrementa claim_geracao (token do CLAIM); NÃO incrementa tentativas (attempt só nasce em comunicacao_iniciar_envio). NUNCA reivindica SENDING nem DELIVERY_UNKNOWN.';

revoke all on function comunicacao_claim_mensagens(integer, text, integer) from public, anon, authenticated;
grant execute on function comunicacao_claim_mensagens(integer, text, integer) to service_role;

-- ---------------------------------------------------------------------
-- 3. PROCESSING -> SENDING — o ATTEMPT nasce aqui
-- ---------------------------------------------------------------------
create or replace function comunicacao_iniciar_envio(
  p_id uuid, p_worker text, p_claim_geracao bigint, p_lease_segundos integer default 90
)
returns setof comunicacao_mensagens
language sql
security invoker
set search_path = public
as $$
  update comunicacao_mensagens
     set status = 'SENDING',
         tentativas = tentativas + 1,
         -- lease NOVO para a fase de envio (maior que o timeout do provider): o
         -- tempo gasto em policy/revalidação antes desta chamada não come o lease
         -- de quem está realmente enviando.
         claim_expira_em = now() + make_interval(secs => greatest(p_lease_segundos, 1)),
         updated_at = now()
   where id = p_id
     and status = 'PROCESSING'
     and claimed_by = p_worker
     and claim_geracao = p_claim_geracao
     and claim_expira_em > now()
     and tentativas < max_tentativas
  returning *;
$$;

comment on function comunicacao_iniciar_envio(uuid, text, bigint, integer) is
  'CAS PROCESSING -> SENDING; cria o ATTEMPT (tentativas+1). Devolve 0 linhas se o worker perdeu a posse (outro claim, lease expirado, estado diferente) ou se as tentativas já esgotaram — nesse caso o provider NÃO pode ser chamado. O attempt devolvido é (claim_geracao, tentativas) da linha retornada.';

-- ---------------------------------------------------------------------
-- 4. SENDING -> resultado (SENT | DELIVERY_UNKNOWN | FAILED | RETRY)
-- ---------------------------------------------------------------------
-- RETRY = falha PRÉ-ENVIO comprovada -> SCHEDULED com backoff, ou FAILED se a
-- política de retries esgotou (tentativas >= max_tentativas). Quem decide que é
-- pré-envio é comunicacao.entrega.js, nunca esta função.
create or replace function comunicacao_finalizar_envio(
  p_id uuid, p_worker text, p_claim_geracao bigint, p_tentativa integer, p_resultado text,
  p_provider_message_id text default null,
  p_erro text default null,
  p_retry_apos_segundos integer default null
)
returns setof comunicacao_mensagens
language sql
security invoker
set search_path = public
as $$
  update comunicacao_mensagens m
     set status = case p_resultado
           when 'SENT' then 'SENT'
           when 'DELIVERY_UNKNOWN' then 'DELIVERY_UNKNOWN'
           when 'FAILED' then 'FAILED'
           else case when m.tentativas >= m.max_tentativas then 'FAILED' else 'SCHEDULED' end
         end,
         enviado_em = case when p_resultado = 'SENT' then now() else m.enviado_em end,
         provider_message_id = case when p_resultado = 'SENT'
                                    then coalesce(p_provider_message_id, m.provider_message_id)
                                    else m.provider_message_id end,
         entrega_incerta_em = case when p_resultado = 'DELIVERY_UNKNOWN' then now() else m.entrega_incerta_em end,
         falhou_em = case when p_resultado = 'FAILED'
                            or (p_resultado = 'RETRY' and m.tentativas >= m.max_tentativas)
                          then now() else m.falhou_em end,
         erro_permanente = case when p_resultado = 'FAILED'
                                  or (p_resultado = 'RETRY' and m.tentativas >= m.max_tentativas)
                                then true else m.erro_permanente end,
         erro = case when p_resultado = 'SENT' then null else p_erro end,
         disponivel_em = case when p_resultado = 'RETRY' and m.tentativas < m.max_tentativas
                              then now() + make_interval(secs => greatest(coalesce(p_retry_apos_segundos, 60), 1))
                              else m.disponivel_em end,
         updated_at = now()
   where m.id = p_id
     and m.claimed_by = p_worker
     and m.claim_geracao = p_claim_geracao
     and m.tentativas = p_tentativa
     and p_resultado in ('SENT', 'DELIVERY_UNKNOWN', 'FAILED', 'RETRY')
     and (
           -- caminho normal: quem criou o attempt (colocou em SENDING) o finaliza.
           m.status = 'SENDING'
           -- confirmação TARDIA: o lease expirou durante a chamada, a varredura
           -- marcou UNKNOWN, e o MESMO attempt confirma que enviou. Só SENT —
           -- UNKNOWN nunca vira retry nem FAILED por aqui.
        or (p_resultado = 'SENT' and m.status = 'DELIVERY_UNKNOWN')
         )
  returning m.*;
$$;

comment on function comunicacao_finalizar_envio(uuid, text, bigint, integer, text, text, text, integer) is
  'CAS de finalização. Só o dono do attempt (claim_geracao, tentativas) finaliza; 0 linhas = perdeu a posse (callback atrasado / attempt antigo) e NADA é sobrescrito. DELIVERY_UNKNOWN só sai por confirmação tardia SENT do mesmo attempt — nunca por RETRY/FAILED.';

-- ---------------------------------------------------------------------
-- 5. PROCESSING -> BLOCKED | CANCELLED | FAILED | SCHEDULED (SEM attempt)
-- ---------------------------------------------------------------------
create or replace function comunicacao_encerrar_processamento(
  p_id uuid, p_worker text, p_claim_geracao bigint, p_destino text,
  p_motivo text default null, p_disponivel_em timestamptz default null
)
returns setof comunicacao_mensagens
language sql
security invoker
set search_path = public
as $$
  update comunicacao_mensagens m
     set status = p_destino,
         erro = p_motivo,
         -- ADIAMENTO: nunca no passado (mínimo +1 min, evita loop apertado) e NÃO
         -- toca `tentativas`: nenhum attempt aconteceu.
         disponivel_em = case when p_destino = 'SCHEDULED'
                              then greatest(coalesce(p_disponivel_em, now() + interval '15 minutes'), now() + interval '1 minute')
                              else m.disponivel_em end,
         falhou_em = case when p_destino = 'FAILED' then now() else m.falhou_em end,
         erro_permanente = case when p_destino = 'FAILED' then true else m.erro_permanente end,
         updated_at = now()
   where m.id = p_id
     and m.status = 'PROCESSING'
     and m.claimed_by = p_worker
     and m.claim_geracao = p_claim_geracao
     and p_destino in ('BLOCKED', 'CANCELLED', 'FAILED', 'SCHEDULED')
  returning m.*;
$$;

comment on function comunicacao_encerrar_processamento(uuid, text, bigint, text, text, timestamptz) is
  'CAS de saída de PROCESSING sem enviar: BLOCKED (veto PERMANENTE de política), CANCELLED, FAILED, ou SCHEDULED (adiamento de condição transitória — disponivel_em mínimo +1min; NÃO consome attempt). 0 linhas = perdeu a posse (claim_geracao mudou).';

-- ---------------------------------------------------------------------
-- 6. Grants (mesmo modelo de 082: só service_role)
-- ---------------------------------------------------------------------
revoke all on function comunicacao_iniciar_envio(uuid, text, bigint, integer) from public, anon, authenticated;
revoke all on function comunicacao_finalizar_envio(uuid, text, bigint, integer, text, text, text, integer) from public, anon, authenticated;
revoke all on function comunicacao_encerrar_processamento(uuid, text, bigint, text, text, timestamptz) from public, anon, authenticated;
grant execute on function comunicacao_iniciar_envio(uuid, text, bigint, integer) to service_role;
grant execute on function comunicacao_finalizar_envio(uuid, text, bigint, integer, text, text, text, integer) to service_role;
grant execute on function comunicacao_encerrar_processamento(uuid, text, bigint, text, text, timestamptz) to service_role;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- PÓS-CHECK (execute isoladamente DEPOIS; nada aqui escreve)
-- ---------------------------------------------------------------------
--   select column_name from information_schema.columns
--     where table_name='comunicacao_mensagens' and column_name='claim_geracao';               -- 1 linha
--   select proname from pg_proc where proname in ('comunicacao_iniciar_envio',
--     'comunicacao_finalizar_envio','comunicacao_encerrar_processamento');                     -- 3 linhas
--   select grantee, routine_name from information_schema.role_routine_grants
--     where routine_name like 'comunicacao_%' and grantee in ('anon','authenticated','PUBLIC'); -- 0 linhas

commit;
