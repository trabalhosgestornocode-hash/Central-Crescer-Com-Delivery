// doc 38 — faturamento do canal iFood pelo DEMONSTRATIVO OFICIAL do iFood (não pela integração SAIPOS). Dados SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ctx, montar, rejeita } from "./helpers/cenario.js";
import { texto } from "./helpers/arquivos.js";

const c = ctx();
const SET = { competencia: "2026-09" };
const W = (n) => async (k, b) => ESCRITAS[k].fazer(n, c, b);
const DEM = { periodoInicio: "2026-09-01", periodoFim: "2026-09-30", vendas: "1.000,00", comissoes: "100,00", taxaPagamento: "20,00", mensalidade: "10,00", servicosEPromocoes: "200,00", ajustes: "0,50", liquido: "670,50", origem: "Demonstrativo sintético do iFood", justificativa: "Fonte oficial do canal iFood (sintético)." };
async function canais(n) {
  const cab = "ATENDENTE;QUANTIDADE_VENDAS;VALOR_TOTAL_VENDAS;CATEGORIA;ITEM;QUANTIDADE_ITEM;VALOR_TOTAL_ITEM";
  const arq = texto([cab, "Loja Sintética;10;500,00;Copos;Copo;10;500,00", "integration-ifood;5;900,00;Diversos;Diversos;5;900,00", "integration-api-int-sale;2;120,00;Diversos;Diversos;2;120,00"].join(String.fromCharCode(10)));
  const r = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_DESEMPENHO_POR_ATENDENTE", tipoMime: "text/csv", conteudo: arq, periodoInicio: "2026-09-01", periodoFim: "2026-09-30" });
  const imp = (await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: "Sintético." })).importacao;
  await n.gerarPropostas(c, { importacaoId: imp.id });
  return Object.fromEntries((await n.listarPropostas(c, { operacao: "VENDA_AGREGADA" })).map((p) => [p.comando.canal, p]));
}

test("iFood oficial: SAIPOS iFood rejeitado (só conferência); demonstrativo dá receita, retenções e recebível líquido; nada duplica", async () => {
  const { nucleo: n } = montar();
  const p = await canais(n);
  for (const k of ["BALCAO", "ANOTA_AI"]) { await n.aprovarProposta(c, { propostaId: p[k].id, justificativa: "Sintético." }); await n.aplicarProposta(c, { propostaId: p[k].id }); }
  assert.equal(p.IFOOD, undefined, "o total iFood da SAIPOS não vira proposta: só conferência (doc 38/39)");
  await rejeita(W(n)("/vendas/demonstrativo-ifood", { ...DEM, liquido: "670,49" }), CODIGO.ENTRADA_INVALIDA); // não fecha
  const r = await W(n)("/vendas/demonstrativo-ifood", DEM);
  assert.deepEqual([r.receita.valorCentavos, r.receita.canal, r.retencoes.length], [100000, "IFOOD", 4]);
  assert.equal((await W(n)("/vendas/demonstrativo-ifood", DEM)).repetido, true);
  const ind = (await n.apurarCompetencia(c, SET)).indicadores;
  const canal = (k) => ind.FATURAMENTO_BRUTO_PROPRIO.porCanal.find((x) => x.canal === k)?.valorCentavos ?? 0;
  assert.deepEqual([canal("BALCAO"), canal("IFOOD"), canal("ANOTA_AI"), ind.FATURAMENTO_BRUTO_PROPRIO.valorCentavos], [50000, 100000, 12000, 162000], "iFood oficial, nunca somado ao SAIPOS");
  assert.equal(ind.RESULTADO_GERENCIAL.valorCentavos, 162000 - 33000 + 50, "retenções e ajuste uma vez cada");
  const rec = (await n.consultarContasAReceber(c, { tamanho: 20 })).itens.find((x) => x.id === r.recebivel.id);
  assert.equal(rec.saldoCentavos, 67050, "o líquido é o que o iFood deve repassar — não é depósito");
  // Granularidade única: com o demonstrativo registrado, nem a SAIPOS nem um novo arquivo de canais criam receita iFood.
  const { nucleo: n2 } = montar();
  await W(n2)("/vendas/demonstrativo-ifood", DEM);
  const p2 = await canais(n2);
  assert.equal(p2.IFOOD, undefined);
  const ind2 = (await n2.apurarCompetencia(c, SET)).indicadores;
  assert.equal(ind2.FATURAMENTO_BRUTO_PROPRIO.porCanal.find((x) => x.canal === "IFOOD")?.valorCentavos, 100000);
});
