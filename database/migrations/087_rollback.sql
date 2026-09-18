-- ROLLBACK da migration 087 (claim × attempt + fencing).
--   * remove as 3 funções novas e o trigger de monotonicidade;
--   * RESTAURA o corpo do claim da migration 082 (que incrementa `tentativas`);
--   * remove a coluna claim_geracao.
-- Depois do rollback, o código do backend que usa as funções novas deixa de
-- funcionar — reverta o deploy do backend ANTES. Linhas em SENDING/
-- DELIVERY_UNKNOWN permanecem como estão (a coluna `tentativas` não é alterada).
begin;

drop function if exists comunicacao_iniciar_envio(uuid, text, bigint, integer);
drop function if exists comunicacao_finalizar_envio(uuid, text, bigint, integer, text, text, text, integer);
drop function if exists comunicacao_encerrar_processamento(uuid, text, bigint, text, text, timestamptz);
-- assinaturas de iterações de desenvolvimento (no-op em produção)
drop function if exists comunicacao_iniciar_envio(uuid, text, integer, integer);
drop function if exists comunicacao_finalizar_envio(uuid, text, integer, text, text, text, integer);
drop function if exists comunicacao_encerrar_processamento(uuid, text, integer, text, text, timestamptz);

drop trigger if exists trg_comunicacao_mensagens_tokens_monotonicos on comunicacao_mensagens;
drop function if exists comunicacao_mensagens_tokens_monotonicos();

-- Claim da 082, byte a byte (incrementa `tentativas` no claim).
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
      tentativas = m.tentativas + 1,
      updated_at = now()
  from candidatos c
  where m.id = c.id
  returning m.*;
$$;

comment on function comunicacao_claim_mensagens(integer, text, integer) is
  'Claim ATÔMICO de até p_limite mensagens elegíveis (SCHEDULED disponíveis, ou PROCESSING com lease expirado — worker abandonado), via FOR UPDATE SKIP LOCKED numa única instrução. Concede um lease de p_lease_segundos (default 120s). Dois workers chamando ao mesmo tempo nunca reivindicam a mesma linha. NUNCA reivindica SENDING (ver comunicacao_expirar_entregas_incertas). Chamada só pelo backend (service_role) — ver auditoria de segurança no comentário acima.';

revoke all on function comunicacao_claim_mensagens(integer, text, integer) from public, anon, authenticated;
grant execute on function comunicacao_claim_mensagens(integer, text, integer) to service_role;

alter table comunicacao_mensagens drop column if exists claim_geracao;
comment on column comunicacao_mensagens.tentativas is null;

notify pgrst, 'reload schema';
commit;
