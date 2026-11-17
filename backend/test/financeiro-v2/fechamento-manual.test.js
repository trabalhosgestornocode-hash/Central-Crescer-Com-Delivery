// Fase 04 (doc 42) — fechamento manual de caixa: registro, vários caixas, correção auditada, comparação com a importação,
// nenhuma receita duplicada e isolamento. Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { calcularFechamento, validarFechamentoManual } from "../../src/modules/financeiro-v2/dominio/fechamentoManual.js";
import { ORG_B, UNI_B, ctx, montar, rejeita } from "./helpers/cenario.js";
import { xlsx } from "./helpers/formatos.js";

const c = ctx();
const NOVEMBRO = () => new Date("2026-11-25T15:00:00.000Z");
const W = (n, k, b, x = c) => ESCRITAS[k].fazer(n, x, b);
const fechar = (n, extra = {}, x = c) => W(n, "/fechamento-manual/registrar", {
  data: "2026-11-05", caixa: "1", responsavelAbertura: "Pessoa A", responsavelFechamento: "Pessoa B", horaAbertura: "10:00", horaFechamento: "23:00",
  din_abertura: "100,00", din_vendas: "50,00", din_retiradas: "30,00", din_reforcos: "10,00", din_transferencias: "0", din_informado: "128,00",
  f_CREDITO_VISA_inf: "40,00", f_DEBITO_MASTERCARD_inf: "20,00", f_PIX_MAQUININHA_IFOOD_inf: "100,00", f_ANOTA_AI_inf: "45,00", f_IFOOD_CONFERENCIA_inf: "60,00", ...extra,
}, x);
const receita = async (n, x = c) => (await n.consultarComposicao(x, { competencia: "2026-11", indicador: "RECEITA_BRUTA" })).totalCentavos;

test("cálculo: dinheiro esperado = abertura + vendas + reforços − retiradas − transferências; diferença = informado − esperado", () => {
  const f = validarFechamentoManual({ data: "2026-11-05", caixa: "1", dinheiro: { aberturaCentavos: 10000, vendasCentavos: 5000, retiradasCentavos: 3000, reforcosCentavos: 1000, transferenciasCentavos: 0, informadoCentavos: 12800 },
    formas: [{ grupo: "CREDITO", bandeira: "Master", informadoCentavos: 4000, esperadoCentavos: 4100 }, { grupo: "IFOOD_CONFERENCIA", informadoCentavos: 999 }] });
  const r = calcularFechamento(f);
  assert.deepEqual([r.dinheiro.esperadoCentavos, r.dinheiro.diferencaCentavos], [13000, -200]);
  assert.deepEqual([r.formas[0].bandeira, r.formas[0].diferencaCentavos], ["MASTERCARD", -100]);
  assert.deepEqual(r.totais, { presencialCentavos: 9000, anotaAiCentavos: 0, soConferenciaCentavos: 999 });
  assert.throws(() => validarFechamentoManual({ data: "2026-11-05", caixa: "1", formas: [{ grupo: "CREDITO", bandeira: "Visa", informadoCentavos: 1 }, { grupo: "CREDITO", bandeira: "VISA", informadoCentavos: 2 }] }), /duas vezes/);
  assert.throws(() => validarFechamentoManual({ data: "2026-11-05", caixa: "1", horaAbertura: "25:00" }), /HH:MM/);
});

test("registro: vários caixas no mesmo dia; repetir igual não duplica; corrigir exige justificativa e guarda a versão anterior", async () => {
  const { nucleo: n } = montar({ relogio: NOVEMBRO });
  const a = await fechar(n);
  assert.equal(a.repetido, false);
  assert.equal((await fechar(n)).repetido, true);
  await fechar(n, { caixa: "2", din_vendas: "5,00", din_informado: "105,00" });
  await rejeita(fechar(n, { din_informado: "129,00" }), CODIGO.ENTRADA_INVALIDA); // mudou sem justificativa
  const corr = await fechar(n, { din_informado: "129,00", justificativa: "Contagem refeita (sintético)." });
  assert.equal(corr.corrigido, true);
  assert.equal(corr.fechamento.versao, 2);
  assert.equal(corr.fechamento.dados.dinheiro.diferencaCentavos, -100);
  const r = await n.consultarFechamentoManual(c, { periodoInicio: "2026-11-01", periodoFim: "2026-11-30" });
  assert.deepEqual(r.dias.map((d) => [d.data, d.fechamentos.length, d.situacao]), [["2026-11-05", 2, "SO_FECHAMENTO_MANUAL"]]);
  await rejeita(fechar(n, { data: "2026-11-30" }), CODIGO.DATA_INVALIDA); // futuro
});

test("sem relatório importado: o fechamento fica registrado como manual e NÃO entra no faturamento", async () => {
  const { nucleo: n } = montar({ relogio: NOVEMBRO });
  await fechar(n);
  assert.equal(await receita(n), 0);
  const [dia] = (await n.consultarFechamentoManual(c, { periodoInicio: "2026-11-05", periodoFim: "2026-11-05" })).dias;
  assert.match(dia.observacao, /NÃO entra no faturamento/);
});

// Planilha sintética no layout real (doc 41) para o mesmo dia do fechamento.
const CAB = ["Pedido", "Código da loja", "Nome da loja", "Tipo do pedido", "Turno", "Canal de venda", "Id do pedido no parceiro", "Número do pedido no parceiro", "Data da venda", "Consumidor", "Tem cupom", "Pagamento", "Está cancelado", "Motivo do cancelamento", "Itens", "Entrega", "Valor Entregador", "Entregador", "Bairro", "CEP", "Acréscimo", "Motivo de acréscimo", "Desconto", "Motivo do desconto", "Total", "Total taxa de serviço"];
const ficha = (hora, pagamento, v) => ["Ficha", null, null, "F", "Dia", null, null, null, `05/11/2026 ${hora}`, "Consumidor não identificado", "N", pagamento, "N", null, v, null, null, null, null, "", 0, "", 0, "", v, 0];
const anota = (v) => [1, "loja", "Loja", "D", "Dia", "Anota.ai", "00000000-0000-4000-8000-000000000099", "77", "05/11/2026 20:00", "Cliente", "N", "Online Anotaai", "N", null, v, 0, 0, null, "B", "0", 0, null, 0, null, v, 0];

test("com relatório importado: compara por forma/bandeira/operadora, aponta divergências e não soma receita", async () => {
  const { nucleo: n } = montar({ relogio: NOVEMBRO });
  await W(n, "/configuracoes/unidade", { nomeExibicao: "U", justificativa: "Teste." });
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  await fechar(n);
  const conteudo = xlsx([{ nome: "Vendas por período", linhas: [CAB, ficha("12:00", "Dinheiro", 50), ficha("12:10", "Crédito Visa", 40), ficha("12:20", "Débito Master", 25), ficha("12:30", "Pago Online via Pix", 100), anota(45)] }]);
  const r = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "application/octet-stream", conteudo, periodoInicio: "2026-11-05", periodoFim: "2026-11-05" });
  const imp = (await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? { aceitarPendencias: true, justificativa: "x" } : {}) })).importacao;
  await n.gerarPropostas(c, { importacaoId: imp.id, contaCaixaId: caixa.id });
  await W(n, "/propostas/aprovar-e-aplicar-prontas", { importacao: imp.id });
  assert.equal(await receita(n), 5000 + 4000 + 2500 + 10000 + 4500, "só as vendas importadas: o fechamento não soma");
  const [dia] = (await n.consultarFechamentoManual(c, { periodoInicio: "2026-11-05", periodoFim: "2026-11-05" })).dias;
  assert.equal(dia.temImportacao, true);
  const linha = (g, s = null) => dia.comparacao.find((l) => l.grupo === g && l.sub === s);
  assert.deepEqual([linha("DINHEIRO").situacao, linha("CREDITO", "VISA").situacao, linha("ANOTA_AI").situacao], ["CONFERE", "CONFERE", "CONFERE"]);
  assert.deepEqual([linha("DEBITO", "MASTERCARD").situacao, linha("DEBITO", "MASTERCARD").diferencaCentavos], ["DIVERGENTE", -500]);
  assert.equal(linha("PIX", "MAQUININHA_IFOOD").situacao, "CONFERE");
  assert.equal(dia.comparacao.some((l) => l.grupo === "IFOOD_CONFERENCIA"), false, "iFood do caixa é só conferência: fora da comparação de faturamento");
  assert.equal(dia.situacao, "DIVERGENTE");
});

test("isolamento e permissão: outra unidade não vê; sem permissão de registrar, recusa", async () => {
  const { nucleo: n } = montar({ relogio: NOVEMBRO });
  await fechar(n);
  const outra = ctx(ORG_B, UNI_B);
  assert.equal((await n.consultarFechamentoManual(outra, { periodoInicio: "2026-11-01", periodoFim: "2026-11-30" })).dias.length, 0);
  const soLeitura = ctx(undefined, undefined, ["financeiro_v2.ver"]);
  await rejeita(fechar(n, { caixa: "9" }, soLeitura), CODIGO.PERMISSAO_INSUFICIENTE);
});

test("comparação: voucher importado sem bandeira compara o total do dia; zero informado sem venda confere", async () => {
  const { compararDia } = await import("../../src/modules/financeiro-v2/dominio/fechamentoManual.js");
  const fechamentos = [{ dados: { dinheiro: { vendasCentavos: 0 }, formas: [{ grupo: "VOUCHER", bandeira: "ALELO", informadoCentavos: 1500 }, { grupo: "VOUCHER", bandeira: "OUTRA", informadoCentavos: 1000 }] } }];
  const vendas = [{ canal: "BALCAO", fonte: { sistema: "SAIPOS" }, brutoCentavos: 2500, pagamentos: [{ forma: "VALE", valorCentavos: 2500 }] }];
  const r = compararDia({ fechamentos, vendas });
  assert.deepEqual(r.comparacao.map((l) => [l.grupo, l.sub, l.situacao]), [["DINHEIRO", null, "CONFERE"], ["VOUCHER", "TODAS", "CONFERE"]]);
  assert.equal(r.situacao, "CONFERE");
});
