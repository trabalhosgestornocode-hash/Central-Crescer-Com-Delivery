// Movimentações de Frente de Caixa da SAIPOS (sangria, reforço, transferência): importação pelo importador de sempre,
// conferência com o fechamento manual e calendário. NADA aqui é faturamento. Dados 100% SINTÉTICOS (mesma forma do export real
// "Financeiro", valores inventados). Roda em memória e no PostgreSQL local. Hoje (relógio do teste) = 25/11/2026.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { classificarMovimentoDeCaixa } from "../../src/modules/financeiro-v2/importacao/fontes/saipos.js";
import { compararComFechamento } from "../../src/modules/financeiro-v2/aplicacao/movimentosDeCaixa.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { CONSULTAS } from "../../src/modules/fv2-integracao/consultas.js";
import { ORG_A, ORG_B, UNI_A, UNI_A2, UNI_B, ctx, montar, rejeita } from "./helpers/cenario.js";
import { xlsx } from "./helpers/formatos.js";

const c = ctx();
const HOJE = () => new Date("2026-11-25T15:00:00.000Z");
const CAB = ["Vencimento", "Emissão", "Pagamento", "Conta", "Método de Pagamento", "Categoria", "Valor", "Pago", "Fornecedor", "Descrição"];
const linha = (dia, valor, descricao = "Retirada de Frente de Caixa", { conta = "Cofre", categoria = "Frente de Caixa", pago = "Sim" } = {}) => {
  const d = `${dia}/11/2026`;
  return [d, d, d, conta, null, categoria, valor, pago, null, descricao];
};
const planilha = (linhas) => xlsx([{ nome: "Financeiro 01Nov-17Nov", linhas: [CAB, ...linhas] }]);
const aBase64 = (bytes) => Buffer.from(bytes).toString("base64");
/** 9 retiradas em 7 dias (08 e 12 têm duas): total R$ 361,75. */
const RETIRADAS = () => [linha("04", 20), linha("06", 75.5), linha("08", 100), linha("08", 40), linha("09", 18), linha("11", 12.25), linha("12", 25), linha("12", 26), linha("15", 45)];
const TOTAL_RETIRADAS = 36175;

async function unidade() {
  const { nucleo: n } = montar({ relogio: HOJE });
  const W = (k, b, x = c) => ESCRITAS[k].fazer(n, x, b);
  await W("/configuracoes/unidade", { nomeExibicao: "Unidade sintética", justificativa: "Teste." });
  const subir = (linhas, inicio = "2026-11-01", fim = "2026-11-17", x = c) => W("/importacao/receber", { tipoRelatorio: "SAIPOS_MOVIMENTOS_CAIXA", periodoInicio: inicio, periodoFim: fim, arquivoBase64: aBase64(planilha(linhas)), nomeArquivo: "financeiro.xlsx" }, x);
  const confirmar = async (importacao, extra = {}) => (await n.confirmarImportacao(c, { importacaoId: importacao.id, impressaoPrevia: importacao.impressaoPrevia, aceitarPendencias: true, justificativa: "Pendências sintéticas aceitas.", ...extra })).importacao;
  const movimentos = (inicio = "2026-11-01", fim = "2026-11-30", x = c) => CONSULTAS["/movimentos-caixa"](n, x, { periodoInicio: inicio, periodoFim: fim });
  const fechamento = (inicio = "2026-11-01", fim = "2026-11-30", x = c) => CONSULTAS["/fechamento-manual"](n, x, { periodoInicio: inicio, periodoFim: fim });
  const calendario = (k = "BALCAO", mes = "2026-11") => CONSULTAS["/calendario-faturamento"](n, c, { canal: k, mes });
  return { n, W, subir, confirmar, movimentos, fechamento, calendario };
}
const efeitoFinanceiro = async (n) => ({
  vendas: (await n.consultarRegistros(c, { tipo: "VENDA" })).length, lancamentos: (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).length,
  movimentacoes: (await n.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).length, recebiveis: (await n.consultarRegistros(c, { tipo: "RECEBIVEL" })).length,
});

test("classificação: só reconhece com descrição + conta Cofre + categoria Frente de Caixa + sinal coerente; o resto é pendência (nunca palpite)", () => {
  const k = (descricao, valorCentavos, conta = "Cofre", categoria = "Frente de Caixa") => classificarMovimentoDeCaixa({ descricao, conta, categoria, valorCentavos }).natureza;
  assert.equal(k("Retirada de Frente de Caixa", 1250), "SANGRIA");
  assert.equal(k("RETIRADA DE FRENTE DE CAIXA", 100), "SANGRIA", "maiúsculas e acentos não importam");
  assert.equal(k("Reforço de Frente de Caixa", -2000), "REFORCO");
  assert.equal(k("Transferência entre caixas", 500), "TRANSFERENCIA");
  assert.equal(k("Retirada de Frente de Caixa", -1250), "DESCONHECIDA", "sinal contradiz: não presume");
  assert.equal(k("Reforço de Frente de Caixa", 2000), "DESCONHECIDA");
  assert.equal(k("Retirada de Frente de Caixa", 1250, "Banco"), "DESCONHECIDA", "conta que não é o Cofre");
  assert.equal(k("Retirada de Frente de Caixa", 1250, "Cofre", "Fornecedores"), "DESCONHECIDA", "categoria que não é Frente de Caixa: não toda categoria é sangria");
  assert.equal(k("Caixa - Loja - Dinheiro - 06/11/2026", -1234), "DESCONHECIDA");
  assert.equal(k("Retirada de Frente de Caixa", 0), "DESCONHECIDA");
  assert.deepEqual(["SO_IMPORTADO", "SO_MANUAL", "POSSIVEL_DUPLICIDADE", "DIVERGENTE", null], [compararComFechamento(100, null), compararComFechamento(null, 100), compararComFechamento(100, 100), compararComFechamento(100, 90), compararComFechamento(0, 0)]);
});

test("o formato aparece na página SAIPOS como leitor real (XLSX homologado) e é aceito pela camada HTTP", async () => {
  const { n } = await unidade();
  const s = await CONSULTAS["/importacoes-canal"](n, c, { canal: "SAIPOS" });
  const f = s.formatos.find((x) => x.id === "SAIPOS_MOVIMENTOS_CAIXA");
  assert.ok(f && f.disponivel && f.aceitaArquivo && f.homologado && !f.principal);
  assert.deepEqual(f.extensoesHomologadas, ["xlsx"]);
  assert.match(f.descricao, /Importar não lança nada/);
});

test("importação: a prévia reconhece 9 retiradas, total e 7 dias; nada é gravado antes de confirmar; caixa fica pendente", async () => {
  const { n, subir, movimentos } = await unidade();
  const r = await subir(RETIRADAS());
  assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR");
  const d = await n.detalharImportacao(c, { id: r.importacao.id });
  const ctl = d.previa.controles;
  assert.deepEqual([ctl.sangrias, ctl.sangriasCentavos, ctl.diasComMovimento, ctl.desconhecidas, ctl.reforcos, ctl.transferenciasAConfirmar, ctl.naoPagas], [9, TOTAL_RETIRADAS, 7, 0, 0, 0, 0]);
  assert.equal(ctl.semCaixaIdentificado, 9, "o relatório não informa o caixa: todas ficam sem vínculo");
  assert.deepEqual([d.previa.erros.length, d.previa.validos, d.previa.rejeitados, d.previa.duplicadosNoArquivo], [0, 9, 0, 0]);
  assert.equal((await movimentos()).dias.length, 0, "a prévia não grava nada");
  assert.deepEqual(await efeitoFinanceiro(n), { vendas: 0, lancamentos: 0, movimentacoes: 0, recebiveis: 0 });
});

test("confirmar: grava os registros, soma por dia e por tipo, lista o que compõe o total, sem NENHUM efeito financeiro", async () => {
  const { n, subir, confirmar, movimentos } = await unidade();
  const antes = await efeitoFinanceiro(n);
  const dreAntes = await n.apurarCompetencia(c, { competencia: "2026-11" });
  const imp = await confirmar((await subir(RETIRADAS())).importacao);
  assert.equal(imp.estado, "IMPORTADO");
  const m = await movimentos();
  assert.deepEqual([m.totais.retiradas.quantidade, m.totais.retiradas.totalCentavos, m.totais.semCaixaIdentificado, m.dias.length], [9, TOTAL_RETIRADAS, 9, 7]);
  const d08 = m.dias.find((x) => x.data === "2026-11-08");
  assert.deepEqual([d08.retiradas.quantidade, d08.retiradas.totalCentavos], [2, 14000], "dois lançamentos no mesmo dia continuam sendo dois");
  assert.deepEqual(d08.itens.map((i) => [i.valorCentavos, i.natureza, i.vinculoComCaixa, i.caixa]), [[10000, "SANGRIA", "PENDENTE", null], [4000, "SANGRIA", "PENDENTE", null]]);
  assert.match(d08.pendenciasDeCaixa.mensagem, /não informa o caixa/);
  assert.match(m.observacao, /só viram conta quando você as lança/);
  assert.equal((await n.detalharImportacao(c, { id: imp.id })).acoes.gerarPropostas, false, "não há proposta a gerar: o botão não aparece");
  assert.deepEqual(await efeitoFinanceiro(n), antes, "nenhuma venda, lançamento, movimentação ou recebível");
  const dreDepois = await n.apurarCompetencia(c, { competencia: "2026-11" });
  assert.deepEqual(dreDepois.indicadores, dreAntes.indicadores, "a DRE não muda");
  assert.deepEqual(await n.verificarConservacao(c), []);
});

test("reimportar o mesmo arquivo não duplica; linhas idênticas no mesmo arquivo continuam sendo duas; período sobreposto reconhece o já importado", async () => {
  const { n, subir, confirmar, movimentos } = await unidade();
  await confirmar((await subir(RETIRADAS())).importacao);
  // O MESMO arquivo reenviado devolve a importação que já existe (nunca cria outra nem regrava as linhas).
  const de_novo = await subir(RETIRADAS());
  assert.equal(de_novo.repetido, true);
  assert.equal(de_novo.importacao.estado, "IMPORTADO");
  assert.equal((await movimentos()).totais.retiradas.quantidade, 9, "continua 9");
  // Arquivo DIFERENTE de período sobreposto (11 a 17/11): o que já foi importado é reconhecido; só a retirada nova entra.
  const sobreposto = await subir([linha("11", 12.25), linha("12", 25), linha("12", 26), linha("15", 45), linha("16", 33)], "2026-11-10", "2026-11-17");
  const d = await n.detalharImportacao(c, { id: sobreposto.importacao.id });
  assert.deepEqual([d.previa.jaExistentes, d.previa.validos], [4, 1], "4 já importadas, 1 nova");
  await confirmar(sobreposto.importacao);
  const m = await movimentos();
  assert.deepEqual([m.totais.retiradas.quantidade, m.totais.retiradas.totalCentavos], [10, TOTAL_RETIRADAS + 3300], "só a nova somou");
  // Duas retiradas idênticas (mesmo dia e valor) no mesmo arquivo: duas, nunca fundidas.
  const dois = await unidade();
  await dois.confirmar((await dois.subir([linha("05", 10), linha("05", 10)])).importacao);
  const iguais = await dois.movimentos();
  assert.deepEqual([iguais.totais.retiradas.quantidade, iguais.totais.retiradas.totalCentavos], [2, 2000]);
});

test("reforço e movimento desconhecido: reforço entra nos totais; o desconhecido fica pendente e FORA dos totais, com o original preservado", async () => {
  const { n, subir, confirmar, movimentos } = await unidade();
  const prev = await subir([linha("06", -20, "Reforço de Frente de Caixa"), linha("06", -12.34, "Caixa - Loja - Dinheiro - 06/11/2026"), linha("07", 15, "Retirada de Frente de Caixa", { pago: "Não" })]);
  const d = await n.detalharImportacao(c, { id: prev.importacao.id });
  const ctl = d.previa.controles;
  assert.deepEqual([ctl.reforcos, ctl.reforcosCentavos, ctl.desconhecidas, ctl.naoPagas, ctl.sangrias], [1, 2000, 1, 1, 0]);
  assert.ok(d.previa.totalDivergencias >= 2, "o desconhecido e o não pago viram pendência na prévia");
  assert.ok(d.previa.divergencias.some((x) => x.codigo === "VALOR_A_CLASSIFICAR"));
  // Sem aceitar as pendências a confirmação é recusada (conferência das classificações).
  await rejeita(n.confirmarImportacao(c, { importacaoId: prev.importacao.id, impressaoPrevia: prev.importacao.impressaoPrevia, aceitarPendencias: false }), CODIGO.ENTRADA_INVALIDA).catch(() => null);
  const antes = await efeitoFinanceiro(n);
  const dreAntes = await n.apurarCompetencia(c, { competencia: "2026-11" });
  await confirmar(prev.importacao);
  assert.deepEqual(await efeitoFinanceiro(n), antes, "reforço não cria receita; sangria não cria despesa; nada vira lançamento");
  assert.deepEqual((await n.apurarCompetencia(c, { competencia: "2026-11" })).indicadores, dreAntes.indicadores, "a DRE não muda");
  const m = await movimentos();
  const d06 = m.dias.find((x) => x.data === "2026-11-06");
  assert.deepEqual([d06.reforcos.totalCentavos, d06.desconhecidas.quantidade, d06.desconhecidas.totalCentavos, d06.retiradas.totalCentavos], [2000, 1, 1234, 0]);
  assert.ok(d06.divergencias.some((x) => x.codigo === "MOVIMENTO_A_CLASSIFICAR"));
  const original = d06.itens.find((i) => i.natureza === "DESCONHECIDA");
  assert.deepEqual([original.descricao, original.considerar], ["Caixa - Loja - Dinheiro - 06/11/2026", false], "a descrição original é preservada");
  const d07 = m.dias.find((x) => x.data === "2026-11-07");
  assert.equal(d07.retiradas.totalCentavos, 0, "não pago fica fora dos totais");
  assert.ok(d07.divergencias.some((x) => x.codigo === "MOVIMENTO_NAO_PAGO"));
});

test("fechamento manual: igual vira POSSÍVEL DUPLICIDADE (usado uma vez), diferente vira divergência e bloqueia o cálculo, só importado entra sozinho", async () => {
  const { n, subir, confirmar, fechamento } = await unidade();
  await confirmar((await subir(RETIRADAS())).importacao);
  const fecha = (data, dinheiro) => n.registrarFechamentoManual(c, { data, caixa: "Caixa 1", dinheiro, formas: [] });
  // 08/11: manual igual ao importado (R$ 140,00) → possível duplicidade; abertura 50 + vendas 300 − 140 = esperado 210; informado 210 → confere.
  await fecha("2026-11-08", { aberturaCentavos: 5000, vendasCentavos: 30000, retiradasCentavos: 14000, informadoCentavos: 21000 });
  // 09/11: manual diferente (R$ 10,00 × importado R$ 18,00) → divergência; esperado NÃO calculado.
  await fecha("2026-11-09", { aberturaCentavos: 0, vendasCentavos: 5000, retiradasCentavos: 1000, informadoCentavos: 4000 });
  // 11/11: manual sem retiradas → só importado entra (R$ 12,25).
  await fecha("2026-11-11", { aberturaCentavos: 0, vendasCentavos: 4000, informadoCentavos: 2775 });
  const f = await fechamento();
  const dia = (data) => f.dias.find((x) => x.data === data);
  const d08 = dia("2026-11-08");
  assert.equal(d08.movimentosDeCaixa.conferenciaComFechamento.retiradas, "POSSIVEL_DUPLICIDADE");
  assert.ok(d08.movimentosDeCaixa.alertas.some((a) => a.codigo === "POSSIVEL_DUPLICIDADE" && /uma vez só/.test(a.mensagem)));
  assert.deepEqual([d08.dinheiroDoDia.retiradasCentavos, d08.dinheiroDoDia.origem.retiradas, d08.dinheiroDoDia.esperadoCentavos, d08.dinheiroDoDia.diferencaCentavos, d08.dinheiroDoDia.situacao], [14000, "IMPORTADO_E_MANUAL_IGUAIS", 21000, 0, "CONFERE"], "a mesma retirada não é descontada duas vezes");
  const d09 = dia("2026-11-09");
  assert.equal(d09.movimentosDeCaixa.conferenciaComFechamento.retiradas, "DIVERGENTE");
  assert.deepEqual([d09.dinheiroDoDia.esperadoCentavos, d09.dinheiroDoDia.situacao], [null, "REVISAR_MOVIMENTOS"], "o sistema não escolhe um lado");
  assert.ok(d09.movimentosDeCaixa.divergencias.some((x) => x.codigo === "MOVIMENTO_DIVERGE_DO_FECHAMENTO" && x.importadoCentavos === 1800 && x.manualCentavos === 1000));
  const d11 = dia("2026-11-11");
  assert.deepEqual([d11.movimentosDeCaixa.conferenciaComFechamento.retiradas, d11.dinheiroDoDia.origem.retiradas, d11.dinheiroDoDia.retiradasCentavos, d11.dinheiroDoDia.esperadoCentavos, d11.dinheiroDoDia.diferencaCentavos], ["SO_IMPORTADO", "IMPORTADO", 1225, 2775, 0]);
  // O fechamento registrado continua exatamente como a equipe digitou (nada foi somado nem alterado).
  assert.equal(d08.fechamentos[0].dados.dinheiro.retiradasCentavos, 14000);
});

test("retirada maior que o dinheiro vendido no dia vira alerta para conferir a abertura — não é tratada como erro", async () => {
  const { n, subir, confirmar, W, movimentos, fechamento } = await unidade();
  // Venda em dinheiro de R$ 15,00 em 06/11 (relatório de vendas por pedido) e retirada de R$ 75,50 no mesmo dia.
  const CABV = ["Pedido", "Código da loja", "Nome da loja", "Tipo do pedido", "Turno", "Canal de venda", "Id do pedido no parceiro", "Número do pedido no parceiro", "Data da venda", "Consumidor", "Tem cupom", "Pagamento", "Está cancelado", "Motivo do cancelamento", "Itens", "Entrega", "Valor Entregador", "Entregador", "Bairro", "CEP", "Acréscimo", "Motivo de acréscimo", "Desconto", "Motivo do desconto", "Total", "Total taxa de serviço"];
  const ficha = ["Ficha", null, null, "F", "Dia", null, null, null, "06/11/2026 12:00", "Consumidor não identificado", "N", "Dinheiro", "N", null, 15, null, null, null, null, "", 0, "", 0, "", 15, 0];
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  const vendas = await W("/importacao/receber", { tipoRelatorio: "SAIPOS_VENDAS", periodoInicio: "2026-11-06", periodoFim: "2026-11-06", arquivoBase64: aBase64(xlsx([{ nome: "Vendas por período", linhas: [CABV, ficha] }])), nomeArquivo: "v.xlsx" });
  const impV = (await n.confirmarImportacao(c, { importacaoId: vendas.importacao.id, impressaoPrevia: vendas.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: "Sintético." })).importacao;
  await n.gerarPropostas(c, { importacaoId: impV.id, contaCaixaId: caixa.id });
  await W("/propostas/aprovar-e-aplicar-prontas", { importacao: impV.id });
  await confirmar((await subir([linha("06", 75.5)])).importacao);
  const f = await fechamento();
  const d06 = f.dias.find((x) => x.data === "2026-11-06");
  assert.equal(d06.dinheiroDoDia.vendasEmDinheiroCentavos, 1500);
  assert.ok(d06.movimentosDeCaixa.alertas.some((a) => a.codigo === "RETIRADA_ACIMA_DO_DINHEIRO_DO_DIA" && /abertura/.test(a.mensagem)));
  assert.equal(d06.movimentosDeCaixa.retiradas.totalCentavos, 7550, "o valor segue registrado como está");
  assert.equal((await movimentos()).totais.retiradas.totalCentavos, 7550);
});

test("calendário SAIPOS (Presencial): o dia mostra retiradas, total, reforços, pendência de caixa, divergências e a lista; Anota Aí não mostra; atualiza ao importar", async () => {
  const { subir, confirmar, calendario } = await unidade();
  const antes = await calendario("BALCAO");
  assert.equal(antes.dias.find((d) => d.data === "2026-11-08").movimentosDeCaixa, null, "sem importação não há bloco");
  await confirmar((await subir([...RETIRADAS(), linha("08", -30, "Reforço de Frente de Caixa"), linha("08", -5, "Algo desconhecido")])).importacao);
  const cal = await calendario("BALCAO");
  const d08 = cal.dias.find((d) => d.data === "2026-11-08");
  const mv = d08.movimentosDeCaixa;
  assert.deepEqual([mv.retiradas.quantidade, mv.retiradas.totalCentavos, mv.reforcos.totalCentavos, mv.desconhecidas.quantidade, mv.pendenciasDeCaixa.quantidade], [2, 14000, 3000, 1, 3]);
  assert.deepEqual(mv.itens.map((i) => i.natureza).sort(), ["DESCONHECIDA", "REFORCO", "SANGRIA", "SANGRIA"], "a lista abre as movimentações que compõem o total");
  assert.ok(d08.divergencias.some((x) => x.codigo === "MOVIMENTO_A_CLASSIFICAR"));
  assert.ok(d08.estados.includes("DIVERGENCIA"));
  assert.ok(!d08.estados.includes("IMPORTADO"), "movimento de caixa não faz o dia virar faturamento importado");
  assert.equal(cal.dias.find((d) => d.data === "2026-11-12").movimentosDeCaixa.retiradas.totalCentavos, 5100);
  assert.equal((await calendario("ANOTA_AI")).dias.find((d) => d.data === "2026-11-08").movimentosDeCaixa, null);
});

test("segurança: sem permissão de importar não envia; sem ver não consulta; outra unidade/empresa não enxerga os movimentos", async () => {
  const { n, subir, confirmar, movimentos } = await unidade();
  await confirmar((await subir(RETIRADAS())).importacao);
  const soVer = ctx(ORG_A, UNI_A, [ACAO.VER]);
  assert.equal((await movimentos("2026-11-01", "2026-11-30", soVer)).totais.retiradas.quantidade, 9);
  await rejeita(subir(RETIRADAS(), "2026-11-01", "2026-11-17", soVer), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(movimentos("2026-11-01", "2026-11-30", ctx(ORG_A, UNI_A, [])), CODIGO.PERMISSAO_INSUFICIENTE);
  assert.equal((await movimentos("2026-11-01", "2026-11-30", ctx(ORG_B, UNI_B))).totais.retiradas.quantidade, 0, "outra empresa");
  await rejeita(CONSULTAS["/movimentos-caixa"](n, c, { periodoInicio: "2026-11-30", periodoFim: "2026-11-01" }), CODIGO.ENTRADA_INVALIDA);
});

test("layout diferente é recusado (nada é interpretado por suposição) e formato de outro relatório não passa", async () => {
  const { n, W } = await unidade();
  const errado = xlsx([{ nome: "x", linhas: [["Data", "Valor"], ["01/11/2026", 10]] }]);
  const r = await W("/importacao/receber", { tipoRelatorio: "SAIPOS_MOVIMENTOS_CAIXA", periodoInicio: "2026-11-01", periodoFim: "2026-11-17", arquivoBase64: aBase64(errado), nomeArquivo: "x.xlsx" });
  assert.equal(r.importacao.estado, "REJEITADO");
  const d = await n.detalharImportacao(c, { id: r.importacao.id });
  assert.ok(d.previa.erros.some((e) => e.codigo === "FORMATO_NAO_RECONHECIDO" && /Colunas ausentes/.test(e.mensagem)));
  assert.equal(d.previa.registros, 0);
});

// ======================================================================================================== AUDITORIA FINAL
test("calendário: o relatório de caixa NÃO prova que o dia não teve venda (não vira 'sem movimento confirmado')", async () => {
  const { subir, confirmar, calendario } = await unidade();
  await confirmar((await subir([linha("08", 100)])).importacao);
  const cal = await calendario("BALCAO");
  for (const data of ["2026-11-08", "2026-11-03"]) {
    const d = cal.dias.find((x) => x.data === data);
    assert.ok(!d.estados.includes("SEM_MOVIMENTO_CONFIRMADO"), `${data}: sem venda importada o dia continua sem registro`);
    assert.ok(!d.observacoes.some((o) => /não traz venda/.test(o)), data);
    assert.ok(d.estados.includes("SEM_REGISTRO") || d.estados.includes("DIVERGENCIA"), data);
  }
  assert.ok(cal.dias.find((x) => x.data === "2026-11-08").importacoes.some((i) => i.tipoRelatorio === "SAIPOS_MOVIMENTOS_CAIXA"), "o relatório continua listado como importação que cobre o dia");
});

test("arquivo CORRIGIDO: contradição com o já importado vira divergência com aceite explícito; só então substitui (histórico preservado); acréscimos não substituem nada", async () => {
  const { n, subir, confirmar, movimentos } = await unidade();
  const retiradas = async () => { const t = (await movimentos()).totais.retiradas; return [t.quantidade, t.totalCentavos]; };
  await confirmar((await subir([linha("10", 100), linha("10", 40)], "2026-11-10", "2026-11-12")).importacao);
  assert.deepEqual(await retiradas(), [2, 14000]);
  // Acréscimo (o novo arquivo traz as duas anteriores e mais uma): nenhuma contradição, soma só a nova.
  const acresc = await subir([linha("10", 100), linha("10", 40), linha("11", 7)], "2026-11-10", "2026-11-12");
  assert.equal(acresc.previa.contagens.substituiriam, 0);
  await confirmar(acresc.importacao);
  assert.deepEqual(await retiradas(), [3, 14700]);
  // Correção: a retirada de R$ 40,00 virou R$ 45,00.
  const corr = await subir([linha("10", 100), linha("10", 45), linha("11", 7)], "2026-11-10", "2026-11-12");
  const d = await n.detalharImportacao(c, { id: corr.importacao.id });
  assert.equal(corr.previa.contagens.substituiriam, 1);
  assert.match(d.previa.divergencias.map((x) => x.mensagem).join(" "), /Dia 10\/11: já há 1 retirada\(s\) importada\(s\) \(R\$\s?40,00\) que este arquivo NÃO traz/);
  assert.deepEqual(await retiradas(), [3, 14700], "a prévia não muda nada");
  await rejeita(n.confirmarImportacao(c, { importacaoId: corr.importacao.id, impressaoPrevia: corr.importacao.impressaoPrevia, aceitarPendencias: false }), CODIGO.IMPORTACAO_INVALIDA);
  assert.deepEqual(await retiradas(), [3, 14700], "sem aceite nada é gravado nem substituído");
  await confirmar(corr.importacao, { justificativa: "Arquivo corrigido pela SAIPOS: a retirada de R$ 40,00 era R$ 45,00." });
  assert.deepEqual(await retiradas(), [3, 15200], "100 + 45 + 7: a de R$ 40,00 saiu da conta (não foi somada)");
  // A linha antiga não foi apagada: continua no histórico como SUBSTITUÍDA, apontando para a importação que a substituiu.
  const antigas = (await n.consultarRegistros(c, { tipo: "REGISTRO_FONTE" })).filter((r) => r.tipoRegistro === "MOVIMENTO_CAIXA" && r.dados.valorAbsolutoCentavos === 4000);
  assert.deepEqual(antigas.map((r) => [r.situacao, r.substituidoPorImportacaoId]), [["SUBSTITUIDO", corr.importacao.id]]);
  const hist = await n.consultarHistorico(c, { registroTipo: "REGISTRO_FONTE", registroId: antigas[0].id });
  assert.ok(hist.some((h) => h.evento === "SUBSTITUICAO"), "o histórico registra a substituição");
  assert.deepEqual(await n.verificarConservacao(c), []);
});

test("arquivos de naturezas diferentes no mesmo período (retiradas num, reforços noutro) convivem: um não substitui o outro", async () => {
  const { subir, confirmar, movimentos } = await unidade();
  await confirmar((await subir([linha("06", 75.5), linha("08", 100)])).importacao);
  const refs = await subir([linha("06", -20, "Reforço de Frente de Caixa")]);
  assert.equal(refs.previa.contagens.substituiriam, 0, "só reforço: nada a ver com as retiradas já importadas");
  await confirmar(refs.importacao);
  const m = await movimentos();
  assert.deepEqual([m.totais.retiradas.totalCentavos, m.totais.reforcos.totalCentavos], [17550, 2000]);
});

test("transferência: aparece 'a confirmar' e NÃO abate o dinheiro esperado (o relatório não diz se o dinheiro sai ou entra no caixa)", async () => {
  const { subir, confirmar, movimentos, fechamento } = await unidade();
  await confirmar((await subir([linha("16", 50, "Transferência entre caixas")], "2026-11-16", "2026-11-16")).importacao);
  const dia = (await movimentos()).dias.find((x) => x.data === "2026-11-16");
  assert.deepEqual([dia.transferencias.quantidade, dia.transferenciasAConfirmar.quantidade, dia.transferenciasAConfirmar.totalCentavos], [0, 1, 5000]);
  assert.ok(dia.divergencias.some((x) => x.codigo === "TRANSFERENCIA_A_CONFIRMAR"));
  const f = (await fechamento("2026-11-16", "2026-11-16")).dias.find((x) => x.data === "2026-11-16");
  assert.deepEqual([f.dinheiroDoDia.transferenciasCentavos, f.dinheiroDoDia.esperadoCentavos], [0, 0], "nada é abatido sem saber o sentido");
});

test("isolamento: outra unidade da MESMA empresa não vê nem é afetada (nem por correção); permissões: importar ≠ confirmar, ver ≠ importar", async () => {
  const { n, W, subir, confirmar, movimentos } = await unidade();
  const outra = ctx(ORG_A, UNI_A2);
  await W("/configuracoes/unidade", { nomeExibicao: "Outra unidade", justificativa: "Teste." }, outra);
  await confirmar((await subir([linha("10", 100), linha("10", 40)], "2026-11-10", "2026-11-12")).importacao);
  assert.equal((await movimentos("2026-11-01", "2026-11-30", outra)).totais.retiradas.quantidade, 0, "mesma empresa, outra unidade: nada");
  // A outra unidade importa o MESMO arquivo: é uma importação dela, independente.
  const a2 = await subir([linha("10", 100), linha("10", 40)], "2026-11-10", "2026-11-12", outra);
  assert.equal(a2.repetido, false);
  await n.confirmarImportacao(outra, { importacaoId: a2.importacao.id, impressaoPrevia: a2.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: "Sintético aceito." });
  assert.equal((await movimentos("2026-11-01", "2026-11-30", outra)).totais.retiradas.totalCentavos, 14000);
  // Corrigir a unidade A não mexe na unidade A2.
  const corr = await subir([linha("10", 100), linha("10", 45)], "2026-11-10", "2026-11-12");
  await confirmar(corr.importacao);
  assert.equal((await movimentos()).totais.retiradas.totalCentavos, 14500);
  assert.equal((await movimentos("2026-11-01", "2026-11-30", outra)).totais.retiradas.totalCentavos, 14000, "a outra unidade continua intacta");
  // Permissões.
  const soImportar = ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.IMPORTAR]);
  const pronta = await subir([linha("14", 10)], "2026-11-14", "2026-11-14", soImportar);
  assert.equal(pronta.importacao.estado, "PRONTO_PARA_IMPORTAR", "quem importa recebe a prévia");
  await rejeita(n.confirmarImportacao(soImportar, { importacaoId: pronta.importacao.id, impressaoPrevia: pronta.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: "x".repeat(25) }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(subir([linha("14", 10)], "2026-11-14", "2026-11-14", ctx(ORG_A, UNI_A, [ACAO.VER])), CODIGO.PERMISSAO_INSUFICIENTE);
  assert.equal((await movimentos("2026-11-01", "2026-11-30")).totais.retiradas.totalCentavos, 14500, "nada de 14/11 foi gravado");
});

test("histórico: cada importação de movimentos aparece no histórico do canal SAIPOS com período, estado e divergências", async () => {
  const { n, subir, confirmar } = await unidade();
  await confirmar((await subir(RETIRADAS())).importacao);
  const canal = await CONSULTAS["/importacoes-canal"](n, c, { canal: "SAIPOS" });
  const h = canal.historico.find((x) => x.tipoRelatorio === "SAIPOS_MOVIMENTOS_CAIXA");
  assert.deepEqual([h.estado, h.periodoInicio, h.periodoFim, h.erros], ["IMPORTADO", "2026-11-01", "2026-11-17", 0]);
  assert.equal(h.relatorio, "Movimentações de Frente de Caixa do SAIPOS");
});
