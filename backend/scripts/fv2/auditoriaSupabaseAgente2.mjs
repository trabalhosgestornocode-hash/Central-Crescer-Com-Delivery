#!/usr/bin/env node
// AUDITORIA INDEPENDENTE DO SCHEMA DEDICADO NO SUPABASE SIMULADO (Agente 2 — apoio à implantação).
//
// Complementa a sonda da 09C (`sondaSupabaseSimulado.mjs`), que prova C0–C6. Aqui se verifica o que a sonda NÃO cobre:
//   K1 privilégios efetivos de cada papel em cada tabela (inclui DELETE/TRUNCATE, que passam por cima de RLS e gatilhos)
//   K2 funções executáveis pelos papéis do módulo; SECURITY DEFINER só na lista esperada (as concessões das migrações)
//   K3 privilégios PADRÃO: um objeto criado depois no schema (canário) fica alcançável por credencial comum?
//   K4 publicações de replicação (Realtime): alguma tabela fv2_* entra em publicação?
//   K5 ataques por SQL direto com o LOGIN da aplicação (sem sessão, token forjado, contexto manipulado, DDL, guardião)
//   K6 o LOGIN do gateway não lê dado financeiro nem escreve fora das funções dele
// Dois cenários de "Supabase" (cada um num cluster novo):
//   S1 padrão público conhecido: privilégios padrão do papel `postgres` SÓ no schema public (como a sonda)
//   S2 hostil: privilégios padrão GLOBAIS do `postgres` (sem "in schema") + publicação `supabase_realtime` FOR ALL TABLES
//
//   node scripts/fv2/auditoriaSupabaseAgente2.mjs [--porta 54369]
//
// Só 127.0.0.1, cluster descartável em pasta temporária, apagado no fim; não lê .env; nenhuma credencial real; nada
// remoto. As migrações 0001–0021 NÃO são alteradas: o texto aplicado recebe só as adaptações A1–A4 do doc 24 § 11.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listarMigracoes } from "./ambiente.mjs";

const args = process.argv.slice(2);
const PORTA = Number(args[args.indexOf("--porta") + 1] || 54369) || 54369;
const EXE = process.platform === "win32" ? ".exe" : "";
const SCHEMA = "financeiro_v2";
const SP_ORIGINAL = "set search_path = pg_catalog, public, pg_temp";
// Funções SECURITY DEFINER que as migrações concedem (0011, 0012, 0021): qualquer outra executável é achado.
const DEFINER_ESPERADO = {
  fv2_app: ["fv2__sessao_vigente()", "fv2_gravar_concessao(jsonb,integer)", "fv2_tem_acao(text[])", "fv2_liberacao_estado(uuid,uuid)"],
  fv2_autoridade: ["fv2_abrir_sessao(uuid,uuid,uuid,integer,text)", "fv2_abrir_sessao_de_provisionamento(uuid,uuid,uuid,uuid,jsonb,text,text,text)", "fv2_encerrar_sessoes(uuid,uuid,uuid,text)", "fv2_liberacao_estado(uuid,uuid)", "fv2_liberacao_alterar(uuid,uuid,boolean,uuid,text,timestamp with time zone)"],
};

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

async function cenario(id, { padraoGlobal, publicacaoTotal, a5 = false }) {
  const pasta = join(tmpdir(), `fv2-auditoria-agente2-${randomBytes(4).toString("hex")}`);
  const nonce = `fv2aud${randomBytes(8).toString("hex")}`;
  const dados = join(pasta, "dados");
  mkdirSync(pasta, { recursive: true });
  const conectar = async (usuario, banco) => {
    const cl = new pg.Client({ connectionString: `postgres://${usuario}@127.0.0.1:${PORTA}/${banco}` });
    await cl.connect();
    const { rows } = await cl.query("select current_setting('cluster_name') n, host(inet_server_addr()) e");
    if (rows[0].n !== nonce || rows[0].e !== "127.0.0.1") { await cl.end(); throw new Error("não é o cluster descartável desta auditoria"); }
    return cl;
  };
  const tentar = async (cl, sql, p = []) => { try { const r = await cl.query(sql, p); return { ok: true, linhas: r.rowCount, rows: r.rows }; } catch (e) { return { ok: false, erro: `${e.code}: ${e.message}` }; } };
  const r = [];
  const registrar = (k, situacao, texto, detalhe = "") => r.push({ k, situacao, texto, detalhe });
  let ligado = false;
  try {
    rodar("initdb", ["-D", dados, "-U", "sim_admin", "--auth=trust", "-E", "UTF8", "--locale=C"]);
    rodar("pg_ctl", ["start", "-D", dados, "-l", join(pasta, "servidor.log"), "-o", `-c listen_addresses=127.0.0.1 -c cluster_name=${nonce} -p ${PORTA}`, "-w"], true);
    ligado = true;
    const admin = await conectar("sim_admin", "postgres");
    await admin.query(`
      create role postgres login nosuperuser createrole createdb replication bypassrls;
      create role anon nologin noinherit; create role authenticated nologin noinherit;
      create role service_role nologin noinherit bypassrls; create role authenticator login noinherit;
      grant anon, authenticated, service_role to authenticator;`);
    await admin.query("create database sim owner postgres");
    await admin.end();
    const a = await conectar("sim_admin", "sim");
    await a.query(`create schema extensions; grant usage on schema public to anon, authenticated, service_role;
      ${padraoGlobal
        ? "alter default privileges for role postgres grant all on tables to anon, authenticated, service_role; alter default privileges for role postgres grant all on functions to anon, authenticated, service_role; alter default privileges for role postgres grant all on sequences to anon, authenticated, service_role;"
        : "alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role; alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;"}
      ${publicacaoTotal ? "create publication supabase_realtime for all tables;" : "create publication supabase_realtime;"}`);
    await a.end();

    // ---- aplicação como `postgres` (não superusuário) com A1–A4
    const p = await conectar("postgres", "sim");
    await p.query(`create schema ${SCHEMA}; revoke all on schema ${SCHEMA} from public; set search_path = ${SCHEMA}, pg_catalog`);
    await p.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'fv2_app') then create role fv2_app nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'fv2_autoridade') then create role fv2_autoridade nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'fv2_guardiao') then create role fv2_guardiao nologin; end if; end $$`);
    await p.query(`grant usage on schema ${SCHEMA} to fv2_app, fv2_autoridade, fv2_guardiao`);
    await p.query("create table fv2_migracao (nome text primary key, sha256 text not null, aplicada_em timestamptz not null default now())");
    for (const m of listarMigracoes()) {
      const sql = m.sql.replaceAll(SP_ORIGINAL, `set search_path = pg_catalog, ${SCHEMA}, pg_temp`);
      if (/search_path\s*=\s*pg_catalog,\s*public/.test(sql)) throw new Error(`${m.nome}: search_path com public`);
      const doGuardiao = (await p.query("select distinct proname from pg_proc where proowner = (select oid from pg_roles where rolname = 'fv2_guardiao')")).rows.map((x) => x.proname);
      const posse = /owner to fv2_guardiao/.test(sql) || doGuardiao.some((f) => new RegExp(String.raw`create\s+or\s+replace\s+function\s+${f}\s*\(`, "i").test(sql));
      await p.query("begin");
      try {
        if (posse) await p.query(`grant fv2_guardiao to current_user; grant create on schema ${SCHEMA} to fv2_guardiao`);
        await p.query(sql);
        if (posse) await p.query(`revoke create on schema ${SCHEMA} from fv2_guardiao; revoke fv2_guardiao from current_user`);
        // A5 (proposta do Agente 2): privilégio padrão GLOBAL do papel de migração não se revoga com IN SCHEMA; então, na
        // MESMA transação de cada migração, retira-se das credenciais comuns o que os padrões deram aos objetos novos. Como
        // as funções protegidas são do guardião, usa a MESMA participação temporária da A3, revogada antes do commit.
        if (a5) await p.query(`grant fv2_guardiao to current_user;
          revoke all on all tables in schema ${SCHEMA} from anon, authenticated, service_role;
          revoke all on all sequences in schema ${SCHEMA} from anon, authenticated, service_role;
          revoke all on all functions in schema ${SCHEMA} from anon, authenticated, service_role;
          revoke fv2_guardiao from current_user`);
        await p.query("insert into fv2_migracao (nome, sha256) values ($1, $2)", [m.nome, m.sha256]);
        await p.query("commit");
      } catch (e) { await p.query("rollback"); throw new Error(`${m.nome} → ${e.code}: ${e.message}`); }
    }
    // Logins próprios do módulo (como no doc 24): search_path NO PAPEL, nunca no banco da plataforma.
    await p.query(`create role fv2_app_login login in role fv2_app; alter role fv2_app_login set search_path = ${SCHEMA}, pg_catalog;
      create role fv2_gateway_login login in role fv2_autoridade; alter role fv2_gateway_login set search_path = ${SCHEMA}, pg_catalog;`);
    registrar("K0", "OK", `0001–0021 aplicadas como postgres no schema ${SCHEMA} (${padraoGlobal ? "padrões GLOBAIS do postgres" : "padrões só no public"}${publicacaoTotal ? ", publicação FOR ALL TABLES" : ""})`);

    const sa = await conectar("sim_admin", "sim");
    // K1 — privilégios por papel e tabela
    const papeis = ["fv2_app", "fv2_autoridade", "anon", "authenticated", "service_role", "authenticator", "public"];
    const priv = (await sa.query(`select c.relname t, g.r, x.privilege_type pr
      from pg_class c join pg_namespace n on n.oid = c.relnamespace,
      lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
      join lateral (select case when x.grantee = 0 then 'public' else x.grantee::regrole::text end r) g on true
      where n.nspname = $1 and c.relkind in ('r','p') and g.r = any($2::text[]) order by 1,2,3`, [SCHEMA, papeis])).rows;
    const de = (papel, tipos) => priv.filter((x) => x.r === papel && tipos.includes(x.pr));
    const apagar = [...de("fv2_app", ["DELETE", "TRUNCATE"]), ...de("fv2_autoridade", ["DELETE", "TRUNCATE"])];
    registrar("K1a", apagar.length ? "FALHA" : "OK", "papéis do módulo sem DELETE/TRUNCATE em tabela alguma (nada se apaga; TRUNCATE passaria por cima de RLS e gatilhos)", apagar.map((x) => `${x.t}:${x.r}:${x.pr}`).join(", "));
    const comuns = priv.filter((x) => ["anon", "authenticated", "service_role", "authenticator", "public"].includes(x.r));
    registrar("K1b", comuns.length ? "ATENÇÃO" : "OK", "credenciais comuns e PUBLIC sem privilégio NAS TABELAS (a barreira principal é o USAGE do schema, provado pela sonda C2)", comuns.length ? `${comuns.length} privilégios herdados de padrões (${[...new Set(comuns.map((x) => x.r))].join(",")}); sem USAGE no schema continuam inalcançáveis` : "");
    const autFin = de("fv2_autoridade", ["SELECT", "INSERT", "UPDATE"]).filter((x) => !/^fv2_(sessao_banco|provisionamento_inicial|liberacao|liberacao_historico|auditoria_concessao|concessao|escopo|historico)$/.test(x.t));
    registrar("K1c", autFin.length ? "ATENÇÃO" : "OK", "autoridade (gateway) sem privilégio direto em tabela financeira (opera só pelas funções guardadas)", autFin.map((x) => `${x.t}:${x.pr}`).join(", "));
    // K2 — funções executáveis
    const exec = (await sa.query(`select p.oid::regprocedure::text f, p.prosecdef d, g.r
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest($2::text[]) g(r)
      where n.nspname = $1 and has_function_privilege(g.r, p.oid, 'execute') order by 1,3`, [SCHEMA, ["fv2_app", "fv2_autoridade", "anon", "authenticated", "service_role"]])).rows;
    const definerExtra = exec.filter((x) => x.d && ["fv2_app", "fv2_autoridade"].includes(x.r) && !DEFINER_ESPERADO[x.r].includes(x.f.replace(/^financeiro_v2\./, "")));
    registrar("K2a", definerExtra.length ? "FALHA" : "OK", "SECURITY DEFINER executável pelos papéis do módulo só na lista concedida pelas migrações", definerExtra.map((x) => `${x.f}→${x.r}`).join(", "));
    const execComuns = exec.filter((x) => ["anon", "authenticated", "service_role"].includes(x.r));
    registrar("K2b", execComuns.length ? "ATENÇÃO" : "OK", "credenciais comuns sem EXECUTE efetivo em funções do schema", execComuns.length ? `${execComuns.length} (EXECUTE herdado; sem USAGE no schema não alcançam)` : "");
    const definerComuns = execComuns.filter((x) => x.d);
    registrar("K2c", definerComuns.length ? "FALHA" : "OK", "nenhuma função SECURITY DEFINER executável por anon/authenticated/service_role (o C4 da sonda, aqui também no cenário hostil)",
      definerComuns.length ? `${definerComuns.length}: ${[...new Set(definerComuns.map((x) => x.f.replace(/^financeiro_v2\./, "")))].slice(0, 4).join(", ")}… (sem USAGE no schema ainda inalcançáveis, mas a 2ª barreira some)` : "");
    // K3 — canário: objeto criado DEPOIS no schema, pelo dono das migrações
    await p.query(`create table ${SCHEMA}.fv2_canario (id int)`);
    // Com A5, o canário faz o papel de uma migração futura: a revogação explícita vem junto, como em toda migração.
    if (a5) await p.query(`revoke all on all tables in schema ${SCHEMA} from anon, authenticated, service_role`);
    const can = (await sa.query(`select string_agg(g.r, ',') p from unnest(array['anon','authenticated','service_role']) g(r) where has_table_privilege(g.r, '${SCHEMA}.fv2_canario', 'select')`)).rows[0].p;
    registrar("K3", can ? "ATENÇÃO" : "OK", "tabela criada depois no schema (canário) sem privilégio para credenciais comuns", can ? `privilégios padrão globais alcançam o canário (${can}): sem USAGE ainda é inalcançável, mas a 2ª barreira some — privilégio padrão GLOBAL não se revoga com IN SCHEMA: aplicar A5 (revogar de anon/authenticated/service_role em tabelas, sequências e funções do schema ao fim de CADA migração ou DDL)` : "");
    await p.query(`drop table ${SCHEMA}.fv2_canario`);
    // K4 — publicações
    const pub = (await sa.query(`select pubname, puballtables from pg_publication`)).rows;
    const pubTabs = (await sa.query(`select pubname, count(*)::int n from pg_publication_tables where schemaname = $1 group by 1`, [SCHEMA])).rows;
    registrar("K4", pubTabs.length ? "FALHA" : "OK", "nenhuma tabela fv2_* em publicação de replicação (Realtime/replicação lógica não difunde dado financeiro)",
      pubTabs.length ? `${pubTabs.map((x) => `${x.pubname}:${x.n} tabelas`).join(", ")} — publicação FOR ALL TABLES inclui o schema novo; exige \`alter publication … \` com lista explícita ou confirmar que a do projeto não é FOR ALL TABLES` : `publicações: ${pub.map((x) => `${x.pubname}(all=${x.puballtables})`).join(", ")}`);
    await sa.end();

    // K5 — LOGIN da aplicação, sem sessão do gateway
    const app = await conectar("fv2_app_login", "sim");
    const k5 = [
      ["sem sessão, leitura de dado financeiro", "select count(*)::int n from fv2_lancamento", (x) => (x.ok && x.rows[0].n === 0) || !x.ok],
      ["sem sessão, escrita direta", `insert into fv2_contraparte (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, tipo, nome) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, now(), gen_random_uuid(), now(), gen_random_uuid(), 'FORNECEDOR', 'x')`, (x) => !x.ok],
      ["TRUNCATE", "truncate fv2_lancamento", (x) => !x.ok],
      ["DELETE", "delete from fv2_lancamento", (x) => !x.ok || x.linhas === 0],
      ["tabela guardada (sessões)", "select count(*) from fv2_sessao_banco", (x) => !x.ok],
      ["tabela guardada (liberação)", "select count(*) from fv2_liberacao", (x) => !x.ok],
      ["abrir sessão (função do gateway)", "select fv2_abrir_sessao(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 60, 'x')", (x) => !x.ok],
      ["conceder a si mesmo sem sessão", "select fv2_gravar_concessao('{}'::jsonb, 0)", (x) => !x.ok],
      ["virar guardião", "set role fv2_guardiao", (x) => !x.ok],
      ["desligar RLS", "alter table fv2_lancamento disable row level security", (x) => !x.ok],
      ["criar objeto no schema", "create table fv2_intruso (id int)", (x) => !x.ok],
      ["ler a plataforma (public)", "select count(*) from pg_catalog.pg_class where relnamespace = 'public'::regnamespace", () => true],
    ];
    const falhasK5 = [];
    for (const [nome, sql, aceito] of k5.slice(0, -1)) { const x = await tentar(app, sql); if (!aceito(x)) falhasK5.push(`${nome}: ${x.ok ? "PASSOU" : x.erro}`); }
    // Token forjado e contexto manipulado: por desenho NÃO dão erro — resultam em NENHUMA sessão (o lado seguro). Mede o
    // EFEITO: sem sessão vigente, sem ação concedida, e a escrita continua recusada.
    for (const [nome, preparo] of [["token forjado", "select fv2_assumir_sessao('token-forjado-' || md5(random()::text))"], ["contexto manipulado (set_config)", "select set_config('fv2.sessao', md5(random()::text), true)"]]) {
      await app.query("begin");
      const prep = await tentar(app, preparo);
      const est = await tentar(app, "select (select count(*) from fv2__sessao_vigente())::int s, coalesce(fv2_tem_acao(array['financeiro_v2.ver','financeiro_v2.registrar']), false) t, (select count(*) from fv2_lancamento)::int l");
      await app.query("savepoint e");
      const esc = await tentar(app, "insert into fv2_contraparte (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, tipo, nome) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, now(), gen_random_uuid(), now(), gen_random_uuid(), 'FORNECEDOR', 'x')");
      await app.query("rollback");
      const seguro = prep.ok && est.ok && est.rows[0].s === 0 && est.rows[0].t === false && est.rows[0].l === 0 && !esc.ok;
      if (!seguro) falhasK5.push(`${nome}: sessão=${est.rows?.[0]?.s} ação=${est.rows?.[0]?.t} linhas=${est.rows?.[0]?.l} escrita=${esc.ok ? "PASSOU" : "recusada"}`);
    }
    registrar("K5", falhasK5.length ? "FALHA" : "OK", `login da aplicação sem sessão: ${k5.length + 1} ataques diretos por SQL bloqueados (leitura, escrita, token forjado, contexto, TRUNCATE/DELETE, guardadas, funções do gateway, autoconcessão, SET ROLE, RLS, DDL)`, falhasK5.join(" | "));
    await app.end();
    // K6 — LOGIN do gateway
    const gw = await conectar("fv2_gateway_login", "sim");
    const k6 = [["ler dado financeiro", "select count(*) from fv2_lancamento"], ["escrever dado financeiro", "insert into fv2_venda (id) values (gen_random_uuid())"], ["ler sessões direto", "select count(*) from fv2_sessao_banco"], ["virar guardião", "set role fv2_guardiao"]];
    const falhasK6 = [];
    for (const [nome, sql] of k6) { const x = await tentar(gw, sql); if (x.ok && !(x.rows?.[0]?.count === "0" && /lancamento/.test(sql))) falhasK6.push(`${nome}: PASSOU`); }
    registrar("K6", falhasK6.length ? "FALHA" : "OK", "login do gateway não lê nem escreve dado financeiro e não usa o guardião (só as funções concedidas)", falhasK6.join(" | "));
    await gw.end();
    await p.end();
  } finally {
    if (ligado) { try { rodar("pg_ctl", ["stop", "-D", dados, "-m", "fast", "-w"], true); } catch { /* parado */ } }
    rmSync(pasta, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  }
  return r.map((x) => `  ${x.situacao.padEnd(8)} ${x.k.padEnd(4)} ${x.texto}${x.detalhe ? ` — ${x.detalhe}` : ""}`).join("\n");
}

const saida = [];
saida.push("S1 — Supabase simulado com privilégios padrão do postgres só no public:", await cenario("S1", { padraoGlobal: false, publicacaoTotal: false }));
saida.push("", "S2 — Supabase simulado HOSTIL: privilégios padrão GLOBAIS do postgres + publicação FOR ALL TABLES:", await cenario("S2", { padraoGlobal: true, publicacaoTotal: true }));
saida.push("", "S3 — o mesmo cenário HOSTIL com a adaptação A5 (revogação explícita ao fim de cada migração):", await cenario("S3", { padraoGlobal: true, publicacaoTotal: true, a5: true }));
process.stdout.write(`${saida.join("\n")}\nClusters descartáveis parados e apagados.\n`);
