// ifoodFinancial.mapper.js — normalização PURA da API Settlements. Sem rede,
// sem banco. `settlements[]` é uma UNIÃO de dois formatos confirmada no
// exemplo real do Swagger (título avulso x período/closingItems) — ver
// ifood.constants.js#IFOOD_ROTAS.financialSettlements.
import { test } from "node:test";
import assert from "node:assert/strict";

const { mapearRespostaSettlements } = await import("../src/modules/ifood/ifoodFinancial.mapper.js");

const TITULO_AVULSO_COM_CONTA = {
  id: "20112085", type: "REGISTRO_RECEBIVEIS", amount: 80, status: "SUCCEED",
  transactionId: "202401020000073669180",
  accountDetails: { bankName: "MONEY PLUS LTDA", bankNumber: "2XX", branchCode: "00XX", accountNumber: "15XXXX", documentNumber: "305XXXXXXXXXXXX" },
  paymentDate: "2024-01-03",
};

const TITULO_AVULSO_SEM_CONTA_DEBITO = {
  id: "93032070", type: "BOLETO", amount: -10, status: "SUCCEED", accountDetails: {}, paymentDate: "2024-02-28",
};

const GRUPO_PERIODO = {
  startDateCalculation: "2024-01-22", endDateCalculation: "2024-01-28",
  closingItems: [
    {
      id: "92559065", type: "REPASSE", product: "IFOOD", amount: 120.3, status: "SUCCEED",
      transactionId: "CAEA1DC15AD05E05243BA5D",
      accountDetails: { bankName: "BANCO DO BRASIL S.A.", bankNumber: "0XX", branchCode: "12XX", branchDigit: "X", accountNumber: "99XXX", accountDigit: "X", documentNumber: "4781XXXXXXXXXXXX" },
      paymentDate: "2024-01-31",
    },
    {
      id: "92702874", type: "REPASSE", product: "IFOOD", amount: 179.94, status: "SUCCEED",
      transactionId: "202401300000274801577",
      accountDetails: { bankName: "BANCO DO BRASIL S.A.", bankNumber: "0XX", branchCode: "12XX", branchDigit: "6", accountNumber: "99XXX", accountDigit: "8", documentNumber: "4781XXXXXXXXXXXX" },
      paymentDate: "2024-01-31",
    },
  ],
};

const ENVELOPE_OBJETO = {
  beginDate: "2024-01-01", endDate: "2024-01-31", balance: 999.4,
  merchantId: "0a6ebafb-5dc1-470e-924f-f8e67b7c87d8",
  settlements: [TITULO_AVULSO_COM_CONTA, TITULO_AVULSO_SEM_CONTA_DEBITO, GRUPO_PERIODO],
  consolidatedMerchants: ["63bcd1f2-832b-43b4-8aa1-c6db708b01cc"],
};

test("envelope OBJETO é mapeado corretamente", () => {
  const r = mapearRespostaSettlements(ENVELOPE_OBJETO);
  assert.equal(r.periodo.inicio, "2024-01-01");
  assert.equal(r.periodo.fim, "2024-01-31");
  assert.equal(r.saldo, 999.4);
  assert.deepEqual(r.merchantsConsolidados, ["63bcd1f2-832b-43b4-8aa1-c6db708b01cc"]);
});

test("envelope ARRAY (Referência de API) é mapeado IGUAL ao objeto", () => {
  const rArray = mapearRespostaSettlements([ENVELOPE_OBJETO]);
  const rObjeto = mapearRespostaSettlements(ENVELOPE_OBJETO);
  assert.deepEqual(rArray, rObjeto);
});

test("achata título avulso + grupo de período em UMA lista de títulos (2 avulsos + 2 do grupo = 4)", () => {
  const r = mapearRespostaSettlements(ENVELOPE_OBJETO);
  assert.equal(r.titulos.length, 4);
});

test("título avulso: periodoApuracao é null (não veio de um grupo)", () => {
  const r = mapearRespostaSettlements(ENVELOPE_OBJETO);
  const t = r.titulos.find((x) => x.id === "20112085");
  assert.equal(t.periodoApuracao, null);
  assert.equal(t.produto, null); // só closingItems tem `product`
});

test("item de closingItems: periodoApuracao vem do grupo (startDateCalculation/endDateCalculation)", () => {
  const r = mapearRespostaSettlements(ENVELOPE_OBJETO);
  const t = r.titulos.find((x) => x.id === "92559065");
  assert.deepEqual(t.periodoApuracao, { inicio: "2024-01-22", fim: "2024-01-28" });
  assert.equal(t.produto, "IFOOD");
});

test("valor negativo (débito, ex. BOLETO) é preservado com o sinal", () => {
  const r = mapearRespostaSettlements(ENVELOPE_OBJETO);
  const t = r.titulos.find((x) => x.id === "93032070");
  assert.equal(t.valor, -10);
});

test("accountDetails vazio ({}) vira contaBancaria: null", () => {
  const r = mapearRespostaSettlements(ENVELOPE_OBJETO);
  const t = r.titulos.find((x) => x.id === "93032070");
  assert.equal(t.contaBancaria, null);
});

test("accountDetails preenchido mapeia banco/agência/conta/documento — incluindo branchDigit/documentNumber (fora do glossário genérico do guia)", () => {
  const r = mapearRespostaSettlements(ENVELOPE_OBJETO);
  const t = r.titulos.find((x) => x.id === "92559065");
  assert.deepEqual(t.contaBancaria, {
    banco: "BANCO DO BRASIL S.A.", numeroBanco: "0XX", agencia: "12XX", digitoAgencia: "X",
    conta: "99XXX", digitoConta: "X", documento: "4781XXXXXXXXXXXX",
  });
});

test("sem paginação: a forma normalizada não tem campo `pagina`", () => {
  const r = mapearRespostaSettlements(ENVELOPE_OBJETO);
  assert.equal("pagina" in r, false);
});

test("0 resultados: settlements ausente ou vazio -> titulos:[], sem lançar", () => {
  const r = mapearRespostaSettlements({ beginDate: "2024-01-01", endDate: "2024-01-31", balance: 0, merchantId: "m1" });
  assert.deepEqual(r.titulos, []);
  assert.equal(r.saldo, 0);
});

test("consolidatedMerchants ausente -> merchantsConsolidados: []", () => {
  const r = mapearRespostaSettlements({ beginDate: "2024-01-01", endDate: "2024-01-31", balance: 0 });
  assert.deepEqual(r.merchantsConsolidados, []);
});
