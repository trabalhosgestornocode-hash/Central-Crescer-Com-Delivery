// 27/11 — ESCLARECIMENTO de uma dúvida da leitura documental pelo participante (determinístico, sem IA).
// Caso real: legenda "conserto de ar condicionado 18.000" + comprovante de R$ 260,00. A leitura anotou "R$ 18.000 × R$ 260,00";
// a resposta "o 18.000 são os BTUs; o pagamento foi de R$ 260,00" resolve ESSA dúvida. Regras (nada é ignorado às cegas):
//   - a dúvida só é esclarecida quando o número que a causou aparece na resposta junto de um indício NÃO monetário (BTU, litros,
//     capacidade, modelo, código, parcelas…); número monetário diferente do comprovado = divergência real ⇒ protege e pergunta;
//   - dúvida sem número (ilegível, favorecido, data…) nunca é esclarecida por aqui;
//   - o valor efetivamente comprovado pelo documento nunca é alterado; a dúvida original é preservada na auditoria.
import { valoresCitados } from "./contaRelatada.js";

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const NUMERO = /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g;
const INDICIO_NAO_MONETARIO = /\b(btus?|btu\/h|litros?|lts?|kg|quilos?|gramas?|ml|watts?|volts?|polegadas?|capacidade|potencia|modelo|codigo|serie|parcelas?|percentual|porcento|peso|tamanho|medida|especificacao|tecnica)\b|%/;

const valor = (token) => Number(String(token).replace(/\./g, "").replace(",", "."));
/** Números de um texto com a posição (valor numérico, sem pontos de milhar). */
export function numerosDe(texto) {
  return [...norm(texto).matchAll(NUMERO)].map((m) => ({ v: valor(m[0]), pos: m.index, len: m[0].length }));
}

/**
 * @param {string} texto           resposta da pessoa
 * @param {string[]} incertezas    dúvidas anotadas pela leitura
 * @param {number} valorCentavos   valor EFETIVAMENTE comprovado pelo documento
 * @returns {{ok:true, esclarecidas:string[], restantes:string[]} | {ok:false, motivo:string, informadoCentavos?:number}}
 */
export function esclarecerIncertezas(texto, incertezas, valorCentavos) {
  const lista = (incertezas ?? []).filter((x) => typeof x === "string");
  if (!lista.length || !texto) return { ok: false, motivo: "SEM_DUVIDA" };
  const t = norm(texto);
  // divergência monetária REAL: a pessoa disse outro valor em reais
  const ditos = valoresCitados(texto);
  const outro = ditos.find((v) => v !== valorCentavos);
  if (outro !== undefined) return { ok: false, motivo: "VALOR_DIVERGENTE", informadoCentavos: outro };
  const nums = numerosDe(texto);
  const comIndicio = (n) => INDICIO_NAO_MONETARIO.test(t.slice(Math.max(0, n.pos - 40), n.pos + n.len + 40));
  const esclarecidas = [], restantes = [];
  for (const d of lista) {
    const duvidosos = numerosDe(d).filter((n) => n.v !== valorCentavos / 100);
    const ok = duvidosos.length > 0 && duvidosos.every((n) => nums.some((m) => m.v === n.v && comIndicio(m)));
    (ok ? esclarecidas : restantes).push(d);
  }
  return esclarecidas.length ? { ok: true, esclarecidas, restantes } : { ok: false, motivo: "NAO_ESCLARECE" };
}
