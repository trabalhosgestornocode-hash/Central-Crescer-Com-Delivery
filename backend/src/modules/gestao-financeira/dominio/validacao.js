// Validação de entrada do domínio (pura). Erros → ApiError.badRequest com `codigo`. Nada de float: valores viram centavos.
import { ApiError } from "../../../shared/ApiError.js";
import { paraCentavos, ValorInvalidoError } from "../../../financeiro-calculos/dinheiro.js";
import { paraDataISO } from "../../../financeiro-calculos/importacao.js";
import { PAPEIS } from "../../../financeiro-calculos/planoContas.js";
import { ehUuid } from "./contexto.js";

const bad = (msg, codigo = "ENTRADA_INVALIDA") => ApiError.badRequest(msg, { codigo });

export function texto(v, campo, { max = 300, obrigatorio = true } = {}) {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  if (!s) { if (obrigatorio) throw bad(`${campo} é obrigatório.`); return null; }
  if (s.length > max) throw bad(`${campo} excede ${max} caracteres.`);
  return s;
}
export function uuid(v, campo, { obrigatorio = true } = {}) {
  if (v == null || v === "") { if (obrigatorio) throw bad(`${campo} é obrigatório.`); return null; }
  if (!ehUuid(v)) throw bad(`${campo} inválido.`);
  return v;
}
export function valorPositivo(v, campo = "valor") {
  let c;
  try { c = paraCentavos(v); } catch (e) { if (e instanceof ValorInvalidoError) throw bad(`${campo} inválido (use até 2 casas decimais).`); throw e; }
  if (c == null || c <= 0) throw bad(`${campo} deve ser maior que zero.`);
  if (c > 100_000_000_000) throw bad(`${campo} fora da faixa permitida.`);
  return c;
}
export function valorOuNulo(v, campo) {
  if (v == null || v === "") return null;
  try { const c = paraCentavos(v); if (c == null) return null; return c; } catch { throw bad(`${campo} inválido.`); }
}
export function data(v, campo = "data", { obrigatorio = true } = {}) {
  if (v == null || v === "") { if (obrigatorio) throw bad(`${campo} é obrigatória.`); return null; }
  const d = paraDataISO(typeof v === "string" ? v : String(v));
  if (!d) throw bad(`${campo} inválida (use AAAA-MM-DD).`);
  return d;
}
export function enumerado(v, campo, permitidos, { obrigatorio = true } = {}) {
  if (v == null || v === "") { if (obrigatorio) throw bad(`${campo} é obrigatório.`); return null; }
  if (!permitidos.includes(v)) throw bad(`${campo} inválido.`);
  return v;
}
export const periodo = (q) => {
  const de = data(q?.de, "de", { obrigatorio: false });
  const ate = data(q?.ate, "ate", { obrigatorio: false });
  if (de && ate && de > ate) throw bad("O período está invertido (de > ate).");
  return { de, ate };
};
export const papel = (v) => enumerado(v, "papel", PAPEIS);
export { bad };
