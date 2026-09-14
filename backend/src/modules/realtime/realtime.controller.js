import { asyncHandler } from "../../shared/asyncHandler.js";
import { ApiError } from "../../shared/ApiError.js";
import { renovarGrantsRealtime } from "./realtime.grants.service.js";

/**
 * Deriva os parâmetros do grant EXCLUSIVAMENTE do que `requireContexto`/
 * `requireAuth` já colocaram em `req` — nunca de `req.body`/`req.query`.
 * Função pura e separada de propósito: é o ponto exato que garante que um
 * cliente não pode "escolher" outra organização/unidade/sessão só porque
 * mandou algo diferente no corpo da requisição.
 * @param {import('express').Request} req
 */
export function parametrosGrantDoRequest(req) {
  return {
    usuarioId: req.user.id,
    sessaoContextoId: req.acesso.sessionId,
    organizacaoId: req.tenant.organizacaoId,
    unidadeId: req.tenant.unidadeId,
  };
}

// Montado atrás de `requireContexto` (ver routes.js) — exatamente como todo
// outro módulo de tenant. Um contexto revogado/expirado nunca chega até
// aqui — cai antes, no próprio requireContexto, com 409 (mesmo
// comportamento de qualquer outra rota de tenant).
//
// Devolve só `{topicos, expiraEm, validadeS}` — SEM token nenhum. O cliente
// continua autenticado no Realtime com o JWT normal da sessão Supabase Auth
// (sb.realtime.setAuth(access_token) — ver realtimeManager.js); a
// autorização por tópico é o grant que esta chamada acabou de gravar em
// `public.realtime_channel_grants`, consultado pela policy de
// `realtime.messages` (migration 080).
export const credencial = asyncHandler(async (req, res) => {
  if (!req.tenant?.organizacaoId) {
    // Defesa em profundidade: não deveria ser alcançável (requireContexto já
    // teria recusado antes), mas gravar um grant sem organização seria um
    // canal sem dono — recusa explicitamente em vez de confiar no chamador.
    throw ApiError.forbidden("Contexto inválido para Realtime.");
  }

  let renovado;
  try {
    renovado = await renovarGrantsRealtime(parametrosGrantDoRequest(req));
  } catch (e) {
    // Falha ao gravar o grant (banco fora do ar, etc.) — nunca finge sucesso.
    throw new ApiError(503, e.message || "Realtime indisponível neste momento.");
  }

  res.json({ data: { topicos: renovado.topicos, expiraEm: renovado.expiraEm, validadeS: renovado.validadeS } });
});
