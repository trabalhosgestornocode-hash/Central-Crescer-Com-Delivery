// Aplicação da migration 126 (autoconcessão só do SuperAdmin ativo) em PRODUÇÃO (uqybgauuxcrqzquultfu), com travas.
// Mesmo modelo do prod-migrar.mjs (120–122): só um OPERADOR AUTORIZADO roda, no PRÓPRIO terminal; a conexão vem SÓ de
// PROD_CONN, nunca é lida de arquivo, impressa nem gravada. Procedimento: docs/gestao-financeira/26-acesso-financeiro-simples.md
//   node backend/testes-seguros/producao/prod-migrar-126.mjs preflight   -> somente leitura; imprime PROD_IDENTIDADE
//   PROD_IDENTIDADE=<…> PROD_AUTORIZO=SIM PROD_BACKUP_CONFIRMADO=SIM node …/prod-migrar-126.mjs aplicar
//   PROD_IDENTIDADE=<…> node …/prod-migrar-126.mjs verificar             -> somente leitura
// Ensaio: PROD_ENSAIO_LOCAL=1 aceita só 127.0.0.1:<PROD_ENSAIO_PORTA, padrão 54321> com MARCADOR_DESCARTAVEL (PG_CLUSTER_DIR).
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const REF_PROD = "uqybgauuxcrqzquultfu", REF_TESTE = "wiqqsxnysbzhcrzrrean";
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const M126 = ["database/migrations/126_financeiro_autoconcessao_superadmin.sql", "2a14073fb4fc573f1fc756116bd0269801ed453e9481d9f39bc680b3a02a3b8e"];
const E = process.env, ENSAIO = E.PROD_ENSAIO_LOCAL === "1", PORTA_ENSAIO = E.PROD_ENSAIO_PORTA || "54321";
const EVID = E.PROD_EVIDENCIAS || path.join(os.tmpdir(), "evidencias-prod");   // fora do Git; sem a conexão
const PSQL = E.PSQL || (existsSync("C:/Program Files/PostgreSQL/17/bin/psql.exe") ? "C:/Program Files/PostgreSQL/17/bin/psql.exe" : "psql");
const sair = (c, m) => { (c ? console.error : console.log)(m); process.exit(c); };
const CONN = E.PROD_CONN ?? "";
const ocultar = (s) => String(s ?? "").split(CONN || "\u0000").join("<conexão>");

function travas() {
  const e = [];
  if (!CONN) e.push("defina PROD_CONN no seu terminal (não cole a conexão no chat)");
  if (CONN.includes(REF_TESTE)) e.push("PROD_CONN aponta para o projeto de TESTES");
  if (ENSAIO) {
    if (!new RegExp(`@127\\.0\\.0\\.1:${PORTA_ENSAIO}/`).test(CONN)) e.push(`ensaio: só 127.0.0.1:${PORTA_ENSAIO}`);
    if (!E.PG_CLUSTER_DIR || !existsSync(path.join(E.PG_CLUSTER_DIR, "MARCADOR_DESCARTAVEL"))) e.push("ensaio: PG_CLUSTER_DIR sem MARCADOR_DESCARTAVEL");
  } else {
    let u; try { u = new URL(CONN); } catch { e.push("PROD_CONN não é uma URL postgres"); }
    if (u) {
      const host = u.hostname, user = decodeURIComponent(u.username);
      const direto = host === `db.${REF_PROD}.supabase.co`, pooler = /\.pooler\.supabase\.com$/.test(host) && user === `postgres.${REF_PROD}`;
      if (!direto && !pooler) e.push(`host/usuário não são do projeto de produção ${REF_PROD}`);
      if ((u.port || "5432") === "6543") e.push("porta 6543 (pooler em modo transação): use a conexão direta ou o pooler de sessão (5432)");
      if (direto && user !== "postgres") e.push("na conexão direta o usuário deve ser postgres");
    }
  }
  return e;
}
function psql(args, { input, leitura = false } = {}) {
  const env = {}; for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) if (E[k]) env[k] = E[k];
  if (!env.SystemRoot && !env.SYSTEMROOT) env.SystemRoot = "C:\\WINDOWS";
  Object.assign(env, { PGCLIENTENCODING: "UTF8", PGAPPNAME: "financeiro-migracao-126", PGCONNECT_TIMEOUT: "15",
    PGOPTIONS: leitura ? "-c default_transaction_read_only=on -c statement_timeout=60000" : "-c statement_timeout=120000" });
  const r = spawnSync(PSQL, ["-X", "-v", "ON_ERROR_STOP=1", ...args, CONN], { input, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, saida: ocultar(r.stdout), erro: ocultar(r.stderr) };
}
function evid(nome, txt) { mkdirSync(EVID, { recursive: true }); const f = path.join(EVID, `126-${nome}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`); writeFileSync(f, txt); return f; }

const SQL_IDENT = `select md5((select oid::text from pg_database where datname = current_database()) || '|' || 'public'::regnamespace::oid::text || '|' || current_database())`;
// Estado lido antes e depois (só contagens, nenhum dado pessoal): a 126 só troca o corpo de gfc_validar.
const SQL_ESTADO = `
select coalesce((select position('plataforma_admins' in prosrc) > 0 from pg_proc where oid = 'public.gfc_validar()'::regprocedure), false) as regra_126,
       (select count(*) from pg_trigger where tgrelid = 'public.gestao_financeira_concessoes'::regclass and not tgisinternal) as gatilhos_concessoes,
       (select count(*) from public.plataforma_admins where ativo) as superadmins_ativos,
       (select count(*) from public.gestao_financeira_concessoes) as concessoes,
       (select count(*) from public.gestao_financeira_concessoes where revogada_em is null) as concessoes_ativas;`;
function lerIdent() { const r = psql(["-tA", "-c", SQL_IDENT], { leitura: true }); if (r.status !== 0) sair(2, `RECUSADO: ${r.erro.split("\n")[0]}`); return r.saida.trim(); }
function lerEstado() {
  const r = psql(["-tA", "-F", "|", "-c", SQL_ESTADO], { leitura: true }); if (r.status !== 0) sair(2, `leitura falhou: ${r.erro.split("\n")[0]}`);
  const [regra, gatilhos, sa, conc, ativas] = r.saida.trim().split("|");
  return { regra126: regra === "t", gatilhos: Number(gatilhos), superadminsAtivos: Number(sa), concessoes: Number(conc), concessoesAtivas: Number(ativas) };
}
function arquivoConferido() {
  const head = execFileSync("git", ["-C", RAIZ, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  console.log(`repositório em ${head}; conferindo sha256 da 126`);
  if (execFileSync("git", ["-C", RAIZ, "status", "--porcelain", "--", M126[0]], { encoding: "utf8" }).trim()) sair(2, `RECUSADO: ${M126[0]} alterado localmente`);
  const s = createHash("sha256").update(readFileSync(path.join(RAIZ, M126[0]))).digest("hex");
  if (s !== M126[1]) sair(2, `RECUSADO: sha256 de ${M126[0]} = ${s.slice(0, 16)}…, esperado ${M126[1].slice(0, 16)}…`);
}
// Somente leitura: onde o SuperAdmin ativo tem vínculo ativo (pré-requisito para receber acesso) e se o Financeiro já
// está ligado ali. Só nomes de empresa/unidade e booleanos; nenhum identificador de pessoa.
const SQL_VINCULOS = `
with sa as (select usuario_id from public.plataforma_admins where ativo),
v as (
  select 'empresa' as tipo, o.nome, uo.organizacao_id as org, null::uuid as uni
    from public.usuarios_organizacoes uo join sa on sa.usuario_id = uo.usuario_id join public.organizacoes o on o.id = uo.organizacao_id where uo.ativo
  union all
  select 'unidade', u.nome, u.organizacao_id, u.id
    from public.usuarios_unidades uu join sa on sa.usuario_id = uu.usuario_id join public.unidades u on u.id = uu.unidade_id where uu.ativo)
select v.tipo, v.nome,
       exists (select 1 from public.perfis_operacionais po join sa on sa.usuario_id = po.conta_id where po.ativo) as perfil_ativo,
       exists (select 1 from public.organizacao_modulos om where om.organizacao_id = v.org and om.modulo_id = 'gestao_financeira') as fin_empresa,
       case when v.uni is null then null else exists (select 1 from public.unidade_modulos um where um.unidade_id = v.uni and um.modulo_id = 'gestao_financeira') end as fin_unidade
  from v order by v.tipo, v.nome;`;
function mostrarVinculos() {
  const r = psql(["-tA", "-F", "|", "-c", SQL_VINCULOS], { leitura: true });
  if (r.status !== 0) { console.log(`vínculos do SuperAdmin: leitura falhou (${r.erro.split("\n")[0]})`); return; }
  const linhas = r.saida.trim() ? r.saida.trim().split(/\r?\n/) : [];
  if (!linhas.length) { console.log("vínculos do SuperAdmin: NENHUM vínculo ativo — crie um no Painel → Usuários antes de se dar acesso."); return; }
  console.log("vínculos ativos do SuperAdmin (tipo | nome | perfil ativo | Financeiro na empresa | Financeiro na unidade):");
  for (const l of linhas) console.log(`  ${l.split("|").map((x) => (x === "t" ? "sim" : x === "f" ? "não" : x || "—")).join(" | ")}`);
}
const mostrar = (x) => console.log(`regra da 126 ativa: ${x.regra126 ? "sim" : "não"} | gatilhos em concessões: ${x.gatilhos} | SuperAdmins ativos: ${x.superadminsAtivos} | concessões: ${x.concessoes} (${x.concessoesAtivas} ativas)`);

const passo = process.argv[2];
if (!["preflight", "aplicar", "verificar"].includes(passo)) sair(2, "uso: node prod-migrar-126.mjs preflight | aplicar | verificar");
const erros = travas(); if (erros.length) sair(2, erros.map((x) => `RECUSADO: ${x}`).join("\n"));
console.log(`${ENSAIO ? "ENSAIO LOCAL — " : ""}alvo: ${ENSAIO ? `127.0.0.1:${PORTA_ENSAIO} (descartável)` : `produção ${REF_PROD}`} | passo: ${passo}`);

if (passo === "preflight") {
  arquivoConferido();
  const ident = lerIdent(); const est = lerEstado(); mostrar(est); mostrarVinculos();
  if (est.superadminsAtivos !== 1) console.log(`ATENÇÃO: ${est.superadminsAtivos} SuperAdmin(s) ativo(s) — esperado 1; confira antes de aplicar.`);
  const f = evid("preflight", `identidade ${ident}\n${JSON.stringify(est)}`);
  console.log(`\nPROD_IDENTIDADE=${ident}\nevidência: ${f}`); process.exit(0);
}

const ident = lerIdent();
if (E.PROD_IDENTIDADE !== ident) sair(2, "RECUSADO: PROD_IDENTIDADE ausente ou diferente da identidade lida agora — rode o preflight e confira o alvo");

if (passo === "verificar") {
  const est = lerEstado(); mostrar(est); mostrarVinculos(); const f = evid("verificar", JSON.stringify(est));
  console.log(`evidência: ${f}`); process.exit(est.regra126 ? 0 : 1);
}

if (E.PROD_AUTORIZO !== "SIM") sair(2, "RECUSADO: falta PROD_AUTORIZO=SIM");
if (E.PROD_BACKUP_CONFIRMADO !== "SIM") sair(2, "RECUSADO: falta PROD_BACKUP_CONFIRMADO=SIM (confirme o backup/PITR no painel do Supabase antes)");
arquivoConferido();
const antes = lerEstado();
const t0 = Date.now(); const r = psql(["-q", "-f", path.join(RAIZ, M126[0])]);
const depois = r.status === 0 ? lerEstado() : antes;
const f = evid(r.status === 0 ? "aplicar" : "aplicar-FALHA", `identidade ${ident}\nantes ${JSON.stringify(antes)}\nexit ${r.status} (${Date.now() - t0} ms)\n${r.saida}\n${r.erro}\ndepois ${JSON.stringify(depois)}\n`);
if (r.status !== 0) sair(1, `FALHA — a transação da 126 foi desfeita; nada mudou.\n${r.erro.split("\n").slice(0, 4).join("\n")}\nevidência: ${f}`);
mostrar(depois);
const ok = depois.regra126 && depois.gatilhos === antes.gatilhos && depois.concessoes === antes.concessoes && depois.superadminsAtivos === antes.superadminsAtivos;
console.log(ok ? "RESULTADO: OK — 126 aplicada; só a função gfc_validar mudou." : "RESULTADO: DIVERGÊNCIA — analise a evidência (rollback: database/migrations/126_rollback.sql).");
console.log(`evidência: ${f}`); process.exit(ok ? 0 : 1);
