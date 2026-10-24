// Metas do Checklist (migration 127) + índice por período (128) em Postgres LOCAL e DESCARTÁVEL, sobre o schema REAL.
// Prova no banco o que o service assume: versão esperada, conflito, histórico append-only, isolamento por organização,
// backend-only (RLS sem policy, anon/authenticated sem privilégio) e o rollback.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55420/postgres node --experimental-vm-modules --test test/checklist-metas-migration-pg.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { motivoPular, criarBancoDescartavel, sql, psqlSync, psqlAsync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal, MIGRATIONS_DIR } from "./helpers/schema-real-pg.js";

const ORG = "00000000-0000-0000-0000-0000000000a0"; const ORG2 = "00000000-0000-0000-0000-0000000000b0";
const UN_A = "00000000-0000-0000-0000-0000000000a1"; const UN_B = "00000000-0000-0000-0000-0000000000b1";

const salvar = (versao, preparo = 12, { org = ORG, un = UN_A, origem = "interface" } = {}) =>
  `select resultado || '|' || coalesce(versao_atual::text, '-') from checklist_metas_salvar('${org}', '${un}', ${versao}, ${preparo}, 80, 35, 80, 45, 80, '${origem}', null, null, 'Gestora', null)`;

describe("metas do Checklist (127/128) — Postgres descartável, schema real", { skip: motivoPular, timeout: 900_000 }, () => {
  let b; let falhas;
  const q = (t) => sql(b.url, t);
  const tenta = (t) => psqlSync(b.url, t);

  before(() => {
    b = criarBancoDescartavel("checklist_metas");
    falhas = construirSchemaReal(b.url);
    q(`insert into organizacoes (id, nome) values ('${ORG}', 'Org A'), ('${ORG2}', 'Org B');
       insert into unidades (id, nome, organizacao_id) values ('${UN_A}', 'Matriz', '${ORG}'), ('${UN_B}', 'Outra', '${ORG2}');`);
  });
  after(() => b?.derrubar());

  test("schema real aplica sem falhas; reaplicar a 127 é idempotente; índice 128 existe e é válido", () => {
    assert.deepEqual(falhas, [], JSON.stringify(falhas));
    assert.equal(psqlSync(b.url, "", { arquivo: join(MIGRATIONS_DIR, "127_checklist_metas.sql") }).ok, true);
    assert.equal(q("select indisvalid::text from pg_index where indexrelid = 'public.idx_ifood_pedidos_tenant_criado'::regclass"), "true");
  });

  test("backend-only: RLS ligada sem policy; anon/authenticated sem privilégio; service_role só lê e executa a função", () => {
    for (const t of ["checklist_metas", "checklist_metas_historico"]) {
      assert.equal(q(`select relrowsecurity::text from pg_class where oid = 'public.${t}'::regclass`), "true");
      assert.equal(q(`select count(*) from pg_policy where polrelid = 'public.${t}'::regclass`), "0");
      for (const papel of ["anon", "authenticated"]) assert.equal(q(`select has_table_privilege('${papel}', 'public.${t}', 'select,insert,update,delete')::text`), "false");
      assert.equal(q(`select has_table_privilege('service_role', 'public.${t}', 'insert,update,delete')::text`), "false");
      assert.equal(q(`select has_table_privilege('service_role', 'public.${t}', 'select')::text`), "true");
    }
    const fn = "public.checklist_metas_salvar(uuid, uuid, bigint, numeric, numeric, numeric, numeric, numeric, numeric, text, uuid, uuid, text, uuid)";
    assert.equal(q(`select has_function_privilege('authenticated', '${fn}', 'execute')::text`), "false");
    assert.equal(q(`select has_function_privilege('service_role', '${fn}', 'execute')::text`), "true");
  });

  test("versão: 0→1, conflito com versão velha, sem_alteracao com valores iguais; histórico com antes/depois", () => {
    assert.equal(q(salvar(0, 12)), "salvo|1");
    assert.equal(q(salvar(0, 10)), "conflito|1", "migração local nunca sobrescreve o que já existe");
    assert.equal(q(salvar(1, 12)), "sem_alteracao|1");
    assert.equal(q(salvar(1, 9.96)), "salvo|2");
    assert.equal(q("select preparo_meta_min::text from checklist_metas where unidade_id = '" + UN_A + "'"), "10.0", "uma casa decimal");
    assert.equal(q(salvar(1, 8)), "conflito|2");
    assert.equal(q(`select string_agg(versao || ':' || coalesce(anterior #>> '{preparo,meta}', '-') || '>' || (novo #>> '{preparo,meta}'), ',' order by versao) from checklist_metas_historico where unidade_id = '${UN_A}'`), "1:->12.0,2:12.0>10.0");
  });

  test("concorrência real: duas gravações com a mesma versão — exatamente uma vence", async () => {
    const [x, y] = await Promise.all([psqlAsync(b.url, salvar(2, 7)), psqlAsync(b.url, salvar(2, 6))]);
    assert.deepEqual([x.out, y.out].sort(), ["conflito|3", "salvo|3"]);
  });

  test("isolamento: unidade de outra organização é recusada; histórico é append-only; valores fora da régua recusados", () => {
    assert.equal(tenta(salvar(0, 12, { org: ORG, un: UN_B })).ok, false);
    assert.equal(tenta(`update checklist_metas_historico set origem = 'interface'`).ok, false);
    assert.equal(tenta(`delete from checklist_metas_historico`).ok, false);
    assert.equal(tenta(salvar(3, 300)).ok, false);
    assert.equal(q(salvar(0, 12, { org: ORG2, un: UN_B })), "salvo|1", "a outra empresa tem as próprias metas");
  });

  test("rollback remove tudo e é idempotente", () => {
    const r = join(MIGRATIONS_DIR, "127_rollback.sql");
    assert.equal(psqlSync(b.url, "", { arquivo: r }).ok, true);
    assert.equal(psqlSync(b.url, "", { arquivo: r }).ok, true);
    assert.equal(q("select coalesce(to_regclass('public.checklist_metas')::text, 'ausente')"), "ausente");
  });
});
