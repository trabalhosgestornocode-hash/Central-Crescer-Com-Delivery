// AUDITORIA das migrations 112/113 (Checkpoint 6B.1) — compatibilidade, ordem, lock_timeout e índice único,
// contra um Postgres LOCAL e DESCARTÁVEL (cada teste cria e derruba o próprio banco).
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55420/postgres node --test test/perfil-exibicao-migration-auditoria-pg.test.js
//
// Limite declarado: foi testado com o PostgreSQL local (17). A versão do Supabase de produção NÃO foi consultada.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { motivoPular, criarBancoDescartavel, sql, psqlSync, psqlAsync } from "./helpers/pg-descartavel.js";
import { SCHEMA_BASE } from "./helpers/schema-perfil-exibicao.js";

const MIG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "database", "migrations");
const M112 = join(MIG, "112_papel_operador_exibicao.sql");
const M113 = join(MIG, "113_papel_exibicao_somente_unidade.sql"); const R113 = join(MIG, "113_rollback.sql");
const ORG = "a0000000-0000-4000-8000-00000000000a";
const UNI = "a1000000-0000-4000-8000-0000000000a1";
const UNI2 = "b1000000-0000-4000-8000-0000000000b1";
const U1 = "11111111-1111-4111-8111-111111111111"; const U2 = "22222222-2222-4222-8222-222222222222"; const U3 = "33333333-3333-4333-8333-333333333333";
const ROLES = ["organization_admin", "unit_manager", "finance", "operations", "viewer"];

const novo = (rotulo) => { const b = criarBancoDescartavel(rotulo); sql(b.url, SCHEMA_BASE); return b; };
const idDe = (i) => `0000000${i}-0000-4000-8000-00000000000${i}`;
const semear = (b) => sql(b.url, `
  insert into organizacoes (id, nome) values ('${ORG}', 'Empresa');
  insert into unidades (id, organizacao_id, nome) values ('${UNI}', '${ORG}', 'U1'), ('${UNI2}', '${ORG}', 'U2');
  ${ROLES.map((r, i) => `
  insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('${idDe(i)}', '${idDe(i)}', '${ORG}', '${r}');
  insert into usuarios_unidades (usuario_id, perfil_id, unidade_id, papel) values ('${idDe(i)}', '${idDe(i)}', '${UNI}', '${r}'), ('${idDe(i)}', '${idDe(i)}', '${UNI2}', null);`).join("\n")}`);
const foto = (b) => sql(b.url, "select md5(coalesce((select string_agg(t::text, '|' order by t::text) from usuarios_organizacoes t), '') || coalesce((select string_agg(t::text, '|' order by t::text) from usuarios_unidades t), ''))");
const insUnidade = (b, u, uni, papel) => psqlSync(b.url, `insert into usuarios_unidades (usuario_id, perfil_id, unidade_id, papel) values ('${u}', '${u}', '${uni}', ${papel ? `'${papel}'` : "null"})`);

describe("AUDITORIA das migrations 112/113 (banco descartável)", { skip: motivoPular, timeout: 300_000 }, () => {
  test("112 e 113 NA MESMA TRANSAÇÃO falham (valor novo de enum não é usável antes do commit) e nada fica aplicado — por isso são dois arquivos", () => {
    const b = novo("mig_mesma_tx");
    try {
      const sem = (s) => s.replace(/^begin;$/m, "").replace(/^commit;$/m, "");
      const juntas = `begin;\n${readFileSync(M112, "utf8")}\n${sem(readFileSync(M113, "utf8"))}\ncommit;`;
      const r = psqlSync(b.url, juntas);
      assert.equal(r.ok, false);
      assert.match(r.err, /unsafe use of new (enum )?value|55P04/i);
      assert.equal(sql(b.url, "select count(*) from pg_constraint where conname = 'uo_sem_papel_exibicao'"), "0");
      assert.doesNotMatch(sql(b.url, "select string_agg(e.enumlabel, ',') from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'papel_acesso'"), /display_operator/, "o ALTER TYPE foi desfeito junto");
    } finally { b.derrubar(); }
  });

  test("COMPATIBILIDADE: com todos os papéis antigos já cadastrados, 112 + 113 não alteram NENHUMA linha", () => {
    const b = novo("mig_compat");
    try {
      semear(b); const antes = foto(b);
      assert.equal(psqlSync(b.url, "", { arquivo: M112 }).ok, true);
      assert.equal(psqlSync(b.url, "", { arquivo: M113 }).ok, true);
      assert.equal(foto(b), antes, "nenhum dado existente mudou");
      assert.equal(sql(b.url, `select count(*) from usuarios_unidades where usuario_id = '${idDe(2)}'`), "2", "usuários antigos continuam podendo ter várias unidades");
    } finally { b.derrubar(); }
  });

  test("ÍNDICE ÚNICO: a mesma conta não tem 2 unidades de exibição; contas diferentes podem compartilhar a unidade; outros papéis seguem livres", () => {
    const b = novo("mig_indice");
    try {
      semear(b); psqlSync(b.url, "", { arquivo: M112 }); psqlSync(b.url, "", { arquivo: M113 });
      assert.equal(insUnidade(b, U1, UNI, "display_operator").ok, true);
      const dup = insUnidade(b, U1, UNI2, "display_operator");
      assert.equal(dup.ok, false); assert.match(dup.err, /uq_usuarios_unidades_exibicao_unica|duplicate key|duplicad/i);
      assert.equal(insUnidade(b, U2, UNI, "display_operator").ok, true, "outra conta, mesma unidade: ok");
      assert.equal(insUnidade(b, U1, UNI2, "viewer").ok, true, "mistura de papéis na mesma conta é recusada pelo BACKEND, não pelo índice");
      assert.equal(psqlSync(b.url, "", { arquivo: R113 }).ok, true);
      assert.equal(sql(b.url, "select count(*) from pg_indexes where indexname = 'uq_usuarios_unidades_exibicao_unica'"), "0", "o rollback remove o índice");
      assert.equal(insUnidade(b, U3, UNI, "display_operator").ok && insUnidade(b, U3, UNI2, "display_operator").ok, true, "sem o índice, volta a ser permitido (rollback fiel)");
    } finally { b.derrubar(); }
  });

  test("LOCK_TIMEOUT: com uma transação longa segurando a tabela, a 113 FALHA em ~5 s, não aplica nada, não prende quem vem depois — e basta repetir", async () => {
    const b = novo("mig_lock");
    try {
      semear(b); psqlSync(b.url, "", { arquivo: M112 });
      const segurando = psqlAsync(b.url, "begin; select count(*) from usuarios_organizacoes; select count(*) from usuarios_unidades; select pg_sleep(14); commit;");
      await new Promise((r) => setTimeout(r, 1500));
      const t0 = Date.now();
      const r = psqlSync(b.url, "", { arquivo: M113 });
      const gasto = Date.now() - t0;
      assert.equal(r.ok, false); assert.match(r.err, /lock timeout|lock_timeout/i);
      assert.ok(gasto >= 4000 && gasto < 11_000, `falhou em ~5 s: ${gasto} ms`);
      assert.equal(sql(b.url, "select count(*) from pg_constraint where conname = 'uo_sem_papel_exibicao'"), "0");
      assert.equal(sql(b.url, "select count(*) from pg_indexes where indexname = 'uq_usuarios_unidades_exibicao_unica'"), "0", "nada aplicado pela metade");
      assert.equal(psqlSync(b.url, "select count(*) from usuarios_organizacoes").ok, true, "leitura comum não ficou presa atrás da migration que falhou");
      await segurando;
      assert.equal(psqlSync(b.url, "", { arquivo: M113 }).ok, true, "repetida depois que a transação longa terminou");
    } finally { b.derrubar(); }
  });

  test("ORDEM de publicação: só com a 112 já se cria a conta de exibição (a 113 só endurece); sem a 112, os papéis antigos seguem funcionando", () => {
    const b = novo("mig_ordem");
    try {
      semear(b);
      assert.equal(sql(b.url, "select count(*) from usuarios_unidades where papel is not null"), String(ROLES.length));
      assert.equal(insUnidade(b, U1, UNI, "display_operator").ok, false, "sem a 112 o valor não existe: o app novo NÃO pode ir antes da 112");
      assert.equal(psqlSync(b.url, "", { arquivo: M112 }).ok, true);
      assert.equal(insUnidade(b, U1, UNI, "display_operator").ok, true);
    } finally { b.derrubar(); }
  });
});
