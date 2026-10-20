import { test } from "node:test";
import assert from "node:assert/strict";
import XLSX from "xlsx";
import { lerLivroCaixaXlsx } from "../../src/modules/gestao-financeira/dominio/importacao/leitorXlsx.js";
import { montarPrevia } from "../../src/financeiro-calculos/importacao.js";

// Planilhas 100% sintéticas, montadas em memória.
function livro(abas) {
  const wb = XLSX.utils.book_new();
  for (const [nome, ws] of abas) XLSX.utils.book_append_sheet(wb, ws, nome);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
const serial = (iso) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000) + 25569;

function abaFluxo({ colunasEmOrdemTroca = false } = {}) {
  const cab = ["DATA", "LANÇAMENTOS", "ENTRADA", "SAIDA", "TIPO", "NATUREZA", "CATEGORIA", "CONTA"];
  const linhas = [
    ["TOTAL DO FILTRO →", 1000.5, 300.25],
    [],
    cab,
    [serial("2026-09-01"), "SALDO MÊS ANTERIOR - A", 100, 0, "SALDO ANTERIOR", "SALDO ANTERIOR", "SALDO ANTERIOR", "A"],
    [serial("2026-09-02"), "VENDA", 900.5, 0, "RECEITA", "RECEBIMENTO DE CLIENTE", "RECEBIMENTO DE CLIENTE", "A"],
    [serial("2026-09-03"), "COMPRA", 0, 300.25, "CUSTO", "VARIAVEL", "INSUMOS", "A"],
  ];
  // o total declarado foi montado para conferir: entradas 100 + 900.5 = 1000.5; saídas 300.25
  const ws = XLSX.utils.aoa_to_sheet(linhas.map((l) => (colunasEmOrdemTroca ? l : l)));
  ws["!ref"] = "A1:H6";
  // total na linha 1 estava em B/C; reposiciona onde o leitor procura (qualquer coluna à direita do rótulo)
  return ws;
}

test("lê só a aba do fluxo, localiza colunas pelo nome, converte serial de data e confere o total declarado", () => {
  const buf = livro([["DASHBOARD", XLSX.utils.aoa_to_sheet([["x"]])], ["FLUXO DE CAIXA", abaFluxo()], ["UNICRED", XLSX.utils.aoa_to_sheet([["y"]])]]);
  const r = lerLivroCaixaXlsx(buf);
  assert.equal(r.aba, "FLUXO DE CAIXA");
  assert.deepEqual(r.abasIgnoradas, ["DASHBOARD", "UNICRED"]);
  assert.equal(r.brutas.length, 3);
  assert.deepEqual(r.totalDeclarado, { entradaCentavos: 100050, saidaCentavos: 30025 });
  const p = montarPrevia({ brutas: r.brutas, totalDeclarado: r.totalDeclarado });
  assert.equal(p.resumo.conferencia.confere, true);
  assert.equal(p.lancamentos[0].data, "2026-09-02");
  assert.equal(p.saldos[0].valor_centavos, 10000);
});

test("preserva fórmula do valor e comentário da célula como nota de revisão", () => {
  const ws = abaFluxo();
  ws.C5 = { t: "n", v: 140, f: "245-106" };
  ws.B6.c = [{ a: "Revisor", t: "Confirmar categoria" }];
  const r = lerLivroCaixaXlsx(livro([["FLUXO", ws]]));
  const venda = r.brutas.find((b) => b.descricao === "VENDA");
  assert.equal(venda.formulaEntrada, "=245-106");
  assert.equal(venda.entrada, 140);
  assert.match(r.brutas.find((b) => b.descricao === "COMPRA").comentario, /Confirmar categoria/);
  const p = montarPrevia({ brutas: r.brutas });
  assert.match(p.lancamentos.find((l) => l.descricao === "VENDA").nota, /=245-106/);
});

test("colunas em outra ordem e cabeçalho deslocado são aceitos; coluna ausente é recusada com a lista", () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ["lixo"], ["lixo"],
    ["CONTA", "CATEGORIA", "NATUREZA", "TIPO", "SAÍDA", "ENTRADA", "DESCRIÇÃO", "DATA"],
    ["A", "C", "FIXA", "DESPESA", 7, 0, "ALUGUEL", serial("2026-09-05")],
  ]);
  const r = lerLivroCaixaXlsx(livro([["Fluxo de Caixa", ws]]));
  assert.equal(r.brutas[0].saida, 7);
  assert.equal(r.brutas[0].conta, "A");
  const sem = XLSX.utils.aoa_to_sheet([["DATA", "ENTRADA", "SAIDA", "TIPO", "NATUREZA", "CATEGORIA", "CONTA"], [1, 1, 0, "a", "b", "c", "d"]]);
  assert.throws(() => lerLivroCaixaXlsx(livro([["FLUXO", sem]])), (e) => e.statusCode === 400 && e.details?.codigo === "COLUNAS_AUSENTES" && e.details.faltando.includes("descricao"));
});

test("entradas inválidas: vazio, não-zip, aba inexistente, tamanho", () => {
  assert.throws(() => lerLivroCaixaXlsx(Buffer.alloc(0)), (e) => e.statusCode === 400);
  assert.throws(() => lerLivroCaixaXlsx(Buffer.from("isto nao e xlsx")), (e) => e.statusCode === 400);
  assert.throws(() => lerLivroCaixaXlsx(Buffer.alloc(6 * 1024 * 1024, 0x50)), (e) => e.statusCode === 400);
  assert.throws(() => lerLivroCaixaXlsx(livro([["OUTRA", XLSX.utils.aoa_to_sheet([["x"]])]])), (e) => e.details?.codigo === "ABA_NAO_ENCONTRADA");
});

test("linhas de rodapé sem data não viram lançamento", () => {
  const ws = abaFluxo();
  XLSX.utils.sheet_add_aoa(ws, [[null, "SALDO", null, null]], { origin: "A7" });
  const r = lerLivroCaixaXlsx(livro([["FLUXO", ws]]));
  assert.equal(r.brutas.length, 3);
});
