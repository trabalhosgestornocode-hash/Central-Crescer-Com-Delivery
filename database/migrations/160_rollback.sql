-- Rollback da 160 — remove o nome do entregador de foody_pedidos (o hash continua). Desligue antes a flag
-- FOODY_CENTRAL_ENTREGADOR_NOME_ENABLED: com a coluna removida e a flag ligada, a sincronização falharia ao gravar.
begin;
set local lock_timeout = '5s';
alter table public.foody_pedidos drop constraint if exists ck_foody_pedidos_entregador_nome;
alter table public.foody_pedidos drop column if exists entregador_nome;
commit;
