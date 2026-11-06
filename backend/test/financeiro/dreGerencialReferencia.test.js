// DRE gerencial de REFERÊNCIA (critério misto parametrizável) + melhorias do importador. Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { montarDreReferencia } from "../../src/financeiro-calculos/dreGerencialReferencia.js";
import { planejarImportacaoCentral } from "../../src/financeiro-calculos/importacaoCentral.js";

const regras = (o = {}) => ({
  versao: "teste", aprovada: false,
  linhas: ["R01", "D01", "C01", "C08", "V01", "F01"].map((codigo) => ({ codigo, descricao: codigo, grupo: codigo[0] })),
  porCategoria: { INSUMO: { linha: "C01", criterio: "competencia" }, ENTREGA: { linha: "C08", criterio: "competencia" }, IMPOSTO: { linha: "D01", criterio: "caixa" },
    DIARIA: { linha: "V01", criterio: "caixa" }, SALARIO: { linha: "F01", criterio: "caixa" }, EMPRESTIMO: { linha: null, criterio: "fora" } },
  grupos: { receita: ["R01"], deducoes: ["D01"], cmv: ["C01"], entregas: ["C08"], variaveis: ["V01"], fixas: ["F01"] },
  fontes: { R01: "vendasBruto" }, ...o,
});
const dados = (o = {}) => ({
  vendas: { brutoCentavos: 100000 },
  obrigacoes: [
    { chave: "O1", categoria: "INSUMO", competencia: "2026-09", valorCentavos: 30000 },     // competência set: entra
    { chave: "O2", categoria: "INSUMO", competencia: "2026-08", valorCentavos: 9999 },      // competência ago: não entra em set
    { chave: "O3", categoria: "ENTREGA", competencia: "2026-09", valorCentavos: 4000 },     // rateada: só pelos rateios
    { chave: "O4", categoria: "SALARIO", competencia: "2026-08", valorCentavos: 20000 },    // caixa: entra pelo pagamento
    { chave: "O5", categoria: "EMPRESTIMO", competencia: "2026-09", valorCentavos: 7000 },  // fora do DRE
    { chave: "O6", categoria: "INSUMO", competencia: "2026-09", valorCentavos: 500, status: "cancelada" },
  ],
  pagamentos: [
    { chave: "P1", obrigacaoChave: "O4", categoria: "SALARIO", data: "2026-09-05", valorCentavos: 20000 },
    { chave: "P2", obrigacaoChave: "O1", categoria: "INSUMO", data: "2026-10-02", valorCentavos: 30000 },   // competência: pagamento não entra
    { chave: "P3", obrigacaoChave: "X", categoria: "IMPOSTO", data: "2026-09-20", valorCentavos: 5000 },
    { chave: "P4", obrigacaoChave: "X", categoria: "DIARIA", data: "2026-08-31", valorCentavos: 777 },      // caixa de agosto: fora de set
    { chave: "P5", obrigacaoChave: "O5", categoria: "EMPRESTIMO", data: "2026-09-10", valorCentavos: 7000 },
  ],
  rateios: [{ obrigacaoChave: "O3", categoria: "ENTREGA", competencia: "2026-09", valorCentavos: 2500 }, { obrigacaoChave: "O3", categoria: "ENTREGA", competencia: "2026-10", valorCentavos: 1500 }],
  parcelasDividaCentavos: null, ...o,
});
const linha = (r, c) => r.linhas.find((l) => l.codigo === c).centavos;

test("critério misto: competência pelo valor original, caixa pelo pagamento do mês, rateio pela parcela do mês, fora não entra", () => {
  const r = montarDreReferencia({ mes: "2026-09", regras: regras(), dados: dados() });
  assert.equal(linha(r, "C01"), 30000); assert.equal(linha(r, "C08"), 2500); assert.equal(linha(r, "F01"), 20000);
  assert.equal(linha(r, "D01"), 5000); assert.equal(linha(r, "V01"), 0); assert.equal(linha(r, "R01"), 100000);
});

test("indicadores pelas fórmulas da referência e PE arredondado só no fim", () => {
  const { indicadores: i } = montarDreReferencia({ mes: "2026-09", regras: regras(), dados: dados() });
  assert.equal(i.faturamentoLiquido, 95000); assert.equal(i.custosTotais, 32500); assert.equal(i.margemContribuicao, 62500);
  assert.equal(i.resultadoGerencial, 42500); assert.equal(i.margemContribuicaoBps, 6250); assert.equal(i.pontoEquilibrio, 32000);
  assert.equal(i.pontoEquilibrioFinanceiro, null, "sem cadastro de dívidas o PE financeiro é indisponível, nunca zero");
});

test("rastreabilidade: cada linha guarda a origem de cada parcela", () => {
  const r = montarDreReferencia({ mes: "2026-09", regras: regras(), dados: dados() });
  assert.deepEqual(r.linhas.find((l) => l.codigo === "C08").origens.map((o) => [o.tipo, o.id, o.centavos]), [["rateio", "O3", 2500]]);
});

test("categoria sem regra e regras não aprovadas deixam o resultado PARCIAL (nada é adivinhado)", () => {
  const r = montarDreReferencia({ mes: "2026-09", regras: regras(), dados: dados({ pagamentos: [{ chave: "P9", categoria: "NOVA", data: "2026-09-01", valorCentavos: 1 }] }) });
  assert.deepEqual(r.pendencias.categoriasSemRegra, { NOVA: 1 }); assert.equal(r.pendencias.parcial, true); assert.equal(r.regrasAprovadas, false);
  const ok = montarDreReferencia({ mes: "2026-09", regras: regras({ aprovada: true }), dados: dados() });
  assert.equal(ok.pendencias.parcial, false);
});

test("trocar o critério é só parâmetro: insumo por caixa passa a usar o pagamento", () => {
  const r = montarDreReferencia({ mes: "2026-10", regras: regras({ porCategoria: { ...regras().porCategoria, INSUMO: { linha: "C01", criterio: "caixa" } } }), dados: dados() });
  assert.equal(linha(r, "C01"), 30000); assert.equal(linha(r, "C08"), 1500);
});

// ---- importador: complemento de fornecedores, competência, rateios ----
const central = { obrigacoes: [{ id: "CP-1", linha: 2, fornecedor: "", descricao: "x", categoria: "Insumos", competencia: "2026-09", vencimento: "2026-09-10", valorPrevistoCentavos: 100,
  jurosCentavos: 0, multaCentavos: 0, descontoCentavos: 0, valorPagoCentavos: 0, status: "", cancelado: false, tipoRegistro: "Obrigação" }],
  pagamentos: [], movimentos: [], fluxo: [], saldos: [], rateios: [{ id: "R1", obrigacaoId: "CP-1", competencia: "2026-09", valorCentavos: 100, criterio: "Dias" }] };
const sistema = { contas: [], categorias: [{ id: "k", nome: "INSUMOS", tipo: "CUSTO" }], fornecedores: [], lancamentos: [], obrigacoes: [], pagamentos: [] };
const dp = { contas: {}, categorias: { Insumos: "INSUMOS" } };

test("importador: fornecedor do complemento da contadora (sem alterar a Central) e pendência registrada", () => {
  const p = planejarImportacaoCentral({ central, sistema, dePara: { ...dp, fornecedoresPorId: { "CP-1": "Fornecedor Identificado" } } });
  assert.equal(p.obrigacoes[0].situacao, "nova"); assert.equal(p.obrigacoes[0].fornecedor, "Fornecedor Identificado");
  assert.match(p.obrigacoes[0].pendencias.join(), /complemento/);
});

test("importador: resumo por competência e rateios relatados (nunca descartados em silêncio)", () => {
  const p = planejarImportacaoCentral({ central, sistema, dePara: dp });
  assert.deepEqual(p.porCompetencia["2026-09"], { obrigacoes: 1, valorOriginalCentavos: 100, bloqueadas: 1 });
  assert.equal(p.rateiosNaoImportados.length, 1); assert.equal(p.resumo.rateiosNaoImportados, 1);
});
