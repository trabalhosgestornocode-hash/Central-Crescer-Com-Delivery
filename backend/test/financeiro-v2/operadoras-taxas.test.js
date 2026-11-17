// Fase 02 (doc 40) — operadoras, taxas com vigência, líquido esperado, bandeiras, Pix da maquininha do iFood, 99Food.
// Dados 100% SINTÉTICOS: nenhuma taxa real (o repositório é público; as taxas reais ficam só no cadastro da unidade).
// Roda em memória e, com FV2_REPOSITORIO=postgres, no banco isolado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { calcularTaxaEstimada, operadoraNaData, percentualEfetivo, resumoPorModalidade } from "../../src/modules/financeiro-v2/dominio/operadoras.js";
import { ORG_B, UNI_B, ctx, montar, rejeita } from "./helpers/cenario.js";

const c = ctx();
const NOVEMBRO = () => new Date("2026-11-25T15:00:00.000Z");
let seq = 0;
const fonte = () => ({ sistema: "MANUAL", idExterno: `teste:${(seq += 1)}` });

async function unidade(n, x = c) {
  const W = (k, b) => ESCRITAS[k].fazer(n, x, b);
  await W("/configuracoes/unidade", { nomeExibicao: "Unidade sintética", justificativa: "Teste." });
  return W;
}
const operadora = (codigo, processador, inicio, extra = {}) => ({ codigo, nome: codigo, processador, inicio, modalidades: "DEBITO,CREDITO_A_VISTA,PIX,VOUCHER", justificativa: "Cadastro sintético.", ...extra });
const tabela = (operadora, vigenciaInicio, taxas, extra = {}) => ({ operadora, vigenciaInicio, fonte: "Contrato sintético", taxas: taxas.join("\n"), justificativa: "Tabela sintética.", ...extra });
const venda = (n, { data, canal = "BALCAO", forma, processador, bandeira, operadora: op, valor, x = c }) => n.registrarVenda(x, {
  canal, dataVenda: data, brutoCentavos: valor, fonte: fonte(),
  pagamentos: [{ forma, valorCentavos: valor, ...(processador ? { processador } : {}), ...(bandeira ? { bandeira } : {}), ...(op ? { operadora: op } : {}) }],
});
const taxaDe = (r) => r.pagamentos[0].taxaEstimada;

test("cálculo: 0,80% de R$ 1.000,00 = R$ 8,00 → líquido R$ 992,00; meio-centavo arredonda para cima; tarifa fixa soma", () => {
  const config = { taxasContratadas: [{ processador: "MAQUININHA_IFOOD", vigenciaInicio: "2026-11-01", vigenciaFim: null, taxas: [{ modalidade: "PIX", bandeira: "PIX", milesimos: 800 }] }] };
  const t = calcularTaxaEstimada({ config, data: "2026-11-10", processador: "MAQUININHA_IFOOD", forma: "PIX", brutoCentavos: 100000 });
  assert.deepEqual([t.situacao, t.taxaCentavos, t.liquidoEsperadoCentavos, t.operadora, t.versao.milesimos], ["CALCULADA", 800, 99200, "MAQUININHA_IFOOD", 800]);
  // 1,99% de R$ 10,05 = 0,199995 → R$ 0,20 (meio-para-cima no centavo)
  const c2 = { taxasContratadas: [{ processador: "STONE", vigenciaInicio: "2026-01-01", taxas: [{ modalidade: "DEBITO", bandeira: "VISA", milesimos: 1990 }, { modalidade: "PIX", bandeira: "PIX", milesimos: 0, tarifaFixaCentavos: 9 }] }] };
  assert.equal(calcularTaxaEstimada({ config: c2, data: "2026-11-10", processador: "STONE", forma: "DEBITO", bandeira: "VISA", brutoCentavos: 1005 }).taxaCentavos, 20);
  assert.equal(calcularTaxaEstimada({ config: c2, data: "2026-11-10", processador: "STONE", forma: "PIX", brutoCentavos: 5000 }).taxaCentavos, 9);
  // Percentual efetivo dos TOTAIS (não média): 8,00 + 0,20 sobre 1.010,05 → 0,81%
  assert.equal(percentualEfetivo(820, 101005), 81);
});

test("taxa desconhecida nunca é zero: sem tabela, sem bandeira na tabela, operadora ausente ou inativa", () => {
  const base = { data: "2026-11-10", processador: "STONE", forma: "DEBITO", bandeira: "ELO", brutoCentavos: 1000 };
  assert.equal(calcularTaxaEstimada({ ...base, config: null }).situacao, "SEM_OPERADORA");
  const config = { taxasContratadas: [{ processador: "STONE", vigenciaInicio: "2026-12-01", taxas: [{ modalidade: "DEBITO", bandeira: "VISA", milesimos: 1000 }] }] };
  assert.equal(calcularTaxaEstimada({ ...base, config }).situacao, "SEM_TABELA_VIGENTE");
  const vigente = { taxasContratadas: [{ ...config.taxasContratadas[0], vigenciaInicio: "2026-01-01" }] };
  const t = calcularTaxaEstimada({ ...base, config: vigente });
  assert.deepEqual([t.situacao, t.taxaCentavos, t.liquidoEsperadoCentavos], ["TAXA_NAO_CONFIGURADA", null, null]);
  assert.equal(calcularTaxaEstimada({ ...base, config: vigente, forma: "DINHEIRO", processador: null }).situacao, "NAO_SE_APLICA");
});

test("vigência: a venda usa a tabela vigente NA DATA DA VENDA; a versão usada fica gravada e não muda com tabela nova", async () => {
  const { nucleo: n } = montar({ relogio: NOVEMBRO });
  const W = await unidade(n);
  await W("/configuracoes/taxas-contratadas", tabela("STONE", "2026-09-01", ["DEBITO;MASTER;1,00"], { vigenciaFim: "2026-11-15" }));
  await W("/configuracoes/taxas-contratadas", tabela("STONE", "2026-11-16", ["DEBITO;MASTER;2,00"]));
  const antes = await venda(n, { data: "2026-11-15", forma: "DEBITO", processador: "STONE", bandeira: "Master", valor: 10000 });
  const depois = await venda(n, { data: "2026-11-16", forma: "DEBITO", processador: "STONE", bandeira: "Mastercard", valor: 10000 });
  assert.deepEqual([taxaDe(antes).taxaCentavos, taxaDe(antes).versao.vigenciaInicio], [100, "2026-09-01"]);
  assert.deepEqual([taxaDe(depois).taxaCentavos, taxaDe(depois).versao.vigenciaInicio], [200, "2026-11-16"]);
  assert.equal(antes.pagamentos[0].bandeira, "MASTERCARD");
  // Encerrar a vigência atual e abrir outra não altera o que já foi gravado (sem recálculo retroativo).
  const lista = await n.consultarLiquidoEsperado(c, { periodoInicio: "2026-11-01", periodoFim: "2026-11-30" });
  const debito = lista.modalidades.find((m) => m.modalidade === "DEBITO");
  assert.deepEqual([debito.brutoCentavos, debito.taxaCentavos, debito.liquidoEsperadoCentavos, debito.percentualEfetivoCentesimos], [20000, 300, 19700, 150]);
});

test("operadoras: Stone encerrada e PagBank depois; simultâneas viram ambiguidade; desativar preserva histórico", async () => {
  const { nucleo: n } = montar({ relogio: NOVEMBRO });
  const W = await unidade(n);
  await W("/configuracoes/operadoras", operadora("STONE", "STONE", "2026-01-01", { encerramento: "2026-11-10" }));
  await W("/configuracoes/operadoras", operadora("PAGBANK", "PAGBANK", "2026-11-11"));
  const cfg = { operadoras: (await n.consultarOperadoras(c)).operadoras };
  assert.equal(operadoraNaData({ config: cfg, data: "2026-11-10", forma: "CREDITO" }).operadora, "STONE");
  assert.equal(operadoraNaData({ config: cfg, data: "2026-11-11", forma: "CREDITO" }).operadora, "PAGBANK");
  // Repetir o cadastro igual não faz nada; com dados diferentes, recusa (não sobrescreve).
  assert.equal((await W("/configuracoes/operadoras", operadora("PAGBANK", "PAGBANK", "2026-11-11"))).repetido, true);
  await rejeita(W("/configuracoes/operadoras", operadora("PAGBANK", "PAGBANK", "2026-11-12")), CODIGO.OPERACAO_INVALIDA);
  // Reabrir a Stone sem encerramento → duas ativas ao mesmo tempo → ambígua (conferência), nunca escolha arbitrária.
  await W("/configuracoes/operadoras/situacao", { codigo: "STONE", encerramento: "", justificativa: "Stone segue ativa junto com a PagBank." });
  const ambas = { operadoras: (await n.consultarOperadoras(c)).operadoras };
  const r = operadoraNaData({ config: ambas, data: "2026-11-20", forma: "DEBITO" });
  assert.deepEqual([r.situacao, r.candidatas], ["OPERADORA_AMBIGUA", ["PAGBANK", "STONE"]]);
  // Desativar mantém o registro e o histórico.
  await W("/configuracoes/operadoras/situacao", { codigo: "PAGBANK", situacao: "INATIVA", justificativa: "Teste de desativação." });
  const pag = (await n.consultarOperadoras(c)).operadoras.find((o) => o.codigo === "PAGBANK");
  assert.deepEqual([pag.situacao, pag.historico.length], ["INATIVA", 2]);
  assert.equal(operadoraNaData({ config: { operadoras: (await n.consultarOperadoras(c)).operadoras }, data: "2026-11-20", forma: "DEBITO" }).operadora, "STONE");
  // Venda com operadora explícita inativa na data → não calcula.
  await W("/configuracoes/taxas-contratadas", tabela("PAGBANK", "2026-11-11", ["DEBITO;VISA;1,00"]));
  const v = await venda(n, { data: "2026-11-20", forma: "DEBITO", processador: "PAGBANK", bandeira: "Visa", operadora: "PAGBANK", valor: 1000 });
  assert.equal(taxaDe(v).situacao, "OPERADORA_INATIVA_NA_DATA");
});

test("Pix da maquininha do iFood: taxa própria na venda PRESENCIAL; não vira canal iFood; não vale para 'Pix na Entrega' (Stone)", async () => {
  const { nucleo: n } = montar({ relogio: NOVEMBRO });
  const W = await unidade(n);
  await W("/configuracoes/operadoras", operadora("MAQUININHA_IFOOD", "MAQUININHA_IFOOD", "2026-11-01", { modalidades: "PIX", nome: "Maquininha do iFood (presencial)" }));
  await W("/configuracoes/taxas-contratadas", tabela("MAQUININHA_IFOOD", "2026-11-01", ["PIX;PIX;0,80"]));
  const pix = await venda(n, { data: "2026-11-10", forma: "PIX", processador: "MAQUININHA_IFOOD", valor: 100000 });
  assert.deepEqual([pix.venda.canal, taxaDe(pix).taxaCentavos, taxaDe(pix).liquidoEsperadoCentavos, pix.recebiveis[0].processador], ["BALCAO", 800, 99200, "MAQUININHA_IFOOD"]);
  // Pix pela Stone (ex.: "Pix na Entrega") não herda a taxa da maquininha do iFood: sem operadora/tabela Stone → sem cálculo.
  const naEntrega = await venda(n, { data: "2026-11-10", forma: "PIX", processador: "STONE", valor: 5000 });
  assert.equal(taxaDe(naEntrega).situacao, "SEM_OPERADORA");
  // Estimativa não é despesa: a DRE só tem as receitas; nenhuma despesa nasceu das taxas estimadas.
  const comp = (indicador) => n.consultarComposicao(c, { competencia: "2026-11", indicador });
  assert.equal((await comp("RECEITA_BRUTA")).totalCentavos, 105000);
  assert.equal((await comp("DESPESAS")).totalCentavos, 0);
  // Canal iFood (marketplace) segue sem nada.
  const ifood = await n.consultarLiquidoEsperado(c, { periodoInicio: "2026-11-01", periodoFim: "2026-11-30", canal: "IFOOD" });
  assert.equal(ifood.modalidades.length, 0);
});

test("bandeiras: só em débito/crédito/vale; normalizadas; crédito é à vista; card agrupa por bandeira", async () => {
  const { nucleo: n } = montar({ relogio: NOVEMBRO });
  const W = await unidade(n);
  await W("/configuracoes/taxas-contratadas", tabela("STONE", "2026-11-01", ["DEBITO;MASTERCARD;1,00", "CREDITO_A_VISTA;VISA;3,00", "VOUCHER;ALELO;5,00"]));
  await rejeita(venda(n, { data: "2026-11-05", forma: "PIX", processador: "STONE", bandeira: "Visa", valor: 1000 }), CODIGO.ENTRADA_INVALIDA);
  await venda(n, { data: "2026-11-05", forma: "DEBITO", processador: "STONE", bandeira: "MASTER", valor: 10000 });
  await venda(n, { data: "2026-11-05", forma: "CREDITO", processador: "STONE", bandeira: "visa", valor: 10000 });
  await venda(n, { data: "2026-11-05", forma: "CREDITO", processador: "STONE", bandeira: "Elo", valor: 10000 });
  await venda(n, { data: "2026-11-05", forma: "VALE", processador: "STONE", bandeira: "Alelo", valor: 2000 });
  const r = await n.consultarLiquidoEsperado(c, { periodoInicio: "2026-11-01", periodoFim: "2026-11-30" });
  const credito = r.modalidades.find((m) => m.modalidade === "CREDITO_A_VISTA");
  assert.deepEqual(credito.bandeiras.map((b) => [b.bandeira, b.situacao, b.taxaCentavos]), [["ELO", "PENDENTE", 0], ["VISA", "CALCULADO", 300]]);
  assert.deepEqual([credito.situacao, credito.brutoSemCalculoCentavos, credito.liquidoEsperadoCentavos], ["PARCIAL", 10000, 9700]);
  assert.equal(r.modalidades.find((m) => m.modalidade === "VOUCHER").taxaCentavos, 100);
  assert.equal(r.natureza, "ESTIMATIVA");
});

test("99Food é canal próprio: receita na categoria da 99Food, separada dos demais canais", async () => {
  const { nucleo: n } = montar({ relogio: NOVEMBRO });
  await unidade(n);
  const v = await venda(n, { data: "2026-11-05", canal: "NOVENTA_E_NOVE_FOOD", forma: "OUTRA", processador: "NOVENTA_E_NOVE_FOOD", valor: 4590 });
  assert.equal(v.venda.canal, "NOVENTA_E_NOVE_FOOD");
  assert.equal(taxaDe(v), undefined); // repasse de marketplace: sem taxa de adquirente
  const receita = await n.consultarComposicao(c, { competencia: "2026-11", indicador: "RECEITA_BRUTA" });
  assert.equal(receita.totalCentavos, 4590);
  assert.ok(JSON.stringify(receita).includes("VENDA_NOVENTA_E_NOVE_FOOD") || JSON.stringify(receita).includes("99Food"));
});

test("isolamento: operadoras e taxas de uma unidade não valem em outra empresa/unidade", async () => {
  const { nucleo: n } = montar({ relogio: NOVEMBRO });
  const W = await unidade(n);
  await W("/configuracoes/taxas-contratadas", tabela("STONE", "2026-11-01", ["DEBITO;VISA;1,00"]));
  const outra = ctx(ORG_B, UNI_B);
  await unidade(n, outra);
  const vB = await venda(n, { data: "2026-11-05", forma: "DEBITO", processador: "STONE", bandeira: "Visa", valor: 10000, x: outra });
  assert.equal(taxaDe(vB).situacao, "SEM_OPERADORA");
  assert.equal((await n.consultarOperadoras(outra)).operadoras.length, 0);
  assert.equal((await n.consultarOperadoras(c)).operadoras.length, 1);
});

test("sem duplicação: repetir a venda (mesma fonte) e as tabelas não cria nada novo nem soma de novo", async () => {
  const { nucleo: n } = montar({ relogio: NOVEMBRO });
  const W = await unidade(n);
  const t = tabela("STONE", "2026-11-01", ["DEBITO;VISA;1,00"]);
  assert.equal((await W("/configuracoes/taxas-contratadas", t)).repetido, false);
  assert.equal((await W("/configuracoes/taxas-contratadas", t)).repetido, true);
  const cmd = { canal: "BALCAO", dataVenda: "2026-11-05", brutoCentavos: 10000, fonte: { sistema: "MANUAL", idExterno: "teste:repetida" }, pagamentos: [{ forma: "DEBITO", processador: "STONE", bandeira: "Visa", valorCentavos: 10000 }] };
  const a = await n.registrarVenda(c, cmd);
  const b = await n.registrarVenda(c, cmd);
  assert.deepEqual([b.repetido, b.venda.id], [true, a.venda.id]);
  const r = await n.consultarLiquidoEsperado(c, { periodoInicio: "2026-11-01", periodoFim: "2026-11-30" });
  assert.deepEqual([r.modalidades[0].quantidade, r.modalidades[0].taxaCentavos], [1, 100]);
});

test("resumo: percentual efetivo vem dos totais e bruto sem cálculo nunca vira taxa zero", () => {
  const r = resumoPorModalidade([
    { modalidade: "DEBITO", bandeira: "VISA", brutoCentavos: 10000, situacao: "CALCULADA", taxaCentavos: 100 },
    { modalidade: "DEBITO", bandeira: "MASTERCARD", brutoCentavos: 30000, situacao: "CALCULADA", taxaCentavos: 600 },
    { modalidade: "DEBITO", bandeira: "ELO", brutoCentavos: 5000, situacao: "TAXA_NAO_CONFIGURADA", taxaCentavos: null },
  ]);
  // (100 + 600) / (10000 + 30000) = 1,75% — a média simples (1,00 e 2,00) daria 1,50%.
  assert.deepEqual([r[0].percentualEfetivoCentesimos, r[0].brutoSemCalculoCentavos, r[0].situacao], [175, 5000, "PARCIAL"]);
});
