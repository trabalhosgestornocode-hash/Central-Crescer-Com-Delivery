// VERIFICADOR REAL DE SEGUNDO FATOR (Execução 10) — porta `verificarAssinatura` da prova de autenticação do Financeiro v2
// (src/modules/financeiro-v2/integracao/provaDeAutenticacao.js), apoiada no PRÓPRIO provedor de identidade (Supabase Auth).
//
// Por que pelo provedor e não por uma chave local: o backend comum não guarda segredo de assinatura de JWT; quem confirma
// que o token é autêntico, não expirou e pertence a uma sessão viva é o Auth do projeto (`auth.getUser(token)` consulta o
// servidor de autenticação). Só depois disso o conteúdo do token é lido — e a conta devolvida pelo provedor tem de ser a
// mesma do `sub` do token.
//
// O que NÃO conta como prova (decidido na prova, não aqui): `aal2` sozinho, o `iat` do token (um token renovado agora
// carrega fator antigo), senha, e-mail, link mágico, PIN da plataforma. A recência vem do carimbo do método de segundo
// fator em `amr` (segundos), dentro de 10 minutos.
import { criarVerificadorDeMfa } from "../financeiro-v2/index.js";

/** Lê o payload de um JWT SEM confiar nele (a autenticidade é decidida pelo provedor antes). */
export function lerPayloadSemConfiar(token) {
  try {
    const partes = String(token ?? "").split(".");
    if (partes.length !== 3) return null;
    const p = JSON.parse(Buffer.from(partes[1], "base64url").toString("utf8"));
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
}

/**
 * @param {{obterUsuario:(token:string)=>Promise<{id:string}|null>}} p `obterUsuario` = validação do token no provedor
 *        (ex.: (t) => supabase.auth.getUser(t).then((r) => (r.error ? null : r.data.user)))
 */
export function verificarAssinaturaPeloProvedor({ obterUsuario }) {
  if (typeof obterUsuario !== "function") throw new Error("Financeiro v2: verificador de MFA sem a validação do provedor.");
  return async (token) => {
    let usuario = null;
    try { usuario = await obterUsuario(token); } catch { usuario = null; }
    if (!usuario || typeof usuario.id !== "string") return null;
    const payload = lerPayloadSemConfiar(token);
    if (!payload || typeof payload.sub !== "string" || payload.sub.toLowerCase() !== usuario.id.toLowerCase()) return null;
    return payload;
  };
}

/** Verificador de MFA pronto para o adaptador e para o gateway. */
export function criarMfaPeloProvedor({ obterUsuario, relogio }) {
  return criarVerificadorDeMfa({ verificarAssinatura: verificarAssinaturaPeloProvedor({ obterUsuario }), ...(relogio ? { relogio } : {}) });
}
