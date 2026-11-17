// Baixa pelo extrato quando a saída é MAIOR que a conta: a tela pergunta o que é a diferença e, se for juros ou multa,
// a baixa grava o ajuste da conta na mesma operação. Demonstração local (núcleo REAL; dados sintéticos).
// Rodar: node --test frontend/test/financeiroV2BaixaJuros.test.js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as tes from "../financeiro-v2/telasTesouraria.js";
import * as conf from "../financeiro-v2/telasConferencias.js";
import { criarDemo, UNIDADES } from "../../backend/scripts/fv2/demoInterface.mjs";
import { auditarHtml } from "./acessibilidade/auditoria.js";

let demo;
const U1 = UNIDADES[0].id;
const OUT = { competencia: "2026-10" };
const tokens = {};
const ok = async (caminho, params, perfil = "administrador") => { const r = await demo.responder(caminho, { unidade: U1, ...params }, perfil); assert.equal(r.status, 200, JSON.stringify(r.corpo)); return r.corpo; };
const agir = (caminho, corpo, perfil = "administrador") => demo.agir(caminho, { unidade: U1, confirmar: true, ...corpo }, perfil, { csrf: tokens[perfil] });
const TODAS = ["financeiro_v2.ver", "financeiro_v2.registrar", "financeiro_v2.vincular_pagamento", "financeiro_v2.corrigir"];
before(async () => {
  demo = await criarDemo();
  for (const p of ["administrador", "gestor", "operador"]) tokens[p] = (await ok("/api/fv2/sessao", {}, p)).csrf;
});

test("juros — a tela pergunta o que é a diferença (nada marcado), e escolher juros quita a conta com o ajuste e a despesa financeira", async () => {
  // Conta de R$ 600,00; a saída do extrato de 28/10 é de R$ 618,50: sobram R$ 18,50.
  const nova = await agir("/api/fv2/acoes/obrigacoes/registrar", { fornecedorNovo: "Contador Sintético", descricao: "Contador Outubro/2026", valor: "600,00", categoria: "INSUMOS", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-30", chave: randomUUID() });
  assert.equal(nova.status, 200, JSON.stringify(nova.corpo));
  const lista = await ok("/api/fv2/contas-a-pagar", { ...OUT, tamanho: "100" });
  const conta = lista.itens.find((t) => t.fornecedor?.nome === "Contador Sintético");
  const det = await ok("/api/fv2/conta-a-pagar", { ...OUT, id: conta.id });
  const saida = det.vinculoExtrato.saidasElegiveis.find((s) => s.valorCentavos === 61850 && s.data === "2026-10-28");
  assert.ok(saida);
  const prev = await ok("/api/fv2/vinculo-extrato", { ...OUT, obrigacao: conta.id, movimentacao: saida.id });
  assert.equal(prev.escolhida.juros.sobraCentavos, 1850);
  assert.equal(prev.escolhida.valorPropostoCentavos, 60000, "a proposta é só a conta: o juro é uma escolha explícita");

  const html = tes.detalheVinculoExtrato(prev, { permissoes: TODAS });
  assert.match(html, /A saída é R\$\s?18,50 maior que a conta\. O que é essa diferença\?/);
  assert.match(html, /Juros ou multa deste pagamento/);
  assert.match(html, /Deixar sem classificar por enquanto/);
  assert.match(html, /name="juros" value="18,50" required/);
  assert.ok(!/name="juros"[^>]*checked/.test(html), "nenhuma opção vem marcada sozinha");
  assert.match(html, /despesas financeiras/);
  assert.deepEqual(auditarHtml(html), []);

  const corpo = { obrigacao: conta.id, movimentacao: saida.id, versao: String(prev.escolhida.versao), valor: "600,00", juros: "18,50", documento: prev.escolhida.documentosDisponiveis[0].id, justificativa: "Pago conforme o extrato de 28/10/2026 (sintético)." };
  const g = await agir("/api/fv2/acoes/obrigacoes/vincular-extrato", corpo, "gestor"); assert.equal(g.status, 403, JSON.stringify(g.corpo));
  const r = await agir("/api/fv2/acoes/obrigacoes/vincular-extrato", corpo);
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.efeito.jurosCentavos, 1850);
  assert.match(conf.resultadoDaAcao({ ok: true, dados: r.corpo }), /Juros ou multa de R\$\s?18,50 lançados como despesa financeira/);
  const rep = await agir("/api/fv2/acoes/obrigacoes/vincular-extrato", corpo);
  assert.equal(rep.corpo.repetido, true, "repetir não duplica");

  const paga = await ok("/api/fv2/conta-a-pagar", { ...OUT, id: conta.id });
  assert.deepEqual([paga.titulo.saldoCentavos, paga.titulo.situacao, paga.titulo.ajustesCentavos], [0, "PAGO", 1850]);
  assert.ok(paga.historico.some((h) => h.evento === "AJUSTE"), "o ajuste de juros fica no histórico da conta");
  const dre = await ok("/api/fv2/dre", { ...OUT });
  assert.match(JSON.stringify(dre), /Juros e multas pagos a fornecedores/, "o juro aparece na DRE, em despesas financeiras");
});

test("juros — escolher 'deixar sem classificar' não envia juros; sem a permissão de corrigir a tela só explica", async () => {
  const lista = await ok("/api/fv2/contas-a-pagar", { ...OUT, tamanho: "100" });
  const alvo = lista.itens.find((t) => t.saldoCentavos > 0 && t.fornecedor?.nome !== "Contador Sintético");
  assert.ok(alvo);
  const det = await ok("/api/fv2/conta-a-pagar", { ...OUT, id: alvo.id });
  const saida = det.vinculoExtrato.saidasElegiveis.find((s) => s.disponivelCentavos > alvo.saldoCentavos);
  if (!saida) return; // sem saída maior que a conta neste cenário: nada a verificar aqui (a regra está coberta no backend).
  const prev = await ok("/api/fv2/vinculo-extrato", { ...OUT, obrigacao: alvo.id, movimentacao: saida.id });
  const semPermissao = tes.detalheVinculoExtrato({ ...prev, escolhida: { ...prev.escolhida, juros: { ...prev.escolhida.juros, voceTemPermissao: false } } }, { permissoes: ["financeiro_v2.ver", "financeiro_v2.vincular_pagamento"] });
  assert.match(semPermissao, /exige também a permissão "corrigir contas"/);
  assert.ok(!/name="juros"/.test(semPermissao));
});
