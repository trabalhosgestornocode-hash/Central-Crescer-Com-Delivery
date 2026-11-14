// Execução 09 — encaixe FUTURO do Financeiro v2 no Dashboard Financeiro (preparado, não ativado) e prévia da baixa
// antecipada. Rodar: node --test frontend/test/financeiroV2Encaixe.test.js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESTADO_FINANCEIRO, estadoDoStatus, menuDoEstado } from "../src/financeiroAcesso.js";
import { AREAS_FINANCEIRO_V2, ESTADO_FINANCEIRO_V2, ESTADO_FINANCEIRO_V2_NEGADO, chaveDoContexto, enderecoDaArea, estadoComFinanceiroV2, menuComFinanceiroV2, respostaVale } from "../src/financeiroV2Encaixe.js";
import * as tes from "../financeiro-v2/telasTesouraria.js";
import { criarDemo, UNIDADES } from "../../backend/scripts/fv2/demoInterface.mjs";
import { auditarHtml } from "./acessibilidade/auditoria.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const ids = (menu) => menu.flatMap((s) => s.itens.map((i) => i.id));
const STATUS = [
  { habilitado: true, financeiro2: false },
  { habilitado: true, financeiro2: true },
  { habilitado: false },
];

test("15 — sem o bloco financeiroV2 (ou com liberado:false), o Dashboard Financeiro é EXATAMENTE o de hoje", () => {
  for (const s of STATUS) {
    assert.equal(estadoComFinanceiroV2(s), estadoDoStatus(s));
    assert.deepEqual(menuComFinanceiroV2(estadoComFinanceiroV2(s)), menuDoEstado(estadoDoStatus(s)));
    const naoLiberado = { ...s, financeiroV2: { liberado: false, disponivel: false, operavel: false, motivo: "UNIDADE_NAO_LIBERADA" } };
    assert.equal(estadoComFinanceiroV2(naoLiberado), estadoDoStatus(s));
  }
  assert.equal(estadoComFinanceiroV2(null), ESTADO_FINANCEIRO.ERRO);
  assert.equal(estadoComFinanceiroV2({ habilitado: true, financeiroV2: "sim" }), ESTADO_FINANCEIRO.ERRO, "bloco malformado é erro, nunca v2 nem legado");
});

test("14, 24 — unidade liberada: o v2 SUBSTITUI o menu (sete áreas, sem duplicar nenhum item nem misturar com o antigo); sem concessão = negado; desligar volta ao atual", () => {
  const ligado = { habilitado: true, financeiro2: true, financeiroV2: { liberado: true, disponivel: true, operavel: true, motivo: null } };
  assert.equal(estadoComFinanceiroV2(ligado), ESTADO_FINANCEIRO_V2);
  const menu = menuComFinanceiroV2(ESTADO_FINANCEIRO_V2);
  assert.equal(menu.length, 7, "sete áreas");
  const todos = ids(menu);
  assert.equal(new Set(todos).size, todos.length, "nenhum item duplicado");
  assert.ok(todos.every((id) => id.startsWith("fv2-")), "nada do financeiro antigo no menu do v2");
  assert.deepEqual(AREAS_FINANCEIRO_V2.flatMap((g) => g.itens.map((i) => i.rota)).sort(), ["caixa-e-bancos", "calendario", "conferencias", "configuracoes", "contas-a-pagar", "contas-a-receber", "documentos", "dre", "fluxo-de-caixa", "vendas-e-recebimentos", "visao-geral"]);
  // liberado, mas a pessoa não opera (sem concessão, impersonação, conta compartilhada): negado — nunca o legado
  for (const v2 of [{ liberado: true, disponivel: true, operavel: false, motivo: "SEM_CONCESSAO" }, { liberado: true, disponivel: false, operavel: false, motivo: "IMPERSONACAO" }]) {
    assert.equal(estadoComFinanceiroV2({ habilitado: true, financeiro2: true, financeiroV2: v2 }), ESTADO_FINANCEIRO_V2_NEGADO);
  }
  assert.deepEqual(menuComFinanceiroV2(ESTADO_FINANCEIRO_V2_NEGADO), []);
  // desativação sintética: liberado:false volta ao menu de hoje
  assert.equal(estadoComFinanceiroV2({ habilitado: true, financeiro2: true, financeiroV2: { liberado: false } }), ESTADO_FINANCEIRO.FINANCEIRO_2);
  assert.equal(enderecoDaArea("contas-a-pagar"), "#/financeiro-v2/contas-a-pagar");
});

test("6 — troca de unidade: resposta pedida no contexto anterior é descartada", () => {
  const a = chaveDoContexto({ empresa: { id: "e1" }, unidade: { id: "u1" }, sessionId: "s1" });
  const b = chaveDoContexto({ empresa: { id: "e1" }, unidade: { id: "u2" }, sessionId: "s2" });
  assert.equal(respostaVale(a, a), true);
  assert.equal(respostaVale(a, b), false);
  assert.equal(respostaVale("", ""), false);
});

test("10 — o encaixe antigo não é importado; o v2 entra só pelo status do servidor e o menu financeiro publicado não muda", () => {
  const varrer = (d) => readdirSync(d, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? varrer(join(d, f.name)) : f.name.endsWith(".js") ? [join(d, f.name)] : []));
  const usam = varrer(SRC).filter((p) => !p.endsWith("financeiroV2Encaixe.js") && /financeiroV2Encaixe/.test(readFileSync(p, "utf8")));
  assert.deepEqual(usam, []);
  // Execução 10: a ligação é INTENCIONAL e por um ponto único — o status do servidor (desligado por padrão) decide; o
  // menu financeiro publicado continua sem nenhum item do v2 (o v2 abre a própria página, mesma aba e mesmo login).
  const acesso = readFileSync(join(SRC, "financeiroAcesso.js"), "utf8");
  assert.deepEqual(acesso.match(/\/api\/v1\/financeiro-v2\/[a-z]+/g), ["/api/v1/financeiro-v2/status"]);
  assert.match(acesso, /ENDERECO_FINANCEIRO_V2 = "\/financeiro-v2\/\?modo=plataforma#\/visao-geral"/);
  assert.ok(!/financeiroV2|financeiro-v2/.test(readFileSync(join(SRC, "financeiroMenu.js"), "utf8")));
});

// ------------------------------------------------------------------------------ baixa antecipada (prévia na tela)
let demo;
const U1 = UNIDADES[0].id;
before(async () => { demo = await criarDemo(); });
const ok = async (caminho, params) => { const r = await demo.responder(caminho, { unidade: U1, ...params }, "administrador"); assert.equal(r.status, 200, JSON.stringify(r.corpo)); return r.corpo; };
const TODAS = ["financeiro_v2.ver", "financeiro_v2.registrar", "financeiro_v2.vincular_pagamento"];

test("16, 17 — prévia com saída ANTERIOR à emissão: alerta, documentos aceitos, caixa explícita de pagamento antecipado e justificativa mínima; conta normal sem nada disso", async () => {
  const OUT = { competencia: "2026-10" };
  const energia = (await ok("/api/fv2/contas-a-pagar", { ...OUT, tamanho: "100" })).itens.find((t) => t.fornecedor?.nome?.startsWith("Energia"));
  const det = await ok("/api/fv2/conta-a-pagar", { ...OUT, id: energia.id });
  const anterior = det.vinculoExtrato.saidasElegiveis.find((s) => s.data < "2026-10-20");
  assert.ok(anterior, "há saída anterior à emissão (20/10) entre as elegíveis");
  const prev = await ok("/api/fv2/vinculo-extrato", { ...OUT, obrigacao: energia.id, movimentacao: anterior.id });
  assert.ok(prev.escolhida.antecipacao?.dias > 0);
  const html = tes.detalheVinculoExtrato(prev, { permissoes: TODAS });
  assert.match(html, /role="alert"><strong>Atenção — saída anterior à emissão da conta\.<\/strong>/);
  assert.match(html, /name="pagamentoAntecipado" required/);
  assert.match(html, /minlength="30"/);
  assert.deepEqual(auditarHtml(html), []);
  // a saída de 28/10 (depois da emissão) não pede nada disso
  const normal = det.vinculoExtrato.saidasElegiveis.find((s) => s.valorCentavos === 61850 && s.data === "2026-10-28");
  const prevNormal = await ok("/api/fv2/vinculo-extrato", { ...OUT, obrigacao: energia.id, movimentacao: normal.id });
  assert.equal(prevNormal.escolhida.antecipacao, null);
  assert.ok(!/pagamentoAntecipado/.test(tes.detalheVinculoExtrato(prevNormal, { permissoes: TODAS })));
});
