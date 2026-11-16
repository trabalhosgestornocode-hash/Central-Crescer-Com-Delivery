// Importação de relatório Food Delivery por unidade: o relatório da Foody é ÚNICO para as lojas que dividem a conta
// (Subway Saci + Açaí no Grau). Cada unidade só concilia/calcula os PRÓPRIOS pedidos; a Subway segue byte a byte igual.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { regrasParaOperacao } from "../src/modules/parser-food-delivery/parserFoodDelivery.service.js";
import { classificarOperacao } from "../src/modules/parser-food-delivery/parserFoodDelivery.operacao.js";

// Pedidos sintéticos no formato do relatório (operação decidida pelo MESMO classificador da importação).
const bruto = [
  { numeroPedido: "1", entregador: "Ana", situacao: "Entregue", detalhesPedido: "1x Sub Frango Teriyaki 15cm" },
  { numeroPedido: "2", entregador: "Bia", situacao: "Entregue", detalhesPedido: "1x Açaí 500ml com granola" },
  { numeroPedido: "3", entregador: "", situacao: "Entregue", detalhesPedido: "1x Açaí 300ml" },
  { numeroPedido: "4", entregador: "Caio", situacao: "Entregue", detalhesPedido: "" },
  { numeroPedido: "5", entregador: "Duda", situacao: "Entregue", detalhesPedido: "1x Açaí 700ml" },
];
const pedidos = bruto.map((p) => ({ ...p, operacao: classificarOperacao(p).operacao }));

describe("regras de filtragem por operação própria", () => {
  test("pré-condição: o classificador separa Subway, Açaí e indefinido", () => {
    assert.deepEqual(pedidos.map((p) => p.operacao), ["subway", "acai_no_grau", "acai_no_grau", "revisao_necessaria", "acai_no_grau"]);
  });

  test("Açaí no Grau: entram só os pedidos do Açaí com entregador", () => {
    const r = regrasParaOperacao("acai_no_grau");
    assert.deepEqual(pedidos.filter(r.elegivel).map((p) => p.numeroPedido), ["2", "5"]);
    assert.deepEqual(r.filtragem(pedidos), { subway: 2, semEntregador: 1, acaiNoGrau: 1, revisaoNecessaria: 1 });
    assert.deepEqual(r.extra, { operacaoPropria: "acai_no_grau" });
    const ign = pedidos.filter((p) => !r.elegivel(p)).map(r.ignorado);
    assert.equal(ign.find((p) => p.numeroPedido === "1").classificacaoIgnorado, "Subway Saci");
    assert.equal(ign.find((p) => p.numeroPedido === "3").classificacaoIgnorado, "Sem entregador");
  });

  test("Subway Saci: comportamento original (só Subway com entregador; resposta sem campo novo)", () => {
    const r = regrasParaOperacao("subway");
    assert.deepEqual(pedidos.filter(r.elegivel).map((p) => p.numeroPedido), ["1"]);
    assert.deepEqual(r.filtragem(pedidos), { subway: 1, semEntregador: 0, acaiNoGrau: 3, revisaoNecessaria: 1 });
    assert.deepEqual(r.extra, {});
  });
});
