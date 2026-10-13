-- Rollback da 118 — remove a credencial OAuth própria por loja adicional e a loja-alvo da sessão OAuth.
--
-- Recusa se existir credencial própria `ativa`: a loja está (ou estaria) sendo consultada com ela; removê-la a faria voltar ao token da
-- conexão, que NÃO a cobre (403 = infração no iFood). Antes: desative a loja (estado `desativada`, operação supervisionada) ou apague
-- a credencial depois de parar a loja. Credenciais em `reauth_required` são descartadas junto.
--
-- ORDEM: a 118 depende da tabela da 117 (chave estrangeira). Para reverter as duas, rode ESTE rollback ANTES do 117_rollback.sql.
--
-- NÃO afeta a loja principal, a credencial da conexão (ifood_credenciais), os pedidos, os eventos nem a migration 117. Idempotente.
-- Checagem e remoção no MESMO bloco (se a checagem recusar, nada é removido).

do $$
declare
  em_uso bigint;
begin
  if to_regclass('public.ifood_loja_credenciais') is not null then
    execute 'select count(*) from public.ifood_loja_credenciais where status = ''ativa''' into em_uso;
    if em_uso > 0 then
      raise exception 'Rollback 118 abortado: existem % credencial(is) própria(s) de loja ativa(s). Pare/desative a loja antes.', em_uso;
    end if;
  end if;
  drop trigger if exists trg_ifood_oauth_sessoes_loja on public.ifood_oauth_sessoes;
  drop function if exists public.ifood_oauth_sessoes_loja_validar();
  drop index if exists public.idx_ifood_oauth_sessoes_loja;
  alter table public.ifood_oauth_sessoes drop column if exists loja_id;
  drop table if exists public.ifood_loja_credenciais;
  drop function if exists public.ifood_loja_credenciais_validar();
end $$;
