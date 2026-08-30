-- =====================================================================
-- MIGRATION 057 — Contato da unidade (responsável + e-mail)
-- =====================================================================
-- OBJETIVO
--   A tela Configurações -> Dados da Unidade edita "Responsável" e
--   "E-mail" da loja, mas a tabela `unidades` não tinha coluna para nenhum
--   dos dois. Sem isso, o frontend mostrava o e-mail do USUÁRIO LOGADO como
--   se fosse o e-mail da loja (fallback errado em configuracoes.js) e o
--   "Responsável" não era salvo em lugar nenhum.
--
--   `responsavel` e `email` são dados da UNIDADE (uma linha por loja),
--   nunca da organização nem do usuário. A edição pelo tenant é escopada
--   por `req.tenant.unidadeId` (Context Token) — ver
--   backend/src/modules/unidade/unidade.service.js#atualizarDados.
--
-- NÃO DESTRUTIVO / IDEMPOTENTE / REVERSÍVEL.
--   - Colunas nullable, sem default além de NULL, sem constraint, sem FK,
--     sem índice. `ADD COLUMN` nullable no Postgres é metadata-only
--     (instantâneo, sem reescrever a tabela, sem lock longo).
--   - Nenhum backfill: toda unidade existente fica com responsavel/email
--     NULL até alguém preencher pela tela.
--
-- IMPACTO NOS DADOS ATUAIS: nenhum. Vínculos, catálogo (produtos/insumos/
--   ficha técnica), histórico e sessões não são tocados.
--
-- ROLLBACK:
--     alter table unidades drop column if exists responsavel;
--     alter table unidades drop column if exists email;
--   (perde apenas o que foi digitado após o deploy desta migration.)
--
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
--   NÃO executar automaticamente em produção.
-- =====================================================================

alter table unidades add column if not exists responsavel text;
alter table unidades add column if not exists email       text;

comment on column unidades.responsavel is 'Nome do responsável pela loja (Configurações -> Dados da Unidade). Dado da UNIDADE.';
comment on column unidades.email       is 'E-mail de contato da loja (Configurações -> Dados da Unidade). Dado da UNIDADE, nunca o e-mail do usuário logado.';
