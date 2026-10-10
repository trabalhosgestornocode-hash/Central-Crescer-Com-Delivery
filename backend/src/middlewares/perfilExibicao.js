// Perfil de EXIBIÇÃO (`display_operator`) — bloqueio "nega tudo, exceto a lista".
//
// O computador da TV da loja entra com uma conta que só pode ver o Checklist Operacional da unidade. Cada rota
// do tenant já exige a sua permissão (e este perfil só tem `checklist.visualizar`), mas isso depende de TODA rota
// nova lembrar de exigir uma. Este middleware é a segunda trava, independente: com o papel de exibição, só as
// rotas da lista abaixo respondem; QUALQUER outra recebe 403 antes de chegar ao módulo — inclusive uma rota que
// alguém esqueça de proteger no futuro. Não depende de menu escondido no frontend.
//
// Montado em routes.js logo depois de `requireContexto` (precisa de `req.acesso`). Só atua sobre o papel de
// exibição; os demais papéis passam intactos. A conferência é por MÉTODO + CAMINHO EXATO (sem prefixo, sem
// curinga): o que não está na lista é negado.
import { ApiError } from "../shared/ApiError.js";
import { PAPEL_EXIBICAO } from "../shared/permissoes.js";

/**
 * Rotas do tenant (relativas ao router do tenant, sem `/api/v1`) que o perfil de exibição pode chamar.
 *   * resumo do Checklist — o próprio painel;
 *   * credencial de Realtime — o gerenciador de canais da Central a pede em qualquer contexto; para este perfil
 *     ela só autoriza o canal da UNIDADE (ver realtime.topicos.js).
 */
export const ROTAS_PERFIL_EXIBICAO = Object.freeze([
  Object.freeze({ metodo: "GET", caminho: "/checklist-operacional/resumo" }),
  Object.freeze({ metodo: "POST", caminho: "/realtime/credencial" }),
]);

/** Caminho comparável: sem barra final e em minúsculas (o Express casa rotas sem diferenciar caixa nem barra final). */
const normalizar = (caminho) => String(caminho ?? "").toLowerCase().replace(/\/+$/, "") || "/";

/** A rota é permitida ao perfil de exibição? Função pura. */
export function rotaPermitidaAoPerfilExibicao(metodo, caminho) {
  const m = String(metodo ?? "").toUpperCase();
  const c = normalizar(caminho);
  // HEAD cai no handler do GET no Express: tem a mesma permissão do GET.
  const metodoEfetivo = m === "HEAD" ? "GET" : m;
  return ROTAS_PERFIL_EXIBICAO.some((r) => r.metodo === metodoEfetivo && r.caminho === c);
}

/** Middleware (depois de `requireContexto`). */
export function restringirPerfilExibicao(req, _res, next) {
  if (req.acesso?.papel !== PAPEL_EXIBICAO) return next();
  if (rotaPermitidaAoPerfilExibicao(req.method, req.path)) return next();
  return next(ApiError.forbidden("Permissão insuficiente para esta ação."));
}
