// Financeiro 2.0 (contas a pagar, conciliação de saídas, juros, painel, DRE gerencial…) — é O Financeiro: vale para TODA organização.
// Não existe mais "versão antiga" para quem tem o módulo financeiro liberado: a empresa que for desbloqueada já entra no modelo novo.
// Continua valendo TUDO o que já existia: módulo financeiro ligado na empresa e na unidade + concessão explícita do perfil (gate).
//
// Chave de emergência (opcional): FINANCEIRO_2_DESLIGADO_ORGANIZACOES = UUIDs separados por vírgula. Só serve para DESLIGAR o 2.0 numa
// organização específica (ex.: incidente). Ausente ou vazia = ninguém desligado. Entradas inválidas são ignoradas (nunca desligam nada).
// A variável antiga FINANCEIRO_2_ORGANIZACOES (lista de liberadas) não tem mais efeito.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Organizações em que o 2.0 foi desligado por emergência (normalizada; entradas inválidas ignoradas). */
export function organizacoesFinanceiro2Desligadas(env = process.env) {
  return new Set(String(env?.FINANCEIRO_2_DESLIGADO_ORGANIZACOES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => UUID.test(s)));
}

/** O Financeiro 2.0 está ativo para esta organização? (padrão: sim, salvo chave de emergência.) */
export function financeiro2Habilitado(organizacaoId, env = process.env) {
  return typeof organizacaoId === "string" && UUID.test(organizacaoId) && !organizacoesFinanceiro2Desligadas(env).has(organizacaoId.toLowerCase());
}
