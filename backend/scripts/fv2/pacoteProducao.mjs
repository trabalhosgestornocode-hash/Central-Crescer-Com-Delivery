#!/usr/bin/env node
// PACOTE DE INSTALAÇÃO do Financeiro v2 no projeto Supabase EXISTENTE (schema dedicado `financeiro_v2`).
//
// Só GERA arquivos; não conecta em banco nenhum. A aplicação em produção exige autorização específica e é feita por um
// mecanismo oficial (ex.: apply_migration do Supabase, que roda como `postgres` numa transação).
//
//   node scripts/fv2/pacoteProducao.mjs            → escreve database/financeiro-v2/producao/*.sql
//   node scripts/fv2/pacoteProducao.mjs --conferir → só confere que os arquivos versionados estão em dia (exit 1 se não)
//
// Conteúdo:
//   instalar.sql   — UMA transação: pré-condições (aborta se o schema ou os papéis já existirem, se o executor for
//                    superusuário ou não tiver CREATEROLE), adaptações A1–A4, as 21 migrações (texto aplicado),
//                    registro nome + hash do arquivo + hash aplicado, e PÓS-CONDIÇÕES que abortam tudo se falharem
//                    (RLS, nenhum acesso de anon/authenticated/service_role/authenticator, funções protegidas do
//                    guardião, guardião sem participação utilizável, nada criado fora do schema além dos 3 papéis).
//   inventario.sql — consulta SÓ-LEITURA que fotografa (sha256) objetos, ACLs, políticas, privilégios padrão e papéis
//                    de fora do Financeiro v2: rodar ANTES e DEPOIS e comparar (C0).
//   desativar.sql  — reversão NÃO destrutiva: tira o acesso de login/uso dos papéis do módulo; dados e objetos ficam.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ESQUEMA_FINANCEIRO, PASTA_DE_MIGRACOES, listarMigracoes, sqlSemExecucaoPublica, textoAplicado } from "./ambiente.mjs";

const S = ESQUEMA_FINANCEIRO;
const PAPEIS = ["fv2_app", "fv2_autoridade", "fv2_guardiao"];
const DESTINO = resolve(PASTA_DE_MIGRACOES, "..", "producao");
const sha = (t) => createHash("sha256").update(t).digest("hex");
const literal = (t) => `'${t.replaceAll("'", "''")}'`;

/** @param {string|null} [ate] gera a instalação só até esta migração (ex.: "0021" = o que está em produção desde 15/11) */
export function instalar(ate = null) {
  const ms = listarMigracoes().filter((m) => !ate || m.nome.slice(0, 4) <= ate);
  const partes = [
    `-- Financeiro v2 — INSTALAÇÃO no schema dedicado ${S} (gerado por backend/scripts/fv2/pacoteProducao.mjs; NÃO editar à mão).`,
    "-- Aplicar como `postgres` (não superusuário, com CREATEROLE), numa ÚNICA transação. Qualquer falha desfaz tudo.",
    `-- Migrações: ${ms.map((m) => m.nome).join(", ")}`,
    "",
    "-- ===================================================================================== pré-condições (abortam)",
    `do $$ begin
  if exists (select 1 from pg_namespace where nspname = '${S}') then raise exception 'FV2 instalação: schema ${S} já existe — nada foi feito'; end if;
  if exists (select 1 from pg_roles where rolname like 'fv2\\_%') then raise exception 'FV2 instalação: já existem papéis fv2_* — nada foi feito'; end if;
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception 'FV2 instalação: não aplicar como superusuário'; end if;
  if not (select rolcreaterole from pg_roles where rolname = current_user) then raise exception 'FV2 instalação: o executor precisa de CREATEROLE'; end if;
  if current_setting('server_version_num')::int < 130000 then raise exception 'FV2 instalação: PostgreSQL 13+ exigido'; end if;
  -- A-2 (auditoria do Agente 2): publicação FOR ALL TABLES incluiria AUTOMATICAMENTE as tabelas do v2 na replicação lógica
  -- (Realtime). A publicação é da plataforma: a instalação PARA antes de qualquer alteração e a decisão é humana.
  if exists (select 1 from pg_publication where puballtables) then
    raise exception 'FV2 instalação: existe publicação FOR ALL TABLES (%) — as tabelas do v2 entrariam na replicação; nada foi feito',
      (select string_agg(pubname, ', ') from pg_publication where puballtables);
  end if;
end $$;`,
    "",
    "-- ================================================================================ A1/A4: schema, papéis, uso",
    `create schema ${S};`,
    `revoke all on schema ${S} from public;`,
    ...PAPEIS.map((r) => `create role ${r} nologin;`),
    `grant usage on schema ${S} to ${PAPEIS.join(", ")};`,
    `create table ${S}.fv2_migracao (nome text primary key, sha256 text not null, sha256_aplicado text, aplicada_em timestamptz not null default now());`,
    `set local search_path = ${S}, pg_catalog;`,
    "",
  ];
  for (const m of ms) {
    const t = textoAplicado(m.sql, S);
    // A3: participação temporária no guardião + CREATE temporário no schema, para toda migração que pode transferir ou
    // recriar função dele (da 0011 em diante); revogados logo depois, dentro da mesma transação.
    const a3 = m.nome >= "0011";
    partes.push(`-- ------------------------------------------------------------------------- ${m.nome} (arquivo ${m.sha256})`);
    if (a3) partes.push(`grant fv2_guardiao to current_user; grant create on schema ${S} to fv2_guardiao;`);
    partes.push(t.trimEnd());
    if (a3) partes.push(`revoke create on schema ${S} from fv2_guardiao; revoke fv2_guardiao from current_user;`);
    // Tabela temporária "on commit drop" das migrações (0012, 0013): numa transação ÚNICA ela sobreviveria até o fim e a
    // próxima migração colidiria. Descartá-la ao fim da própria migração reproduz o efeito do commit individual.
    for (const [, nome] of t.matchAll(/create\s+temporary\s+table\s+([a-z0-9_]+)/gi)) partes.push(`drop table if exists pg_temp.${nome};`);
    partes.push(`insert into ${S}.fv2_migracao (nome, sha256, sha256_aplicado) values (${literal(m.nome)}, ${literal(m.sha256)}, ${literal(sha(t))});`, "");
  }
  partes.push("-- ======================================================== A5: nenhuma função do módulo executável por PUBLIC", `${sqlSemExecucaoPublica(S)};`, "");
  partes.push(
    "-- ======================================================================= A5: revogação explícita (Agente 2, A-1)",
    "-- Privilégio padrão GLOBAL do executor (sem IN SCHEMA) não se revoga por schema e daria às credenciais comuns acesso",
    "-- aos objetos criados acima. Não se confia só na falta de USAGE: retira-se tudo explicitamente. As funções protegidas",
    "-- são do guardião: a revogação usa a MESMA participação temporária da A3, desfeita na sequência.",
    `grant fv2_guardiao to current_user;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated','service_role','authenticator'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema ${S} from %I', r);
      execute format('revoke all on all sequences in schema ${S} from %I', r);
      execute format('revoke all on all functions in schema ${S} from %I', r);
    end if;
  end loop;
end $$;
revoke fv2_guardiao from current_user;`,
    "",
    "-- ===================================================================================== pós-condições (abortam)",
    `do $$
declare n int; txt text;
begin
  select count(*) into n from ${S}.fv2_migracao;
  if n <> ${ms.length} then raise exception 'FV2 pós: % migrações registradas (esperado ${ms.length})', n; end if;
  -- nada do módulo fora do schema dedicado
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace where c.relname like 'fv2\\_%' and s.nspname <> '${S}' and s.nspname not like 'pg\\_%';
  if n > 0 then raise exception 'FV2 pós: % relações fv2_* fora do schema', n; end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where p.proname like 'fv2\\_%' and s.nspname <> '${S}';
  if n > 0 then raise exception 'FV2 pós: % funções fv2_* fora do schema', n; end if;
  -- RLS forçada em todas as tabelas de dados (as 5 GUARDADAS não têm RLS por desenho e nenhum papel além do guardião as acessa)
  select string_agg(c.relname, ', ') into txt from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = '${S}' and c.relkind = 'r' and c.relname <> 'fv2_migracao'
      and c.relname not in ('fv2_auditoria_concessao','fv2_liberacao','fv2_liberacao_historico','fv2_administrador_corporativo','fv2_administrador_corporativo_historico','fv2_provisionamento_inicial','fv2_sessao_banco')
      and not (c.relrowsecurity and c.relforcerowsecurity);
  if txt is not null then raise exception 'FV2 pós: tabelas sem RLS forçada: %', txt; end if;
  -- credenciais comuns sem nenhum caminho
  select string_agg(r, ', ') into txt from unnest(array['anon','authenticated','service_role','authenticator']) r
    where exists (select 1 from pg_roles where rolname = r) and has_schema_privilege(r, '${S}', 'usage');
  if txt is not null then raise exception 'FV2 pós: USAGE no schema para %', txt; end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace,
    unnest(array['anon','authenticated','service_role','authenticator','fv2_app','fv2_autoridade']) g(r)
    where s.nspname = '${S}' and exists (select 1 from pg_roles where rolname = g.r)
      and c.relname in ('fv2_auditoria_concessao','fv2_liberacao','fv2_liberacao_historico','fv2_administrador_corporativo','fv2_administrador_corporativo_historico','fv2_provisionamento_inicial','fv2_sessao_banco')
      and (has_table_privilege(g.r, c.oid, 'select') or has_table_privilege(g.r, c.oid, 'insert') or has_table_privilege(g.r, c.oid, 'update') or has_table_privilege(g.r, c.oid, 'delete'));
  if n > 0 then raise exception 'FV2 pós: tabela guardada acessível por papel não autorizado (% casos)', n; end if;
  -- A5: NENHUM privilégio de credencial comum em tabela, sequência ou função do schema (não só falta de USAGE).
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace,
    lateral aclexplode(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) x
    where s.nspname = '${S}' and c.relkind in ('r','p','v','m','S')
      and (x.grantee = 0 or pg_get_userbyid(x.grantee) in ('anon','authenticated','service_role','authenticator'));
  if n > 0 then raise exception 'FV2 pós: % privilégio(s) de PUBLIC ou credencial comum em tabela/sequência do schema', n; end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace,
    lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    where s.nspname = '${S}' and pg_get_userbyid(x.grantee) in ('anon','authenticated','service_role','authenticator');
  if n > 0 then raise exception 'FV2 pós: % EXECUTE concedido a credencial comum em função do schema', n; end if;
  -- A-2: nenhuma tabela do v2 em publicação de replicação.
  select count(*) into n from pg_publication_tables where schemaname = '${S}';
  if n > 0 then raise exception 'FV2 pós: % tabela(s) do v2 em publicação de replicação', n; end if;
  -- funções protegidas: dono guardião, search_path no schema, sem EXECUTE para PUBLIC nem credenciais comuns
  select string_agg(p.oid::regprocedure::text, ', ') into txt from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = '${S}' and p.prosecdef and (
      pg_get_userbyid(p.proowner) <> 'fv2_guardiao'
      or not (p.proconfig::text like '%search_path=pg_catalog, ${S}, pg_temp%')
      or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0 and x.privilege_type = 'EXECUTE')
      or exists (select 1 from unnest(array['anon','authenticated','service_role']) g(r) where exists (select 1 from pg_roles where rolname = g.r) and has_function_privilege(g.r, p.oid, 'execute')));
  if txt is not null then raise exception 'FV2 pós: função protegida fora da regra: %', txt; end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = '${S}' and p.prosecdef;
  if n < 8 then raise exception 'FV2 pós: só % funções protegidas (esperado ≥ 8)', n; end if;
  -- A-1: NENHUMA função do schema (protegida ou não) executável pelas credenciais comuns
  select string_agg(p.oid::regprocedure::text || ':' || g.r, ', ') into txt from pg_proc p join pg_namespace s on s.oid = p.pronamespace,
    unnest(array['anon','authenticated','service_role','authenticator']) g(r)
    where s.nspname = '${S}' and exists (select 1 from pg_roles where rolname = g.r) and has_function_privilege(g.r, p.oid, 'execute');
  if txt is not null then raise exception 'FV2 pós: função executável por credencial comum: %', txt; end if;
  -- A-2: nenhuma tabela do módulo em publicação de replicação/tempo real
  select count(*) into n from pg_publication_tables where schemaname = '${S}';
  if n > 0 then raise exception 'FV2 pós: % tabelas do módulo em publicação de replicação', n; end if;
  -- guardião: nenhum membro com SET ou INHERIT; sem CREATE no schema
  select count(*) into n from pg_auth_members m join pg_roles r on r.oid = m.roleid where r.rolname = 'fv2_guardiao' and (m.set_option or m.inherit_option);
  if n > 0 then raise exception 'FV2 pós: guardião com participação utilizável'; end if;
  if has_schema_privilege('fv2_guardiao', '${S}', 'create') then raise exception 'FV2 pós: guardião com CREATE no schema'; end if;
  -- nenhum papel de LOGIN criado aqui (os de conexão são criados depois, por decisão própria, com senha fora do Git)
  select count(*) into n from pg_roles where rolname like 'fv2\\_%' and rolcanlogin;
  if n > 0 then raise exception 'FV2 pós: papel fv2_* com login'; end if;
end $$;`,
    "",
  );
  return partes.join("\n");
}

const INVENTARIO = `-- Financeiro v2 — FOTO do sistema atual (SÓ LEITURA). Rodar antes e depois da instalação: o hash deve ser IGUAL.
-- Exclui só o que é do Financeiro v2 (schema ${S}, papéis fv2_*) e esquemas temporários.
with foto as (
  select 'schema' k, nspname || '|' || nspowner::regrole::text || '|' || coalesce(nspacl::text, '') v from pg_namespace where nspname <> '${S}' and nspname !~ '^pg_(toast_)?temp_'
  union all select 'rel', n.nspname || '.' || c.relname || '|' || c.relkind::text || '|' || c.relowner::regrole::text || '|' || coalesce(c.relacl::text, '') || '|' || c.relrowsecurity::text || c.relforcerowsecurity::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('${S}', 'pg_toast', 'pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast_)?temp_'
  union all select 'func', p.oid::regprocedure::text || '|' || p.proowner::regrole::text || '|' || coalesce(p.proacl::text, '') || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('${S}', 'pg_catalog', 'information_schema')
  union all select 'pol', schemaname || '.' || tablename || '.' || policyname || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '') from pg_policies where schemaname <> '${S}'
  union all select 'dacl', defaclrole::regrole::text || '|' || defaclnamespace::text || '|' || defaclobjtype::text || '|' || coalesce(defaclacl::text, '') from pg_default_acl
  union all select 'role', rolname || '|' || rolsuper::text || rolcreaterole::text || rolbypassrls::text || rolcanlogin::text || rolinherit::text from pg_roles where rolname !~ '^(fv2_|pg_)'
  union all select 'memb', r.rolname || '>' || m.rolname || '|' || x.admin_option::text || x.inherit_option::text || x.set_option::text
    from pg_auth_members x join pg_roles r on r.oid = x.roleid join pg_roles m on m.oid = x.member where r.rolname !~ '^fv2_' and m.rolname !~ '^fv2_'
  union all select 'trg', tgrelid::regclass::text || '.' || tgname || '|' || tgenabled::text from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname <> '${S}'
)
select count(*) as itens, encode(sha256(convert_to(string_agg(k || ':' || v, E'\\n' order by k, v), 'UTF8')), 'hex') as sha256 from foto;
`;

const DESATIVAR = `-- Financeiro v2 — DESATIVAÇÃO NÃO DESTRUTIVA. Nada é apagado: dados, tabelas, funções e histórico ficam.
-- 1) A liberação por unidade é desligada pela própria aplicação (fv2_liberacao_alterar, com a autoridade).
-- 2) Este arquivo corta o acesso dos papéis de conexão do módulo (se existirem) e o uso do schema.
do $$ declare r text; begin
  for r in select rolname from pg_roles where rolname like 'fv2\\_%' and rolcanlogin loop
    execute format('alter role %I nologin', r);
  end loop;
end $$;
revoke usage on schema ${S} from fv2_app, fv2_autoridade;
-- Reativar: grant usage on schema ${S} to fv2_app, fv2_autoridade; alter role <papel de conexão> login;
`;

/**
 * ESCOPO DA UNIDADE (passo da ativação, como `postgres`): registra o par empresa+unidade em que o v2 pode operar. Os
 * IDs vêm da página de ativação (contexto da SESSÃO do administrador), nunca digitados de memória; o SQL confere que a
 * unidade existe e pertence à empresa na tabela da plataforma, e é idempotente. Não libera nada (a liberação é outro ato).
 */
export function sqlEscopoDaUnidade(organizacaoId, unidadeId, rotulo = "Açaí no Grau Saci") {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(organizacaoId) || !uuid.test(unidadeId)) throw new Error("IDs de empresa/unidade inválidos.");
  if (!/^[\p{L}\p{N} ().-]{1,120}$/u.test(rotulo)) throw new Error("Rótulo inválido.");
  const o = organizacaoId.toLowerCase();
  const u = unidadeId.toLowerCase();
  return `-- Financeiro v2 — ESCOPO da unidade ${u} (empresa ${o}). Uma transação, como postgres.
do $$ begin
  if not exists (select 1 from public.unidades where id = '${u}'::uuid and organizacao_id = '${o}'::uuid) then
    raise exception 'FV2 escopo: a unidade não existe ou não pertence a esta empresa — nada foi feito';
  end if;
  if (select count(*) from financeiro_v2.fv2_migracao) < 21 then raise exception 'FV2 escopo: o Financeiro v2 não está instalado'; end if;
end $$;
insert into financeiro_v2.fv2_escopo (organizacao_id, unidade_id, rotulo) values ('${o}'::uuid, '${u}'::uuid, ${literal(rotulo)})
  on conflict (organizacao_id, unidade_id) do nothing;
select organizacao_id, unidade_id, rotulo, criado_em from financeiro_v2.fv2_escopo where organizacao_id = '${o}'::uuid and unidade_id = '${u}'::uuid;
`;
}

/** Concessão mínima (ver + registrar) da identidade técnica de entregadores, em UMA unidade. Gera o SQL; não executa nada. */
export function sqlConcessaoDeAutomacao(organizacaoId, unidadeId) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(organizacaoId) || !uuid.test(unidadeId)) throw new Error("IDs de empresa/unidade inválidos.");
  const [o, u, p] = [organizacaoId.toLowerCase(), unidadeId.toLowerCase(), "00000000-0000-4000-8000-00000000e7e9"];
  const just = "Identidade técnica exclusiva do fechamento semanal de entregadores próprios.";
  return `set local search_path = ${S}, pg_catalog, public;
with nova as (
  insert into fv2_concessao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, chave_idempotencia, impressao, extras, usuario_id, acoes, situacao, concedido_por, justificativa)
  values (gen_random_uuid(), '${o}', '${u}', 1, now(), '${EXECUTOR_BOOTSTRAP}', now(), '${EXECUTOR_BOOTSTRAP}', 'concessao:${p}', null, '{}'::jsonb, '${p}', '["financeiro_v2.registrar","financeiro_v2.ver"]'::jsonb, 'ATIVA', '${EXECUTOR_BOOTSTRAP}', ${literal(just)})
  on conflict do nothing returning *)
insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'CRIACAO', null, jsonb_build_object('versao', 1, 'acoes', acoes, 'situacao', situacao), justificativa, concedido_por, now() from nova;
`;
}

/** Executor sintético do bootstrap (não é conta da plataforma; o papel de banco real fica em papel_de_banco). */
export const EXECUTOR_BOOTSTRAP = "00000000-0000-4000-8000-0000000b0075";

// ------------------------------------------------------------------------------------------------ MOVA (16A/16C)
/** Identidade técnica do MOVA no Financeiro v2 (a mesma da migração 0028 e de fv2-integracao/leitorMova.js). */
export const IDENTIDADE_DO_MOVA = "00000000-0000-4000-8000-00000000a0a0";
const UUID_MOVA = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAPEIS_DO_MODULO_RESERVADOS = ["fv2_app", "fv2_autoridade", "fv2_guardiao", "fv2_leitor_mova"];
function exigirPapelDoLeitor(papel) {
  if (typeof papel !== "string" || !/^fv2_[a-z0-9_]{1,40}$/.test(papel) || PAPEIS_DO_MODULO_RESERVADOS.includes(papel) || /^fv2_(app|autoridade)_login/.test(papel)) {
    throw new Error("Nome inválido para o papel de login do leitor do MOVA (use fv2_mova_<sufixo>; nunca o de outro papel do módulo).");
  }
  return papel;
}

/**
 * Concessão SOMENTE-LEITURA ("ver") da identidade do MOVA em UMA unidade: concessão + histórico, no formato do núcleo e
 * como a dos entregadores. Recusa se a unidade não está no Financeiro v2, se a 0028 não foi aplicada ou se a identidade já
 * tem concessão ativa em OUTRA unidade (o piloto é de uma unidade só). Idempotente. Gera o SQL; não executa nada.
 */
export function sqlConcessaoDoMova(organizacaoId, unidadeId, { alemDe = [] } = {}) {
  if (!UUID_MOVA.test(organizacaoId) || !UUID_MOVA.test(unidadeId)) throw new Error("IDs de empresa/unidade inválidos.");
  // 23/11: unidade ADICIONAL (ex.: Subway além do Açaí) só com a lista EXATA das unidades já autorizadas (conferida no banco).
  if (!Array.isArray(alemDe) || !alemDe.every((x) => UUID_MOVA.test(x))) throw new Error("Lista de unidades já autorizadas inválida.");
  const [o, u, p] = [organizacaoId.toLowerCase(), unidadeId.toLowerCase(), IDENTIDADE_DO_MOVA];
  const ja = [...new Set(alemDe.map((x) => x.toLowerCase()))].filter((x) => x !== u).sort();
  const just = ja.length ? "Identidade técnica do MOVA: consultas somente-leitura (unidade adicional autorizada pelo proprietário)."
    : "Identidade técnica do MOVA: consultas somente-leitura (piloto de uma unidade).";
  const outras = ja.length
    ? `  if coalesce((select array_agg(unidade_id::text order by unidade_id::text) from fv2_concessao where usuario_id = '${p}' and situacao = 'ATIVA' and unidade_id <> '${u}'), '{}') <> array[${ja.map((x) => `'${x}'`).join(", ")}]::text[] then raise exception 'MOVA: as concessões ativas da identidade não são exatamente as unidades informadas em --alem-de — nada foi feito'; end if;
  if exists (select 1 from fv2_concessao where usuario_id = '${p}' and situacao = 'ATIVA' and acoes <> '["financeiro_v2.ver"]'::jsonb) then raise exception 'MOVA: há concessão da identidade com ação além de ver — nada foi feito'; end if;`
    : `  if exists (select 1 from fv2_concessao where usuario_id = '${p}' and situacao = 'ATIVA' and unidade_id <> '${u}') then raise exception 'MOVA: a identidade já tem concessão ativa em outra unidade (o piloto é de uma só) — nada foi feito'; end if;`;
  return `set local search_path = ${S}, pg_catalog, public;
do $$ begin
  if not exists (select 1 from pg_proc where proname = 'fv2_abrir_sessao_mova') then raise exception 'MOVA: a migração 0028 não foi aplicada — nada foi feito'; end if;
  if not exists (select 1 from fv2_escopo where organizacao_id = '${o}' and unidade_id = '${u}') then raise exception 'MOVA: a unidade não está no Financeiro v2 — nada foi feito'; end if;
${outras}
end $$;
with nova as (
  insert into fv2_concessao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, chave_idempotencia, impressao, extras, usuario_id, acoes, situacao, concedido_por, justificativa)
  values (gen_random_uuid(), '${o}', '${u}', 1, now(), '${EXECUTOR_BOOTSTRAP}', now(), '${EXECUTOR_BOOTSTRAP}', 'concessao:${p}', null, '{}'::jsonb, '${p}', '["financeiro_v2.ver"]'::jsonb, 'ATIVA', '${EXECUTOR_BOOTSTRAP}', ${literal(just)})
  on conflict do nothing returning *)
insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'CRIACAO', null, jsonb_build_object('versao', 1, 'acoes', acoes, 'situacao', situacao), justificativa, concedido_por, now() from nova;
select unidade_id, usuario_id, acoes, situacao, versao from fv2_concessao where usuario_id = '${p}' order by unidade_id;
`;
}

// ------------------------------------------------------------------------------------------------------------------------
// 24/11 — IDENTIDADE OPERACIONAL do MOVA (escrita estreita). Concessão POR UNIDADE, só com ações ESTREITAS autorizadas,
// idempotente, com histórico (fv2_historico) e revogação independente por unidade. Gera o SQL; não executa nada.
// Diferente da identidade de LEITURA (IDENTIDADE_DO_MOVA, só `ver`): a operacional NUNCA é a de leitura, nunca recebe ação
// ampla (registrar, corrigir, cancelar, aplicar, conceder…) e só existe onde o proprietário concedeu.
/** Ações que a identidade operacional pode receber (a lista do provedor fv2-integracao/operacionalMova.js). */
export const ACOES_OPERACIONAIS_DO_MOVA = Object.freeze(["financeiro_v2.ver", "financeiro_v2.enviar_documento", "financeiro_v2.baixar_por_comprovante",
  "financeiro_v2.registrar_obrigacao", "financeiro_v2.registrar_juros", "financeiro_v2.vincular_pagamento", "financeiro_v2.prestar_sangria"]);
const IDENTIDADES_RESERVADAS = Object.freeze([IDENTIDADE_DO_MOVA, EXECUTOR_BOOTSTRAP, "00000000-0000-4000-8000-00000000e7e9"]);
const MIGRACAO_DA_ACAO = Object.freeze({ "financeiro_v2.registrar_obrigacao": "0030_registrar_obrigacao_documental.sql", "financeiro_v2.registrar_juros": "0031_registrar_juros_no_pagamento.sql", "financeiro_v2.prestar_sangria": "0032_prestar_sangria.sql" });

function exigirOperacional({ identidade, organizacaoId, unidadeId, autor, justificativa }) {
  if (![identidade, organizacaoId, unidadeId, autor].every((x) => UUID_MOVA.test(x ?? ""))) throw new Error("Identidade, empresa, unidade e autor precisam ser UUID.");
  const id = identidade.toLowerCase();
  if (IDENTIDADES_RESERVADAS.includes(id)) throw new Error("A identidade operacional precisa ser PRÓPRIA (nunca a de leitura do MOVA, a de entregadores ou o executor técnico).");
  if (autor.toLowerCase() === id) throw new Error("Quem concede não pode ser a própria identidade.");
  if (typeof justificativa !== "string" || justificativa.trim().length < 10 || justificativa.length > 500) throw new Error("Justificativa obrigatória (10 a 500 caracteres).");
  return [id, organizacaoId.toLowerCase(), unidadeId.toLowerCase(), autor.toLowerCase()];
}

/**
 * Concede (ou ALTERA para exatamente estas ações) a identidade operacional em UMA unidade. Recusa ação fora da lista estreita,
 * lista sem `ver`, migração da ação ausente e identidade que já tenha ação ampla em QUALQUER unidade.
 * @param {{identidade:string, organizacaoId:string, unidadeId:string, acoes:string[], concedidoPor:string, justificativa:string}} p
 */
export function sqlConcessaoOperacionalDoMova({ identidade, organizacaoId, unidadeId, acoes, concedidoPor, justificativa }) {
  const [p, o, u, autor] = exigirOperacional({ identidade, organizacaoId, unidadeId, autor: concedidoPor, justificativa });
  const lista = [...new Set((acoes ?? []).map(String))].sort();
  if (!lista.includes("financeiro_v2.ver")) throw new Error("A concessão operacional sempre inclui financeiro_v2.ver.");
  const fora = lista.filter((a) => !ACOES_OPERACIONAIS_DO_MOVA.includes(a));
  if (fora.length) throw new Error(`Ação fora da lista estreita do MOVA: ${fora.join(", ")}.`);
  if (lista.length < 2) throw new Error("Só `ver` é a identidade de LEITURA: a operacional precisa de ao menos uma ação estreita.");
  const json = literal(JSON.stringify(lista));
  const estreitas = literal(JSON.stringify(ACOES_OPERACIONAIS_DO_MOVA));
  const migracoes = [...new Set(lista.map((a) => MIGRACAO_DA_ACAO[a]).filter(Boolean))];
  return `-- MOVA — CONCESSÃO OPERACIONAL (escrita estreita) em UMA unidade. Revisar antes de aplicar. Idempotente.
set local search_path = ${S}, pg_catalog, public;
do $$ begin
  if not exists (select 1 from fv2_escopo where organizacao_id = '${o}' and unidade_id = '${u}') then raise exception 'MOVA: a unidade não está no Financeiro v2 — nada foi feito'; end if;
${migracoes.map((m) => `  if not exists (select 1 from fv2_migracao where nome = '${m}') then raise exception 'MOVA: a migração ${m} não foi aplicada — nada foi feito'; end if;`).join("\n")}
  if exists (select 1 from fv2_concessao c where c.usuario_id = '${p}' and exists (select 1 from jsonb_array_elements_text(c.acoes) a where not ${estreitas}::jsonb ? a)) then
    raise exception 'MOVA: a identidade operacional tem ação AMPLA em alguma unidade — nada foi feito';
  end if;
end $$;
with atual as (select * from fv2_concessao where organizacao_id = '${o}' and unidade_id = '${u}' and usuario_id = '${p}' for update),
nova as (
  insert into fv2_concessao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, chave_idempotencia, impressao, extras, usuario_id, acoes, situacao, concedido_por, justificativa)
  select gen_random_uuid(), '${o}', '${u}', 1, now(), '${autor}', now(), '${autor}', 'concessao:${p}', null, '{"origem":"MOVA_OPERACIONAL"}'::jsonb, '${p}', ${json}::jsonb, 'ATIVA', '${autor}', ${literal(justificativa.trim())}
   where not exists (select 1 from atual)
  returning *),
alterada as (
  update fv2_concessao c set acoes = ${json}::jsonb, situacao = 'ATIVA', versao = c.versao + 1, atualizado_em = now(), atualizado_por = '${autor}', concedido_por = '${autor}', justificativa = ${literal(justificativa.trim())}
    from atual where c.id = atual.id and (c.acoes <> ${json}::jsonb or c.situacao <> 'ATIVA')
  returning c.*, atual.acoes as acoes_antes, atual.situacao as situacao_antes, atual.versao as versao_antes)
insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'CRIACAO', null, jsonb_build_object('versao', versao, 'acoes', acoes, 'situacao', situacao), justificativa, concedido_por, now() from nova
union all
select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'ALTERACAO', jsonb_build_object('versao', versao_antes, 'acoes', acoes_antes, 'situacao', situacao_antes),
       jsonb_build_object('versao', versao, 'acoes', acoes, 'situacao', situacao), justificativa, concedido_por, now() from alterada;
select organizacao_id, unidade_id, acoes, situacao, versao from fv2_concessao where usuario_id = '${p}' order by organizacao_id, unidade_id;
`;
}

/** Revoga a identidade operacional em UMA unidade (as demais ficam como estão). Idempotente; histórico gravado. */
export function sqlRevogarConcessaoOperacionalDoMova({ identidade, organizacaoId, unidadeId, revogadoPor, justificativa }) {
  const [p, o, u, autor] = exigirOperacional({ identidade, organizacaoId, unidadeId, autor: revogadoPor, justificativa });
  return `-- MOVA — REVOGAÇÃO da concessão operacional em UMA unidade (vale na próxima operação: a porta relê a concessão a cada chamada).
set local search_path = ${S}, pg_catalog, public;
with atual as (select * from fv2_concessao where organizacao_id = '${o}' and unidade_id = '${u}' and usuario_id = '${p}' and situacao = 'ATIVA' for update),
revogada as (
  update fv2_concessao c set acoes = '[]'::jsonb, situacao = 'REVOGADA', versao = c.versao + 1, atualizado_em = now(), atualizado_por = '${autor}', justificativa = ${literal(justificativa.trim())}
    from atual where c.id = atual.id
  returning c.*, atual.acoes as acoes_antes, atual.versao as versao_antes)
insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'ALTERACAO', jsonb_build_object('versao', versao_antes, 'acoes', acoes_antes, 'situacao', 'ATIVA'),
       jsonb_build_object('versao', versao, 'acoes', acoes, 'situacao', situacao), justificativa, '${autor}', now() from revogada;
select organizacao_id, unidade_id, acoes, situacao, versao from fv2_concessao where usuario_id = '${p}' order by organizacao_id, unidade_id;
`;
}

/** Verificador SCRAM-SHA-256 do PostgreSQL: a senha em claro nunca vai ao SQL, ao log do banco nem ao histórico de comandos. */
export function verificadorScram(senha, iteracoes = 4096, sal = randomBytes(16)) {
  const salgada = pbkdf2Sync(senha, sal, iteracoes, 32, "sha256");
  const chaveDoCliente = createHmac("sha256", salgada).update("Client Key").digest();
  const guardada = createHash("sha256").update(chaveDoCliente).digest();
  const chaveDoServidor = createHmac("sha256", salgada).update("Server Key").digest();
  return `SCRAM-SHA-256$${iteracoes}:${sal.toString("base64")}$${guardada.toString("base64")}:${chaveDoServidor.toString("base64")}`;
}

/**
 * Login do leitor do MOVA: membro SOMENTE de fv2_leitor_mova, máximo de 2 conexões, caminho de busca do módulo e tempos
 * limite. A senha entra como verificador SCRAM (nunca em claro). Recusa se a 0028 não foi aplicada ou se o papel já existe.
 * Gera o SQL; não executa nada.
 */
export function sqlLoginDoLeitorDoMova(papel, senha) {
  exigirPapelDoLeitor(papel);
  if (typeof senha !== "string" || senha.length < 32) throw new Error("Senha do leitor do MOVA: use pelo menos 32 caracteres.");
  return `do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'fv2_leitor_mova') then raise exception 'MOVA: a migração 0028 não foi aplicada — nada foi feito'; end if;
  if exists (select 1 from pg_roles where rolname = '${papel}') then raise exception 'MOVA: o papel ${papel} já existe — nada foi feito'; end if;
end $$;
create role ${papel} login password '${verificadorScram(senha)}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 2 in role fv2_leitor_mova;
alter role ${papel} set search_path = ${S}, pg_catalog;
alter role ${papel} set statement_timeout = '15s';
alter role ${papel} set idle_in_transaction_session_timeout = '30s';
`;
}

/** Conferência SOMENTE-LEITURA do login do leitor (rodar depois de criar). Cada coluna tem o valor esperado no nome. */
export function sqlVerificacaoDoLeitorDoMova(papel) {
  exigirPapelDoLeitor(papel);
  return `select
  (select count(*) from pg_roles where rolname = '${papel}' and rolcanlogin and not rolsuper and not rolcreaterole and not rolcreatedb and not rolbypassrls and not rolreplication and rolconnlimit = 2)::int as "login_restrito_esperado_1",
  (select count(*) from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles r on r.oid = m.member where r.rolname = '${papel}')::int as "papeis_membro_esperado_1",
  (select string_agg(g.rolname, ',') from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles r on r.oid = m.member where r.rolname = '${papel}') as "membro_de_esperado_fv2_leitor_mova",
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = '${S}' and c.relkind in ('r', 'p')
     and (has_table_privilege('${papel}', c.oid, 'insert') or has_table_privilege('${papel}', c.oid, 'update') or has_table_privilege('${papel}', c.oid, 'delete') or has_table_privilege('${papel}', c.oid, 'truncate')))::int as "tabelas_com_escrita_esperado_0",
  has_function_privilege('${papel}', '${S}.fv2_abrir_sessao(uuid, uuid, uuid, integer, text)', 'execute') as "emite_sessao_alheia_esperado_false",
  has_function_privilege('${papel}', '${S}.fv2_gravar_concessao(jsonb, integer)', 'execute') as "grava_concessao_esperado_false",
  has_function_privilege('${papel}', '${S}.fv2_abrir_sessao_mova(uuid, uuid)', 'execute') as "abre_sessao_mova_esperado_true",
  (select string_agg(n.nspname || '.' || c.relname, ',' order by 1) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p', 'v', 'm') and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast', '${S}')
       and (has_table_privilege('${papel}', c.oid, 'select') or has_table_privilege('${papel}', c.oid, 'insert') or has_table_privilege('${papel}', c.oid, 'update') or has_table_privilege('${papel}', c.oid, 'delete'))) as "fora_do_modulo_esperado_so_pg_stat_statements";
`;
}

/** Desligamento de emergência do leitor: bloqueia novas conexões e derruba as abertas. Não apaga nada. Gera o SQL. */
export function sqlDesativarLeitorDoMova(papel) {
  exigirPapelDoLeitor(papel);
  return `alter role ${papel} nologin;
select count(pg_terminate_backend(pid))::int as conexoes_encerradas from pg_stat_activity where usename = '${papel}';
`;
}

/**
 * BOOTSTRAP ADMINISTRATIVO ÚNICO (decisão do proprietário, 15/11): a PRIMEIRA administração financeira de UMA unidade,
 * sem segundo atestador, executada pela autoridade de infraestrutura (`postgres`, mesma credencial da instalação).
 * Não altera nenhuma função, política ou regra: a concessão nasce no mesmo formato do núcleo (concessão + histórico) e a
 * trilha fica em fv2_auditoria_concessao (finalidade BOOTSTRAP_INFRAESTRUTURA, papel_de_banco = executor) e numa sessão
 * de PROVISIONAMENTO que já nasce revogada (nunca utilizável). Travas:
 *   - só o papel executor; v2 instalado; unidade da empresa; conta ativa, PESSOAL (1 pessoa), com TOTP verificado,
 *     vinculada à unidade e à empresa;
 *   - USO ÚNICO no sistema inteiro (qualquer bootstrap anterior recusa outro); a unidade não pode ter administrador;
 *   - idempotente: repetir com a MESMA pessoa/unidade depois de concluído não faz nada.
 * NÃO libera a unidade: a liberação exige 2º fator real e recente (fv2_liberacao_alterar) e é feita pela própria pessoa
 * na página de ativação, com o login da plataforma — o que também comprova o TOTP em uso.
 */
export function sqlBootstrapAdministrador({ organizacaoId, unidadeId, usuarioId, autorizacao, acoes, executor = "postgres" }) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const [n, v] of Object.entries({ organizacaoId, unidadeId, usuarioId })) if (!uuid.test(String(v))) throw new Error(`${n} inválido.`);
  if (!/^[A-Za-z0-9._:-]{6,80}$/.test(String(autorizacao))) throw new Error("Identificador da autorização inválido.");
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(executor)) throw new Error("Papel executor inválido.");
  if (!Array.isArray(acoes) || !acoes.length || acoes.some((a) => !/^financeiro_v2\.[a-z_]+$/.test(a))) throw new Error("Ações inválidas.");
  const [o, u, p] = [organizacaoId, unidadeId, usuarioId].map((x) => x.toLowerCase());
  const lista = JSON.stringify([...new Set(acoes)].sort());
  const just = `Administração financeira inicial por bootstrap de infraestrutura (sem segundo atestador, decisão do proprietário). Autorização: ${autorizacao}.`;
  return `-- Financeiro v2 — BOOTSTRAP ADMINISTRATIVO ÚNICO. Unidade ${u} (empresa ${o}), pessoa ${p}, autorização ${autorizacao}.
-- Executar como ${executor}, numa ÚNICA transação. Não apaga nada, não libera a unidade, não muda regra alguma.
-- O caminho de busca vale só nesta transação: os gatilhos do módulo conferidos no COMMIT (histórico obrigatório) usam
-- nomes sem schema, e o papel executor tem o caminho padrão da plataforma (sem financeiro_v2).
set local search_path = financeiro_v2, pg_catalog, public;
do $$
declare
  v_org  uuid := '${o}'; v_uni uuid := '${u}'; v_usr uuid := '${p}'; v_exec uuid := '${EXECUTOR_BOOTSTRAP}';
  v_acoes jsonb := ${literal(lista)}::jsonb; v_just text := ${literal(just)};
  v_id uuid := gen_random_uuid(); v_sess uuid; v_agora timestamptz := clock_timestamp(); v_ant record;
begin
  if session_user <> ${literal(executor)} then raise exception 'FV2 bootstrap: só o papel ${executor} executa — nada foi feito'; end if;
  perform pg_advisory_xact_lock(hashtextextended('fv2|' || v_org || '|' || v_uni || '|concessoes', 0));
  if (select count(*) from financeiro_v2.fv2_migracao) < 21 then raise exception 'FV2 bootstrap: o Financeiro v2 não está instalado'; end if;
  if not exists (select 1 from public.unidades where id = v_uni and organizacao_id = v_org) then raise exception 'FV2 bootstrap: unidade fora da empresa'; end if;
  if not exists (select 1 from auth.users where id = v_usr and deleted_at is null and (banned_until is null or banned_until < now())) then raise exception 'FV2 bootstrap: conta inexistente, excluída ou bloqueada'; end if;
  if not exists (select 1 from auth.mfa_factors where user_id = v_usr and factor_type::text = 'totp' and status::text = 'verified') then raise exception 'FV2 bootstrap: a conta não tem TOTP verificado'; end if;
  if (select count(*) from public.perfis_operacionais where conta_id = v_usr and ativo) <> 1
     or not exists (select 1 from public.perfis_operacionais where id = v_usr and conta_id = v_usr and ativo) then raise exception 'FV2 bootstrap: a conta não é pessoal (exige exatamente uma pessoa ativa)'; end if;
  if not exists (select 1 from public.usuarios_unidades where perfil_id = v_usr and unidade_id = v_uni and ativo) then raise exception 'FV2 bootstrap: a pessoa não está vinculada à unidade'; end if;
  if not exists (select 1 from public.usuarios_organizacoes where usuario_id = v_usr and organizacao_id = v_org and ativo) then raise exception 'FV2 bootstrap: a pessoa não está vinculada à empresa'; end if;
  -- uso único no sistema inteiro (idempotente para a mesma pessoa e unidade)
  select a.organizacao_id, a.unidade_id, a.usuario_alvo into v_ant from financeiro_v2.fv2_auditoria_concessao a where a.finalidade = 'BOOTSTRAP_INFRAESTRUTURA' limit 1;
  if found then
    if v_ant.organizacao_id = v_org and v_ant.unidade_id = v_uni and v_ant.usuario_alvo = v_usr then raise notice 'FV2 bootstrap: já concluído para esta pessoa e unidade — nada a fazer'; return; end if;
    raise exception 'FV2 bootstrap: o bootstrap já foi usado — novos administradores só pelo fluxo normal de concessão';
  end if;
  if exists (select 1 from financeiro_v2.fv2_concessao c where c.organizacao_id = v_org and c.unidade_id = v_uni and c.situacao = 'ATIVA' and c.acoes ? 'financeiro_v2.conceder') then raise exception 'FV2 bootstrap: a unidade já tem administrador'; end if;
  if exists (select 1 from financeiro_v2.fv2_concessao c where c.organizacao_id = v_org and c.unidade_id = v_uni and c.usuario_id = v_usr) then raise exception 'FV2 bootstrap: a pessoa já tem concessão nesta unidade — usar o fluxo normal'; end if;
  insert into financeiro_v2.fv2_escopo (organizacao_id, unidade_id, rotulo) values (v_org, v_uni, 'Açaí no Grau Saci') on conflict (organizacao_id, unidade_id) do nothing;
  -- trilha: sessão de provisionamento que já nasce revogada (nunca abre nada)
  insert into financeiro_v2.fv2_sessao_banco (token_hash, usuario_id, organizacao_id, unidade_id, finalidade, pode_escrever, alvo, acoes_autorizadas, referencia, expira_em, revogada_em, motivo_revogacao)
  values (sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), v_exec, v_org, v_uni, 'PROVISIONAMENTO', false, v_usr, v_acoes,
          left('BOOTSTRAP_INFRAESTRUTURA ' || ${literal(autorizacao)}, 200), clock_timestamp() + interval '1 minute', clock_timestamp(), 'bootstrap de infraestrutura: só trilha')
  returning id into v_sess;
  insert into financeiro_v2.fv2_concessao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por,
                                           chave_idempotencia, impressao, extras, usuario_id, acoes, situacao, concedido_por, justificativa)
  values (v_id, v_org, v_uni, 1, v_agora, v_exec, v_agora, v_exec, 'concessao:' || v_usr, null, '{}'::jsonb, v_usr, v_acoes, 'ATIVA', v_exec, v_just);
  insert into financeiro_v2.fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
  values (gen_random_uuid(), v_org, v_uni, 'CONCESSAO', v_id, 'CRIACAO', null,
          jsonb_build_object('id', v_id, 'organizacaoId', v_org, 'unidadeId', v_uni, 'versao', 1, 'criadoEm', v_agora, 'criadoPor', v_exec,
                             'atualizadoEm', v_agora, 'atualizadoPor', v_exec, 'chaveIdempotencia', 'concessao:' || v_usr, 'impressao', null,
                             'usuarioId', v_usr, 'acoes', v_acoes, 'situacao', 'ATIVA', 'concedidoPor', v_exec, 'justificativa', v_just),
          v_just, v_exec, v_agora);
  insert into financeiro_v2.fv2_auditoria_concessao (organizacao_id, unidade_id, concessao_id, usuario_alvo, ator, sessao_id, finalidade, operacao, acoes_antes, acoes_depois, situacao_depois, justificativa)
  values (v_org, v_uni, v_id, v_usr, v_exec, v_sess, 'BOOTSTRAP_INFRAESTRUTURA', 'PROVISIONAMENTO', '[]'::jsonb, v_acoes, 'ATIVA', v_just);
end $$;
select a.em, a.papel_de_banco as executor, a.usuario_alvo as beneficiario, a.unidade_id, a.finalidade, a.justificativa, c.situacao, jsonb_array_length(c.acoes) as acoes,
       (select count(*) from financeiro_v2.fv2_liberacao l where l.organizacao_id = '${o}'::uuid and l.ativa) as liberacoes_ativas
  from financeiro_v2.fv2_auditoria_concessao a join financeiro_v2.fv2_concessao c on c.id = a.concessao_id
 where a.finalidade = 'BOOTSTRAP_INFRAESTRUTURA';
`;
}

const executadoDireto = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (executadoDireto && process.argv[2] === "--escopo") {
  const t = sqlEscopoDaUnidade(process.argv[3], process.argv[4]);
  process.stdout.write(`${t}-- sha256 ${sha(t)}\n`);
  process.exit(0);
}
if (executadoDireto && process.argv[2] === "--mova-concessao") { const i = process.argv.indexOf("--alem-de"); process.stdout.write(sqlConcessaoDoMova(process.argv[3], process.argv[4], { alemDe: i > 0 ? String(process.argv[i + 1] ?? "").split(",").filter(Boolean) : [] })); process.exit(0); }
// 24/11: identidade OPERACIONAL — --mova-operacional <org> <unidade> --identidade <uuid> --acoes a,b --concedido-por <uuid> --justificativa "…"
//        e --mova-operacional-revogar <org> <unidade> --identidade <uuid> --revogado-por <uuid> --justificativa "…"
if (executadoDireto && (process.argv[2] === "--mova-operacional" || process.argv[2] === "--mova-operacional-revogar")) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  try {
    const comum = { identidade: arg("--identidade"), organizacaoId: process.argv[3], unidadeId: process.argv[4], justificativa: arg("--justificativa") };
    process.stdout.write(process.argv[2] === "--mova-operacional"
      ? sqlConcessaoOperacionalDoMova({ ...comum, acoes: String(arg("--acoes") ?? "").split(",").filter(Boolean), concedidoPor: arg("--concedido-por") })
      : sqlRevogarConcessaoOperacionalDoMova({ ...comum, revogadoPor: arg("--revogado-por") }));
    process.exit(0);
  } catch (e) { process.stderr.write(`ERRO: ${e.message}\n`); process.exit(1); }
}
if (executadoDireto && process.argv[2] === "--mova-login") { process.stdout.write(sqlLoginDoLeitorDoMova(process.argv[3], process.env.FV2_MOVA_LEITOR_SENHA ?? "")); process.exit(0); }
if (executadoDireto && process.argv[2] === "--mova-verificar") { process.stdout.write(sqlVerificacaoDoLeitorDoMova(process.argv[3])); process.exit(0); }
if (executadoDireto && process.argv[2] === "--mova-desativar") { process.stdout.write(sqlDesativarLeitorDoMova(process.argv[3])); process.exit(0); }
if (executadoDireto && process.argv[2] === "--bootstrap") {
  const { ACAO } = await import("../../src/modules/financeiro-v2/dominio/contexto.js");
  const t = sqlBootstrapAdministrador({ organizacaoId: process.argv[3], unidadeId: process.argv[4], usuarioId: process.argv[5], autorizacao: process.argv[6], acoes: Object.values(ACAO) });
  process.stdout.write(`${t}-- sha256 ${sha(t)}\n`);
  process.exit(0);
}

/**
 * ATUALIZAÇÃO incremental de um banco que já tem o Financeiro v2 instalado (produção em 17/11/2026: 0001–0023, conferidas por nome e hash contra o Git).
 * UMA transação: confere que as migrações já registradas são EXATAMENTE as do Git (nome + hash), aplica só as novas com as
 * mesmas adaptações da instalação (A3, A5) e aborta se qualquer pós-condição falhar. Não cria papéis nem toca no sistema atual.
 */
export const BASE_INSTALADA = "0031"; // produção conferida em 25/11 (31 migrações com o mesmo hash do Git; 0029–0031 aplicadas em 23/11)
export function atualizar(base = BASE_INSTALADA) {
  const ms = listarMigracoes();
  const ja = ms.filter((m) => m.nome.slice(0, 4) <= base);
  const novas = ms.filter((m) => m.nome.slice(0, 4) > base);
  if (!novas.length) return `-- Financeiro v2 — nada a atualizar além de ${base}.\n`;
  const partes = [
    `-- Financeiro v2 — ATUALIZAÇÃO do schema ${S} (gerado por backend/scripts/fv2/pacoteProducao.mjs; NÃO editar à mão).`,
    "-- Aplicar como `postgres` (não superusuário), numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.",
    `-- Já instaladas (conferidas por nome e hash): ${ja.map((m) => m.nome).join(", ")}`,
    `-- Novas: ${novas.map((m) => m.nome).join(", ")}`,
    "",
    `do $$ declare n int; begin
  if not exists (select 1 from pg_namespace where nspname = '${S}') then raise exception 'FV2 atualização: schema ${S} não existe — nada foi feito'; end if;
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception 'FV2 atualização: não aplicar como superusuário'; end if;
  if exists (select 1 from pg_publication where puballtables) then raise exception 'FV2 atualização: existe publicação FOR ALL TABLES — nada foi feito'; end if;
  select count(*) into n from ${S}.fv2_migracao;
  if n <> ${ja.length} then raise exception 'FV2 atualização: % migrações registradas (esperado ${ja.length}) — nada foi feito', n; end if;
  select count(*) into n from ${S}.fv2_migracao m join (values ${ja.map((m) => `(${literal(m.nome)}, ${literal(m.sha256)})`).join(", ")}) v(nome, sha) on v.nome = m.nome and v.sha = m.sha256;
  if n <> ${ja.length} then raise exception 'FV2 atualização: migrações instaladas diferem do Git (nome/hash) — nada foi feito'; end if;
end $$;`,
    `set local search_path = ${S}, pg_catalog;`,
    "",
  ];
  for (const m of novas) {
    const t = textoAplicado(m.sql, S);
    partes.push(`-- ------------------------------------------------------------------------- ${m.nome} (arquivo ${m.sha256})`);
    partes.push(`grant fv2_guardiao to current_user; grant create on schema ${S} to fv2_guardiao;`, t.trimEnd(), `revoke create on schema ${S} from fv2_guardiao; revoke fv2_guardiao from current_user;`);
    for (const [, nome] of t.matchAll(/create\s+temporary\s+table\s+([a-z0-9_]+)/gi)) partes.push(`drop table if exists pg_temp.${nome};`);
    partes.push(`insert into ${S}.fv2_migracao (nome, sha256, sha256_aplicado) values (${literal(m.nome)}, ${literal(m.sha256)}, ${literal(sha(t))});`, "");
  }
  partes.push(`${sqlSemExecucaoPublica(S)};`,
    `grant fv2_guardiao to current_user;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated','service_role','authenticator'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema ${S} from %I', r);
      execute format('revoke all on all sequences in schema ${S} from %I', r);
      execute format('revoke all on all functions in schema ${S} from %I', r);
    end if;
  end loop;
end $$;
revoke fv2_guardiao from current_user;`,
    `do $$ declare n int; txt text; begin
  select count(*) into n from ${S}.fv2_migracao;
  if n <> ${ms.length} then raise exception 'FV2 pós: % migrações registradas (esperado ${ms.length})', n; end if;
  select string_agg(c.relname, ', ') into txt from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = '${S}' and c.relkind = 'r' and c.relname <> 'fv2_migracao'
      and c.relname not in ('fv2_auditoria_concessao','fv2_liberacao','fv2_liberacao_historico','fv2_administrador_corporativo','fv2_administrador_corporativo_historico','fv2_provisionamento_inicial','fv2_sessao_banco')
      and not (c.relrowsecurity and c.relforcerowsecurity);
  if txt is not null then raise exception 'FV2 pós: tabelas sem RLS forçada: %', txt; end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace,
    lateral aclexplode(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) x
    where s.nspname = '${S}' and c.relkind in ('r','p','v','m','S') and (x.grantee = 0 or pg_get_userbyid(x.grantee) in ('anon','authenticated','service_role','authenticator'));
  if n > 0 then raise exception 'FV2 pós: % privilégio(s) de PUBLIC ou credencial comum em tabela do schema', n; end if;
  select count(*) into n from pg_publication_tables where schemaname = '${S}';
  if n > 0 then raise exception 'FV2 pós: % tabela(s) do v2 em publicação de replicação', n; end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname <> '${S}' and s.nspname not like 'pg\\_%' and c.relname like 'fv2\\_%';
  if n > 0 then raise exception 'FV2 pós: % relações fv2_* fora do schema', n; end if;
end $$;`, "");
  return partes.join("\n");
}

const arquivos = { "instalar.sql": instalar(), "atualizar.sql": atualizar(), "inventario.sql": INVENTARIO, "desativar.sql": DESATIVAR };
if (!executadoDireto) { /* importado (testes): só exporta as funções */ } else if (process.argv.includes("--conferir")) {
  const fora = Object.entries(arquivos).filter(([n, t]) => !existsSync(join(DESTINO, n)) || readFileSync(join(DESTINO, n), "utf8") !== t).map(([n]) => n);
  if (fora.length) { process.stderr.write(`Desatualizados: ${fora.join(", ")} (rode node scripts/fv2/pacoteProducao.mjs)\n`); process.exit(1); }
  process.stdout.write("Pacote de produção em dia.\n");
} else {
  mkdirSync(DESTINO, { recursive: true });
  for (const [n, t] of Object.entries(arquivos)) writeFileSync(join(DESTINO, n), t);
  process.stdout.write(`${Object.entries(arquivos).map(([n, t]) => `${n}  sha256=${sha(t)}`).join("\n")}\n`);
}
