// Extrator de TEXTO de PDF digital, próprio (só node:zlib). Não executa nada do arquivo: não há JavaScript, fontes
// compiladas nem renderização — só leitura de objetos, descompactação de streams e interpretação dos operadores de texto.
//
// Entrega as linhas de cada página (fragmentos agrupados pela altura e ordenados pela posição horizontal) e um
// diagnóstico: quantas páginas o documento declara, quantas foram lidas, quais não têm texto e quais têm imagem.
// PDF digitalizado (página com imagem e sem texto) é SINALIZADO — não há OCR automático.
// Suporta: objetos diretos e em object streams (/ObjStm), /FlateDecode, fontes simples (WinAnsi/Latin) e fontes com
// /ToUnicode (códigos de 1 ou 2 bytes). PDF criptografado é recusado.
import { inflateSync } from "node:zlib";
import { CODIGO, falhar } from "../../dominio/erros.js";

const invalido = (mensagem) => falhar(CODIGO.IMPORTACAO_INVALIDA, `PDF inválido: ${mensagem}`);
const LIMITE_STREAM = 64 * 1024 * 1024;

// ------------------------------------------------------------------------------------------- objetos
function lerObjetos(bin) {
  const objetos = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(bin))) {
    const inicio = m.index + m[0].length;
    const fim = bin.indexOf("endobj", inicio);
    if (fim < 0) break;
    let corpo = bin.slice(inicio, fim);
    let stream = null;
    const s = /stream\r?\n/.exec(corpo);
    if (s && corpo.slice(0, s.index).includes("<<")) {
      const dict = corpo.slice(0, s.index);
      const ini = s.index + s[0].length;
      const fimStream = corpo.lastIndexOf("endstream");
      stream = corpo.slice(ini, fimStream < 0 ? corpo.length : fimStream).replace(/\r?\n$/, "");
      corpo = dict;
    }
    objetos.set(Number(m[1]), { dict: corpo, stream });
    re.lastIndex = fim + 6;
  }
  return objetos;
}

function decodificarStream(obj) {
  if (obj.stream === null) return "";
  const filtros = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(obj.dict)?.[1] ?? "";
  let dados = Buffer.from(obj.stream, "latin1");
  if (/FlateDecode/.test(filtros)) {
    try {
      dados = inflateSync(dados, { maxOutputLength: LIMITE_STREAM });
    } catch {
      return null; // stream corrompido: a página fica sem texto e é sinalizada
    }
  } else if (filtros && !/FlateDecode/.test(filtros)) return /DCTDecode|JPX|CCITT|JBIG2/.test(filtros) ? "" : null;
  return dados.toString("latin1");
}

/** Objetos guardados dentro de object streams (PDF 1.5+). */
function expandirObjStm(objetos) {
  for (const obj of [...objetos.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(obj.dict)) continue;
    const n = Number(/\/N\s+(\d+)/.exec(obj.dict)?.[1] ?? 0);
    const primeiro = Number(/\/First\s+(\d+)/.exec(obj.dict)?.[1] ?? 0);
    const conteudo = decodificarStream(obj);
    if (!conteudo) continue;
    const pares = conteudo.slice(0, primeiro).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i += 1) {
      const num = pares[2 * i];
      const ini = primeiro + pares[2 * i + 1];
      const fim = i + 1 < n ? primeiro + pares[2 * i + 3] : conteudo.length;
      if (!objetos.has(num)) objetos.set(num, { dict: conteudo.slice(ini, fim), stream: null });
    }
  }
}

const ref = (texto) => { const m = /^\s*(\d+)\s+\d+\s+R/.exec(texto); return m ? Number(m[1]) : null; };
/** Valor de uma chave de dicionário (texto bruto até o próximo nome de chave do mesmo nível, aproximado). */
function valorDe(dict, chave) {
  const i = dict.search(new RegExp(`/${chave}(?![A-Za-z])`));
  if (i < 0) return null;
  let j = i + chave.length + 1;
  while (/\s/.test(dict[j])) j += 1;
  if (dict.startsWith("<<", j)) {
    let nivel = 0;
    for (let k = j; k < dict.length; k += 1) {
      if (dict.startsWith("<<", k)) { nivel += 1; k += 1; } else if (dict.startsWith(">>", k)) { nivel -= 1; k += 1; if (nivel === 0) return dict.slice(j, k + 1); }
    }
    return dict.slice(j);
  }
  if (dict[j] === "[") return dict.slice(j, dict.indexOf("]", j) + 1);
  return /^(\d+\s+\d+\s+R|\/[^\s/<>\[\]()]+|[^\s/<>\[\]]+)/.exec(dict.slice(j))?.[0] ?? null;
}
const resolver = (objetos, v) => { const r = v === null ? null : ref(v); return r === null ? v : objetos.get(r)?.dict ?? null; };

// ------------------------------------------------------------------------------------------- fontes
function mapaToUnicode(cmap) {
  const mapa = new Map();
  let largura = 1;
  const hex = (h) => { const b = Buffer.from(h.length % 4 === 0 ? h : h.padStart(4, "0"), "hex"); let s = ""; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i)); return s; };
  for (const bloco of cmap.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    const m = /<([0-9a-fA-F]+)>/.exec(bloco[1]);
    if (m) largura = m[1].length / 2;
  }
  for (const bloco of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of bloco[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) mapa.set(parseInt(m[1], 16), hex(m[2]));
  }
  for (const bloco of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of bloco[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const a = parseInt(m[1], 16);
      const b = parseInt(m[2], 16);
      if (b - a > 65535) continue;
      if (m[4] !== undefined) {
        const base = parseInt(m[4], 16);
        for (let c = a; c <= b; c += 1) mapa.set(c, String.fromCharCode(base + (c - a)));
      } else {
        const lista = [...m[5].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => hex(x[1]));
        lista.forEach((s, k) => mapa.set(a + k, s));
      }
    }
  }
  return { mapa, largura };
}

function fontesDaPagina(objetos, pagina) {
  const recursos = resolver(objetos, valorDe(pagina, "Resources")) ?? "";
  const fontesDict = resolver(objetos, valorDe(recursos, "Font")) ?? "";
  const fontes = new Map();
  for (const m of fontesDict.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    const fonte = objetos.get(Number(m[2]))?.dict ?? "";
    const tu = ref(valorDe(fonte, "ToUnicode") ?? "");
    const cmap = tu !== null && objetos.get(tu) ? decodificarStream(objetos.get(tu)) : null;
    fontes.set(m[1], cmap ? mapaToUnicode(cmap) : null);
  }
  return { fontes };
}

function decodificarTexto(bytes, fonte) {
  if (!fonte) return Buffer.from(bytes, "latin1").toString("latin1");
  let s = "";
  for (let i = 0; i < bytes.length; i += fonte.largura) {
    let c = 0;
    for (let k = 0; k < fonte.largura; k += 1) c = (c << 8) | (bytes.charCodeAt(i + k) || 0);
    s += fonte.mapa.get(c) ?? "";
  }
  return s;
}

// ------------------------------------------------------------------------------------------- conteúdo
function lerStringLiteral(s, i) {
  let nivel = 1;
  let out = "";
  for (let j = i + 1; j < s.length; j += 1) {
    const ch = s[j];
    if (ch === "\\") {
      const n = s[j + 1];
      const esc = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
      if (n in esc) { out += esc[n]; j += 1; } else if (/[0-7]/.test(n)) { const oct = /^[0-7]{1,3}/.exec(s.slice(j + 1))[0]; out += String.fromCharCode(parseInt(oct, 8)); j += oct.length; } else if (n === "\r" || n === "\n") { j += 1; }
      continue;
    }
    if (ch === "(") nivel += 1;
    if (ch === ")") { nivel -= 1; if (nivel === 0) return [out, j + 1]; }
    out += ch;
  }
  return [out, s.length];
}

function tokens(conteudo) {
  const lista = [];
  let i = 0;
  while (i < conteudo.length) {
    const ch = conteudo[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === "%") { i = conteudo.indexOf("\n", i); if (i < 0) break; continue; }
    if (ch === "(") { const [t, j] = lerStringLiteral(conteudo, i); lista.push({ str: t }); i = j; continue; }
    if (ch === "<" && conteudo[i + 1] !== "<") { const j = conteudo.indexOf(">", i); lista.push({ str: Buffer.from(conteudo.slice(i + 1, j).replace(/\s/g, ""), "hex").toString("latin1") }); i = j + 1; continue; }
    if (ch === "[" || ch === "]") { lista.push({ op: ch }); i += 1; continue; }
    if (ch === "<" || ch === ">") { i += 2; continue; }
    const m = /^(\/[^\s/<>\[\]()]*|[^\s/<>\[\]()%]+)/.exec(conteudo.slice(i, i + 200));
    if (!m) { i += 1; continue; }
    const t = m[1];
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) lista.push({ num: Number(t) });
    else if (t.startsWith("/")) lista.push({ nome: t.slice(1) });
    else lista.push({ op: t });
    i += t.length;
  }
  return lista;
}

function fragmentosDoConteudo(conteudo, fontes) {
  const frags = [];
  let fonte = null;
  let tm = [1, 0, 0, 1, 0, 0];
  let lm = [1, 0, 0, 1, 0, 0];
  let lider = 0;
  let pilha = [];
  let arr = null;
  const mover = (tx, ty) => { lm = [lm[0], lm[1], lm[2], lm[3], lm[4] + tx * lm[0] + ty * lm[2], lm[5] + tx * lm[1] + ty * lm[3]]; tm = [...lm]; };
  const emitir = (texto) => { if (texto) frags.push({ x: tm[4], y: tm[5], texto }); tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + texto.length * 5, tm[5]]; };
  for (const t of tokens(conteudo)) {
    if (t.op === "[") { arr = []; continue; }
    if (t.op === "]") { pilha.push({ arr }); arr = null; continue; }
    if (arr) { arr.push(t); continue; }
    if (!t.op) { pilha.push(t); continue; }
    const args = pilha;
    pilha = [];
    const n = (k) => args[k]?.num ?? 0;
    switch (t.op) {
      case "BT": tm = [1, 0, 0, 1, 0, 0]; lm = [1, 0, 0, 1, 0, 0]; break;
      case "Tf": fonte = fontes.get(args[0]?.nome) ?? null; break;
      case "TL": lider = n(0); break;
      case "Td": mover(n(0), n(1)); break;
      case "TD": lider = -n(1); mover(n(0), n(1)); break;
      case "Tm": lm = [n(0), n(1), n(2), n(3), n(4), n(5)]; tm = [...lm]; break;
      case "T*": mover(0, -lider); break;
      case "Tj": emitir(decodificarTexto(args[0]?.str ?? "", fonte)); break;
      case "'": mover(0, -lider); emitir(decodificarTexto(args[0]?.str ?? "", fonte)); break;
      case "\"": mover(0, -lider); emitir(decodificarTexto(args[2]?.str ?? "", fonte)); break;
      case "TJ": {
        let s = "";
        for (const p of args[0]?.arr ?? []) {
          if (p.str !== undefined) s += decodificarTexto(p.str, fonte);
          else if (p.num !== undefined && p.num < -200) s += " ";
        }
        emitir(s);
        break;
      }
      default: break;
    }
  }
  return frags;
}

/** Fragmentos → linhas: mesma altura (tolerância de 2 pontos), ordenadas de cima para baixo e da esquerda para a direita. */
function agruparEmLinhas(frags) {
  const linhas = [];
  for (const f of [...frags].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const l = linhas.find((x) => Math.abs(x.y - f.y) <= 2);
    if (l) l.partes.push(f); else linhas.push({ y: f.y, partes: [f] });
  }
  return linhas
    .map((l) => ({ y: l.y, partes: l.partes.sort((a, b) => a.x - b.x).map((p) => ({ x: p.x, texto: p.texto })) }))
    .map((l) => ({ ...l, texto: l.partes.map((p) => p.texto).join(" ").replace(/\s+/g, " ").trim() }))
    .filter((l) => l.texto);
}

/**
 * @returns {{paginas: Array<{numero:number, linhas:string[], temTexto:boolean, temImagem:boolean}>, paginasDeclaradas:number|null,
 *            digitalizado:boolean, incompleto:boolean}}
 */
export function lerPdf(bytes) {
  const bin = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  if (!bin.startsWith("%PDF-")) invalido("assinatura %PDF ausente");
  if (/\/Encrypt\s/.test(bin)) invalido("documento criptografado (exporte sem senha)");
  const objetos = lerObjetos(bin);
  expandirObjStm(objetos);
  const raizPaginas = [...objetos.values()].find((o) => /\/Type\s*\/Pages\b/.test(o.dict) && !/\/Parent/.test(o.dict));
  const paginasDeclaradas = raizPaginas ? Number(/\/Count\s+(\d+)/.exec(raizPaginas.dict)?.[1] ?? NaN) : null;
  const ordem = [];
  const visitar = (dict, profundidade = 0) => {
    if (profundidade > 32) return;
    for (const r of (valorDe(dict, "Kids") ?? "").matchAll(/(\d+)\s+\d+\s+R/g)) {
      const filho = objetos.get(Number(r[1]))?.dict ?? "";
      if (/\/Type\s*\/Pages\b/.test(filho)) visitar(filho, profundidade + 1);
      else if (/\/Type\s*\/Page\b/.test(filho)) ordem.push(filho);
    }
  };
  if (raizPaginas) visitar(raizPaginas.dict);
  if (!ordem.length) ordem.push(...[...objetos.values()].filter((o) => /\/Type\s*\/Page\b/.test(o.dict)).map((o) => o.dict));
  const paginas = ordem.map((dict, i) => {
    const { fontes } = fontesDaPagina(objetos, dict);
    const recursos = resolver(objetos, valorDe(dict, "Resources")) ?? "";
    const contents = valorDe(dict, "Contents") ?? "";
    const refs = [...contents.matchAll(/(\d+)\s+\d+\s+R/g)].map((r) => Number(r[1]));
    let conteudo = "";
    let corrompido = false;
    for (const r of refs) {
      const d = objetos.get(r) ? decodificarStream(objetos.get(r)) : null;
      if (d === null) corrompido = true; else conteudo += `\n${d}`;
    }
    const detalhe = agruparEmLinhas(fragmentosDoConteudo(conteudo, fontes));
    const linhas = detalhe.map((l) => l.texto);
    const temImagem = /\/XObject/.test(recursos) && /\bDo\b/.test(conteudo);
    // `posicoes`: cada linha com seus fragmentos e a posição horizontal (para tabelas em que o valor só se resolve pela coluna).
    return { numero: i + 1, linhas, posicoes: detalhe, temTexto: linhas.length > 0, temImagem, corrompido };
  });
  const semTexto = paginas.filter((p) => !p.temTexto);
  return {
    paginas,
    paginasDeclaradas: Number.isFinite(paginasDeclaradas) ? paginasDeclaradas : null,
    digitalizado: paginas.length > 0 && semTexto.length === paginas.length && paginas.some((p) => p.temImagem),
    incompleto: (Number.isFinite(paginasDeclaradas) && paginasDeclaradas !== paginas.length) || paginas.some((p) => p.corrompido),
  };
}
