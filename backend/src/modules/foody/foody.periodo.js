// Datas da camada central Foody. Tudo em HORA DE PAREDE de Brasília ("YYYY-MM-DDTHH:MM:SS", sem fuso), igual ao Parser —
// a chave dos overrides (numero_pedido || hora de parede, 19 caracteres) depende disso.
//
// Janela da API (validada em produção, só leitura): startDate INCLUSIVO, endDate EXCLUSIVO. A janela de um dia vai de
// D 00:00:00-03:00 até (D+1) 00:00:00-03:00 — sem lacuna no último segundo e sem sobreposição com o dia seguinte.
import { FOODY_OFFSET, FOODY_OFFSET_MIN, FOODY_DIAS_REPROCESSO } from "./foody.constants.js";

const DIA = /^\d{4}-\d{2}-\d{2}$/;

export function validarCompetencia(competencia) {
  if (typeof competencia !== "string" || !DIA.test(competencia)) return false;
  const d = new Date(`${competencia}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === competencia;
}

export function somarDias(competencia, n) {
  const d = new Date(`${competencia}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Janela [inicio, fim) de um dia, no formato aceito pela API. */
export function janelaDoDia(competencia) {
  if (!validarCompetencia(competencia)) throw new RangeError(`competência inválida: ${competencia}`);
  return { inicio: `${competencia}T00:00:00${FOODY_OFFSET}`, fim: `${somarDias(competencia, 1)}T00:00:00${FOODY_OFFSET}` };
}

/**
 * Converte qualquer ISO com fuso (ou sem fuso, assumido -03:00) para hora de parede de Brasília. null se ausente/inválido.
 * "2026-09-12T19:03:11-03:00" → "2026-09-12T19:03:11"; "2026-09-12T22:03:11Z" → "2026-09-12T19:03:11".
 */
export function paraParede(iso) {
  if (iso == null || String(iso).trim() === "") return null;
  const s = String(iso).trim();
  const comFuso = /(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s}${FOODY_OFFSET}`;
  const ms = Date.parse(comFuso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + FOODY_OFFSET_MIN * 60_000).toISOString().slice(0, 19);
}

/** "Hoje" (parede de Brasília) a partir de um Date. */
export function hojeParede(agora = new Date()) {
  return new Date(agora.getTime() + FOODY_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

/** Competências da rodada agendada: D-1 primeiro, depois D-2 … D-N (reprocessamento das janelas recentes). */
export function competenciasParaSincronizar(agora = new Date(), dias = FOODY_DIAS_REPROCESSO) {
  const hoje = hojeParede(agora);
  return Array.from({ length: dias }, (_, i) => somarDias(hoje, -(i + 1)));
}

/** Dia congelado: fora da janela de reprocessamento automático (D-1..D-N). Hoje e futuro também não são sincronizados. */
export function situacaoCompetencia(competencia, agora = new Date(), dias = FOODY_DIAS_REPROCESSO) {
  const hoje = hojeParede(agora);
  if (competencia >= hoje) return "FUTURA_OU_ABERTA";
  if (competencia < somarDias(hoje, -dias)) return "CONGELADA";
  return "REPROCESSAVEL";
}
