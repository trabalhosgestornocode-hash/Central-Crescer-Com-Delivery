// ifoodFinancial.mapper.js — normalização PURA da API Anticipation. Sem
// rede, sem banco. Mesmo envelope de Settlements, item de closingItems
// diferente — ver ifood.constants.js#IFOOD_ROTAS.financialAnticipations.
import { test } from "node:test";
import assert from "node:assert/strict";

const { mapearRespostaAnticipation } = await import("../src/modules/ifood/ifoodFinancial.mapper.js");

const GRUPO_SEMANAL = {
  startDateCalculation: "2024-01-22", endDateCalculation: "2024-01-28",
  closingItems: [
    {
      type: "REPASSE_ANTECIPADO_SEMANAL",
      originalPaymentAmount: 221.16, feePercentage: 1.49, feeAmount: 3.3, anticipatedPaymentAmount: 217.86,
      status: "SUCCEED",
      accountDetails: { bankName: "BANCO DO BRASIL S.A.", bankNumber: "032", branchCode: "001", branchDigit: null, accountNumber: "383826456", accountDigit: "6", documentNumber: null },
      originalPaymentDate: "2024-11-27", anticipatedPaymentDate: "2024-11-06",
    },
  ],
};

const ENVELOPE = {
  beginDate: "2024-01-01", endDate: "2024-01-31", balance: 999.4,
  merchantId: "0a6ebafb-5dc1-470e-924f-f8e67b7c87d8",
  settlements: [GRUPO_SEMANAL],
};

test("envelope OBJETO é mapeado corretamente", () => {
  const r = mapearRespostaAnticipation(ENVELOPE);
  assert.equal(r.periodo.inicio, "2024-01-01");
  assert.equal(r.periodo.fim, "2024-01-31");
  assert.equal(r.saldo, 999.4);
  assert.equal(r.antecipacoes.length, 1);
});

test("envelope ARRAY (Referência de API) é mapeado IGUAL ao objeto", () => {
  const rArray = mapearRespostaAnticipation([ENVELOPE]);
  const rObjeto = mapearRespostaAnticipation(ENVELOPE);
  assert.deepEqual(rArray, rObjeto);
});

test("type REPASSE_ANTECIPADO_SEMANAL preservado literalmente", () => {
  const r = mapearRespostaAnticipation(ENVELOPE);
  assert.equal(r.antecipacoes[0].tipo, "REPASSE_ANTECIPADO_SEMANAL");
});

test("type REPASSE_ANTECIPADO_DIARIO também é preservado (não hardcoded só pro semanal)", () => {
  const r = mapearRespostaAnticipation({ ...ENVELOPE, settlements: [{ ...GRUPO_SEMANAL, closingItems: [{ ...GRUPO_SEMANAL.closingItems[0], type: "REPASSE_ANTECIPADO_DIARIO" }] }] });
  assert.equal(r.antecipacoes[0].tipo, "REPASSE_ANTECIPADO_DIARIO");
});

test("valorOriginal, valorAntecipado e taxa mapeados corretamente", () => {
  const r = mapearRespostaAnticipation(ENVELOPE);
  const a = r.antecipacoes[0];
  assert.equal(a.valorOriginal, 221.16);
  assert.equal(a.valorAntecipado, 217.86);
  assert.deepEqual(a.taxa, { valor: 3.3, percentual: 1.49 });
});

test("valorAntecipado = valorOriginal - taxa.valor (explicável, sem número mágico)", () => {
  const r = mapearRespostaAnticipation(ENVELOPE);
  const a = r.antecipacoes[0];
  assert.ok(Math.abs(a.valorOriginal - a.taxa.valor - a.valorAntecipado) < 0.001);
});

test("as DUAS datas (original e antecipada) são mapeadas — não é só uma data como em Settlements", () => {
  const r = mapearRespostaAnticipation(ENVELOPE);
  const a = r.antecipacoes[0];
  assert.equal(a.dataPagamentoOriginal, "2024-11-27");
  assert.equal(a.dataPagamentoAntecipado, "2024-11-06");
});

test("periodoApuracao vem do grupo (startDateCalculation/endDateCalculation)", () => {
  const r = mapearRespostaAnticipation(ENVELOPE);
  assert.deepEqual(r.antecipacoes[0].periodoApuracao, { inicio: "2024-01-22", fim: "2024-01-28" });
});

test("status SUCCEED/FAILED/PENDING preservados literalmente", () => {
  for (const status of ["SUCCEED", "FAILED", "PENDING"]) {
    const r = mapearRespostaAnticipation({ ...ENVELOPE, settlements: [{ ...GRUPO_SEMANAL, closingItems: [{ ...GRUPO_SEMANAL.closingItems[0], status }] }] });
    assert.equal(r.antecipacoes[0].status, status);
  }
});

test("contaBancaria: mesmo shape de Settlements (banco/agência/conta/documento), campos null viram null", () => {
  const r = mapearRespostaAnticipation(ENVELOPE);
  assert.deepEqual(r.antecipacoes[0].contaBancaria, {
    banco: "BANCO DO BRASIL S.A.", numeroBanco: "032", agencia: "001", digitoAgencia: null,
    conta: "383826456", digitoConta: "6", documento: null,
  });
});

test("sem paginação: a forma normalizada não tem campo `pagina`", () => {
  const r = mapearRespostaAnticipation(ENVELOPE);
  assert.equal("pagina" in r, false);
});

test("0 resultados: settlements ausente ou vazio -> antecipacoes:[], sem lançar", () => {
  const r = mapearRespostaAnticipation({ beginDate: "2024-01-01", endDate: "2024-01-31", balance: 0 });
  assert.deepEqual(r.antecipacoes, []);
  assert.equal(r.saldo, 0);
});

test("item avulso (sem closingItems) também é aceito — periodoApuracao null", () => {
  const r = mapearRespostaAnticipation({ ...ENVELOPE, settlements: [GRUPO_SEMANAL.closingItems[0]] });
  assert.equal(r.antecipacoes.length, 1);
  assert.equal(r.antecipacoes[0].periodoApuracao, null);
});

test("nenhum campo de elegibilidade é inventado — só os campos confirmados no Swagger", () => {
  const r = mapearRespostaAnticipation(ENVELOPE);
  const chaves = Object.keys(r.antecipacoes[0]);
  assert.ok(!chaves.some((k) => /elegi|eligib/i.test(k)), "não deveria inventar campo de elegibilidade");
});
