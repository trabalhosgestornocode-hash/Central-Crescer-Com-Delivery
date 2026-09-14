-- =====================================================================
-- MIGRATION 080 — Realtime: grants efêmeros de canal (Etapa 1, infra)
-- =====================================================================
-- OBJETIVO
--   Autorizar canais PRIVADOS do Supabase Realtime (Broadcast) sem criar
--   um segundo sistema de assinatura de JWT: o frontend continua usando o
--   JWT normal da sessão Supabase Auth (setAuth com o access_token de
--   sempre); a autorização por tópico vem de uma tabela pequena que o
--   backend escreve DEPOIS de `requireContexto` validar sessão/contexto —
--   nunca do que o cliente declara.
--
--   Fonte da verdade continua sendo `sessoes_contexto` + `requireContexto`.
--   `realtime_channel_grants` NÃO é uma segunda fonte de autorização — é só
--   uma capacidade temporária DERIVADA daquele contexto, de vida curta
--   (config.realtimeCredentialTtlS, default 5 min), renovada pelo
--   RealtimeManager do frontend enquanto o contexto continuar válido.
--
-- POR QUE NÃO UM JWT CUSTOMIZADO (decisão registrada)
--   O projeto usa JWT Signing Keys assimétricas (ES256) para o Supabase
--   Auth — confirmado via o JWKS público do projeto antes desta migration.
--   Assinar um JWT próprio exigiria ou obter a chave privada do Supabase
--   (fora de questão) ou reativar/depender de um Legacy JWT Secret cujo
--   status real não estava confirmado — ambos alterariam ou criariam
--   dependência na infraestrutura de autenticação principal do Crescer só
--   para viabilizar Realtime. Esta migration evita isso por completo.
--
-- CHAVE PRIMÁRIA — por que (sessao_contexto_id, topico) e não (usuario_id, topico)
--   O Context Token vive em sessionStorage: duas ABAS da MESMA conta podem
--   ter contextos (empresa/unidade) diferentes e simultâneos, e CADA troca
--   de contexto (mesmo dentro da MESMA aba) emite um `sessoes_contexto.id`
--   novo (ver sessao.service.js#criarSessao — nunca reaproveita a linha).
--   Se a chave fosse (usuario_id, topico), a renovação/limpeza de uma aba
--   poderia apagar o grant de outra aba que aponte pro MESMO tópico. Com
--   (sessao_contexto_id, topico), cada contexto (cada aba, cada troca) tem
--   linhas próprias — uma nunca apaga a da outra. VALIDADO ponta a ponta
--   contra um Supabase de teste real: duas sessões simultâneas, troca de
--   unidade numa delas, revogação de uma sem afetar a outra.
--
-- POR QUE UMA FUNÇÃO SECURITY DEFINER (achado da validação ponta a ponta)
--   A primeira versão desta migration usava a tabela direto dentro do
--   `using` da policy de `realtime.messages` (`exists (select 1 from
--   realtime_channel_grants ...)`). Isso FALHOU no teste real: RLS roda
--   com o role de quem está perguntando (`authenticated`), não com o role
--   de quem criou a policy — e como `realtime_channel_grants` tem RLS
--   habilitada e ZERO policies para `authenticated`, a subquery via
--   `authenticated` nunca via linha nenhuma, mesmo com um grant válido
--   (EXISTS sempre `false`). A correção: uma função SECURITY DEFINER que
--   só devolve um boolean (nunca expõe linha) — ela lê a tabela com o
--   privilégio de quem a criou (bypassando a RLS do chamador), e
--   `authenticated` só ganha EXECUTE na função, nunca SELECT/INSERT/etc.
--   na tabela em si. Mantém exatamente a exigência de "nenhum acesso
--   direto de authenticated à tabela" — só muda COMO a checagem acontece.
--
-- LIMITAÇÃO CONHECIDA E ACEITA (documentada, não ignorada)
--   A policy só consegue checar `auth.uid()` (o JWT normal não carrega
--   qual aba/contexto está perguntando). Isso significa que, tecnicamente,
--   QUALQUER aba da MESMA conta que tenha um grant vivo para um tópico
--   pode receber aquele Broadcast — não só a aba que criou o grant. Isto é
--   aceito porque: (1) o grant só existe porque ESSA MESMA conta teve, em
--   algum momento nos últimos minutos, uma sessão de contexto validada por
--   `requireContexto` para aquele tópico — nunca é acesso de uma conta sem
--   nenhum vínculo; (2) o payload dos eventos é sempre mínimo (ids/data/
--   versão — nunca valor monetário ou nome, por design da taxonomia
--   aprovada); (3) o dado de negócio de verdade continua sendo buscado via
--   REST, sempre gated pelo Context Token daquela aba especificamente —
--   Realtime aqui é só sinal de "algo mudou", nunca a fonte do dado. A
--   janela de exposição é reduzida por esta migration NÃO depender só do
--   TTL: revogar uma sessão de contexto (troca de unidade/empresa, logout)
--   apaga os grants daquela sessão na hora (sessao.service.js#revogarSessoes).
--
-- CLEANUP / REVOGAÇÃO
--   `revogarSessoes()` (sessao.service.js) já é o ÚNICO lugar que marca
--   `sessoes_contexto.revogada_em` — passou a apagar, na mesma chamada, os
--   grants das sessões que revogou. TTL (`expira_em > now()`) é a rede de
--   segurança para o que não passou por essa revogação explícita.
--
-- SEGURANÇA (tudo validado ponta a ponta contra um Supabase de teste real)
--   * `authenticated`/`anon` têm os privilégios de tabela REVOGADOS por
--     completo em `realtime_channel_grants` (nem SELECT) — não dependem só
--     de RLS. Só `service_role` (que ignora RLS) e a função SECURITY
--     DEFINER leem essa tabela.
--   * A policy nova em `realtime.messages` restringe explicitamente
--     `extension = 'broadcast'` — testado: um grant de Broadcast NÃO
--     autoriza Presence (confirmado no log do Realtime:
--     "UnableToHandlePresence: :unauthorized").
--   * Nenhuma policy de INSERT em `realtime.messages` para `authenticated`
--     — testado: um cliente autenticado tentando inserir direto em
--     `realtime_channel_grants` recebe "permission denied" (após a
--     revogação de privilégio; antes da revogação, "violates row-level
--     security policy" — os dois são recusa, nenhum insere).
--
-- NÃO TOCA
--   * `realtime.messages` já vem com RLS habilitada pelo próprio Supabase —
--     esta migration NUNCA executa ALTER TABLE nela, só adiciona a policy.
--     Confirmado por leitura antes de aplicar: relrowsecurity já era true,
--     zero policies pré-existentes.
--   * Nenhuma Signing Key, nenhum JWT Secret, nenhuma configuração de Auth.
--   * Nenhuma tabela de negócio existente.
--
-- VALIDAÇÃO REALIZADA (projeto de teste descartável, antes de propor
-- aplicar em produção): tabela criada, RLS habilitada, zero policies
-- públicas na tabela de grants, policy de SELECT criada em
-- realtime.messages, zero policy de INSERT para authenticated, subscribe
-- autorizado com grant válido, subscribe negado sem grant, subscribe
-- negado com grant expirado, Broadcast real recebido pelo cliente
-- autorizado, Presence negado com o mesmo grant de Broadcast, INSERT pelo
-- cliente negado, 2 sessões/abas simultâneas com grants independentes,
-- troca de unidade numa sessão sem afetar a outra, revogação removendo só
-- os grants da sessão revogada, rollback executado com sucesso. Nenhuma
-- tabela de negócio foi alterada — só fixtures temporárias (usuário,
-- organização, unidades, sessões de teste), removidas ao final.
--
-- PRÉ-REQUISITOS: nenhum (schema `realtime` já existe, gerido pelo Supabase).
-- IDEMPOTENTE: pode ser reexecutada com segurança (create if not exists /
-- create or replace / drop policy if exists antes de recriar).
-- SEM novas extensões.
-- ROLLBACK: database/migrations/080_rollback.sql.
-- COMO USAR: Supabase -> SQL Editor -> cole o arquivo inteiro e execute.
-- =====================================================================
begin;

create table if not exists public.realtime_channel_grants (
  sessao_contexto_id uuid not null
    references public.sessoes_contexto(id) on delete cascade,
  topico     text not null,
  usuario_id uuid not null
    references auth.users(id) on delete cascade,
  expira_em  timestamptz not null,
  criado_em  timestamptz not null default now(),
  primary key (sessao_contexto_id, topico)
);

comment on table public.realtime_channel_grants is
  'Capacidade TEMPORÁRIA e derivada para assinar um canal privado do Realtime. NUNCA é fonte de autorização por si só — só existe depois de requireContexto validar sessoes_contexto. Escrita exclusiva do backend (service_role). Leitura só via public.tem_grant_realtime() (SECURITY DEFINER) — nenhum privilégio de tabela para authenticated/anon.';

create index if not exists idx_realtime_grants_usuario_topico
  on public.realtime_channel_grants (usuario_id, topico);

alter table public.realtime_channel_grants enable row level security;

-- Revoga explicitamente os privilégios padrão que o Supabase concede a
-- `anon`/`authenticated` em toda tabela nova do schema `public` — sem
-- isto, RLS sozinha já bastaria (zero policies = zero linha visível), mas
-- a revogação é defesa em profundidade: mesmo uma policy futura mal escrita
-- não abriria acesso direto por engano.
revoke all on public.realtime_channel_grants from authenticated, anon;

-- Função SECURITY DEFINER — o ÚNICO jeito de checar um grant sem dar
-- SELECT direto na tabela para `authenticated` (ver o comentário "POR QUE
-- UMA FUNÇÃO SECURITY DEFINER" acima). Só devolve um boolean.
create or replace function public.tem_grant_realtime(p_topico text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.realtime_channel_grants g
    where g.usuario_id = auth.uid()
      and g.topico = p_topico
      and g.expira_em > now()
  );
$$;

revoke all on function public.tem_grant_realtime(text) from public;
grant execute on function public.tem_grant_realtime(text) to authenticated;
-- `authenticated` PRECISA de EXECUTE (é quem a policy abaixo avalia); `anon`
-- não — sem isto, o advisor de segurança do Supabase aponta a função como
-- chamável por `anon` via RPC. Inofensivo na prática (auth.uid() é null
-- pra anon, então a função sempre devolve false, nunca vaza nada), mas
-- revogado mesmo assim por princípio de menor privilégio.
revoke execute on function public.tem_grant_realtime(text) from anon;

-- Autorização de Broadcast em realtime.messages — restrita à extensão
-- 'broadcast' e a um grant vivo (não expirado) para o mesmo tópico.
drop policy if exists "crescer_realtime_receber_broadcast_via_grant" on realtime.messages;
create policy "crescer_realtime_receber_broadcast_via_grant"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and public.tem_grant_realtime((select realtime.topic()))
);

commit;
