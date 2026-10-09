// Aviso "os pedidos desta unidade mudaram" — a ponte entre o processamento de Events/Order e o Realtime.
//
// Mesmo padrão de ifoodEventsEstado.js: um registro em memória, sem I/O, sem import de Realtime/rede.
// Quem processa (ifoodEvents.service, ifoodOrder.service) só chama `avisarPedidosAtualizados` DEPOIS de persistir;
// quem decide o transporte é o host que monta o Events (worker-ifood/runtime.js registra o Broadcast).
//
// INTERRUPTOR PRÓPRIO — IFOOD_CHECKLIST_REALTIME_ENABLED (padrão: DESLIGADO; só o literal "true" liga, a mesma
// regra das outras flags do iFood). Vale em DOIS pontos, para nenhum caminho publicar por fora dele:
//   1. o host só registra o destino com a flag ligada (sem flag nem o módulo de Realtime é carregado);
//   2. este ponto central confere a flag A CADA chamada — mesmo com um destino registrado, flag desligada = nada.
// A flag só controla o aviso. Polling, ACK, lease, OAuth e transições do Events não a leem.
//
// GARANTIAS (o aviso nunca interfere no processamento homologado):
//   * NUNCA lança e NUNCA é aguardado: agenda o envio e volta na hora — o ciclo, o ACK, o lease e o fencing do
//     Events não esperam rede nenhuma por causa dele;
//   * falha do destino (síncrona, rejeição, demora além do prazo) só vira log — nada é reprocessado;
//   * por unidade: no máximo UM envio em voo + UM pendente (rajada vira no máximo dois avisos, nunca uma fila);
//   * no processo todo: no máximo MAX_EM_VOO envios simultâneos; o excedente é descartado com log — a tela
//     recupera pelo polling de segurança (o mesmo vale se o processo encerrar antes de publicar);
//   * o aviso leva só organização + unidade: nenhum pedido, merchant, cliente ou valor. É um sinal de
//     invalidação — a tela consulta o resumo de novo, que continua sendo a fonte da verdade.

import { ifoodLog } from "./ifood.logsafe.js";

/** Tipo do evento de domínio no Realtime (espelhado em frontend/src/realtime/realtimeEvents.js). */
export const EVENTO_PEDIDOS_ATUALIZADOS = "ifood_pedido.estado_atualizado";
export const FLAG_CHECKLIST_REALTIME = "IFOOD_CHECKLIST_REALTIME_ENABLED";
/** Envios simultâneos no processo (todas as unidades). */
export const MAX_EM_VOO = 20;
/** Prazo de um envio: passou disso, a vaga é liberada mesmo sem resposta (o envio em si tem timeout próprio). */
export const PRAZO_ENVIO_MS = 10_000;

/** A emissão de avisos do Checklist está ligada NESTE processo? Ausente/qualquer outro valor = não. */
export function checklistRealtimeHabilitado(env = process.env) {
  return env?.[FLAG_CHECKLIST_REALTIME] === "true";
}

let destino = null;
const emVoo = new Set();      // chaves org|unidade com envio em andamento
const pendentes = new Map();  // chave -> tenant: mudou de novo durante o envio — reenvia UMA vez ao terminar
const contadores = { enviados: 0, falhas: 0, descartadosPorLimite: 0, agrupados: 0 };

/** Registrado pelo host do Events com a função que publica; `null` limpa. */
export function registrarDestinoAvisoPedidos(fn) { destino = typeof fn === "function" ? fn : null; }

const msgErro = (e) => String(e?.message ?? e).slice(0, 200);

/** Promise do destino com prazo: nunca deixa uma vaga presa por um envio que não termina. */
function comPrazo(promessa, ms) {
  let timer;
  const prazo = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`aviso sem resposta em ${ms} ms`)), ms);
    timer.unref?.();   // nunca segura o encerramento do processo
  });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(timer));
}

function enviar(chave, tenant, log) {
  const fn = destino;
  if (!fn) return;
  if (emVoo.size >= MAX_EM_VOO) {
    contadores.descartadosPorLimite += 1;
    log("warn", "pedidos.aviso_descartado_limite", { emVoo: emVoo.size });
    return;
  }
  emVoo.add(chave);
  contadores.enviados += 1;
  let promessa;
  try { promessa = Promise.resolve(fn(tenant)); } catch (e) { promessa = Promise.reject(e); }
  comPrazo(promessa, PRAZO_ENVIO_MS)
    .catch((e) => { contadores.falhas += 1; log("warn", "pedidos.aviso_falhou", { erro: msgErro(e) }); })
    .finally(() => {
      emVoo.delete(chave);
      const proximo = pendentes.get(chave);
      if (proximo) { pendentes.delete(chave); enviar(chave, proximo, log); }
    })
    .catch(() => {});   // defesa final: nada daqui vira rejeição não tratada
}

/**
 * Agenda um aviso por unidade afetada. Retorna na hora; nunca lança.
 * @param {Iterable<{organizacaoId: string, unidadeId: string}>} tenants
 * @param {{log?: Function, env?: object}} [opts]
 * @returns {number} quantas unidades foram avisadas ou ficaram pendentes (0 com a flag desligada ou sem destino)
 */
export function avisarPedidosAtualizados(tenants, { log = ifoodLog, env = process.env } = {}) {
  try {
    if (!checklistRealtimeHabilitado(env) || !destino) return 0;
    const unicos = new Map();
    for (const t of tenants ?? []) {
      if (typeof t?.organizacaoId === "string" && t.organizacaoId && typeof t?.unidadeId === "string" && t.unidadeId) {
        unicos.set(`${t.organizacaoId}|${t.unidadeId}`, { organizacaoId: t.organizacaoId, unidadeId: t.unidadeId });
      }
    }
    for (const [chave, tenant] of unicos) {
      if (emVoo.has(chave)) { pendentes.set(chave, tenant); contadores.agrupados += 1; continue; }
      enviar(chave, tenant, log);
    }
    return unicos.size;
  } catch (e) {
    try { log("warn", "pedidos.aviso_falhou", { erro: msgErro(e) }); } catch { /* nunca lança */ }
    return 0;
  }
}

/** Observabilidade/teste: estado do aviso neste processo (sem dados de pedido). */
export function estadoAvisoPedidos(env = process.env) {
  return { habilitado: checklistRealtimeHabilitado(env), destinoRegistrado: destino != null, emVoo: emVoo.size, pendentes: pendentes.size, ...contadores };
}

/** Só para teste: volta ao estado inicial. */
export function _resetAvisoPedidosParaTeste() {
  destino = null; emVoo.clear(); pendentes.clear();
  for (const k of Object.keys(contadores)) contadores[k] = 0;
}
