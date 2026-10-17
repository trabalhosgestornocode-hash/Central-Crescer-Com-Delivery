-- Rollback da 123 — remove o módulo `checklist_operacional` (catálogo + vínculos de empresa e de unidade).
--
-- ANTES: confirme que o backend/frontend publicados NÃO dependem mais do módulo novo (o gate do Checklist aceita
-- `checklist_operacional` OU `ifood` na transição; se o `OU ifood` já foi removido, volte o código ANTES de rodar isto,
-- senão empresas que só tinham o módulo novo perdem o Checklist). Quem tem `ifood` continua com acesso.
-- As FKs de organizacao_modulos/unidade_modulos apontam para modulos(id) com ON DELETE CASCADE, mas os deletes são
-- explícitos para não depender disso. Idempotente.

begin;
delete from unidade_modulos where modulo_id = 'checklist_operacional';
delete from organizacao_modulos where modulo_id = 'checklist_operacional';
delete from modulos where id = 'checklist_operacional';
commit;
