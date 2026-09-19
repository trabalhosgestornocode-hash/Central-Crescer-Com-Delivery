// Classificação de falhas Gateway -> Backend (Checkpoint C3.5-C.8.2).
//
// POR QUE EXISTE: até aqui toda falha de persistência/chamada ao backend era
// tratada igual, e o único jeito de "lidar" com ela era abortar — foi o que
// deixou o Gateway em DISCONNECTED para sempre depois de um HTTP 413 (e o que
// deixaria qualquer 5xx transitório, ex.: um deploy do backend, fazer o mesmo).
// A decisão "vale tentar de novo?" precisa ser EXPLÍCITA e por classe:
//
//   transitoria — a mesma requisição pode dar certo mais tarde sem ninguém
//                 mexer em nada (backend reiniciando, 5xx, timeout, rede).
//                 Retry COM backoff e LIMITE.
//   permanente  — repetir a mesma requisição não ajuda (HMAC recusado, payload
//                 acima do teto estrutural, fencing/geração obsoletos, erro de
//                 cifra local, 4xx de contrato). NUNCA entra em loop: é logado e
//                 o retry daquele snapshot para. Quem depende do resultado
//                 (reconnect) decide o fail-safe.
//
// Só devolve um vocabulário FECHADO (`classe`, `causa`, `status`) — nunca a
// mensagem do erro, o corpo da resposta nem qualquer dado do payload (o
// payload aqui é auth state cifrado: nada dele pode ir para o log).

import { CODIGOS } from "./errors.js";

/**
 * @typedef {'transitoria'|'permanente'} ClasseFalha
 * @typedef {{classe: ClasseFalha, causa: string, status: number|null}} ClassificacaoFalha
 */

/**
 * Falha de PERSISTÊNCIA do auth state, já classificada. É o que
 * `garantirPersistido()` devolve (rejeitando) para quem coordena a reconexão.
 * Só carrega o vocabulário fechado — nunca `message` do erro original.
 */
export class AuthPersistenciaError extends Error {
  /**
   * @param {ClasseFalha} classe
   * @param {string} causa
   * @param {{status?: number|null}} [extra]
   */
  constructor(classe, causa, { status = null } = {}) {
    super(`auth_state.persistir falhou: ${classe}/${causa}`);
    this.name = "AuthPersistenciaError";
    this.classe = classe;
    this.causa = causa;
    this.status = status;
  }
}

const permanente = (causa, status = null) => ({ classe: "permanente", causa, status });
const transitoria = (causa, status = null) => ({ classe: "transitoria", causa, status });

/**
 * Classifica um erro lançado por `backendClient` (GatewayError) ou pelo
 * próprio adapter. NUNCA lança.
 *
 * Detalhe importante: `GatewayError.status` é sempre o status do PRÓPRIO
 * Gateway (503 para CODIGOS.INDISPONIVEL) — o status HTTP devolvido pelo
 * BACKEND fica em `detalheInterno.status` (ver backendClient.js#chamar).
 *
 * Desconhecido -> transitória: com o retry LIMITADO, o pior caso é gastar o
 * orçamento de tentativas; já classificar como permanente por engano deixaria
 * de tentar algo que se resolveria sozinho (exatamente o erro do incidente).
 *
 * @param {any} e
 * @returns {ClassificacaoFalha}
 */
export function classificarFalhaBackend(e) {
  if (e instanceof AuthPersistenciaError) return { classe: e.classe, causa: e.causa, status: e.status };
  if (e?.leaseStale) return permanente("lease_stale", 409);
  if (e?.authSessionStale) return permanente("auth_session_stale", 409);

  const status = Number.isInteger(e?.detalheInterno?.status) ? e.detalheInterno.status : null;
  if (status !== null) {
    if (status === 401 || status === 403) return permanente("hmac_recusado", status);
    // 413 é ESTRUTURAL: o payload passou do teto que o backend aceita. Repetir
    // o mesmo corpo nunca resolve — sem loop; quem opera precisa agir.
    if (status === 413) return permanente("payload_grande_demais", status);
    if (status === 408 || status === 425 || status === 429) return transitoria(`http_${status}`, status);
    if (status >= 500) return transitoria("http_5xx", status);
    // 404 numa rota que existe = backend ainda sem a rota (rolling deploy) —
    // transitório por natureza; o orçamento LIMITADO de retry cobre o caso de
    // ser configuração errada de verdade.
    if (status === 404) return transitoria("http_404", status);
    return permanente("http_4xx", status);
  }

  // Timeout (AbortController), rede inalcançável, DNS: o backendClient devolve
  // INDISPONIVEL sem status HTTP.
  if (e?.codigo === CODIGOS.INDISPONIVEL) return transitoria("rede_ou_timeout");
  return transitoria("desconhecido");
}
