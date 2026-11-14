// Leitores de FORMATO (XLSX, PDF digital, OFX) com arquivos sintéticos de estrutura técnica real, e o fluxo pelo núcleo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO, analisarArquivo, criarRegistroDeFontes } from "../../src/modules/financeiro-v2/index.js";
import { lerXlsx, dataDoExcel, numeroComoTexto } from "../../src/modules/financeiro-v2/importacao/formatos/xlsx.js";
import { lerPdf } from "../../src/modules/financeiro-v2/importacao/formatos/pdf.js";
import { lerOfx } from "../../src/modules/financeiro-v2/importacao/formatos/ofx.js";
import { detectarFormato } from "../../src/modules/financeiro-v2/importacao/formatos/index.js";
import { ofx, pdf, serie, xlsx } from "./helpers/formatos.js";
import { PERIODO_SETEMBRO } from "./helpers/arquivos.js";
import { ctx, montar, rejeita } from "./helpers/cenario.js";

const fontes = criarRegistroDeFontes();
const SET = { inicio: "2026-09-01", fim: "2026-09-30" };
const analisar = (fonte, tipo, bytes) => analisarArquivo({ bytes, adaptador: fontes.buscar(fonte, tipo), periodo: SET });
const codigos = (l) => l.map((x) => x.codigo);

const CAB_STONE = ["Identificador da transação", "Data da venda", "Produto", "Bandeira", "Valor bruto", "Desconto de MDR", "Desconto de antecipação", "Valor líquido", "Status"];
const stoneXlsx = (linhas, extra = {}) => xlsx([{ nome: "Resumo", linhas: [["Relatório sintético"]] }, { nome: "Vendas", linhas: [["Exportação sintética"], [], CAB_STONE, ...linhas] }], extra);

test("XLSX: abas, células tipadas, datas do Excel (1900 e 1904), fórmulas com e sem resultado, erros", () => {
  const wb = lerXlsx(xlsx([{ nome: "A", linhas: [["texto & <xml>", 1234.5, { data: serie("2026-09-02") }, { dataHora: serie("2026-09-02", "13:45") }, { formula: "B1*2", valor: 2469 }, { formula: "B1/0" }, { erro: "#DIV/0!" }]] }]));
  const [l] = wb.abas[0].linhas;
  assert.deepEqual(l.map((c) => c.tipo), ["texto", "numero", "data", "data", "numero", "formula_sem_valor", "erro"]);
  assert.equal(l[0].texto, "texto & <xml>");
  assert.equal(l[2].texto, "2026-09-02 00:00:00");
  assert.equal(l[3].texto, "2026-09-02 13:45:00");
  assert.equal(l[4].formula, true);
  assert.equal(dataDoExcel(0, true), "1904-01-01 00:00:00");
  assert.equal(numeroComoTexto(String(0.1 + 0.2)), "0.3"); // ruído de ponto flutuante não vira 3ª casa
  assert.equal(lerXlsx(xlsx([{ nome: "S", linhas: [["x"]] }], { comprimir: false })).abas[0].linhas[0][0].texto, "x");
  assert.throws(() => lerXlsx(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0])), (e) => e.codigo === CODIGO.IMPORTACAO_INVALIDA);
});

test("XLSX Stone (estrutura sintética): acha o cabeçalho na 2ª aba, lê datas do Excel, totais e situação", () => {
  const a = analisar("STONE", "STONE_VENDAS", stoneXlsx([
    ["T-1", { dataHora: serie("2026-09-02", "12:00") }, "Débito", "Bandeira A", 20, 0.3, 0, 19.7, "Aprovada"],
    ["T-2", { dataHora: serie("2026-09-02", "13:00") }, "Crédito", "Bandeira B", 50, 1.2, 0.8, 48, "Aprovada"],
    ["T-3", { dataHora: serie("2026-09-03", "09:00") }, "Pix", "Pix", 7, 0, 0, 7, "Cancelada"],
    ["TOTAL", "", "", "", { formula: "SUM(E4:E6)", valor: 77 }, "", "", "", ""],
  ]));
  assert.equal(a.formato, "xlsx");
  assert.equal(a.aba, "Vendas");
  assert.deepEqual(a.erros, []);
  assert.equal(a.registros.length, 3);
  assert.equal(a.registros[0].dados.hora, "12:00:00");
  assert.equal(a.registros[1].dados.antecipacaoCentavos, 80);
  assert.equal(a.controles.brutoAprovadoCentavos, 7000);
  assert.equal(a.controles.liquidoAprovadoCentavos, 6770);
});

test("XLSX: cabeçalho diferente, valor monetário anômalo e fórmula sem resultado NÃO viram venda válida", () => {
  const alterado = xlsx([{ nome: "V", linhas: [["Código", "Quando", "Tipo", "Total"], ["T-1", "x", "y", 1]] }]);
  assert.deepEqual(codigos(analisar("STONE", "STONE_VENDAS", alterado).erros), ["FORMATO_NAO_RECONHECIDO"]);
  const ruins = analisar("STONE", "STONE_VENDAS", stoneXlsx([
    ["T-1", { dataHora: serie("2026-09-02", "12:00") }, "Débito", "B", 20.005, 0, 0, 20.005, "Aprovada"],
    ["T-2", { dataHora: serie("2026-09-02", "12:10") }, "Débito", "B", { formula: "X1+1" }, 0, 0, 10, "Aprovada"],
    ["T-3", { dataHora: serie("2026-09-02", "12:20") }, "Débito", "B", "dez reais", 0, 0, 10, "Aprovada"],
  ]));
  assert.deepEqual(codigos(ruins.erros), ["VALOR_INVALIDO", "VALOR_INVALIDO", "VALOR_INVALIDO", "VALOR_INVALIDO"]);
  assert.equal(ruins.registros.length, 0);
  assert.ok(codigos(ruins.divergencias).includes("ANOMALIA_DE_PLANILHA")); // a fórmula sem resultado também fica registrada
});

test("XLSX: identificador repetido no arquivo é detectado (idêntico conta uma vez; diferente é conflito)", () => {
  const linha = ["T-9", { dataHora: serie("2026-09-02", "12:00") }, "Débito", "B", 10, 0.2, 0, 9.8, "Aprovada"];
  assert.equal(analisar("STONE", "STONE_VENDAS", stoneXlsx([linha, linha])).duplicadosNoArquivo.length, 1);
  const outro = [...linha];
  outro[4] = 11;
  outro[7] = 10.8;
  assert.deepEqual(codigos(analisar("STONE", "STONE_VENDAS", stoneXlsx([linha, outro])).erros), ["CONFLITO_NO_ARQUIVO"]);
});

const extratoPdf = (extra = {}) => pdf([
  ["COOPERATIVA SINTÉTICA - EXTRATO DE CONTA", "Período: 01/09/2026 a 30/09/2026", "Data Histórico Valor Saldo", "SALDO ANTERIOR 1.000,00",
    "02/09 PIX RECEBIDO 500,00 1.500,00", "CLIENTE SINTETICO ALFA", "03/09 PAGAMENTO BOLETO 200,00 D 1.300,00", "Página 1 de 2"],
  ["03/09 TARIFA PACOTE 15,50 D 1.284,50", "05/09 CRED ADQUIRENTE", "DEPOSITO SINTETICO 715,50 2.000,00", "SALDO FINAL 2.000,00", "SALDO ATUAL 9.999,99", "Página 2 de 2"],
], extra);

test("PDF digital: páginas, linhas, descrição multilinha, saldos inicial/final, saldo atual separado e página de origem", () => {
  const doc = lerPdf(extratoPdf());
  assert.equal(doc.paginas.length, 2);
  assert.equal(doc.digitalizado, false);
  assert.equal(doc.incompleto, false);
  const a = analisar("UNICRED", "UNICRED_EXTRATO", extratoPdf());
  assert.equal(a.formato, "pdf");
  assert.deepEqual(a.erros, []);
  assert.deepEqual(a.divergencias, []);
  assert.equal(a.registros.length, 4);
  assert.equal(a.registros[0].dados.historico, "PIX RECEBIDO CLIENTE SINTETICO ALFA");
  assert.equal(a.registros[3].dados.historico, "CRED ADQUIRENTE DEPOSITO SINTETICO");
  assert.deepEqual(a.registros.map((r) => r.dados.pagina), [1, 1, 2, 2]);
  assert.deepEqual(a.registros.map((r) => r.dados.sentido), ["ENTRADA", "SAIDA", "SAIDA", "ENTRADA"]);
  assert.equal(a.controles.saldoFecha, true);
  assert.equal(a.controles.saldoFinalCentavos, 200000);
  assert.equal(a.controles.saldoAtualCentavos, 999999); // registrado, mas NÃO usado como saldo do período
  assert.equal(a.controles.paginas, 2);
  // Fontes com ToUnicode (códigos de 2 bytes) e objetos dentro de object stream também são lidos.
  assert.equal(analisar("UNICRED", "UNICRED_EXTRATO", extratoPdf({ toUnicode: true, objStm: true })).registros.length, 4);
});

test("PDF: incompleto, digitalizado (sem OCR), saldo divergente e movimentação faltante são sinalizados", () => {
  assert.deepEqual(codigos(analisar("UNICRED", "UNICRED_EXTRATO", extratoPdf({ declararPaginas: 3 })).erros), ["PDF_INCOMPLETO"]);
  const scan = pdf([["x"]], { imagemSemTexto: true });
  assert.equal(lerPdf(scan).digitalizado, true);
  assert.deepEqual(codigos(analisar("UNICRED", "UNICRED_EXTRATO", scan).erros), ["PDF_DIGITALIZADO"]);
  // Uma linha some do meio: o encadeamento de saldos e o fechamento denunciam.
  const faltando = pdf([["SALDO ANTERIOR 1.000,00", "02/09 PIX RECEBIDO 500,00 1.500,00", "04/09 TARIFA 15,50 D 1.284,50", "SALDO FINAL 1.284,50"]]);
  const a = analisar("UNICRED", "UNICRED_EXTRATO", faltando);
  assert.ok(codigos(a.divergencias).includes("LINHA_NAO_FECHA"));
  assert.ok(codigos(a.divergencias).includes("SALDO_NAO_FECHA"));
  assert.throws(() => lerPdf(new TextEncoder().encode("não é pdf")), (e) => e.codigo === CODIGO.IMPORTACAO_INVALIDA);
  assert.deepEqual(codigos(analisar("UNICRED", "UNICRED_EXTRATO", new TextEncoder().encode("%PDF-1.4\n/Encrypt 5 0 R\n")).erros), ["FORMATO_NAO_RECONHECIDO"]);
});

test("OFX 1.x e 2.x: FITID vira identificador; saldo só é final se for da data de fim; inválido é recusado", () => {
  const trn = [{ data: "20260902", valor: "500.00", fitid: "F1", memo: "PIX RECEBIDO" }, { data: "20260903", valor: "-200.00", fitid: "F2", memo: "BOLETO", documento: "123" }];
  for (const versao of [1, 2]) {
    const o = lerOfx(new TextDecoder().decode(ofx({ transacoes: trn, saldo: "1300.00", versao })));
    assert.equal(o.transacoes.length, 2);
    assert.equal(o.inicio, "2026-09-01");
  }
  const a = analisar("UNICRED", "UNICRED_EXTRATO", ofx({ transacoes: trn, saldo: "1300.00" }));
  assert.equal(a.formato, "ofx");
  assert.deepEqual(a.erros, []);
  assert.deepEqual(a.registros.map((r) => r.idExterno), ["F1", "F2"]);
  assert.ok(a.registros.every((r) => r.identificacao === "ID_EXTERNO"));
  assert.equal(a.controles.saldoFinalCentavos, 130000);
  assert.ok(codigos(a.divergencias).includes("SALDO_NAO_FECHA")); // OFX sem saldo inicial: consistência não comprovável
  const atual = analisar("UNICRED", "UNICRED_EXTRATO", ofx({ transacoes: trn, saldo: "9999.00", saldoEm: "20261112" }));
  assert.equal(atual.controles.saldoFinalCentavos, null);
  assert.equal(atual.controles.saldoAtualCentavos, 999900);
  assert.throws(() => lerOfx("OFXHEADER:100\nnada"), (e) => e.codigo === CODIGO.IMPORTACAO_INVALIDA);
});

test("formato detectado pelo conteúdo: PDF não é aceito como relatório Stone; binário desconhecido é recusado", () => {
  assert.equal(detectarFormato(extratoPdf()), "pdf");
  assert.equal(detectarFormato(stoneXlsx([])), "xlsx");
  assert.equal(detectarFormato(ofx({ transacoes: [] })), "ofx");
  assert.deepEqual(codigos(analisar("STONE", "STONE_VENDAS", extratoPdf()).erros), ["FORMATO_NAO_SUPORTADO"]);
  assert.deepEqual(codigos(analisar("SAIPOS", "SAIPOS_VENDAS", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 0])).erros), ["FORMATO_NAO_SUPORTADO"]);
});

test("núcleo: XLSX Stone e PDF Unicred passam pela prévia sem efeito financeiro, com repetição e versão corrigida", async () => {
  const { nucleo } = montar();
  const c = ctx();
  const linhas = [["T-1", { dataHora: serie("2026-09-02", "12:00") }, "Débito", "B", 20, 0.3, 0, 19.7, "Aprovada"]];
  const receber = (fonte, tipoRelatorio, conteudo, extra = {}) => nucleo.receberArquivoParaImportacao(c, { fonte, tipoRelatorio, tipoMime: "application/octet-stream", conteudo, ...PERIODO_SETEMBRO, ...extra });
  const st = await receber("STONE", "STONE_VENDAS", stoneXlsx(linhas));
  assert.equal(st.importacao.estado, "PRONTO_PARA_IMPORTAR");
  assert.equal((await receber("STONE", "STONE_VENDAS", stoneXlsx(linhas))).repetido, true);
  await nucleo.confirmarImportacao(c, { importacaoId: st.importacao.id, impressaoPrevia: st.importacao.impressaoPrevia });
  const un = await receber("UNICRED", "UNICRED_EXTRATO", extratoPdf());
  const conf = await nucleo.confirmarImportacao(c, { importacaoId: un.importacao.id, impressaoPrevia: un.importacao.impressaoPrevia });
  assert.equal(conf.relatorio.inseridos, 4);
  const v2 = await receber("UNICRED", "UNICRED_EXTRATO", extratoPdf({ toUnicode: true }), { substituiImportacaoId: un.importacao.id });
  const c2 = await nucleo.confirmarImportacao(c, { importacaoId: v2.importacao.id, impressaoPrevia: v2.importacao.impressaoPrevia });
  assert.equal(c2.relatorio.registrosSubstituidos, 4);
  for (const indicador of ["RECEITA_BRUTA", "DESPESAS"]) assert.equal((await nucleo.consultarComposicao(c, { competencia: "2026-09", indicador })).totalCentavos, 0);
  const scan = await receber("UNICRED", "UNICRED_EXTRATO", pdf([["x"]], { imagemSemTexto: true }));
  assert.equal(scan.importacao.estado, "REJEITADO");
  const preservado = await nucleo.lerArquivoDoDocumento(c, { documentoId: scan.importacao.documentoId });
  assert.ok(preservado.conteudo.byteLength > 0); // ilegível, mas preservado no cofre
  await rejeita(nucleo.confirmarImportacao(c, { importacaoId: scan.importacao.id, impressaoPrevia: scan.importacao.impressaoPrevia }), CODIGO.TRANSICAO_INVALIDA);
});
