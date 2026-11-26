// Rota do Painel Administrativo no hash (F5, link direto, várias abas). Rodar: node --test frontend/test/rotaPainelAdm.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { lerRota, montarRota, gravarRota, limparRota, podeRestaurarPainel } from "../src/rotaPainelAdm.js";

const ORG = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const AP = "11111111-0000-4000-8000-000000000001";

test("ida e volta: tela, perfil, aba, apresentação e slide", () => {
  for (const r of [{ tela: "relatorios" }, { tela: "nucleo-mentorados" }, { tela: "nucleo-mentorados", org: ORG, aba: "comparativo" },
    { tela: "nucleo-mentorados", org: ORG, aba: "apresentacoes", apresentacao: AP, slide: 7 }]) {
    const lido = lerRota(montarRota(r));
    assert.deepEqual(lido, { ...r, ...(r.org && !r.aba ? { aba: "visao" } : {}) });
  }
});

test("endereços que não são do painel ou malformados não abrem nada indevido", () => {
  assert.equal(lerRota(""), null);
  assert.equal(lerRota("#/outra-coisa"), null);
  assert.equal(lerRota("#/painel-admx"), null);
  assert.deepEqual(lerRota("#/painel-adm/<script>"), { tela: null });
  assert.deepEqual(lerRota("#/painel-adm/nucleo-mentorados/1 or 1=1/visao"), { tela: "nucleo-mentorados" });
  assert.deepEqual(lerRota(`#/painel-adm/nucleo-mentorados/${ORG}/aba-falsa`), { tela: "nucleo-mentorados", org: ORG, aba: "visao" });
  assert.equal(lerRota(`#/painel-adm/nucleo-mentorados/${ORG}/visao/apresentacao/${AP}/999`).slide, 1);
  assert.equal(lerRota("#/painel-adm/nucleo-mentorados/%E0%A4%A/visao").org, undefined);
});

test("gravar usa replaceState (sem poluir o histórico) e limpar remove só a rota do painel", () => {
  const chamadas = [];
  const loc = { hash: "", pathname: "/", search: "?x=1" };
  const hist = { state: null, replaceState: (_s, _t, url) => { chamadas.push(url); loc.hash = url.startsWith("#") ? url : ""; } };
  gravarRota({ tela: "nucleo-mentorados", org: ORG, aba: "historico" }, loc, hist);
  gravarRota({ tela: "nucleo-mentorados", org: ORG, aba: "historico" }, loc, hist);
  assert.equal(chamadas.length, 1, "não regrava o mesmo endereço");
  limparRota(loc, hist);
  assert.equal(chamadas.at(-1), "/?x=1");
  loc.hash = "#/outra"; limparRota(loc, hist);
  assert.equal(chamadas.length, 2, "não mexe em hash que não é do painel");
});

test("só contas com acesso ao Painel Administrativo restauram pelo endereço", () => {
  const r = lerRota("#/painel-adm/nucleo-mentorados");
  assert.equal(podeRestaurarPainel(r, { painelAdministrativo: true }), true);
  assert.equal(podeRestaurarPainel(r, { superadmin: true }), true);
  assert.equal(podeRestaurarPainel(r, { painelAdministrativo: false }), false);
  assert.equal(podeRestaurarPainel(r, null), false);
  assert.equal(podeRestaurarPainel(null, { superadmin: true }), false);
});
