// Consulta mínima 6b8 (database/auditoria/6b8-consulta-minima-115.sql): um único SELECT de catálogo; mostra o que falta para fechar a 115.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { motivoPular, criarBancoDescartavel, sql, psqlSync, URL_ADMIN } from "./helpers/pg-descartavel.js";
import { construirSchemaReal } from "./helpers/schema-real-pg.js";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "database", "auditoria", "6b8-consulta-minima-115.sql");
const fonte = readFileSync(SCRIPT, "utf8");
const sc = fonte.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");
const sl = sc.replace(/'(?:[^']|'')*'/g, "''");

describe("consulta mínima 6b8 — estático", () => {
  test("UM único SELECT; sem escrita/DDL/DML/GRANT/SET/DO; só pg_*; nada de auth.users, storage, segredo", () => {
    assert.equal((sl.match(/;/g) ?? []).length, 1); assert.match(sl.trim(), /^select\b/i);
    assert.doesNotMatch(sl, /\b(begin|commit|rollback|set|reset|do|insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|vacuum|analyze|lock|execute|call|prepare)\b/i);
    assert.doesNotMatch(sl, /\b(set_config|pg_terminate_backend|pg_read_file|dblink|nextval|setval)\b/i);
    const alvos = [...sl.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/gi)].map((m) => m[1].toLowerCase());
    assert.deepEqual([...new Set(alvos.filter((a) => !/^(pg_[a-z_]+|unnest|aclexplode|t)$/.test(a)))], []);
    assert.doesNotMatch(sc, /auth\.users|storage\.objects|password|secret|jwt|pg_authid|pg_shadow|pg_settings|query_to_xml/i);
    assert.equal((sc.match(/rolconfig/g) ?? []).length, 1); assert.match(sc, /c ~ '\^pgrst\\.db_schemas='/);
  });
});

describe("consulta mínima 6b8 — dinâmico (schema que reproduz a produção)", { skip: motivoPular, timeout: 300_000 }, () => {
  let b; let linhas; const GRUPO = `grupo_extra_${Math.random().toString(36).slice(2, 8)}`;   // role é GLOBAL no cluster: nome único por execução
  const secao = (n) => linhas.filter((l) => l[0] === n);
  before(() => {
    b = criarBancoDescartavel("audit_min");
    assert.deepEqual(construirSchemaReal(b.url, { ate: 111 }), []);
    sql(b.url, `do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if; end $$;
      alter role authenticator set pgrst.db_schemas = 'public,graphql_public'; alter role authenticator set pgrst.jwt_secret = 'SEGREDO-NAO-PODE-APARECER';
      create role ${GRUPO} nologin; grant select on vw_estoque_critico to ${GRUPO}; grant ${GRUPO} to anon;`);
    const r = psqlSync(b.url, `begin transaction read only; ${fonte}\nrollback;`, { formato: "-t -A -F~~" });
    assert.equal(r.ok, true, r.err);
    linhas = r.out.split(/\r?\n/).filter((l) => /^\d\./.test(l)).map((l) => l.split("~~"));
  });
  after(() => { b?.derrubar(); try { sql(URL_ADMIN, `drop role if exists ${GRUPO}`); } catch { /* melhor esforço */ } });

  test("devolve as 6 seções com o necessário e NADA além (sem o segredo de configuração)", () => {
    assert.equal(secao("1.sessao")[0][1], "postgres"); assert.match(secao("1.sessao")[0][4], /membro_de_postgres=true/);
    assert.ok(!linhas.flat().join(" ").includes("SEGREDO-NAO-PODE-APARECER"));
    assert.equal(secao("6.pgrst_schemas")[0][2], "public,graphql_public");
    assert.equal(secao("3.assinaturas").length, 7, "uma assinatura por RPC (sem sobrecargas no schema de teste)");
  });
  test("ACL completo: mostra TODOS os grantees das views (PUBLIC/anon/authenticated/service_role + role extra) e o concedente; e as RPCs (inclui PUBLIC)", () => {
    const v = secao("2.acl_completo").filter((l) => l[2] === "view" && l[1] === "vw_estoque_critico");
    const grantees = v.map((l) => l[4].replace("grantee=", "")); for (const g of ["anon", "authenticated", "service_role", GRUPO, "postgres"]) assert.ok(grantees.includes(g), `grantee ${g}`);
    assert.ok(v.every((l) => l[5] === "concedido_por=postgres" || l[5].startsWith("concedido_por=")));
    const rpc = secao("2.acl_completo").filter((l) => l[2] === "rpc"); assert.ok(rpc.some((l) => l[4] === "grantee=-"), "PUBLIC aparece como '-'"); assert.equal(new Set(rpc.map((l) => l[1])).size, 7);
  });
  test("membros: mostra a herança (anon herda de uma role extra); dependências: lista quem cita os alvos (RPC→RPC no repositório)", () => {
    assert.ok(secao("5.membros").some((l) => l[1] === GRUPO && l[2] === "anon"));
    const dep = secao("4.dependencias").map((l) => `${l[2]}>${l[3]}`).join(" ");
    assert.match(dep, /bonificacao_congelar_competencia[^>]*>cita=bonificacao_reabrir_competencia/); assert.match(dep, /transferir_unidade_organizacao[^>]*>cita=remapear_organizacao_em_tabelas_de_unidade/);
  });
  test("não altera nada (transação READ ONLY sem erro) e a saída não tem dado de cliente nem segredo", () => {
    assert.doesNotMatch(linhas.map((l) => l.join(" ")).join("\n"), /@[a-z0-9-]+\.[a-z]{2,}|eyJ[A-Za-z0-9_-]{10,}|postgres(ql)?:\/\//i);
  });
});
