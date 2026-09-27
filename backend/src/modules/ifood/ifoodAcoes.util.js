// Utilidades das ações de pedido (Checkpoint D): sanitização da auditoria e classificação de falhas.

import { IFOOD_ERROS } from "./ifood.errors.js";

const CHAVE_SENSIVEL = /token|secret|authorization|password|senha|refresh|verifier|authorizationcode|apikey|api_key|cookie/i;

/**
 * Cópia PROFUNDA sem nenhuma chave sensível (token, segredo, Authorization, refresh, code verifier...),
 * com strings truncadas e profundidade limitada. Usada em tudo que vai para `ifood_pedido_acoes`/`ifood_disputas`.
 */
export function sanitizarParaAuditoria(valor, profundidade = 0) {
  if (valor === null || valor === undefined) return null;
  if (profundidade > 6) return "[profundidade]";
  if (typeof valor === "string") return valor.length > 500 ? `${valor.slice(0, 500)}…` : valor;
  if (typeof valor !== "object") return valor;
  if (Array.isArray(valor)) return valor.slice(0, 50).map((v) => sanitizarParaAuditoria(v, profundidade + 1));
  const out = {};
  for (const [k, v] of Object.entries(valor)) {
    if (CHAVE_SENSIVEL.test(k)) continue;
    out[k] = sanitizarParaAuditoria(v, profundidade + 1);
  }
  return out;
}

/** Mensagem de erro segura para gravar (curta; nunca o corpo bruto). */
export const mensagemSegura = (e) => String(e?.message ?? e ?? "erro").replace(/Bearer\s+\S+/gi, "Bearer ***").slice(0, 300);

/**
 * O que a falha de uma AÇÃO MUTANTE significa para o estado do pedido.
 *   'incerto'   — timeout / rede / 5xx / resposta ilegível: o iFood PODE ter processado. NÃO repetir às cegas: aguardar o evento oficial.
 *   'definitivo'— o iFood respondeu recusando (400/401/403/404/409/422) ou pediu calma (429): a ação NÃO foi executada.
 */
export function classificarFalhaDeAcao(e) {
  const c = e?.codigo;
  if (c === IFOOD_ERROS.IFOOD_INDISPONIVEL || c === IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA || c === IFOOD_ERROS.IFOOD_CANCELADO) return "incerto";
  if (!c) return "incerto";                                   // erro inesperado (rede etc.): trata como incerto
  return "definitivo";
}
