// Exportação de relatórios (CSV e XLSX) — funções PURAS. Garantias:
//  • dinheiro em CENTAVOS INTEIROS até o último passo; texto decimal exato (sem float); ausente (null) vira célula VAZIA, nunca "0,00";
//  • neutralização de injeção de fórmula (CSV/XLSX): texto que começa com = + - @ (ou tab/CR/LF) ganha um apóstrofo; números ficam numéricos;
//  • CSV para planilhas brasileiras: UTF-8 com BOM, separador ";", decimal ",", datas dd/mm/aaaa, CRLF;
//  • rastreabilidade: bloco de informações (relatório, período, regime de caixa, filtros, situação parcial, geração, código de verificação).
import { createHash } from "node:crypto";
import XLSX from "xlsx";

export const LIMITE_LINHAS_EXPORTACAO = 50_000;
const SEPARADOR = ";";

/** Neutraliza texto que uma planilha interpretaria como fórmula/comando. Só para TEXTO (números não passam por aqui). */
export function neutralizar(valor) {
  const s = String(valor ?? "");
  // inicia (após espaços/controles invisíveis) com = + - @ ; ou começa com tab/CR/LF
  if (/^[\t\r\n]/.test(s) || /^[\s\u0000-\u001f ​﻿]*[=+\-@]/.test(s)) return `'${s}`;
  return s;
}

/** centavos inteiros → "1234.56" exato (sem float). */
export function decimalExato(centavos) {
  if (!Number.isSafeInteger(centavos)) throw new RangeError("centavos deve ser inteiro seguro");
  const neg = centavos < 0;
  const abs = Math.abs(centavos);
  return `${neg ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
const virgula = (s) => s.replace(".", ",");

/** "AAAA-MM-DD" → "dd/mm/aaaa" (ou "" se inválida). */
export const dataBr = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso ?? "") ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
/** "AAAA-MM-DD" → serial de data do Excel. */
export function serialExcel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return null;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) + 25569;
}

/** Representação TEXTUAL (CSV) de uma célula tipada. */
export function celulaCsv(tipo, v) {
  if (v === null || v === undefined || v === "") return "";
  switch (tipo) {
    case "moeda": return virgula(decimalExato(v));
    case "pct": return virgula(decimalExato(v));                 // bps → "18,88" (percentual com a unidade no rótulo da coluna)
    case "inteiro": return String(Math.trunc(Number(v)));
    case "data": return dataBr(v);
    case "booleano": return v ? "Sim" : "Não";
    default: return neutralizar(v);
  }
}

const precisaAspas = (s) => /[;"\r\n]/.test(s);
const campoCsv = (s) => (precisaAspas(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Código de verificação: SHA-256 do CONTEÚDO (colunas + linhas), para conferir que o arquivo corresponde aos dados. */
export function codigoVerificacao(relatorio) {
  const h = createHash("sha256").update(JSON.stringify([relatorio.colunas.map((c) => [c.id, c.tipo]), relatorio.linhas, relatorio.totais ?? null]), "utf8").digest("hex");
  return h.slice(0, 16).toUpperCase().replace(/(.{4})/g, "$1-").slice(0, -1);
}

/** Bloco de informações (rótulo, valor) comum a CSV e XLSX. */
export function blocoInformacoes(r) {
  const m = r.meta ?? {};
  const per = m.periodo?.de || m.periodo?.ate ? `${dataBr(m.periodo.de) || "início"} a ${dataBr(m.periodo.ate) || "hoje"}` : "Todo o período";
  const filtros = (m.filtros ?? []).filter((f) => f.valor).map((f) => `${f.rotulo}: ${f.valor}`).join("; ") || "Nenhum";
  return [
    ["Relatório", r.titulo],
    ["Regime", "Regime de caixa (gerencial): recebimentos e pagamentos efetivos; não é contabilidade de competência"],
    ["Período", per],
    ["Filtros", filtros],
    ["Situação dos dados", m.parcial ? "PARCIAL — leia os avisos abaixo" : "Completo para os filtros aplicados"],
    ...((m.avisos ?? []).map((a, i) => [`Aviso ${i + 1}`, a])),
    ["Linhas", String(r.linhas.length)],
    ["Gerado em", m.geradoEm ?? ""],
    ["Código de verificação", codigoVerificacao(r)],
  ];
}

/** CSV completo (string). Texto neutralizado; números exatos; BOM; CRLF. */
export function montarCsv(r) {
  const linhas = [];
  for (const [k, v] of blocoInformacoes(r)) linhas.push([neutralizar(k), neutralizar(v)].map(campoCsv).join(SEPARADOR));
  linhas.push("");
  linhas.push(r.colunas.map((c) => campoCsv(neutralizar(c.rotulo))).join(SEPARADOR));
  for (const l of r.linhas) linhas.push(r.colunas.map((c) => campoCsv(celulaCsv(c.tipo, l[c.id]))).join(SEPARADOR));
  if (r.totais) linhas.push(r.colunas.map((c, i) => campoCsv(i === 0 ? "TOTAL" : celulaCsv(c.tipo, r.totais[c.id]))).join(SEPARADOR));
  return `﻿${linhas.join("\r\n")}\r\n`;
}

const FORMATO = { moeda: "#,##0.00", pct: '0.00"%"', inteiro: "0", data: "dd/mm/yyyy" };

/** Célula XLSX tipada. Texto vira string neutralizada; moeda é número (centavos/100, exato ao centavo); ausente = célula inexistente. */
function celulaXlsx(tipo, v) {
  if (v === null || v === undefined || v === "") return null;
  switch (tipo) {
    case "moeda": return { t: "n", v: Number(decimalExato(v)), z: FORMATO.moeda };
    case "pct": return { t: "n", v: Number(decimalExato(v)), z: FORMATO.pct };
    case "inteiro": return { t: "n", v: Math.trunc(Number(v)), z: FORMATO.inteiro };
    case "data": { const n = serialExcel(v); return n === null ? null : { t: "n", v: n, z: FORMATO.data }; }
    case "booleano": return { t: "s", v: v ? "Sim" : "Não" };
    default: return { t: "s", v: neutralizar(v) };
  }
}

/** XLSX (Buffer): aba "Dados" (tabela pura, pronta para tabela dinâmica) e aba "Informações" (rastreabilidade). */
export function montarXlsx(r) {
  const dados = {};
  const colunas = r.colunas;
  colunas.forEach((c, j) => { dados[XLSX.utils.encode_cell({ r: 0, c: j })] = { t: "s", v: neutralizar(c.rotulo) }; });
  r.linhas.forEach((l, i) => colunas.forEach((c, j) => { const x = celulaXlsx(c.tipo, l[c.id]); if (x) dados[XLSX.utils.encode_cell({ r: i + 1, c: j })] = x; }));
  let ultima = r.linhas.length;
  if (r.totais) {
    ultima += 1;
    colunas.forEach((c, j) => { const x = j === 0 ? { t: "s", v: "TOTAL" } : celulaXlsx(c.tipo, r.totais[c.id]); if (x) dados[XLSX.utils.encode_cell({ r: ultima, c: j })] = x; });
  }
  dados["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(ultima, 0), c: Math.max(colunas.length - 1, 0) } });
  dados["!cols"] = colunas.map((c) => ({ wch: c.tipo === "texto" ? 36 : 16 }));
  const info = {};
  const bloco = blocoInformacoes(r);
  bloco.forEach(([k, v], i) => {
    info[XLSX.utils.encode_cell({ r: i, c: 0 })] = { t: "s", v: neutralizar(k) };
    info[XLSX.utils.encode_cell({ r: i, c: 1 })] = { t: "s", v: neutralizar(v) };
  });
  info["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: bloco.length - 1, c: 1 } });
  info["!cols"] = [{ wch: 24 }, { wch: 90 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, dados, "Dados");
  XLSX.utils.book_append_sheet(wb, info, "Informações");
  wb.Props = { Title: String(r.titulo).slice(0, 120), Author: "Central Crescer com Delivery", CreatedDate: new Date(r.meta?.geradoEm ?? Date.now()) };
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

/** Nome de arquivo seguro (ASCII, sem entrada livre do usuário). */
export function nomeArquivo(r, formato) {
  const slug = String(r.id).replace(/[^a-z0-9-]/gi, "");
  const d = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(x ?? "") ? x : null);
  const ger = String(r.meta?.geradoEm ?? "").slice(0, 16).replace(/[^0-9]/g, "");
  return `${slug}_${d(r.meta?.periodo?.de) ?? "inicio"}_${d(r.meta?.periodo?.ate) ?? "fim"}_${ger || "sem-data"}.${formato === "xlsx" ? "xlsx" : "csv"}`;
}
