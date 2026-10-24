// Checklist Operacional — PERÍODOS do Dashboard Operacional (funções puras; relógio sempre injetado).
//
// Todo limite é um DIA OPERACIONAL no fuso do negócio (mesma convenção do resumo ao vivo: dia civil, virada 00:00,
// America/Sao_Paulo). O pedido pertence ao dia do seu recebimento oficial — nunca ao dia em que a Central o gravou.
//
// PERÍODOS
//   hoje          o dia de hoje (parcial)
//   ontem         o dia de ontem
//   semana        segunda-feira desta semana até hoje (parcial)
//   mes           dia 1 deste mês até hoje (parcial)
//   personalizado [inicio, fim] (datas inclusivas), no máximo LIMITE_DIAS dias, nunca no futuro
//
// COMPARATIVO EQUIVALENTE ("período anterior")
//   hoje → ontem · ontem → anteontem · semana → os mesmos dias da semana anterior · mês → o mês anterior do dia 1 ao
//   mesmo dia (limitado ao último dia dele) · personalizado → a mesma quantidade de dias imediatamente antes.
//   Período que termina HOJE está incompleto: o último dia do comparativo é cortado no MESMO horário de agora
//   (`corteMs`), para não comparar um dia pela metade com um dia inteiro.

import { FUSO_NEGOCIO, partesNoFuso, instanteLocal } from "./checklistOperacional.calc.js";

export const PERIODOS = Object.freeze(["hoje", "ontem", "semana", "mes", "personalizado"]);
export const LIMITE_DIAS = 92;

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const DIA_MS = 86_400_000;

/** "2026-10-24" → ms UTC à meia-noite (só aritmética de calendário; nunca um instante real). */
const diaUtc = (iso) => Date.parse(`${iso}T00:00:00Z`);
const isoDeUtc = (t) => new Date(t).toISOString().slice(0, 10);
export const somarDias = (iso, n) => isoDeUtc(diaUtc(iso) + n * DIA_MS);
export const diasEntre = (a, b) => Math.round((diaUtc(b) - diaUtc(a)) / DIA_MS) + 1; // inclusivo

/** Data válida de verdade (2026-02-30 não passa). */
export function dataValida(iso) {
  if (typeof iso !== "string" || !RE_DATA.test(iso)) return false;
  const t = diaUtc(iso);
  return Number.isFinite(t) && isoDeUtc(t) === iso;
}

/** Hoje (data local) no fuso. */
export function hojeNoFuso(agoraMs, fuso = FUSO_NEGOCIO) {
  const p = partesNoFuso(agoraMs, fuso);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Instante (ms) do início do dia operacional `iso`. */
export function inicioDoDia(iso, fuso = FUSO_NEGOCIO) {
  const [a, m, d] = iso.split("-").map(Number);
  return instanteLocal(a, m, d, 0, fuso);
}

/** 0 = domingo … 6 = sábado (dia da semana do calendário, sem fuso: a data já é local). */
export const diaDaSemana = (iso) => new Date(diaUtc(iso)).getUTCDay();

const ultimoDiaDoMes = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).getUTCDate();

function intervalo(inicio, fim, fuso, corteMs = null) {
  return { inicio, fim, dias: diasEntre(inicio, fim), inicioMs: inicioDoDia(inicio, fuso), fimMs: inicioDoDia(somarDias(fim, 1), fuso), corteMs };
}

const erro = (codigo, mensagem) => ({ ok: false, codigo, mensagem });

/**
 * @param {{periodo?: string, inicio?: string, fim?: string, agoraMs: number, fuso?: string}} p
 * @returns {{ok: true, tipo: string, atual: object, anterior: object, parcial: boolean} | {ok: false, codigo: string, mensagem: string}}
 */
export function resolverPeriodo({ periodo = "hoje", inicio, fim, agoraMs, fuso = FUSO_NEGOCIO }) {
  if (!PERIODOS.includes(periodo)) return erro("PERIODO_INVALIDO", "Período inválido. Use hoje, ontem, semana, mes ou personalizado.");
  const hoje = hojeNoFuso(agoraMs, fuso);
  let a;
  let b;
  if (periodo === "hoje") [a, b] = [hoje, hoje];
  else if (periodo === "ontem") [a, b] = [somarDias(hoje, -1), somarDias(hoje, -1)];
  else if (periodo === "semana") {
    const recuo = (diaDaSemana(hoje) + 6) % 7; // segunda = 0
    [a, b] = [somarDias(hoje, -recuo), hoje];
  } else if (periodo === "mes") [a, b] = [`${hoje.slice(0, 8)}01`, hoje];
  else {
    if (!dataValida(inicio) || !dataValida(fim)) return erro("DATA_INVALIDA", "Informe início e fim no formato AAAA-MM-DD.");
    if (inicio > fim) return erro("DATA_INVALIDA", "A data inicial é depois da final.");
    if (fim > hoje) return erro("DATA_FUTURA", "O período não pode terminar no futuro.");
    if (diasEntre(inicio, fim) > LIMITE_DIAS) return erro("PERIODO_GRANDE_DEMAIS", `Escolha no máximo ${LIMITE_DIAS} dias.`);
    [a, b] = [inicio, fim];
  }

  const parcial = b === hoje;
  // Quanto do dia de hoje já passou: o último dia do comparativo é cortado no mesmo ponto.
  const decorridoHojeMs = parcial ? agoraMs - inicioDoDia(hoje, fuso) : null;

  let antA;
  let antB;
  if (periodo === "semana") [antA, antB] = [somarDias(a, -7), somarDias(b, -7)];
  else if (periodo === "mes") {
    const [ano, mes] = a.split("-").map(Number);
    const [anoAnt, mesAnt] = mes === 1 ? [ano - 1, 12] : [ano, mes - 1];
    const prefixo = `${anoAnt}-${String(mesAnt).padStart(2, "0")}-`;
    const diaFim = Math.min(Number(b.slice(8, 10)), ultimoDiaDoMes(anoAnt, mesAnt));
    [antA, antB] = [`${prefixo}01`, `${prefixo}${String(diaFim).padStart(2, "0")}`];
  } else {
    const n = diasEntre(a, b);
    [antA, antB] = [somarDias(a, -n), somarDias(a, -1)];
  }
  const corteMs = decorridoHojeMs == null ? null : inicioDoDia(antB, fuso) + decorridoHojeMs;

  return {
    ok: true,
    tipo: periodo,
    parcial,
    atual: intervalo(a, b, fuso, parcial ? agoraMs : null),
    anterior: intervalo(antA, antB, fuso, corteMs),
  };
}
