#!/usr/bin/env node
// SONDA DA ATUALIZAÇÃO 0023 (administração corporativa) sobre uma instalação 0001–0022 JÁ EXISTENTE, simulando o projeto
// Supabase: cluster PostgreSQL DESCARTÁVEL (initdb em pasta temporária, só 127.0.0.1, porta própria), papel `postgres` não
// superusuário com CREATEROLE, anon/authenticated/service_role/authenticator. Nada conecta fora do loopback nem lê .env.
//
//   node scripts/fv2/sondaAtualizacao.mjs [--instalacao <arquivo instalar.sql da versão anterior>] [--porta 54349]
//
// Passos: (1) instala a versão ANTERIOR (padrão: `git show origin/main:database/financeiro-v2/producao/instalar.sql` da árvore
// versionada; ou o arquivo informado), (2) grava dados sintéticos pré-existentes (escopo, liberação do Açaí), (3) aplica
// atualizar.sql como `postgres` numa transação, (4) confere: dados antigos intactos, Açaí continua só consulta,
// funções do guardião, aplicação sem acesso, participação do guardião desfeita, e que repetir a atualização ABORTA.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const valor = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const PORTA = Number(valor("--porta") ?? 54349) || 54349;
const RAIZ = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const PRODUCAO = join(RAIZ, "database", "financeiro-v2", "producao");
const EXE = process.platform === "win32" ? ".exe" : "";
const pg = (await import("pg")).default;

function binarios() {
  const c = [process.env.FV2_PG_BIN];
  const raiz = "C:\\Program Files\\PostgreSQL";
  if (process.platform === "win32" && existsSync(raiz)) for (const v of readdirSync(raiz).sort().reverse()) c.push(join(raiz, v, "bin"));
  const d = c.find((x) => x && ["initdb", "pg_ctl"].every((b) => existsSync(join(x, b + EXE))));
  if (!d) throw new Error("binários do PostgreSQL não encontrados (FV2_PG_BIN)");
  return d;
}
const BIN = binarios();
const rodar = (bin, a, silencioso = false) => {
  const r = spawnSync(join(BIN, bin + EXE), a, { encoding: "utf8", windowsHide: true, stdio: silencioso ? "ignore" : "pipe" });
  if (r.status !== 0) throw new Error(`${bin} falhou: ${r.stderr || r.stdout || r.status}`);
};
const anterior = valor("--instalacao")
  ? readFileSync(valor("--instalacao"), "utf8")
  : (() => { const r = spawnSync("git", ["-C", RAIZ, "show", "origin/main:database/financeiro-v2/producao/instalar.sql"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) throw new Error("não consegui ler instalar.sql anterior do git"); return r.stdout; })();
if (/0023_administracao_corporativa/.test(anterior)) throw new Error("a instalação informada já contém a 0023: use a versão anterior");
const atualizar = readFileSync(join(PRODUCAO, "atualizar.sql"), "utf8");

const pasta = join(tmpdir(), `fv2-sonda-atualizacao-${randomBytes(4).toString("hex")}`);
const nonce = `fv2atu${randomBytes(8).toString("hex")}`;
const dados = join(pasta, "dados");
mkdirSync(pasta, { recursive: true });
const conectar = async (usuario, banco) => {
  const cl = new pg.Client({ connectionString: `postgres://${usuario}@127.0.0.1:${PORTA}/${banco}` });
  await cl.connect();
  const { rows } = await cl.query("select current_setting('cluster_name') n, host(inet_server_addr()) e");
  if (rows[0].n !== nonce || rows[0].e !== "127.0.0.1") { await cl.end(); throw new Error("não é o cluster descartável desta sonda"); }
  return cl;
};
const resultados = [];
const conferir = (ok, texto, detalhe = "") => { resultados.push({ ok, texto, detalhe }); };
let ligado = false;
try {
  rodar("initdb", ["-D", dados, "-U", "sim_admin", "--auth=trust", "-E", "UTF8", "--locale=C"]);
  rodar("pg_ctl", ["start", "-D", dados, "-l", join(pasta, "servidor.log"), "-o", `-c listen_addresses=127.0.0.1 -c cluster_name=${nonce} -p ${PORTA}`, "-w"], true);
  ligado = true;
  const admin = await conectar("sim_admin", "postgres");
  await admin.query(`create role postgres login nosuperuser createrole createdb replication bypassrls;
    create role anon nologin noinherit; create role authenticated nologin noinherit; create role service_role nologin noinherit bypassrls;
    create role authenticator login noinherit; grant anon, authenticated, service_role to authenticator;`);
  await admin.query("create database sim owner postgres");
  await admin.end();
  const a = await conectar("sim_admin", "sim");
  await a.query(`create schema extensions; grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres grant all on tables to anon, authenticated, service_role;
    alter default privileges for role postgres grant all on functions to anon, authenticated, service_role;
    create publication supabase_realtime;`);
  await a.end();
  const p = await conectar("postgres", "sim");
  // (1) versão anterior, como seria aplicada
  await p.query(`begin;\n${anterior}\ncommit;`);
  // (2) dados sintéticos pré-existentes (como o Açaí hoje: escopo, empresa e unidade liberadas, uma administração)
  const ORG = "00000000-0000-4000-8000-0000000000aa", UNI = "00000000-0000-4000-8000-0000000000bb", ATOR = "00000000-0000-4000-8000-0000000000cc";
  await p.query("insert into financeiro_v2.fv2_escopo (organizacao_id, unidade_id, rotulo) values ($1, $2, 'Unidade sintética pré-existente')", [ORG, UNI]);
  await p.query("begin; grant fv2_guardiao to current_user");
  await p.query("select financeiro_v2.fv2_liberacao_alterar($1, null, true, $2, 'Empresa ligada na sonda (sintético).', now())", [ORG, ATOR]);
  await p.query("select financeiro_v2.fv2_liberacao_alterar($1, $2, true, $3, 'Unidade ligada na sonda (sintético).', now())", [ORG, UNI, ATOR]);
  await p.query("revoke fv2_guardiao from current_user; commit");
  const antes = (await p.query("select count(*)::int n from financeiro_v2.fv2_liberacao")).rows[0].n;
  // (3) a atualização, numa transação, como `postgres`
  try { await p.query(`begin;\n${atualizar}\ncommit;`); conferir(true, "atualizar.sql aplicada como postgres (não superusuário) numa transação"); }
  catch (e) { await p.query("rollback").catch(() => {}); conferir(false, "atualizar.sql", `${e.code}: ${e.message}`); throw e; }
  // (4) conferências
  const s = await conectar("sim_admin", "sim");
  const q = async (sql, par = []) => (await s.query(sql, par)).rows;
  conferir((await q("select count(*)::int n from financeiro_v2.fv2_migracao"))[0].n === 23, "23 migrações registradas");
  conferir((await q("select count(*)::int n from financeiro_v2.fv2_liberacao"))[0].n === antes, "liberações anteriores preservadas", String(antes));
  const lib = await q("select unidade_id, ativa, escrita_ativa from financeiro_v2.fv2_liberacao");
  conferir(lib.length > 0 && lib.every((l) => l.escrita_ativa === false), "unidades anteriores ficam SEM escrita (só consulta)");
  const fns = await q(`select p.proname, pg_get_userbyid(p.proowner) dono, has_function_privilege('public', p.oid, 'execute') publico, has_function_privilege('fv2_app', p.oid, 'execute') app,
      has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('service_role', p.oid, 'execute') sr
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'financeiro_v2' and p.proname in ('fv2_administrador_corporativo_ativo','fv2_administrador_corporativo_definir','fv2_liberacao_alterar_lote','fv2_conceder_por_administrador','fv2_painel_liberacoes','fv2_painel_acessos','fv2_painel_administradores')`);
  conferir(fns.length === 7 && fns.every((f) => f.dono === "fv2_guardiao" && !f.publico && !f.app && !f.anon && !f.auth && !f.sr), "7 funções novas: do guardião, sem PUBLIC, sem aplicação, sem anon/authenticated/service_role");
  const tabelas = await q(`select c.relname, c.relrowsecurity,
      has_table_privilege('fv2_app', c.oid, 'select') app, has_table_privilege('anon', c.oid, 'select') anon, has_table_privilege('authenticated', c.oid, 'select') auth, has_table_privilege('service_role', c.oid, 'select') sr
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'financeiro_v2' and c.relname in ('fv2_administrador_corporativo','fv2_administrador_corporativo_historico')`);
  conferir(tabelas.length === 2 && tabelas.every((t) => t.relrowsecurity && !t.app && !t.anon && !t.auth && !t.sr), "tabelas de administração: RLS ligado e nenhum acesso da aplicação nem de anon/authenticated/service_role");
  conferir((await q("select count(*)::int n from pg_auth_members am join pg_roles r on r.oid = am.roleid where r.rolname = 'fv2_guardiao' and (am.set_option or am.inherit_option)"))[0].n === 0, "o guardião termina sem participação utilizável");
  const fora = await q("select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relname like 'fv2\\_%' and n.nspname <> 'financeiro_v2'");
  conferir(fora[0].n === 0, "nada do módulo fora do schema dedicado");
  conferir((await q("select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'fv2%'"))[0].n === 0, "nenhuma função fv2 no public");
  // repetir ABORTA sem alterar nada
  let abortou = false;
  try { await p.query(`begin;\n${atualizar}\ncommit;`); } catch (e) { abortou = /migrações registradas/.test(e.message); await p.query("rollback").catch(() => {}); }
  conferir(abortou, "repetir a atualização ABORTA (já aplicada)");
  await s.end();
  await p.end();
} catch (e) {
  conferir(false, "erro da sonda", String(e.message).slice(0, 400));
} finally {
  if (ligado) { try { rodar("pg_ctl", ["stop", "-D", dados, "-m", "immediate", "-w"], true); } catch { /* segue */ } }
  rmSync(pasta, { recursive: true, force: true });
}
for (const r of resultados) process.stdout.write(`${r.ok ? "OK    " : "FALHA "} ${r.texto}${r.detalhe ? ` — ${r.detalhe}` : ""}\n`);
process.exit(resultados.every((r) => r.ok) ? 0 : 1);
