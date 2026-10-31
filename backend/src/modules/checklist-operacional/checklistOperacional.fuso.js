// D-15 — fuso por unidade: REGRA ÚNICA, usada pelo Dashboard 2.0 (períodos, lista de pedidos, Ficha 360°), pelo fechamento
// diário e pelo agendador. Por isso tela, PDF, Excel, prévia do WhatsApp e fechamento sempre caem no MESMO intervalo.
//
//   * Data de corte (OPERACIONAL_FUSO_UNIDADE_CORTE=AAAA-MM-DD): DESLIGADA por padrão. Sem ela, tudo segue no fuso da plataforma
//     (comportamento anterior, idêntico).
//   * Com o corte: uma competência/período cuja data inicial é ≥ corte usa o fuso IANA da unidade (`unidades.timezone`), se houver;
//     antes do corte, o fuso da plataforma. O fuso de um período depende SÓ da data inicial — o fechamento da competência C e o
//     Dashboard "C a C" decidem igual.
//   * Fechamentos já gravados guardam `fuso`/`fuso_origem` da versão e nunca são reprocessados automaticamente.
//   * O Checklist AO VIVO não usa esta regra (continua no fuso da plataforma — decisão anterior).
import { FUSO_NEGOCIO } from "./checklistOperacional.calc.js";
import { resolverPeriodo, hojeNoFuso } from "./checklistOperacional.periodos.js";

const DATA = /^\d{4}-\d{2}-\d{2}$/;

export function lerCorteFuso(env = process.env) {
  const v = String(env.OPERACIONAL_FUSO_UNIDADE_CORTE ?? "").trim();
  return DATA.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null;
}

/** Fuso IANA "Região/Cidade" que o runtime reconhece (nunca offset, nunca "UTC" solto). */
export function fusoValido(tz) {
  if (typeof tz !== "string" || !/^[A-Za-z]+\/[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0); return true; } catch { return false; }
}

/** Regra única: `data` (AAAA-MM-DD) ≥ corte e unidade com fuso válido → fuso da unidade; senão o da plataforma. */
export function resolverFuso({ fusoUnidade = null, data = null, corte = lerCorteFuso() } = {}) {
  if (!corte || !fusoValido(fusoUnidade) || !data || data < corte) return { fuso: FUSO_NEGOCIO, origem: "padrao_plataforma" };
  return { fuso: fusoUnidade, origem: "unidade" };
}

/** Período do Dashboard no fuso certo: decide pela data INICIAL calculada no fuso da unidade (mesma regra do fechamento). */
export function resolverPeriodoDaUnidade({ filtro = {}, agoraMs, fusoUnidade = null, corte = lerCorteFuso() }) {
  const args = { periodo: filtro.periodo || "hoje", inicio: filtro.inicio, fim: filtro.fim, agoraMs };
  if (corte && fusoValido(fusoUnidade)) {
    const p = resolverPeriodo({ ...args, fuso: fusoUnidade });
    if (p.ok && p.atual.inicio >= corte) return { periodo: p, fuso: fusoUnidade, origem: "unidade" };
  }
  return { periodo: resolverPeriodo({ ...args, fuso: FUSO_NEGOCIO }), fuso: FUSO_NEGOCIO, origem: "padrao_plataforma" };
}

/** "Hoje" operacional da unidade (no fuso que a regra manda usar para hoje). */
export function hojeDaUnidade({ agoraMs, fusoUnidade = null, corte = lerCorteFuso() }) {
  const candidato = fusoValido(fusoUnidade) ? hojeNoFuso(agoraMs, fusoUnidade) : null;
  const { fuso, origem } = resolverFuso({ fusoUnidade, data: candidato, corte });
  return { hoje: hojeNoFuso(agoraMs, fuso), fuso, origem };
}

/** Fuso para exibir um instante (ex.: horários da Ficha 360°): o do dia operacional daquele instante. */
export function fusoDoInstante({ instanteMs, fusoUnidade = null, corte = lerCorteFuso() }) {
  if (!Number.isFinite(instanteMs) || !fusoValido(fusoUnidade)) return resolverFuso({ corte: null });
  return resolverFuso({ fusoUnidade, data: hojeNoFuso(instanteMs, fusoUnidade), corte });
}
