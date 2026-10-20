// Contrato repositório ⇄ SQL: toda RPC chamada pelo backend existe nos SQL do domínio (121 + 122) com EXATAMENTE os mesmos parâmetros.
// Evita a divergência silenciosa entre a camada de aplicação e o banco (que só apareceria em homologação).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const aqui = fileURLToPath(new URL(".", import.meta.url));
const dominio = join(aqui, "..", "..", "src", "modules", "gestao-financeira", "dominio");
const raizRepo = join(aqui, "..", "..", "..");
// 121 (provisória ou promovida em database/migrations) + 122 (proposta); rollbacks ignorados
const dirs = ["docs/gestao-financeira/sql-provisorio", "docs/gestao-financeira/proposta-122", "database/migrations"].map((d) => join(raizRepo, d));
const arquivos = dirs.flatMap((d) => { try { return readdirSync(d).filter((f) => /^12[12]_.*\.sql$/.test(f) && !f.includes("rollback")).map((f) => join(d, f)); } catch { return []; } });
const sql = arquivos.map((f) => readFileSync(f, "utf8")).join("\n");
const funcoes = new Map();
for (const m of sql.matchAll(/create or replace function (fin_[a-z_]+)\(([\s\S]*?)\)\s*returns/g)) {
  funcoes.set(m[1], [...m[2].matchAll(/\b(p_[a-z_]+)\s+[a-z]/g)].map((x) => x[1]).sort());
}
const fonte = ["repositorio.js", "repositorio.periodos.js", "repositorio.conciliacao.js"].map((f) => readFileSync(join(dominio, f), "utf8")).join("\n");
const chamadas = [...fonte.matchAll(/\.rpc\("(fin_[a-z_]+)",\s*\{([\s\S]*?)\}\s*\)/g)].map((m) => ({ nome: m[1], params: [...m[2].matchAll(/\b(p_[a-z_]+):/g)].map((x) => x[1]).sort() }));

test("o repositório chama RPCs (e as encontra no SQL)", () => {
  assert.ok(chamadas.length >= 9, `chamadas encontradas: ${chamadas.length}`);
  assert.ok(funcoes.size >= 9, `funções no SQL: ${funcoes.size}`);
});
test("cada RPC chamada existe no SQL com os mesmos parâmetros (nenhum a mais, nenhum a menos)", () => {
  for (const c of chamadas) {
    assert.ok(funcoes.has(c.nome), `RPC ausente no SQL: ${c.nome}`);
    assert.deepEqual(c.params, funcoes.get(c.nome), `parâmetros divergem em ${c.nome}`);
  }
});
test("nenhuma RPC do SQL que o backend deixou de usar é perigosa: a única sem uso direto é a de desvínculo sem motivo (revogada no 122)", () => {
  const usadas = new Set(chamadas.map((c) => c.nome));
  const semUso = [...funcoes.keys()].filter((n) => !usadas.has(n) && /^fin_(abrir|fechar|reabrir|criar|vincular|desvincular|confirmar|cancelar|fingerprint)/.test(n));
  assert.deepEqual(semUso, ["fin_desvincular_transferencia"]);
});
