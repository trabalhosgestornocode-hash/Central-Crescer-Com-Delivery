-- =====================================================================
-- MIGRATION 114 — O RLS não concede nada ao Operador de Exibição (conta da TV)
-- =====================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO SEM APROVAÇÃO EXPLÍCITA. Escrita e testada SÓ contra um Postgres local descartável.
-- PRÉ-REQUISITO: 112 aplicada E COMMITADA (o valor 'display_operator' precisa existir para a função ser criada).
--
-- ACHADO (6B.3): as policies `rls_*_tenant` (migration 016) liberam, para `authenticated`, TODAS as linhas das tabelas de
-- unidade a quem tem vínculo ATIVO em `usuarios_unidades`, sem olhar o papel — via `auth_unidade_ids()`. O backend usa
-- service_role e nem passa por isso, mas a chave `anon` é pública: a conta da TV, com o JWT guardado no navegador,
-- conseguiria falar DIRETO com a API REST do Supabase e ler (e, nas policies `for all`, escrever) vendas, estoque,
-- notas, bonificação etc. da unidade — furando a regra "só o Checklist". Vale para qualquer papel hoje (as policies são
-- cegas ao papel), mas só no Operador de Exibição isso contradiz o propósito da conta.
--
-- CORREÇÃO MÍNIMA: um único ponto de estrangulamento — `auth_unidade_ids()` deixa de devolver vínculos cujo papel é
-- 'display_operator'. Nenhuma policy muda. Quem tem outro papel (ou herda da empresa: papel NULL) continua igual.
-- A conta da TV não perde nada que use: o app dela passa só pelo backend (service_role) e o Realtime usa
-- `realtime_channel_grants` (outra tabela, outra policy).
-- ROLLBACK: 114_rollback.sql (restaura o corpo original da função).
-- =====================================================================
begin;
set local lock_timeout = '5s';

create or replace function public.auth_unidade_ids()
returns setof uuid
language sql stable security definer
set search_path to 'public'
as $$
  select unidade_id from usuarios_unidades
  where usuario_id = auth.uid() and ativo
    and papel is distinct from 'display_operator'::papel_acesso;
$$;

commit;
