// Painel SuperAdmin — o caminho para criar a conta do computador da TV (Operador de Exibição).
// Checagens estáticas: o botão, o manipulador e a chamada de API existem, e o fluxo antigo de "associar unidade"
// NÃO mudou (continua exigindo empresa e continua sem oferecer o cargo de exibição).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(fileURLToPath(new URL("../src", import.meta.url)));
const views = readFileSync(resolve(SRC, "adminViews.js"), "utf8");
const api = readFileSync(resolve(SRC, "adminApi.js"), "utf8");

describe("painel admin — acesso de exibição (TV)", () => {
  test("a API do painel conhece a lista de cargos de unidade", () => {
    assert.match(api, /papeisUnidade: \(\) => get\("\/usuarios\/papeis-unidade"\)/);
    assert.match(api, /papeis: \(\) => get\("\/usuarios\/papeis"\)/, "a lista de cargos de empresa segue como era");
  });

  test("o detalhe do usuário tem o botão e existe o manipulador", () => {
    assert.match(views, /data-adm-acao="usuario-exibicao"[^>]*>\+ Acesso de exibição \(TV\)<\/button>/);
    assert.match(views, /"usuario-exibicao": async \(\{ id, nome \}\) => \{/);
  });

  test("o manipulador cria SÓ o cargo de exibição, numa unidade, avisando que a conta é exclusiva", () => {
    const i = views.indexOf('"usuario-exibicao": async');
    const trecho = views.slice(i, views.indexOf('"usuario-senha"', i));
    assert.match(trecho, /adminApi\.associarUnidade\(id, unidadeId, "display_operator"\)/);
    assert.match(trecho, /somente o Checklist Operacional/);
    assert.match(trecho, /Não pode ter vínculo de empresa nem outros cargos/);
    assert.match(trecho, /if \(!unidadeId\) throw new Error\("Selecione uma unidade\."\)/);
    assert.doesNotMatch(trecho, /adminApi\.associar(Empresa|EmpresasLote)\(/, "nunca associa empresa");
  });

  test("o fluxo ANTIGO de associar unidade segue igual: exige empresa e só oferece os cargos de empresa", () => {
    const i = views.indexOf('"usuario-associar-unidade": async');
    const trecho = views.slice(i, views.indexOf('"usuario-exibicao"', i));
    assert.match(trecho, /Associe "\$\{nome\}" a uma empresa primeiro\./);
    assert.match(trecho, /opcoes: cache\.papeis\.map/);
    assert.doesNotMatch(trecho, /display_operator|papeisUnidade/);
  });
});
