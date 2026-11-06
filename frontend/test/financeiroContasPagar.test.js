import { test } from "node:test";
import assert from "node:assert/strict";
import { centavosDigitados, previaDiferenca, acoesDaConta, ACAO_FIN2, SITUACAO_CP } from "../src/financeiro/modeloContasPagar.js";

// Dados sintéticos.
test("valor digitado pt-BR vira centavos; vazio/inválido é ausente (nunca zero)", () => {
  assert.equal(centavosDigitados("832,41"), 83241);
  assert.equal(centavosDigitados("1.234,56"), 123456);
  assert.equal(centavosDigitados("832.41"), 83241);
  assert.equal(centavosDigitados("R$ 810"), 81000);
  for (const x of ["", null, "abc", "1,234"]) assert.equal(centavosDigitados(x), x === "1,234" ? 123400 : null);
});

test("prévia: exemplo homologado 810,00 → 832,41 quitada = R$ 22,41 e 2,77% presumido", () => {
  const p = previaDiferenca("810,00", "832,41", true);
  assert.equal(p.tipo, "acrescimo");
  assert.equal(p.difCentavos, 2241);
  assert.equal(p.bps, 277);
  assert.match(p.texto, /22,41/);
  assert.match(p.texto, /2,77%/);
  assert.match(p.texto, /presumido/);
});

test("prévia: sem confirmar quitação nada é classificado; parcial nunca é desconto", () => {
  const p = previaDiferenca("1500", "900", false);
  assert.equal(p.tipo, "parcial");
  assert.match(p.texto, /não desconto/);
});

test("prévia: soma com o que já foi pago (múltiplos pagamentos)", () => {
  assert.equal(previaDiferenca("2000", "800", true, 120000).tipo, "igual");
});

test("prévia: pago a menor e quitado fica 'a verificar'", () => {
  const p = previaDiferenca("640", "610", true);
  assert.equal(p.tipo, "a_menor");
  assert.match(p.texto, /a verificar/);
});

const conta = (extra = {}) => ({ status: "aberta", pagamentosAtivos: 1, provisoria: false, diferencaCentavos: null, ...extra });
const NIVEIS = {
  operador: [ACAO_FIN2.VER, ACAO_FIN2.LANCAR, ACAO_FIN2.EDITAR],
  gerente: [ACAO_FIN2.VER, ACAO_FIN2.LANCAR, ACAO_FIN2.EDITAR, ACAO_FIN2.CONCILIAR, ACAO_FIN2.CANCELAR, ACAO_FIN2.FECHAR],
  contadora: [ACAO_FIN2.VER, ACAO_FIN2.EDITAR, ACAO_FIN2.CONCILIAR, ACAO_FIN2.CLASSIFICAR, ACAO_FIN2.FECHAR],
  leitor: [ACAO_FIN2.VER],
};
test("ações por perfil: operador registra pagamento mas não quita nem classifica", () => {
  const a = acoesDaConta(conta(), NIVEIS.operador);
  assert.equal(a.pagamento, true); assert.equal(a.quitar, false); assert.equal(a.classificar, false);
});
test("ações por perfil: gerente quita e confirma provisório, mas não classifica", () => {
  assert.equal(acoesDaConta(conta(), NIVEIS.gerente).quitar, true);
  assert.equal(acoesDaConta(conta({ provisoria: true }), NIVEIS.gerente).confirmar, true);
  assert.equal(acoesDaConta(conta({ status: "quitada", diferencaCentavos: 2241 }), NIVEIS.gerente).classificar, false);
});
test("ações por perfil: contadora classifica diferença de conta quitada", () => {
  assert.equal(acoesDaConta(conta({ status: "quitada", diferencaCentavos: 2241 }), NIVEIS.contadora).classificar, true);
  assert.equal(acoesDaConta(conta({ status: "quitada", diferencaCentavos: 0 }), NIVEIS.contadora).classificar, false);
});
test("ações por perfil: leitor só consulta", () => {
  assert.deepEqual(Object.values(acoesDaConta(conta({ provisoria: true }), NIVEIS.leitor)).filter(Boolean), []);
});
test("despesa não é pintada de vermelho por ser despesa: só atraso/divergência", () => {
  assert.notEqual(SITUACAO_CP.a_vencer.tom, "bad");
  assert.notEqual(SITUACAO_CP.paga.tom, "bad");
  assert.equal(SITUACAO_CP.vencida.tom, "bad");
});
