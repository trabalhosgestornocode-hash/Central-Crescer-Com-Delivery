// Leitura do relatório DIÁRIO de vendas da SAIPOS (CSV/XLSX): uma linha por dia, com venda bruta, recebido em espécie e sangria.
// PURO e rígido: nada é presumido. Dia repetido no arquivo, data inválida ou valor negativo viram ERRO por linha (a importação não grava com erro).
// Coluna ausente = campo NÃO informado (diferente de zero informado). Não existe divisão por canal aqui: o relatório diário não a traz.
import XLSX from "xlsx";
import { ApiError } from "../../../../shared/ApiError.js";
import { paraCentavos } from "../../../../financeiro-calculos/dinheiro.js";
import { paraDataISO } from "../../../../financeiro-calculos/importacao.js";

export const LIMITE_BYTES = 2 * 1024 * 1024;
export const LIMITE_DIAS = 400;
const sa = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\(?R\$\)?/gi, "").replace(/\s+/g, " ").trim().toUpperCase();
const CAB = {
  data: ["DATA", "DIA"],
  venda: ["VENDA BRUTA", "VENDAS BRUTAS", "VENDAS", "VENDA", "VENDAS SACI", "VENDAS SAIPOS", "FATURAMENTO", "FATURAMENTO BRUTO", "TOTAL VENDAS", "TOTAL DE VENDAS", "VALOR DE VENDAS"],
  especie: ["ESPECIE", "DINHEIRO", "CAIXA ESPECIE", "CAIXA ESPECIE SACI", "RECEBIDO EM ESPECIE", "RECEBIMENTO EM ESPECIE", "VENDAS EM ESPECIE", "RECEBIDO ESPECIE"],
  sangria: ["SANGRIA", "SANGRIAS", "SANGRIA SACI", "SANGRIA SAIPOS"],
  destino: ["DESTINO", "DESTINO DA SANGRIA"],
  observacao: ["OBSERVACAO", "OBSERVACOES", "OBS", "NOTA"],
};

/** @returns {{ dias: Array<{data,vendaCentavos,especieCentavos,sangriaCentavos,destino,observacao,linha}>, erros: Array<{linha,motivo}>, colunas: string[] }} */
export function lerVendasDiarias(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw ApiError.badRequest("Arquivo vazio.", { codigo: "ARQUIVO_AUSENTE" });
  if (buffer.length > LIMITE_BYTES) throw ApiError.badRequest("Arquivo acima do limite de 2 MB.", { codigo: "ARQUIVO_GRANDE" });
  let wb;
  try { wb = XLSX.read(buffer, { type: "buffer", cellDates: false }); } catch { throw ApiError.badRequest("Não foi possível abrir o arquivo.", { codigo: "ARQUIVO_INVALIDO" }); }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws?.["!ref"]) throw ApiError.badRequest("O arquivo está vazio.", { codigo: "ARQUIVO_VAZIO" });
  const linhas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const ehCab = (l) => l && l.some((c) => CAB.data.includes(sa(c))) && l.some((c) => [...CAB.venda, ...CAB.especie, ...CAB.sangria].includes(sa(c)));
  const iCab = linhas.slice(0, 40).findIndex(ehCab);
  if (iCab < 0) throw ApiError.badRequest("Cabeçalho não encontrado: use colunas Data, Venda bruta, Recebido em espécie e/ou Sangria.", { codigo: "CABECALHO_NAO_ENCONTRADO" });
  const cols = {};
  linhas[iCab].forEach((c, i) => { for (const [campo, nomes] of Object.entries(CAB)) if (nomes.includes(sa(c)) && cols[campo] == null) cols[campo] = i; });
  if (linhas.length - iCab > LIMITE_DIAS + 20) throw ApiError.badRequest(`Arquivo acima do limite de ${LIMITE_DIAS} dias.`, { codigo: "ARQUIVO_GRANDE" });

  const dias = [], erros = [], vistos = new Map();
  for (let k = iCab + 1; k < linhas.length; k++) {
    const l = linhas[k], linha = k + 1;
    if (!l || l.every((c) => c == null || c === "")) continue;
    if (/^TOTAL/.test(sa(l[cols.data]))) continue;                           // linha de total do relatório
    try {
      const data = paraDataISO(l[cols.data]);
      if (!data) throw new Error("data inválida");
      const lerValor = (campo, nome) => {
        if (cols[campo] == null || l[cols[campo]] == null || l[cols[campo]] === "") return null;   // não informado
        let c; try { c = paraCentavos(l[cols[campo]]); } catch { throw new Error(`${nome} inválido`); }
        if (c == null) return null; if (c < 0) throw new Error(`${nome} negativo`); return c;
      };
      const d = { data, vendaCentavos: lerValor("venda", "venda bruta"), especieCentavos: lerValor("especie", "valor em espécie"), sangriaCentavos: lerValor("sangria", "sangria"),
        destino: cols.destino != null && l[cols.destino] ? String(l[cols.destino]).trim().slice(0, 120) : null, observacao: cols.observacao != null && l[cols.observacao] ? String(l[cols.observacao]).trim().slice(0, 300) : null, linha };
      if (d.vendaCentavos == null && d.especieCentavos == null && d.sangriaCentavos == null) throw new Error("nenhum valor informado nesta linha");
      if (vistos.has(data)) throw new Error(`data repetida no arquivo (já na linha ${vistos.get(data)})`);
      vistos.set(data, linha);
      dias.push(d);
    } catch (e) { erros.push({ linha, motivo: e.message }); }
  }
  if (!dias.length && !erros.length) throw ApiError.badRequest("Nenhuma linha de venda encontrada.", { codigo: "SEM_LINHAS" });
  return { dias, erros, colunas: Object.keys(cols) };
}
