-- 160 — Camada central Foody: NOME do entregador em foody_pedidos (além do hash).
--
-- ADITIVA sobre a 147. Uma coluna anulável, sem default e sem preencher nada: as linhas existentes ficam com NULL até a próxima
-- sincronização (ou reprocessamento) com a flag FOODY_CENTRAL_ENTREGADOR_NOME_ENABLED=true. Com a flag desligada a aplicação
-- nunca lê nem grava a coluna.
-- Motivo: o proprietário precisa do nome para conferir e pagar os entregadores no Parser (10/11/2026). A API Foody já envia
-- `courier.courierName`; até aqui só o hash era guardado (minimização definida na validação de 03/11).
-- Acesso: a tabela continua com RLS ligado e sem policy (só service_role). O nome não entra em logs nem em respostas de sync.
-- Rollback: 160_rollback.sql (remove a coluna; os nomes guardados se perdem, o hash continua).

begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regclass('public.foody_pedidos') is null then
    raise exception '160: exige a migration 147 (camada central Foody)';
  end if;
end $$;

alter table public.foody_pedidos add column if not exists entregador_nome text;
alter table public.foody_pedidos drop constraint if exists ck_foody_pedidos_entregador_nome;
alter table public.foody_pedidos add constraint ck_foody_pedidos_entregador_nome
  check (entregador_nome is null or (length(entregador_nome) between 1 and 120 and entregador_presente));

comment on column public.foody_pedidos.entregador_nome is
  'Nome do entregador enviado pela Foody (courier.courierName). NULL = não guardado (flag desligada) ou sem entregador.';

commit;
