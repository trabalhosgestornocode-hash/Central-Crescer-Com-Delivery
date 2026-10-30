-- Rollback da 134 — remove convites, desafios, livro-razão de consentimento e termos.
-- ATENÇÃO: o livro-razão é PROVA de consentimento/revogação — exportar antes. As revogações já aplicadas (categorias desligadas,
-- opt-out) PERMANECEM: o rollback não reativa nada. Idempotente.
begin;
set local lock_timeout = '5s';
drop trigger if exists trg_comunicacao_dest_cat_revogada on comunicacao_destinatario_categorias;
drop trigger if exists trg_comunicacao_escopo_revogada on comunicacao_destinatario_escopos;
drop function if exists comunicacao_revogar(text, uuid[], text[], uuid, text, uuid, uuid, boolean, text);
drop function if exists comunicacao_titular_consentir(uuid, uuid, text[], integer, text, text, text);
drop function if exists comunicacao_desafio_verificar(uuid, text);
drop function if exists comunicacao_desafio_criar(text, uuid, text, text, text, text, boolean, integer);
drop function if exists comunicacao_bloquear_reativacao_revogada();
drop function if exists comunicacao_consentimento_vigente(uuid, text);
alter table if exists comunicacao_destinatario_escopos drop column if exists verificacao_simulada;
drop table if exists comunicacao_consentimentos;
drop table if exists comunicacao_desafios_titular;
drop table if exists comunicacao_convites;
drop function if exists comunicacao_convites_coerencia();
drop table if exists comunicacao_termos;
commit;
