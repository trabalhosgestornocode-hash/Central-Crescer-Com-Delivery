// JANELA CRÍTICA D-1 — Checkpoint H.4-A.4. Funções PURAS (sem I/O), mesmo
// espírito de comunicacao.horario.js — reaproveita seus utilitários
// (partesLocais/instanteDeLocal/inteiroDeterministico), NUNCA duplica a
// conversão de timezone nem a matemática de jitter.
//
// A janela comercial normal (seg-sex 08:00-18:00 etc., comunicacao.horario.js)
// continua INTOCADA — este arquivo é uma camada A MAIS, só para o caso
// específico de uma pendência dashboard_ifood_d1 cujo prazo operacional
// encerra HOJE (ver administrativo.status.js#prazoFinalHoje). Fora desse
// caso, nenhuma destas funções é sequer consultada pelo pipeline normal.
//
// V1: no máximo DOIS estágios críticos por dia (item 16 do checkpoint) —
// nunca um terceiro, nunca depois do cutoff.

import { partesLocais, instanteDeLocal, inteiroDeterministico } from "./comunicacao.horario.js";

export const ESTAGIO_CRITICO = Object.freeze({
  CRITICO_1: "critico_1",
  CRITICO_FINAL: "critico_final",
});

// Faixas em horário LOCAL da organização — propositalmente estreitas (item 7):
// não é "a janela crítica inteira dispara continuamente", é a janela em que
// CADA estágio especificamente pode ser agendado, uma vez.
const FAIXAS = Object.freeze({
  [ESTAGIO_CRITICO.CRITICO_1]: { iniH: 19, iniM: 30, fimH: 20, fimM: 0 },
  [ESTAGIO_CRITICO.CRITICO_FINAL]: { iniH: 22, iniM: 15, fimH: 22, fimM: 45 },
});

// Hard cutoff (item 8): depois disso, NADA novo é agendado hoje — nem
// CRITICO_1 nem CRITICO_FINAL, mesmo que caiam dentro de suas próprias
// faixas (na prática nunca caem, já que as duas faixas terminam antes disto;
// mantido como invariante explícita e verificável, não só "por construção").
export const CUTOFF_CRITICO = Object.freeze({ hora: 23, minuto: 30 });

const emMinutos = (h, m) => h * 60 + m;

function minutoDoInstanteLocal(instante, tz) {
  const p = partesLocais(instante, tz);
  return { minuto: p.hora * 60 + p.minuto, partes: p };
}

/** `instante` cai depois do hard cutoff (23:30 local)? Se sim, nada novo pode ser agendado hoje. */
export function depoisDoCutoffCritico(instante, tz) {
  const { minuto } = minutoDoInstanteLocal(instante, tz);
  return minuto >= emMinutos(CUTOFF_CRITICO.hora, CUTOFF_CRITICO.minuto);
}

/**
 * `instante` está DENTRO da faixa deste estágio específico, em horário local?
 * (fim exclusivo, mesmo padrão de dentroDaJanelaLocal). `estagio` desconhecido -> false.
 */
export function estagioCriticoElegivel(instante, tz, estagio) {
  const faixa = FAIXAS[estagio];
  if (!faixa) return false;
  const { minuto } = minutoDoInstanteLocal(instante, tz);
  return minuto >= emMinutos(faixa.iniH, faixa.iniM) && minuto < emMinutos(faixa.fimH, faixa.fimM);
}

/**
 * Qual estágio (se algum) está elegível agora? `null` se nenhum — nunca os
 * dois ao mesmo tempo (as faixas não se sobrepõem, por construção).
 */
export function estagioCriticoAtual(instante, tz) {
  for (const estagio of Object.values(ESTAGIO_CRITICO)) {
    if (estagioCriticoElegivel(instante, tz, estagio)) return estagio;
  }
  return null;
}

/**
 * Próximo instante (dentro de HOJE, local) em que este estágio pode ser
 * agendado, com jitter determinístico limitado pela PRÓPRIA faixa do
 * estágio (item 9 — nunca o jitter genérico de 30min, que poderia
 * ultrapassar uma faixa de 30min inteira). `null` se a faixa de hoje já
 * fechou (chamador deve tratar como "não há mais estágio disponível hoje"
 * — nunca um retry para o dia seguinte: cada estágio é do SEU dia).
 * @returns {Date|null}
 */
export function proximoInstanteCritico(instante, tz, estagio, chave) {
  const faixa = FAIXAS[estagio];
  if (!faixa) return null;
  const { minuto, partes } = minutoDoInstanteLocal(instante, tz);
  const iniMin = emMinutos(faixa.iniH, faixa.iniM), fimMin = emMinutos(faixa.fimH, faixa.fimM);
  if (minuto >= fimMin) return null; // faixa de hoje já fechou

  const base = minuto >= iniMin
    ? new Date(instante)
    : instanteDeLocal(tz, partes.ano, partes.mes, partes.dia, faixa.iniH, faixa.iniM);
  const baseMinuto = minutoDoInstanteLocal(base, tz).minuto;
  const restanteMs = Math.max(0, (fimMin - baseMinuto) * 60_000 - 60_000); // nunca no minuto exato do fim
  const jitterMs = inteiroDeterministico(chave, restanteMs || 1);
  return new Date(base.getTime() + jitterMs);
}
