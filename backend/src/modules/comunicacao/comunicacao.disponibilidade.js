// DISPONIBILIDADE DOS DADOS DO iFOOD (D-1) — funções PURAS (sem I/O, sem relógio).
//
// O dashboard iFood lê o dia ANTERIOR (D-1), mas os dados completos só ficam disponíveis por volta
// das 10:00 (hora LOCAL da empresa). Antes disso a empresa NÃO está atrasada: não há cobrança, não
// há mensagem na fila. Dois horários, ambos CONFIGURÁVEIS (nada de "10:00" espalhado pelo código):
//
//   dados_disponiveis_apos  a partir daqui o D-1 pode ser considerado disponível
//   envios_permitidos_apos  horário mínimo de ENVIO (margem entre a atualização do iFood e a cobrança)
//
// O fim das comunicações continua sendo o fim da janela comercial (`janelas`).
//
// Só o dia D-1 (ontem, no calendário LOCAL da empresa) espera pela disponibilidade: uma pendência de
// dias anteriores (D-2, D-3...) já tem dado completo há muito tempo e segue só a janela comercial.

import { partesLocais } from "./comunicacao.horario.js";

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const emMinutos = (hhmm) => { const m = HHMM.exec(hhmm); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** Valor de bootstrap — só usado se a linha da configuração não existir (nunca "sem espera"). */
export const DISPONIBILIDADE_IFOOD_PADRAO = Object.freeze({ dados_disponiveis_apos: "10:00", envios_permitidos_apos: "10:30" });

/**
 * Configuração de disponibilidade válida? `envios_permitidos_apos` não pode ser ANTERIOR a
 * `dados_disponiveis_apos` (cobrar antes de o dado existir é exatamente o bug que isto evita).
 * @param {unknown} cfg
 * @returns {boolean}
 */
export function disponibilidadeValida(cfg) {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return false;
  const d = emMinutos(cfg.dados_disponiveis_apos), e = emMinutos(cfg.envios_permitidos_apos);
  return d !== null && e !== null && e >= d;
}

/**
 * Normaliza o valor lido do banco: inválido/corrompido cai no PADRÃO (nunca desativa a espera).
 * @param {unknown} cfg
 * @returns {{dados_disponiveis_apos: string, envios_permitidos_apos: string}}
 */
export function normalizarDisponibilidade(cfg) {
  return disponibilidadeValida(cfg)
    ? { dados_disponiveis_apos: cfg.dados_disponiveis_apos, envios_permitidos_apos: cfg.envios_permitidos_apos }
    : { ...DISPONIBILIDADE_IFOOD_PADRAO };
}

const pad2 = (n) => String(n).padStart(2, "0");
const isoDia = (a, m, d) => `${a}-${pad2(m)}-${pad2(d)}`;

/** `true` se `dataReferencia` (YYYY-MM-DD) é o D-1 do calendário LOCAL de `agora` no `timezone`. */
export function ehD1(dataReferencia, agora, timezone) {
  if (typeof dataReferencia !== "string") return false;
  const p = partesLocais(agora, timezone);
  const ontem = new Date(Date.UTC(p.ano, p.mes - 1, p.dia - 1));
  return dataReferencia.slice(0, 10) === isoDia(ontem.getUTCFullYear(), ontem.getUTCMonth() + 1, ontem.getUTCDate());
}

/**
 * O dado da `dataReferencia` já pode ser considerado disponível para COBRANÇA agora?
 *  - referência que NÃO é D-1 (mais antiga)                       -> disponível
 *  - D-1 e hora local < `dados_disponiveis_apos`                  -> NÃO ("DADOS_IFOOD_INDISPONIVEIS")
 *  - D-1 e hora local < `envios_permitidos_apos`                  -> NÃO ("AGUARDANDO_HORARIO_MINIMO_ENVIO")
 * @param {{dataReferencia: string, agora: Date, timezone: string, config: object}} p
 * @returns {{disponivel: boolean, motivo: string|null}}
 */
export function avaliarDisponibilidadeD1({ dataReferencia, agora, timezone, config }) {
  if (!ehD1(dataReferencia, agora, timezone)) return { disponivel: true, motivo: null };
  const cfg = normalizarDisponibilidade(config);
  const p = partesLocais(agora, timezone);
  const min = p.hora * 60 + p.minuto;
  if (min < emMinutos(cfg.dados_disponiveis_apos)) return { disponivel: false, motivo: "DADOS_IFOOD_INDISPONIVEIS" };
  if (min < emMinutos(cfg.envios_permitidos_apos)) return { disponivel: false, motivo: "AGUARDANDO_HORARIO_MINIMO_ENVIO" };
  return { disponivel: true, motivo: null };
}

/**
 * Janelas de envio EFETIVAS para um alerta cuja pendência mais antiga é `dataReferencia`: para o D-1, o
 * início de cada dia passa a ser max(início da janela, `envios_permitidos_apos`) (dia que fica sem
 * janela útil vira fechado). Assim o AGENDAMENTO nunca cai antes do horário mínimo e o ADIAMENTO
 * (calcularDisponivelEm) reagenda para depois dele. Referência mais antiga: janelas inalteradas.
 *
 * `agora` decide se HOJE o D-1 ainda é o D-1: o tratamento é pelo dia da referência em relação ao
 * calendário local de `agora` — quem chama reavalia a cada ciclo, então a restrição some sozinha
 * quando a pendência envelhece (D-1 vira D-2 à meia-noite).
 * @returns {object} novas janelas (nunca muta a entrada)
 */
export function janelasParaReferencia({ janelas, dataReferencia, agora, timezone, config }) {
  if (!janelas || !ehD1(dataReferencia, agora, timezone)) return janelas;
  const minimo = emMinutos(normalizarDisponibilidade(config).envios_permitidos_apos);
  const nova = {};
  for (const g of ["seg_sex", "sab", "dom"]) {
    const j = janelas[g];
    if (!j) { nova[g] = null; continue; }
    const ini = Math.max(emMinutos(j.inicio), minimo), fim = emMinutos(j.fim);
    nova[g] = ini < fim ? { inicio: fmt(ini), fim: j.fim } : null;
  }
  return nova;
}
