// Fase 07 (doc 44) — áreas iFood e 99Food: só fontes oficiais; preliminar × confirmado; pedidos SAIPOS só conferência.
// Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ctx, montar } from "./helpers/cenario.js";

const c = ctx();
const W = (n, k, b) => ESCRITAS[k].fazer(n, c, b);
const DEM = { periodoInicio: "2026-09-01", periodoFim: "2026-09-30", vendas: "1.000,00", comissoes: "100,00", taxaPagamento: "20,00", mensalidade: "10,00", servicosEPromocoes: "200,00", ajustes: "0,50", liquido: "670,50", origem: "Demonstrativo sintético", justificativa: "Sintético." };

test("iFood sem demonstrativo: PRELIMINAR, totais ausentes (não zero) e pendência explícita", async () => {
  const { nucleo: n } = montar();
  const r = await n.consultarCanalPlataforma(c, { canal: "IFOOD", competencia: "2026-09" });
  assert.deepEqual([r.situacao, r.totais], ["PRELIMINAR", null]);
  assert.ok(r.pendencias.some((p) => p.codigo === "DEMONSTRATIVO_AUSENTE"));
});

test("iFood com demonstrativo oficial: bruto, comissões, taxas, mensalidade, descontos, ajuste, repasse previsto × recebido", async () => {
  const { nucleo: n } = montar();
  const banco = await n.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco Sintético" });
  const d = await W(n, "/vendas/demonstrativo-ifood", DEM);
  let r = await n.consultarCanalPlataforma(c, { canal: "IFOOD", competencia: "2026-09" });
  assert.equal(r.situacao, "CONFIRMADO_COM_REPASSE_PENDENTE");
  const t = r.totais;
  assert.deepEqual([t.brutoCentavos, t.comissoesCentavos, t.taxasCentavos, t.mensalidadesCentavos, t.descontosEPromocoesCentavos], [100000, 10000, 2000, 1000, 20000]);
  assert.deepEqual([t.repassePrevistoCentavos, t.repasseRecebidoCentavos, t.saldoAReceberCentavos], [67050, 0, 67050]);
  assert.deepEqual([t.pedidos, t.cancelamentos], [null, null], "o demonstrativo não traz pedidos: nunca zero");
  // Repasse recebido no banco: passa a confirmado.
  const e = await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-10-05", sentido: "ENTRADA", valorCentavos: 67050, natureza: "RECEBIMENTO" });
  await n.registrarLiquidacao(c, { movimentacaoId: e.movimentacao.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: d.recebivel.id, valorCentavos: 67050 }] });
  r = await n.consultarCanalPlataforma(c, { canal: "IFOOD", competencia: "2026-09" });
  assert.deepEqual([r.situacao, r.totais.repasseRecebidoCentavos, r.totais.saldoAReceberCentavos, r.demonstrativos[0].situacaoRepasse], ["CONFIRMADO", 67050, 0, "RECEBIDO"]);
  assert.equal(r.historico.length, 1);
});

test("99Food: sem fonte oficial nada é presumido; a SAIPOS não vira faturamento", async () => {
  const { nucleo: n } = montar();
  const r = await n.consultarCanalPlataforma(c, { canal: "NOVENTA_E_NOVE_FOOD", competencia: "2026-09" });
  assert.deepEqual([r.situacao, r.dependeDeRelatorioOficial, r.totais], ["SEM_FONTE_OFICIAL", true, null]);
  assert.equal(r.conferenciaSaipos.natureza, "SO_CONFERENCIA");
});

test("receita iFood fora da fonte oficial (ex.: venda manual/anterior à regra) é sinalizada como pendência, sem ser escondida", async () => {
  const { nucleo: n } = montar();
  await n.registrarVenda(c, { canal: "IFOOD", dataVenda: "2026-09-10", brutoCentavos: 5000, fonte: { sistema: "MANUAL", idExterno: "teste:ifood-manual" }, pagamentos: [{ forma: "OUTRA", processador: "IFOOD", valorCentavos: 5000 }] });
  const r = await n.consultarCanalPlataforma(c, { canal: "IFOOD", competencia: "2026-09" });
  assert.deepEqual([r.outrasOrigens.lancamentos, r.outrasOrigens.valorCentavos], [1, 5000]);
  assert.ok(r.pendencias.some((p) => p.codigo === "RECEITA_IFOOD_FORA_DA_FONTE_OFICIAL"));
});
