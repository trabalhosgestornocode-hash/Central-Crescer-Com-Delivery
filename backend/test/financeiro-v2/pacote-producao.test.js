// Execução 10 — o PACOTE DE INSTALAÇÃO em produção (database/financeiro-v2/producao) está em dia com as migrações
// 0001–0021 e é estritamente ADITIVO: nada de DROP/TRUNCATE/DELETE em objeto que não seja do próprio módulo, nada fora do
// schema dedicado, nenhum papel com login, nenhuma senha. A aplicação real no banco é validada pela sonda
// (scripts/fv2/sondaSupabaseSimulado.mjs, execução E4) e pela suíte PostgreSQL (modelo migrado no schema dedicado).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listarMigracoes, textoAplicado } from "../../scripts/fv2/ambiente.mjs";

const backend = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const pasta = join(backend, "..", "database", "financeiro-v2", "producao");
const ler = (n) => readFileSync(join(pasta, n), "utf8");

test("10 — pacote de produção em dia com as migrações (gerado, nunca editado à mão)", () => {
  const r = spawnSync(process.execPath, [join(backend, "scripts", "fv2", "pacoteProducao.mjs"), "--conferir"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const instalar = ler("instalar.sql");
  for (const m of listarMigracoes()) {
    assert.ok(instalar.includes(m.sha256), `${m.nome}: hash do arquivo ausente`);
    assert.ok(instalar.includes(textoAplicado(m.sql).trimEnd()), `${m.nome}: texto aplicado ausente`);
  }
});

test("10 — instalar.sql é aditivo e não toca no sistema atual", () => {
  const sql = ler("instalar.sql").replace(/--[^\n]*/g, "");
  // DROP só da tabela temporária das próprias migrações; nenhum TRUNCATE/DELETE em massa; nada de ALTER em objeto alheio
  const drops = [...sql.matchAll(/\bdrop\s+(\w+)\s+(?:if\s+exists\s+)?([\w.]+)/gi)].map((x) => `${x[1].toLowerCase()} ${x[2]}`);
  assert.deepEqual([...new Set(drops)].filter((d) => !/^(table (pg_temp\.)?fv2__\w+|policy fv2_\w+|trigger fv2_\w+|function fv2_\w+|index fv2_\w+|constraint fv2_\w+)$/.test(d)), []);
  // comandos (não as palavras: os gatilhos de proteção citam "before truncate" para PROIBIR exclusão)
  assert.doesNotMatch(sql, /(^|;)\s*truncate\s/im);
  assert.doesNotMatch(sql, /(^|;)\s*delete\s+from\s/im);
  assert.doesNotMatch(sql, /\bdisable\s+row\s+level\s+security\b/i);
  assert.doesNotMatch(sql, /\b(alter|drop)\s+table\s+(?:if\s+exists\s+)?(public|auth|storage)\./i);
  assert.doesNotMatch(sql, /search_path\s*=\s*[^;$]*\bpublic\b/i, "search_path apontando para public");
  assert.doesNotMatch(sql, /\blogin\s+password\b|\bpassword\s+'/i, "nenhuma senha no pacote");
  assert.match(sql, /create schema financeiro_v2;/);
  assert.match(sql, /revoke all on schema financeiro_v2 from public;/);
  assert.match(sql, /schema financeiro_v2 já existe/); // pré-condição: não reinstala por cima
});

test("auditoria do Agente 2 — A-2 aborta antes de alterar; A5 revoga explicitamente; pós-condições não confiam só no USAGE", () => {
  const sql = ler("instalar.sql");
  const pre = sql.indexOf("pré-condições (abortam)");
  const criar = sql.indexOf("create schema financeiro_v2;");
  const a2 = sql.indexOf("from pg_publication where puballtables");
  assert.ok(pre >= 0 && a2 > pre && a2 < criar, "a checagem da publicação FOR ALL TABLES vem ANTES de qualquer alteração");
  const a5 = sql.indexOf("A5: revogação explícita");
  const ultima = sql.lastIndexOf("insert into financeiro_v2.fv2_migracao");
  const pos = sql.indexOf("pós-condições (abortam)");
  assert.ok(a5 > ultima && a5 < pos, "A5 depois da última migração e antes das pós-condições");
  for (const t of ["revoke all on all tables in schema financeiro_v2 from %I", "revoke all on all sequences in schema financeiro_v2 from %I", "revoke all on all functions in schema financeiro_v2 from %I"]) assert.ok(sql.includes(t), t);
  assert.match(sql.slice(a5, pos), /grant fv2_guardiao to current_user;[\s\S]*revoke fv2_guardiao from current_user;/, "participação temporária desfeita");
  for (const t of ["privilégio(s) de PUBLIC ou credencial comum em tabela/sequência", "EXECUTE concedido a credencial comum", "tabela(s) do v2 em publicação de replicação"]) assert.ok(sql.slice(pos).includes(t), t);
});

test("10 — desativar.sql não apaga nada", () => {
  const sql = ler("desativar.sql").replace(/--[^\n]*/g, "");
  assert.doesNotMatch(sql, /\b(drop|truncate|delete)\b/i);
  assert.match(sql, /nologin/);
});

test("10 — inventario.sql é só leitura", () => {
  const sql = ler("inventario.sql").replace(/--[^\n]*/g, "");
  assert.doesNotMatch(sql, /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i);
});

test("10 — escopo da unidade (passo da ativação): só UUIDs, confere a unidade na empresa e o v2 instalado; idempotente; não libera nada", async () => {
  const { sqlEscopoDaUnidade } = await import("../../scripts/fv2/pacoteProducao.mjs");
  const O = "aaaaaaaa-0000-4000-8000-000000000001";
  const U = "aaaaaaaa-0000-4000-8000-0000000000a1";
  const sql = sqlEscopoDaUnidade(O, U);
  assert.match(sql, /from public\.unidades where id = 'aaaaaaaa-0000-4000-8000-0000000000a1'::uuid and organizacao_id = 'aaaaaaaa-0000-4000-8000-000000000001'::uuid/);
  assert.match(sql, /on conflict \(organizacao_id, unidade_id\) do nothing/);
  assert.doesNotMatch(sql, /fv2_liberacao|update|delete|drop|truncate/i);
  assert.throws(() => sqlEscopoDaUnidade("x", U));
  assert.throws(() => sqlEscopoDaUnidade(O, "'; drop table x; --"));
  assert.throws(() => sqlEscopoDaUnidade(O, U, "rótulo'; drop"));
});
