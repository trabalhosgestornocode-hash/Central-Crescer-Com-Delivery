-- =====================================================================
-- MIGRATION 113 — O papel de exibição é só de UMA UNIDADE (nunca de empresa, nunca duas unidades)
-- =====================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO SEM APROVAÇÃO EXPLÍCITA. Escrita e testada SÓ contra um Postgres local descartável.
-- ✅  ADITIVA: uma constraint CHECK em `usuarios_organizacoes` e um índice ÚNICO PARCIAL em `usuarios_unidades`.
--     Nenhuma linha existente as viola (o valor nem existia antes da 112). Rollback: 113_rollback.sql.
-- PRÉ-REQUISITO: a 112 já aplicada E COMMITADA. O Postgres não deixa USAR um valor de enum criado na MESMA transação
--     (erro 55P04 "unsafe use of new enum value"): por isso a 112 e a 113 são arquivos/transações separados — NÃO
--     junte as duas num único lote/transação (o runner do Supabase executa cada arquivo na própria transação: ok).
--
-- POR QUE:
--   * um vínculo de EMPRESA vale para TODAS as unidades dela e para o modo consolidado. O Operador de Exibição é uma
--     conta da TV de UMA unidade: se um dado fora do padrão lhe desse vínculo de empresa, ele enxergaria o que o papel
--     nunca deveria. O backend já recusa (sessao.service.js); a constraint fecha o caminho também no banco.
--   * a conta da TV entra sozinha na unidade quando o contexto vence (um único acesso). Com DUAS unidades a reentrada
--     passaria a pedir escolha manual: a conta de exibição é de UMA unidade (índice único por conta).
--
-- PUBLICAÇÃO SEGURA: `lock_timeout` curto — se houver transação longa segurando a tabela, esta migration FALHA em até
-- 5 s (sem aplicar nada) em vez de ficar na fila do Postgres bloqueando os logins que vêm atrás dela. Basta repetir.
-- =====================================================================
begin;
set local lock_timeout = '5s';
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('migration:113_papel_exibicao_somente_unidade', 0));

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint c
                  where c.conname = 'uo_sem_papel_exibicao'
                    and c.conrelid = 'public.usuarios_organizacoes'::pg_catalog.regclass) then
    alter table usuarios_organizacoes
      add constraint uo_sem_papel_exibicao check (papel <> 'display_operator'::papel_acesso);
  end if;
end $$;

create unique index if not exists uq_usuarios_unidades_exibicao_unica
  on usuarios_unidades (usuario_id) where papel = 'display_operator'::papel_acesso;

commit;
