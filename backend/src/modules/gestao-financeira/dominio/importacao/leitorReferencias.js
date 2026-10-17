// Leitura de DADOS DE REFERÊNCIA da conciliação (vendas, taxas, sangrias, caixa em espécie) a partir de CSV/XLSX genérico.
// Formato (cabeçalho obrigatório, qualquer ordem): DATA · TIPO · VALOR · [CANAL] · [NOTA]. TIPO ∈ venda | taxa | sangria | dinheiro.
// Não depende da planilha complementar da operação (que não foi fornecida): é um modelo neutro para entrada posterior ou integração com PDV.
import { createHash } from "node:crypto";
import XLSX from "xlsx";
import { ApiError } from "../../../../shared/ApiError.js";
import { paraCentavos } from "../../../../financeiro-calculos/dinheiro.js";
import { paraDataISO } from "../../../../financeiro-calculos/importacao.js";

export const LIMITE_BYTES = 2 * 1024 * 1024;
export const LIMITE_LINHAS = 5000;
const semAcento = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toUpperCase();
const CAB = { data: ["DATA"], tipo: ["TIPO"], valor: ["VALOR", "VALOR (R$)"], canal: ["CANAL"], nota: ["NOTA", "OBSERVACAO", "OBS"] };
const TIPOS = { VENDA: "venda", VENDAS: "venda", TAXA: "taxa", TAXAS: "taxa", SANGRIA: "sangria", SANGRIAS: "sangria", DINHEIRO: "dinheiro", ESPECIE: "dinheiro" };

export const chaveReferencia = (r, ocorrencia) =>
  `${createHash("sha256").update([r.data, r.tipo, r.canal ?? "", r.valor_centavos].join("|"), "utf8").digest("hex").slice(0, 24)}#${ocorrencia}`;

/** Retorna { itens (prontos para gravar), erros[{linha,motivo}] }. Chaves = impressão + ocorrência (reordenar/reenviar não duplica). */
export function lerReferencias(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw ApiError.badRequest("Arquivo vazio.", { codigo: "ARQUIVO_AUSENTE" });
  if (buffer.length > LIMITE_BYTES) throw ApiError.badRequest("Arquivo acima do limite de 2 MB.", { codigo: "ARQUIVO_GRANDE" });
  let wb;
  try { wb = XLSX.read(buffer, { type: "buffer", cellDates: false }); } catch { throw ApiError.badRequest("Não foi possível abrir o arquivo.", { codigo: "ARQUIVO_INVALIDO" }); }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws?.["!ref"]) throw ApiError.badRequest("O arquivo está vazio.", { codigo: "ARQUIVO_VAZIO" });
  const linhas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const iCab = linhas.slice(0, 30).findIndex((l) => l && l.some((c) => CAB.data.includes(semAcento(c))) && l.some((c) => CAB.valor.includes(semAcento(c))));
  if (iCab < 0) throw ApiError.badRequest("Cabeçalho não encontrado (DATA, TIPO, VALOR).", { codigo: "CABECALHO_NAO_ENCONTRADO" });
  const cols = {};
  linhas[iCab].forEach((c, i) => { for (const [campo, nomes] of Object.entries(CAB)) if (nomes.includes(semAcento(c)) && cols[campo] == null) cols[campo] = i; });
  const faltando = ["data", "tipo", "valor"].filter((c) => cols[c] == null);
  if (faltando.length) throw ApiError.badRequest(`Colunas ausentes: ${faltando.join(", ")}.`, { codigo: "COLUNAS_AUSENTES", faltando });
  if (linhas.length - iCab > LIMITE_LINHAS) throw ApiError.badRequest("Arquivo acima do limite de linhas.", { codigo: "ARQUIVO_GRANDE" });

  const itens = []; const erros = []; const vistos = new Map();
  linhas.slice(iCab + 1).forEach((l, k) => {
    if (!l || l.every((c) => c == null || c === "")) return;
    const linha = iCab + k + 2;
    try {
      const data = paraDataISO(l[cols.data]);
      const tipo = TIPOS[semAcento(l[cols.tipo])];
      const valor = paraCentavos(l[cols.valor]);
      if (!data) throw new Error("data inválida");
      if (!tipo) throw new Error("tipo inválido (use venda, taxa, sangria ou dinheiro)");
      if (valor == null) throw new Error("valor ausente");
      if (valor < 0) throw new Error("valor negativo");
      const canal = cols.canal != null && l[cols.canal] ? String(l[cols.canal]).trim().toUpperCase() : null;
      const base = { data, tipo, canal, valor_centavos: valor };
      const h = chaveReferencia(base, 0).split("#")[0];
      const n = (vistos.get(h) ?? 0) + 1; vistos.set(h, n);
      itens.push({ ...base, fonte: "arquivo_referencia", referencia_origem: `linha ${linha}`, chave_origem: `${h}#${n}`, nota: cols.nota != null && l[cols.nota] ? String(l[cols.nota]).trim().slice(0, 500) : null });
    } catch (e) { erros.push({ linha, motivo: e.message }); }
  });
  return { itens, erros };
}
