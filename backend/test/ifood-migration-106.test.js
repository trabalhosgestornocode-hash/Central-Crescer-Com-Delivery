// Migration 106 — registro do requestId da Reconciliation On Demand (Financial).
// Validação ESTÁTICA do SQL (o Postgres real foi validado no projeto de teste).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIG = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../database/migrations");
const ler = (f) => readFileSync(path.join(MIG, f), "utf8");
const semComentarios = (sql) => sql.replace(/--.*$/gm, "");
const SQL = semComentarios(ler("106_ifood_financial_reconciliacao_on_demand.sql"));
const RB = semComentarios(ler("106_rollback.sql"));
const TABELA = "ifood_financial_reconciliacoes_on_demand";

test("106 é aditiva: só cria objetos novos, não altera/apaga tabela ou dado existente", () => {
  assert.doesNotMatch(SQL, /drop\s+table|truncate|delete\s+from|update\s+\w+\s+set|drop\s+column/i);
  assert.doesNotMatch(SQL, /alter\s+table\s+(?!ifood_financial_reconciliacoes_on_demand\b)\w+/i, "nenhuma tabela existente é alterada");
  assert.match(SQL, new RegExp(`create table if not exists ${TABELA}`));
});

test("isolamento: organização, unidade e conexão obrigatórias, com FK", () => {
  for (const [col, ref] of [["organizacao_id", "organizacoes"], ["unidade_id", "unidades"], ["conexao_id", "ifood_conexoes"]]) {
    assert.match(SQL, new RegExp(`${col} uuid not null references ${ref}\\(id\\) on delete cascade`), col);
  }
});

test("uma solicitação por conexão + competência; CHECKs de competência e status", () => {
  assert.match(SQL, /unique \(conexao_id, competencia\)/);
  assert.match(SQL, /competencia text not null check \(competencia ~ '\^\[0-9\]\{4\}-\(0\[1-9\]\|1\[0-2\]\)\$'\)/);
  assert.match(SQL, /check \(status in \('solicitado', 'created', 'enqueue', 'processed', 'error'\)\)/);
  assert.match(SQL, /request_id uuid not null/);
  assert.match(SQL, /expira_em timestamptz not null/);
});

test("backend-only: RLS habilitado, nenhuma policy e REVOKE de anon/authenticated (TRUNCATE não passa por RLS)", () => {
  assert.match(SQL, new RegExp(`alter table ${TABELA} enable row level security`));
  assert.doesNotMatch(SQL, /create\s+policy/i);
  assert.doesNotMatch(SQL, /grant\s+/i);
  assert.match(SQL, new RegExp(`revoke all on ${TABELA} from anon, authenticated`));
});

test("não guarda token, URL de download nem conteúdo do arquivo", () => {
  assert.doesNotMatch(SQL, /token|download|url|arquivo\s+(bytea|text)/i);
});

test("rollback remove SÓ o trigger e a tabela da 106", () => {
  const drops = [...RB.matchAll(/drop\s+(table|trigger)\s+if\s+exists\s+(\w+)/gi)].map((m) => `${m[1].toLowerCase()}:${m[2]}`);
  assert.deepEqual(drops, ["trigger:trg_ifood_fin_recon_od_upd", `table:${TABELA}`]);
  assert.doesNotMatch(RB, /delete|truncate|alter\s+table/i);
});
