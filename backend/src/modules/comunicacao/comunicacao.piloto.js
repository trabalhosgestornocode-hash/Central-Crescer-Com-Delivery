// ALLOWLIST DO PILOTO — Checkpoint H.4-A. Defesa em profundidade para a
// primeira ativação controlada do canal: NUNCA substitui nenhum gate
// existente (modo, habilitado, consentimento, opt-out, vínculo, cooldown,
// rate-limit, horário) — é uma camada A MAIS, aplicada como o ÚLTIMO check
// de comunicacao.policy.js#avaliarEnvio. Mesmo se `modo=NORMAL` + outra
// organização for habilitada por engano + uma mensagem for criada, só um
// telefone desta lista pode efetivamente sair.
//
// Função PURA (env é parâmetro injetável, mesmo espírito de `deps` no resto
// do módulo) — quem lê `process.env` de verdade é o chamador em
// comunicacao.alertas.service.js, ANTES de montar o snapshot do Policy
// Engine (que continua sem I/O, ver comunicacao.policy.js). Nunca lança:
// uma allowlist malformada é tratada como VAZIA (fail-closed silencioso +
// log — nunca derruba o ciclo inteiro por causa de uma env mal escrita).
//
// Nunca loga o E.164 completo — reaproveita mascararTelefone() de
// comunicacao.contatos.repo.js (nenhuma segunda função de máscara).

import { mascararTelefone } from "./comunicacao.contatos.repo.js";

const RE_E164 = /^\+[1-9][0-9]{7,14}$/;

/** Mesmo padrão exato de COMUNICACAO_WORKER_ENABLED/MB_PLAYWRIGHT_ENABLED: só a string exata "true" liga. */
export function pilotoHabilitado(env = process.env) {
  return env.COMUNICACAO_PILOTO_ENABLED === "true";
}

/**
 * Lê e valida COMUNICACAO_PILOTO_TELEFONES_E164 (lista separada por vírgula).
 * Ausente/vazia -> lista vazia. QUALQUER entrada que não seja E.164 válido
 * invalida a lista INTEIRA (nunca aceita parcialmente uma allowlist
 * malformada) — loga um aviso (sem o valor bruto) e devolve vazio.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function lerAllowlistPiloto(env = process.env) {
  const bruto = env.COMUNICACAO_PILOTO_TELEFONES_E164;
  if (bruto === undefined || bruto === null || String(bruto).trim() === "") return [];
  const itens = String(bruto).split(",").map((s) => s.trim()).filter(Boolean);
  for (const item of itens) {
    if (!RE_E164.test(item)) {
      console.error(`[comunicacao.piloto] COMUNICACAO_PILOTO_TELEFONES_E164 contém uma entrada que não é E.164 válido (formato: "+DDI...", ${item.length} caractere(s)) — allowlist tratada como VAZIA (fail-closed) até ser corrigida.`);
      return [];
    }
  }
  return itens;
}

/**
 * Gate opt-in: com `COMUNICACAO_PILOTO_ENABLED` desligado (padrão — estado
 * atual de produção), esta função devolve `true` para QUALQUER telefone —
 * a camada extra do piloto simplesmente não existe fora da janela do
 * piloto, e nunca vira uma restrição permanente depois que o piloto
 * terminar. SÓ com o piloto ligado é que passa a exigir presença explícita
 * na allowlist (lista ausente/vazia/malformada -> ninguém passa; fora da
 * lista -> bloqueado; na lista -> passa). Nunca lança.
 * @param {string|null|undefined} telefoneE164
 * @param {NodeJS.ProcessEnv} [env]
 */
export function telefoneAutorizadoNoPiloto(telefoneE164, env = process.env) {
  if (!pilotoHabilitado(env)) return true;
  if (!telefoneE164) return false;
  const lista = lerAllowlistPiloto(env);
  if (!lista.length) return false;
  return lista.includes(telefoneE164);
}

/** Só para logs/erros seguros — nunca o E.164 cru. */
export { mascararTelefone };
