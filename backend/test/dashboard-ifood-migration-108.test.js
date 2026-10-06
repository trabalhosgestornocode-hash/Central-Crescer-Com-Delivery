// Migration 108 — Dashboard iFood multicanal: grants das tabelas novas.
// Validação ESTÁTICA do SQL (o Postgres real foi validado no projeto de teste).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIG = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../database/migrations");
const SQL = readFileSync(path.join(MIG, "108_dashboard_ifood_canais.sql"), "utf8").replace(/--.*$/gm, "");
const TABELAS = "dashboard_ifood_unidade_config, dashboard_ifood_canais, lancamentos_financeiros_canais";

test("anon sem acesso e authenticated só SELECT nas três tabelas (TRUNCATE não passa por RLS)", () => {
  assert.match(SQL, new RegExp(`revoke all on ${TABELAS}\\s+from anon, authenticated;`));
  assert.match(SQL, new RegExp(`grant select on ${TABELAS}\\s+to authenticated;`));
  assert.doesNotMatch(SQL, /grant\s+[^;]*\bto\s+anon\b/i);
  assert.doesNotMatch(SQL, /grant\s+(?!select\s+on\b)[^;]*\bto\s+authenticated\s*;/i, "authenticated nunca recebe escrita");
});

// ---------------------------------------------------------------------------
// safeupdate: no Supabase, toda RPC chamada pelo backend passa pelo PostgREST
// (papel `authenticator`), que carrega `safeupdate` — DELETE/UPDATE sem WHERE
// é recusado ("DELETE requires a WHERE clause"), até em tabela temporária.
// O PGlite não tem safeupdate, então só esta checagem estática pega o caso.
// ---------------------------------------------------------------------------
const corposDeFuncao = (sql) => [...sql.matchAll(/\$\$([\s\S]*?)\$\$/g)].map((m) => m[1]);
const semStrings = (sql) => sql.replace(/'(?:[^']|'')*'/g, "''");

/** DELETE/UPDATE de nível de comando sem WHERE (ignora `for update`, `on conflict do update set`). */
function comandosSemWhere(corpo) {
  const limpo = semStrings(corpo.replace(/--.*$/gm, ""));
  const achados = [];
  for (const m of limpo.matchAll(/\b(delete\s+from\s+[\w.]+|update\s+(?!set\b)[\w.]+(?:\s+(?!set\b)\w+)?\s+set\b)[^;]*;/gi)) {
    if (!/\bwhere\b/i.test(m[0])) achados.push(m[0].replace(/\s+/g, " ").slice(0, 80));
  }
  return achados;
}

test("safeupdate: nenhuma função da 108 tem DELETE ou UPDATE sem WHERE", () => {
  const corpos = corposDeFuncao(readFileSync(path.join(MIG, "108_dashboard_ifood_canais.sql"), "utf8"));
  assert.ok(corpos.length >= 6, "esperava as funções/RPCs da 108");
  assert.deepEqual(corpos.flatMap(comandosSemWhere), []);
});

test("safeupdate: o detector pega o padrão proibido e ignora os permitidos", () => {
  assert.equal(comandosSemWhere("begin delete from pg_temp.x; end").length, 1);
  assert.equal(comandosSemWhere("update dashboard_ifood_canais k set nome = 'a';").length, 1);
  assert.deepEqual(comandosSemWhere("delete from pg_temp.x where true;"), []);
  assert.deepEqual(comandosSemWhere("select * into v from t where id = 1 for update;"), []);
  assert.deepEqual(comandosSemWhere("insert into t values (1) on conflict (id) do update set a = excluded.a;"), []);
  assert.deepEqual(comandosSemWhere("update t k set a = d.a from d where d.id = k.id;"), []);
  assert.deepEqual(comandosSemWhere("-- delete from x;\nraise exception 'update x set y;';"), []);
});

test("o REVOKE vem depois das policies de leitura e o service_role mantém a escrita", () => {
  assert.ok(SQL.indexOf("revoke all on dashboard_ifood_unidade_config") > SQL.lastIndexOf("create policy"));
  assert.match(SQL, new RegExp(`grant select, insert, update, delete on ${TABELAS}\\s+to service_role;`));
});
