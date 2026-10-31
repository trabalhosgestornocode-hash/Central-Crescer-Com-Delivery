// ORQUESTRADOR da consolidação por telefone — DESLIGADO por padrão e NÃO conectado ao worker/agendador (a política de envio só muda com autorização).
// Recebe tudo por INJEÇÃO (leitura de estado, envio, finalização): não importa banco, provider, fila, política nem cotas. Define a ordem segura:
//   1. RELÊ o estado de cada bloco NA HORA do envio (alterações posteriores de permissão valem: revogação, opt-out, pausa, desabilitação);
//      falha ao ler o estado = bloco fora (fail-closed) e devolvido ao fluxo individual;
//   2. consolida só os blocos ainda autorizados (comunicacao.consolidacao.js) — nada de bloco revogado no texto;
//   3. UM envio por mensagem consolidada, com chave de idempotência derivada do conjunto (`cons:<chave>`) — mensagem de bloco único mantém a
//      chave ORIGINAL, idêntica à de hoje;
//   4. resultado do envio decide TODOS os componentes juntos:
//        * enviado            → todos SENT com o mesmo provider id (falha ao finalizar um não gera reenvio: é registrada);
//        * provado pré-envio  → NADA é finalizado e os ids voltam (`devolvidos`) para o fluxo individual — nenhum aviso se perde;
//        * dúvida (timeout, 5xx, conexão cortada) → todos DELIVERY_UNKNOWN e NUNCA reenvio (mesma regra do envio de hoje);
//   5. falha de UM grupo (telefone) não interrompe os outros.
// O chamador (futuro, com autorização) segue responsável por claim/fencing/cotas; aqui só se decide o QUE sai e como cada componente termina.
import { consolidarPorTelefone, LIMITE_PADRAO } from "./comunicacao.consolidacao.js";

/** Desligada por padrão: só COMUNICACAO_CONSOLIDACAO_POR_TELEFONE=true a liga (e, mesmo ligada, nada a chama sem a integração autorizada). */
export const consolidacaoLigada = (env = process.env) => String(env?.COMUNICACAO_CONSOLIDACAO_POR_TELEFONE ?? "").trim().toLowerCase() === "true";

export const RESULTADO = Object.freeze({ SENT: "SENT", DELIVERY_UNKNOWN: "DELIVERY_UNKNOWN" });

const preEnvio = (e) => e?.preEnvio === true && !e?._timeout;

/**
 * @param {{
 *   itens: Array<object>,                                   // itens de consolidarPorTelefone (sem `estado`: ele é relido aqui)
 *   lerEstado: (item: object) => Promise<object>,           // estado ATUAL do bloco (registroAtivo, categoriaHabilitada, optOutContato, ...)
 *   enviar: (p: {contatoWhatsappId: string, texto: string, idempotencyKey: string, ids: string[]}) => Promise<{providerMessageId: string}>,
 *   finalizar: (id: string, r: {resultado: string, providerMessageId?: string, consolidadaEm?: string}) => Promise<void>,
 *   agora?: () => Date, maxCaracteres?: number
 * }} p
 */
export async function enviarConsolidado({ itens, lerEstado, enviar, finalizar, agora = () => new Date(), maxCaracteres = LIMITE_PADRAO }) {
  const saida = { enviadas: [], devolvidos: [], incertos: [], excluidos: [], falhasAoFinalizar: [] };
  // 1) estado FRESCO de cada bloco (nunca o de quando foi agendado)
  const frescos = [];
  for (const it of itens ?? []) {
    try { frescos.push({ ...it, autorizado: undefined, estado: await lerEstado(it) }); }
    catch { saida.excluidos.push({ id: it?.id ?? null, motivo: "ESTADO_INDISPONIVEL" }); saida.devolvidos.push({ ids: [it?.id].filter(Boolean), motivo: "ESTADO_INDISPONIVEL" }); }
  }
  // 2) só o que ainda está autorizado
  const { mensagens, excluidos } = consolidarPorTelefone(frescos, { maxCaracteres, agora: agora() });
  saida.excluidos.push(...excluidos);
  const porId = new Map(frescos.map((i) => [i.id, i]));
  // 3–5) um envio por mensagem; um grupo falhar não derruba os outros
  for (const m of mensagens) {
    const unico = m.blocos === 1;
    const idempotencyKey = unico ? (porId.get(m.ids[0])?.idempotencyKey ?? m.ids[0]) : `cons:${m.chave}`;
    let r;
    try { r = await enviar({ contatoWhatsappId: m.contatoWhatsappId, texto: m.texto, idempotencyKey, ids: m.ids }); }
    catch (e) {
      if (preEnvio(e)) { saida.devolvidos.push({ ids: m.ids, motivo: "FALHA_PRE_ENVIO" }); continue; }
      for (const id of m.ids) {
        try { await finalizar(id, { resultado: RESULTADO.DELIVERY_UNKNOWN, consolidadaEm: m.chave }); }
        catch { saida.falhasAoFinalizar.push({ id, resultado: RESULTADO.DELIVERY_UNKNOWN }); }
      }
      saida.incertos.push({ ids: m.ids, chave: m.chave });
      continue;                                   // dúvida ⇒ nunca reenviar
    }
    for (const id of m.ids) {
      try { await finalizar(id, { resultado: RESULTADO.SENT, providerMessageId: r?.providerMessageId, consolidadaEm: unico ? undefined : m.chave }); }
      catch { saida.falhasAoFinalizar.push({ id, resultado: RESULTADO.SENT }); }   // já saiu: registrar, JAMAIS reenviar
    }
    saida.enviadas.push({ chave: m.chave, ids: m.ids, providerMessageId: r?.providerMessageId ?? null, blocos: m.blocos });
  }
  return saida;
}
