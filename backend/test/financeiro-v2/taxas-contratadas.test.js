// doc 35 — taxas contratadas (Stone) por modalidade e bandeira × taxas cobradas por transação. Dados SINTÉTICOS.
// Roda em memória e, com FV2_REPOSITORIO=postgres, no banco isolado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { conferirTaxas, validarTabelaDeTaxas } from "../../src/modules/financeiro-v2/dominio/taxasContratadas.js";
import { ctx, montar, rejeita } from "./helpers/cenario.js";
import { texto } from "./helpers/arquivos.js";

const c = ctx();
const TABELA = ["DEBITO;MASTERCARD;1,10", "DEBITO;VISA;1,10", "CREDITO_A_VISTA;MASTERCARD;3,90", "CREDITO_A_VISTA;VISA;3,90", "PIX;PIX;0,40"].join("\n");
const stoneCsv = (linhas) => texto(["STONE ID;DATA DA VENDA;PRODUTO;BANDEIRA;VALOR BRUTO;VALOR LIQUIDO;DESCONTO DE MDR;DESCONTO DE ANTECIPACAO;DESCONTO UNIFICADO;ULTIMO STATUS;CÓDIGO DE AUTORIZAÇÃO",
  ...linhas.map((l) => [l.id, l.quando, l.produto, l.bandeira, l.bruto, l.liquido, "0,000000", "0,000000", l.unificado, "Aprovada", l.id].join(";"))].join("\n"));

test("tabela contratada: validação (sem 0%, sem repetição, modalidades praticadas) e vigência sem sobreposição", async () => {
  assert.throws(() => validarTabelaDeTaxas({ processador: "STONE", vigenciaInicio: "2026-09-01", fonte: "x", justificativa: "x", taxas: [{ modalidade: "DEBITO", bandeira: "Visa", percentual: "0" }] }), /maior que zero/);
  assert.throws(() => validarTabelaDeTaxas({ processador: "STONE", vigenciaInicio: "2026-09-01", fonte: "x", justificativa: "x", taxas: [{ modalidade: "CREDITO_PARCELADO", bandeira: "Visa", percentual: "5" }] }), /DEBITO, CREDITO_A_VISTA ou PIX/);
  assert.throws(() => validarTabelaDeTaxas({ processador: "STONE", vigenciaInicio: "2026-09-01", fonte: "x", justificativa: "x", taxas: [{ modalidade: "DEBITO", bandeira: "Master", percentual: "1,10" }, { modalidade: "DEBITO", bandeira: "MasterCard", percentual: "1,10" }] }), /duas vezes/);
  const { nucleo: n } = montar();
  const W = (k, b) => ESCRITAS[k].fazer(n, c, b);
  const corpo = { vigenciaInicio: "2026-09-01", fonte: "Captura sintética do app", prazoDeRecebimento: "Mesmo dia", taxas: TABELA, justificativa: "Tabela sintética." };
  await rejeita(W("/configuracoes/taxas-contratadas", corpo), CODIGO.OPERACAO_INVALIDA); // unidade não configurada
  await W("/configuracoes/unidade", { nomeExibicao: "Unidade sintética", justificativa: "Teste." });
  const r = await W("/configuracoes/taxas-contratadas", corpo);
  assert.deepEqual([r.repetido, r.tabela.taxas.length, r.tabela.taxas.find((t) => t.modalidade === "CREDITO_A_VISTA" && t.bandeira === "MASTERCARD").milesimos], [false, 5, 3900]);
  assert.equal((await W("/configuracoes/taxas-contratadas", corpo)).repetido, true);
  await rejeita(W("/configuracoes/taxas-contratadas", { ...corpo, vigenciaInicio: "2026-10-01" }), CODIGO.OPERACAO_INVALIDA); // sobrepõe a vigente sem fim
});

test("conferência por transação: contratado × cobrado × líquido; Pix truncado vira diferença; vale sem taxa nunca é 0%; soma exata × arredondada", async () => {
  const { nucleo: n } = montar();
  const W = (k, b) => ESCRITAS[k].fazer(n, c, b);
  await W("/configuracoes/unidade", { nomeExibicao: "Unidade sintética", justificativa: "Teste." });
  await W("/configuracoes/taxas-contratadas", { vigenciaInicio: "2026-09-01", fonte: "Captura sintética", taxas: TABELA, justificativa: "Tabela sintética." });
  const arquivo = stoneCsv([
    { id: "S1", quando: "02/09/2026 12:00", produto: "Credito", bandeira: "MasterCard", bruto: "100,000000", liquido: "96,100000", unificado: "-3,900000" },
    { id: "S2", quando: "02/09/2026 12:05", produto: "Credito", bandeira: "Visa", bruto: "17,610000", liquido: "16,923210", unificado: "-0,686790" },
    { id: "S3", quando: "03/09/2026 12:00", produto: "Debito", bandeira: "Visa", bruto: "50,000000", liquido: "49,450000", unificado: "-0,550000" },
    { id: "S4", quando: "04/09/2026 12:00", produto: "Pix", bandeira: "Pix", bruto: "19,880000", liquido: "19,810000", unificado: "-0,070000" },
    { id: "S5", quando: "05/09/2026 12:00", produto: "Voucher", bandeira: "Alelo", bruto: "30,000000", liquido: "30,000000", unificado: "0,000000" },
  ]);
  const r = await n.receberArquivoParaImportacao(c, { fonte: "STONE", tipoRelatorio: "STONE_VENDAS", tipoMime: "application/octet-stream", conteudo: arquivo, periodoInicio: "2026-09-01", periodoFim: "2026-09-30" });
  await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? { aceitarPendencias: true, justificativa: "Sintético." } : {}) });
  const q = await n.consultarTaxasContratadas(c, { competencia: "2026-09" });
  const g = (m, b) => q.composicao.find((x) => x.modalidade === m && x.bandeira === b);
  assert.deepEqual([g("CREDITO_A_VISTA", "MASTERCARD").esperadoCentavos, g("CREDITO_A_VISTA", "MASTERCARD").cobradoCentavos, g("CREDITO_A_VISTA", "MASTERCARD").liquidoInformadoCentavos], [390, 390, 9610]);
  assert.deepEqual(g("DEBITO", "VISA").porSituacao, { CONFERE: 1 });
  assert.deepEqual(g("PIX", "PIX").porSituacao, { DIFERENTE_DO_CONTRATADO: 1 }, "0,40% de 19,88 = 0,0795 → contratado 0,08; o processador cobrou 0,07 (truncado)");
  const vale = q.composicao.find((x) => x.bandeira === "ALELO");
  assert.deepEqual([vale.percentualContratado, vale.esperadoCentavos, vale.porSituacao], [null, null, { SEM_TAXA_CONTRATADA: 1 }], "sem taxa contratada: nunca 0%");
  // Soma exata (milionésimos) × arredondada por transação: a fração de centavo aparece, não some.
  assert.equal(q.total.cobradoCentavos, Math.floor((3900000 + 686790 + 550000 + 70000 + 5000) / 10000));
  assert.equal(q.total.cobradoArredondadoPorTransacaoCentavos, 390 + 69 + 55 + 7);
  assert.equal(q.fracaoDeCentavo.centavos, q.total.cobradoArredondadoPorTransacaoCentavos - q.total.cobradoCentavos);
  assert.equal(q.pendencias.length, 2);
});

test("crédito parcelado (o Açaí só vende à vista) vira divergência, sem descartar nem mudar o valor; sem tabela vigente não inventa taxa", () => {
  const tabelas = [{ processador: "STONE", vigenciaInicio: "2026-09-01", vigenciaFim: null, taxas: [{ modalidade: "CREDITO_A_VISTA", bandeira: "VISA", milesimos: 3900 }] }];
  const r = conferirTaxas([
    { id: "P1", data: "2026-09-10", dados: { produto: "CREDITO", bandeira: "Visa", parcelas: "3", brutoMicros: 300000000, descontoInformadoMicros: 15000000, liquidoMicros: 285000000 } },
    { id: "A1", data: "2026-08-31", dados: { produto: "CREDITO", bandeira: "Visa", parcelas: "1", brutoMicros: 100000000, descontoInformadoMicros: 3900000, liquidoMicros: 96100000 } },
  ], tabelas);
  const [p, a] = r.pendencias.sort((x, y) => x.id.localeCompare(y.id)).reverse();
  assert.deepEqual([p.situacao, p.brutoCentavos, p.cobradoCentavos], ["PARCELADA_A_CONFERIR", 30000, 1500]);
  assert.deepEqual([a.situacao, a.esperadoCentavos], ["SEM_TABELA_VIGENTE", null]);
});

// ------------------------------------------------------------------------------------------- doc 36: taxas na DRE
const ACEITE36 = { aceitarPendencias: true, justificativa: "Sintético." };
async function importar36(n, fonte, tipoRelatorio, conteudo) {
  const r = await n.receberArquivoParaImportacao(c, { fonte, tipoRelatorio, tipoMime: "application/octet-stream", conteudo, periodoInicio: "2026-09-01", periodoFim: "2026-09-30" });
  if (r.repetido) return { ...r.importacao, repetido: true };
  return (await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? ACEITE36 : {}) })).importacao;
}
const aplicarTodas36 = async (n, operacao) => {
  for (const p of await n.listarPropostas(c, { operacao })) {
    if (!["PROPOSTA", "AGUARDANDO_REVISAO"].includes(p.estado)) continue;
    await n.aprovarProposta(c, { propostaId: p.id, justificativa: "Sintético." });
    await n.aplicarProposta(c, { propostaId: p.id });
  }
};
const STONE36 = [
  { id: "S1", quando: "02/09/2026 12:00", produto: "Credito", bandeira: "MasterCard", bruto: "100,000000", liquido: "96,100000", unificado: "-3,900000" },
  { id: "S2", quando: "02/09/2026 12:05", produto: "Credito", bandeira: "Visa", bruto: "17,610000", liquido: "16,923210", unificado: "-0,686790" },
  { id: "S3", quando: "03/09/2026 12:00", produto: "Debito", bandeira: "Visa", bruto: "50,000000", liquido: "49,450000", unificado: "-0,550000" },
  { id: "S4", quando: "04/09/2026 12:00", produto: "Pix", bandeira: "Pix", bruto: "19,880000", liquido: "19,810000", unificado: "-0,070000" },
  { id: "S5", quando: "05/09/2026 12:00", produto: "Voucher", bandeira: "Elo", bruto: "30,000000", liquido: "28,920000", unificado: "-1,080000" },
];
const MICROS36 = 3900000 + 686790 + 550000 + 70000 + 1080000;
const resultado36 = async (n) => (await n.apurarCompetencia(c, { competencia: "2026-09" })).indicadores;

test("taxas Stone do período na DRE: soma exata uma vez; bruto e líquido Stone não viram receita; reimportações não duplicam; vale com tarifa efetiva entra", async () => {
  const { nucleo: n } = montar();
  const cab = "ATENDENTE;QUANTIDADE_VENDAS;VALOR_TOTAL_VENDAS;CATEGORIA;ITEM;QUANTIDADE_ITEM;VALOR_TOTAL_ITEM";
  const canais = texto([cab, "Loja Sintética;10;500,00;Copos;Copo;10;500,00", "integration-ifood;5;300,00;Diversos;Diversos;5;300,00", "integration-api-int-sale;2;120,00;Diversos;Diversos;2;120,00"].join(String.fromCharCode(10)));
  const impC = await importar36(n, "SAIPOS", "SAIPOS_DESEMPENHO_POR_ATENDENTE", canais);
  await n.gerarPropostas(c, { importacaoId: impC.id });
  await aplicarTodas36(n, "VENDA_AGREGADA");
  const antes = await resultado36(n);
  const impS = await importar36(n, "STONE", "STONE_VENDAS", stoneCsv(STONE36));
  await n.gerarPropostas(c, { importacaoId: impS.id }); // sem pedidos: nenhuma venda a ligar
  const depoisImport = await resultado36(n);
  assert.deepEqual([depoisImport.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, depoisImport.RESULTADO_GERENCIAL.valorCentavos], [92000, antes.RESULTADO_GERENCIAL.valorCentavos], "importar a Stone não muda receita nem resultado");
  const r = await ESCRITAS["/importacao/reconhecer-taxas"].fazer(n, c, { importacao: impS.id, justificativa: "Tarifas conferidas por transação (sintético)." });
  const taxa = Math.floor((MICROS36 + 5000) / 10000);
  assert.deepEqual([r.resultado.length, r.resultado[0].lancamento.valorCentavos, r.resultado[0].lancamento.categoria, r.resultado[0].lancamento.taxasDoPeriodo.transacoes], [1, taxa, "TAXAS_STONE", 5]);
  const depois = await resultado36(n);
  assert.equal(depois.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, 92000, "nem o bruto nem o líquido Stone viram receita");
  assert.equal(depois.RESULTADO_GERENCIAL.valorCentavos, antes.RESULTADO_GERENCIAL.valorCentavos - taxa, "a tarifa entra uma única vez");
  // Repetir, reimportar a Stone e reimportar os canais: nada muda.
  assert.equal((await n.reconhecerTaxasDoPeriodo(c, { importacaoId: impS.id, justificativa: "De novo." })).resultado[0].repetido, true);
  assert.equal((await importar36(n, "STONE", "STONE_VENDAS", stoneCsv(STONE36))).repetido, true);
  assert.equal((await importar36(n, "SAIPOS", "SAIPOS_DESEMPENHO_POR_ATENDENTE", canais)).repetido, true);
  assert.equal((await resultado36(n)).RESULTADO_GERENCIAL.valorCentavos, depois.RESULTADO_GERENCIAL.valorCentavos);
  const q = await n.consultarTaxasContratadas(c, { competencia: "2026-09" });
  assert.deepEqual(q.reconhecimento.map((x) => [x.situacao, x.valorCentavos]), [["RECONHECIDA", taxa]]);
  assert.equal(q.total.cobradoCentavos, taxa, "DRE = soma exata das tarifas efetivas");
  // Estorno autorizado: cancela (não apaga) e o resultado volta.
  await ESCRITAS["/importacao/estornar-taxas"].fazer(n, c, { importacao: impS.id, competencia: "2026-09", justificativa: "Teste de estorno (sintético)." });
  assert.equal((await resultado36(n)).RESULTADO_GERENCIAL.valorCentavos, antes.RESULTADO_GERENCIAL.valorCentavos);
  assert.equal((await n.consultarTaxasContratadas(c, { competencia: "2026-09" })).reconhecimento[0].situacao, "ESTORNADA");
});

test("substituição por pedidos: com as taxas do período ativas, a taxa por venda é recusada; após o estorno, entra por venda e o período reconhece só o resto", async () => {
  const { nucleo: n } = montar();
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  const { saiposVendas } = await import("./helpers/arquivos.js");
  const ped = await importar36(n, "SAIPOS", "SAIPOS_VENDAS", saiposVendas([{ pedido: "P-1", data: "02/09/2026 11:59", canal: "Balcão", itens: 10000, forma: "Crédito", autorizacao: "S1" }]));
  await n.gerarPropostas(c, { importacaoId: ped.id, contaCaixaId: caixa.id });
  await aplicarTodas36(n, "VENDA");
  const impS = await importar36(n, "STONE", "STONE_VENDAS", stoneCsv(STONE36.slice(0, 2)));
  await n.gerarPropostas(c, { importacaoId: impS.id });
  const [pS1] = (await n.listarPropostas(c, { operacao: "PAGAMENTO_STONE" })).filter((p) => p.comando.vendaId);
  assert.ok(pS1, "a transação S1 liga à venda P-1");
  await n.reconhecerTaxasDoPeriodo(c, { importacaoId: impS.id, justificativa: "Período (sintético)." });
  await n.aprovarProposta(c, { propostaId: pS1.id, justificativa: "Revisado (sintético)." });
  await rejeita(n.aplicarProposta(c, { propostaId: pS1.id }), CODIGO.CONFLITO_IDEMPOTENCIA);
  await n.estornarTaxasDoPeriodo(c, { importacaoId: impS.id, competencia: "2026-09", justificativa: "Substituição pelos pedidos (sintético)." });
  await n.aplicarProposta(c, { propostaId: pS1.id });
  const r = await n.reconhecerTaxasDoPeriodo(c, { importacaoId: impS.id, justificativa: "Período sem as vendas detalhadas (sintético)." });
  assert.deepEqual([r.resultado[0].lancamento.taxasDoPeriodo.transacoes, r.resultado[0].lancamento.valorCentavos], [1, Math.floor((686790 + 5000) / 10000)], "só a S2 (sem venda)");
  const ind = await resultado36(n);
  assert.equal(ind.RESULTADO_GERENCIAL.valorCentavos, 10000 - 390 - 69, "cada tarifa uma vez: S1 pela venda, S2 pelo período");
});
