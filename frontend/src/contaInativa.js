// Conta BLOQUEADA no meio do uso (403 com `details.codigo = "CONTA_INATIVA"` vindo do requireAuth).
//
// Diferente do 401 (login caiu) e do 409 (contexto caiu, a pessoa pode reentrar): aqui a conta não pode mais entrar de
// jeito nenhum, então NÃO há reentrada automática — a Central encerra o contexto, tira os dados da tela e vai para o login
// (ver app.js, `app:conta-inativa`). Só este código dispara o fluxo; qualquer outro 403 (falta de permissão) segue como erro comum.
export const CODIGO_CONTA_INATIVA = "CONTA_INATIVA";

export const ehContaInativa = (status, corpo) => status === 403 && (corpo?.codigo || corpo?.details?.codigo) === CODIGO_CONTA_INATIVA;

/** Avisa a Central (uma vez por vez): quem escuta encerra tudo e mostra o login. */
export function avisarContaInativa(mensagem) {
  document.dispatchEvent(new CustomEvent("app:conta-inativa", { detail: mensagem }));
}
