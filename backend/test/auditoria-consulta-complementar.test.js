// Consulta complementar (database/auditoria/6b7-consulta-complementar.sql): um único SELECT de catálogo, sem escrita nem dado de cliente.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { motivoPular, criarBancoDescartavel, sql, psqlSync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal } from "./helpers/schema-real-pg.js";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "database", "auditoria", "6b7-consulta-complementar.sql");
const fonte = readFileSync(SCRIPT, "utf8");
const sc = fonte.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");
const sl = sc.replace(/'(?:[^']|'')*'/g, "''");

describe("consulta complementar — estático", () => {
  test("UM único SELECT; sem escrita/DDL/DML/GRANT/SET; só tabelas pg_*", () => {
    assert.equal((sl.match(/;/g) ?? []).length, 1); assert.match(sl.trim(), /^select\b/i);
    assert.doesNotMatch(sl, /\b(begin|commit|rollback|set|reset|do|insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|vacuum|analyze|lock|execute|call|prepare)\b/i);
    const alvos = [...sl.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/gi)].map((m) => m[1].toLowerCase());
    assert.deepEqual([...new Set(alvos.filter((a) => !/^(pg_[a-z_]+|t)$/.test(a)))], []);
    assert.doesNotMatch(sc, /auth\.users|storage\.objects|password|secret|jwt|pg_authid|pg_settings/i);
  });
});

describe("consulta complementar — dinâmico", { skip: motivoPular, timeout: 300_000 }, () => {
  let b;
  before(() => { b = criarBancoDescartavel("audit_compl"); assert.deepEqual(construirSchemaReal(b.url, { ate: 111 }), []); });
  after(() => b?.derrubar());
  test("roda sem erro; lista gatilho de evento, tabelas com RLS sem policy e os dados de unidade_config; não altera nada", () => {
    sql(b.url, "alter table unidade_config enable row level security; create function zz_ev() returns event_trigger language plpgsql as $f$ begin null; end $f$; create event trigger zz_rls_auto on ddl_command_end execute function zz_ev();");
    const r = psqlSync(b.url, `begin transaction read only; ${fonte}\nrollback;`, { formato: "-t -A -F~~" });
    assert.equal(r.ok, true, r.err);
    const linhas = r.out.split(/\r?\n/).filter((l) => /^\d\./.test(l)).map((l) => l.split("~~"));
    assert.ok(linhas.some((l) => l[0] === "1.gatilhos_de_evento" && l[1] === "zz_rls_auto" && l[2] === "ddl_command_end"));
    assert.ok(linhas.some((l) => l[0] === "2.rls_sem_policy" && l[1] === "unidade_config"));
    const cfg = linhas.find((l) => l[0] === "3.unidade_config"); assert.match(cfg[3], /rls_ligado=true/); assert.equal(cfg[4], "policies=0");
    assert.doesNotMatch(r.out, /@|eyJ|postgres(ql)?:\/\//);
  });
});
