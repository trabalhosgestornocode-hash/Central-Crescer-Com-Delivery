// INTEGRAÇÃO da consolidação por telefone com o envio do D-1 — DESLIGADA por padrão e NÃO conectada ao worker.
//
// Este módulo é o PROTOCOLO de um lote já reivindicado (`claimJobs`), escrito contra PORTAS que espelham as fases reais do pipeline
// (`processarJobReivindicado`): avaliar (portões da política, sem efeito) → reservar (capacidade atômica; nasce o attempt) → enviar → finalizar.
// Não importa banco, provider, fila, política nem cotas, e NÃO altera o pipeline atual: as portas de produção (adaptadores) só existem depois da
// extração autorizada dos portões e da decisão sobre o teto por telefone (doc 37). Com a flag desligada, `processarLoteConsolidado` devolve
// `null` sem chamar nenhuma porta — o chamador segue o caminho de hoje, byte a byte.
//
// Garantias (provadas em test/comunicacao-consolidacao-integracao.test.js, inclusive por propriedade com cenários aleatórios):
//   * CONSERVAÇÃO: todo job recebido termina em EXATAMENTE um destino (enviado, terminal-da-avaliação, excluído-por-autorização, adiado/barrado na
//     reserva, devolvido ao fluxo individual, ou incerto) — nenhum relatório some, nenhum é enviado duas vezes;
//   * REVALIDAÇÃO NO ENVIO: avaliação (portões) → releitura da autorização → reserva, nessa ordem, ANTES de montar o texto; o texto só contém
//     blocos que passaram pelas três;
//   * CONTEÚDO COMPLETO, RASTREABILIDADE, ISOLAMENTO, IDEMPOTÊNCIA: herdados de comunicacao.consolidacao.js;
//   * FALHAS: pré-envio comprovado ⇒ cada componente volta via `finalizar(RETRY)` (o pipeline o reagenda — nada se perde); dúvida ⇒ todos
//     DELIVERY_UNKNOWN e NUNCA reenvio; falha ao finalizar um componente não reenvia; um grupo (telefone) falhar não derruba os outros.
import { consolidarPorTelefone, LIMITE_PADRAO } from "./comunicacao.consolidacao.js";

export const consolidacaoLigada = (env = process.env) => String(env?.COMUNICACAO_CONSOLIDACAO_POR_TELEFONE ?? "").trim().toLowerCase() === "true";

export const DESTINO = Object.freeze({
  ENVIADO: "ENVIADO", TERMINAL_NA_AVALIACAO: "TERMINAL_NA_AVALIACAO", EXCLUIDO_POR_AUTORIZACAO: "EXCLUIDO_POR_AUTORIZACAO",
  NAO_RESERVADO: "NAO_RESERVADO", FALHA_DEFINITIVA: "FALHA_DEFINITIVA", DEVOLVIDO_AO_FLUXO_INDIVIDUAL: "DEVOLVIDO_AO_FLUXO_INDIVIDUAL", INCERTO: "INCERTO", ERRO_INTERNO: "ERRO_INTERNO",
});
const preEnvio = (e) => e?.preEnvio === true && !e?._timeout;
const classificarPadrao = (e) => (preEnvio(e) ? "RETRY" : "DELIVERY_UNKNOWN");
const telefoneDe = (job) => job?.contato_id ?? null;

/**
 * @param {{
 *   jobs: Array<object>, env?: object, maxCaracteres?: number, agora?: () => Date,
 *   portas: {
 *     avaliar: (job) => Promise<{pronto: true, item: object} | {pronto: false, resultado: string}>,   // portões reais; terminal/adiado já gravado pelo pipeline
 *     relerEstado: (item) => Promise<object>,                                                          // autorização ATUAL do bloco
 *     reservar: (job, ctx: {consolidado: boolean, blocos: number, chave: (string|null)}) => Promise<{iniciado: true, tentativa: number} | {iniciado: false, resultado: string}>,
 *     enviar: (p: {contatoWhatsappId: string, texto: string, idempotencyKey: string, ids: string[]}) => Promise<{providerMessageId: (string|null)}>,
 *     finalizar: (job, tentativa: number, r: {resultado: ("SENT"|"RETRY"|"FAILED"|"DELIVERY_UNKNOWN"), erro?: Error, providerMessageId?: string, consolidadaEm?: string}) => Promise<void>,
 *   }
 * }} p
 * @returns {Promise<null | {destinos: Map<string, {destino: string, detalhe?: any}>, mensagens: Array<{chave: string, ids: string[], providerMessageId: (string|null)}>, individuais: object[]}>}
 */
export async function processarLoteConsolidado({ jobs, env = process.env, maxCaracteres = LIMITE_PADRAO, agora = () => new Date(), portas }) {
  if (!consolidacaoLigada(env)) return null;
  const classificar = portas?.classificarFalha ?? classificarPadrao;   // "RETRY" (pré-envio provado) | "FAILED" (definitiva) | "DELIVERY_UNKNOWN" (dúvida)                           // DESLIGADA: nenhuma porta é tocada
  const destinos = new Map(); const mensagens = []; const individuais = [];
  const marca = (id, destino, detalhe) => destinos.set(String(id), { destino, ...(detalhe === undefined ? {} : { detalhe }) });

  // grupos por telefone; telefone sem par (ou sem id) segue o caminho individual de hoje
  const porTelefone = new Map();
  for (const job of jobs ?? []) { const t = telefoneDe(job); if (!t) { individuais.push(job); continue; } (porTelefone.get(t) ?? porTelefone.set(t, []).get(t)).push(job); }
  for (const [, lista] of porTelefone) if (lista.length === 1) individuais.push(lista[0]);
  const grupos = [...porTelefone.values()].filter((l) => l.length > 1);

  for (const grupo of grupos) {
    // 1) portões reais de cada job (sem reservar); o terminal/adiado já foi gravado pelo próprio pipeline
    const prontos = [];
    for (const job of grupo) {
      try {
        const a = await portas.avaliar(job);
        if (a.pronto) prontos.push({ job, item: a.item }); else marca(job.id, DESTINO.TERMINAL_NA_AVALIACAO, a.resultado);
      } catch { marca(job.id, DESTINO.ERRO_INTERNO); }
    }
    // 2) autorização RELIDA agora (revogação/opt-out/pausa/escopo posteriores valem)
    const frescos = [];
    for (const p of prontos) {
      try { frescos.push({ ...p.item, autorizado: undefined, estado: await portas.relerEstado(p.item), __job: p.job }); }
      catch { marca(p.job.id, DESTINO.DEVOLVIDO_AO_FLUXO_INDIVIDUAL, "ESTADO_INDISPONIVEL"); individuais.push(p.job); }
    }
    const { excluidos: excl1 } = consolidarPorTelefone(frescos, { maxCaracteres, agora: agora() });
    const fora = new Set(excl1.map((e) => e.id));
    for (const e of excl1) marca(e.id, DESTINO.EXCLUIDO_POR_AUTORIZACAO, e.motivo);
    const autorizados = frescos.filter((f) => !fora.has(f.id));
    // 3) RESERVA de cada componente autorizado ANTES de montar o texto, MENSAGEM A MENSAGEM: todos os componentes de uma mensagem física levam a
    //    mesma chave, para o banco contá-los como UMA mensagem no teto do telefone (migration 140). Quem não reservar não entra no texto.
    const { mensagens: planejadas } = consolidarPorTelefone(autorizados.map((f) => ({ ...f, estado: undefined, autorizado: true })), { maxCaracteres, agora: agora() });
    const porIdAutorizado = new Map(autorizados.map((f) => [f.id, f]));
    for (const plano of planejadas) {
      const reservados = []; const fichas = new Map();
      for (const id of plano.ids) {
        const f = porIdAutorizado.get(id);
        try {
          const r = await portas.reservar(f.__job, { consolidado: plano.blocos > 1, blocos: plano.blocos, chave: plano.blocos > 1 ? plano.chave : null });
          if (r.iniciado) { reservados.push(f); fichas.set(f.id, r.tentativa); } else marca(f.id, DESTINO.NAO_RESERVADO, r.resultado);
        } catch { marca(f.id, DESTINO.ERRO_INTERNO); }
      }
      // 4) texto SÓ com quem passou pelas três etapas; um envio por mensagem consolidada
      const { mensagens: msgs, excluidos: excl2 } = consolidarPorTelefone(reservados.map((r) => ({ ...r, estado: undefined, autorizado: true })), { maxCaracteres, agora: agora() });
      for (const e of excl2) {           // reservou mas não cabe/é inválido: nunca se perde — volta para reenvio individual pelo pipeline
        const f = reservados.find((r) => r.id === e.id);
        try { await portas.finalizar(f.__job, fichas.get(f.id), { resultado: "RETRY" }); marca(f.id, DESTINO.DEVOLVIDO_AO_FLUXO_INDIVIDUAL, e.motivo); } catch { marca(f.id, DESTINO.ERRO_INTERNO); }
      }
      const porId = new Map(reservados.map((r) => [r.id, r]));
      for (const m of msgs) {
        const unico = m.blocos === 1;
        const idempotencyKey = unico ? (porId.get(m.ids[0]).idempotencyKey ?? m.ids[0]) : `cons:${m.chave}`;
        let r; let falha = null;
        try { r = await portas.enviar({ contatoWhatsappId: m.contatoWhatsappId, texto: m.texto, idempotencyKey, ids: m.ids }); } catch (e) { falha = e; }
        const resultado = falha ? classificar(falha) : "SENT";
        for (const id of m.ids) {
          const f = porId.get(id);
          try { await portas.finalizar(f.__job, fichas.get(id), { resultado, erro: falha ?? undefined, providerMessageId: r?.providerMessageId ?? undefined, consolidadaEm: unico ? undefined : m.chave }); } catch { /* já enviado: registrar, jamais reenviar */ }
          marca(id, resultado === "SENT" ? DESTINO.ENVIADO : resultado === "RETRY" ? DESTINO.DEVOLVIDO_AO_FLUXO_INDIVIDUAL : resultado === "FAILED" ? DESTINO.FALHA_DEFINITIVA : DESTINO.INCERTO, resultado === "SENT" ? { chave: m.chave } : resultado);
        }
        if (!falha) mensagens.push({ chave: m.chave, ids: m.ids, providerMessageId: r?.providerMessageId ?? null });
      }
    }
  }
  return { destinos, mensagens, individuais };
}
