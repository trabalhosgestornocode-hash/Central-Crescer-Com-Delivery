// PERÍODO DE REFERÊNCIA na legenda do comprovante (25/11/2026) — regras PURAS, sem I/O, sem IA.
//
// "Vale-refeição de 24/11 a 30/11", "aluguel referente a novembro", "vale-transporte da primeira semana de dezembro",
// "energia referente a outubro". Só é competência quando é INEQUÍVOCA: período dentro de um mês ou um único mês citado.
// Período que atravessa dois meses ou dois meses citados ⇒ ambígua (o MOVA pergunta só o mês). Nunca inventa.
// O mesmo período decide se uma conta EXISTENTE pode ser a paga: período informado incompatível ⇒ não é aquela conta.
import { normalizar } from "./divergencia.js";

const MESES = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const RE_NOME = new RegExp(`\\b(${MESES.join("|")})\\b(?:\\s+(?:de\\s+)?(20\\d{2}))?`, "g");
// dd/mm[/aa[aa]] a|até|-|ao dd/mm[/aa[aa]] (texto ORIGINAL: as barras importam)
const RE_INTERVALO = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(?:a|à|ate|até|ao|-|–)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/i;
const RE_MES_ANO = /(?<![\d/])(0?[1-9]|1[0-2])\/(20\d{2})\b/; // "11/2026", nunca o fim de "25/11/2026"

const anoDe = (a, ref) => (a ? (String(a).length === 2 ? 2000 + Number(a) : Number(a)) : ref);
const doisDigitos = (n) => String(n).padStart(2, "0");
const dataIso = (ano, mes, dia) => {
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia ? `${ano}-${doisDigitos(mes)}-${doisDigitos(dia)}` : null;
};

/**
 * @param {string|null} texto legenda (dado não confiável: só é lido por estas regras)
 * @param {string|null} dataPagamento AAAA-MM-DD (ano de referência quando a legenda não traz o ano)
 * @returns {null | {inicio:string|null, fim:string|null, competencia:string|null, ambigua:boolean, meses:string[]}}
 */
export function periodoDaLegenda(texto, dataPagamento) {
  const bruto = String(texto ?? "");
  if (!bruto.trim()) return null;
  const [anoRef, mesRef] = String(dataPagamento ?? "").split("-").map(Number);
  const ref = anoRef || new Date().getUTCFullYear();
  const i = RE_INTERVALO.exec(bruto);
  if (i) {
    const [, d1, m1, a1, d2, m2, a2] = i;
    const fimAno = anoDe(a2, ref);
    let iniAno = anoDe(a1, fimAno);
    if (!a1 && Number(m1) > Number(m2)) iniAno = fimAno - 1; // 28/12 a 03/01
    const inicio = dataIso(iniAno, Number(m1), Number(d1)); const fim = dataIso(fimAno, Number(m2), Number(d2));
    if (inicio && fim && inicio <= fim) {
      const meses = [...new Set([inicio.slice(0, 7), fim.slice(0, 7)])];
      return { inicio, fim, competencia: meses.length === 1 ? meses[0] : null, ambigua: meses.length > 1, meses };
    }
  }
  const t = normalizar(bruto);
  const meses = new Set();
  for (const m of t.matchAll(RE_NOME)) {
    const mes = MESES.indexOf(m[1]) + 1;
    // Sem ano: o do pagamento; mês posterior ao do pagamento em mais de um ⇒ ano anterior ("dezembro" pago em janeiro).
    const ano = m[2] ? Number(m[2]) : (mesRef && mes > mesRef + 1 ? ref - 1 : ref);
    meses.add(`${ano}-${doisDigitos(mes)}`);
  }
  const ma = RE_MES_ANO.exec(bruto);
  if (ma && !RE_INTERVALO.test(bruto)) meses.add(`${ma[2]}-${doisDigitos(ma[1])}`);
  if (!meses.size) return null;
  const lista = [...meses].sort();
  return { inicio: null, fim: null, competencia: lista.length === 1 ? lista[0] : null, ambigua: lista.length > 1, meses: lista };
}

/**
 * A conta EXISTENTE pode ser a paga por este comprovante, dado o período informado? Sem período informado ⇒ sim (regra antiga).
 * Incompatível quando: a competência da conta difere da competência inequívoca informada; ou a descrição da conta traz um
 * período que NÃO se sobrepõe ao informado (outra semana do mesmo benefício, mesmo valor e mesma pessoa).
 */
export function contaCompativelComPeriodo(conta, periodo) {
  if (!periodo || periodo.ambigua) return true;
  if (periodo.competencia && conta?.competencia && conta.competencia !== periodo.competencia) return false;
  if (periodo.inicio && periodo.fim) {
    const ano = Number(String(conta?.vencimento ?? conta?.competencia ?? periodo.fim).slice(0, 4)) || Number(periodo.fim.slice(0, 4));
    const daConta = periodoDaLegenda(conta?.descricao ?? "", `${ano}-${String(conta?.competencia ?? periodo.fim).slice(5, 7) || "01"}-15`);
    if (daConta?.inicio && daConta?.fim && (daConta.fim < periodo.inicio || daConta.inicio > periodo.fim)) return false;
  }
  return true;
}

/**
 * Identificador da transação LIDO de um comprovante pode estar RECORTADO na imagem. Só vale como chave de duplicidade quando
 * tem a forma completa conhecida (Pix E2E: "E" + 31 caracteres); um E2E incompleto é descartado (vira incerteza), para não
 * bater por engano com outro pagamento nem deixar de bater com o mesmo. Outros formatos (autenticação, NSU) passam.
 */
export function idTransacaoConfiavel(id) {
  if (typeof id !== "string" || !id.trim()) return null;
  const v = id.trim();
  if (/^E\d{8}/i.test(v)) return /^E[0-9A-Z]{31}$/i.test(v) ? v : null;
  return v.length >= 6 ? v : null;
}
