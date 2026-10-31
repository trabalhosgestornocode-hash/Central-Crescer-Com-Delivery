-- Rollback da 135 — remove as cotas próprias das categorias novas. O D-1 não é afetado (nunca teve cota própria). Idempotente.
begin;
set local lock_timeout = '5s';
drop function if exists comunicacao_cota_categoria_disponivel(text, uuid, uuid, uuid, timestamptz);
alter table if exists comunicacao_categorias drop constraint if exists comunicacao_categorias_d1_sem_cota_propria;
alter table if exists comunicacao_categorias drop constraint if exists comunicacao_categorias_cota_valida;
drop function if exists comunicacao_cota_valida(jsonb);
alter table if exists comunicacao_categorias drop column if exists cota;
commit;
