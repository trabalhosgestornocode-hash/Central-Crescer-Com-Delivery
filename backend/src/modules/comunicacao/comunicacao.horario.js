// HORÁRIO por organização — funções PURAS (sem I/O) sobre instantes UTC + timezone IANA.
//
// REGRA: toda decisão de horário comercial é
//   agora UTC -> timezone IANA da ORGANIZAÇÃO -> hora/dia local da organização.
// NUNCA a hora local do servidor (o Render roda em UTC), nunca um offset fixo
// ("-03:00" não carrega DST nem mudanças de regra). O cálculo usa Intl
// (`timeZone`), nunca aritmética manual de offset por região.
//
// DETERMINISMO: nenhuma função aqui lê o relógio nem usa Math.random — o
// chamador passa o instante. O jitter é derivado de um hash da chave do evento.
//
// (Substitui, para a decisão de horário, o antigo comunicacao.scheduler.js, que
//  usava getHours()/getDay() do servidor.)

import { createHash } from "node:crypto";

const MIN = 60_000;
const DIA_MS = 24 * 60 * MIN;
const NOMES_DIA = ["dom", "seg_sex", "seg_sex", "seg_sex", "seg_sex", "seg_sex", "sab"]; // índice = dia da semana (0=dom)

/** Erro de configuração de horário (timezone/janela inválidos): o chamador DEVE tratar como fail-closed. */
export class ConfiguracaoHorarioInvalida extends Error {
  constructor(mensagem) { super(mensagem); this.name = "ConfiguracaoHorarioInvalida"; this.codigo = "CONFIG_INVALIDA"; }
}

/**
 * `true` só para um nome IANA "Região/Cidade" (ou "UTC") que o runtime reconhece. Recusa offsets
 * ("-03:00", "UTC+3"), aliases de offset fixo ("EST", "GMT", "Etc/GMT+3") e vazio: uma empresa deve
 * gravar a cidade, para as regras de horário de verão do lugar valerem.
 */
export function timezoneValido(tz) {
  const t = typeof tz === "string" ? tz.trim() : "";
  if (!t || /^[+-]/.test(t) || /^(utc|gmt)[+-]/i.test(t)) return false;
  if (t !== "UTC" && (!t.includes("/") || /^etc\//i.test(t))) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() }); return true; } catch { return false; }
}

const formatadores = new Map();
function formatador(tz) {
  let f = formatadores.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatadores.set(tz, f);
  }
  return f;
}
const SEMANA = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function exigirTimezone(tz) {
  if (!timezoneValido(tz)) throw new ConfiguracaoHorarioInvalida(`timezone inválido: ${String(tz)}`);
  return tz.trim();
}

/**
 * Componentes de calendário do instante NO timezone dado.
 * @param {Date|number} instante
 * @param {string} tz
 * @returns {{ano:number, mes:number, dia:number, hora:number, minuto:number, segundo:number, diaSemana:number}}
 */
export function partesLocais(instante, tz) {
  const zona = exigirTimezone(tz);
  const p = {};
  for (const { type, value } of formatador(zona).formatToParts(new Date(instante))) p[type] = value;
  return {
    ano: Number(p.year), mes: Number(p.month), dia: Number(p.day),
    hora: Number(p.hour) % 24, minuto: Number(p.minute), segundo: Number(p.second),
    diaSemana: SEMANA[p.weekday],
  };
}

const pareceLocal = (t, tz, a, m, d, h, mi) => {
  const p = partesLocais(t, tz);
  return p.ano === a && p.mes === m && p.dia === d && p.hora === h && p.minuto === mi;
};

/**
 * Instante UTC em que o relógio de parede do timezone marca a data/hora dada.
 * DST: hora INEXISTENTE (salto de primavera) -> o primeiro instante válido depois do salto;
 * hora REPETIDA (volta de outono) -> a PRIMEIRA ocorrência.
 * @returns {Date}
 */
export function instanteDeLocal(tz, ano, mes, dia, hora = 0, minuto = 0) {
  const zona = exigirTimezone(tz);
  const chute = Date.UTC(ano, mes - 1, dia, hora, minuto);
  const offsetEm = (t) => {
    const p = partesLocais(t, zona);
    return Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo) - Math.floor(t / 1000) * 1000;
  };
  const t1 = chute - offsetEm(chute);
  const t2 = chute - offsetEm(t1);
  const candidatos = [...new Set([t1, t2])].filter((t) => pareceLocal(t, zona, ano, mes, dia, hora, minuto));
  if (candidatos.length) return new Date(Math.min(...candidatos));
  return new Date(Math.max(t1, t2)); // lacuna de DST
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const emMinutos = (hhmm) => { const m = HHMM.exec(hhmm); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** `janelas` no formato de comunicacao_configuracoes.janelas: {seg_sex, sab, dom} -> {inicio,fim}|null. */
export function janelasValidas(janelas) {
  if (!janelas || typeof janelas !== "object" || Array.isArray(janelas)) return false;
  let algumaAberta = false;
  for (const g of ["seg_sex", "sab", "dom"]) {
    const j = janelas[g];
    if (j === null || j === undefined) continue;
    const ini = emMinutos(j?.inicio), fim = emMinutos(j?.fim);
    if (ini === null || fim === null || fim <= ini) return false;
    algumaAberta = true;
  }
  return algumaAberta;
}
function exigirJanelas(janelas) {
  if (!janelasValidas(janelas)) throw new ConfiguracaoHorarioInvalida("janelas inválidas (formato HH:MM, fim > início, ao menos um dia aberto)");
  return janelas;
}
function janelaDoDia(diaSemana, janelas) {
  const j = janelas[NOMES_DIA[diaSemana]];
  return j ? { ini: emMinutos(j.inicio), fim: emMinutos(j.fim) } : null;
}

/** O instante cai dentro de uma janela permitida, no horário LOCAL da organização? (fim exclusivo) */
export function dentroDaJanelaLocal(instante, tz, janelas) {
  exigirJanelas(janelas);
  const p = partesLocais(instante, tz);
  const j = janelaDoDia(p.diaSemana, janelas);
  if (!j) return false;
  const min = p.hora * 60 + p.minuto;
  return min >= j.ini && min < j.fim;
}

/** Soma `k` dias ao calendário local (y/m/d) sem depender de horário: devolve {ano,mes,dia,diaSemana}. */
function maisDias(p, k) {
  const d = new Date(Date.UTC(p.ano, p.mes - 1, p.dia + k));
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate(), diaSemana: d.getUTCDay() };
}

/**
 * Próximo instante (>= `instante`) em que o envio é permitido. Já dentro da janela -> o próprio instante.
 * Ex.: sexta 18:30 locais, janela seg–sex 08–18 -> segunda 08:00 LOCAL da organização.
 * @returns {Date}
 */
export function proximoInstantePermitido(instante, tz, janelas, { limiteDias = 14 } = {}) {
  exigirJanelas(janelas);
  const agora = new Date(instante);
  const p = partesLocais(agora, tz);
  const hoje = janelaDoDia(p.diaSemana, janelas);
  const min = p.hora * 60 + p.minuto;
  if (hoje && min >= hoje.ini && min < hoje.fim) return agora;
  if (hoje && min < hoje.ini) return instanteDeLocal(tz, p.ano, p.mes, p.dia, Math.floor(hoje.ini / 60), hoje.ini % 60);
  for (let k = 1; k <= limiteDias; k++) {
    const d = maisDias(p, k);
    const j = janelaDoDia(d.diaSemana, janelas);
    if (j) return instanteDeLocal(tz, d.ano, d.mes, d.dia, Math.floor(j.ini / 60), j.ini % 60);
  }
  throw new ConfiguracaoHorarioInvalida("nenhuma janela aberta nos próximos dias");
}

/** Instante de FECHAMENTO da janela que contém `instante` (ou `null` se ele está fora de qualquer janela). */
export function fimDaJanelaLocal(instante, tz, janelas) {
  exigirJanelas(janelas);
  const p = partesLocais(instante, tz);
  const j = janelaDoDia(p.diaSemana, janelas);
  const min = p.hora * 60 + p.minuto;
  if (!j || min < j.ini || min >= j.fim) return null;
  return instanteDeLocal(tz, p.ano, p.mes, p.dia, Math.floor(j.fim / 60), j.fim % 60);
}

/** Início (00:00 local) do dia LOCAL que contém `instante`, como instante UTC — a fronteira da cota diária. */
export function inicioDoDiaLocal(instante, tz) {
  const p = partesLocais(instante, tz);
  return instanteDeLocal(tz, p.ano, p.mes, p.dia, 0, 0);
}

/** Início do PRÓXIMO dia local (00:00) — instante a partir do qual uma cota diária zera. */
export function inicioDoProximoDiaLocal(instante, tz) {
  const p = partesLocais(instante, tz);
  const d = maisDias(p, 1);
  return instanteDeLocal(tz, d.ano, d.mes, d.dia, 0, 0);
}

/** Inteiro determinístico em [0, modulo) derivado de sha256(chave). Sem aleatoriedade. */
export function inteiroDeterministico(chave, modulo) {
  if (!(modulo > 0)) return 0;
  const h = createHash("sha256").update(String(chave)).digest();
  return Number(h.readBigUInt64BE(0) % BigInt(Math.floor(modulo)));
}

/**
 * Jitter DETERMINÍSTICO e auditável: espalha os envios que caem na abertura da janela para que todas as
 * empresas não disparem exatamente às 08:00. offset = hash(chave) mod spread; spread = min(spreadMaxMs,
 * tempo restante da janela - 1 min), então o resultado NUNCA passa do fechamento. Mesmo evento -> mesmo horário.
 * @returns {Date}
 */
export function aplicarJitterNaJanela(instante, tz, janelas, chave, { spreadMaxMs = 30 * MIN } = {}) {
  const base = new Date(instante);
  const fim = fimDaJanelaLocal(base, tz, janelas);
  if (!fim) return base; // fora da janela: não há como aplicar jitter "dentro" dela
  const restante = fim.getTime() - base.getTime() - MIN;
  const spread = Math.max(0, Math.min(spreadMaxMs, restante));
  return new Date(base.getTime() + inteiroDeterministico(chave, spread));
}

/**
 * Primeiro horário de envio para um evento: se `agora` já está na janela, envia já (sem jitter);
 * senão, abertura da próxima janela + jitter determinístico.
 * @returns {{instante: Date, adiado: boolean}}
 */
export function proximoHorarioDeEnvio(agora, tz, janelas, chave, opcoes = {}) {
  const alvo = proximoInstantePermitido(agora, tz, janelas);
  if (alvo.getTime() === new Date(agora).getTime()) return { instante: alvo, adiado: false };
  return { instante: aplicarJitterNaJanela(alvo, tz, janelas, chave, opcoes), adiado: true };
}

export const _constantes = Object.freeze({ MIN, DIA_MS });
