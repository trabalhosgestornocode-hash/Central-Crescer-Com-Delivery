// Validadores de entrada da integração iFood — garantia em runtime na
// fronteira HTTP (mesmo espírito de shared/validar.js e dos outros módulos).

import * as v from "../../shared/validar.js";
import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";
import { appTypesDoOAuth } from "./ifoodToken.service.js";

/**
 * appType: 'analytics' | 'financial', + 'order' em homologação ou quando o app de Order está configurado
 * (IFOOD_ORDER_CLIENT_*). Fonte única: appTypesDoOAuth(). Erro de domínio (não 400 genérico).
 */
export function validarAppType(valor) {
  const s = typeof valor === "string" ? valor.trim().toLowerCase() : "";
  if (!appTypesDoOAuth().includes(s)) throw ifoodErro(IFOOD_ERROS.IFOOD_APP_TYPE_INVALIDO);
  return s;
}

/** sessionId da sessão OAuth (uuid). */
export function validarSessionId(valor) {
  return v.uuid(valor, "sessionId");
}

/**
 * authorizationCode: string opaca fornecida pelo Portal do Parceiro iFood.
 * Só limpa espaços e limita tamanho — o formato exato é do iFood, não nosso.
 */
export function validarAuthorizationCode(valor) {
  const s = typeof valor === "string" ? valor.trim() : "";
  if (s.length < 4) throw ifoodErro(IFOOD_ERROS.IFOOD_OAUTH_CODIGO_INVALIDO, { mensagem: "Informe o código de autorização fornecido pelo iFood." });
  if (s.length > 512) throw ifoodErro(IFOOD_ERROS.IFOOD_OAUTH_CODIGO_INVALIDO);
  return s;
}

/** merchantId vindo do frontend (blocos D/E) — SEMPRE revalidado na API depois. */
export function validarMerchantId(valor) {
  const s = typeof valor === "string" ? valor.trim() : "";
  if (s.length < 1 || s.length > 128) throw ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_NAO_ENCONTRADO);
  return s;
}
