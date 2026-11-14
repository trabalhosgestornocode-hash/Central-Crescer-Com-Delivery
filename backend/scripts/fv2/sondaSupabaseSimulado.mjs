#!/usr/bin/env node
// SONDA DO SUPABASE EXISTENTE, SIMULADO LOCALMENTE (Execução 09C, adendo de infraestrutura).
//
// Pergunta: as migrações 0001–0021 do Financeiro v2 cabem num schema DEDICADO do PostgreSQL do projeto Supabase que a
// plataforma já usa, com os privilégios que esse projeto dá ao papel de migração, sem alterar nada do sistema atual e sem
// expor dados financeiros às credenciais comuns (anon, authenticated, service_role)?
//
// Como: cria um cluster PostgreSQL DESCARTÁVEL (initdb numa pasta temporária, só 127.0.0.1, porta própria), monta nele
// as características PÚBLICAS conhecidas de um projeto Supabase (papel `postgres` NÃO superusuário com CREATEROLE e
// BYPASSRLS; `anon`/`authenticated`/`service_role` (BYPASSRLS)/`authenticator`; schemas `auth`, `storage`, `extensions`;
// privilégios PADRÃO do `public` concedidos a anon/authenticated/service_role; tabelas, funções e políticas de uma
// "plataforma" sintética, inclusive um "financeiro antigo" sintético) e aplica as migrações CONECTADO COMO `postgres`.
// Nada aqui conecta fora do loopback, lê .env ou usa credencial real; o cluster é apagado no fim.
//
// Execuções (cada uma num banco novo; papéis fv2_* removidos entre elas):
//   E1 "como está":        migrações originais no `public` (o que aconteceria sem adaptação)
//   E2 "dedicado":         schema financeiro_v2 + adaptações A1–A4 (doc 24 § 11) — a proposta
//   E3 "public adaptado":  as mesmas adaptações, mas no `public` — mede a exposição pelos privilégios padrão
//
//   node scripts/fv2/sondaSupabaseSimulado.mjs [--porta 54339] [--manter]
//
// LIMITES (o que esta sonda NÃO prova): versão e atributos reais do papel `postgres` do projeto, privilégios padrão
// reais, extensões instaladas, limites de conexão e o comportamento do Supavisor. Esses itens têm consultas SÓ-LEITURA
// preparadas no doc 24 § 11 para quando houver autorização específica.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PASTA_DE_MIGRACOES, listarMigracoes } from "./ambiente.mjs";

const args = process.argv.slice(2);
const PORTA = Number(args[args.indexOf("--porta") + 1] || 54339) || 54339;
const MANTER = args.includes("--manter");
const PASTA = join(tmpdir(), `fv2-sonda-supabase-${randomBytes(4).toString("hex")}`);
const EXE = process.platform === "win32" ? ".exe" : "";
const SCHEMA = "financeiro_v2";
const NONCE = `fv2sonda${randomBytes(8).toString("hex")}`; // nome do cluster desta execução (barreira 2)

function binarios() {
  const c = [process.env.FV2_PG_BIN, ...(process.env.PATH || "").split(process.platform === "win32" ? ";" : ":")];
  const raiz = join(process.env.ProgramFiles || "C:\\Program Files", "PostgreSQL");
  if (process.platform === "win32" && existsSync(raiz)) for (const v of readdirSync(raiz).sort().reverse()) c.push(join(raiz, v, "bin"));
  const d = c.find((x) => x && ["initdb", "pg_ctl"].every((b) => existsSync(join(x, b + EXE))));
  if (!d) throw new Error("binários do PostgreSQL não encontrados (FV2_PG_BIN)");
  return d;
}
const BIN = binarios();
const rodar = (bin, a, semSaida = false) => {
  const r = spawnSync(join(BIN, bin + EXE), a, { encoding: "utf8", windowsHide: true, stdio: semSaida ? "ignore" : "pipe" });
  if (r.status !== 0) throw new Error(`${bin} falhou: ${r.stderr || r.stdout || r.status}`);
};

const pg = (await import("pg")).default;
async function conectar(usuario, banco) {
  const url = `postgres://${usuario}@127.0.0.1:${PORTA}/${banco}`;
  // barreira 1: só loopback literal e porta própria (a guarda do ambiente de testes recusa, de propósito, os nomes
  // `postgres`/`anon`/`service_role` que esta simulação precisa; aqui a prova forte é a barreira 2)
  const u = new URL(url);
  if (u.hostname !== "127.0.0.1" || Number(u.port) !== PORTA || PORTA === 5432 || u.search) throw new Error("destino não é o cluster local desta sonda");
  const cl = new pg.Client({ connectionString: url });
  await cl.connect();
  // barreira 2: o servidor conectado é o cluster DESCARTÁVEL criado agora (cluster_name aleatório desta execução,
  // legível por qualquer papel — data_directory exigiria privilégio que o papel `postgres` simulado não tem)
  const { rows } = await cl.query("select current_setting('cluster_name') as n, host(inet_server_addr()) as e");
  if (rows[0].n !== NONCE || rows[0].e !== "127.0.0.1") {
    await cl.end();
    throw new Error("o servidor conectado não é o cluster descartável desta sonda");
  }
  return cl;
}
const tentar = async (cl, sql) => { try { await cl.query(sql); return null; } catch (e) { return `${e.code}: ${e.message}`; } };

// ---------------------------------------------------------------------------------------------- plataforma simulada
const PAPEIS_SUPABASE = `
  create role postgres login nosuperuser createrole createdb replication bypassrls;
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;
  create role authenticator login noinherit;
  grant anon, authenticated, service_role to authenticator;
  create role supabase_auth_admin nologin noinherit createrole;
  create role supabase_storage_admin nologin noinherit createrole;
  -- 10: atributos CONFIRMADOS na inspeção só-leitura do projeto real (14/11/2026): o postgres herda pg_read_all_data e é
  -- membro (ADMIN/INHERIT/SET) dos papéis da API; createrole_self_grant vazio; nenhum privilégio padrão global.
  grant pg_read_all_data to postgres;
  grant anon, authenticated, service_role, authenticator to postgres with admin option;`;

async function montarPlataforma(admin, banco) {
  await admin.query(`create database ${banco} owner postgres`);
  const a = await conectar("sim_admin", banco);
  await a.query(`
    create schema auth authorization supabase_auth_admin;
    create table auth.users (id uuid primary key, email text);
    create schema storage authorization supabase_storage_admin;
    create table storage.buckets (id text primary key, public boolean not null default false);
    create table storage.objects (id uuid primary key, bucket_id text references storage.buckets, name text, owner uuid);
    alter table storage.objects enable row level security;
    create schema extensions;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`);
  await a.end();
  const p = await conectar("postgres", banco);
  await p.query(`
    create table public.organizacoes (id uuid primary key, nome text not null);
    alter table public.organizacoes enable row level security;
    create policy org_leitura on public.organizacoes for select to authenticated using (true);
    create table public.financeiro_lancamentos (id bigserial primary key, organizacao_id uuid, valor numeric);
    alter table public.financeiro_lancamentos enable row level security;
    create function public.plataforma_versao() returns text language sql as 'select ''sintética''';`);
  await p.end();
}

/** Fotografia de TUDO o que não é do Financeiro v2 (objetos, ACLs, RLS, políticas, privilégios padrão, papéis). */
async function inventarioAlheio(admin) {
  const q = async (sql) => (await admin.query(sql)).rows;
  const foto = {
    schemas: await q(`select nspname, nspowner::regrole::text o, nspacl::text acl from pg_namespace where nspname <> '${SCHEMA}' and nspname !~ '^pg_(toast_)?temp_' order by 1`),
    relacoes: await q(`select n.nspname, c.relname, c.relkind, c.relowner::regrole::text o, c.relacl::text acl, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('${SCHEMA}', 'pg_toast', 'pg_catalog', 'information_schema')
      and not (n.nspname = 'public' and c.relname like 'fv2\\_%') order by 1, 2`),
    funcoes: await q(`select n.nspname, p.oid::regprocedure::text f, p.proowner::regrole::text o, p.proacl::text acl, p.prosecdef, p.proconfig::text cfg
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('${SCHEMA}', 'pg_catalog', 'information_schema')
      and not (n.nspname = 'public' and p.proname like 'fv2\\_%') order by 1, 2`),
    politicas: await q(`select schemaname, tablename, policyname, roles::text, qual from pg_policies where schemaname <> '${SCHEMA}' and tablename not like 'fv2\\_%' order by 1, 2, 3`),
    padrao: await q(`select defaclrole::regrole::text r, defaclnamespace::regnamespace::text n, defaclobjtype t, defaclacl::text acl from pg_default_acl order by 1, 2, 3`),
    papeis: await q(`select rolname, rolsuper, rolcreaterole, rolbypassrls, rolcanlogin, rolinherit from pg_roles where rolname !~ '^(fv2_|pg_)' order by 1`),
    membros: await q(`select r.rolname g, m.rolname m from pg_auth_members x join pg_roles r on r.oid = x.roleid join pg_roles m on m.oid = x.member
      where r.rolname !~ '^(fv2_|pg_)' and m.rolname !~ '^fv2_' order by 1, 2`),
  };
  const h = createHash("sha256").update(JSON.stringify(foto)).digest("hex");
  return Object.assign(new String(h), { foto });
}
/** Partes do inventário que mudaram (para o relatório não esconder o que foi). */
const diferencas = (a, b) => Object.keys(a.foto).filter((k) => JSON.stringify(a.foto[k]) !== JSON.stringify(b.foto[k]))
  .map((k) => `${k}: +${JSON.stringify(b.foto[k].filter((x) => !a.foto[k].some((y) => JSON.stringify(y) === JSON.stringify(x))))} -${JSON.stringify(a.foto[k].filter((x) => !b.foto[k].some((y) => JSON.stringify(y) === JSON.stringify(x))))}`);

// ------------------------------------------------------------------------------------------------------ adaptações
// A1 schema dedicado sem acesso de PUBLIC; papéis fv2_* criados antes (as migrações já usam "se não existir").
// A2 search_path das funções SECURITY DEFINER aponta para o schema dedicado (troca textual verificada: 9 ocorrências).
// A3 posse das funções para o guardião: participação TEMPORÁRIA do papel de migração + CREATE temporário no schema,
//    revogados na MESMA transação da migração (R6b).
// A4 USAGE no schema só para fv2_app, fv2_autoridade e fv2_guardiao.
const SP_ORIGINAL = "set search_path = pg_catalog, public, pg_temp";
async function aplicar(cl, { schema, adaptar }) {
  const ocorrencias = [];
  if (adaptar) {
    if (schema !== "public") await cl.query(`create schema ${schema}; revoke all on schema ${schema} from public`);
    await cl.query(`set search_path = ${schema}, pg_catalog`);
    await cl.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'fv2_app') then create role fv2_app nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'fv2_autoridade') then create role fv2_autoridade nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'fv2_guardiao') then create role fv2_guardiao nologin; end if;
    end $$`);
    // no public, PUBLIC já tem USAGE: conceder de novo alteraria a ACL do schema da plataforma
    if (schema !== "public") await cl.query(`grant usage on schema ${schema} to fv2_app, fv2_autoridade, fv2_guardiao`);
  }
  await cl.query("create table if not exists fv2_migracao (nome text primary key, sha256 text not null, aplicada_em timestamptz not null default now())");
  for (const m of listarMigracoes()) {
    let sql = m.sql;
    if (adaptar && schema !== "public") {
      const n = sql.split(SP_ORIGINAL).length - 1;
      if (n) ocorrencias.push(`${m.nome}:${n}`);
      sql = sql.replaceAll(SP_ORIGINAL, `set search_path = pg_catalog, ${schema}, pg_temp`);
      if (/search_path\s*=\s*pg_catalog,\s*public/.test(sql)) return { erro: `${m.nome}: search_path com public não adaptado` };
    }
    // A3 vale para quem TRANSFERE a posse ao guardião e para quem RECRIA (create or replace) função que já é dele
    const doGuardiao = adaptar ? (await cl.query("select distinct p.proname from pg_proc p where p.proowner = (select oid from pg_roles where rolname = 'fv2_guardiao')")).rows.map((x) => x.proname) : [];
    const posse = adaptar && (/owner to fv2_guardiao/.test(sql) || doGuardiao.some((f) => new RegExp(String.raw`create\s+or\s+replace\s+function\s+${f}\s*\(`, "i").test(sql)));
    if (posse) ocorrencias.push(`${m.nome}:A3`);
    await cl.query("begin");
    try {
      if (posse) await cl.query(`grant fv2_guardiao to current_user; grant create on schema ${schema} to fv2_guardiao`);
      await cl.query(sql);
      if (posse) await cl.query(`revoke create on schema ${schema} from fv2_guardiao; revoke fv2_guardiao from current_user`);
      await cl.query("insert into fv2_migracao (nome, sha256) values ($1, $2)", [m.nome, m.sha256]);
      await cl.query("commit");
    } catch (e) {
      await cl.query("rollback");
      return { erro: `${m.nome} → ${e.code}: ${e.message}`, ocorrencias };
    }
  }
  return { erro: null, ocorrencias };
}

async function verificar(admin, banco, schema) {
  const a = await conectar("sim_admin", banco);
  const um = async (sql) => (await a.query(sql)).rows[0];
  const r = [];
  const ok = (id, texto, cond, detalhe = "") => r.push({ id, situacao: cond ? "OK" : "FALHA", texto, detalhe });
  const tabelas = (await a.query(`select c.relname, c.relrowsecurity rls, c.relforcerowsecurity force from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = '${schema}' and c.relkind in ('r', 'p') and c.relname like 'fv2\\_%' order by 1`)).rows;
  // As 5 tabelas GUARDADAS (07B/09B) não têm RLS por desenho: nenhum papel além do guardião tem privilégio nelas
  // (mesma regra de test/financeiro-v2/postgres-integridade.test.js).
  const GUARDADAS = ["fv2_auditoria_concessao", "fv2_liberacao", "fv2_liberacao_historico", "fv2_provisionamento_inicial", "fv2_sessao_banco"];
  const semForce = tabelas.filter((t) => !(t.rls && t.force) && t.relname !== "fv2_migracao" && !GUARDADAS.includes(t.relname)).map((t) => t.relname);
  const guardadasAbertas = (await a.query(`select c.relname, g.r from pg_class c join pg_namespace n on n.oid = c.relnamespace,
      unnest(array['fv2_app','fv2_autoridade','anon','authenticated','service_role','authenticator']) g(r)
    where n.nspname = '${schema}' and c.relname = any($1::text[]) and (has_table_privilege(g.r, c.oid, 'select') or has_table_privilege(g.r, c.oid, 'insert')
      or has_table_privilege(g.r, c.oid, 'update') or has_table_privilege(g.r, c.oid, 'delete'))`, [GUARDADAS])).rows.map((x) => `${x.relname}:${x.r}`);
  ok("C1", `${tabelas.length} tabelas fv2_* no schema ${schema}; RLS forçada em todas, salvo as 5 GUARDADAS, que nenhum papel além do guardião acessa`,
    tabelas.length > 0 && semForce.length === 0 && guardadasAbertas.length === 0, [...semForce, ...guardadasAbertas].join(", "));
  const exp = await um(`select count(*)::int n, string_agg(distinct g.r, ',') papeis from pg_class c join pg_namespace s on s.oid = c.relnamespace,
    unnest(array['anon','authenticated','service_role','authenticator']) g(r)
    where s.nspname = '${schema}' and c.relname like 'fv2\\_%' and c.relkind in ('r','p','v','S')
      and (has_table_privilege(g.r, c.oid, 'select') or has_table_privilege(g.r, c.oid, 'insert') or has_table_privilege(g.r, c.oid, 'update') or has_table_privilege(g.r, c.oid, 'delete'))`);
  const uso = await um(`select string_agg(r, ',') papeis from unnest(array['anon','authenticated','service_role','authenticator']) r where has_schema_privilege(r, '${schema}', 'usage')`);
  ok("C2", `credenciais comuns (anon/authenticated/service_role/authenticator) sem privilégio em tabela fv2_*${schema === "public" ? "" : " e sem USAGE no schema"}`,
    exp.n === 0 && (schema === "public" || !uso.papeis), `${exp.n} privilégios (${exp.papeis ?? "—"}); USAGE: ${uso.papeis ?? "nenhum"}`);
  await a.query("set role service_role");
  const leitura = await tentar(a, `select count(*) from ${schema}.fv2_lancamento`);
  await a.query("reset role");
  ok("C3", "service_role (BYPASSRLS) NÃO consegue ler fv2_lancamento", leitura !== null, leitura ?? "LEU a tabela (RLS não protege papel com BYPASSRLS)");
  await a.query("set role authenticated");
  const leituraAuth = await tentar(a, `select count(*) from ${schema}.fv2_lancamento`);
  await a.query("reset role");
  ok("C3b", "authenticated NÃO consegue ler fv2_lancamento", leituraAuth !== null, leituraAuth ?? "LEU a tabela");
  const funcs = (await a.query(`select p.oid::regprocedure::text f, p.proowner::regrole::text dono, p.proconfig::text cfg,
      exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0 and x.privilege_type = 'EXECUTE') publico,
      (select string_agg(g.r, ',') from unnest(array['anon','authenticated','service_role']) g(r) where has_function_privilege(g.r, p.oid, 'execute')) comuns
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = '${schema}' and p.prosecdef`)).rows;
  const ruins = funcs.filter((f) => f.dono !== "fv2_guardiao" || !String(f.cfg).includes(`pg_catalog, ${schema}, pg_temp`) && !String(f.cfg).includes(`pg_catalog,${schema},pg_temp`) || f.publico || f.comuns);
  ok("C4", `${funcs.length} funções SECURITY DEFINER: dono fv2_guardiao, search_path fixo no schema, sem EXECUTE para PUBLIC/anon/authenticated/service_role`,
    funcs.length > 0 && ruins.length === 0, ruins.map((f) => `${f.f} dono=${f.dono} cfg=${f.cfg} publico=${f.publico} comuns=${f.comuns ?? ""}`).join(" | "));
  // PostgreSQL 16+: quem cria um papel sem ser superusuário recebe, automaticamente, ADMIN OPTION sobre ele (sem SET e
  // sem INHERIT). Não dá para usar os privilégios do guardião assim, mas dá para se conceder SET depois — por isso é
  // ATENÇÃO (faz parte do limite de confiança do C6), e qualquer outro tipo de participação é FALHA.
  const membros = (await a.query(`select m.rolname, x.admin_option a, x.inherit_option i, x.set_option s from pg_auth_members x
    join pg_roles r on r.oid = x.roleid join pg_roles m on m.oid = x.member where r.rolname = 'fv2_guardiao'`)).rows;
  const criar = await um(`select has_schema_privilege('fv2_guardiao', '${schema}', 'create') c`);
  const soAdminDoMigrador = membros.every((x) => x.rolname === "postgres" && x.a && !x.i && !x.s);
  r.push({ id: "C5", situacao: !soAdminDoMigrador || (schema !== "public" && criar.c) ? "FALHA" : membros.length ? "ATENÇÃO" : "OK",
    texto: "guardião sem membros utilizáveis (sem SET/INHERIT) e sem CREATE no schema ao fim",
    detalhe: `${membros.map((x) => `${x.rolname}(admin=${x.a},inherit=${x.i},set=${x.s})`).join(", ") || "0 membros"}; create=${criar.c}${membros.length ? " — participação ADMIN implícita do PG16+ (quem criou o papel); remover exige superusuário/suporte" : ""}` });
  const dono = await um(`select string_agg(distinct c.relowner::regrole::text, ',') d from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = '${schema}' and c.relname like 'fv2\\_%'`);
  const bypass = await um(`select rolbypassrls b from pg_roles where rolname = 'postgres'`);
  r.push({ id: "C6", situacao: "ATENÇÃO", texto: `dono das tabelas: ${dono.d}; papel postgres com BYPASSRLS=${bypass.b}`,
    detalhe: "quem tem a senha do papel postgres (ou do supabase_admin/painel SQL) lê tudo, como já ocorre com os dados da plataforma: limite de confiança a decidir (doc 24 § 11)" });
  await a.end();
  return r;
}

async function limparPapeisFv2(admin) {
  for (const papel of ["fv2_app", "fv2_autoridade", "fv2_guardiao"]) await tentar(admin, `drop role if exists ${papel}`);
}

// ------------------------------------------------------------------------------------------------------- execução
mkdirSync(PASTA, { recursive: true });
const DADOS = join(PASTA, "dados");
let ligado = false;
try {
  rodar("initdb", ["-D", DADOS, "-U", "sim_admin", "--auth=trust", "-E", "UTF8", "--locale=C"]);
  rodar("pg_ctl", ["start", "-D", DADOS, "-l", join(PASTA, "servidor.log"), "-o", `-c listen_addresses=127.0.0.1 -c cluster_name=${NONCE} -p ${PORTA}`, "-w"], true);
  ligado = true;
  const admin = await conectar("sim_admin", "postgres");
  const versao = (await admin.query("show server_version")).rows[0].server_version;
  await admin.query(PAPEIS_SUPABASE);
  const saida = [`Cluster descartável PostgreSQL ${versao} em 127.0.0.1:${PORTA} (${PASTA})`];

  for (const [id, banco, schema, adaptar] of [["E1", "sim_como_esta", "public", false], ["E2", "sim_dedicado", SCHEMA, true], ["E3", "sim_public_adaptado", "public", true]]) {
    await montarPlataforma(admin, banco);
    const noBanco = await conectar("sim_admin", banco);
    const antes = await inventarioAlheio(noBanco);
    const p = await conectar("postgres", banco);
    const res = await aplicar(p, { schema, adaptar });
    await p.end();
    const depois = await inventarioAlheio(noBanco);
    await noBanco.end();
    saida.push("", `${id} — schema ${schema}, ${adaptar ? "com adaptações A1–A4" : "migrações originais"}:`);
    saida.push(`  aplicação: ${res.erro ? `PARA em ${res.erro}` : "0001–0021 aplicadas como `postgres` (não superusuário)"}`);
    if (res.ocorrencias?.length) saida.push(`  A2 search_path adaptado: ${res.ocorrencias.join(" ")}`);
    const igual = String(antes) === String(depois);
    saida.push(`  ${igual ? "OK      " : "FALHA   "} C0   objetos, ACLs, políticas, privilégios padrão e papéis do sistema atual INALTERADOS (sha256 ${antes.slice(0, 12)}…${igual ? "" : ` → ${depois.slice(0, 12)}…: ${diferencas(antes, depois).join(" ; ")}`})`);
    if (!res.erro) for (const x of await verificar(admin, banco, schema)) saida.push(`  ${x.situacao.padEnd(8)} ${x.id.padEnd(4)} ${x.texto}${x.detalhe ? ` — ${x.detalhe}` : ""}`);
    await admin.query(`drop database ${banco} with (force)`);
    await limparPapeisFv2(admin);
  }
  // E4 — o PACOTE DE PRODUÇÃO (database/financeiro-v2/producao), exatamente como seria aplicado: uma transação, como
  // `postgres`; foto do sistema atual antes/depois (inventario.sql); reaplicar tem de abortar; desativar não apaga nada.
  {
    const pasta = join(PASTA_DE_MIGRACOES, "..", "producao");
    const [instalar, inventario, desativar] = ["instalar.sql", "inventario.sql", "desativar.sql"].map((n) => readFileSync(join(pasta, n), "utf8"));
    const banco = "sim_pacote";
    await montarPlataforma(admin, banco);
    const p = await conectar("postgres", banco);
    const foto = async () => (await p.query(inventario)).rows[0];
    const antes = await foto();
    let erro = null;
    try { await p.query("begin"); await p.query(instalar); await p.query("commit"); } catch (e) { erro = `${e.code}: ${e.message}`; await p.query("rollback"); }
    const depois = await foto();
    saida.push("", "E4 — pacote de produção (instalar.sql numa transação, como postgres):");
    saida.push(`  aplicação: ${erro ? `FALHOU → ${erro}` : "OK (pré e pós-condições do próprio pacote passaram)"}`);
    saida.push(`  ${antes.sha256 === depois.sha256 ? "OK      " : "FALHA   "} C0   foto do sistema atual (inventario.sql, ${antes.itens} itens) idêntica antes/depois: ${antes.sha256.slice(0, 12)}…${antes.sha256 === depois.sha256 ? "" : ` → ${depois.sha256.slice(0, 12)}…`}`);
    let segunda = null;
    try { await p.query("begin"); await p.query(instalar); await p.query("commit"); } catch (e) { segunda = e.message; await p.query("rollback"); }
    saida.push(`  ${segunda && /já existe/.test(segunda) ? "OK      " : "FALHA   "} R    reaplicar é recusado sem efeito: ${segunda ?? "NÃO abortou"}`);
    if (!erro) for (const x of await verificar(admin, banco, SCHEMA)) saida.push(`  ${x.situacao.padEnd(8)} ${x.id.padEnd(4)} ${x.texto}${x.detalhe ? ` — ${x.detalhe}` : ""}`);
    if (!erro) {
      await p.query("create role fv2_app_login login password 'sintetica-descartavel' in role fv2_app");
      const n0 = (await p.query("select count(*)::int n from financeiro_v2.fv2_migracao")).rows[0].n;
      await p.query(desativar);
      const login = (await p.query("select rolcanlogin from pg_roles where rolname = 'fv2_app_login'")).rows[0].rolcanlogin;
      const uso = (await p.query("select has_schema_privilege('fv2_app', 'financeiro_v2', 'usage') u")).rows[0].u;
      const n1 = (await p.query("select count(*)::int n from financeiro_v2.fv2_migracao")).rows[0].n;
      saida.push(`  ${!login && !uso && n0 === n1 ? "OK      " : "FALHA   "} D    desativar.sql: login cortado=${!login}, USAGE retirado=${!uso}, objetos e registros preservados (${n1}/${n0})`);
      const depoisDesativar = await foto();
      saida.push(`  ${depoisDesativar.sha256 === antes.sha256 ? "OK      " : "FALHA   "} C0'  sistema atual intacto também depois da desativação`);
    }
    await p.end();
    await admin.query(`drop database ${banco} with (force)`);
    await tentar(admin, "drop role if exists fv2_app_login");
    await limparPapeisFv2(admin);
  }
  await admin.end();
  process.stdout.write(`${saida.join("\n")}\n`);
} finally {
  if (ligado) { try { rodar("pg_ctl", ["stop", "-D", DADOS, "-m", "fast", "-w"], true); } catch { /* já parado */ } }
  if (!MANTER) rmSync(PASTA, { recursive: true, force: true });
  process.stdout.write(MANTER ? `Cluster mantido em ${PASTA}\n` : "Cluster descartável parado e apagado.\n");
}
