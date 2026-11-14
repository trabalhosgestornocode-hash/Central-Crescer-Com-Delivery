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
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ESQUEMA_FINANCEIRO, PASTA_DE_MIGRACOES, listarMigracoes, textoAplicado } from "./ambiente.mjs";

const S = ESQUEMA_FINANCEIRO;
const PAPEIS = ["fv2_app", "fv2_autoridade", "fv2_guardiao"];
const DESTINO = resolve(PASTA_DE_MIGRACOES, "..", "producao");
const sha = (t) => createHash("sha256").update(t).digest("hex");
const literal = (t) => `'${t.replaceAll("'", "''")}'`;

function instalar() {
  const ms = listarMigracoes();
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
  partes.push(
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
      and c.relname not in ('fv2_auditoria_concessao','fv2_liberacao','fv2_liberacao_historico','fv2_provisionamento_inicial','fv2_sessao_banco')
      and not (c.relrowsecurity and c.relforcerowsecurity);
  if txt is not null then raise exception 'FV2 pós: tabelas sem RLS forçada: %', txt; end if;
  -- credenciais comuns sem nenhum caminho
  select string_agg(r, ', ') into txt from unnest(array['anon','authenticated','service_role','authenticator']) r
    where exists (select 1 from pg_roles where rolname = r) and has_schema_privilege(r, '${S}', 'usage');
  if txt is not null then raise exception 'FV2 pós: USAGE no schema para %', txt; end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace,
    unnest(array['anon','authenticated','service_role','authenticator','fv2_app','fv2_autoridade']) g(r)
    where s.nspname = '${S}' and exists (select 1 from pg_roles where rolname = g.r)
      and c.relname in ('fv2_auditoria_concessao','fv2_liberacao','fv2_liberacao_historico','fv2_provisionamento_inicial','fv2_sessao_banco')
      and (has_table_privilege(g.r, c.oid, 'select') or has_table_privilege(g.r, c.oid, 'insert') or has_table_privilege(g.r, c.oid, 'update') or has_table_privilege(g.r, c.oid, 'delete'));
  if n > 0 then raise exception 'FV2 pós: tabela guardada acessível por papel não autorizado (% casos)', n; end if;
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

const arquivos = { "instalar.sql": instalar(), "inventario.sql": INVENTARIO, "desativar.sql": DESATIVAR };
if (process.argv.includes("--conferir")) {
  const fora = Object.entries(arquivos).filter(([n, t]) => !existsSync(join(DESTINO, n)) || readFileSync(join(DESTINO, n), "utf8") !== t).map(([n]) => n);
  if (fora.length) { process.stderr.write(`Desatualizados: ${fora.join(", ")} (rode node scripts/fv2/pacoteProducao.mjs)\n`); process.exit(1); }
  process.stdout.write("Pacote de produção em dia.\n");
} else {
  mkdirSync(DESTINO, { recursive: true });
  for (const [n, t] of Object.entries(arquivos)) writeFileSync(join(DESTINO, n), t);
  process.stdout.write(`${Object.entries(arquivos).map(([n, t]) => `${n}  sha256=${sha(t)}`).join("\n")}\n`);
}
