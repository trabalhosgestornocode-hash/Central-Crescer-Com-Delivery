-- Rollback da 119 — volta a exigir servicos_promocoes >= 0 (sem crédito).
--
-- Recusa se já houver crédito gravado (valor negativo) em qualquer das duas
-- tabelas: recriar o CHECK falharia e, pior, converter o crédito em custo
-- mudaria o resultado financeiro do mês. Revise esses lançamentos antes.
--
-- Checagem e recriação no MESMO bloco de propósito. Idempotente.

do $$
declare
  negativos bigint;
begin
  select (select count(*) from public.lancamentos_financeiros_diarios where servicos_promocoes < 0)
       + (select count(*) from public.lancamentos_financeiros_canais where servicos_promocoes < 0)
    into negativos;
  if negativos > 0 then
    raise exception 'Rollback 119 abortado: existem % lançamento(s) com Serviços e Promoções como CRÉDITO (negativo). Revise-os antes.', negativos;
  end if;

  alter table public.lancamentos_financeiros_diarios drop constraint if exists lfd_servicos_promocoes_check;
  alter table public.lancamentos_financeiros_diarios
    add constraint lfd_servicos_promocoes_check check (servicos_promocoes is null or servicos_promocoes >= 0);

  alter table public.lancamentos_financeiros_canais drop constraint if exists lancamentos_financeiros_canais_servicos_promocoes_check;
  alter table public.lancamentos_financeiros_canais
    add constraint lancamentos_financeiros_canais_servicos_promocoes_check check (servicos_promocoes is null or servicos_promocoes >= 0);
end $$;

comment on column public.lancamentos_financeiros_diarios.servicos_promocoes is null;
comment on column public.lancamentos_financeiros_canais.servicos_promocoes is null;
