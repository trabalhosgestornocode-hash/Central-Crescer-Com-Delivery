// Validações centralizadas de entrada. Contratos são ESTRITOS: campo desconhecido é erro, não é ignorado.
import { CODIGO, falhar } from "./erros.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ehUuid = (v) => typeof v === "string" && UUID.test(v);

export function exigirObjeto(v, campo = "entrada") {
  if (v === null || typeof v !== "object" || Array.isArray(v)) falhar(CODIGO.ENTRADA_INVALIDA, `${campo} deve ser um objeto.`, { campo });
  return v;
}

export function semCamposDesconhecidos(obj, permitidos, nome = "entrada") {
  const extras = Object.keys(exigirObjeto(obj, nome)).filter((k) => !permitidos.includes(k));
  if (extras.length) falhar(CODIGO.ENTRADA_INVALIDA, `${nome} contém campos não reconhecidos.`, { campos: extras });
  return obj;
}

export function exigirUuid(v, campo) {
  if (!ehUuid(v)) falhar(CODIGO.ENTRADA_INVALIDA, `${campo} deve ser um identificador válido.`, { campo });
  return v.toLowerCase();
}

export function uuidOpcional(v, campo) {
  return v === undefined || v === null ? null : exigirUuid(v, campo);
}

/** Texto obrigatório (aparado, sem caracteres de controle). Com `opcional`, ausência vira null. */
export function exigirTexto(v, campo, { max = 200, opcional = false } = {}) {
  if (v === undefined || v === null || v === "") {
    if (opcional) return null;
    falhar(CODIGO.ENTRADA_INVALIDA, `${campo} é obrigatório.`, { campo });
  }
  if (typeof v !== "string") falhar(CODIGO.ENTRADA_INVALIDA, `${campo} deve ser texto.`, { campo });
  const t = v.trim();
  // eslint-disable-next-line no-control-regex
  if (!t || t.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(t)) {
    if (!t && opcional) return null;
    falhar(CODIGO.ENTRADA_INVALIDA, `${campo} é inválido (vazio, longo demais ou com caracteres de controle).`, { campo });
  }
  return t;
}

export function exigirUmDe(v, enumeracao, campo) {
  const valores = Array.isArray(enumeracao) ? enumeracao : Object.values(enumeracao);
  if (typeof v !== "string" || !valores.includes(v)) falhar(CODIGO.ENTRADA_INVALIDA, `${campo} não é um valor permitido.`, { campo, permitidos: valores });
  return v;
}

export function exigirLista(v, campo, { min = 1, max = 500 } = {}) {
  if (!Array.isArray(v) || v.length < min || v.length > max) {
    falhar(CODIGO.ENTRADA_INVALIDA, `${campo} deve ser uma lista com ${min} a ${max} itens.`, { campo });
  }
  return v;
}

export function exigirInteiro(v, campo, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(v) || v < min || v > max) falhar(CODIGO.ENTRADA_INVALIDA, `${campo} deve ser um inteiro entre ${min} e ${max}.`, { campo });
  return v;
}

/** Congela em profundidade (registros devolvidos pelo núcleo são imutáveis). */
export function congelar(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) congelar(v[k]);
  }
  return v;
}
