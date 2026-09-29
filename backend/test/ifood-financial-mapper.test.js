// ifoodFinancial.mapper.js — normalização PURA da API Sales. Sem rede, sem
// banco. Cobre as duas formas de envelope confirmadas na auditoria (ver
// ifood.constants.js#IFOOD_ROTAS.financialSales).
import { test } from "node:test";
import assert from "node:assert/strict";

const { mapearRespostaSales, mapearVenda } = await import("../src/modules/ifood/ifoodFinancial.mapper.js");

const VENDA_MINIMA = {
  id: "sale-1", shortId: "123", createdAt: "2025-03-06T20:28:45.876Z",
  type: "ORDER", category: "FOOD", salesChannel: "IFOOD", currentStatus: "CONCLUDED",
  merchant: { id: "m-1", shortId: 456, name: "Loja Teste", type: "RESTAURANT", timezone: "Etc/GMT+3", documents: [{ value: "99999999999999", type: "CNPJ" }] },
  saleGrossValue: { bag: 100, deliveryFee: 10, serviceFee: -1 },
  billingSummary: { saleBalance: 91, billingEntries: [{ name: "ORDER_PAYMENT", value: 100 }, { name: "ORDER_COMMISSION", value: -9 }] },
  orderEvents: [{ id: "ev-1", fullCode: "FINANCIAL_BILLED_ORDER_ENTRY", code: "FBOE", createdAt: "2025-03-06T21:00:00Z", metadata: { entries: [{ amount: 91 }] } }],
};

const ENVELOPE_OBJETO = {
  page: 1, size: 1, beginSalesDate: "2025-03-06", endSalesDate: "2025-03-06",
  sales: [VENDA_MINIMA], total: 1, pageCount: 1,
};

test("envelope OBJETO (forma do guia narrativo) é mapeado corretamente", () => {
  const r = mapearRespostaSales(ENVELOPE_OBJETO);
  assert.equal(r.periodo.inicio, "2025-03-06");
  assert.equal(r.periodo.fim, "2025-03-06");
  assert.equal(r.pagina.atual, 1);
  assert.equal(r.pagina.total, 1);
  assert.equal(r.pagina.totalPaginas, 1);
  assert.equal(r.vendas.length, 1);
  assert.equal(r.vendas[0].id, "sale-1");
});

test("envelope ARRAY (forma da Referência de API/Swagger) é mapeado IGUAL ao objeto", () => {
  const comoArray = [ENVELOPE_OBJETO];
  const rArray = mapearRespostaSales(comoArray);
  const rObjeto = mapearRespostaSales(ENVELOPE_OBJETO);
  assert.deepEqual(rArray, rObjeto);
});

test("0 resultados: sales ausente ou vazio -> vendas:[] e totais 0, sem lançar", () => {
  const semSales = mapearRespostaSales({ page: 1, beginSalesDate: "2025-01-01", endSalesDate: "2025-01-01", total: 0, pageCount: 0 });
  assert.deepEqual(semSales.vendas, []);
  assert.equal(semSales.pagina.total, 0);

  const arrayVazio = mapearRespostaSales({ page: 1, sales: [], total: 0, pageCount: 0, beginSalesDate: "2025-01-01", endSalesDate: "2025-01-01" });
  assert.deepEqual(arrayVazio.vendas, []);
});

test("billingEntries: valor negativo vira 'debito', valor positivo vira 'credito'", () => {
  const v = mapearVenda(VENDA_MINIMA);
  const porNome = Object.fromEntries(v.resumoFinanceiro.lancamentos.map((l) => [l.nome, l.tipo]));
  assert.equal(porNome.ORDER_PAYMENT, "credito");
  assert.equal(porNome.ORDER_COMMISSION, "debito");
});

test("saleGrossValue.total = itens + entrega + taxaServico (explicável, sem número mágico)", () => {
  const v = mapearVenda(VENDA_MINIMA);
  assert.equal(v.valorBruto.itens, 100);
  assert.equal(v.valorBruto.entrega, 10);
  assert.equal(v.valorBruto.taxaServico, -1);
  assert.equal(v.valorBruto.total, 109);
});

test("merchant.documents (plural, forma real) NUNCA é mapeado — CPF/CNPJ não saem do mapper", () => {
  const v = mapearVenda(VENDA_MINIMA);
  assert.equal("documentos" in v.merchant, false);
  assert.ok(!JSON.stringify(v).includes("99999999999999"));
  assert.deepEqual(v.merchant, { id: "m-1", shortId: 456, nome: "Loja Teste", tipo: "RESTAURANT", timezone: "Etc/GMT+3" });
});

test("merchant.document (singular, forma da tabela de referência) também NUNCA é mapeado", () => {
  const venda = { ...VENDA_MINIMA, merchant: { ...VENDA_MINIMA.merchant, documents: undefined, document: [{ value: "11111111111", type: "CPF" }] } };
  const v = mapearVenda(venda);
  assert.ok(!JSON.stringify(v).includes("11111111111"));
  assert.ok(!/document/i.test(JSON.stringify(v)));
});

test("benefits ausente -> beneficios null, sem lançar", () => {
  const v = mapearVenda(VENDA_MINIMA);
  assert.equal(v.beneficios, null);
});

test("orderEvents.metadata aninhado (refund/payout) é preservado sem achatar", () => {
  const v = mapearVenda(VENDA_MINIMA);
  assert.deepEqual(v.eventos[0].detalhe, { entries: [{ amount: 91 }] });
  assert.equal(v.eventos[0].codigoCompleto, "FINANCIAL_BILLED_ORDER_ENTRY");
});

test("mapearVenda nunca lança com objeto vazio (defensivo campo a campo)", () => {
  const v = mapearVenda({});
  assert.equal(v.id, null);
  assert.deepEqual(v.pagamentos, []);
  assert.deepEqual(v.eventos, []);
  assert.deepEqual(v.historicoStatus, []);
  assert.equal(v.resumoFinanceiro, null);
  assert.equal(v.entrega, null);
});
