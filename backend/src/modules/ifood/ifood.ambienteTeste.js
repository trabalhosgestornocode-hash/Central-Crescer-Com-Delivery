// Fonte ÚNICA de "qual banco é o de teste" para a integração iFood, e a trava
// de RUNTIME do modo centralizado temporário (CENTRALIZED_TEST).
//
// POR QUE EXISTE
//   O app centralizado de teste (Teste (C)) é só um ambiente técnico para
//   desenvolver as APIs de negócio. Ele NUNCA pode rodar contra o banco de
//   produção nem no serviço de produção (Render). Além da trava de subida
//   (scripts/ifoodHomologGuard.mjs), o próprio provider consulta esta função
//   na hora de obter o token — assim, mesmo que alguém suba o backend "na mão"
//   com IFOOD_CENTRALIZED_TEST_MODE=true, o modo se recusa a funcionar.
//
// Só identificadores públicos aqui (ref de projeto Supabase). Nenhum segredo.

export const PROJETO_TESTE_REF = "wiqqsxnysbzhcrzrrean";      // "teste-multiempresarial"
export const PROJETO_PRODUCAO_REF = "uqybgauuxcrqzquultfu";   // "Crescer Com Delivery"

/** `ref` do projeto Supabase a partir da SUPABASE_URL (`https://<ref>.supabase.co`), ou null. */
export function refDaSupabaseUrl(url) {
  try {
    const host = new URL(String(url ?? "").trim()).host;
    return host.endsWith(".supabase.co") ? host.slice(0, -".supabase.co".length) : null;
  } catch {
    return null;
  }
}

/**
 * O modo centralizado de teste pode operar neste processo?
 * Só se TODAS as condições valerem:
 *   * SUPABASE_URL é o projeto de TESTE (produção e qualquer outro são recusados);
 *   * o processo NÃO está no Render (`RENDER` definido);
 *   * NODE_ENV não é 'production'.
 * @param {Record<string, string|undefined>} env normalmente `process.env`
 * @returns {{ok: boolean, motivos: string[]}}
 */
export function centralizadoTestePermitido(env) {
  const motivos = [];
  const ref = refDaSupabaseUrl(env.SUPABASE_URL);
  if (ref === PROJETO_PRODUCAO_REF) motivos.push("SUPABASE_URL é o projeto de PRODUÇÃO");
  else if (ref !== PROJETO_TESTE_REF) motivos.push(`SUPABASE_URL não é o projeto de teste (ref: ${ref ?? "ausente/inválido"})`);
  if (env.RENDER) motivos.push("processo rodando no Render");
  if (String(env.NODE_ENV ?? "").toLowerCase() === "production") motivos.push("NODE_ENV=production");
  return { ok: motivos.length === 0, motivos };
}
