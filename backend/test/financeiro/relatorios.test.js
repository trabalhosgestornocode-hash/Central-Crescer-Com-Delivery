import { test } from "node:test";
import assert from "node:assert/strict";
import { PAPEL } from "../../src/financeiro-calculos/planoContas.js";
import { paraEntradaMotor, aberturasComoLancamentos, montarDre, compararDres, rankingCategorias, serieMovimento, movimentoPorConta } from "../../src/financeiro-calculos/relatorios.js";
import { apurar } from "../../src/financeiro-calculos/motor.js";

// Sintético. Categorias: A receita, B/C custos, D fixa, E transferência.
const cats = new Map([
  ["A", { id: "A", nome: "VENDAS", papel: PAPEL.RECEITA_OPERACIONAL }], ["B", { id: "B", nome: "INSUMOS", papel: PAPEL.CUSTO_VARIAVEL }],
  ["C", { id: "C", nome: "FRETE", papel: PAPEL.CUSTO_VARIAVEL }], ["D", { id: "D", nome: "ALUGUEL", papel: PAPEL.DESPESA_FIXA }],
  ["E", { id: "E", nome: "ENTRE CONTAS", papel: PAPEL.TRANSFERENCIA }],
]);
let n = 0;
const L = (categoria_id, sentido, valor_centavos, data_movimento, conta_id = "c1", extra = {}) => ({ id: `l${++n}`, conta_id, categoria_id, sentido, valor_centavos, data_movimento, status: "realizado", ...extra });
const dados = () => [
  L("A", "entrada", 100000, "2026-09-01"), L("B", "saida", 30000, "2026-09-02"), L("C", "saida", 10000, "2026-09-02"),
  L("D", "saida", 20000, "2026-09-05"), L("E", "saida", 5000, "2026-09-06"), L("E", "entrada", 5000, "2026-09-06", "c2"),
];

test("DRE: totais conferem com o motor; detalhes aparecem e NÃO são somados de novo", () => {
  const ent = paraEntradaMotor(dados(), cats);
  const dre = montarDre(ent, cats);
  const l = (id) => dre.linhas.find((x) => x.id === id);
  assert.equal(l("receita").centavos, 100000);
  assert.equal(l("custos").centavos, 40000);
  assert.deepEqual(l("custos").detalhes.map((d) => [d.nome, d.centavos]), [["INSUMOS", 30000], ["FRETE", 10000]]);
  assert.equal(l("margem_contribuicao").centavos, 60000);
  assert.equal(l("resultado").centavos, 40000);
  assert.equal(l("margem_liquida").bps, 4000);
  assert.equal(l("custos").percentualReceitaBps, 4000);
  assert.equal(l("resultado").centavos, apurar(ent).resultadoGerencial);
  // soma das linhas de total que compõem o resultado (sem os detalhes) = resultado
  const soma = l("receita").centavos - l("custos").centavos - l("desp_variaveis").centavos - l("tributos").centavos - l("desp_fixas").centavos - l("pessoal").centavos - l("desp_financeiras").centavos;
  assert.equal(soma, l("resultado").centavos);
  assert.equal(dre.regime.id, "caixa");
  assert.ok(dre.avisos[0].includes("não a venda bruta"));
});

test("DRE: transferência interna pareada não altera resultado", () => {
  const sem = montarDre(paraEntradaMotor(dados().filter((x) => x.categoria_id !== "E"), cats), cats);
  const com = montarDre(paraEntradaMotor(dados(), cats), cats);
  assert.equal(com.linhas.find((x) => x.id === "resultado").centavos, sem.linhas.find((x) => x.id === "resultado").centavos);
});

test("DRE: lançamento sem categoria deixa a DRE parcial e é avisado", () => {
  const dre = montarDre(paraEntradaMotor([...dados(), L(null, "saida", 999, "2026-09-07", "c1", { classificacao_pendente: true })], cats), cats);
  assert.equal(dre.parcial, true);
  assert.ok(dre.avisos.some((a) => /sem classificação/.test(a)));
});

test("DRE: sem receita a margem líquida é indisponível (null), não zero", () => {
  const dre = montarDre(paraEntradaMotor([L("D", "saida", 100, "2026-09-01")], cats), cats);
  assert.equal(dre.linhas.find((x) => x.id === "margem_liquida").bps, null);
  assert.equal(dre.linhas.find((x) => x.id === "receita").percentualReceitaBps, null);
});

test("comparação entre períodos: delta absoluto e percentual só com base não-zero", () => {
  const a = montarDre(paraEntradaMotor(dados(), cats), cats);
  const b = montarDre(paraEntradaMotor([L("A", "entrada", 50000, "2026-08-01"), L("D", "saida", 20000, "2026-08-02")], cats), cats);
  const c = compararDres(a, b);
  const rec = c.find((x) => x.id === "receita");
  assert.equal(rec.delta, 50000);
  assert.equal(rec.deltaBps, 10000); // +100%
  const custos = c.find((x) => x.id === "custos");
  assert.equal(custos.anterior, 0);
  assert.equal(custos.deltaBps, null);
  assert.equal(c.find((x) => x.id === "margem_liquida").deltaPontosBps, 4000 - (b.linhas.find((x) => x.id === "margem_liquida").bps));
});

test("ranking de categorias: ordem decrescente, participação e acumulada", () => {
  const r = rankingCategorias(paraEntradaMotor(dados(), cats), cats);
  assert.deepEqual(r.itens.map((i) => i.nome), ["INSUMOS", "ALUGUEL", "FRETE"]);
  assert.equal(r.totalCentavos, 60000);
  assert.equal(r.itens[0].participacaoBps, 5000);
  assert.equal(r.itens.at(-1).acumuladaBps, 10000);
});

test("série e movimento por conta: excluem saldo anterior e separam transferências", () => {
  const ent = paraEntradaMotor(dados(), cats);
  const serie = serieMovimento(ent, { agrupar: "dia" });
  assert.deepEqual(serie.map((s) => s.periodo), ["2026-09-01", "2026-09-02", "2026-09-05"]); // 09-06 só tem transferência
  assert.equal(serieMovimento(ent, { agrupar: "mes" })[0].entradas, 100000);
  assert.equal(serieMovimento(ent, { agrupar: "mes", excluirTransferencias: false })[0].entradas, 105000);
  const m = movimentoPorConta(ent, [{ id: "c1", nome: "A" }, { id: "c2", nome: "B" }]);
  assert.equal(m[1].entradas, 5000);
  assert.equal(m[1].transferenciasEntrada, 5000);
  assert.equal(m[0].transferenciasSaida, 5000);
});

test("aberturas do período viram saldo anterior; fora do período não entram", () => {
  const ab = [{ conta_id: "c1", data_referencia: "2026-09-01", valor_centavos: 700 }, { conta_id: "c2", data_referencia: "2026-08-01", valor_centavos: 900 }];
  const ls = aberturasComoLancamentos(ab, "2026-09-01", "2026-09-30");
  assert.equal(ls.length, 1);
  const r = apurar([...paraEntradaMotor(dados(), cats), ...ls]);
  assert.equal(r.saldoAnterior, 700);
  assert.equal(r.saldoFinal, r.variacaoCaixa + 700);
});
