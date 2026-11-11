// Leitura da planilha de CONTAS A PAGAR (aba de saídas do mês) → linhas brutas para o núcleo puro (financeiro-calculos/importacaoContasPagar.js).
// Colunas localizadas pelo NOME do cabeçalho (sem intervalo fixo). Só leitura: o arquivo original nunca é alterado.
import XLSX from "xlsx";
import { ApiError } from "../../../../shared/ApiError.js";

export const LIMITE_BYTES = 5 * 1024 * 1024;
export const LIMITE_LINHAS = 5000;
const sem = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toUpperCase();
const CABECALHOS = {
  vencimento: ["VENCIMENTO"], previsto: ["VALOR PREVISTO"], realizado: ["VALOR REALIZADO"], descricao: ["DESCRICAO", "LANCAMENTO", "LANCAMENTOS"],
  classificacao: ["CLASSIFICACAO"], categoria: ["CATEGORIA"], natureza: ["NATUREZA"], formaPagamento: ["BANCO / FORMA", "BANCO/FORMA", "FORMA DE PAGAMENTO"],
  dataPagamento: ["DATA PAGAMENTO", "DATA DO PAGAMENTO"], origem: ["ORIGEM"],
};
const OBRIGATORIOS = ["vencimento", "previsto", "realizado", "descricao", "categoria", "formaPagamento", "dataPagamento", "origem"];

export function lerContasPagarXlsx(buffer, { nomeAba } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw ApiError.badRequest("Arquivo vazio.", { codigo: "ARQUIVO_VAZIO" });
  if (buffer.length > LIMITE_BYTES) throw ApiError.badRequest("Arquivo acima do limite de 5 MB.", { codigo: "ARQUIVO_GRANDE" });
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw ApiError.badRequest("O arquivo não é uma planilha .xlsx válida.", { codigo: "ARQUIVO_INVALIDO" });
  let wb;
  try { wb = XLSX.read(buffer, { type: "buffer", cellDates: true, cellFormula: false }); } catch { throw ApiError.badRequest("Não foi possível abrir a planilha.", { codigo: "ARQUIVO_INVALIDO" }); }
  const abas = wb.SheetNames;
  const candidatas = nomeAba ? abas.filter((n) => sem(n) === sem(nomeAba)) : abas;
  for (const aba of candidatas) {
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, raw: true, defval: null, blankrows: false });
    const limite = Math.min(linhas.length, 30);
    for (let i = 0; i < limite; i++) {
      const cols = {};
      linhas[i].forEach((v, c) => { const t = sem(v); for (const [campo, nomes] of Object.entries(CABECALHOS)) if (nomes.includes(t) && cols[campo] == null) cols[campo] = c; });
      if (!OBRIGATORIOS.every((k) => cols[k] != null)) continue;
      if (linhas.length - i > LIMITE_LINHAS) throw ApiError.badRequest("Planilha acima do limite de linhas.", { codigo: "LINHAS_DEMAIS" });
      const brutas = [];
      for (let r = i + 1; r < linhas.length; r++) {
        const l = linhas[r];
        if (l.every((x) => x == null || x === "")) continue;
        if (l[cols.vencimento] == null && l[cols.dataPagamento] == null) continue;   // rodapé/legenda sem data
        const o = { linha: r + 1 };
        for (const k of Object.keys(cols)) o[k] = l[cols[k]] ?? null;
        brutas.push(o);
      }
      return { aba, brutas };
    }
  }
  throw ApiError.badRequest("Não encontrei a aba de contas a pagar. Esperado: colunas VENCIMENTO, VALOR PREVISTO, VALOR REALIZADO, Descrição, CATEGORIA, BANCO / FORMA, DATA PAGAMENTO e ORIGEM.", { codigo: "ABA_NAO_ENCONTRADA", abas });
}
