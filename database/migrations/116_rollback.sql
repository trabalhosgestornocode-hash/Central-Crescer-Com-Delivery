-- Rollback da 116 — remove o vínculo manual de merchant (ifood_merchant_vinculos).
--
-- Recusa se houver vínculo `validado`: nesse caso o merchant já foi gravado em ifood_conexoes e o
-- histórico de quem validou só existe nesta tabela. Exporte antes e remova manualmente.
-- Vínculos em aberto, rejeitados e cancelados são descartados junto com a tabela.
--
-- Checagem e remoção ficam no MESMO bloco de propósito: se a checagem recusar, a tabela não é removida
-- mesmo que o cliente SQL continue executando depois de um erro. Idempotente (sem a tabela, não faz nada).

do $$
declare
  validados bigint;
begin
  if to_regclass('public.ifood_merchant_vinculos') is null then
    return;
  end if;
  execute 'select count(*) from public.ifood_merchant_vinculos where estado = ''validado''' into validados;
  if validados > 0 then
    raise exception 'Rollback 116 abortado: existem % vínculo(s) manual(is) VALIDADO(S). Exporte o histórico antes e remova manualmente.', validados;
  end if;
  execute 'drop table public.ifood_merchant_vinculos';
end $$;
