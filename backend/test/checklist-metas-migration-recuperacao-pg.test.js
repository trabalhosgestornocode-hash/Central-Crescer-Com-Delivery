// Migrations 127/128 — APLICAÇÃO, FALHA, RECUPERAÇÃO e ROLLBACK em Postgres LOCAL e DESCARTÁVEL (schema real até 126).
// Complementa checklist-metas-migration-pg.test.js com o que a publicação precisa saber antes de rodar em produção:
//   * 128 (CREATE INDEX CONCURRENTLY) NÃO roda dentro de transação — e nada fica pela metade;
//   * 127 é atômica: com um lock no caminho (lock_timeout 5 s) aborta inteira, sem objeto órfão; depois aplica normalmente;
//   * índice INVALID (falha no meio do CONCURRENTLY): reaplicar a 128 NÃO conserta (IF NOT EXISTS) — o procedimento
//     documentado (drop concurrently + reaplicar) conserta;
//   * estrutura: constraints, chaves, gatilhos e índices; o plano da consulta do Dashboard usa o índice;
//   * rollback na ordem 128 → 127 com dados existentes: pedidos intactos, metas e histórico apagados (documentado),
//     outras migrations intactas; idempotente; reaplicar depois funciona do zero.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55430/postgres node --experimental-vm-modules --test test/checklist-metas-migration-recuperacao-pg.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { motivoPular, criarBancoDescartavel, sql, psqlSync, psqlAsync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal, MIGRATIONS_DIR } from "./helpers/schema-real-pg.js";

const ORG = "00000000-0000-0000-0000-0000000000a0";
const UN = "00000000-0000-0000-0000-0000000000a1";
const M127 = join(MIGRATIONS_DIR, "127_checklist_metas.sql");
const M128 = join(MIGRATIONS_DIR, "128_ifood_pedidos_indice_periodo.sql");
const R127 = join(MIGRATIONS_DIR, "127_rollback.sql");
const R128 = join(MIGRATIONS_DIR, "128_rollback.sql");
const IDX = "idx_ifood_pedidos_tenant_criado";

describe("migrations 127/128 — falha, recuperação e rollback (schema real até 126)", { skip: motivoPular, timeout: 900_000 }, () => {
  let b;
  const q = (t) => sql(b.url, t);
  const aplicar = (arq) => psqlSync(b.url, "", { arquivo: arq });
  const existe = (rel) => q(`select coalesce(to_regclass('public.${rel}')::text, 'ausente')`);
  const salvar = (versao, preparo) => q(`select resultado || '|' || versao_atual from checklist_metas_salvar('${ORG}', '${UN}', ${versao}, ${preparo}, 80, 35, 80, 45, 80, 'interface', null, null, 'Gestora', null)`);

  before(() => {
    b = criarBancoDescartavel("hml_mig_127_128");
    const falhas = construirSchemaReal(b.url, { ate: 126 });
    assert.deepEqual(falhas, [], JSON.stringify(falhas));
    q(`insert into organizacoes (id, nome) values ('${ORG}', 'Org A');
       insert into unidades (id, nome, organizacao_id) values ('${UN}', 'Unidade A', '${ORG}');
       insert into ifood_pedidos (order_id, merchant_id, organizacao_id, unidade_id, status_oficial, criado_em)
         select 'p-' || g, 'm-1', '${ORG}', '${UN}', 'CONCLUDED', now() - (g || ' minutes')::interval from generate_series(1, 3000) g;`);
  });
  after(() => b?.derrubar());

  test("pré-condição: schema real até 126 sem as 127/128 (numeração livre)", () => {
    assert.equal(existe("checklist_metas"), "ausente");
    assert.equal(existe(IDX), "ausente");
    assert.equal(q("select count(*) from ifood_pedidos"), "3000");
  });

  test("128 dentro de transação: recusada pelo Postgres e nada fica criado", () => {
    const r = psqlSync(b.url, `begin;\n${readFileSync(M128, "utf8")}\ncommit;`);
    assert.equal(r.ok, false);
    assert.match(r.err, /CREATE INDEX CONCURRENTLY cannot run inside a transaction block/);
    assert.equal(existe(IDX), "ausente");
  });

  test("127 com um lock no caminho: aborta INTEIRA por lock_timeout (sem objeto órfão); depois aplica normalmente", async () => {
    const segura = psqlAsync(b.url, "begin; lock table unidades in access exclusive mode; select pg_sleep(9); commit;");
    await new Promise((r) => setTimeout(r, 1500));
    const r = aplicar(M127);
    assert.equal(r.ok, false);
    assert.match(r.err, /lock timeout|canceling statement due to lock timeout/i);
    assert.equal(existe("checklist_metas"), "ausente");
    assert.equal(existe("checklist_metas_historico"), "ausente");
    assert.equal(q("select count(*) from pg_proc where proname like 'checklist_metas%'"), "0");
    await segura;
    assert.equal(aplicar(M127).ok, true);
    assert.equal(aplicar(M127).ok, true, "idempotente");
    assert.equal(salvar(0, 12), "salvo|1");
  });

  test("128 fora de transação: índice criado e VÁLIDO com dados existentes; reaplicar é inofensivo", () => {
    assert.equal(aplicar(M128).ok, true);
    assert.equal(q(`select indisvalid::text || '|' || indisready::text from pg_index where indexrelid = 'public.${IDX}'::regclass`), "true|true");
    assert.equal(q(`select pg_get_indexdef('public.${IDX}'::regclass)`), `CREATE INDEX ${IDX} ON public.ifood_pedidos USING btree (organizacao_id, unidade_id, criado_em)`);
    assert.equal(aplicar(M128).ok, true);
    assert.equal(q(`select count(*) from pg_indexes where indexname = '${IDX}'`), "1");
  });

  test("a consulta do Dashboard (tenant + intervalo de criado_em) usa o índice", () => {
    const plano = q(`set enable_seqscan = off; explain select order_id from ifood_pedidos where organizacao_id = '${ORG}' and unidade_id = '${UN}' and criado_em >= now() - interval '7 days' and criado_em < now() order by criado_em`);
    assert.match(plano, new RegExp(IDX));
  });

  test("falha no meio do CONCURRENTLY (índice INVALID): reaplicar NÃO conserta; drop concurrently + reaplicar conserta", () => {
    q(`update pg_index set indisvalid = false where indexrelid = 'public.${IDX}'::regclass`); // simula a falha
    assert.equal(aplicar(M128).ok, true);
    assert.equal(q(`select indisvalid::text from pg_index where indexrelid = 'public.${IDX}'::regclass`), "false", "IF NOT EXISTS mantém o índice inválido");
    assert.equal(psqlSync(b.url, `drop index concurrently if exists ${IDX};`).ok, true);
    assert.equal(aplicar(M128).ok, true);
    assert.equal(q(`select indisvalid::text from pg_index where indexrelid = 'public.${IDX}'::regclass`), "true");
  });

  test("estrutura: chaves, constraints de faixa, unicidade do histórico, gatilhos e índices", () => {
    const cons = q(`select string_agg(conname || ':' || contype::text, ',' order by conname) from pg_constraint where conrelid = 'public.checklist_metas'::regclass`);
    for (const c of ["checklist_metas_pkey:p", "checklist_metas_unidade_id_fkey:f", "checklist_metas_organizacao_id_fkey:f"]) assert.ok(cons.includes(c), `${c} em ${cons}`);
    assert.equal(q(`select count(*) from pg_constraint where conrelid = 'public.checklist_metas'::regclass and contype = 'c'`), "8", "versao + 3 metas + 3 avisos + tamanho do nome");
    assert.equal(q(`select string_agg(confdeltype::text, '') from pg_constraint where conrelid = 'public.checklist_metas'::regclass and contype = 'f'`), "cc", "on delete cascade (unidade/empresa excluída leva as metas)");
    assert.match(q(`select string_agg(conname, ',') from pg_constraint where conrelid = 'public.checklist_metas_historico'::regclass and contype = 'u'`), /uq_checklist_metas_historico_versao/);
    assert.equal(q(`select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = 'public.checklist_metas_historico'::regclass and not tgisinternal`), "trg_checklist_metas_historico_imutavel,trg_checklist_metas_historico_tenant");
    assert.equal(q(`select string_agg(tgname, ',') from pg_trigger where tgrelid = 'public.checklist_metas'::regclass and not tgisinternal`), "trg_checklist_metas_tenant");
    assert.match(q(`select string_agg(indexname, ',') from pg_indexes where tablename = 'checklist_metas_historico'`), /idx_checklist_metas_historico_tenant/);
    // Faixas recusadas pelo banco mesmo se a API deixasse passar.
    assert.equal(psqlSync(b.url, `select checklist_metas_salvar('${ORG}', '${UN}', 1, 0, 80, 35, 80, 45, 80, 'interface', null, null, 'x', null)`).ok, false);
    assert.equal(psqlSync(b.url, `select checklist_metas_salvar('${ORG}', '${UN}', 1, 12, 100, 35, 80, 45, 80, 'interface', null, null, 'x', null)`).ok, false);
  });

  test("rollback 128 → 127 com dados: pedidos intactos; metas e histórico apagados; demais migrations intactas; idempotente", () => {
    assert.equal(salvar(1, 14), "salvo|2");
    const modulo123 = q("select count(*) from modulos where id = 'checklist_operacional'");
    const financeiro120 = existe("fin_lancamentos") !== "ausente" || q("select count(*) from pg_tables where tablename like 'fin\\_%'") !== "0";
    // 128 primeiro (só o índice), depois a 127.
    assert.equal(aplicar(R128).ok, true);
    assert.equal(existe(IDX), "ausente");
    assert.equal(q("select count(*) from ifood_pedidos"), "3000", "o rollback do índice não toca nos pedidos");
    assert.equal(aplicar(R128).ok, true, "idempotente");
    assert.equal(aplicar(R127).ok, true);
    assert.equal(existe("checklist_metas"), "ausente");
    assert.equal(existe("checklist_metas_historico"), "ausente", "o histórico de metas é perdido no rollback (exportar antes)");
    assert.equal(q("select count(*) from pg_proc where proname like 'checklist_metas%'"), "0");
    assert.equal(aplicar(R127).ok, true, "idempotente");
    assert.equal(q("select count(*) from ifood_pedidos"), "3000");
    assert.equal(q("select count(*) from modulos where id = 'checklist_operacional'"), modulo123, "migration 123 intacta");
    assert.ok(financeiro120 === (existe("fin_lancamentos") !== "ausente" || q("select count(*) from pg_tables where tablename like 'fin\\_%'") !== "0"), "Financeiro intacto");
  });

  test("reaplicar depois do rollback: 127 + 128 voltam do zero e a função grava a versão 1 de novo", () => {
    assert.equal(aplicar(M127).ok, true);
    assert.equal(aplicar(M128).ok, true);
    assert.equal(q(`select indisvalid::text from pg_index where indexrelid = 'public.${IDX}'::regclass`), "true");
    assert.equal(salvar(0, 12), "salvo|1");
    assert.equal(q("select count(*) from checklist_metas_historico"), "1");
  });
});
