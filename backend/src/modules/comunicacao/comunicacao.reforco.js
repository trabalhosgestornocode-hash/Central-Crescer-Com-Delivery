// REFORÇO DE PRAZO FINAL D-1 — 2ª mensagem (no máximo uma) de um alerta cuja 1ª mensagem já saiu.
// Funções PURAS (sem I/O), reaproveitando os utilitários de comunicacao.horario.js
// (partesLocais/instanteDeLocal/inteiroDeterministico) — nada de conversão de timezone
// ou jitter reimplementados — e a `diaAnterior` canônica do Painel Administrativo.
//
// POLÍTICA (decisão de produto, H.4-A.8): 1 aviso normal (horário comercial, fluxo existente)
// + no máximo 1 reforço de prazo final, EXCLUSIVAMENTE para dashboard_ifood_d1 cujo prazo
// vence HOJE (dataReferencia === diaAnterior(hoje local)) — backlog antigo e outros tipos, não.
//   * janela do reforço: 20:00–22:00 local da organização, jitter determinístico dentro dela;
//   * hard cutoff: 22:30 local (expira_em); nunca reagendado para o dia seguinte;
//   * dias: segunda a sábado (domingo NÃO). GAP CONHECIDO: não há calendário de feriados;
//   * espaçamento próprio: >= 2h desde o envio REAL da mensagem inicial (o cooldown normal de
//     8h/4h NÃO controla o reforço; rate-limit diário e por minuto continuam valendo).
// A janela comercial normal (08–18) NÃO se aplica ao reforço — nem o pipeline normal é alterado.

import { partesLocais, instanteDeLocal, inteiroDeterministico } from "./comunicacao.horario.js";
import { diaAnterior } from "../administrativo/administrativo.status.js";

const MIN = 60_000;

/** Janela do reforço, em horário LOCAL da organização. */
export const JANELA_REFORCO = Object.freeze({ inicio: { hora: 20, minuto: 0 }, fim: { hora: 22, minuto: 0 } });

/** Hard cutoff ABSOLUTO (local): depois disso nada sai e nada é reagendado. */
export const CUTOFF_REFORCO = Object.freeze({ hora: 22, minuto: 30 });

/** Espaçamento mínimo (horas) desde o envio real da mensagem inicial. */
export const ESPACAMENTO_MINIMO_HORAS = 2;

/** Espalhamento máximo do jitter determinístico dentro da janela. */
export const SPREAD_REFORCO_MS = 30 * MIN;

/** Propósito gravado em `comunicacao_mensagens.metadados.proposito` (ausente = mensagem inicial). */
export const PROPOSITO = Object.freeze({ INICIAL: "inicial", REFORCO: "reforco" });

/** Motivos de cancelamento terminal do reforço no JIT (nunca há retry para outro dia). */
export const MOTIVO_REFORCO = Object.freeze({
  FORA_DA_JANELA: "REFORCO_FORA_DA_JANELA",
  PRAZO_NAO_E_HOJE: "REFORCO_PRAZO_NAO_E_HOJE",
  TIPO_NAO_SUPORTADO: "REFORCO_TIPO_NAO_SUPORTADO",
  PRIMEIRA_NAO_ENVIADA: "REFORCO_PRIMEIRA_NAO_ENVIADA",
  ESPACAMENTO_INSUFICIENTE: "REFORCO_ESPACAMENTO_INSUFICIENTE",
});

export const chaveIdempotenciaInicial = (alertaId) => `wa:alerta:${alertaId}:v1`;
export const chaveIdempotenciaReforco = (alertaId) => `wa:alerta:${alertaId}:reforco:v1`;

/** Propósito de uma linha de `comunicacao_mensagens` (sem metadados = inicial, compatibilidade histórica). */
export const propositoDaMensagem = (mensagem) => (mensagem?.metadados?.proposito === PROPOSITO.REFORCO ? PROPOSITO.REFORCO : PROPOSITO.INICIAL);

/** AAAA-MM-DD do instante no calendário LOCAL da organização. */
export function dataLocalIso(instante, tz) {
  const p = partesLocais(instante, tz);
  return `${p.ano}-${String(p.mes).padStart(2, "0")}-${String(p.dia).padStart(2, "0")}`;
}

/** O prazo do D-1 (`dataReferencia`) vence HOJE (calendário local)? Backlog antigo = false. Nunca infere por contagem de dias. */
export function prazoD1VenceHoje(dataReferencia, agora, tz) {
  if (!dataReferencia) return false;
  return dataReferencia === diaAnterior(dataLocalIso(agora, tz));
}

/**
 * Janela de reforço de HOJE, ou `null` se `agora` não está nela. Exige: dia de segunda a sábado
 * (domingo = fechado) E 20:00 <= agora < 22:00 locais (e, por construção, antes do cutoff 22:30).
 * @returns {{inicio: Date, fim: Date, cutoff: Date}|null}
 */
export function janelaDeReforcoAgora(agora, tz) {
  const p = partesLocais(agora, tz);
  if (p.diaSemana === 0) return null; // domingo: sem reforço
  const inicio = instanteDeLocal(tz, p.ano, p.mes, p.dia, JANELA_REFORCO.inicio.hora, JANELA_REFORCO.inicio.minuto);
  const fim = instanteDeLocal(tz, p.ano, p.mes, p.dia, JANELA_REFORCO.fim.hora, JANELA_REFORCO.fim.minuto);
  const cutoff = instanteDeLocal(tz, p.ano, p.mes, p.dia, CUTOFF_REFORCO.hora, CUTOFF_REFORCO.minuto);
  const t = new Date(agora).getTime();
  if (t < inicio.getTime() || t >= fim.getTime() || t >= cutoff.getTime()) return null;
  return { inicio, fim, cutoff };
}

/** Instante do reforço: `agora` + jitter determinístico (mesma chave -> mesmo horário), nunca depois de fim-1min. */
export function instanteDoReforco(agora, janela, chave) {
  const base = new Date(agora).getTime();
  const restante = Math.max(0, janela.fim.getTime() - base - MIN);
  return new Date(base + inteiroDeterministico(chave, Math.min(SPREAD_REFORCO_MS, restante)));
}

/** Espaçamento mínimo desde o envio real da inicial cumprido? (`enviadoEm` ausente = não cumprido, fail-closed.) */
export function espacamentoCumprido(enviadoEm, agora) {
  if (!enviadoEm) return false;
  return new Date(agora).getTime() >= new Date(enviadoEm).getTime() + ESPACAMENTO_MINIMO_HORAS * 60 * MIN;
}

/** O 1º envio foi HOJE (no calendário local da organização)? O reforço é "do dia" — nunca de dias depois. */
export function mesmoDiaLocal(a, b, tz) {
  return dataLocalIso(a, tz) === dataLocalIso(b, tz);
}
