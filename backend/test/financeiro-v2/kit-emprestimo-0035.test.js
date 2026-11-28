// 27/11 — ENSAIO do kit de produção da 0035 num PostgreSQL REAL isolado: backup → reversão (volta à 0034) → atualizar.sql de produção
// (aplica SÓ a 0035) → conferência. Prova que o caminho de ida e de volta funciona antes de qualquer uso em produção.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";
import { ESCOPOS_PADRAO } from "./helpers/cenario.js";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ler = (n) => fs.readFileSync(path.join(RAIZ, "database/financeiro-v2/producao", n), "utf8");
const parteB = (sql) => sql.slice(sql.indexOf("-- ===================== B) banco"));

test("KIT-0035 ensaio: backup, reversão para a 0034 e reaplicação pelo atualizar.sql de produção; conferência final", { skip: motivoParaPular(), timeout: 300000 }, async () => {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  const dono = await (await repositorio.interno()).dono();
  const estado = async () => (await dono.query(`select (select count(*)::int from financeiro_v2.fv2_migracao) n,
      (select pg_get_constraintdef(oid) like '%registrar_emprestimo%' from pg_constraint where conname = 'fv2_concessao_acoes_lista') acao,
      (select count(*)::int from pg_proc where proname = 'fv2_principal_de_emprestimo') funcao`)).rows[0];
  assert.deepEqual(await estado(), { n: 35, acao: true, funcao: 1 }, "banco de teste com a 0035");
  // como em produção: papel SEM superusuário, numa conexão
  const comoMigrador = async (sql) => { const c = await dono.connect(); try { await c.query("set role fv2_teste_migrador"); return await c.query(sql); } finally { try { await c.query("reset role"); } catch { /* descartada */ } c.release(); } };
  await dono.query(ler("emprestimo-0035/01-backup.sql")); // backup: cópia pelo dono do banco (em produção, o postgres)
  assert.equal(Number((await dono.query("select count(*) n from backup_0035_20261127.objetos")).rows[0].n), 2, "backup da função e da restrição");
  await comoMigrador(parteB(ler("emprestimo-0035/05-reversao.sql")));
  assert.deepEqual(await estado(), { n: 34, acao: false, funcao: 0 }, "reversão: volta exatamente à 0034");
  await comoMigrador(ler("atualizar.sql"));
  assert.deepEqual(await estado(), { n: 35, acao: true, funcao: 1 }, "o atualizar.sql de produção aplica a 0035 sobre a 0034");
  const c = (await dono.query(ler("emprestimo-0035/03-conferencia.sql"))).rows[0];
  assert.deepEqual([Number(c.migracoes), c.tem_0035, c.acao_na_lista, Number(c.funcao_nova), Number(c.concessoes_com_a_acao)], [35, true, true, 1, 0]);
});
