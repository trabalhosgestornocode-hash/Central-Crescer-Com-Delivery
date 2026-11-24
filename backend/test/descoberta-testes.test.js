// Descoberta da suíte: o executor (scripts/rodarTestes.mjs) roda TODO arquivo *.test.* de test/ e nenhum helper.
// Protege contra os dois erros: helpers rodando soltos como se fossem testes (falhas falsas) e teste real fora da lista (falha escondida).
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { arquivosDeTeste } from "../scripts/rodarTestes.mjs";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
function todos(p, acc = []) {
  for (const e of readdirSync(p, { withFileTypes: true })) { const c = join(p, e.name); if (e.isDirectory()) todos(c, acc); else acc.push(relative(RAIZ, c).split("\\").join("/")); }
  return acc;
}

test("DT-01 todo *.test.* de test/ está na lista e nenhum arquivo de helpers/fixtures/avaliação entra", () => {
  const lista = arquivosDeTeste();
  const esperados = todos(join(RAIZ, "test")).filter((f) => /\.test\.(c|m)?js$/.test(f)).sort();
  assert.deepEqual([...lista].sort(), esperados);
  assert.ok(lista.every((f) => !/\/helpers\//.test(f)), "nenhum helper roda como teste");
  assert.ok(lista.length > 500, "a suíte inteira, não um recorte");
});

test("DT-02 arquivos JS fora do padrão em test/ são só apoio (helpers, avaliação): nenhum declara test() sozinho", () => {
  const apoio = todos(join(RAIZ, "test")).filter((f) => /\.(c|m)?js$/.test(f) && !/\.test\.(c|m)?js$/.test(f));
  const comTeste = apoio.filter((f) => /^\s*(test|it|describe)\(/m.test(readFileSync(join(RAIZ, f), "utf8")) && !/\/helpers\//.test(f));
  assert.deepEqual(comTeste, [], `arquivo com test() fora do padrão *.test.* não seria executado: ${comTeste.join(", ")}`);
});

test("DT-03 os helpers que viram PROCESSO continuam cobertos pelos testes que os iniciam", () => {
  const usos = { "ifood-worker-fixture.mjs": "ifood-worker-lifecycle.test.js", "servidor-sigterm-app.mjs": "servidor-sigterm-processo.test.js" };
  for (const [helper, teste] of Object.entries(usos)) {
    assert.ok(arquivosDeTeste().includes(`test/${teste}`), teste);
    assert.match(readFileSync(join(RAIZ, "test", teste), "utf8"), new RegExp(helper.replace(".", "\\.")), `${teste} inicia ${helper}`);
  }
});

test("DT-04 npm test usa o executor (e não `node --test test/`, que roda os helpers)", () => {
  const pkg = JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8"));
  assert.match(pkg.scripts.test, /scripts\/rodarTestes\.mjs/);
  assert.doesNotMatch(pkg.scripts.test, /--test test\/\s*$/);
});
