// Checklist Operacional — ORIGEM por loja (Sanduíches/Saladas) na tela. Funções puras, sem DOM.
//
// Rodar: node --test frontend/test/checklistOperacionalLojas.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

import { derivarPedidoAtivo, METAS_EXEMPLO } from "../src/checklistOperacionalModelo.js";
import { linhaPedidoAtivo, painelUltimosPedidos, seloLoja } from "../src/checklistOperacionalVisual.js";
import { adaptarResumo } from "../src/checklistOperacionalDados.js";

const AGORA = Date.parse("2026-10-06T22:00:00Z");
const ha = (min) => new Date(AGORA - min * 60000).toISOString();
const ativo = (extra = {}) => derivarPedidoAtivo({ id: "d-1", displayId: "4531", recebidoEm: ha(5), status: "CONFIRMED", confirmadoEm: ha(4), ...extra }, METAS_EXEMPLO, AGORA);

test("sem `loja` (uma loja só): nada é desenhado — o HTML é idêntico ao de antes", () => {
  assert.equal(seloLoja({}), "");
  assert.equal(seloLoja(undefined), "");
  assert.equal(seloLoja({ loja: {} }), "");
  assert.doesNotMatch(linhaPedidoAtivo(ativo()), /cko-ped-loja|data-loja/);
  assert.doesNotMatch(painelUltimosPedidos({ ultimosPedidos: [{ id: "u", displayId: "1", recebidoEm: ha(9), status: "CONCLUDED", preparoMin: 8, entregaMin: 20, vidaMin: 30 }], metas: METAS_EXEMPLO }), /cko-ped-loja/);
});

test("com `loja`: a origem aparece no pedido em andamento e na tabela dos últimos pedidos", () => {
  const html = linhaPedidoAtivo(ativo({ loja: { rotulo: "Saladas" } }));
  assert.match(html, /<span class="cko-ped-loja" data-loja>Saladas<\/span>/);
  assert.ok(html.indexOf("#4531") < html.indexOf("Saladas") && html.indexOf("Saladas") < html.indexOf("Recebido"), "logo abaixo do número, antes do horário");
  const tabela = painelUltimosPedidos({ ultimosPedidos: [
    { id: "u1", displayId: "1", recebidoEm: ha(9), status: "CONCLUDED", preparoMin: 8, entregaMin: 20, vidaMin: 30, loja: { rotulo: "Sanduíches" } },
    { id: "u2", displayId: "2", recebidoEm: ha(8), status: "CONCLUDED", preparoMin: 9, entregaMin: 22, vidaMin: 31, loja: { rotulo: "Saladas" } },
  ], metas: METAS_EXEMPLO });
  assert.match(tabela, /#1<span class="cko-ped-loja" data-loja>Sanduíches<\/span>/);
  assert.match(tabela, /#2<span class="cko-ped-loja" data-loja>Saladas<\/span>/);
});

test("o rótulo é escapado (nada de HTML injetado a partir do nome da loja)", () => {
  const html = linhaPedidoAtivo(ativo({ loja: { rotulo: '<img src=x onerror="alert(1)">' } }));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("adaptarResumo repassa `lojas` (e vem vazio com uma loja só); os pedidos mantêm a origem", () => {
  const ctx = { unidade: { id: "u", nome: "Unidade" }, metas: METAS_EXEMPLO, recebidoEmMs: AGORA };
  const uma = adaptarResumo({ servidorEm: new Date(AGORA).toISOString(), integracao: { estado: "ao_vivo" }, pedidosAtivos: [], ultimosPedidos: [] }, ctx);
  assert.deepEqual(uma.lojas, []);
  const duas = adaptarResumo({
    servidorEm: new Date(AGORA).toISOString(), integracao: { estado: "ao_vivo" },
    pedidosAtivos: [{ id: "a", displayId: "1", status: "CONFIRMED", recebidoEm: ha(3), loja: { rotulo: "Saladas" } }], ultimosPedidos: [],
    lojas: [{ rotulo: "Sanduíches", principal: true, estado: "ativa", contagemDia: { recebidos: 3 } }, { rotulo: "Saladas", principal: false, estado: "ativa", contagemDia: { recebidos: 4 } }],
  }, ctx);
  assert.deepEqual(duas.lojas.map((l) => l.rotulo), ["Sanduíches", "Saladas"]);
  assert.equal(duas.pedidosAtivos[0].loja.rotulo, "Saladas");
});
