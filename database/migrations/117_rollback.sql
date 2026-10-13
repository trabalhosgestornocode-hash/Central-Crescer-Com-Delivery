-- Rollback da 117 — remove as lojas adicionais por conexão (ifood_conexao_lojas) e suas funções.
--
-- Recusa se houver loja `ativa` ou `liberada`: o poller está (ou estaria) consultando essa loja, e remover a tabela
-- faria o recebimento dela parar sem aviso. Desative-a antes (estado `desativada`) e confirme que o Gestor da loja está
-- acompanhado. Lojas `pendente`, `bloqueada` e `desativada` são descartadas junto com a tabela (o histórico de bloqueios some:
-- exporte antes se precisar).
--
-- A remoção NÃO afeta a loja principal (ifood_conexoes), os pedidos, os eventos, a credencial nem o Checklist: o poller ignora a
-- ausência da tabela e volta ao comportamento de uma loja por unidade. Os pedidos já gravados das lojas adicionais PERMANECEM.
-- Checagem e remoção no MESMO bloco (se a checagem recusar, nada é removido). Idempotente.

do $$
declare
  em_uso bigint;
begin
  if to_regclass('public.ifood_conexao_lojas') is not null then
    execute 'select count(*) from public.ifood_conexao_lojas where estado in (''ativa'', ''liberada'')' into em_uso;
    if em_uso > 0 then
      raise exception 'Rollback 117 abortado: existem % loja(s) adicional(is) ativa(s)/liberada(s). Desative-as (estado desativada) antes.', em_uso;
    end if;
  end if;
  drop function if exists public.ifood_loja_iniciar_verificacao(uuid, integer);
  drop function if exists public.ifood_loja_marcar_ativa(uuid);
  drop function if exists public.ifood_loja_bloquear(uuid, text);
  drop table if exists public.ifood_conexao_lojas;
  drop function if exists public.ifood_conexao_lojas_validar();
end $$;
