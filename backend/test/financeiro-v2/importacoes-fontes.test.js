// Leitores de fonte (puros, sem banco): formato reconhecido, campos, valores, totais de controle, duplicidades, período.
// Todos os arquivos são SINTÉTICOS (helpers/arquivos.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { analisarArquivo, criarRegistroDeFontes } from "../../src/modules/financeiro-v2/index.js";
import { foodyEntregas, ifoodApuracao, saiposDiarias, saiposFormas, saiposVendas, stoneRecebimentos, stoneVendas, texto, unicredExtrato } from "./helpers/arquivos.js";

const fontes = criarRegistroDeFontes();
const SET = { inicio: "2026-09-01", fim: "2026-09-30" };
const analisar = (fonte, tipo, bytes, extra = {}) => analisarArquivo({ bytes, adaptador: fontes.buscar(fonte, tipo), periodo: SET, ...extra });
const codigos = (lista) => lista.map((x) => x.codigo);

const PEDIDOS = [
  { pedido: "P-1", data: "02/09/2026 12:00", canal: "Balcão", itens: 3000, forma: "Dinheiro" },
  { pedido: "P-2", data: "02/09/2026 12:05", canal: "iFood", itens: 4500, desconto: 500, taxa: 700, forma: "Pago online" },
  { pedido: "P-3", data: "03/09/2026 19:10", canal: "Balcão", itens: 2500, forma: "Crédito", autorizacao: "AUT-9" },
  { pedido: "P-4", data: "03/09/2026 19:30", canal: "Balcão", itens: 1000, forma: "Pix", situacao: "Cancelado" },
];

test("SAIPOS vendas: lê pedidos, separa canal de forma de pagamento e confere o total declarado", () => {
  const a = analisar("SAIPOS", "SAIPOS_VENDAS", saiposVendas(PEDIDOS, { total: 3000 + 4700 + 2500 }));
  assert.deepEqual(a.erros, []);
  assert.deepEqual(a.divergencias, []);
  assert.equal(a.registros.length, 4);
  const p2 = a.registros.find((r) => r.idExterno === "P-2");
  assert.equal(p2.dados.canal, "IFOOD");
  assert.equal(p2.dados.formaPagamento, "ONLINE_PLATAFORMA");
  assert.equal(p2.valorCentavos, 4700); // itens − desconto + entrega
  assert.equal(a.registros.find((r) => r.idExterno === "P-3").dados.formaPagamento, "CREDITO");
  assert.equal(a.registros.find((r) => r.idExterno === "P-3").dados.canal, "BALCAO");
  assert.equal(a.controles.faturamentoCentavos, 10200); // cancelado fica fora
  assert.equal(a.controles.canceladosCentavos, 1000);
  assert.equal(p2.identificacao, "ID_EXTERNO");
  assert.equal(p2.original.Pedido, "P-2"); // linha original preservada
});

test("arquivo inválido, coluna obrigatória ausente e arquivo vazio são REJEITADOS sem palpite", () => {
  assert.deepEqual(codigos(analisar("SAIPOS", "SAIPOS_VENDAS", texto("isto não é um relatório\nnada aqui\n")).erros), ["FORMATO_NAO_RECONHECIDO"]);
  const semTotal = analisar("SAIPOS", "SAIPOS_VENDAS", saiposVendas(PEDIDOS, { semColuna: "Total" }));
  assert.equal(semTotal.reconhecido, false);
  assert.match(semTotal.erros[0].mensagem, /total/);
  assert.deepEqual(codigos(analisar("SAIPOS", "SAIPOS_VENDAS", texto("   \n")).erros), ["ARQUIVO_VAZIO"]);
  // Relatório de outra fonte não é aceito como Stone.
  assert.equal(analisar("STONE", "STONE_VENDAS", saiposVendas(PEDIDOS)).reconhecido, false);
});

test("campo obrigatório vazio e valor monetário inválido viram erro COM a linha", () => {
  const ruins = [{ ...PEDIDOS[0], pedido: "" }, { ...PEDIDOS[1], totalTexto: "12,3,4" }, { ...PEDIDOS[2], totalTexto: "1.2345,00" }];
  const a = analisar("SAIPOS", "SAIPOS_VENDAS", saiposVendas(ruins));
  assert.deepEqual(codigos(a.erros).sort(), ["CAMPO_OBRIGATORIO", "VALOR_INVALIDO", "VALOR_INVALIDO"]);
  assert.deepEqual(a.erros.map((e) => e.linha).sort(), [2, 3, 4]);
  assert.equal(a.registros.length, 0);
  assert.deepEqual(codigos(analisar("SAIPOS", "SAIPOS_VENDAS", saiposVendas([{ ...PEDIDOS[0], data: "31/02/2026 10:00" }])).erros), ["DATA_INVALIDA"]);
});

test("totais inconsistentes: linha que não fecha e total declarado diferente viram DIVERGÊNCIA (nunca ajuste)", () => {
  const a = analisar("SAIPOS", "SAIPOS_VENDAS", saiposVendas([{ ...PEDIDOS[0], totalTexto: "31,00" }], { total: 9999 }));
  assert.deepEqual(a.erros, []);
  assert.deepEqual(codigos(a.divergencias).sort(), ["LINHA_NAO_FECHA", "TOTAL_NAO_CONFERE"]);
  const total = a.divergencias.find((d) => d.codigo === "TOTAL_NAO_CONFERE");
  assert.equal(total.esperadoCentavos, 9999);
  assert.equal(total.encontradoCentavos, 3100);
  assert.equal(a.registros[0].valorCentavos, 3100); // o valor do arquivo é preservado como está
});

test("registros repetidos no mesmo arquivo: idênticos contam uma vez; mesmo id com conteúdo diferente é conflito", () => {
  const dup = analisar("SAIPOS", "SAIPOS_VENDAS", saiposVendas([PEDIDOS[0], PEDIDOS[0], PEDIDOS[1]]));
  assert.equal(dup.registros.length, 2);
  assert.equal(dup.duplicadosNoArquivo.length, 1);
  const conflito = analisar("SAIPOS", "SAIPOS_VENDAS", saiposVendas([PEDIDOS[0], { ...PEDIDOS[0], itens: 3100 }]));
  assert.deepEqual(codigos(conflito.erros), ["CONFLITO_NO_ARQUIVO"]);
});

test("sem identificador da fonte, linhas iguais NÃO se fundem por valor e data (impressão digital + ocorrência)", () => {
  const ext = unicredExtrato({ saldoInicial: 0, lancamentos: [
    { data: "05/09/2026", historico: "TARIFA PACOTE", valor: -1000, saldo: -1000 },
    { data: "05/09/2026", historico: "TARIFA PACOTE", valor: -1000, saldo: -2000 },
  ] });
  const a = analisar("UNICRED", "UNICRED_EXTRATO", ext);
  assert.equal(a.registros.length, 2);
  assert.ok(a.registros.every((r) => r.identificacao === "IMPRESSAO_DIGITAL"));
  assert.notEqual(a.registros[0].chave, a.registros[1].chave);
  assert.equal(a.duplicadosNoArquivo.length, 0);
});

test("período incorreto: registro fora do período declarado rejeita o arquivo", () => {
  const a = analisar("SAIPOS", "SAIPOS_VENDAS", saiposVendas([{ ...PEDIDOS[0], data: "01/10/2026 10:00" }]));
  assert.deepEqual(codigos(a.erros), ["PERIODO_INCORRETO"]);
});

test("estabelecimento: de outra unidade rejeita; sem cadastro vira pendência explícita", () => {
  const t = [{ id: "T-1", quando: "02/09/2026 12:00", bruto: 1000, mdr: 30, stonecode: "LOJA-X" }];
  assert.deepEqual(codigos(analisar("STONE", "STONE_VENDAS", stoneVendas(t), { estabelecimentosDaUnidade: ["LOJA-Y"] }).erros), ["UNIDADE_INCOMPATIVEL"]);
  assert.deepEqual(analisar("STONE", "STONE_VENDAS", stoneVendas(t), { estabelecimentosDaUnidade: ["LOJA-X"] }).erros, []);
  assert.deepEqual(codigos(analisar("STONE", "STONE_VENDAS", stoneVendas(t)).divergencias), ["ESTABELECIMENTO_NAO_VERIFICADO"]);
});

test("Stone vendas: taxa informada × taxa calculada, antecipação identificada, canal NÃO presumido Balcão", () => {
  const a = analisar("STONE", "STONE_VENDAS", stoneVendas([
    { id: "T-1", quando: "02/09/2026 12:00", produto: "Débito", bruto: 2000, mdr: 30 },
    { id: "T-2", quando: "02/09/2026 13:00", produto: "Crédito", bruto: 5000, mdr: 120, antecipacao: 80 },
    { id: "T-3", quando: "02/09/2026 14:00", produto: "Crédito", bruto: 1000, mdr: 20, liquido: 900 },
    { id: "T-4", quando: "02/09/2026 15:00", produto: "Pix", bruto: 700, mdr: 0, status: "Cancelada" },
  ]));
  assert.deepEqual(a.erros, []);
  const t2 = a.registros.find((r) => r.idExterno === "T-2");
  assert.equal(t2.dados.antecipada, true);
  assert.equal(t2.dados.taxaInformadaCentavos, 200);
  assert.equal(t2.dados.canal, null);
  assert.equal(t2.dados.natureza, "VENDA_PROCESSADA");
  assert.deepEqual(codigos(a.divergencias), ["LINHA_NAO_FECHA", "ESTABELECIMENTO_NAO_VERIFICADO"].filter((c) => c !== "ESTABELECIMENTO_NAO_VERIFICADO"));
  assert.equal(a.divergencias[0].linha, 4);
  assert.equal(a.controles.brutoAprovadoCentavos, 8000); // cancelada fora
  const rec = analisar("STONE", "STONE_RECEBIMENTOS", stoneRecebimentos([{ data: "03/09/2026", transacao: "T-1", liquido: 1970 }, { data: "03/09/2026", transacao: "T-2", parcela: 1, liquido: 4800 }]));
  assert.deepEqual(rec.erros, []);
  assert.equal(rec.registros[1].idExterno, "T-2:1");
  assert.equal(rec.controles.porData["2026-09-03"], 6770);
});

test("iFood apuração: cada componente com sua natureza; antecipação já incluída; componente desconhecido vira pendência", () => {
  const comps = [
    { data: "07/09/2026", tipo: "Vendas", valor: 100000 },
    { data: "07/09/2026", tipo: "Comissão", valor: -12000 },
    { data: "07/09/2026", tipo: "Taxa de transação de pagamento", valor: -3200 },
    { data: "07/09/2026", tipo: "Promoção", valor: -1500, responsavel: "Loja" },
    { data: "07/09/2026", tipo: "Promoção", valor: -800, responsavel: "iFood" },
    { data: "07/09/2026", tipo: "Entrega Sob Demanda", valor: -2500 },
    { data: "07/09/2026", tipo: "Mensalidade", valor: -10000 },
    { data: "07/09/2026", tipo: "Anúncios", valor: -3000 },
    { data: "07/09/2026", tipo: "Antecipação de recebíveis", valor: -900 },
    { data: "07/09/2026", tipo: "Repasse previsto", valor: 66900 },
    { data: "08/09/2026", tipo: "Repasse pago", valor: 66900 },
  ];
  const a = analisar("IFOOD", "IFOOD_APURACAO", ifoodApuracao(comps));
  assert.deepEqual(a.erros, []);
  assert.deepEqual(a.divergencias, []);
  const por = Object.fromEntries(a.registros.map((r) => [`${r.dados.componente}|${r.dados.responsavelSubsidio ?? ""}`, r.dados]));
  assert.equal(por["COMISSAO|"].categoriaSugerida, "COMISSOES_IFOOD");
  assert.equal(por["MENSALIDADE|"].categoriaSugerida, "MENSALIDADE_IFOOD");
  assert.equal(por["ANUNCIOS|"].categoriaSugerida, "ANUNCIOS_IFOOD");
  assert.equal(por["PROMOCAO_LOJA|Loja"].categoriaSugerida, "PROMOCOES_SUBSIDIADAS");
  assert.equal(por["PROMOCAO_IFOOD|iFood"].efeito, "INFORMATIVO"); // subsídio do iFood não reduz o resultado da loja
  assert.equal(por["ANTECIPACAO|"].jaIncluidaNaApuracao, true);
  assert.equal(a.controles.composicaoCentavos, 66900);
  const estranho = analisar("IFOOD", "IFOOD_APURACAO", ifoodApuracao([...comps, { data: "07/09/2026", tipo: "Crédito misterioso", valor: 100 }]));
  assert.ok(codigos(estranho.divergencias).includes("VALOR_A_CLASSIFICAR"));
  assert.ok(codigos(estranho.divergencias).includes("TOTAL_NAO_CONFERE"));
});

test("Foody: entregas e subtotal por entregador; cancelada e taxa rejeitada não são devidas; soma confere com o total", () => {
  const entregas = [
    { pedido: "F-1", data: "02/09/2026", entregador: "Entregador Alfa", taxa: 700, custo: 600 },
    { pedido: "F-2", data: "02/09/2026", entregador: "Entregador Alfa", taxa: 900, custo: 800 },
    { pedido: "F-3", data: "03/09/2026", entregador: "Entregador Beta", taxa: 700, custo: 600 },
    { pedido: "F-4", data: "03/09/2026", entregador: "Entregador Beta", taxa: 700, custo: 600, situacao: "Cancelada" },
    { pedido: "F-5", data: "03/09/2026", entregador: "Entregador Beta", taxa: 700, custo: 600, situacao: "Taxa rejeitada" },
  ];
  const ok = analisar("FOODY", "FOODY_ENTREGAS", foodyEntregas(entregas, { subtotais: { "Entregador Alfa": 1400, "Entregador Beta": 600 }, total: 2000 }));
  assert.deepEqual(ok.erros, []);
  assert.deepEqual(ok.divergencias, []);
  assert.deepEqual(ok.controles.porEntregador["Entregador Alfa"], { entregas: 2, devidoCentavos: 1400, declaradoCentavos: 1400 });
  assert.equal(ok.controles.devidoCentavos, 2000);
  const ruim = analisar("FOODY", "FOODY_ENTREGAS", foodyEntregas(entregas, { subtotais: { "Entregador Beta": 1200 }, total: 2600 }));
  assert.deepEqual(codigos(ruim.divergencias), ["TOTAL_NAO_CONFERE", "TOTAL_NAO_CONFERE"]);
});

test("Unicred: extrato cujo saldo fecha × extrato que não fecha (e linha que não encadeia)", () => {
  const lanc = [
    { data: "02/09/2026", historico: "CRED STONE PAGAMENTOS", valor: 6770 },
    { data: "03/09/2026", historico: "PIX ENVIADO FORNECEDOR", valor: -2500 },
    { data: "04/09/2026", historico: "TARIFA PACOTE SERVICOS", valor: -1290 },
    { data: "05/09/2026", historico: "PAGTO TITULO BOLETO", valor: -1000 },
  ];
  const fecha = analisar("UNICRED", "UNICRED_EXTRATO", unicredExtrato({ saldoInicial: 10000, lancamentos: lanc }));
  assert.deepEqual(fecha.erros, []);
  assert.deepEqual(fecha.divergencias, []);
  assert.equal(fecha.controles.saldoFecha, true);
  assert.equal(fecha.controles.entradasCentavos, 6770);
  assert.equal(fecha.controles.saidasCentavos, 4790);
  assert.equal(fecha.controles.saldoFinalCentavos, 11980);
  assert.deepEqual(fecha.registros.map((r) => r.dados.categoriaSugerida), ["CREDITO_ADQUIRENTE", "PIX_ENVIADO", "TARIFA", "PAGAMENTO_BOLETO"]);
  assert.ok(fecha.registros.every((r) => r.dados.classificacaoConfirmada === false));

  const naoFecha = analisar("UNICRED", "UNICRED_EXTRATO", unicredExtrato({ saldoInicial: 10000, lancamentos: lanc, saldoFinal: 12000 }));
  assert.equal(naoFecha.controles.saldoFecha, false);
  const div = naoFecha.divergencias.find((d) => d.codigo === "SALDO_NAO_FECHA");
  assert.equal(div.diferencaCentavos, -20);

  const quebra = analisar("UNICRED", "UNICRED_EXTRATO", unicredExtrato({ saldoInicial: 10000, lancamentos: [{ ...lanc[0], saldo: 99999 }, lanc[1]] }));
  assert.ok(codigos(quebra.divergencias).includes("LINHA_NAO_FECHA"));
});

test("SAIPOS totais (diárias e formas): impressão digital inclui o período — o mesmo canal em outro mês não colide", () => {
  const a = analisar("SAIPOS", "SAIPOS_VENDAS_DIARIAS", saiposDiarias([["01/09/2026", 10, 50000], ["02/09/2026", 12, 61234]], 111234));
  assert.deepEqual(a.erros, []);
  assert.deepEqual(a.divergencias, []);
  const f1 = analisar("SAIPOS", "SAIPOS_FORMAS_PAGAMENTO", saiposFormas([["Dinheiro", 5, 20000]]));
  const f2 = analisarArquivo({ bytes: saiposFormas([["Dinheiro", 5, 20000]]), adaptador: fontes.buscar("SAIPOS", "SAIPOS_FORMAS_PAGAMENTO"), periodo: { inicio: "2026-08-01", fim: "2026-08-31" } });
  assert.notEqual(f1.registros[0].chave, f2.registros[0].chave);
  assert.equal(f1.registros[0].dados.formaPagamento, "DINHEIRO");
});

test("quadro de compatibilidade: só é 'amostra real' o leitor conferido com arquivo real, e só no formato conferido", () => {
  const quadro = Object.fromEntries(fontes.compatibilidade().map((q) => [q.tipoRelatorio, q]));
  assert.equal(Object.keys(quadro).length, 18); // + 4 leitores do SWF (03, 45, 76, sangrias)
  assert.deepEqual(Object.values(quadro).filter((q) => q.compatibilidade === "AMOSTRA_REAL").map((q) => `${q.tipoRelatorio}:${q.formatosHomologados.join(",")}`).sort(),
    ["IFOOD_CONCILIACAO:xlsx", "NOVENTA_E_NOVE_FOOD_RELATORIO:xlsx", "SAIPOS_DESEMPENHO_POR_ATENDENTE:xlsx", "SAIPOS_FATURAMENTO_POR_DIA:pdf", "SAIPOS_FORMAS_PAGAMENTO:xlsx", "SAIPOS_MOVIMENTOS_CAIXA:xlsx", "SAIPOS_VENDAS:xlsx", "STONE_VENDAS:xlsx", "SWF_ANALISE_FATURAMENTO:xlsx", "SWF_CANAIS:xlsx", "SWF_PAGAMENTOS:xlsx", "SWF_SANGRIAS:xlsx", "UNICRED_EXTRATO:pdf"]);
  // CSV de Stone e OFX/CSV de Unicred continuam sintéticos: a prévia informa a compatibilidade do formato lido.
  assert.equal(analisar("STONE", "STONE_VENDAS", stoneVendas([{ id: "T-1", quando: "02/09/2026 12:00", bruto: 1000, mdr: 30 }])).compatibilidade, "SINTETICA");
});
