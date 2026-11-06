// Saldo de abertura negativo (conta devedora) não pode quebrar os relatórios nem inverter o sinal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { aberturasComoLancamentos } from "../../src/financeiro-calculos/relatorios.js";
import { apurar, saldosPorConta } from "../../src/financeiro-calculos/motor.js";

const ab = [{ conta_id: "A", data_referencia: "2026-09-01", valor_centavos: 10000 }, { conta_id: "B", data_referencia: "2026-09-01", valor_centavos: -52433 }];
const mov = [{ id: "m1", contaId: "B", sentido: "entrada", valorCentavos: 52434, papel: "receita_operacional", status: "realizado" }];

test("abertura negativa vira 'saída' do saldo anterior com valor absoluto (motor aceita)", () => {
  const ls = aberturasComoLancamentos(ab, "2026-09-01", "2026-09-30");
  assert.deepEqual(ls.map((l) => [l.sentido, l.valorCentavos]), [["entrada", 10000], ["saida", 52433]]);
  const r = apurar([...mov, ...ls]);
  assert.equal(r.saldoAnterior, 10000 - 52433);
  assert.equal(r.variacaoCaixa, 52434);              // a abertura não entra na variação
  assert.equal(r.saldoFinal, 10000 - 52433 + 52434);
});

test("saldos por conta com abertura negativa", () => {
  const s = saldosPorConta([{ id: "A", nome: "A" }, { id: "B", nome: "B" }], { A: 10000, B: -52433 }, mov);
  assert.equal(s.contas.find((c) => c.contaId === "B").saldoCentavos, 1);
  assert.equal(s.totalCentavos, 10001);
});
