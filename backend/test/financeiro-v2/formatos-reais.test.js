// Estruturas REAIS observadas nas exportações de setembro/2026 (Stone XLSX, Unicred PDF, SAIPOS PDF e XLSX), reproduzidas
// com dados 100% SINTÉTICOS: nenhum nome, código, identificador ou valor real. Provam o layout, não os números do mês.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analisarArquivo, criarRegistroDeFontes } from "../../src/modules/financeiro-v2/index.js";
import { pdf, xlsx } from "./helpers/formatos.js";
import { ctx, montar } from "./helpers/cenario.js";

const fontes = criarRegistroDeFontes();
const analisar = (fonte, tipo, bytes, periodo = { inicio: "2026-09-01", fim: "2026-09-30" }) => analisarArquivo({ bytes, adaptador: fontes.buscar(fonte, tipo), periodo });
const codigos = (l) => l.map((x) => x.codigo).sort();

// ------------------------------------------------------------------------------------------- Stone (XLSX "Report")
const CAB_STONE = ["DOCUMENTO", "STONECODE", "DATA DA VENDA", "BANDEIRA", "PRODUTO", "STONE ID", "N DE PARCELAS", "VALOR BRUTO", "VALOR LIQUIDO",
  "DESCONTO DE MDR", "DESCONTO DE ANTECIPACAO", "DESCONTO UNIFICADO", "N DO CARTAO", "MEIO DE CAPTURA", "N DE SERIE", "ULTIMO STATUS", "DATA DO ULTIMO STATUS", "CÓDIGO DE AUTORIZAÇÃO"];
const linhaStone = (o) => ["00000000000000", "SC-TESTE", o.quando, o.bandeira ?? "Bandeira X", o.produto ?? "Credito", o.id, o.parcelas ?? "1", o.bruto, o.liquido,
  o.mdr ?? "0,000000", "0,000000", o.unificado ?? "0,000000", "000000******0000", "POS", "SERIE-TESTE", o.status ?? "Aprovada", o.quando, o.aut ?? "A1B2C3"];
const stoneReal = (linhas) => xlsx([{ nome: "Report", linhas: [CAB_STONE, ...linhas.map(linhaStone)] }]);

test("Stone (estrutura real): texto com 6 casas, descontos negativos (cartão no 'unificado', Pix no MDR), cartão omitido", () => {
  const a = analisar("STONE", "STONE_VENDAS", stoneReal([
    { id: "11111111111111", quando: "02/09/2026 12:00", bruto: "50,000000", liquido: "48,765432", unificado: "-1,234568" },
    { id: "22222222222222", quando: "02/09/2026 12:30", produto: "Pix QRcode", bandeira: "", parcelas: "", bruto: "10,000000", liquido: "9,990000", mdr: "-0,010000" },
    { id: "33333333333333", quando: "03/09/2026 09:00", produto: "Debito Pre-pago", bruto: "7,000000", liquido: "6,900000", unificado: "-0,100000", status: "Cancelada" },
  ]));
  assert.equal(a.formato, "xlsx");
  assert.equal(a.compatibilidade, "AMOSTRA_REAL");
  assert.deepEqual(a.erros, []);
  assert.equal(a.registros.length, 3);
  const [cartao, pix] = a.registros;
  assert.equal(cartao.dados.produto, "CREDITO");
  assert.equal(pix.dados.produto, "PIX");
  assert.equal(cartao.dados.liquidoMicros, 48765432); // fração de centavo preservada, sem arredondar a linha
  assert.equal(cartao.dados.liquidoTemFracaoDeCentavo, true);
  assert.equal(pix.dados.descontoInformadoMicros, 10000);
  assert.equal(cartao.original["N DO CARTAO"], "[omitido]");
  assert.equal(cartao.dados.canal, null);
  assert.equal(a.controles.aprovadas, 2);
  assert.equal(a.controles.rejeitadas, 1);
  assert.equal(a.controles.brutoAprovadoCentavos, 6000);
  assert.equal(a.controles.liquidoAprovadoCentavos, 5876); // 58,755432 → centavo só no total
  assert.equal(a.controles.descontosAprovadosCentavos, 124);
  assert.ok(!codigos(a.divergencias).includes("LINHA_NAO_FECHA"));
});

test("Stone (estrutura real): desconto que não fecha, bruto com fração de centavo e id repetido são apontados", () => {
  const base = { quando: "02/09/2026 12:00", bruto: "50,000000", liquido: "48,000000", unificado: "-1,000000" };
  const a = analisar("STONE", "STONE_VENDAS", stoneReal([{ ...base, id: "44444444444444" }, { ...base, id: "55555555555555", bruto: "50,001000" }]));
  assert.deepEqual(codigos(a.erros), ["VALOR_INVALIDO"]);
  assert.ok(codigos(a.divergencias).includes("LINHA_NAO_FECHA"));
  const dup = analisar("STONE", "STONE_VENDAS", stoneReal([{ ...base, id: "66666666666666", liquido: "49,000000" }, { ...base, id: "66666666666666", liquido: "49,000000" }]));
  assert.equal(dup.duplicadosNoArquivo.length, 1);
});

// ------------------------------------------------------------------------------------------- Unicred (PDF de extrato)
const CAB_UNICRED = "Data Lançamentos Valor (R$) Saldo (R$)";
const extratoUnicred = ({ quebrarSaldo = false, periodo = "Período de 01/09/2026 a 30/09/2026" } = {}) => pdf([
  ["11/11/2026 17:55:39", "Extrato de conta corrente", periodo, "Coop: 0000 - AG: 0000 - Conta: 00000", "Saldo atual R$ 9.999,99",
    "Saldo em 31/08/2026: R$ 100,00", "Total Disponível R$ 9.999,99", CAB_UNICRED,
    "CREDITO RECEBIMENTO DE PIX ( Doc.: PIXA1 / CLIENTE", "02/09/2026 R$ 50,00 R$ 150,00", "SINTETICO ALFA )",
    "DEBITO TRANSFERENCIA PIX ( Doc.: PIXB2 /", `03/09/2026 - R$ 30,00 R$ ${quebrarSaldo ? "999,00" : "120,00"}`, "FORNECEDOR SINTETICO", "LTDA )",
    "04/09/2026 SEGURO PRESTAMISTA ( Doc.: 777 ) - R$ 5,00 R$ 115,00",
    "CENTRAL DE RELACIONAMENTO: Capitais e regiões metropolitanas: 0000 0000 - Demais regiões: Pág. 1 /2"],
  [CAB_UNICRED, "LIQUIDACAO DE PARCELA DE EMPRESTIMO ( Doc.: 9 /", "05/09/2026 - R$ 15,00 R$ 100,00", "CONTRATO SINTETICO )",
    "Saldo no final do período R$ 100,00", "Saldo atual R$ 9.999,99", "Saldo bloqueado R$ 0,00",
    "CENTRAL DE RELACIONAMENTO: Capitais e regiões metropolitanas: 0000 0000 - Demais regiões: Pág. 2 /2"],
]);

test("Unicred (estrutura real): descrição antes e depois da linha de valor, débito com '-', saldos do período × atual", () => {
  const a = analisar("UNICRED", "UNICRED_EXTRATO", extratoUnicred());
  assert.equal(a.compatibilidade, "AMOSTRA_REAL");
  assert.deepEqual(a.erros, []);
  assert.deepEqual(a.divergencias, []);
  assert.equal(a.registros.length, 4);
  assert.deepEqual(a.registros.map((r) => r.dados.sentido), ["ENTRADA", "SAIDA", "SAIDA", "SAIDA"]);
  assert.equal(a.registros[0].dados.historico, "CREDITO RECEBIMENTO DE PIX ( Doc.: PIXA1 / CLIENTE SINTETICO ALFA )");
  assert.equal(a.registros[1].dados.historico, "DEBITO TRANSFERENCIA PIX ( Doc.: PIXB2 / FORNECEDOR SINTETICO LTDA )");
  assert.equal(a.registros[0].dados.documento, "PIXA1");
  assert.deepEqual(a.registros.map((r) => r.dados.pagina), [1, 1, 1, 2]);
  assert.deepEqual(a.registros.map((r) => r.dados.categoriaSugerida), ["PIX_RECEBIDO", "PIX_ENVIADO", "SEGURO", "EMPRESTIMO"]);
  assert.equal(a.controles.saldoInicialCentavos, 10000);
  assert.equal(a.controles.entradasCentavos, 5000);
  assert.equal(a.controles.saidasCentavos, 5000);
  assert.equal(a.controles.saldoFinalCentavos, 10000);
  assert.equal(a.controles.saldoAtualCentavos, 999999); // posição na emissão: registrada, nunca vira saldo de setembro
  assert.equal(a.controles.saldoFecha, true);
});

test("Unicred (estrutura real): saldo intermediário que não encadeia e período diferente do declarado viram divergência", () => {
  assert.ok(codigos(analisar("UNICRED", "UNICRED_EXTRATO", extratoUnicred({ quebrarSaldo: true })).divergencias).includes("LINHA_NAO_FECHA"));
  assert.ok(codigos(analisar("UNICRED", "UNICRED_EXTRATO", extratoUnicred({ periodo: "Período de 01/08/2026 a 30/09/2026" })).divergencias).includes("PERIODO_DO_DOCUMENTO"));
});

// ------------------------------------------------------------------------------------------- SAIPOS faturamento por dia (PDF)
const CABECALHO_SAIPOS = [
  { y: 720, partes: [[234, "VEND"], [257, "AS"], [427, "ITENS"]] },
  { y: 714, partes: [[116, "SEMANA"], [288, "ACUMUL"], [325, "ADO"], [365, "MÉDIO"], [472, "ENTREGA"], [532, "SER"], [549, "VIÇO"], [737, "CANC"]] },
  { y: 708, partes: [[61, "DATA"], [174, "VEND"], [197, "AS"], [257, "DE"], [435, "DOS"], [589, "ACRÉSCIMOS"], [665, "DESCONTOS"]] },
  { y: 702, partes: [[116, "DIA DA"], [315, "VALOR"], [363, "TICKE"], [387, "T"], [477, "TAXA DE"], [534, "TAXA DE"]] },
];
const diaSaipos = (y, data, semana, qtd, valor, acumulado, desconto) => [
  { y, partes: [[48, data], [116, semana], [199, qtd], [257, "R$"], [290, `R$ ${acumulado}`], [382, "R$"], [441, "R$"], [477, "R$ 20,00"], [539, "R$ 0,00"], [615, "R$ 1,00"], [677, `R$ ${desconto}`]] },
  { y: y + 13, partes: [[116, "feira"], [234, valor], [371, "41,67"], [418, valor]] },
];
const faturamentoSaipos = ({ acumulado2 = "800,00" } = {}) => pdf([[
  "Faturamento por dia", { y: 760, partes: [[80, "30/09/2026"]] }, ...CABECALHO_SAIPOS,
  ...diaSaipos(300, "02/09/2026", "Quarta-", "8", "300,00", acumulado2, "20,00"),
  ...diaSaipos(328, "01/09/2026", "Terça-", "12", "500,00", "500,00", "30,00"),
  { y: 200, partes: [[116, "T"], [121, "otal"], [188, "20"], [257, "R$"], [677, "R$ 50,00"]] }, { y: 213, partes: [[234, "800,00"]] },
]]);

test("SAIPOS faturamento por dia (PDF real): colunas pela posição, dia em duas linhas, acumulado e linha TOTAL conferidos", () => {
  const a = analisar("SAIPOS", "SAIPOS_FATURAMENTO_POR_DIA", faturamentoSaipos(), { inicio: "2026-09-01", fim: "2026-09-02" });
  assert.equal(a.compatibilidade, "AMOSTRA_REAL");
  assert.deepEqual(a.erros, []);
  assert.deepEqual(a.divergencias, []);
  assert.equal(a.registros.length, 2); // a data solta do cabeçalho não vira dia
  assert.equal(a.controles.faturamentoCentavos, 80000);
  assert.equal(a.controles.acumuladoFinalCentavos, 80000);
  assert.equal(a.controles.descontosCentavos, 5000);
  assert.equal(a.controles.quantidadeVendas, 20);
  assert.deepEqual(a.controles.totalDeclarado, { valorCentavos: 80000, descontosCentavos: 5000, quantidade: 20 });
  const quebrado = analisar("SAIPOS", "SAIPOS_FATURAMENTO_POR_DIA", faturamentoSaipos({ acumulado2: "810,00" }), { inicio: "2026-09-01", fim: "2026-09-02" });
  assert.ok(codigos(quebrado.divergencias).includes("LINHA_NAO_FECHA"));
  // Relatório de 2 dias declarado como mês inteiro: cobertura denunciada.
  assert.ok(codigos(analisar("SAIPOS", "SAIPOS_FATURAMENTO_POR_DIA", faturamentoSaipos()).divergencias).includes("PERIODO_DO_DOCUMENTO"));
});

// ------------------------------------------------------------------------------------------- SAIPOS formas de pagamento (XLSX)
const formasSaipos = (dias = ["01/09/2026", "02/09/2026"]) => xlsx([{ nome: "Vendas por forma de pagamento", linhas: [
  ["Forma de pagamento", "Valor total dos pagamentos (R$)", "Quantidade de pagamentos", "%", ...dias.map((d) => `Dia - ${d}`)],
  ["Dinheiro", "300.5", "10", "40,00 %", "100.5", "200"],
  ["Crédito Visa", "400", "8", "50,00 %", "250", "150"],
  ["Voucher Parceiro Desconto", "50", "3", "5,00 %", "20", "30"],
  ["máquina outra marca", "20", "1", "2,50 %", "20", ""],
  ["Pagamento não cadastrado", "9.5", "1", "1,20 %", "", "9.5"],
] }]);

test("SAIPOS formas de pagamento (XLSX real): total × soma dos dias, cobertura do período e formas anômalas como pendência", () => {
  const a = analisar("SAIPOS", "SAIPOS_FORMAS_PAGAMENTO", formasSaipos(), { inicio: "2026-09-01", fim: "2026-09-02" });
  assert.equal(a.compatibilidade, "AMOSTRA_REAL");
  assert.deepEqual(a.erros, []);
  assert.equal(a.controles.totalCentavos, 78000);
  assert.equal(a.controles.diasCobertos, 2);
  assert.deepEqual(a.controles.formasAnomalas, ["Voucher Parceiro Desconto", "máquina outra marca", "Pagamento não cadastrado"]);
  assert.equal(a.controles.anomaliasCentavos, 7950);
  assert.deepEqual(codigos(a.divergencias), ["VALOR_A_CLASSIFICAR", "VALOR_A_CLASSIFICAR", "VALOR_A_CLASSIFICAR"]);
  assert.deepEqual(a.registros[0].dados.porDia, { "2026-09-01": 10050, "2026-09-02": 20000 });
  assert.ok(codigos(analisar("SAIPOS", "SAIPOS_FORMAS_PAGAMENTO", formasSaipos()).divergencias).includes("PERIODO_DO_DOCUMENTO"));
  assert.deepEqual(codigos(analisar("SAIPOS", "SAIPOS_FORMAS_PAGAMENTO", formasSaipos(["01/09/2026", "03/10/2026"]), { inicio: "2026-09-01", fim: "2026-09-30" }).erros), ["PERIODO_INCORRETO"]);
});

test("núcleo: faturamento (PDF) × formas (XLSX) do SAIPOS — diferença detectada sem ajuste e sem efeito financeiro", async () => {
  const { nucleo } = montar();
  const c = ctx();
  const periodo = { periodoInicio: "2026-09-01", periodoFim: "2026-09-02" };
  for (const [tipoRelatorio, conteudo] of [["SAIPOS_FATURAMENTO_POR_DIA", faturamentoSaipos()], ["SAIPOS_FORMAS_PAGAMENTO", formasSaipos()]]) {
    const r = await nucleo.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio, tipoMime: "application/octet-stream", conteudo, ...periodo });
    assert.equal(r.importacao.compatibilidade, "AMOSTRA_REAL");
    const pend = r.previa.totalDivergencias ? { aceitarPendencias: true, justificativa: "Formas anômalas registradas para investigação." } : {};
    await nucleo.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...pend });
  }
  const cmp = await nucleo.compararRelatoriosSaipos(c, periodo);
  assert.equal(cmp.fonteFaturamento, "FATURAMENTO_POR_DIA");
  assert.equal(cmp.faturamentoCentavos, 80000);
  assert.equal(cmp.formasDePagamentoCentavos, 78000);
  assert.equal(cmp.diferencaCentavos, 2000);
  assert.equal((await nucleo.consultarComposicao(c, { competencia: "2026-09", indicador: "RECEITA_BRUTA" })).totalCentavos, 0);
});
