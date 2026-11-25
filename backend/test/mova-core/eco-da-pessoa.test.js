// MOVA CORE — o número que a PESSOA escreveu pode ser repetido em frase neutra ou atribuída a ela; afirmar estado financeiro
// (em aberto, pago, saldo, valor da conta, gasto) com ele continua exigindo consulta oficial. Valores da proposta valem como "valor".
import { test } from "node:test";
import assert from "node:assert/strict";
import { fatosDaMensagem, verificarFidelidade } from "../../src/modules/mova-core/verificador.js";

test("EP-01 leitura dos números da mensagem: R$, inteiros e milhar; datas, anos e medidas ficam de fora", () => {
  assert.deepEqual(fatosDaMensagem("paguei 90 ontem, dia 24/11/2026, 500ml; e R$ 1.250,50 da conta; gastei 12 e voltaram 3").map((x) => x.valorCentavos).sort((a, b) => a - b), [300, 1200, 9000, 125050]);
  assert.ok(fatosDaMensagem("x 15").every((f) => f.significado === "PERGUNTA:informado"));
});

test("EP-02 repetir PASSA; afirmar estado financeiro com o número da pessoa BARRA (não confirma número errado sugerido)", () => {
  const ctx = { fatos: fatosDaMensagem("devemos 500 pro Atacadão né? paguei 90 ontem"), unidades: [] };
  for (const t of ["O valor de R$ 90,00 que você informou, certo?", "Entendi: R$ 90,00, ontem.", "Você disse R$ 500,00; vou conferir nas contas."]) assert.equal(verificarFidelidade(t, ctx).ok, true, t);
  for (const t of ["Sim, R$ 500,00 em aberto com o Atacadão.", "O saldo do Inter é R$ 90,00.", "Os R$ 90,00 já estão pagos.", "O valor da conta é R$ 500,00.", "Gastamos R$ 91,00."]) assert.equal(verificarFidelidade(t, ctx).ok, false, t);
});

test("EP-03 valor da PROPOSTA preparada vale como 'Valor:' / 'pago' na conferência do resumo", () => {
  const ctx = { fatos: [{ valorCentavos: 25900, significado: "PROPOSTA:valor", entidade: "Doce Brownie Ltda", periodo: null }], unidades: [] };
  assert.equal(verificarFidelidade("• Fornecedor: Doce Brownie Ltda • Valor: R$ 259,00 • Pago em 14/10", ctx).ok, true);
});
