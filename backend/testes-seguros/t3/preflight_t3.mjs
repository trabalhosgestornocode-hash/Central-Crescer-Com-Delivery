// PRÉ-VOO DO T3 — confirma que o alvo é um projeto Supabase DESCARTÁVEL antes de qualquer alteração.
//   Fase A (padrão, SEM rede):  node backend/testes-seguros/t3/preflight_t3.mjs
//   Fase B (SOMENTE LEITURA, exige autorização): node backend/testes-seguros/t3/preflight_t3.mjs --conectar
// Nunca lê backend/.env. Só usa as variáveis T3_* do terminal. Recusa o projeto de PRODUÇÃO e o projeto de teste COMPARTILHADO
// ("teste-multiempresarial", usado por outras frentes — o T3 cria dados permanentes e termina destruindo o projeto).
// Fase B: conexão com default_transaction_read_only=on; só SELECTs de identidade e contagens; grava um resumo JSON para as evidências.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(aqui, "..", "..");
const { PROJETO_PRODUCAO_REF, PROJETO_TESTE_REF } = await import(pathToFileURL(path.join(backend, "src", "modules", "ifood", "ifood.ambienteTeste.js")).href);
const E = process.env;
const conectar = process.argv.includes("--conectar");
const ensaioLocal = E.T3_ENSAIO_LOCAL === "1";        // só para validar este script contra o PostgreSQL local (127.0.0.1)
const erros = [], avisos = [], ok = [];
const exigir = (cond, msgOk, msgErro) => (cond ? ok.push(msgOk) : erros.push(msgErro));

// ---------------- Fase A: identidade declarada (sem rede) ----------------
const ref = E.T3_PROJECT_REF ?? "";
const necessarias = ["T3_PROJECT_REF", "T3_SUPABASE_URL", "T3_PSQL_CONN", "T3_SERVICE_ROLE_KEY", "T3_ANON_KEY", "T3_CONFIRMO"];
const faltam = necessarias.filter((k) => !E[k]);
exigir(!faltam.length, "todas as variáveis T3_* definidas", `faltam variáveis: ${faltam.join(", ")}`);
exigir(E.T3_CONFIRMO === "ESTE_PROJETO_E_DESCARTAVEL", "T3_CONFIRMO correto", "T3_CONFIRMO precisa ser exatamente ESTE_PROJETO_E_DESCARTAVEL");
if (!ensaioLocal) {
  exigir(/^[a-z]{20}$/.test(ref), "T3_PROJECT_REF com formato de ref do Supabase", "T3_PROJECT_REF inválido (esperado 20 letras minúsculas)");
  exigir(ref !== PROJETO_PRODUCAO_REF, "não é o projeto de PRODUÇÃO", `RECUSADO: ${ref} é o projeto de PRODUÇÃO`);
  exigir(ref !== PROJETO_TESTE_REF, "não é o projeto de teste compartilhado", `RECUSADO: ${ref} é o projeto de teste COMPARTILHADO (teste-multiempresarial); use um projeto novo e exclusivo`);
  let host = ""; try { host = new URL(E.T3_SUPABASE_URL ?? "").host; } catch { /* inválida */ }
  exigir(host === `${ref}.supabase.co`, "T3_SUPABASE_URL corresponde ao ref", `T3_SUPABASE_URL não é https://${ref}.supabase.co`);
  const conn = E.T3_PSQL_CONN ?? "";
  exigir(conn.startsWith("postgresql://") && (conn.includes(`db.${ref}.supabase.co`) || conn.includes(`postgres.${ref}@`)), "T3_PSQL_CONN aponta para o mesmo ref (conexão direta ou pooler)", "T3_PSQL_CONN não contém o ref do projeto (db.<ref>.supabase.co ou usuário postgres.<ref>)");
  exigir(!conn.includes(PROJETO_PRODUCAO_REF) && !(E.T3_SUPABASE_URL ?? "").includes(PROJETO_PRODUCAO_REF), "nenhuma variável T3 contém o ref de produção", "RECUSADO: alguma variável T3 contém o ref de PRODUÇÃO");
  // chaves legadas (JWT) carregam ref e role; as novas (sb_secret_/sb_publishable_) não: nesse caso só avisa
  const claims = (k) => { try { const p = String(k).split("."); return p.length === 3 ? JSON.parse(Buffer.from(p[1], "base64url").toString("utf8")) : null; } catch { return null; } };
  for (const [nome, esperado] of [["T3_SERVICE_ROLE_KEY", "service_role"], ["T3_ANON_KEY", "anon"]]) {
    const c = claims(E[nome]);
    if (c) { exigir(c.ref === ref, `${nome} pertence ao ref`, `${nome} é de outro projeto (ref ${c.ref})`); exigir(c.role === esperado, `${nome} tem role ${esperado}`, `${nome} tem role ${c.role}, esperado ${esperado}`); }
    else avisos.push(`${nome} não é JWT legado (chave nova sb_*): não dá para conferir o ref pela chave — confira no painel do projeto`);
  }
}
// variáveis da Central no MESMO terminal podem confundir quem roda o T3: não podem apontar para produção
for (const k of ["SUPABASE_URL", "DATABASE_URL", "SUPABASE_DB_URL"]) if ((E[k] ?? "").includes(PROJETO_PRODUCAO_REF)) erros.push(`RECUSADO: ${k} deste terminal aponta para PRODUÇÃO; abra um terminal limpo para o T3`);

const relatorio = { fase: conectar ? "B" : "A", ref: ref || null, ok, avisos, erros };
if (erros.length || !conectar) {
  console.log(JSON.stringify(relatorio, null, 2));
  if (!conectar && !erros.length) console.log("\nFase A OK. A fase B (--conectar, somente leitura) só com a sua autorização.");
  process.exit(erros.length ? 2 : 0);
}

// ---------------- Fase B: leitura do banco (somente leitura, autorizada) ----------------
const PSQL = E.PSQL || "psql";
const q = (sql) => {
  const r = spawnSync(PSQL, [E.T3_PSQL_CONN, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8", env: { ...E, PGOPTIONS: "-c default_transaction_read_only=on", PGCLIENTENCODING: "UTF8", PGCONNECT_TIMEOUT: "10" } });
  if (r.status !== 0) throw new Error((r.stderr || "").trim().split("\n")[0]);
  return (r.stdout || "").trim();
};
try {
  const contar = (t) => q(`select case when to_regclass('${t}') is null then -1 else (select count(*) from ${t}) end`);
  const b = {
    identidade: q("select current_database() || ' | ' || current_user || ' | ' || split_part(version(), ' ', 2)"),
    somenteLeitura: q("show default_transaction_read_only"),
    organizacoes: Number(contar("public.organizacoes")),
    organizacoesNaoTeste: Number(q("select case when to_regclass('public.organizacoes') is null then 0 else (select count(*) from public.organizacoes where id::text not like '00000000-0000-0000-0000-0000000000__') end")),
    unidades: Number(contar("public.unidades")),
    usuariosAuth: Number(contar("auth.users")),
    tabelasPublic: Number(q("select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'")),
    objetosFinanceiros: Number(q("select count(*) from pg_class where relnamespace = 'public'::regnamespace and (relname like 'fin\\_%' or relname like 'gestao\\_financeira\\_%')")),
    tamanhoBanco: q("select pg_size_pretty(pg_database_size(current_database()))"),
    schemasSupabase: q("select string_agg(nspname, ',' order by nspname) from pg_namespace where nspname in ('auth','storage','realtime','graphql_public','extensions')"),
  };
  relatorio.banco = b;
  if (b.somenteLeitura !== "on") erros.push("a sessão não ficou somente leitura");
  if (b.organizacoesNaoTeste > 0) erros.push(`RECUSADO: ${b.organizacoesNaoTeste} organização(ões) com id que não é de teste — banco com dados reais`);
  if (b.usuariosAuth > 5 && !ensaioLocal) erros.push(`RECUSADO: ${b.usuariosAuth} usuários em auth.users — não parece projeto novo`);
  if (!ensaioLocal && !/auth/.test(b.schemasSupabase ?? "")) avisos.push("schemas do Supabase ausentes: confirme que o alvo é um projeto Supabase");
  if (b.objetosFinanceiros > 0) avisos.push(`já existem ${b.objetosFinanceiros} objetos financeiros (migrations 120–122 aplicadas antes?)`);
} catch (e) { erros.push(`falha na leitura: ${e.message}`); }
relatorio.erros = erros;
console.log(JSON.stringify(relatorio, null, 2));
process.exit(erros.length ? 2 : 0);
