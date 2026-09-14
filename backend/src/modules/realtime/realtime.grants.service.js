// Grants efêmeros de canal Realtime (public.realtime_channel_grants) —
// capacidade TEMPORÁRIA e derivada, nunca uma segunda fonte de autorização.
// A fonte da verdade continua sendo `sessoes_contexto` + `requireContexto`:
// esta função só deve ser chamada DEPOIS que `requireContexto` já validou
// sessão/contexto/revogação/expiração/pid (ver realtime.controller.js).
//
// Por que não um JWT customizado: o projeto usa JWT Signing Keys assimétricas
// (ES256) para o Supabase Auth — confirmado via o JWKS público antes de
// decidir esta arquitetura. Assinar um token próprio exigiria tocar a
// infraestrutura de Auth (chave privada, Legacy Secret, signing keys), o que
// foi explicitamente descartado. O frontend continua usando o JWT normal da
// sessão (setAuth com o access_token de sempre) — este módulo só garante que
// exista, no banco, um grant vivo para os tópicos daquele contexto, que a
// policy de `realtime.messages` (migration 080) consulta.
//
// ISOLAMENTO ENTRE ABAS/CONTEXTOS: a chave do grant é (sessao_contexto_id,
// topico) — NUNCA (usuario_id, topico). Cada troca de unidade/empresa emite
// uma sessoes_contexto.id NOVA (ver sessao.service.js#criarSessao), então
// duas abas (ou duas trocas na mesma aba) nunca compartilham a mesma linha:
// renovar/limpar o grant de uma sessão jamais apaga o de outra.
import { supabase } from "../../config/supabase.js";
import { config } from "../../config/env.js";
import { topicosAutorizados } from "./realtime.topicos.js";

const TABELA = "realtime_channel_grants";

/**
 * Cria/estende os grants dos tópicos autorizados do contexto ATUAL e limpa,
 * SÓ desta mesma sessão de contexto, qualquer grant de um tópico que não
 * esteja mais entre os autorizados. Nunca toca `sessao_contexto_id` de outra
 * sessão — nem da mesma conta, nem da mesma aba num ciclo anterior.
 *
 * @param {object} params
 * @param {string} params.usuarioId          auth.users.id — a CONTA (req.user.id)
 * @param {string} params.sessaoContextoId   sessoes_contexto.id da sessão ATUAL (req.acesso.sessionId)
 * @param {string} params.organizacaoId      req.tenant.organizacaoId — nunca do body/query
 * @param {string|null} [params.unidadeId]   req.tenant.unidadeId — nunca do body/query
 * @param {number} [params.validadeS]
 * @param {{db?: typeof supabase}} [deps]     injeção só para teste
 * @returns {Promise<{topicos: string[], expiraEm: string, validadeS: number}>}
 */
export async function renovarGrantsRealtime(
  { usuarioId, sessaoContextoId, organizacaoId, unidadeId = null, validadeS = config.realtimeCredentialTtlS },
  { db = supabase } = {},
) {
  const topicos = topicosAutorizados({ organizacaoId, unidadeId });
  const expiraEmDate = new Date(Date.now() + validadeS * 1000);
  const expiraEm = expiraEmDate.toISOString();

  if (topicos.length) {
    const linhas = topicos.map((topico) => ({
      sessao_contexto_id: sessaoContextoId, topico, usuario_id: usuarioId, expira_em: expiraEm,
    }));
    const { error } = await db.from(TABELA).upsert(linhas, { onConflict: "sessao_contexto_id,topico" });
    if (error) throw new Error(`Falha ao renovar grants Realtime: ${error.message}`);
  }

  // Limpeza — só desta sessão. Tópico que a sessão tinha antes e não tem mais
  // (hoje não acontece em uso normal, já que troca de contexto sempre cria
  // uma sessao_contexto_id nova — fica como defesa em profundidade).
  let del = db.from(TABELA).delete().eq("sessao_contexto_id", sessaoContextoId);
  if (topicos.length) del = del.not("topico", "in", `(${topicos.join(",")})`);
  const { error: erroLimpeza } = await del;
  if (erroLimpeza) throw new Error(`Falha ao limpar grants obsoletos: ${erroLimpeza.message}`);

  return { topicos, expiraEm, validadeS };
}

/**
 * Remove TODOS os grants das sessões de contexto informadas — chamado pelo
 * ÚNICO lugar que revoga `sessoes_contexto` (sessao.service.js#revogarSessoes),
 * no mesmo instante em que a(s) sessão(ões) é(são) marcada(s) revogada_em.
 * Isso é o que torna a revogação de um contexto (troca de unidade/empresa,
 * logout) IMEDIATA para o Realtime, em vez de depender só do TTL do grant.
 *
 * Nunca lança para quem chamou tratar como falha de negócio — ver o
 * try/catch em revogarSessoes: uma falha aqui só significa que o grant
 * expira pelo TTL normal em vez de já ter sido removido na hora.
 * @param {string[]} sessaoContextoIds
 * @param {{db?: typeof supabase}} [deps]
 */
export async function removerGrantsDeSessoes(sessaoContextoIds, { db = supabase } = {}) {
  if (!sessaoContextoIds?.length) return;
  const { error } = await db.from(TABELA).delete().in("sessao_contexto_id", sessaoContextoIds);
  if (error) throw new Error(`Falha ao remover grants de sessões revogadas: ${error.message}`);
}
