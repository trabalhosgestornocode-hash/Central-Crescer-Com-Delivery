// Bus de eventos do Realtime (frontend/src/realtime/realtimeBus.js).
//
// Cobre os itens da Etapa 1 que dizem respeito a ROTEAMENTO/DEDUPLICAÇÃO no
// frontend: "evento irrelevante não deve refazer fetch desnecessário" e
// "eventos duplicados não provocam múltiplos refetches".
//
// Rodar: node --test frontend/test/realtimeBus.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { registrarInteresse, receberEvento, _interessesAtivos, _resetParaTeste } =
  await import("../src/realtime/realtimeBus.js");

beforeEach(() => { _resetParaTeste(); });

describe("realtimeBus — registro e roteamento por tipo", () => {
  test("só chama quem está inscrito NAQUELE tipo de evento", () => {
    let chamouA = 0, chamouB = 0;
    registrarInteresse({ eventos: ["a.criado"], aoReceber: () => { chamouA++; } });
    registrarInteresse({ eventos: ["b.criado"], aoReceber: () => { chamouB++; } });

    receberEvento({ tipo: "a.criado", organizacaoId: "o1" });
    assert.equal(chamouA, 1);
    assert.equal(chamouB, 0);
  });

  test("sem lista de eventos (null), recebe qualquer tipo", () => {
    let chamadas = 0;
    registrarInteresse({ eventos: null, aoReceber: () => { chamadas++; } });
    receberEvento({ tipo: "qualquer.coisa", organizacaoId: "o1" });
    receberEvento({ tipo: "outra.coisa", organizacaoId: "o1", entidadeId: "x" });
    assert.equal(chamadas, 2);
  });

  test("evento irrelevante (relevante() = false) não chama aoReceber — módulo fechado não refaz fetch", () => {
    let chamou = false;
    registrarInteresse({
      eventos: ["dashboard_ifood.lancamento_atualizado"],
      relevante: () => false, // ex.: "minha tela não está aberta agora"
      aoReceber: () => { chamou = true; },
    });
    receberEvento({ tipo: "dashboard_ifood.lancamento_atualizado", organizacaoId: "o1", unidadeId: "u1" });
    assert.equal(chamou, false);
  });

  test("relevante() recebe o evento inteiro (pode filtrar por unidade/mês do módulo)", () => {
    let recebido = null;
    registrarInteresse({
      eventos: ["x.y"],
      relevante: (ev) => ev.unidadeId === "u-minha",
      aoReceber: (ev) => { recebido = ev; },
    });
    receberEvento({ tipo: "x.y", organizacaoId: "o1", unidadeId: "u-outra" });
    assert.equal(recebido, null);
    receberEvento({ tipo: "x.y", organizacaoId: "o1", unidadeId: "u-minha", entidadeId: "e1" });
    assert.equal(recebido?.entidadeId, "e1");
  });

  test("cancelar o registro (função devolvida) para de reagir", () => {
    let chamadas = 0;
    const cancelar = registrarInteresse({ eventos: ["x.y"], aoReceber: () => { chamadas++; } });
    receberEvento({ tipo: "x.y", organizacaoId: "o1", entidadeId: "1" });
    cancelar();
    receberEvento({ tipo: "x.y", organizacaoId: "o1", entidadeId: "2" });
    assert.equal(chamadas, 1);
    assert.equal(_interessesAtivos(), 0);
  });

  test("um interessado que lança não impede os outros de reagir", () => {
    let chamouSegundo = false;
    registrarInteresse({ eventos: ["x.y"], aoReceber: () => { throw new Error("boom"); } });
    registrarInteresse({ eventos: ["x.y"], aoReceber: () => { chamouSegundo = true; } });
    assert.doesNotThrow(() => receberEvento({ tipo: "x.y", organizacaoId: "o1", entidadeId: "1" }));
    assert.equal(chamouSegundo, true);
  });
});

describe("realtimeBus — deduplicação", () => {
  test("dois eventos idênticos (mesmo tipo/organizacao/unidade/entidade/versão) em sequência: só o primeiro dispara", () => {
    let chamadas = 0;
    registrarInteresse({ eventos: ["x.y"], aoReceber: () => { chamadas++; } });
    const evento = { tipo: "x.y", organizacaoId: "o1", unidadeId: "u1", entidadeId: "lanc-1", versao: "2026-09-13T10:00:00Z" };
    const a = receberEvento(evento);
    const b = receberEvento({ ...evento });
    assert.equal(a, true, "primeiro é aceito");
    assert.equal(b, false, "segundo é deduplicado");
    assert.equal(chamadas, 1);
  });

  test("mesma entidade com versão DIFERENTE não é deduplicada (é uma mudança nova de verdade)", () => {
    let chamadas = 0;
    registrarInteresse({ eventos: ["x.y"], aoReceber: () => { chamadas++; } });
    receberEvento({ tipo: "x.y", organizacaoId: "o1", unidadeId: "u1", entidadeId: "lanc-1", versao: "v1" });
    receberEvento({ tipo: "x.y", organizacaoId: "o1", unidadeId: "u1", entidadeId: "lanc-1", versao: "v2" });
    assert.equal(chamadas, 2);
  });

  test("entidades diferentes nunca se deduplicam entre si", () => {
    let chamadas = 0;
    registrarInteresse({ eventos: ["x.y"], aoReceber: () => { chamadas++; } });
    receberEvento({ tipo: "x.y", organizacaoId: "o1", unidadeId: "u1", entidadeId: "lanc-1" });
    receberEvento({ tipo: "x.y", organizacaoId: "o1", unidadeId: "u1", entidadeId: "lanc-2" });
    assert.equal(chamadas, 2);
  });
});
