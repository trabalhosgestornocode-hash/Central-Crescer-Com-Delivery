// Fuso da operação no frontend do Dashboard Operacional (D-15). A fonte é SEMPRE o servidor: a resposta traz
// `periodo.fuso` / `ficha.fuso` (fuso da unidade a partir da data de corte, senão o padrão). Esta tela só exibe
// horários nesse fuso — nunca decide competência por conta própria.
export const FUSO_PADRAO = "America/Sao_Paulo";
let atual = FUSO_PADRAO;

function fusoValido(f) {
  if (typeof f !== "string" || !f) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: f }); return true; } catch { return false; }
}

/** Fixa o fuso vindo do servidor (inválido/ausente → padrão). */
export function definirFusoOperacao(fuso) { atual = fusoValido(fuso) ? fuso : FUSO_PADRAO; return atual; }
export const fusoOperacao = () => atual;

export const horaNoFuso = (iso, fuso = atual) =>
  (iso ? new Date(iso).toLocaleTimeString("pt-BR", { timeZone: fuso, hour: "2-digit", minute: "2-digit" }) : "—");
export const dataHoraNoFuso = (iso, fuso = atual) =>
  (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: fuso, dateStyle: "short", timeStyle: "short" }) : "—");
/** AAAA-MM-DD do instante no fuso. */
export const diaNoFuso = (agora = new Date(), fuso = atual) => new Intl.DateTimeFormat("en-CA", { timeZone: fuso }).format(agora);
