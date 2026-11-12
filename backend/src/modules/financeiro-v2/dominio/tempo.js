// Datas e competências. Datas são texto ISO "AAAA-MM-DD" (sem hora, sem fuso); competência é "AAAA-MM".
// Texto ISO compara corretamente com < e >, então nenhuma aritmética de Date vaza para as regras.
import { CODIGO, falhar } from "./erros.js";

const DATA = /^(\d{4})-(\d{2})-(\d{2})$/;
const COMPETENCIA = /^(\d{4})-(0[1-9]|1[0-2])$/;
const ANO_MIN = 2000;
const ANO_MAX = 2100;

export function ehData(v) {
  const m = typeof v === "string" ? DATA.exec(v) : null;
  if (!m) return false;
  const [a, me, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (a < ANO_MIN || a > ANO_MAX) return false;
  const dt = new Date(Date.UTC(a, me - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === me - 1 && dt.getUTCDate() === d;
}

export function exigirData(v, campo = "data") {
  if (!ehData(v)) falhar(CODIGO.DATA_INVALIDA, `${campo} deve ser uma data real no formato AAAA-MM-DD.`, { campo });
  return v;
}

export function ehCompetencia(v) {
  const m = typeof v === "string" ? COMPETENCIA.exec(v) : null;
  return !!m && Number(m[1]) >= ANO_MIN && Number(m[1]) <= ANO_MAX;
}

export function exigirCompetencia(v, campo = "competencia") {
  if (!ehCompetencia(v)) falhar(CODIGO.DATA_INVALIDA, `${campo} deve estar no formato AAAA-MM.`, { campo });
  return v;
}

export const competenciaDe = (data) => exigirData(data).slice(0, 7);

/** Soma meses preservando o dia quando possível (31/01 + 1 mês = 28 ou 29/02). */
export function somarMeses(data, meses) {
  exigirData(data);
  if (!Number.isSafeInteger(meses)) falhar(CODIGO.DATA_INVALIDA, "Quantidade de meses inválida.");
  const [a, m, d] = data.split("-").map(Number);
  const indice = a * 12 + (m - 1) + meses;
  const ano = Math.floor(indice / 12);
  const mes = indice % 12;
  const ultimoDia = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
  const texto = `${String(ano).padStart(4, "0")}-${String(mes + 1).padStart(2, "0")}-${String(Math.min(d, ultimoDia)).padStart(2, "0")}`;
  return exigirData(texto, "data resultante");
}

/** Data civil de hoje no fuso da operação (padrão: Brasília). */
export function hojeEm(instante = new Date(), fuso = "America/Sao_Paulo") {
  return new Intl.DateTimeFormat("en-CA", { timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit" }).format(instante);
}
