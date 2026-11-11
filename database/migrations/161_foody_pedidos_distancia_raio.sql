-- 161 — Camada central Foody: DISTÂNCIA EM RAIO (km) em foody_pedidos.
--
-- ADITIVA sobre a 147. Uma coluna anulável, sem default e sem preencher nada: as linhas existentes ficam com NULL até a
-- próxima sincronização (ou reprocessamento) com a flag FOODY_CENTRAL_DISTANCIA_ENABLED=true. Flag desligada = a aplicação
-- nunca lê nem grava a coluna.
-- Motivo: a API Foody não envia distância, mas envia as coordenadas do ponto de coleta e do ponto de entrega; a coleta
-- calcula a linha reta (haversine, km com 2 casas) — o mesmo dado que o relatório Excel chama de "Distância raio (km)" —
-- e guarda SÓ o número. As coordenadas do cliente nunca são gravadas.
-- Acesso: a tabela continua com RLS ligado e sem policy (só service_role).
-- Rollback: 161_rollback.sql (remove a coluna; desligue a flag antes).

begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regclass('public.foody_pedidos') is null then
    raise exception '161: exige a migration 147 (camada central Foody)';
  end if;
end $$;

alter table public.foody_pedidos add column if not exists distancia_raio_km numeric(6,2);
alter table public.foody_pedidos drop constraint if exists ck_foody_pedidos_distancia_raio;
alter table public.foody_pedidos add constraint ck_foody_pedidos_distancia_raio
  check (distancia_raio_km is null or (distancia_raio_km >= 0 and distancia_raio_km <= 100));

comment on column public.foody_pedidos.distancia_raio_km is
  'Distância em raio (km, linha reta coleta→entrega) calculada das coordenadas da API Foody. NULL = não calculada (flag desligada) ou coordenada ausente.';

commit;
