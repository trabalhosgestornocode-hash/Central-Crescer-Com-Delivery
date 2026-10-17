// Leitura do livro-caixa em XLSX → linhas brutas para o núcleo puro (financeiro-calculos/importacao.js).
// Só a aba do fluxo é lida: as abas por conta (visões filtradas) NÃO são fontes independentes e nunca são importadas.
// Colunas são localizadas pelo NOME do cabeçalho (nada de intervalo fixo). Fórmulas e comentários de célula são preservados.
import XLSX from "xlsx";
import { ApiError } from "../../../../shared/ApiError.js";

export const LIMITE_BYTES = 5 * 1024 * 1024;
export const LIMITE_LINHAS = 20000;

const semAcento = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toUpperCase();

const CABECALHOS = {
  data: ["DATA"],
  descricao: ["LANCAMENTOS", "LANCAMENTO", "DESCRICAO", "HISTORICO"],
  entrada: ["ENTRADA", "ENTRADAS"],
  saida: ["SAIDA", "SAIDAS"],
  tipo: ["TIPO"],
  natureza: ["NATUREZA"],
  categoria: ["CATEGORIA"],
  conta: ["CONTA"],
};

function localizarCabecalho(ws, intervalo) {
  const limite = Math.min(intervalo.e.r, intervalo.s.r + 30);
  for (let r = intervalo.s.r; r <= limite; r++) {
    const cols = {};
    for (let c = intervalo.s.c; c <= intervalo.e.c; c++) {
      const cel = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cel || cel.v == null) continue;
      const txt = semAcento(cel.v);
      for (const [campo, nomes] of Object.entries(CABECALHOS)) if (nomes.includes(txt) && cols[campo] == null) cols[campo] = c;
    }
    if (Object.keys(cols).length >= 6) return { r, cols };
  }
  return null;
}

export function lerLivroCaixaXlsx(buffer, { nomeAba } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw ApiError.badRequest("Arquivo vazio.");
  if (buffer.length > LIMITE_BYTES) throw ApiError.badRequest("Arquivo acima do limite de 5 MB.");
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw ApiError.badRequest("O arquivo não é uma planilha .xlsx válida.");
  let wb;
  try {
    wb = XLSX.read(buffer, { type: "buffer", cellFormula: true, cellDates: false, dense: false });
  } catch {
    throw ApiError.badRequest("Não foi possível abrir a planilha.");
  }
  const nomes = wb.SheetNames;
  const alvo = nomeAba ? nomes.find((n) => semAcento(n) === semAcento(nomeAba)) : nomes.find((n) => semAcento(n).startsWith("FLUXO"));
  if (!alvo) throw ApiError.badRequest("Aba do fluxo de caixa não encontrada.", { codigo: "ABA_NAO_ENCONTRADA", abas: nomes });
  const ws = wb.Sheets[alvo];
  if (!ws?.["!ref"]) throw ApiError.badRequest("A aba do fluxo está vazia.");
  const intervalo = XLSX.utils.decode_range(ws["!ref"]);
  const cab = localizarCabecalho(ws, intervalo);
  const obrigatorios = ["data", "descricao", "entrada", "saida", "tipo", "natureza", "categoria", "conta"];
  if (!cab) throw ApiError.badRequest("Cabeçalho do fluxo não encontrado.", { codigo: "CABECALHO_NAO_ENCONTRADO" });
  const faltando = obrigatorios.filter((c) => cab.cols[c] == null);
  if (faltando.length) throw ApiError.badRequest(`Colunas ausentes: ${faltando.join(", ")}.`, { codigo: "COLUNAS_AUSENTES", faltando });
  if (intervalo.e.r - cab.r > LIMITE_LINHAS) throw ApiError.badRequest("Planilha acima do limite de linhas.");

  const cel = (r, campo) => ws[XLSX.utils.encode_cell({ r, c: cab.cols[campo] })];
  const valor = (c) => (c == null || c.v == null || c.v === "" ? null : c.v);
  const formulaDe = (c) => (c?.f ? `=${c.f}` : null);
  const comentario = (c) => (c?.c?.length ? c.c.map((x) => x.t).join(" ").replace(/\s+/g, " ").trim() : null);

  const brutas = [];
  for (let r = cab.r + 1; r <= intervalo.e.r; r++) {
    if (valor(cel(r, "data")) == null && valor(cel(r, "descricao")) == null && valor(cel(r, "entrada")) == null && valor(cel(r, "saida")) == null) continue;
    const dData = cel(r, "data");
    if (valor(dData) == null) continue; // linhas de total/rodapé sem data não são lançamento
    brutas.push({
      linha: r + 1,
      data: valor(dData),
      descricao: valor(cel(r, "descricao")),
      entrada: valor(cel(r, "entrada")),
      saida: valor(cel(r, "saida")),
      tipo: valor(cel(r, "tipo")),
      natureza: valor(cel(r, "natureza")),
      categoria: valor(cel(r, "categoria")),
      conta: valor(cel(r, "conta")),
      formulaEntrada: formulaDe(cel(r, "entrada")),
      formulaSaida: formulaDe(cel(r, "saida")),
      comentario: [comentario(cel(r, "descricao")), comentario(cel(r, "entrada")), comentario(cel(r, "saida"))].filter(Boolean).join(" | ") || null,
    });
  }

  // Total declarado: acima do cabeçalho, linha com "TOTAL" e os dois primeiros números à direita (entrada, saída).
  let totalDeclarado = null;
  for (let r = intervalo.s.r; r < cab.r && !totalDeclarado; r++) {
    let achou = false;
    const nums = [];
    for (let c = intervalo.s.c; c <= intervalo.e.c; c++) {
      const x = ws[XLSX.utils.encode_cell({ r, c })];
      if (!x || x.v == null) continue;
      if (typeof x.v === "string" && semAcento(x.v).startsWith("TOTAL")) achou = true;
      else if (achou && typeof x.v === "number") nums.push(x.v);
    }
    if (achou && nums.length >= 2) {
      const cent = (n) => Math.round(n * 100);
      totalDeclarado = { entradaCentavos: cent(nums[0]), saidaCentavos: cent(nums[1]) };
    }
  }
  return { aba: alvo, brutas, totalDeclarado, abasIgnoradas: nomes.filter((n) => n !== alvo) };
}
