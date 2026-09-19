-- ROLLBACK da migration 088. Remove tudo o que a 088 criou; a 082 e a 087 NÃO são tocadas
-- (o claim volta EXATAMENTE ao corpo da 087). A 088 não altera nenhum status de alerta,
-- então não há normalização de dados a desfazer.
-- Reverta o deploy do backend ANTES (o backend da 088 depende destas funções/tabela).
begin;
drop trigger if exists trg_comunicacao_mensagens_sincroniza_alerta on comunicacao_mensagens;
drop function if exists comunicacao_mensagens_sincroniza_alerta();
drop function if exists comunicacao_cancelar_expiradas(text);
drop function if exists comunicacao_reconciliar_entrega(uuid, uuid, text, text);
drop function if exists comunicacao_reservar_envio(uuid, text, bigint, integer, numeric, integer, integer, integer, timestamptz);
drop function if exists comunicacao_agendar_mensagem_alerta(uuid, text, text, text, timestamptz, timestamptz, integer);

-- restaura o claim EXATAMENTE como a 087 o definiu (sem o filtro expira_em, que some junto com a coluna)
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

alter table comunicacao_mensagens drop column if exists expira_em;
drop trigger if exists trg_comunicacao_habilitacoes_valida on comunicacao_habilitacoes;
drop trigger if exists trg_comunicacao_habilitacoes_upd on comunicacao_habilitacoes;
drop table if exists comunicacao_habilitacoes;
drop function if exists comunicacao_habilitacoes_valida();
notify pgrst, 'reload schema';
commit;
