// Feature flag do Financeiro 2.0 (contas a pagar, conciliação de saídas, juros) — FAIL-CLOSED.
// Liga SÓ para as organizações listadas explicitamente em FINANCEIRO_2_ORGANIZACOES (UUIDs separados por vírgula).
// Ausente, vazia ou com valor inválido = desligado para todas. Não existe "todas" (curinga): cada empresa entra por decisão própria.
// Continua valendo TUDO o que já existia: módulo financeiro ligado na empresa e na unidade + concessão explícita do perfil (gate).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lista de organizações liberadas (normalizada). Entradas inválidas são ignoradas (nunca liberam nada). */
export function organizacoesFinanceiro2(env = process.env) {
  return new Set(String(env?.FINANCEIRO_2_ORGANIZACOES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => UUID.test(s)));
}

/** O Financeiro 2.0 está liberado para esta organização? */
export function financeiro2Habilitado(organizacaoId, env = process.env) {
  return typeof organizacaoId === "string" && UUID.test(organizacaoId) && organizacoesFinanceiro2(env).has(organizacaoId.toLowerCase());
}
