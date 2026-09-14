// Emissor central de eventos de domínio para o Realtime — a ÚNICA porta de
// saída que um service pode usar para propagar uma alteração. Nenhum service
// deve chamar a API do Supabase Realtime diretamente: é essa indireção que
// permite trocar o transporte no futuro (ex.: sair de Broadcast HTTP para um
// relay próprio) sem tocar em nenhuma regra de negócio.
//
// Contrato (ver a auditoria da Etapa A e a aprovação da Etapa 1):
//   service de domínio → operação concluída (INSERT/UPDATE/DELETE com sucesso)
//   → emitirEventoRealtime({tipo, organizacaoId, unidadeId, ...})
//   → publica nos tópicos autorizados daquele contexto
//
// FALHA DE EMISSÃO NUNCA VIRA FALHA DE NEGÓCIO
//   A gravação já foi confirmada pelo banco antes de qualquer service chegar
//   a chamar esta função. Se o Broadcast falhar (rede, Supabase fora do ar,
//   variável ausente), a função ENGOLE o erro — só loga — e devolve
//   normalmente. Quem chamou não deve (e hoje não pode, pela assinatura)
//   saber se a emissão funcionou. Consistência entre clientes, nesse caso,
//   fica por conta da reconexão/resync do RealtimeManager (Fase T/S da
//   auditoria) — Realtime acelera a propagação, nunca é a fonte da verdade.
//
// ⚠️ Etapa 1: esta função existe e está testada, mas NENHUM service ainda a
// chama (a ligação com o Dashboard iFood é a Etapa 2, por decisão explícita
// do escopo aprovado).
//
// CONTRATO REST CONFIRMADO (auditoria pré-Etapa-2, contra a doc oficial —
// apps/docs/content/guides/realtime/broadcast.mdx do repo supabase/supabase):
//   Endpoint de UMA mensagem: POST /realtime/v1/api/broadcast/{topic}/events/{event}?private=true
//   Header: só `apikey` (a doc não mostra `Authorization`); corpo = o payload cru.
// Existe também um endpoint de LOTE (POST /realtime/v1/api/broadcast, corpo
// `{messages:[{topic,event,payload}]}`), mas a doc oficial NÃO mostra, em
// nenhum exemplo, como marcar uma mensagem do lote como privada — só o
// endpoint de uma mensagem documenta `?private=true` de forma inequívoca.
// Como isto é a fronteira de segurança do canal (uma mensagem que "escapasse"
// pro plano público seria recebida por qualquer cliente, autorizado ou não),
// preferimos o endpoint de UMA mensagem — mais uma chamada HTTP por tópico
// (no máximo 2, empresa+unidade), mas sem ambiguidade nenhuma sobre `private`.
// Se uma confirmação futura (teste contra um projeto real) mostrar que o lote
// aceita `private` por mensagem com segurança, dá pra voltar a agrupar.
import { config } from "../../config/env.js";
import { topicosAutorizados } from "./realtime.topicos.js";

const NOME_EVENTO = "evento_dominio";

/**
 * @param {string} topico
 * @param {object} payload
 * @param {typeof fetch} fetchImpl — injetável só para teste; produção usa o `fetch` global.
 */
async function publicarBroadcast(topico, payload, fetchImpl) {
  const url = `${config.supabaseUrl}/realtime/v1/api/broadcast/${encodeURIComponent(topico)}/events/${encodeURIComponent(NOME_EVENTO)}?private=true`;
  const resposta = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: config.supabaseServiceKey },
    body: JSON.stringify(payload),
  });
  if (!resposta.ok) {
    throw new Error(`Broadcast recusado (${resposta.status}) no tópico ${topico}.`);
  }
}

/**
 * Emite um evento de domínio para os tópicos autorizados do contexto — NUNCA
 * lança. Chame depois da escrita confirmada (commit/sucesso), nunca antes.
 *
 * @param {object} evento
 * @param {string} evento.tipo  taxonomia de domínio, ex.: "dashboard_ifood.lancamento_atualizado" — nunca genérico ("changed"/"updated")
 * @param {string} evento.organizacaoId
 * @param {string|null} [evento.unidadeId]
 * @param {Record<string, unknown>} [evento.resto]  campos mínimos do payload (Fase F: ids/datas/versão, nunca valor monetário/nome de pessoa)
 * @param {{fetchImpl?: typeof fetch, log?: (msg: string, err: unknown) => void}} [opts]  injeção pra teste
 */
export async function emitirEventoRealtime(
  { tipo, organizacaoId, unidadeId = null, ...resto },
  { fetchImpl = fetch, log = (msg, err) => console.error(msg, err?.message ?? err) } = {},
) {
  if (!tipo || !organizacaoId) {
    log("[realtime] emitirEventoRealtime chamado sem tipo/organizacaoId — ignorado", { tipo, organizacaoId });
    return;
  }
  const topicos = topicosAutorizados({ organizacaoId, unidadeId });
  if (!topicos.length) return;

  const payload = { tipo, organizacaoId, unidadeId, ...resto, emitidoEm: new Date().toISOString() };

  const resultados = await Promise.allSettled(
    topicos.map((topico) => publicarBroadcast(topico, payload, fetchImpl)),
  );
  for (const r of resultados) {
    if (r.status === "rejected") {
      log(`[realtime] falha ao emitir "${tipo}" (gravação já estava confirmada — ignorando)`, r.reason);
    }
  }
}
