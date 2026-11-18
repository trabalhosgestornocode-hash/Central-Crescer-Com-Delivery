-- =====================================================================================================================
-- Financeiro v2 — migração 0027: BLOQUEIO DA IDENTIDADE TÉCNICA independente de quem grava
--
-- Problema: o gatilho da 0026 consultava a sessão com os privilégios de quem gravava. Papéis sem acesso às sessões
-- (como o instalador) recebiam "permission denied" e não conseguiam criar a concessão técnica.
--
-- O que muda (e o que NÃO muda):
--   * A função do gatilho passa a rodar como fv2_guardiao, que já lê as sessões.
--   * Nenhum papel ganha acesso a fv2__sessao_vigente.
--   * A regra é a mesma: sessão da identidade técnica não altera as tabelas protegidas.
--   * Nenhum dado é alterado.
-- =====================================================================================================================

create or replace function fv2_bloquear_identidade_de_automacao() returns trigger
language plpgsql security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
begin
  if (select usuario_id from fv2__sessao_vigente()) = '00000000-0000-4000-8000-00000000e7e9'::uuid then
    raise exception 'FV2: a identidade técnica de entregadores não pode alterar %', tg_table_name using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
alter function fv2_bloquear_identidade_de_automacao() owner to fv2_guardiao;
revoke all on function fv2_bloquear_identidade_de_automacao() from public, fv2_app, fv2_autoridade;
