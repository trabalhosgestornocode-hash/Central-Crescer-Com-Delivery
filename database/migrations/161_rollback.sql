-- Rollback da 161 — remove a distância em raio de foody_pedidos. Desligue antes a flag FOODY_CENTRAL_DISTANCIA_ENABLED:
-- com a coluna removida e a flag ligada, a sincronização falharia ao gravar.
begin;
set local lock_timeout = '5s';
alter table public.foody_pedidos drop constraint if exists ck_foody_pedidos_distancia_raio;
alter table public.foody_pedidos drop column if exists distancia_raio_km;
commit;
