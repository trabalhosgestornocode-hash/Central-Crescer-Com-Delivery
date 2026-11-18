// Leitor XLSX PRÓPRIO (Office Open XML = ZIP + XML), só com node:zlib. Sem dependência externa: as bibliotecas
// disponíveis no backend têm versões antigas com falhas conhecidas ao abrir arquivos hostis, e aqui os arquivos vêm de fora.
//
// Entrega, por aba, as células com TIPO: texto | numero | data | booleano | erro | formula_sem_valor | vazio.
//   - datas: número de série do Excel convertido pela época da pasta (1900 ou 1904), quando o estilo da célula é de data;
//   - fórmula: usa o RESULTADO ARMAZENADO; fórmula sem resultado guardado é sinalizada (nunca recalculada nem virada em 0);
//   - número com mais casas do que o ponto flutuante explica (ex.: 0,1+0,2) é normalizado pelo valor de 15 dígitos.
// Proteções: limite de entradas do ZIP, de tamanho descompactado por entrada e total (bomba de compressão), caminhos
// fixos (nenhum nome de entrada vira caminho de disco), entidades XML só as predefinidas e numéricas.
import { inflateRawSync } from "node:zlib";
import { CODIGO, falhar } from "../../dominio/erros.js";

const LIMITE_ENTRADAS = 2000;
const LIMITE_ENTRADA_BYTES = 64 * 1024 * 1024;
const LIMITE_TOTAL_BYTES = 160 * 1024 * 1024;
const invalido = (mensagem) => falhar(CODIGO.IMPORTACAO_INVALIDA, `XLSX inválido: ${mensagem}`);

/** Lê o diretório central do ZIP e devolve um acesso preguiçoso às entradas por nome. */
export function abrirZip(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) invalido("fim do diretório ZIP não encontrado");
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (total > LIMITE_ENTRADAS) invalido("entradas demais");
  const entradas = new Map();
  for (let n = 0; n < total; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) invalido("diretório central corrompido");
    const metodo = buf.readUInt16LE(p + 10);
    const compactado = buf.readUInt32LE(p + 20);
    const tamanho = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28);
    const el = buf.readUInt16LE(p + 30);
    const cl = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nome = buf.subarray(p + 46, p + 46 + nl).toString("utf8");
    entradas.set(nome, { metodo, compactado, tamanho, local });
    p += 46 + nl + el + cl;
  }
  let consumido = 0;
  return {
    nomes: () => [...entradas.keys()],
    ler(nome) { return this.lerBytes(nome)?.toString("utf8") ?? null; },
    lerBytes(nome) {
      const e = entradas.get(nome);
      if (!e) return null;
      if (e.tamanho > LIMITE_ENTRADA_BYTES) invalido("entrada grande demais");
      if (e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== 0x04034b50) invalido("cabeçalho local corrompido");
      const inicio = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const dados = buf.subarray(inicio, inicio + e.compactado);
      let saida;
      if (e.metodo === 0) saida = Buffer.from(dados);
      else if (e.metodo === 8) {
        try {
          saida = inflateRawSync(dados, { maxOutputLength: LIMITE_ENTRADA_BYTES });
        } catch {
          invalido("conteúdo compactado corrompido ou grande demais");
        }
      } else invalido("método de compressão não suportado");
      consumido += saida.length;
      if (consumido > LIMITE_TOTAL_BYTES) invalido("conteúdo descompactado grande demais");
      return saida;
    },
  };
}

/** ZIP de exportação com UM XLSX dentro devolve o XLSX; um XLSX comum volta como veio. Nenhum nome de entrada vira caminho. */
export function xlsxDentroDoZip(bytes) {
  const zip = abrirZip(bytes);
  const nomes = zip.nomes();
  if (nomes.includes("[Content_Types].xml")) return bytes;
  const planilhas = nomes.filter((n) => n.toLowerCase().endsWith(".xlsx") && !n.includes("/") && !n.includes("\\"));
  if (planilhas.length !== 1 || nomes.length !== 1) invalido("o ZIP precisa conter exatamente uma planilha XLSX");
  return new Uint8Array(zip.lerBytes(planilhas[0]));
}

const ENTIDADES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
export const desescapar = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
  if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTIDADES[e.toLowerCase()];
});
const atributo = (tag, nome) => {
  const m = new RegExp(`\\s${nome}="([^"]*)"`).exec(tag);
  return m ? desescapar(m[1]) : null;
};
const textoDe = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => desescapar(m[1])).join("");

/** "AB12" → 27 (índice de coluna a partir de 0). */
export function colunaDe(ref) {
  const letras = /^([A-Z]+)/.exec(ref)?.[1] ?? "";
  let n = 0;
  for (const ch of letras) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const FORMATOS_DE_DATA_PADRAO = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
function estilosDeData(stylesXml) {
  if (!stylesXml) return new Set();
  const custom = new Map([...stylesXml.matchAll(/<numFmt\s[^>]*>/g)].map((m) => [Number(atributo(m[0], "numFmtId")), atributo(m[0], "formatCode") ?? ""]));
  const ehData = (id) => FORMATOS_DE_DATA_PADRAO.has(id) || (custom.has(id) && /[dmyh]/i.test(custom.get(id).replace(/"[^"]*"|\[[^\]]*\]/g, "")));
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? "";
  const indices = new Set();
  [...xfs.matchAll(/<xf\s[^>]*?\/?>/g)].forEach((m, i) => { if (ehData(Number(atributo(m[0], "numFmtId") ?? 0))) indices.add(i); });
  return indices;
}

/** Série do Excel → "AAAA-MM-DD hh:mm:ss" (aritmética inteira em segundos). */
export function dataDoExcel(serie, data1904 = false) {
  const segundos = Math.round(serie * 86400);
  const base = data1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const iso = new Date(base + segundos * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

/** Número do XLSX → texto decimal estável (15 dígitos significativos, sem notação científica). */
export function numeroComoTexto(texto) {
  const n = Number(texto);
  if (!Number.isFinite(n)) return null;
  let s = n.toPrecision(15);
  if (/e/i.test(s)) s = BigInt(Math.trunc(n)).toString();
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

/**
 * @returns {{abas: Array<{nome:string, linhas: Array<Array<{tipo:string, texto:string, formula:boolean}>>}>, data1904:boolean}}
 */
export function lerXlsx(bytes) {
  const zip = abrirZip(bytes);
  const workbook = zip.ler("xl/workbook.xml") ?? invalido("xl/workbook.xml ausente (não é uma pasta de trabalho Excel)");
  const rels = zip.ler("xl/_rels/workbook.xml.rels") ?? "";
  const alvos = new Map([...rels.matchAll(/<Relationship\s[^>]*>/g)].map((m) => [atributo(m[0], "Id"), atributo(m[0], "Target")]));
  const data1904 = /<workbookPr[^>]*date1904="(1|true)"/.test(workbook);
  const compartilhadas = [...(zip.ler("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textoDe(m[1]));
  const datas = estilosDeData(zip.ler("xl/styles.xml"));
  const abas = [];
  for (const m of workbook.matchAll(/<sheet\s[^>]*?\/?>/g)) {
    const nome = atributo(m[0], "name") ?? `aba${abas.length + 1}`;
    const alvo = alvos.get(atributo(m[0], "r:id"));
    if (!alvo) continue;
    const caminho = alvo.startsWith("/") ? alvo.slice(1) : `xl/${alvo.replace(/^\.\//, "")}`;
    const xml = zip.ler(caminho);
    if (xml === null) invalido(`aba "${nome}" sem conteúdo`);
    const linhas = [];
    for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
      const indice = Number(atributo(r[1] ?? r[3], "r") ?? linhas.length + 1) - 1;
      const linha = [];
      for (const c of (r[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const corpo = c[2] ?? "";
        const ref = atributo(attrs, "r");
        const col = ref ? colunaDe(ref) : linha.length;
        const t = atributo(attrs, "t") ?? "n";
        const s = Number(atributo(attrs, "s") ?? 0);
        const formula = /<f[\s>/]/.test(corpo);
        const v = /<v>([\s\S]*?)<\/v>/.exec(corpo)?.[1];
        let cel;
        if (t === "inlineStr") cel = { tipo: "texto", texto: textoDe(corpo) };
        else if (v === undefined) cel = formula ? { tipo: "formula_sem_valor", texto: "" } : { tipo: "vazio", texto: "" };
        else if (t === "s") cel = { tipo: "texto", texto: compartilhadas[Number(v)] ?? "" };
        else if (t === "str") cel = { tipo: "texto", texto: desescapar(v) };
        else if (t === "b") cel = { tipo: "booleano", texto: v === "1" ? "VERDADEIRO" : "FALSO" };
        else if (t === "e") cel = { tipo: "erro", texto: desescapar(v) };
        else if (datas.has(s)) cel = { tipo: "data", texto: dataDoExcel(Number(v), data1904) };
        else {
          const num = numeroComoTexto(v);
          cel = num === null ? { tipo: "erro", texto: v } : { tipo: "numero", texto: num };
        }
        linha[col] = { ...cel, formula };
      }
      for (let i = 0; i < linha.length; i += 1) linha[i] ??= { tipo: "vazio", texto: "", formula: false };
      linhas[indice] = linha;
    }
    for (let i = 0; i < linhas.length; i += 1) linhas[i] ??= [];
    abas.push({ nome, linhas });
  }
  if (!abas.length) invalido("nenhuma aba encontrada");
  return { abas, data1904 };
}
