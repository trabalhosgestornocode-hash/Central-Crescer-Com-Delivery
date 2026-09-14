// Bus de eventos do Realtime — a ÚNICA porta de entrada para um módulo de
// tela reagir a um evento de domínio. Nenhum módulo deve importar/conhecer o
// RealtimeManager ou a API do Supabase Realtime: ele só chama
// `registrarInteresse` uma vez, com uma condição de relevância (tipicamente
// "este é o meu contexto atual E minha tela está montada agora") e o que
// fazer quando o evento bate — normalmente a MESMA função de repintar que o
// módulo já usa depois de salvar (ver a auditoria: carregarConteudo,
// renderPadmAtual, pintarRelatorios, etc.).
//
// Responsabilidades daqui, e só daqui:
//   * DEDUPLICAÇÃO — dois broadcasts muito próximos da mesma entidade/versão
//     viram UMA chamada aos interessados, nunca uma cascata de refetches.
//   * ROTEAMENTO — cada interessado só é chamado se `relevante(evento)`
//     disser que sim; um módulo fechado/inativo simplesmente não reage
//     (Fase J: "módulo não está aberto? não faz nada agora — o próximo fetch
//     normal já vem com dado atualizado").
//   * ISOLAMENTO DE FALHA — um interessado que lança não derruba os outros
//     (mesmo padrão de contextoEscopo.js#resetarEscopoDeContexto).
//
// Etapa 1: existe e está testado, mas nenhum módulo de tela ainda chama
// `registrarInteresse` (a ligação do Dashboard iFood é a Etapa 2).

/** @typedef {{eventos: Set<string>|null, relevante: (evento: object) => boolean, aoReceber: (evento: object) => void}} Interesse */

/** @type {Interesse[]} */
const interesses = [];

/**
 * @param {{eventos?: string[]|null, relevante?: (evento: object) => boolean, aoReceber: (evento: object) => void}} opts
 *   `eventos` — lista de tipos que interessam (ex.: EVENTOS_DASHBOARD_IFOOD.*);
 *   `null`/omitido = qualquer tipo (raro; normalmente usado só para reagir à
 *   resincronização, que não é um evento de domínio específico).
 *   `relevante` — filtro adicional por CONTEXTO ATUAL do módulo (unidade,
 *   mês, "a minha tela está montada agora?"). Default: sempre relevante.
 * @returns {() => void} função para cancelar o registro (útil em testes/hot-reload)
 */
export function registrarInteresse({ eventos = null, relevante = () => true, aoReceber }) {
  if (typeof aoReceber !== "function") throw new Error("registrarInteresse exige aoReceber(evento)");
  const item = { eventos: eventos ? new Set(eventos) : null, relevante, aoReceber };
  interesses.push(item);
  return () => {
    const i = interesses.indexOf(item);
    if (i > -1) interesses.splice(i, 1);
  };
}

const JANELA_DEDUP_MS = 500;
/** @type {Map<string, number>} chave de dedup -> timestamp da última vez aceita */
let ultimosAceitos = new Map();

function chaveDedup(evento) {
  return [evento.tipo, evento.organizacaoId, evento.unidadeId ?? "", evento.entidadeId ?? "", evento.versao ?? ""].join("|");
}

/** Limpeza oportunista — evita crescer pra sempre numa sessão longa. */
function limparAntigos(agora) {
  if (ultimosAceitos.size <= 500) return;
  for (const [chave, t] of ultimosAceitos) {
    if (agora - t > JANELA_DEDUP_MS * 4) ultimosAceitos.delete(chave);
  }
}

/**
 * Chamado pelo RealtimeManager para cada mensagem recebida de um canal (ou
 * para o sinal sintético de resincronização). NUNCA chamado diretamente por
 * um módulo de tela.
 * @param {object} evento — `{tipo, organizacaoId, unidadeId, entidadeId?, versao?, ...}`
 * @returns {boolean} `false` quando foi descartado por deduplicação
 */
export function receberEvento(evento) {
  const agora = Date.now();
  const chave = chaveDedup(evento);
  const ultimo = ultimosAceitos.get(chave);
  if (ultimo != null && agora - ultimo < JANELA_DEDUP_MS) return false;
  ultimosAceitos.set(chave, agora);
  limparAntigos(agora);

  for (const item of interesses) {
    if (item.eventos && !item.eventos.has(evento.tipo)) continue;
    let ok = false;
    try { ok = item.relevante(evento); } catch (e) { console.error("[realtime] falha ao avaliar relevância de", evento.tipo, e); }
    if (!ok) continue;
    try { item.aoReceber(evento); } catch (e) { console.error("[realtime] um interessado falhou ao reagir a", evento.tipo, e); }
  }
  return true;
}

/** Só para teste: número de interesses registrados agora. */
export function _interessesAtivos() {
  return interesses.length;
}

/** Só para teste: zera interesses e o histórico de deduplicação. */
export function _resetParaTeste() {
  interesses.length = 0;
  ultimosAceitos = new Map();
}
