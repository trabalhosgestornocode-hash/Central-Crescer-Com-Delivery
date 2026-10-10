// Renovação AUTOMÁTICA do Context Token — SÓ do perfil de exibição (`display_operator`), computador ligado à TV.
//
// A loja opera ~17 h por dia; o Context Token vale 8 h. Em vez de esticar a validade de todo mundo, o perfil de
// exibição pode RENOVAR o próprio contexto, de forma controlada:
//
//   * preventiva: só dentro de uma janela antes do vencimento (o navegador agenda; o SERVIDOR confere);
//   * ancorada na AUTENTICAÇÃO: o limite absoluto (padrão 20 h) conta a partir do momento do LOGIN no Supabase
//     (claim `amr[].timestamp` do JWT), não a partir do contexto. Se contasse a partir do contexto, a reentrada
//     automática (que existe e não pede senha) recomeçaria a contagem e o limite nunca valeria;
//   * fail-closed: sem o carimbo de autenticação no JWT NÃO há renovação (a TV segue com os 8 h de sempre);
//   * nunca renova para mais do que falta até o limite: a última renovação é CURTA, e depois dela é preciso entrar
//     de novo com a senha.
//
// Funções PURAS (relógio injetado) — testadas, inclusive numa jornada simulada de 17 h.
import { VALIDADE_PADRAO_S } from "./contextToken.js";
import { carimboDeAutenticacao } from "./carimboAutenticacao.js";

export { carimboDeAutenticacao };

const NUM = (v, padrao, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : padrao;
};

/**
 * Política (segundos). Lida do ambiente a cada chamada para os testes poderem apertar os prazos; tudo é limitado a
 * faixas seguras (o limite absoluto nunca passa de 24 h, a janela nunca passa de metade da validade do contexto).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function lerPoliticaRenovacao(env = process.env) {
  return Object.freeze({
    /** Limite ABSOLUTO desde a autenticação (login). Padrão 20 h = expediente de 17 h + margem. */
    limiteAbsolutoS: NUM(env.RENOVACAO_EXIBICAO_LIMITE_S, 20 * 3600, 600, 24 * 3600),
    /** O servidor só renova quando falta MENOS que isto para o contexto vencer (antes disso: "cedo", sem mudar nada). */
    janelaS: NUM(env.RENOVACAO_EXIBICAO_JANELA_S, 2 * 3600, 60, Math.floor(VALIDADE_PADRAO_S / 2)),
    /** O contexto ANTIGO continua valendo só por isto depois da troca (cobre requisições em voo; não reaproveitável). */
    gracaS: NUM(env.RENOVACAO_EXIBICAO_GRACA_S, 90, 5, 600),
    /** Menos que isto até o limite: não vale emitir contexto novo — é hora de autenticar de novo. */
    minimoS: NUM(env.RENOVACAO_EXIBICAO_MINIMO_S, 60, 5, 600),
    /** Tolerância para relógio do emissor do JWT adiantado. */
    desvioS: 300,
  });
}

/**
 * MFA exigido para o perfil de exibição? DORMENTE por padrão (mesmo modelo de config/seguranca.js#MFA): só liga com
 * MFA_ENFORCE_EXIBICAO=true, depois de a conta da TV ter o segundo fator cadastrado — senão a flag a trancaria para
 * fora. Ligada, vale para ENTRAR e para RENOVAR (JWT precisa estar em aal2).
 * @param {NodeJS.ProcessEnv} [env]
 */
export const mfaExigidoParaExibicao = (env = process.env) => env.MFA_ENFORCE_EXIBICAO === "true";

/**
 * Quanto falta até o limite absoluto e se ainda dá para ter contexto.
 * @returns {{ acao: "ok"|"indisponivel"|"reautenticar", restanteLimiteMs: number|null, limiteEm: number|null, validadeS: number|null }}
 */
export function limiteDaAutenticacao({ agoraMs, authEmMs, politica = lerPoliticaRenovacao(), validadePadraoS = VALIDADE_PADRAO_S }) {
  if (!Number.isFinite(authEmMs) || authEmMs <= 0) return { acao: "indisponivel", restanteLimiteMs: null, limiteEm: null, validadeS: null };
  if (authEmMs > agoraMs + politica.desvioS * 1000) return { acao: "indisponivel", restanteLimiteMs: null, limiteEm: null, validadeS: null }; // carimbo "do futuro"
  const limiteEm = authEmMs + politica.limiteAbsolutoS * 1000;
  const restanteLimiteMs = limiteEm - agoraMs;
  if (restanteLimiteMs <= politica.minimoS * 1000) return { acao: "reautenticar", restanteLimiteMs, limiteEm, validadeS: null };
  return { acao: "ok", restanteLimiteMs, limiteEm, validadeS: Math.floor(Math.min(validadePadraoS, restanteLimiteMs / 1000)) };
}

/**
 * Decisão do SERVIDOR para um pedido de renovação.
 *   cedo          -> ainda falta mais que a janela: nada muda (idempotente)
 *   renovar       -> pode emitir contexto novo com `validadeS`
 *   reautenticar  -> limite absoluto atingido: precisa de login novo
 *   indisponivel  -> sem carimbo confiável de autenticação: não renova (comportamento de 8 h)
 * @returns {{ acao: "cedo"|"renovar"|"reautenticar"|"indisponivel", validadeS: number|null, limiteEm: number|null, restanteMs: number }}
 */
export function decidirRenovacao({ agoraMs, expiraEmMs, authEmMs, politica = lerPoliticaRenovacao(), validadePadraoS = VALIDADE_PADRAO_S }) {
  const restanteMs = expiraEmMs - agoraMs;
  const lim = limiteDaAutenticacao({ agoraMs, authEmMs, politica, validadePadraoS });
  if (lim.acao !== "ok") return { acao: lim.acao, validadeS: null, limiteEm: lim.limiteEm, restanteMs };
  if (restanteMs > politica.janelaS * 1000) return { acao: "cedo", validadeS: null, limiteEm: lim.limiteEm, restanteMs };
  return { acao: "renovar", validadeS: lim.validadeS, limiteEm: lim.limiteEm, restanteMs };
}
