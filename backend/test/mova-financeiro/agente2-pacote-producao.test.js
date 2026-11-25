// MOVA — Agente 2: pacote de PRODUÇÃO do schema `mova` (instalar.sql) aplicado num database NOVO do PostgreSQL local isolado.
// Confere: pré-condições que abortam sem mudar nada, transação única, registro com sha256, permissões mínimas e a trava que
// separa a OPERACAO (schema próprio marcado) do banco de HOMOLOGAÇÃO. Nenhum dado real; nada remoto.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { abrirPool, ambiente } from "../financeiro-v2/helpers/postgres.js";
import { urlDoBanco } from "../../scripts/fv2/ambiente.mjs";
import { TABELAS_ESPERADAS, gerarInstalar, gerarInventario, listarMigracoes } from "../../scripts/mova/pacoteProducao.mjs";
import { exigirBancoDaOperacao } from "../../src/modules/fv2-integracao/mova.js";
import { motivoParaPularMova } from "./helpers/banco.js";

const PULAR = motivoParaPularMova();
const PRODUCAO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "database", "mova-financeiro", "producao");
const t = (nome, fn) => test(nome, { skip: PULAR }, fn);

let admin = null;
const criados = [];
async function bancoVazio(comentario = null) {
  const a = ambiente();
  admin ??= await abrirPool(a.urlAdmin, { max: 2 });
  const banco = `fv2_teste_mova_${randomBytes(6).toString("hex")}`; // só o padrão de teste; apagado no fim
  await admin.query(`create database ${banco} template template0`);
  await admin.query(`comment on database ${banco} is 'FV2_ISOLADO_TESTE:${a.marcador}'`);
  const pool = await abrirPool(urlDoBanco(a.urlAdmin, banco), { max: 1 });
  criados.push({ pool, banco });
  // Banco "de homologação": a guarda do ambiente isolado exige o marcador de teste para CONECTAR; a marca de homologação
  // entra depois, na conexão já aberta (pool de 1 conexão), só para simular o destino errado.
  if (comentario) { await pool.query("select 1"); await admin.query(`comment on database ${banco} is '${comentario}'`); }
  return { pool, banco };
}
after(async () => {
  for (const { pool, banco } of criados.splice(0)) {
    if (!/^fv2_teste_mova_[0-9a-f]{12}$/.test(banco)) continue;
    await pool.end().catch(() => {});
    await admin?.query(`drop database if exists ${banco} with (force)`).catch(() => {});
  }
  await admin?.end().catch(() => {});
});
const instalar = (pool) => pool.query(`begin;\n${readFileSync(join(PRODUCAO, "instalar.sql"), "utf8")}\ncommit;`).catch(async (e) => { await pool.query("rollback").catch(() => {}); throw e; });

test("P0 o pacote versionado é exatamente o gerado a partir das migrações (nada editado à mão)", () => {
  assert.equal(readFileSync(join(PRODUCAO, "instalar.sql"), "utf8"), gerarInstalar());
  assert.equal(readFileSync(join(PRODUCAO, "inventario.sql"), "utf8"), gerarInventario());
  const sql = gerarInstalar().replace(/--[^\n]*/g, "");
  assert.doesNotMatch(sql, /^\s*(drop\s+(table|schema|role)|truncate\s|delete\s+from)/im, "instalação aditiva");
  assert.doesNotMatch(sql, /\bpassword\b|create\s+(role|user)\s+\w+\s+(with\s+)?login\b/i, "não cria login nem senha");
  assert.doesNotMatch(sql, /comment on schema mova/i, "a marcação da operação é passo do operador");
  assert.doesNotMatch(sql, /\bpublic\.|financeiro_v2\./i, "não toca em public nem no Financeiro v2");
});

t("P1 instala num banco novo: tabelas, registro sha256, mova_app sem login e sem DELETE; inventário antes e depois", async () => {
  const { pool } = await bancoVazio();
  const antes = Object.fromEntries((await pool.query(gerarInventario())).rows.map((r) => [r.item, r.valor]));
  assert.equal(antes.schema_mova, "AUSENTE");
  await instalar(pool);
  const tabelas = (await pool.query("select tablename from pg_tables where schemaname = 'mova'")).rows.map((r) => r.tablename).sort();
  assert.deepEqual(tabelas, [...TABELAS_ESPERADAS].sort());
  const reg = (await pool.query("select nome, sha256 from mova.mova_migracao order by nome")).rows;
  assert.deepEqual(reg, listarMigracoes().map(({ nome, sha256 }) => ({ nome, sha256 })));
  const del = await pool.query("select table_name, privilege_type from information_schema.role_table_grants where table_schema = 'mova' and grantee = 'mova_app' and privilege_type in ('DELETE','TRUNCATE')");
  assert.deepEqual(del.rows, [{ table_name: "conversa_ativa", privilege_type: "DELETE" }], "só a conversa ativa (efêmera) pode ser excluída");
  assert.equal((await pool.query("select rolcanlogin from pg_roles where rolname = 'mova_app'")).rows[0].rolcanlogin, false);
  assert.equal((await pool.query("select has_schema_privilege('public', 'mova', 'USAGE') as u")).rows[0].u, false);
  const depois = Object.fromEntries((await pool.query(gerarInventario())).rows.map((r) => [r.item, r.valor]));
  assert.equal(depois.schema_mova, "EXISTE");
  assert.equal(depois.tabelas_mova, String(TABELAS_ESPERADAS.length));
  // P2: reaplicar aborta sem mudar nada
  await assert.rejects(instalar(pool), /schema mova já existe/);
  assert.equal((await pool.query("select count(*)::int as n from mova.mova_migracao")).rows[0].n, listarMigracoes().length);
});

t("P3 banco de HOMOLOGAÇÃO do MOVA: a instalação aborta e nada é criado", async () => {
  const { pool } = await bancoVazio("MOVA_HOMOLOGACAO:marcador-teste-01");
  await assert.rejects(instalar(pool), /banco de HOMOLOGAÇÃO/);
  assert.equal((await pool.query("select count(*)::int as n from pg_namespace where nspname = 'mova'")).rows[0].n, 0);
});

t("P4 trava da OPERACAO: só o schema marcado MOVA_OPERACAO:<marcador> passa; homologação e schema sem marca são recusados", async () => {
  const { pool } = await bancoVazio();
  await instalar(pool);
  await assert.rejects(exigirBancoDaOperacao(pool, "marcador-operacao-01"), { codigo: "BANCO_NAO_E_DA_OPERACAO" });
  await pool.query("comment on schema mova is 'MOVA_OPERACAO:marcador-operacao-01'");
  await exigirBancoDaOperacao(pool, "marcador-operacao-01");
  await assert.rejects(exigirBancoDaOperacao(pool, "outro-marcador-99"), { codigo: "BANCO_NAO_E_DA_OPERACAO" });
  await assert.rejects(exigirBancoDaOperacao(pool, null), { codigo: "BANCO_NAO_E_DA_OPERACAO" });
  // o mesmo schema num banco de homologação nunca guarda a operação
  const h = await bancoVazio("MOVA_HOMOLOGACAO:marcador-teste-02");
  for (const m of listarMigracoes()) await h.pool.query(m.sql);
  await h.pool.query("comment on schema mova is 'MOVA_OPERACAO:marcador-operacao-01'");
  await assert.rejects(exigirBancoDaOperacao(h.pool, "marcador-operacao-01"), { codigo: "BANCO_DE_HOMOLOGACAO_NA_OPERACAO" });
});
