// Painel de Operadoras e Taxas (18/11/2026): bruto, taxa ESTIMADA e líquido esperado do período por operadora e modalidade.
// Dados 100% SINTÉTICOS; roda em memória e no PostgreSQL local (FV2_REPOSITORIO=postgres).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { CONSULTAS } from "../../src/modules/fv2-integracao/consultas.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ctx, montar, rejeita } from "./helpers/cenario.js";

const c = ctx();
let seq = 0;

async function cenario() {
  const m = montar({ relogio: () => new Date("2026-11-20T12:00:00Z") });
  const W = (rota, corpo) => ESCRITAS[rota].fazer(m.nucleo, c, corpo);
  await W("/configuracoes/unidade", { nomeExibicao: "Unidade sintética", justificativa: "Teste." });
  await W("/configuracoes/operadoras", { codigo: "STONE", nome: "Stone Sintética", processador: "STONE", inicio: "2026-01-01", encerramento: "2026-11-09", modalidades: "DEBITO,CREDITO_A_VISTA", justificativa: "Teste." });
  await W("/configuracoes/operadoras", { codigo: "PAGBANK", nome: "PagBank Sintética", processador: "PAGBANK", inicio: "2026-11-10", modalidades: "DEBITO,CREDITO_A_VISTA,PIX", justificativa: "Teste." });
  await W("/configuracoes/taxas-contratadas", { operadora: "STONE", vigenciaInicio: "2026-01-01", fonte: "Sintética", justificativa: "Teste.", taxas: "DEBITO;MASTERCARD;1,42\nCREDITO_A_VISTA;VISA;4,35" });
  await W("/configuracoes/taxas-contratadas", { operadora: "PAGBANK", vigenciaInicio: "2026-11-10", fonte: "Sintética", justificativa: "Teste.", taxas: "DEBITO;MASTERCARD;1,00\nPIX;PIX;0,50" });
  const caixa = await m.nucleo.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  const vender = (data, valor, pagamento) => m.nucleo.registrarVenda(c, { canal: "BALCAO", dataVenda: data, brutoCentavos: valor, fonte: { sistema: "MANUAL", idExterno: `PT-${(seq += 1)}` }, pagamentos: [{ valorCentavos: valor, ...pagamento }] });
  await vender("2026-11-05", 10000, { forma: "DEBITO", processador: "STONE", bandeira: "MASTERCARD" }); // Stone 1,42% → 142
  await vender("2026-11-05", 20000, { forma: "CREDITO", processador: "STONE", bandeira: "VISA" }); // Stone 4,35% → 870
  await vender("2026-11-12", 10000, { forma: "DEBITO", processador: "PAGBANK", bandeira: "MASTERCARD" }); // PagBank 1% → 100
  await vender("2026-11-12", 5000, { forma: "CREDITO", processador: "PAGBANK", bandeira: "ELO" }); // sem taxa de crédito Elo → não configurada
  await vender("2026-11-12", 8000, { forma: "PIX", processador: "PAGBANK" }); // 0,5% → 40
  await vender("2026-11-12", 3000, { forma: "DINHEIRO", contaId: caixa.id }); // sem operadora: fora do painel
  return m;
}

test("painel por operadora e modalidade: bruto, taxa estimada e líquido do período; dinheiro fica fora", async () => {
  const m = await cenario();
  const p = await m.nucleo.consultarTaxasPorOperadora(c, { periodoInicio: "2026-11-01", periodoFim: "2026-11-30" });
  assert.equal(p.natureza, "ESTIMATIVA");
  assert.deepEqual([p.total.quantidade, p.total.brutoCentavos, p.total.taxaCentavos, p.total.brutoSemCalculoCentavos], [5, 53000, 1152, 5000]);
  assert.equal(p.total.liquidoEsperadoCentavos, 48000 - 1152);
  const op = Object.fromEntries(p.operadoras.map((o) => [o.operadora, o]));
  assert.deepEqual(Object.keys(op).sort(), ["PAGBANK", "STONE"]);
  assert.deepEqual([op.STONE.total.brutoCentavos, op.STONE.total.taxaCentavos], [30000, 1012]);
  assert.deepEqual([op.PAGBANK.total.brutoCentavos, op.PAGBANK.total.taxaCentavos, op.PAGBANK.total.brutoSemCalculoCentavos], [23000, 140, 5000]);
  const mod = Object.fromEntries(p.porModalidade.map((x) => [x.modalidade, x]));
  assert.deepEqual([mod.DEBITO.brutoCentavos, mod.DEBITO.taxaCentavos], [20000, 242]);
  assert.deepEqual([mod.CREDITO_A_VISTA.brutoCentavos, mod.CREDITO_A_VISTA.taxaCentavos, mod.CREDITO_A_VISTA.brutoSemCalculoCentavos], [25000, 870, 5000]);
  assert.deepEqual([mod.PIX.brutoCentavos, mod.PIX.taxaCentavos], [8000, 40]);
  assert.ok(!("DINHEIRO" in mod));
});

test("período filtra pela data da venda; a rota /operadoras só traz o painel com período", async () => {
  const m = await cenario();
  const so5 = await m.nucleo.consultarTaxasPorOperadora(c, { periodoInicio: "2026-11-01", periodoFim: "2026-11-09" });
  assert.deepEqual(so5.operadoras.map((o) => o.operadora), ["STONE"]);
  const semPeriodo = await CONSULTAS["/operadoras"](m.nucleo, c, {});
  assert.ok(!("painel" in semPeriodo));
  const comPeriodo = await CONSULTAS["/operadoras"](m.nucleo, c, { periodoInicio: "2026-11-10", periodoFim: "2026-11-30" });
  assert.deepEqual(comPeriodo.painel.operadoras.map((o) => o.operadora), ["PAGBANK"]);
  assert.equal(comPeriodo.operadoras.length, 2);
  await rejeita(m.nucleo.consultarTaxasPorOperadora(c, { periodoInicio: "2026-11-30", periodoFim: "2026-11-01" }), CODIGO.ENTRADA_INVALIDA);
});
