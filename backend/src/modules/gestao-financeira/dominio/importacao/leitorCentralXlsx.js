// Leitura da Central Financeira Unificada (XLSX) → registros normalizados para o núcleo puro
// (financeiro-calculos/importacaoCentral.js). SOMENTE leitura: o arquivo original nunca é alterado.
// Cada tabela é localizada pelo NOME DA ABA + linha de cabeçalho (colunas pelo nome, sem intervalo fixo).
import XLSX from "xlsx";
import { paraCentavos } from "../../../../financeiro-calculos/dinheiro.js";

const chaveCab = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toUpperCase();

// aba → colunas obrigatórias (pelo nome normalizado do cabeçalho)
export const TABELAS = Object.freeze({
  obrigacoes: { aba: "03_BD_OBRIGACOES", exige: ["ID", "FORNECEDOR", "DESCRICAO", "CATEGORIA", "COMPETENCIA", "VENCIMENTO", "VALOR PREVISTO", "TIPO REGISTRO"] },
  pagamentos: { aba: "03_BD_PAGAMENTOS", exige: ["ID", "ID OBRIGACAO", "DATA", "CONTA", "VALOR", "ID MOVIMENTO", "TIPO REGISTRO"] },
  movimentos: { aba: "05_BD_MOVIMENTOS", exige: ["ID", "CONTA", "DATA", "ENTRADA", "SAIDA", "REF FLUXO"] },
  fluxo: { aba: "06_BD_FLUXO_ORIGEM", exige: ["ID", "CONTA", "DATA", "LANCAMENTO", "ENTRADA", "SAIDA"] },
  referencias: { aba: "99_CAD_REFERENCIAS", exige: ["INDICADOR", "VALOR APRESENTACAO", "VALOR PLANILHA", "SITUACAO"] },
  inconsistencias: { aba: "12_BD_INCONSISTENCIAS", exige: ["ID", "TIPO", "DESCRICAO", "STATUS"] },
  saldos: { aba: "05_BD_SALDOS", exige: ["CONTA", "COMPETENCIA", "SALDO INICIAL INFORMADO"] },
});

/** Data do Excel (serial, Date ou texto ISO/pt-BR) → "AAAA-MM-DD" (sem fuso). */
export function paraDataISO(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}` : null; }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function lerTabela(wb, { aba, exige }) {
  const ws = wb.Sheets[aba];
  if (!ws) throw new Error(`aba ausente na Central: ${aba}`);
  const linhas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
  const iCab = linhas.findIndex((l) => { const c = l.map(chaveCab); return exige.every((e) => c.includes(e)); });
  if (iCab < 0) throw new Error(`cabeçalho não encontrado em ${aba} (esperado: ${exige.join(", ")})`);
  const cab = linhas[iCab].map(chaveCab);
  const out = [];
  for (let i = iCab + 1; i < linhas.length; i++) {
    const l = linhas[i];
    if (l.every((x) => x == null || x === "")) break;              // fim da tabela
    const o = { _linha: i + 1 }; cab.forEach((k, j) => { if (k) o[k] = l[j]; });
    if (o.ID == null && o.INDICADOR == null && o.CONTA == null) continue;
    out.push(o);
  }
  return out;
}

const txt = (v) => (v == null ? "" : String(v).trim());
const sim = (v) => /^S(IM)?$/i.test(txt(v).normalize("NFD").replace(/[̀-ͯ]/g, ""));
const c0 = (v) => (v == null || v === "" ? 0 : paraCentavos(typeof v === "string" ? v : Number(v)));

/** Lê a Central e devolve registros normalizados (centavos inteiros, datas ISO). */
export function lerCentralXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false, cellFormula: false });
  const t = Object.fromEntries(Object.entries(TABELAS).map(([k, d]) => [k, lerTabela(wb, d)]));
  return {
    obrigacoes: t.obrigacoes.map((o) => ({
      id: txt(o.ID), linha: o._linha, fornecedor: txt(o.FORNECEDOR), descricao: txt(o.DESCRICAO), categoria: txt(o.CATEGORIA),
      competencia: paraDataISO(o.COMPETENCIA)?.slice(0, 7) ?? (/^\d{4}-\d{2}/.test(txt(o.COMPETENCIA)) ? txt(o.COMPETENCIA).slice(0, 7) : null),
      vencimento: paraDataISO(o.VENCIMENTO), valorPrevistoCentavos: c0(o["VALOR PREVISTO"]),
      jurosCentavos: c0(o.JUROS), multaCentavos: c0(o.MULTA), descontoCentavos: c0(o.DESCONTO), valorPagoCentavos: c0(o["VALOR PAGO"]),
      status: txt(o.STATUS), cancelado: sim(o.CANCELADO), tipoRegistro: txt(o["TIPO REGISTRO"]),
    })),
    pagamentos: t.pagamentos.map((p) => ({
      id: txt(p.ID), linha: p._linha, obrigacaoId: txt(p["ID OBRIGACAO"]), data: paraDataISO(p.DATA), conta: txt(p.CONTA),
      valorCentavos: c0(p.VALOR), idMovimento: txt(p["ID MOVIMENTO"]), cancelado: sim(p.CANCELADO), tipoRegistro: txt(p["TIPO REGISTRO"]),
      situacaoVinculo: txt(p["SITUACAO VINCULO"]),
    })),
    movimentos: t.movimentos.map((m) => ({ id: txt(m.ID), conta: txt(m.CONTA), data: paraDataISO(m.DATA), entradaCentavos: c0(m.ENTRADA), saidaCentavos: c0(m.SAIDA), refFluxo: txt(m["REF FLUXO"]) })),
    fluxo: t.fluxo.map((f) => ({ id: txt(f.ID), conta: txt(f.CONTA), data: paraDataISO(f.DATA), descricao: txt(f.LANCAMENTO), entradaCentavos: c0(f.ENTRADA), saidaCentavos: c0(f.SAIDA) })),
    referencias: t.referencias.map((r) => ({ indicador: txt(r.INDICADOR), valorApresentacao: r["VALOR APRESENTACAO"], valorPlanilha: r["VALOR PLANILHA"], situacao: txt(r.SITUACAO), nota: txt(r.NOTA) })),
    saldos: t.saldos.map((s) => ({ conta: txt(s.CONTA), data: paraDataISO(s.COMPETENCIA), inicialInformadoCentavos: s["SALDO INICIAL INFORMADO"] == null || s["SALDO INICIAL INFORMADO"] === "" ? null : c0(s["SALDO INICIAL INFORMADO"]), fonte: txt(s["FONTE SALDO INICIAL"]) })),
    inconsistencias: t.inconsistencias.map((i) => ({ id: txt(i.ID), tipo: txt(i.TIPO), descricao: txt(i.DESCRICAO), status: txt(i.STATUS), responsavel: txt(i.RESPONSAVEL) })),
  };
}
