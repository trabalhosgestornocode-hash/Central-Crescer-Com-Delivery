// Agrupamento das despesas fixas como na apresentação (Pessoal · Administrativas · Prestação de serviços · Financeiras) e salvaguardas da homologação.
// Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { arvoreDre } from "../../src/financeiro-calculos/composicao.js";

const L = (codigo, descricao, centavos) => ({ codigo, descricao, centavos, criterio: "caixa", motivo: null });
const dre = {
  semContasAPagar: false,
  indicadores: { faturamentoBruto: 1000000, deducoes: 0, faturamentoLiquido: 1000000, cmv: 0, entregas: 0, custosTotais: 0, despesasVariaveis: 0, margemContribuicao: 1000000, despesasFixas: 8100, resultadoGerencial: 991900 },
  grupos: [{ grupo: "deducoes", linhas: [] }, { grupo: "cmv", linhas: [] }, { grupo: "entregas", linhas: [] }, { grupo: "variaveis", linhas: [] },
    { grupo: "fixas", linhas: [L("C1", "SALARIO", 4000), L("C2", "ENERGIA", 2000), L("C3", "HONORARIOS ADVOCATICIOS", 1000), L("C4", "PRESTADOR DE SERVIÇOS", 800), L("C5", "MARKETING", 200), L("C6", "TARIFAS", 100)] }],
};
const papel = new Map([["C1", "despesa_pessoal"], ["C2", "despesa_fixa"], ["C3", "despesa_fixa"], ["C4", "despesa_fixa"], ["C5", "despesa_variavel"], ["C6", "despesa_financeira"]]);

test("despesas fixas: Prestação de serviços é subgrupo próprio e as Administrativas não a incluem", () => {
  const fixas = arvoreDre(dre, null, { papelPorLinha: papel }).find((n) => n.id === "fixas");
  const sub = Object.fromEntries(fixas.filhos.map((s) => [s.rotulo, { centavos: s.centavos, itens: s.filhos.map((x) => x.rotulo) }]));
  assert.deepEqual(Object.keys(sub), ["Pessoal", "Administrativas", "Prestação de serviços", "Financeiras e tarifas"], "ordem: pessoal, administrativas, prestação, financeiras");
  assert.equal(sub["Administrativas"].centavos, 3000); assert.deepEqual(sub["Administrativas"].itens.sort(), ["ENERGIA", "HONORARIOS ADVOCATICIOS"]);
  assert.equal(sub["Prestação de serviços"].centavos, 1000); assert.deepEqual(sub["Prestação de serviços"].itens.sort(), ["MARKETING", "PRESTADOR DE SERVIÇOS"]);
  assert.equal(fixas.filhos.reduce((a, s) => a + s.centavos, 0), 8100, "os subgrupos somam o total de despesas fixas");
});

test("o script de homologação não carrega valores da apresentação (a referência é privada e só COMPARA)", () => {
  const fonte = readFileSync(fileURLToPath(new URL("../../testes-seguros/financeiro-2-0/homologar-setembro.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(fonte, /R\$ ?\d{1,3}(\.\d{3})+,\d{2}/, "nenhum valor formatado em reais");
  const numeros = [...fonte.matchAll(/(?<![\w.#$-])\d{5,}(?![\w])/g)].map((m) => m[0]).filter((n) => n !== "10000");   // 10000 = pontos-base de 100%
  assert.deepEqual(numeros, [], `números grandes no script: ${numeros.join(", ")}`);
  assert.match(fonte, /FIN20_REFERENCIA/, "lê a referência de um JSON privado");
  assert.match(fonte, /só servidor local/, "recusa servidor que não seja local");
});
