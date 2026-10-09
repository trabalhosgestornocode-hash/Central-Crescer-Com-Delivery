// Checklist Operacional — SINCRONIZAÇÃO com o servidor (sem DOM; relógio e rede injetáveis).
//
// Uma única porta para "buscar o resumo de novo", seja qual for o motivo:
//   * aviso do Realtime (pedido da unidade mudou) ou resincronização depois de reconectar;
//   * polling de segurança (o intervalo que o servidor indica — continua valendo mesmo sem Realtime);
//   * a tela voltou a ficar visível.
//
// GARANTIAS
//   * no máximo UMA consulta em voo; o que chegar no meio vira UMA consulta logo depois (nunca uma cascata);
//   * avisos em rajada são agrupados numa janela curta, com um atraso aleatório pequeno — várias TVs da mesma
//     unidade não consultam o servidor no mesmo milissegundo;
//   * resposta mais antiga nunca sobrescreve uma mais nova (ordem de envio e `servidorEm`);
//   * `parar()` (troca de unidade, saída da tela) invalida timers e respostas em voo: nada de um contexto antigo
//     é aplicado depois;
//   * falha: recuo exponencial a partir do intervalo normal, com teto — a tela volta sozinha quando a rede volta.
//
// O Realtime só ANTECIPA a consulta; sem ele, o polling mantém a tela correta. A fonte da verdade é sempre o
// endpoint de resumo.

/** Janela para agrupar avisos em rajada (ms) e atraso aleatório máximo somado a ela (ms). */
export const JANELA_AVISO_MS = 400;
export const ESPALHAMENTO_MAX_MS = 750;
export const RECUO_MAXIMO_MS = 120_000;

/**
 * O aviso é desta tela? Organização E unidade do contexto atual. A resincronização do canal da unidade também
 * vale (reconectou: os avisos perdidos na queda não chegam mais — consulta o estado atual).
 * @param {{tipo: string, organizacaoId?: string, unidadeId?: string|null}} evento
 * @param {{organizacaoId: string|null|undefined, unidadeId: string|null|undefined}} ctx
 */
export function avisoDaMinhaUnidade(evento, ctx) {
  if (!evento || !ctx?.organizacaoId || !ctx?.unidadeId) return false;
  if (evento.organizacaoId && evento.organizacaoId !== ctx.organizacaoId) return false;
  return evento.unidadeId === ctx.unidadeId;
}

/**
 * @param {{
 *   buscar: () => Promise<any>,                  resposta do endpoint ({ data })
 *   aplicar: (resposta: any) => void,             resposta aceita (mais nova que a última aplicada)
 *   falhou: (erro: any) => void,
 *   intervaloMs: number,
 *   relogio?: { setTimeout: Function, clearTimeout: Function },
 *   aleatorio?: () => number,
 * }} p
 */
export function criarSincronizador({ buscar, aplicar, falhou, intervaloMs, relogio = globalThis, aleatorio = Math.random }) {
  let ativo = false;
  let geracao = 0;          // muda a cada iniciar/parar: resposta de geração antiga é descartada
  let emVoo = false;
  let pendente = false;     // pedido de consulta que chegou com outra em voo
  let seq = 0;              // ordem de envio
  let ultimoSeqAplicado = 0;
  let ultimoServidorMs = -Infinity;
  let falhas = 0;
  let intervalo = intervaloMs;
  let timerPolling = null;
  let timerAviso = null;
  const estatisticas = { consultas: 0, aplicadas: 0, descartadas: 0, agrupadas: 0 };

  const limpar = (t) => { if (t != null) relogio.clearTimeout(t); return null; };

  function agendarPolling() {
    timerPolling = limpar(timerPolling);
    if (!ativo) return;
    const atraso = falhas ? Math.min(RECUO_MAXIMO_MS, intervalo * 2 ** Math.min(falhas - 1, 3)) : intervalo;
    const g = geracao;
    timerPolling = relogio.setTimeout(() => { timerPolling = null; if (g === geracao) consultar(); }, atraso);
  }

  function consultar() {
    if (!ativo) return;
    if (emVoo) { pendente = true; estatisticas.agrupadas += 1; return; }
    timerPolling = limpar(timerPolling);
    const g = geracao;
    const meu = ++seq;
    emVoo = true;
    estatisticas.consultas += 1;
    Promise.resolve().then(buscar).then(
      (resposta) => {
        if (g !== geracao) return;
        const servidor = Date.parse(resposta?.data?.servidorEm);
        if (meu < ultimoSeqAplicado || (Number.isFinite(servidor) && servidor < ultimoServidorMs)) { estatisticas.descartadas += 1; return; }
        ultimoSeqAplicado = meu;
        if (Number.isFinite(servidor)) ultimoServidorMs = servidor;
        falhas = 0;
        estatisticas.aplicadas += 1;
        aplicar(resposta);
      },
      (erro) => {
        if (g !== geracao) return;
        falhas += 1;
        falhou(erro);
      },
    ).finally(() => {
      if (g !== geracao) return;
      emVoo = false;
      if (pendente) { pendente = false; consultar(); } else agendarPolling();
    });
  }

  return {
    /** Liga e consulta já. */
    iniciar() { if (ativo) return; ativo = true; geracao += 1; consultar(); },
    /** Desliga: timers cancelados, resposta em voo será descartada. Idempotente. */
    parar() {
      ativo = false; geracao += 1; emVoo = false; pendente = false;
      timerPolling = limpar(timerPolling); timerAviso = limpar(timerAviso);
    },
    /** Aviso do Realtime / resincronização: agrupa a rajada e espalha as TVs no tempo. */
    avisar() {
      if (!ativo) return;
      if (timerAviso != null) { estatisticas.agrupadas += 1; return; }
      const g = geracao;
      timerAviso = relogio.setTimeout(() => { timerAviso = null; if (g === geracao) consultar(); }, JANELA_AVISO_MS + Math.floor(aleatorio() * ESPALHAMENTO_MAX_MS));
    },
    /** Consulta já (ex.: a tela voltou a ficar visível). */
    agora() { if (ativo) consultar(); },
    /** O servidor pode mudar o intervalo do polling (`atualizarEmS`). Vale a partir do próximo agendamento. */
    definirIntervalo(ms) { if (Number.isFinite(ms) && ms >= 10_000) intervalo = ms; },
    get ativo() { return ativo; },
    get emVoo() { return emVoo; },
    get falhas() { return falhas; },
    get estatisticas() { return { ...estatisticas }; },
  };
}

/**
 * Texto do modo de atualização ao lado do horário da sincronização. "tempo real" exige as DUAS coisas:
 *   * o servidor diz que há avisos (`tempoReal.avisosAtivos`: emissão ligada E recebimento ao vivo) — canal
 *     assinado sem avisos sendo emitidos não é tempo real;
 *   * o canal privado da unidade está assinado — avisos emitidos sem canal conectado também não.
 * Fora disso, a tela está no polling de segurança e diz isso.
 */
export function textoModoAtualizacao(statusCanal, atualizarEmS, avisosAtivos) {
  if (avisosAtivos === true && statusCanal === "SUBSCRIBED") return "tempo real";
  return `atualiza a cada ${atualizarEmS ?? 30} s`;
}
