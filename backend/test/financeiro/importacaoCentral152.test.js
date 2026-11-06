// Planejador dos complementos da Central (migration 152). Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planejarComplementos } from "../../src/financeiro-calculos/importacaoCentral152.js";

const sistema = (o = {}) => ({ obrigacoesPorChave: new Map([["central:CP:CP-1", { id: "o1", valorCentavos: 10000 }]]), rateiosChaves: new Set(), dividasChaves: new Set(), eventosChaves: new Set(),
  recebiveisChaves: new Set(), lancamentosChaves: new Set(), contas: [{ id: "k1", nome: "BANCO" }, { id: "k2", nome: "CAIXA" }], categoriaTransferenciaId: "ct",
  entradasSemPar: [{ id: "e1", conta: "BANCO", data: "2026-09-04", valorCentavos: 3000 }], entradas: [{ id: "e9", conta: "BANCO", data: "2026-09-02", valorCentavos: 700 }], ...o });
const dePara = { contas: { "Banco A": "BANCO", "Caixa": "CAIXA" }, mesmoFato: [{ recebivel: "C2", divida: "D2" }] };
const central = (o = {}) => ({
  rateios: [{ id: "R1", obrigacaoId: "CP-1", competencia: "2026-08", valorCentavos: 6000, criterio: "Dias de consumo" }, { id: "R2", obrigacaoId: "CP-1", competencia: "2026-09", valorCentavos: 4000, criterio: "Dias de consumo" }],
  dividas: [{ id: "D1", credor: "Banco X", tipo: "1. Dívida própria - bancária", valorOriginalCentavos: null, entraPe: true, saldoCentavos: null, situacao: "Em dia", fonte: "slide", observacao: "" },
    { id: "D2", credor: "Terceiro", tipo: "4. Retenção de obrigação de terceiros", entraPe: false, saldoCentavos: 500, situacao: "A receber", fonte: "", observacao: "" }],
  eventosDivida: [{ id: "E1", dividaId: "D1", data: "2026-09-10", tipo: "Amortização", valorCentavos: 1500, idMovimento: "M9", observacao: "" },
    { id: "E2", dividaId: "D2", data: "2026-09-02", tipo: "Reembolso", valorCentavos: 700, idMovimento: "M8", observacao: "" }],
  recebiveis: [{ id: "C1", tipo: "Venda (consolidado mensal)", origem: "vendas", canal: "Todos", competencia: "2026-09", valorPrevistoCentavos: 999, valorRecebidoCentavos: 0 },
    { id: "C2", tipo: "Recebível", origem: "Reembolso da empresa parceira", canal: "Parceira", competencia: "2026-09", previsao: "2026-10-02", valorPrevistoCentavos: 1200, valorRecebidoCentavos: 700, contaDestino: "Banco A", status: "Parcial" }],
  movimentos: [{ id: "M1", conta: "Caixa", data: "2026-09-04", entradaCentavos: 0, saidaCentavos: 3000, refFluxo: "", categoria: "Transferência interna", parTransferencia: "TRF-1", descricao: "caixa para o banco" },
    { id: "M2", conta: "Banco A", data: "2026-09-04", entradaCentavos: 3000, saidaCentavos: 0, refFluxo: "FX-9", categoria: "Transferência interna", parTransferencia: "TRF-1", descricao: "" },
    { id: "M8", conta: "Banco A", data: "2026-09-02", entradaCentavos: 700, saidaCentavos: 0, refFluxo: "FX-8", categoria: "", parTransferencia: "", descricao: "" }],
  ...o,
});

test("rateio: uma definição por obrigação, Σ linhas = elegível, chave de origem, PROPOSTO (provisório)", () => {
  const p = planejarComplementos({ central: central(), sistema: sistema(), dePara });
  assert.equal(p.rateios.length, 1);
  assert.deepEqual([p.rateios[0].situacao, p.rateios[0].valorElegivelCentavos, p.rateios[0].criterio, p.rateios[0].chave], ["novo", 10000, "dias_consumo", "central:RAT:CP-1"]);
  assert.match(p.rateios[0].justificativa, /PROVISÓRIA/);
});
test("rateio bloqueado se a obrigação não foi importada ou se Σ passa do original", () => {
  assert.equal(planejarComplementos({ central: central(), sistema: sistema({ obrigacoesPorChave: new Map() }), dePara }).rateios[0].situacao, "bloqueado");
  const c = central({ rateios: [{ id: "R1", obrigacaoId: "CP-1", competencia: "2026-09", valorCentavos: 10001, criterio: "x" }] });
  assert.match(planejarComplementos({ central: c, sistema: sistema(), dePara }).rateios[0].motivos.join(), /acima do valor original/);
});
test("recebível consolidado de vendas NÃO vira conta a receber (duplicaria faturamento/recebimentos)", () => {
  const p = planejarComplementos({ central: central(), sistema: sistema(), dePara });
  assert.deepEqual(p.recebiveis.map((r) => r.id), ["C2"]);
  assert.ok(p.fora.some((f) => f.id === "C1"));
});
test("dívida declarada como MESMO FATO do recebível: vira recebível (não dívida) e os reembolsos viram recebimentos conciliados", () => {
  const p = planejarComplementos({ central: central(), sistema: sistema(), dePara });
  assert.ok(!p.dividas.some((d) => d.id === "D2")); assert.ok(p.fora.some((f) => f.id === "D2"));
  assert.deepEqual(p.recebiveis[0].recebimentos.map((x) => [x.valorCentavos, x.lancamentoId]), [[700, "e9"]]);
  assert.equal(p.recebiveis[0].situacao, "novo");
});
test("dívida com valor/saldo desconhecidos fica nula (nunca zero) e com pendência; evento de amortização marca principal/juros não separados", () => {
  const p = planejarComplementos({ central: central(), sistema: sistema(), dePara });
  const d = p.dividas[0];
  assert.deepEqual([d.natureza, d.valorOriginalCentavos, d.saldoInformadoCentavos], ["propria", null, null]);
  assert.match(d.pendencia, /não informado|N\/D/);
  assert.equal(p.eventos[0].principalCentavos, 1500); assert.match(p.eventos[0].observacao, /NÃO separados/);
});
test("perna de transferência ausente no caixa: casada 1:1 com a entrada sem par já existente; repetir não duplica", () => {
  const p = planejarComplementos({ central: central(), sistema: sistema(), dePara });
  assert.deepEqual([p.pernas[0].situacao, p.pernas[0].entradaId, p.pernas[0].contaId], ["novo", "e1", "k2"]);
  const q = planejarComplementos({ central: central(), sistema: sistema({ lancamentosChaves: new Set(["central:MOV:M1"]), entradasSemPar: [] }), dePara });
  assert.equal(q.pernas[0].situacao, "existente");
});
test("perna sem entrada correspondente no sistema fica BLOQUEADA (nada é criado sem par)", () => {
  const p = planejarComplementos({ central: central(), sistema: sistema({ entradasSemPar: [] }), dePara });
  assert.equal(p.pernas[0].situacao, "bloqueado"); assert.match(p.pernas[0].motivos.join(), /não encontrada/);
});
