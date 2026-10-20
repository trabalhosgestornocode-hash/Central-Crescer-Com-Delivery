// Diagnóstico SOMENTE LEITURA do Supabase de testes COMPARTILHADO (doc 19 §6 Grupo A; doc 21).
// Uso: DIAG_CONN=<conexão postgres do projeto de TESTES> node backend/testes-seguros/t3/diagnostico_leitura.mjs [diagnostico_xxx.sql] > saida.txt
// Travas: a conexão vem SÓ da variável (nunca de arquivo .env); recusa o ref de produção e qualquer ref que não seja o de testes;
// abre a sessão com default_transaction_read_only=on e o SQL ainda faz BEGIN READ ONLY + conferência; nada é impresso da conexão.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PRODUCAO = "uqybgauuxcrqzquultfu";
const TESTE = "wiqqsxnysbzhcrzrrean"; // mesmo ref de PROJETO_TESTE_REF (backend/src/modules/ifood/ifood.ambienteTeste.js)
const conn = process.env.DIAG_CONN ?? "";
const sair = (m) => { console.error(`RECUSADO: ${m}`); process.exit(2); };
if (!conn) sair("defina DIAG_CONN (conexão do projeto de TESTES).");
if (conn.includes(PRODUCAO)) sair("a conexão aponta para PRODUÇÃO.");
let host = "";
try { host = new URL(conn).hostname; } catch { sair("DIAG_CONN não é uma URL postgresql:// válida."); }
const usuario = decodeURIComponent(new URL(conn).username);
if (!host.includes(TESTE) && !usuario.endsWith(`.${TESTE}`)) sair("a conexão não é do projeto de testes conhecido.");
for (const k of ["SUPABASE_URL", "DATABASE_URL"]) if ((process.env[k] ?? "").includes(PRODUCAO)) sair(`${k} de produção neste terminal.`);

// Só arquivos diagnostico_*.sql DESTA pasta (todos abrem BEGIN READ ONLY e terminam em ROLLBACK).
const nomeSql = process.argv[2] ?? "diagnostico_leitura.sql";
if (!/^diagnostico_[a-z0-9_]+\.sql$/.test(nomeSql)) sair("só diagnostico_*.sql desta pasta.");
const sql = path.join(path.dirname(fileURLToPath(import.meta.url)), nomeSql);
const psql = process.env.PSQL || "C:/Program Files/PostgreSQL/17/bin/psql.exe";
const r = spawnSync(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", sql, conn], {
  env: { ...process.env, PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=20000", PGCONNECT_TIMEOUT: "15", PGAPPNAME: "diag-financeiro-leitura", PGCLIENTENCODING: "UTF8" },
  encoding: "utf8",
});
const limpar = (s) => String(s ?? "").split(conn).join("<conexão>");
process.stdout.write(limpar(r.stdout));
if (r.stderr) process.stderr.write(limpar(r.stderr));
process.exit(r.status ?? 1);
