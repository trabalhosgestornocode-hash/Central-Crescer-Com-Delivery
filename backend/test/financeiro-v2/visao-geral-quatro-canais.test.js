// Fase 08 (doc 44) — Visão Geral e DRE com os quatro canais: Presencial e Anota Aí pela SAIPOS, iFood pelo demonstrativo
// oficial, 99Food sem fonte (sem dados, não zero). Taxa ESTIMADA nunca entra na DRE. Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ORG_B, UNI_B, ctx, montar } from "./helpers/cenario.js";
import { xlsx } from "./helpers/formatos.js";

const c = ctx();
const W = (n, k, b) => ESCRITAS[k].fazer(n, c, b);
const CAB = ["Pedido", "Código da loja", "Nome da loja", "Tipo do pedido", "Turno", "Canal de venda", "Id do pedido no parceiro", "Número do pedido no parceiro", "Data da venda", "Consumidor", "Tem cupom", "Pagamento", "Está cancelado", "Motivo do cancelamento", "Itens", "Entrega", "Valor Entregador", "Entregador", "Bairro", "CEP", "Acréscimo", "Motivo de acréscimo", "Desconto", "Motivo do desconto", "Total", "Total taxa de serviço"];
const ficha = (q, pag, v) => ["Ficha", null, null, "F", "Dia", null, null, null, q, "Consumidor não identificado", "N", pag, "N", null, v, null, null, null, null, "", 0, "", 0, "", v, 0];
let k = 0;
const integ = (canal, q, pag, v) => { k += 1; return [k, "l", "L", "D", "Dia", canal, `00000000-0000-4000-8000-${String(k).padStart(12, "0")}`, String(k), q, "C", "N", pag, "N", null, v, 0, 0, null, "B", "0", 0, null, 0, null, v, 0]; };

async function cenario() {
  const { nucleo: n } = montar();
  await W(n, "/configuracoes/unidade", { nomeExibicao: "U", justificativa: "x" });
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  await W(n, "/configuracoes/operadoras", { codigo: "STONE", nome: "Stone", processador: "STONE", inicio: "2026-01-01", modalidades: "DEBITO,CREDITO_A_VISTA", justificativa: "x" });
  await W(n, "/configuracoes/taxas-contratadas", { operadora: "STONE", vigenciaInicio: "2026-01-01", fonte: "Fictícia", taxas: "DEBITO;VISA;1,00", justificativa: "x" });
  const linhas = [ficha("02/09/2026 12:00", "Débito Visa", 100), ficha("02/09/2026 13:00", "Dinheiro", 50), integ("Anota.ai", "02/09/2026 19:00", "Online Anotaai", 40), integ("iFood", "02/09/2026 19:10", "Online iFood", 70), integ("99 Food", "02/09/2026 19:20", "Pago Online", 30)];
  const r = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "application/octet-stream", conteudo: xlsx([{ nome: "Vendas por período", linhas: [CAB, ...linhas] }]), periodoInicio: "2026-09-02", periodoFim: "2026-09-02" });
  const imp = (await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? { aceitarPendencias: true, justificativa: "x" } : {}) })).importacao;
  await n.gerarPropostas(c, { importacaoId: imp.id, contaCaixaId: caixa.id });
  await W(n, "/propostas/aprovar-e-aplicar-prontas", { importacao: imp.id });
  return n;
}

test("quatro canais separados: SAIPOS (Presencial, Anota Aí), iFood oficial, 99Food sem dados; nada duplicado", async () => {
  const n = await cenario();
  let vg = await n.apurarVisaoGeral(c, { competencia: "2026-09" });
  const canal = (x) => vg.faturamentoBruto.porCanal.find((p) => p.canal === x);
  assert.deepEqual(["BALCAO", "ANOTA_AI", "IFOOD", "NOVENTA_E_NOVE_FOOD"].map((x) => Boolean(canal(x))), [true, true, true, true]);
  assert.deepEqual([canal("BALCAO").valorCentavos, canal("ANOTA_AI").valorCentavos], [15000, 4000]);
  assert.deepEqual([canal("IFOOD").registros.length, canal("NOVENTA_E_NOVE_FOOD").registros.length], [0, 0], "iFood/99Food da SAIPOS não viram faturamento");
  await W(n, "/vendas/demonstrativo-ifood", { periodoInicio: "2026-09-01", periodoFim: "2026-09-30", vendas: "70,00", comissoes: "8,00", taxaPagamento: "2,00", mensalidade: "0", servicosEPromocoes: "0", ajustes: "0", liquido: "60,00", origem: "Sintético", justificativa: "x" });
  vg = await n.apurarVisaoGeral(c, { competencia: "2026-09" });
  assert.deepEqual([canal("IFOOD").valorCentavos, vg.faturamentoBruto.valorCentavos], [7000, 15000 + 4000 + 7000]);
});

test("DRE: taxa estimada (líquido esperado) não vira despesa; comissão do iFood oficial entra uma vez", async () => {
  const n = await cenario();
  const dre = async () => (await n.apurarCompetencia(c, { competencia: "2026-09" })).indicadores;
  const antes = await dre();
  const le = await n.consultarLiquidoEsperado(c, { periodoInicio: "2026-09-01", periodoFim: "2026-09-30", canal: "BALCAO" });
  assert.equal(le.total.taxaCentavos, 100, "1% de R$ 100,00 estimado");
  assert.equal(antes.RESULTADO_GERENCIAL.valorCentavos, antes.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, "nenhuma despesa nasceu da estimativa");
  await W(n, "/vendas/demonstrativo-ifood", { periodoInicio: "2026-09-01", periodoFim: "2026-09-30", vendas: "70,00", comissoes: "8,00", taxaPagamento: "2,00", mensalidade: "0", servicosEPromocoes: "0", ajustes: "0", liquido: "60,00", origem: "Sintético", justificativa: "x" });
  await W(n, "/vendas/demonstrativo-ifood", { periodoInicio: "2026-09-01", periodoFim: "2026-09-30", vendas: "70,00", comissoes: "8,00", taxaPagamento: "2,00", mensalidade: "0", servicosEPromocoes: "0", ajustes: "0", liquido: "60,00", origem: "Sintético", justificativa: "x" });
  const depois = await dre();
  assert.equal(depois.RESULTADO_GERENCIAL.valorCentavos, 19000 + 7000 - 1000, "comissão + taxa do iFood uma vez");
});

test("isolamento: os canais de uma unidade não aparecem em outra empresa", async () => {
  const n = await cenario(); // MESMO núcleo/repositório: a outra empresa consulta e não vê nada
  const vg = await n.apurarVisaoGeral(ctx(ORG_B, UNI_B), { competencia: "2026-09" });
  assert.ok(vg.faturamentoBruto.porCanal.every((p) => !(p.registros ?? []).length));
});
