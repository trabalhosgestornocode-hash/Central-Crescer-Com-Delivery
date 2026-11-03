// Feature flags da camada central Foody. Fail-closed: qualquer valor que não seja exatamente "true" = desligado;
// allowlist vazia = nenhuma unidade.
import { FLAG_HABILITADO, FLAG_AGENDADOR, FLAG_UNIDADES, FLAG_COMPARTILHAMENTO } from "./foody.constants.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ligada = (v) => String(v ?? "").trim().toLowerCase() === "true";

export function lerFlagsFoody(env = process.env) {
  const unidades = new Set(String(env[FLAG_UNIDADES] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => UUID.test(s)));
  return {
    habilitado: ligada(env[FLAG_HABILITADO]),
    agendadorHabilitado: ligada(env[FLAG_AGENDADOR]),
    compartilhamentoHabilitado: ligada(env[FLAG_COMPARTILHAMENTO]),
    unidades,
  };
}

/** A sincronização (manual ou agendada) só roda com a flag mestre ligada E a unidade na allowlist. */
export function unidadePermitida(env, unidadeId) {
  const f = lerFlagsFoody(env);
  return f.habilitado && f.unidades.has(String(unidadeId ?? "").toLowerCase());
}

/** O agendador exige as DUAS flags e allowlist não vazia. */
export function agendamentoPermitido(env = process.env) {
  const f = lerFlagsFoody(env);
  return f.habilitado && f.agendadorHabilitado && f.unidades.size > 0;
}

/** Distribuição da conexão compartilhada: exige a flag mestre E a de compartilhamento (a unidade titular segue na allowlist). */
export function compartilhamentoPermitido(env = process.env) {
  const f = lerFlagsFoody(env);
  return f.habilitado && f.compartilhamentoHabilitado;
}
