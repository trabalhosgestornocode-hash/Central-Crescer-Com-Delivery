// Aplicação das migrations 120 → 121 → 122 do Dashboard Financeiro em PRODUÇÃO (uqybgauuxcrqzquultfu), com travas.
// Só um OPERADOR AUTORIZADO roda este script, no PRÓPRIO terminal. A conexão vem SÓ de PROD_CONN, definida por ele;
// o script nunca a lê de arquivo (.env), nunca a imprime e nunca a grava. Procedimento: docs/gestao-financeira/25-procedimento-producao.md
//   node backend/testes-seguros/producao/prod-migrar.mjs preflight   -> somente leitura; imprime PROD_IDENTIDADE
//   PROD_IDENTIDADE=<…> PROD_AUTORIZO=SIM PROD_BACKUP_CONFIRMADO=SIM node …/prod-migrar.mjs aplicar
//   PROD_IDENTIDADE=<…> node …/prod-migrar.mjs verificar             -> somente leitura (catálogo 23/23 + tabelas compartilhadas)
// Ensaio: PROD_ENSAIO_LOCAL=1 aceita só 127.0.0.1:54321 com MARCADOR_DESCARTAVEL (PG_CLUSTER_DIR); nada mais muda.
// Os arquivos aplicados são conferidos por sha256 (lista fechada abaixo): qualquer mudança neles exige atualizar esta lista.
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const REF_PROD = "uqybgauuxcrqzquultfu", REF_TESTE = "wiqqsxnysbzhcrzrrean";
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ARQ = [
  ["database/migrations/120_gestao_financeira_fundacao.sql", "9f10b0dd66ca4dff4aff22fb15f0b0d6f3010addb74604db55a99b4b1cb7ee48"],
  ["database/migrations/121_gestao_financeira_dominio.sql", "32e0d881bb5bd9fe986eca918d808b91b0dfec2b846ecd7c0b206259e9f49e25"],
  ["database/migrations/122_conciliacao_periodos.sql", "d8133d00e0f427fcd17467e4c13f512b93d4051b98afec43d903a1ddf45fa500"],
];
const CATALOGO = ["backend/testes-seguros/t3/verificacoes_catalogo.sql", "63281db4711eb1bf4ab5b908cc4f4166a0c7f1c925fdd7198809b629858bb809"];
const E = process.env, ENSAIO = E.PROD_ENSAIO_LOCAL === "1";
const EVID = E.PROD_EVIDENCIAS || path.join(os.tmpdir(), "evidencias-prod");   // fora do Git; sem a conexão
const PSQL = E.PSQL || (existsSync("C:/Program Files/PostgreSQL/17/bin/psql.exe") ? "C:/Program Files/PostgreSQL/17/bin/psql.exe" : "psql");
const sair = (c, m) => { (c ? console.error : console.log)(m); process.exit(c); };
const CONN = E.PROD_CONN ?? "";
const ocultar = (s) => String(s ?? "").split(CONN || "\u0000").join("<conexão>");

// ---------- travas de alvo ----------
function travas() {
  const e = [];
  if (!CONN) e.push("defina PROD_CONN no seu terminal (não cole a conexão no chat)");
  if (CONN.includes(REF_TESTE)) e.push("PROD_CONN aponta para o projeto de TESTES");
  if (ENSAIO) {
    if (!/@127\.0\.0\.1:54321\//.test(CONN)) e.push("ensaio: só 127.0.0.1:54321");
    if (!E.PG_CLUSTER_DIR || !existsSync(path.join(E.PG_CLUSTER_DIR, "MARCADOR_DESCARTAVEL"))) e.push("ensaio: PG_CLUSTER_DIR sem MARCADOR_DESCARTAVEL");
  } else {
    let u; try { u = new URL(CONN); } catch { e.push("PROD_CONN não é uma URL postgres"); }
    if (u) {
      const host = u.hostname, user = decodeURIComponent(u.username);
      const direto = host === `db.${REF_PROD}.supabase.co`, pooler = /\.pooler\.supabase\.com$/.test(host) && user === `postgres.${REF_PROD}`;
      if (!direto && !pooler) e.push(`host/usuário não são do projeto de produção ${REF_PROD}`);
      if ((u.port || "5432") === "6543") e.push("porta 6543 (pooler em modo transação): use a conexão direta ou o pooler de sessão (5432)");
      if (!(direto ? user === "postgres" : true)) e.push("na conexão direta o usuário deve ser postgres");
    }
  }
  return e;
}
function psql(args, { input, leitura = false } = {}) {
  const env = {}; for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) if (E[k]) env[k] = E[k];
  if (!env.SystemRoot && !env.SYSTEMROOT) env.SystemRoot = "C:\\WINDOWS";
  Object.assign(env, { PGCLIENTENCODING: "UTF8", PGAPPNAME: "financeiro-migracao-120-122", PGCONNECT_TIMEOUT: "15",
    PGOPTIONS: leitura ? "-c default_transaction_read_only=on -c statement_timeout=60000" : "-c statement_timeout=300000" });
  const r = spawnSync(PSQL, ["-X", "-v", "ON_ERROR_STOP=1", ...args, CONN], { input, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, saida: ocultar(r.stdout), erro: ocultar(r.stderr) };
}
function evid(nome, txt) { mkdirSync(EVID, { recursive: true }); const f = path.join(EVID, `${nome}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`); writeFileSync(f, txt); return f; }
const sha = (t) => createHash("sha256").update(t).digest("hex");

const SQL_IDENT = `select md5((select oid::text from pg_database where datname = current_database()) || '|' || 'public'::regnamespace::oid::text || '|' || current_database())`;
// tabelas compartilhadas que as migrations podem tocar: só modulos pode mudar (+1 linha)
const COMPARTILHADAS = ["modulos", "organizacoes", "unidades", "organizacao_modulos", "unidade_modulos", "perfis", "usuarios_organizacoes"];
const SQL_IMPRESSAO = COMPARTILHADAS.map((t) =>
  `select '${t}' as t, count(*) as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '-') as h from public.${t} x`).join("\nunion all\n") + ";";
const SQL_PREFLIGHT = `
select current_user as usuario, (select rolsuper from pg_roles where rolname = current_user) as superusuario,
       (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls, current_setting('server_version') as versao,
       current_setting('transaction_read_only') as somente_leitura;
select (select count(*) from pg_class where relnamespace = 'public'::regnamespace and (relname like 'fin\\_%' or relname like 'gestao\\_financeira\\_%')) as objetos_financeiros,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'fin\\_%' or proname like 'gfc\\_%' or proname like 'gestao\\_financeira\\_%')) as funcoes_financeiras,
       (select count(*) from public.modulos) as modulos, exists (select 1 from public.modulos where id = 'gestao_financeira') as modulo_financeiro_existe,
       exists (select 1 from public.modulos where id = 'checklist_operacional') as checklist_123;
select pg_get_constraintdef(c.oid) as check_categoria from pg_constraint c where c.conrelid = 'public.modulos'::regclass and c.contype = 'c';
select p.oid::regprocedure as funcao, pg_get_userbyid(p.proowner) as dono, pg_has_role(current_user, p.proowner, 'USAGE') as quem_aplica_administra
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('remapear_organizacao_em_tabelas_de_unidade', 'transferir_unidade_organizacao', 'promover_unidade_para_empresa');
select has_function_privilege('anon', 'public.transferir_unidade_organizacao(uuid,uuid,uuid,text,text,text)', 'execute') as anon_executa_transferir,
       coalesce((select has_table_privilege('anon', 'public.vw_faturamento_diario', 'select') where to_regclass('public.vw_faturamento_diario') is not null), false) as anon_le_view_115;
select string_agg(tgname, ', ' order by tgname) as gatilhos_unidades from pg_trigger where tgrelid = 'public.unidades'::regclass and not tgisinternal;
select (select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle') as sessoes_ativas_outras,
       (select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and xact_start < now() - interval '60 seconds') as transacoes_longas,
       (select count(*) from pg_locks where not granted) as locks_esperando;
select (select count(*) from public.organizacoes) as organizacoes, (select count(*) from public.unidades) as unidades;
`;
function lerIdent() { const r = psql(["-tA", "-c", SQL_IDENT], { leitura: true }); if (r.status !== 0) sair(2, `RECUSADO: ${r.erro.split("\n")[0]}`); return r.saida.trim(); }
function lerImpressao() {
  const r = psql(["-tA", "-F", "|", "-c", SQL_IMPRESSAO], { leitura: true }); if (r.status !== 0) sair(2, `impressão falhou: ${r.erro.split("\n")[0]}`);
  return Object.fromEntries(r.saida.trim().split(/\r?\n/).map((l) => { const [t, n, h] = l.split("|"); return [t, { n: Number(n), h }]; }));
}
function catalogo() {
  const r = psql(["-f", path.join(RAIZ, CATALOGO[0])], { leitura: true });
  const linhas = r.saida.split(/\r?\n/).filter((l) => /\|\s*[tf]\s*$/.test(l));
  return { status: r.status, t: linhas.filter((l) => /\|\s*t\s*$/.test(l)).length, f: linhas.filter((l) => /\|\s*f\s*$/.test(l)), saida: r.saida, erro: r.erro };
}
function arquivosConferidos() {
  const head = execFileSync("git", ["-C", RAIZ, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  console.log(`repositório em ${head}; conferindo sha256 dos arquivos aplicados`);
  for (const [rel, esp] of [...ARQ, CATALOGO]) {
    if (execFileSync("git", ["-C", RAIZ, "status", "--porcelain", "--", rel], { encoding: "utf8" }).trim()) sair(2, `RECUSADO: ${rel} alterado localmente`);
    const s = sha(readFileSync(path.join(RAIZ, rel))); if (s !== esp) sair(2, `RECUSADO: sha256 de ${rel} = ${s.slice(0, 16)}…, esperado ${esp.slice(0, 16)}…`);
  }
}

const passo = process.argv[2];
if (!["preflight", "aplicar", "verificar"].includes(passo)) sair(2, "uso: node prod-migrar.mjs preflight | aplicar | verificar");
const erros = travas(); if (erros.length) sair(2, erros.map((x) => `RECUSADO: ${x}`).join("\n"));
console.log(`${ENSAIO ? "ENSAIO LOCAL — " : ""}alvo: ${ENSAIO ? "127.0.0.1:54321 (descartável)" : `produção ${REF_PROD}`} | passo: ${passo}`);

if (passo === "preflight") {
  arquivosConferidos();
  const ident = lerIdent();
  const r = psql(["-f", "-"], { input: `begin transaction read only;\n${SQL_PREFLIGHT}\nrollback;\n`, leitura: true });
  if (r.status !== 0) sair(2, `preflight falhou: ${r.erro.split("\n")[0]}`);
  const imp = lerImpressao();
  const f = evid("preflight", `identidade ${ident}\n${r.saida}\n${JSON.stringify(imp, null, 1)}`);
  console.log(r.saida); for (const [t, v] of Object.entries(imp)) console.log(`impressão ${t}: ${v.n} linhas`);
  console.log(`\nPROD_IDENTIDADE=${ident}\nevidência: ${f}`);
  console.log("Arquivos conferidos: sha256 das 3 migrations + catálogo (iguais aos do PR #49).");
  process.exit(0);
}

const ident = lerIdent();
if (E.PROD_IDENTIDADE !== ident) sair(2, "RECUSADO: PROD_IDENTIDADE ausente ou diferente da identidade lida agora — rode o preflight e confira o alvo");

if (passo === "verificar") {
  const c = catalogo(); const imp = lerImpressao();
  const f = evid("verificar", `${c.saida}\n${c.erro}\n${JSON.stringify(imp, null, 1)}`);
  console.log(`catálogo: ${c.t} t / ${c.f.length} f${c.f.length ? "\n" + c.f.join("\n") : ""}`);
  for (const [t, v] of Object.entries(imp)) console.log(`impressão ${t}: ${v.n} linhas`);
  console.log(`evidência: ${f}`); process.exit(c.t === 23 && c.f.length === 0 ? 0 : 1);
}

// ---------- aplicar ----------
if (E.PROD_AUTORIZO !== "SIM") sair(2, "RECUSADO: falta PROD_AUTORIZO=SIM");
if (E.PROD_BACKUP_CONFIRMADO !== "SIM") sair(2, "RECUSADO: falta PROD_BACKUP_CONFIRMADO=SIM (confirme o backup/PITR no painel do Supabase antes)");
arquivosConferidos();
const antes = lerImpressao(); let log = `identidade ${ident}\nantes ${JSON.stringify(antes)}\n`;
for (const [rel] of ARQ) {
  const t0 = Date.now(); const r = psql(["-q", "-f", path.join(RAIZ, rel)]);
  log += `\n== ${rel} (exit ${r.status}, ${Date.now() - t0} ms)\n${r.saida}\n${r.erro}\n`;
  if (r.status !== 0) { const f = evid("aplicar-FALHA", log); sair(1, `FALHA em ${rel} — a transação dele foi desfeita; as anteriores ficaram aplicadas. PARADO.\n${r.erro.split("\n").slice(0, 4).join("\n")}\nevidência: ${f}`); }
  console.log(`OK    ${rel} (${Date.now() - t0} ms)`);
}
const c = catalogo(); const depois = lerImpressao();
const dif = COMPARTILHADAS.filter((t) => JSON.stringify(antes[t]) !== JSON.stringify(depois[t]));
log += `\n== catálogo\n${c.saida}\n${c.erro}\ndepois ${JSON.stringify(depois)}\n`;
const f = evid("aplicar", log);
console.log(`catálogo: ${c.t} t / ${c.f.length} f${c.f.length ? "\n" + c.f.join("\n") : ""}`);
for (const t of COMPARTILHADAS) console.log(`${dif.includes(t) ? "MUDOU " : "igual "} ${t}: ${antes[t].n} -> ${depois[t].n}`);
const ok = c.t === 23 && !c.f.length && dif.length === 1 && dif[0] === "modulos" && depois.modulos.n === antes.modulos.n + 1;
console.log(ok ? "RESULTADO: OK — 120/121/122 aplicadas; catálogo 23/23; só 'modulos' ganhou 1 linha." : "RESULTADO: DIVERGÊNCIA — não faça o merge; analise a evidência.");
console.log(`evidência: ${f}`); process.exit(ok ? 0 : 1);
