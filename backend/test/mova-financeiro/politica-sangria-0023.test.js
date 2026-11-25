// MOVA 0023 (25/11/2026): PRESTACAO_DE_SANGRIA nas listas fechadas de políticas e execuções. Ensaio do pacote de PRODUÇÃO
// (aplicar-politica-sangria.sql) e da reversão num banco local isolado com as migrações registradas pelo hash real.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { criarBancoMova, descartarBancoMova, motivoParaPularMova } from "./helpers/banco.js";
import { ESTADO_PRODUCAO_APOS_PROPOSTAS, listarMigracoes } from "../../scripts/mova/pacoteProducao.mjs";

const PULAR = motivoParaPularMova();
const ler = (p) => readFileSync(new URL(`../../../database/mova-financeiro/${p}`, import.meta.url), "utf8");
const aceita = async (pool) => (await pool.query("select pg_get_constraintdef(oid) d from pg_constraint where conname = 'politica_autonomia_operacao_check'")).rows[0].d.includes("PRESTACAO_DE_SANGRIA");

test("P23 pacote de produção da 0023: confere o estado por hash, aplica, recusa repetir; reversão volta e recusa com política de sangria", { skip: PULAR, timeout: 120000 }, async () => {
  const banco = await criarBancoMova();
  const { pool } = banco;
  try {
    const ms = listarMigracoes();
    await pool.query("create table if not exists mova.mova_migracao (nome text primary key, sha256 text not null, aplicada_em timestamptz not null default now())");
    await pool.query("delete from mova.mova_migracao");
    for (const m of ms.filter((x) => [...ESTADO_PRODUCAO_APOS_PROPOSTAS, "0023"].includes(x.nome.slice(0, 4)))) await pool.query("insert into mova.mova_migracao (nome, sha256) values ($1, $2)", [m.nome, m.sha256]);
    assert.equal(await aceita(pool), true, "o banco de teste nasce com todas as migrações");
    // reverter (sem política de sangria): volta ao estado da 0012
    await pool.query(`begin; ${ler("recuperacao/reverter-0023.sql")} commit;`);
    assert.equal(await aceita(pool), false);
    await assert.rejects(pool.query("insert into mova.politica_autonomia (operacao, organizacao_id, unidade_id, nivel, limite_centavos, responsavel, motivo, vigente_de, criada_por) values ('PRESTACAO_DE_SANGRIA', gen_random_uuid(), gen_random_uuid(), 'APLICAR_AUTOMATICO', 100000, 'x', 'motivo sintético', '2026-11-25', gen_random_uuid())"), /check/);
    // aplicar o pacote de produção
    await pool.query(`begin; ${ler("producao/aplicar-politica-sangria.sql")} commit;`);
    assert.equal(await aceita(pool), true);
    await assert.rejects(pool.query(`begin; ${ler("producao/aplicar-politica-sangria.sql")} commit;`), /já aplicada/);
    await pool.query("rollback").catch(() => {});
    // com uma política de sangria (mesmo revogada), a reversão recusa
    await pool.query("insert into mova.politica_autonomia (operacao, organizacao_id, unidade_id, nivel, limite_centavos, responsavel, motivo, vigente_de, criada_por, revogada_em, revogada_por) values ('PRESTACAO_DE_SANGRIA', gen_random_uuid(), gen_random_uuid(), 'APLICAR_AUTOMATICO', 100000, 'x', 'motivo sintético', '2026-11-25', gen_random_uuid(), now(), gen_random_uuid())");
    await assert.rejects(pool.query(`begin; ${ler("recuperacao/reverter-0023.sql")} commit;`), /PRESTACAO_DE_SANGRIA/);
    await pool.query("rollback").catch(() => {});
    assert.equal(await aceita(pool), true);
    // estado divergente (hash diferente) ⇒ o pacote recusa
    await pool.query("delete from mova.mova_migracao where nome like '0023_%'");
    await pool.query("update mova.mova_migracao set sha256 = 'outro' where nome like '0020_%'");
    await assert.rejects(pool.query(`begin; ${ler("producao/aplicar-politica-sangria.sql")} commit;`), /ausente ou com outro conteúdo/);
    await pool.query("rollback").catch(() => {});
  } finally { await descartarBancoMova(banco); }
});
