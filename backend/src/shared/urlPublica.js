// Origem PÚBLICA confiável para links enviados a pessoas (convite da Central, convite de usuário).
//
// Nunca derivada de cabeçalhos da requisição em produção (Host/X-Forwarded-* são manipuláveis): vem de APP_URL_PUBLICA,
// que precisa ser https:// e só origem (sem caminho, query ou fragmento). Sem ela, em produção NÃO há link (quem chama
// responde "indisponível"); fora de produção (desenvolvimento/testes) cai na origem da própria requisição.
import { ApiError } from "./ApiError.js";

/** Origem configurada válida (`https://host[:porta]`) ou null. */
export function origemConfigurada(env = process.env) {
  const bruto = String(env.APP_URL_PUBLICA ?? "").trim();
  if (!bruto) return null;
  let u;
  try { u = new URL(bruto); } catch { return null; }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && env.NODE_ENV !== "production")) return null;
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash || u.username || u.password) return null;
  return u.origin;
}

/**
 * Origem para montar links. Produção: SÓ a configurada (ou 503). Fora dela: a configurada, senão a da requisição.
 * @param {{ env?: object, req?: import("express").Request }} p
 */
export function origemParaLinks({ env = process.env, req = null } = {}) {
  const conf = origemConfigurada(env);
  if (conf) return conf;
  if (env.NODE_ENV === "production") {
    throw new ApiError(503, "Links de convite indisponíveis: a URL pública da plataforma não está configurada.", { codigo: "URL_PUBLICA_AUSENTE" });
  }
  return req ? `${req.protocol}://${req.get("host")}` : "";
}
