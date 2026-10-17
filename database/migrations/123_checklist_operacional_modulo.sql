-- =====================================================================
-- 123 — Módulo próprio `checklist_operacional` (Checklist Operacional independente do módulo `ifood`)
-- =====================================================================
-- OBJETIVO
--   O Checklist Operacional exigia o módulo `ifood` (mesmo sem usar a API: ele só lê `ifood_pedidos`). Esta migration
--   cria o módulo PRÓPRIO no catálogo, para o SuperAdmin liberar o painel a qualquer empresa/unidade pela tela de Acessos,
--   com ou sem integração iFood. Sem integração o painel abre com um aviso informativo (nenhum dado é inventado).
--
-- O QUE FAZ
--   1. Catálogo: insere `checklist_operacional` em `modulos` (idempotente).
--   2. COMPATIBILIDADE: quem JÁ tem o módulo `ifood` (já via o Checklist) ganha o módulo novo, na empresa
--      (`organizacao_modulos`) E na unidade (`unidade_modulos`) — o acesso efetivo é a INTERSEÇÃO das duas tabelas
--      (shared/modulos.js#modulosEfetivosDaUnidade). Ninguém perde acesso.
--   3. NÃO habilita nenhuma outra empresa/unidade: as demais continuam FECHADAS até o SuperAdmin decidir.
--
-- Sessões abertas antes desta migration não trazem o módulo novo (a sessão congela os módulos por até 8 h): o gate do
-- backend aceita `checklist_operacional` OU `ifood` durante a transição (routes.js).
--
-- PRÉ-REQUISITOS: migration 030 (modulos, organizacao_modulos) e 034 (unidade_modulos).
-- NUMERAÇÃO: a trilha financeira (branch integracao/gestao-financeira, ainda não integrada à main) ocupa 120, 121 e a planejada 122; o 123 é
-- o próximo livre e só é definitivo se continuar livre no merge (maior número existente em main + 1). Sem dependência de dados com ela.
-- IDEMPOTENTE. ROLLBACK: 123_rollback.sql.
-- =====================================================================

begin;

insert into modulos (id, nome, categoria, ordem) values
  ('checklist_operacional', 'Checklist Operacional', 'operacao', 17)
on conflict (id) do update set nome = excluded.nome, categoria = excluded.categoria, ordem = excluded.ordem;

-- Empresas que já têm `ifood`.
insert into organizacao_modulos (organizacao_id, modulo_id)
select om.organizacao_id, 'checklist_operacional'
from organizacao_modulos om
where om.modulo_id = 'ifood'
on conflict do nothing;

-- Unidades que já têm `ifood`.
insert into unidade_modulos (unidade_id, modulo_id)
select um.unidade_id, 'checklist_operacional'
from unidade_modulos um
where um.modulo_id = 'ifood'
on conflict do nothing;

commit;

-- VERIFICAÇÃO (rode separadamente):
--   select id, nome, categoria, ordem from modulos where id = 'checklist_operacional';           -- 1 linha
--   select count(*) from organizacao_modulos where modulo_id = 'checklist_operacional';           -- = empresas com ifood
--   select count(*) from organizacao_modulos where modulo_id = 'ifood';
--   select count(*) from unidade_modulos where modulo_id = 'checklist_operacional';               -- = unidades com ifood
