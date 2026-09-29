// ifoodFinancial.mapper.js — normalização PURA da API Financial Events. Sem
// rede, sem banco. Cobre as duas formas de envelope (mesma divergência de
// Sales — ver ifood.constants.js#IFOOD_ROTAS.financialEvents) e os campos
// confirmados na Referência de API oficial.
import { test } from "node:test";
import assert from "node:assert/strict";

const { mapearRespostaFinancialEvents, mapearEventoFinanceiro } = await import("../src/modules/ifood/ifoodFinancial.mapper.js");

const EVENTO_CREDITO = {
  name: "ORDER_PAYMENT", description: "IN_APP_PAYMENT_CREDIT", product: "IFOOD", trigger: "SALE_CONCLUDED",
  dateTime: "2025-03-01T07:00:00Z", competence: "2025-03",
  period: { beginDate: "2025-03-01", endDate: "2025-03-02" },
  reference: { type: "ORDER", id: "order-1", date: "2025-03-01T22:07:10Z" },
  hasTransferImpact: true,
  amount: { value: "91" },
  billing: { baseValue: "91" },
  settlement: { expectedDate: "2025-03-26" },
  receiver: { businessId: "m-1", businessType: "MERCHANT", businessDocument: "00011122233344" },
  payment: { method: "PIX", liability: "MERCHANT" },
};

const EVENTO_DEBITO_SEM_IMPACTO = {
  name: "STORE_SUBSIDY", description: "BENEFIT_PARTNER", product: "IFOOD", trigger: "SALE_CONCLUDED",
  dateTime: "2025-03-01T07:00:00Z", competence: "2025-03",
  period: { beginDate: "2025-03-01", endDate: "2025-03-02" },
  reference: { type: "ORDER", id: "order-1", date: "2025-03-01T22:07:10Z" },
  hasTransferImpact: false,
  amount: { value: "-3.99" },
  billing: { baseValue: "-3.99" },
  settlement: { expectedDate: "2025-04-02" },
  receiver: { businessId: "m-1", businessType: "MERCHANT", businessDocument: "00011122233344" },
  payment: { method: "CREDIT", brand: "MASTERCARD", liability: "MERCHANT" },
};

const ENVELOPE_OBJETO = { page: 1, size: 100, hasNextPage: false, financialEvents: [EVENTO_CREDITO, EVENTO_DEBITO_SEM_IMPACTO] };

test("envelope OBJETO (guia) é mapeado corretamente", () => {
  const r = mapearRespostaFinancialEvents(ENVELOPE_OBJETO);
  assert.equal(r.pagina.atual, 1);
  assert.equal(r.pagina.tamanho, 100);
  assert.equal(r.pagina.temProximaPagina, false);
  assert.equal(r.eventos.length, 2);
});

test("envelope ARRAY (Referência de API) é mapeado IGUAL ao objeto", () => {
  const rArray = mapearRespostaFinancialEvents([ENVELOPE_OBJETO]);
  const rObjeto = mapearRespostaFinancialEvents(ENVELOPE_OBJETO);
  assert.deepEqual(rArray, rObjeto);
});

test("0 resultados: financialEvents ausente ou vazio -> eventos:[], sem lançar", () => {
  const semEventos = mapearRespostaFinancialEvents({ page: 1, size: 100, hasNextPage: false });
  assert.deepEqual(semEventos.eventos, []);
});

test("amount.value vem como STRING no JSON real — convertido para number", () => {
  const e = mapearEventoFinanceiro(EVENTO_CREDITO);
  assert.equal(typeof e.valor, "number");
  assert.equal(e.valor, 91);
});

test("valor positivo -> tipoValor 'credito'; negativo -> 'debito'", () => {
  const credito = mapearEventoFinanceiro(EVENTO_CREDITO);
  const debito = mapearEventoFinanceiro(EVENTO_DEBITO_SEM_IMPACTO);
  assert.equal(credito.tipoValor, "credito");
  assert.equal(debito.tipoValor, "debito");
});

test("hasTransferImpact=true é preservado como temImpactoRepasse", () => {
  const e = mapearEventoFinanceiro(EVENTO_CREDITO);
  assert.equal(e.temImpactoRepasse, true);
});

test("hasTransferImpact=false é preservado (caso especial: pedido pago direto na loja)", () => {
  const e = mapearEventoFinanceiro(EVENTO_DEBITO_SEM_IMPACTO);
  assert.equal(e.temImpactoRepasse, false);
});

test("receiver.businessId (forma real da API) é lido; businessDocument NUNCA é mapeado", () => {
  const e = mapearEventoFinanceiro(EVENTO_CREDITO);
  assert.deepEqual(e.comerciante, { id: "m-1", tipo: "MERCHANT" });
  assert.ok(!JSON.stringify(e).includes("00011122233344"));
});

test("receiver.merchantId (forma da tabela do guia) também é aceito; merchantDocument NUNCA é mapeado", () => {
  const e = mapearEventoFinanceiro({ ...EVENTO_CREDITO, receiver: { merchantId: "m-2", merchantDocument: "99999999999999" } });
  assert.deepEqual(e.comerciante, { id: "m-2", tipo: null });
  assert.ok(!JSON.stringify(e).includes("99999999999999"));
});

test("billing.baseValue/feePercentage também convertidos de string para number", () => {
  const e = mapearEventoFinanceiro({ ...EVENTO_CREDITO, billing: { baseValue: "96", feePercentage: "12" } });
  assert.equal(e.faturamento.valorBase, 96);
  assert.equal(e.faturamento.percentualTaxa, 12);
});

test("mapearEventoFinanceiro nunca lança com objeto vazio (defensivo campo a campo)", () => {
  const e = mapearEventoFinanceiro({});
  assert.equal(e.nome, null);
  assert.equal(e.valor, null);
  assert.equal(e.tipoValor, null);
  assert.equal(e.temImpactoRepasse, null, "ausente = desconhecido, nunca 'sem impacto'");
  assert.equal(e.comerciante, null);
  assert.equal(e.faturamento, null);
  assert.equal(e.pagamento, null);
});
