// Geradores de arquivos SINTÉTICOS com a mesma estrutura TÉCNICA dos formatos reais (XLSX, PDF digital, OFX).
// Nenhum dado real: servem para provar os leitores byte a byte, não para imitar um relatório específico.
import { crc32, deflateRawSync, deflateSync } from "node:zlib";

// ------------------------------------------------------------------------------------------- ZIP / XLSX
function zip(arquivos, { comprimir = true } = {}) {
  const locais = [];
  const centrais = [];
  let offset = 0;
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    const dados = Buffer.from(conteudo, "utf8");
    const comp = comprimir ? deflateRawSync(dados) : dados;
    const nomeB = Buffer.from(nome, "utf8");
    const crc = crc32(dados);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(comprimir ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(dados.length, 22); local.writeUInt16LE(nomeB.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(comprimir ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(dados.length, 24); central.writeUInt16LE(nomeB.length, 28);
    central.writeUInt32LE(offset, 42);
    locais.push(local, nomeB, comp);
    centrais.push(central, nomeB);
    offset += 30 + nomeB.length + comp.length;
  }
  const dir = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(Object.keys(arquivos).length, 8); fim.writeUInt16LE(Object.keys(arquivos).length, 10);
  fim.writeUInt32LE(dir.length, 12); fim.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locais, dir, fim]));
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const letra = (i) => { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/**
 * Célula: string (texto) | number (número) | { data: serieExcel } | { dataHora: serie } | { formula, valor? } | { erro } | null.
 * @param {Array<{nome:string, linhas:Array<Array<any>>}>} abas
 */
export function xlsx(abas, { data1904 = false, comprimir = true } = {}) {
  const arquivos = {
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships/>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns:r="r"><workbookPr${data1904 ? ' date1904="1"' : ""}/><sheets>${abas.map((a, i) => `<sheet name="${esc(a.nome)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships>${abas.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
    "xl/styles.xml": `<?xml version="1.0"?><styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
  };
  abas.forEach((aba, i) => {
    const rows = aba.linhas.map((linha, r) => `<row r="${r + 1}">${linha.map((v, c) => {
      const ref = `${letra(c)}${r + 1}`;
      if (v === null || v === undefined) return "";
      if (typeof v === "string") return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
      if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
      if (v.data !== undefined) return `<c r="${ref}" s="1"><v>${v.data}</v></c>`;
      if (v.dataHora !== undefined) return `<c r="${ref}" s="2"><v>${v.dataHora}</v></c>`;
      if (v.erro) return `<c r="${ref}" t="e"><v>${esc(v.erro)}</v></c>`;
      if (v.formula) return `<c r="${ref}"><f>${esc(v.formula)}</f>${v.valor !== undefined ? `<v>${v.valor}</v>` : ""}</c>`;
      return "";
    }).join("")}</row>`).join("");
    arquivos[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;
  });
  return zip(arquivos, { comprimir });
}

/** Data civil → série do Excel (época 1900). */
export const serie = (iso, hora = "00:00") => {
  const dias = (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;
  const [h, m] = hora.split(":").map(Number);
  return dias + (h * 60 + m) / 1440;
};

// ------------------------------------------------------------------------------------------- PDF
const pdfTexto = (s) => `(${String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")})`;
const hex2 = (s) => `<${[...s].map((ch) => ch.charCodeAt(0).toString(16).padStart(4, "0")).join("")}>`;

/**
 * @param {string[][]} paginas linhas de texto por página
 * @param {{declararPaginas?:number, imagemSemTexto?:boolean, toUnicode?:boolean, objStm?:boolean}} opcoes
 */
export function pdf(paginas, { declararPaginas, imagemSemTexto = false, toUnicode = false, objStm = false } = {}) {
  const objetos = [];
  const novo = (corpo) => { objetos.push(corpo); return objetos.length; };
  const stream = (dict, conteudo) => {
    const dados = deflateSync(Buffer.from(conteudo, "latin1"));
    return { dict: `<< ${dict} /Filter /FlateDecode /Length ${dados.length} >>`, dados };
  };
  const catalogo = novo(null);
  const raiz = novo(null);
  const cmap = toUnicode ? novo(stream("", "/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0000> <FFFF> <0000> endbfrange endcmap end end")) : null;
  const fonteCorpo = `<< /Type /Font /Subtype /${toUnicode ? "Type0" : "Type1"} /BaseFont /Helvetica ${toUnicode ? `/Encoding /Identity-H /ToUnicode ${cmap} 0 R` : "/Encoding /WinAnsiEncoding"} >>`;
  const fonte = novo(objStm ? { naObjStm: fonteCorpo } : fonteCorpo);
  const imagem = imagemSemTexto ? novo(stream("/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8", "\x80")) : null;
  const kids = [];
  for (const linhas of paginas) {
    const conteudo = imagemSemTexto
      ? "q 500 0 0 700 50 50 cm /Im1 Do Q"
      : linhas.map((l, i) => {
        // Linha simples (texto) ou posicionada: { y, partes: [[x, texto], ...] } — para tabelas que dependem da coluna.
        if (typeof l === "string") return `BT /F1 9 Tf 40 ${780 - i * 14} Td ${toUnicode ? hex2(l) : pdfTexto(l)} Tj ET`;
        return l.partes.map(([x, t]) => `BT /F1 9 Tf ${x} ${l.y} Td ${toUnicode ? hex2(t) : pdfTexto(t)} Tj ET`).join("\n");
      }).join("\n");
    const c = novo(stream("", conteudo));
    const recursos = `<< /Font << /F1 ${fonte} 0 R >>${imagem ? ` /XObject << /Im1 ${imagem} 0 R >>` : ""} >>`;
    kids.push(novo(`<< /Type /Page /Parent ${raiz} 0 R /MediaBox [0 0 595 842] /Resources ${recursos} /Contents ${c} 0 R >>`));
  }
  objetos[catalogo - 1] = `<< /Type /Catalog /Pages ${raiz} 0 R >>`;
  objetos[raiz - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${declararPaginas ?? paginas.length} >>`;
  const partes = [Buffer.from("%PDF-1.5\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const emObjStm = [];
  objetos.forEach((o, i) => {
    const n = i + 1;
    if (o && typeof o === "object" && o.naObjStm) { emObjStm.push([n, o.naObjStm]); return; }
    if (o && typeof o === "object") partes.push(Buffer.from(`${n} 0 obj\n${o.dict}\nstream\n`, "latin1"), o.dados, Buffer.from("\nendstream\nendobj\n", "latin1"));
    else partes.push(Buffer.from(`${n} 0 obj\n${o}\nendobj\n`, "latin1"));
  });
  if (emObjStm.length) {
    let cab = "";
    let corpo = "";
    for (const [n, texto] of emObjStm) { cab += `${n} ${corpo.length} `; corpo += `${texto}\n`; }
    const s = stream(`/Type /ObjStm /N ${emObjStm.length} /First ${cab.length}`, cab + corpo);
    partes.push(Buffer.from(`${objetos.length + 1} 0 obj\n${s.dict}\nstream\n`, "latin1"), s.dados, Buffer.from("\nendstream\nendobj\n", "latin1"));
  }
  partes.push(Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"));
  return new Uint8Array(Buffer.concat(partes));
}

// ------------------------------------------------------------------------------------------- OFX
export function ofx({ inicio = "20260901", fim = "20260930", transacoes, saldo = null, saldoEm = fim, versao = 1 }) {
  const trn = transacoes.map((t) => `<STMTTRN>\n<TRNTYPE>${t.valor.startsWith("-") ? "DEBIT" : "CREDIT"}\n<DTPOSTED>${t.data}120000[-3:BRT]\n<TRNAMT>${t.valor}\n<FITID>${t.fitid}\n${t.documento ? `<CHECKNUM>${t.documento}\n` : ""}<MEMO>${t.memo}\n${versao === 2 ? "</STMTTRN>" : "</STMTTRN>"}`).join("\n");
  const cab = versao === 2 ? '<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?>' : "OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n";
  return new TextEncoder().encode(`${cab}\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>0000\n</BANKACCTFROM>\n<BANKTRANLIST>\n<DTSTART>${inicio}\n<DTEND>${fim}\n${trn}\n</BANKTRANLIST>${saldo !== null ? `\n<LEDGERBAL>\n<BALAMT>${saldo}\n<DTASOF>${saldoEm}\n</LEDGERBAL>` : ""}\n</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>\n`);
}

// ------------------------------------------------------------------------------------------- SAIPOS faturamento por dia (PDF)
const R = (c) => `${String(Math.trunc(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${String(c % 100).padStart(2, "0")}`;
/** Dias: [{ data:"dd/mm/aaaa", valor, desconto, qtd }] — composição fechada: itens = valor − entrega(20,00) − acréscimo(1,00) + desconto. */
export function faturamentoSaiposPdf(dias) {
  const cab = [
    { y: 720, partes: [[234, "VEND"], [257, "AS"], [427, "ITENS"]] },
    { y: 714, partes: [[116, "SEMANA"], [288, "ACUMUL"], [325, "ADO"], [365, "MÉDIO"], [472, "ENTREGA"], [532, "SER"], [549, "VIÇO"], [737, "CANC"]] },
    { y: 708, partes: [[61, "DATA"], [174, "VEND"], [197, "AS"], [257, "DE"], [435, "DOS"], [589, "ACRÉSCIMOS"], [665, "DESCONTOS"]] },
    { y: 702, partes: [[116, "DIA DA"], [315, "VALOR"], [363, "TICKE"], [387, "T"], [477, "TAXA DE"], [534, "TAXA DE"]] },
  ];
  let acumulado = 0;
  const linhas = [];
  dias.forEach((d, i) => {
    acumulado += d.valor;
    const y = 600 - i * 28;
    const itens = d.valor - 2000 - 100 + d.desconto;
    linhas.push({ y, partes: [[48, d.data], [116, "Dia-"], [199, String(d.qtd ?? 1)], [257, "R$"], [290, `R$ ${R(acumulado)}`], [382, "R$"], [441, "R$"], [477, "R$ 20,00"], [539, "R$ 0,00"], [615, "R$ 1,00"], [677, `R$ ${R(d.desconto)}`]] });
    linhas.push({ y: y + 13, partes: [[116, "feira"], [234, R(d.valor)], [371, "1,00"], [418, R(itens)]] });
  });
  return pdf([["Faturamento por dia", ...cab, ...linhas]]);
}
