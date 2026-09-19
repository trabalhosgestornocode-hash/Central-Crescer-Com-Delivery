// ADIAMENTO com HORÁRIO REAL — função PURA (sem I/O, sem relógio): dado o motivo
// TRANSITÓRIO de um bloqueio, calcula o PRÓXIMO instante em que a mensagem volta
// a ser elegível. Substitui o antigo "+15 minutos" cego: um adiamento nunca cai
// fora da janela de envio da ORGANIZAÇÃO (timezone IANA dela), e nunca usa a hora
// local do servidor.
//
// O que decide o instante:
//   OUTSIDE_ALLOWED_WINDOW  próxima abertura de janela (+ jitter determinístico)
//   EMPRESA_PAUSADA         `pausado_ate` (e, se cair fora da janela, a abertura seguinte)
//   RATE_LIMIT (dia)        00:00 do PRÓXIMO dia local da organização (a cota zera) -> abertura
//   RATE_LIMIT (minuto)     ~2 min (a taxa por minuto esvazia sozinha)
//   COOLDOWN/PROVIDER/MODO  agora + `adiamentoMs`, empurrado para dentro da janela
//   CONFIG_INVALIDA         sem timezone/janela confiável não há como calcular horário:
//                           espera longa e fixa (a mensagem expira por TTL se ninguém corrigir)
//
// JITTER: derivado de hash(idempotency_key | data lógica | organização) — mesma
// mensagem, mesmo instante em toda reavaliação; nunca Math.random().

import { MOTIVOS_BLOQUEIO } from "./comunicacao.constants.js";
import {
  proximoHorarioDeEnvio, inicioDoProximoDiaLocal, timezoneValido, janelasValidas,
  ConfiguracaoHorarioInvalida,
} from "./comunicacao.horario.js";

const MIN = 60_000;
export const ESPERA_RATE_LIMIT_MINUTO_MS = 2 * MIN;
export const ESPERA_CONFIG_INVALIDA_MS = 60 * MIN;
/** O banco impõe um mínimo de +1 min em todo adiamento (comunicacao_encerrar_processamento). */
export const ADIAMENTO_MINIMO_MS = MIN;

/** Motivo do bloqueio da RESERVA atômica -> vocabulário de bloqueio da política. */
export const MOTIVO_DA_RESERVA = Object.freeze({
  COOLDOWN: MOTIVOS_BLOQUEIO.COOLDOWN,
  RATE_LIMIT_DIA: MOTIVOS_BLOQUEIO.RATE_LIMIT,
  RATE_LIMIT_MINUTO: MOTIVOS_BLOQUEIO.RATE_LIMIT,
  RATE_LIMIT_MINUTO_ORGANIZACAO: MOTIVOS_BLOQUEIO.RATE_LIMIT,
});

/**
 * Chave do jitter: identifica o EVENTO LÓGICO, não a execução. Mesma mensagem
 * (idempotency_key) + mesma data lógica + mesma organização => mesmo hash.
 * @param {{idempotencyKey: string, dataLogica?: string|null, organizacaoId: string}} p
 */
export function chaveDeJitter({ idempotencyKey, dataLogica = null, organizacaoId }) {
  return `${idempotencyKey}|${dataLogica ?? ""}|${organizacaoId}`;
}

/**
 * @param {{
 *   motivo: string, agora: Date, adiamentoMs: number,
 *   timezone?: string|null, janelas?: object|null, pausadoAte?: Date|null,
 *   ratePorDia?: boolean, chave: string, jitterMaxMs?: number,
 * }} p
 * @returns {Date} instante FUTURO (>= agora + 1 min) em que a mensagem volta a ser elegível
 */
export function calcularDisponivelEm({ motivo, agora, adiamentoMs, timezone = null, janelas = null, pausadoAte = null, ratePorDia = false, chave, jitterMaxMs }) {
  const minimo = new Date(agora.getTime() + ADIAMENTO_MINIMO_MS);
  const espera = (ms) => new Date(agora.getTime() + Math.max(ms, ADIAMENTO_MINIMO_MS));
  const horarioConfiavel = timezoneValido(timezone) && janelasValidas(janelas);

  // Sem timezone/janela confiável não existe "próximo horário real": espera fixa.
  if (!horarioConfiavel) return espera(motivo === MOTIVOS_BLOQUEIO.CONFIG_INVALIDA ? ESPERA_CONFIG_INVALIDA_MS : adiamentoMs);

  let base;
  if (motivo === MOTIVOS_BLOQUEIO.EMPRESA_PAUSADA && pausadoAte instanceof Date && pausadoAte.getTime() > agora.getTime()) {
    base = pausadoAte;
  } else if (motivo === MOTIVOS_BLOQUEIO.RATE_LIMIT && ratePorDia) {
    base = inicioDoProximoDiaLocal(agora, timezone);
  } else if (motivo === MOTIVOS_BLOQUEIO.RATE_LIMIT) {
    base = espera(ESPERA_RATE_LIMIT_MINUTO_MS);
  } else if (motivo === MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW) {
    base = minimo;
  } else {
    base = espera(adiamentoMs);
  }

  try {
    // Já dentro da janela: o próprio instante (sem jitter). Fora: abertura da próxima janela + jitter determinístico.
    const { instante } = proximoHorarioDeEnvio(base, timezone, janelas, chave, jitterMaxMs ? { spreadMaxMs: jitterMaxMs } : {});
    return instante.getTime() < minimo.getTime() ? minimo : instante;
  } catch (e) {
    if (e instanceof ConfiguracaoHorarioInvalida) return espera(ESPERA_CONFIG_INVALIDA_MS);
    throw e;
  }
}
