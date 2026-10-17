import { test } from "node:test";
import assert from "node:assert/strict";
import XLSX from "xlsx";
import { neutralizar, decimalExato, celulaCsv, montarCsv, montarXlsx, codigoVerificacao, nomeArquivo, serialExcel, dataBr } from "../../src/financeiro-calculos/exportacao.js";

// Dados sintéticos.
const rel = (extra = {}) => ({
  id: "movimentacoes", titulo: "Histórico de movimentações",
  colunas: [{ id: "data", rotulo: "Data", tipo: "data" }, { id: "descricao", rotulo: "Descrição", tipo: "texto" }, { id: "valor", rotulo: "Valor (R$)", tipo: "moeda" }, { id: "pct", rotulo: "% receita", tipo: "pct" }, { id: "pend", rotulo: "Pendente", tipo: "booleano" }, { id: "n", rotulo: "Qtd", tipo: "inteiro" }],
  linhas: [
    { data: "2026-09-01", descricao: "Venda do dia", valor: 123456, pct: 1888, pend: false, n: 3 },
    { data: "2026-09-02", descricao: "Compra; com \"aspas\"\nquebra", valor: -5, pct: null, pend: true, n: 0 },
    { data: "2026-09-03", descricao: "sem valor", valor: null, pct: null, pend: false, n: null },
  ],
  totais: { valor: 123451 },
  meta: { periodo: { de: "2026-09-01", ate: "2026-09-30" }, filtros: [{ rotulo: "Conta", valor: "CAIXA" }, { rotulo: "Tipo", valor: "" }], parcial: true, avisos: ["2 lançamento(s) sem classificação"], geradoEm: "2026-10-17T12:00:00.000Z" },
  ...extra,
});

test("neutralização: = + - @ tab CR LF (e precedidos de espaço/invisíveis) ganham apóstrofo; texto comum e números não", () => {
  for (const p of ["=1+1", "+55 11", "-2+3", "@SOMA(A1)", "\tcmd", "\rcmd", "\ncmd", "  =HYPERLINK(\"http://x\")", " =1", "​+1", "=cmd|' /C calc'!A0"]) assert.equal(neutralizar(p), `'${p}`, JSON.stringify(p));
  for (const p of ["Venda", "100% ok", "a=b", "Taxa - Stone", "", "ＵＴＦ", "＝fullwidth"]) assert.equal(neutralizar(p), p);
  assert.equal(neutralizar(null), "");
  assert.equal(neutralizar(12), "12");
});

test("decimal exato: centavos → texto sem float, para todo o intervalo relevante (propriedade com 20 mil valores)", () => {
  assert.equal(decimalExato(0), "0.00"); assert.equal(decimalExato(5), "0.05"); assert.equal(decimalExato(-5), "-0.05"); assert.equal(decimalExato(7769484), "77694.84");
  assert.equal(decimalExato(-123456789012), "-1234567890.12");
  assert.throws(() => decimalExato(1.5), RangeError);
  let x = 12345;
  for (let i = 0; i < 20000; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const c = (i % 2 ? -1 : 1) * (x * (1 + (i % 400)));
    const t = decimalExato(c);
    assert.match(t, /^-?\d+\.\d{2}$/);
    assert.equal(Math.round(Number(t) * 100), c, `ida e volta falhou para ${c}`);   // o que o Excel lê volta ao centavo
  }
});

test("CSV: BOM, ';', decimal ',', datas BR, CRLF; vazio ≠ zero; texto com ; aspas e quebra é escapado; bloco de rastreabilidade", () => {
  const csv = montarCsv(rel());
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes("\r\n"));
  assert.match(csv, /Relatório;Histórico de movimentações/);
  assert.match(csv, /Regime;"Regime de caixa \(gerencial\)/);          // o texto contém ';' → corretamente entre aspas
  assert.match(csv, /Período;01\/09\/2026 a 30\/09\/2026/);
  assert.match(csv, /Filtros;Conta: CAIXA/);
  assert.doesNotMatch(csv, /Tipo:/);                                  // filtro vazio não aparece
  assert.match(csv, /Situação dos dados;PARCIAL/);
  assert.match(csv, /Aviso 1;2 lançamento\(s\) sem classificação/);
  assert.match(csv, /Gerado em;2026-10-17T12:00:00.000Z/);
  assert.match(csv, /Código de verificação;[0-9A-F]{4}(-[0-9A-F]{4}){3}/);
  assert.match(csv, /Data;Descrição;Valor \(R\$\);% receita;Pendente;Qtd/);
  assert.match(csv, /01\/09\/2026;Venda do dia;1234,56;18,88;Não;3/);
  assert.match(csv, /02\/09\/2026;"Compra; com ""aspas""\nquebra";-0,05;;Sim;0/);
  assert.match(csv, /03\/09\/2026;sem valor;;;Não;\r\n/);              // valor ausente: célula vazia, NUNCA 0,00
  assert.match(csv, /TOTAL;;1234,51;;;\r\n$/);
  assert.doesNotMatch(csv, /1234\.56|1\.234,56/);                    // sem ponto decimal nem separador de milhar
});

test("CSV: injeção de fórmula neutralizada em descrição, filtros, avisos e cabeçalhos; números negativos continuam numéricos", () => {
  const csv = montarCsv(rel({
    colunas: [{ id: "d", rotulo: "=Rotulo", tipo: "texto" }, { id: "v", rotulo: "Valor", tipo: "moeda" }],
    linhas: [{ d: "=HYPERLINK(\"http://evil\",\"x\")", v: -1234 }, { d: "+cmd", v: 5 }, { d: "@SUM(1)", v: 0 }],
    totais: null,
    meta: { periodo: {}, filtros: [{ rotulo: "Conta", valor: "=CONTA" }], parcial: false, avisos: ["-aviso"], geradoEm: "2026-10-17T12:00:00.000Z" },
  }));
  assert.match(csv, /'=Rotulo/);
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil"",""x""\)";-12,34/);
  assert.match(csv, /'\+cmd;0,05/);
  assert.match(csv, /'@SUM\(1\);0,00/);
  assert.match(csv, /Conta: =CONTA|Filtros;'Conta: =CONTA|Filtros;Conta: =CONTA/);
  assert.match(csv, /Aviso 1;'-aviso/);
  // nenhuma LINHA de dados/informações começa com caractere de fórmula
  for (const linha of csv.replace("﻿", "").split("\r\n").filter(Boolean)) assert.doesNotMatch(linha, /^[=+@]/);
});

test("XLSX: abas Dados e Informações; moeda numérica exata ao centavo; vazio sem célula; texto neutralizado; datas como data; totais", () => {
  const buf = montarXlsx(rel({ linhas: [...rel().linhas, { data: "2026-09-04", descricao: "=1+1", valor: 7769484, pct: 0, pend: false, n: 1 }] }));
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false, cellNF: true });
  assert.deepEqual(wb.SheetNames, ["Dados", "Informações"]);
  const d = wb.Sheets.Dados;
  assert.equal(d.A1.v, "Data"); assert.equal(d.C1.v, "Valor (R$)");
  assert.equal(d.C2.t, "n"); assert.equal(Math.round(d.C2.v * 100), 123456); assert.equal(d.C2.z, "#,##0.00");
  assert.equal(Math.round(d.C3.v * 100), -5);
  assert.equal(d.C4, undefined);                                        // valor ausente: sem célula
  assert.equal(Math.round(d.C5.v * 100), 7769484);
  assert.equal(d.B5.t, "s"); assert.equal(d.B5.v, "'=1+1"); assert.equal(d.B5.f, undefined);   // texto, nunca fórmula
  assert.equal(d.A2.v, serialExcel("2026-09-01")); assert.equal(d.A2.z, "dd/mm/yyyy");
  assert.equal(d.A6.v, "TOTAL"); assert.equal(Math.round(d.C6.v * 100), 123451);
  assert.equal(d.E2.v, "Não"); assert.equal(d.E3.v, "Sim");
  const i = wb.Sheets["Informações"];
  const texto = Object.keys(i).filter((k) => !k.startsWith("!")).map((k) => i[k].v).join("|");
  assert.match(texto, /Regime de caixa/); assert.match(texto, /PARCIAL/); assert.match(texto, /01\/09\/2026 a 30\/09\/2026/); assert.match(texto, /[0-9A-F]{4}-[0-9A-F]{4}/);
  // nenhuma célula do arquivo tem fórmula
  for (const aba of Object.values(wb.Sheets)) for (const k of Object.keys(aba).filter((x) => !x.startsWith("!"))) assert.equal(aba[k].f, undefined, k);
});

test("XLSX: ida e volta de centavos para valores grandes e negativos (precisão monetária)", () => {
  const valores = [0, 1, 99, 100, 101, 123456, 7769484, 15008406, 99999999999, -1, -123456789, 1234567890123];
  const r = { id: "t", titulo: "t", colunas: [{ id: "v", rotulo: "v", tipo: "moeda" }], linhas: valores.map((v) => ({ v })), meta: {} };
  const d = XLSX.read(montarXlsx(r), { type: "buffer" }).Sheets.Dados;
  valores.forEach((v, i) => assert.equal(Math.round(d[`A${i + 2}`].v * 100), v, String(v)));
});

test("código de verificação muda com o conteúdo e é estável para o mesmo conteúdo; nome de arquivo seguro", () => {
  const a = codigoVerificacao(rel()), b = codigoVerificacao(rel());
  assert.equal(a, b);
  const outro = rel(); outro.linhas[0].valor += 1;
  assert.notEqual(codigoVerificacao(outro), a);
  assert.equal(nomeArquivo(rel(), "csv"), "movimentacoes_2026-09-01_2026-09-30_202610171200.csv");
  assert.match(nomeArquivo(rel({ id: "../../etc/passwd", meta: { periodo: { de: "x\"y", ate: null } } }), "xlsx"), /^etcpasswd_inicio_fim_sem-data\.xlsx$/);
  assert.equal(dataBr("2026-09-02"), "02/09/2026"); assert.equal(dataBr("lixo"), "");
});

test("célula tipada: tipos desconhecidos viram texto neutralizado; moeda ausente é vazia", () => {
  assert.equal(celulaCsv("moeda", null), ""); assert.equal(celulaCsv("moeda", 0), "0,00");
  assert.equal(celulaCsv("inventado", "=x"), "'=x");
  assert.equal(celulaCsv("pct", 5), "0,05");
});
