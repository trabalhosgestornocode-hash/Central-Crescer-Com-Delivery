// Leitor da planilha "Histórico Financeiro do iFood" (check-up mensal do mentor).
//
// Identifica cada linha pelo RÓTULO da coluna B (nunca pela posição) e cada coluna pelo mês do cabeçalho de datas mais
// próximo acima. Só lê VALORES de origem (R$ e quantidades); as linhas de % da planilha são recalculadas pelo motor e
// usadas apenas para conferência — um % mensal de 0 onde o valor em R$ está vazio é "zero artificial" e é ignorado.
// Célula vazia = null (não informado). Nunca transforma ausência em zero.

import { createHash } from "node:crypto";
import XLSX from "xlsx";
import { ApiError } from "../../shared/ApiError.js";
import { centavos, pct, ymDe } from "./calc.js";

export const LEITOR_VERSAO = "historico-ifood-v1";

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7E]/g, "?").toUpperCase().replace(/\s+/g, " ").trim();

// Ordem importa: a 1ª regra que casar vence. `campo` = coluna de mentoria_historico_mensal.
const REGRAS = [
  { campo: "qtd_pedidos", re: /TOTAL DE VENDAS REALIZADAS/, tipo: "inteiro" },
  { campo: "valor_vendas_desempenho", re: /^VALOR TOTAL DAS VENDAS/, tipo: "reais" },
  { campo: null, conferencia: "ticket", re: /^TICKET M.DIO/ },
  { campo: "novos_clientes", re: /^NOVOS CLIENTES/, tipo: "inteiro" },
  { campo: "valor_vendas", re: /FINANCEIRO \| VALOR DAS VENDAS/, tipo: "reais" },
  { campo: "taxas_comissoes", re: /^\[R\$\] TAXAS E COMISS/, tipo: "reais" },
  { campo: "servicos_promocoes", re: /^\[R\$\] SERVI.OS E PROMO/, tipo: "reais" },
  { campo: "taxas_entregadores", re: /^\[R\$\] TAXA DOS ENTREGADORES/, tipo: "reais" },
  { campo: null, conferencia: "pctTaxasMaisServicosMaisEntregadores", meta: "custosIfoodTotal", re: /^\[%\] TAXAS E COMISS.ES \+ SERVI.OS E PROMO..ES \+ ENTREGADORES/ },
  { campo: null, conferencia: "pctTaxasMaisServicos", meta: "taxasMaisServicos", re: /^\[%\] TAXAS E COMISS.ES \+ SERVI.OS/ },
  { campo: null, conferencia: "pctTaxasComissoes", meta: "taxasComissoes", re: /^\[%\] TAXAS E COMISS/ },
  { campo: null, conferencia: "pctServicosPromocoes", meta: "servicosPromocoes", re: /^\[%\] SERVI.OS E PROMO/ },
  { campo: null, conferencia: "pctEntregadores", meta: "taxasEntregadores", re: /^\[%\] TAXA DOS ENTREGADORES/ },
  { campo: null, metaGeral: true, re: /^\[%\] META RESTAURANTE/ },
  { campo: "precificacao_pct", re: /^% PRECIFICA..O LOJA X IFOOD$/, tipo: "fracao" },
];

/** Extrai metas do próprio rótulo: "| Até 13%", "| Ideal 12% - Limite 15%", "Mínimo R$45 - Ideal R$50". */
function metasDoRotulo(rotulo) {
  const r = norm(rotulo);
  const ate = /ATE (\d+(?:[.,]\d+)?)%/.exec(r);
  const ideal = /IDEAL (\d+(?:[.,]\d+)?)%/.exec(r);
  const limite = /LIMITE (\d+(?:[.,]\d+)?)%/.exec(r);
  const num = (m) => (m ? Number(m[1].replace(",", ".")) : null);
  return { maximo: num(ate) ?? num(limite), ideal: num(ideal) };
}

function mesDoSerial(v) {
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = XLSX.SSF.parse_date_code(v);
    if (d && d.d === 1) return `${d.y}-${String(d.m).padStart(2, "0")}`;
  }
  if (v instanceof Date) return ymDe(v);
  return null;
}

/**
 * @param {Buffer} buffer conteúdo do .xlsx
 * @param {{arquivoNome?: string}} [opts]
 * @returns {{sha256: string, leitorVersao: string, meses: object[], metas: object, notas: string[], avisos: object[], titulo: string|null}}
 */
export function lerPlanilhaHistorico(buffer, { arquivoNome = "" } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw ApiError.badRequest("Arquivo vazio.", { codigo: "ARQUIVO_VAZIO" });
  if (buffer.length > 5 * 1024 * 1024) throw ApiError.badRequest("Arquivo maior que 5 MB.", { codigo: "ARQUIVO_GRANDE" });
  if (arquivoNome && !/\.xlsx$/i.test(arquivoNome)) throw ApiError.badRequest("Envie um arquivo .xlsx.", { codigo: "FORMATO_INVALIDO" });
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  let wb;
  try { wb = XLSX.read(buffer, { type: "buffer", cellDates: false, cellFormula: false, cellHTML: false }); }
  catch { throw ApiError.badRequest("Não foi possível abrir a planilha.", { codigo: "ARQUIVO_INVALIDO" }); }
  if (wb.SheetNames.length !== 1) {
    throw ApiError.badRequest(`A planilha deve ter uma única aba (tem ${wb.SheetNames.length}).`, { codigo: "ABAS_INESPERADAS" });
  }
  const linhas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null, raw: true });

  const porMes = new Map();
  const metas = {};
  const notas = [];
  const avisos = [];
  const conferencias = {};
  let colunasMes = null; // índice da coluna -> "AAAA-MM", do cabeçalho de datas mais recente
  let titulo = null;

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i] ?? [];
    const rotulo = linha[1];
    const datas = linha.map(mesDoSerial);
    if (datas.filter(Boolean).length >= 3) { colunasMes = new Map(datas.map((m, c) => [c, m]).filter(([, m]) => m)); continue; }
    if (!titulo && typeof rotulo === "string" && /CHECK-UP|HIST.RICO/i.test(norm(rotulo))) titulo = String(rotulo).trim();
    if (!colunasMes || typeof rotulo !== "string") continue;
    const regra = REGRAS.find((r) => r.re.test(norm(rotulo)));
    // Texto fora das colunas de mês (ex.: "Ago/26 Fullservice") é nota do mentor, guardada como veio.
    const ultimaCol = Math.max(...colunasMes.keys());
    for (let c = ultimaCol + 1; c < linha.length; c++) {
      if (typeof linha[c] === "string" && linha[c].trim()) notas.push(`${String(rotulo).trim()}: ${linha[c].trim()}`);
    }
    if (!regra) continue;
    if (regra.meta) {
      const m = metasDoRotulo(rotulo);
      if (m.maximo != null || m.ideal != null) metas[regra.meta] = m;
    }
    if (regra.conferencia === "ticket") {
      const r = norm(rotulo);
      const min = /MINIMO R\$ ?(\d+(?:[.,]\d+)?)/.exec(r), ideal = /IDEAL R\$ ?(\d+(?:[.,]\d+)?)/.exec(r);
      if (min || ideal) metas.ticketMedio = { minimo: min ? Number(min[1].replace(",", ".")) : null, ideal: ideal ? Number(ideal[1].replace(",", ".")) : null };
    }
    if (regra.metaGeral) {
      const vals = [...colunasMes.keys()].map((c) => linha[c]).filter((v) => typeof v === "number");
      if (vals.length && vals.every((v) => v === vals[0])) metas.metaRestaurantePct = Math.round(vals[0] * 1e6) / 1e4;
      continue;
    }
    for (const [c, mes] of colunasMes) {
      const v = linha[c];
      if (regra.conferencia) { (conferencias[regra.conferencia] ??= new Map()).set(mes, typeof v === "number" ? v : null); continue; }
      if (!regra.campo) continue;
      const alvo = porMes.get(mes) ?? { mes: `${mes}-01` };
      if (v == null || v === "") { alvo[regra.campo] ??= null; porMes.set(mes, alvo); continue; }
      if (typeof v !== "number" || !Number.isFinite(v)) {
        avisos.push({ codigo: "VALOR_NAO_NUMERICO", mes, campo: regra.campo, valor: String(v).slice(0, 40) });
        continue;
      }
      const valor = regra.tipo === "reais" ? Math.round(v * 100) / 100
        : regra.tipo === "inteiro" ? Math.round(v) : Math.round(v * 1e6) / 1e4;
      // Rótulo repetido mais abaixo (ex.: quadro de produto) nunca sobrescreve o valor mensal já lido.
      if (alvo[regra.campo] != null) {
        if (alvo[regra.campo] !== valor) avisos.push({ codigo: "ROTULO_REPETIDO", mes, campo: regra.campo, mantido: alvo[regra.campo], ignorado: valor });
        continue;
      }
      alvo[regra.campo] = valor;
      porMes.set(mes, alvo);
    }
  }

  const meses = [...porMes.values()].filter((m) => Object.keys(m).some((k) => k !== "mes" && m[k] != null))
    .sort((a, b) => a.mes.localeCompare(b.mes));
  if (!meses.length) throw ApiError.badRequest("Nenhum mês com valores foi encontrado na planilha.", { codigo: "SEM_MESES" });
  if (!meses.some((m) => m.valor_vendas != null)) throw ApiError.badRequest("A linha 'Valor das vendas' (aba Financeiro) não foi encontrada.", { codigo: "SEM_VENDAS" });

  // Conferência dos % da planilha contra o recálculo (só avisa; nunca altera o valor de origem).
  for (const m of meses) {
    const ym = m.mes.slice(0, 7);
    const v = centavos(m.valor_vendas), tc = centavos(m.taxas_comissoes), sp = centavos(m.servicos_promocoes), en = centavos(m.taxas_entregadores);
    const checar = (chave, recalculado, rotulo) => {
      const p = conferencias[chave]?.get(ym);
      if (p == null) return;
      const daPlanilha = Math.round(p * 1e6) / 1e4;
      if (recalculado == null) {
        if (daPlanilha === 0) avisos.push({ codigo: "ZERO_ARTIFICIAL", mes: ym, campo: rotulo, texto: `${rotulo}: a planilha mostra 0% com o valor em R$ vazio — tratado como não informado.` });
        return;
      }
      if (Math.abs(daPlanilha - recalculado) > 0.01) avisos.push({ codigo: "PERCENTUAL_DIVERGENTE", mes: ym, campo: rotulo, planilha: daPlanilha, recalculado });
    };
    checar("pctTaxasComissoes", pct(tc, v), "% taxas e comissões");
    checar("pctServicosPromocoes", pct(sp, v), "% serviços e promoções");
    checar("pctTaxasMaisServicos", tc != null && sp != null ? pct(tc + sp, v) : null, "% taxas + serviços");
    checar("pctEntregadores", pct(en, v), "% entregadores");
    checar("pctTaxasMaisServicosMaisEntregadores", tc != null && sp != null && en != null ? pct(tc + sp + en, v) : null, "% total com entregadores");
  }

  return { sha256, leitorVersao: LEITOR_VERSAO, titulo, meses, metas, notas: [...new Set(notas)], avisos };
}
