// Hook de resolução (node:module.register): redireciona APENAS `src/config/supabase.js` para um módulo que delega a
// `globalThis.__supabaseFalso`. Permite rodar o código REAL dos serviços sobre um banco em memória sem vm.SourceTextModule
// (instável no Node 20) e sem tocar em código de produção. Cada arquivo de teste roda em processo próprio, então o redirecionamento
// não vaza para outras suítes.
const FONTE = "export const supabase = { from: (...a) => globalThis.__supabaseFalso.from(...a), rpc: (...a) => globalThis.__supabaseFalso.rpc(...a) };";
const URL_FALSA = `data:text/javascript,${encodeURIComponent(FONTE)}`;

export async function resolve(specifier, context, nextResolve) {
  const r = await nextResolve(specifier, context);
  if (r.url.endsWith("/src/config/supabase.js")) return { url: URL_FALSA, shortCircuit: true };
  return r;
}
