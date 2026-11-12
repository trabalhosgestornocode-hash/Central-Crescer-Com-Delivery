// Leitura PURA de arquivos tabulares (CSV/TSV/;), sem tocar em disco, rede ou banco.
// O arquivo nunca é alterado: os bytes entram, uma tabela de textos sai. Conversões (dinheiro, datas) são estritas —
// valor que não segue o formato esperado vira ERRO com o número da linha, nunca um palpite.
import { CODIGO, ErroFinanceiro } from "../dominio/erros.js";
import { centavosDeTextoBR } from "../dominio/dinheiro.js";
import { ehData } from "../dominio/tempo.js";

/** Bytes → texto. UTF-8 estrito; se não for UTF-8 válido, Windows-1252 (exportações antigas de planilha). Sem BOM. */
export function decodificar(bytes) {
  let texto;
  try {
    texto = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    texto = new TextDecoder("windows-1252").decode(bytes);
  }
  return texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;
}

function separadorProvavel(texto) {
  const primeira = texto.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const contagem = { ";": 0, ",": 0, "\t": 0 };
  let aspas = false;
  for (const ch of primeira) {
    if (ch === "\"") aspas = !aspas;
    else if (!aspas && ch in contagem) contagem[ch] += 1;
  }
  return Object.entries(contagem).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(contagem).sort((a, b) => b[1] - a[1])[0][0] : ";";
}

/** Texto → linhas de células (RFC 4180: aspas, aspas duplicadas, quebra de linha dentro de aspas). */
export function lerTabela(texto) {
  const sep = separadorProvavel(texto);
  const linhas = [];
  let linha = [];
  let celula = "";
  let aspas = false;
  for (let i = 0; i < texto.length; i += 1) {
    const ch = texto[i];
    if (aspas) {
      if (ch === "\"" && texto[i + 1] === "\"") { celula += "\""; i += 1; }
      else if (ch === "\"") aspas = false;
      else celula += ch;
    } else if (ch === "\"") aspas = true;
    else if (ch === sep) { linha.push(celula); celula = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && texto[i + 1] === "\n") i += 1;
      linha.push(celula); linhas.push(linha); linha = []; celula = "";
    } else celula += ch;
  }
  if (celula !== "" || linha.length) { linha.push(celula); linhas.push(linha); }
  return { separador: sep, linhas: linhas.map((l) => l.map((c) => c.trim())) };
}

/** "Valor Líquido (R$)" → "valor liquido r". Comparação de rótulos sem acento, caixa ou pontuação. */
export const rotulo = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Procura, nas primeiras linhas, o cabeçalho que contém TODAS as colunas obrigatórias.
 * @param {string[][]} linhas
 * @param {Record<string, {rotulos:string[], obrigatorio?:boolean}>} colunas
 */
export function localizarCabecalho(linhas, colunas, { busca = 20 } = {}) {
  let melhor = { indice: -1, mapa: {}, faltando: Object.keys(colunas).filter((c) => colunas[c].obrigatorio !== false) };
  for (let i = 0; i < Math.min(linhas.length, busca); i += 1) {
    const rotulos = linhas[i].map(rotulo);
    const mapa = {};
    for (const [campo, def] of Object.entries(colunas)) {
      const j = rotulos.findIndex((r) => def.rotulos.map(rotulo).includes(r));
      if (j >= 0) mapa[campo] = j;
    }
    const faltando = Object.keys(colunas).filter((c) => colunas[c].obrigatorio !== false && !(c in mapa));
    if (faltando.length < melhor.faltando.length) melhor = { indice: i, mapa, faltando };
    if (!faltando.length) break;
  }
  return melhor;
}

/** Erro de uma linha do arquivo (vira item da prévia; nunca é engolido). */
export const erroDeLinha = (codigo, mensagem, linha, campo) => ({ codigo, mensagem, linha, campo: campo ?? null });

/** "1.234,56" / "-12,30" / "R$ 10,00" → centavos. Aceita também "1234.56" (exportação com ponto decimal). */
export function centavos(texto, campo) {
  const t = String(texto ?? "").replace(/\s+/g, " ").trim();
  if (!t) throw new ErroFinanceiro(CODIGO.VALOR_INVALIDO, `${campo} vazio.`, { campo });
  if (/^-?\d{1,15}\.\d{1,2}$/.test(t)) return centavosDeTextoBR(t.replace(".", ","), campo);
  // "20.005" sem vírgula é AMBÍGUO (20 mil e 5? 20 reais e meio centavo de planilha?): nunca se adivinha.
  if (/^-?\d{1,3}\.\d{3}$/.test(t) || /^-?\d+\.\d{3,}$/.test(t)) throw new ErroFinanceiro(CODIGO.VALOR_INVALIDO, `${campo} ambíguo ou com mais de 2 casas decimais.`, { campo });
  return centavosDeTextoBR(t, campo);
}

/** "31/12/2026" ou "2026-12-31" (com hora opcional) → { data:"2026-12-31", hora:"23:59:00"|null }. */
export function dataHora(texto, campo) {
  const t = String(texto ?? "").trim();
  let m = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  let data;
  let h;
  if (m) { data = `${m[3]}-${m[2]}-${m[1]}`; h = m.slice(4); }
  else {
    m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
    if (m) { data = `${m[1]}-${m[2]}-${m[3]}`; h = m.slice(4); }
  }
  if (!data || !ehData(data)) throw new ErroFinanceiro(CODIGO.DATA_INVALIDA, `${campo} não é uma data válida (dd/mm/aaaa).`, { campo });
  const hora = h?.[0] ? `${h[0]}:${h[1]}:${h[2] ?? "00"}` : null;
  if (hora && (Number(h[0]) > 23 || Number(h[1]) > 59 || Number(h[2] ?? 0) > 59)) throw new ErroFinanceiro(CODIGO.DATA_INVALIDA, `${campo} tem hora inválida.`, { campo });
  return { data, hora };
}
