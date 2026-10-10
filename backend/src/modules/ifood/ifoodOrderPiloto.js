// Piloto do app Order (pedidos + eventos): QUAIS unidades podem usá-lo.
//
// As credenciais IFOOD_ORDER_CLIENT_ID/SECRET só dizem que o app Order EXISTE neste ambiente. Elas NÃO
// liberam o Order para ninguém. Liberação é explícita, por unidade:
//
//   IFOOD_ORDER_PILOT_UNITS=<uuid da unidade>[,<uuid>...]   (vírgula, ponto e vírgula ou espaço)
//
// Fail-closed: vazio/ausente = nenhuma unidade. Só UUIDs válidos entram; o resto é ignorado (e contado,
// nunca ecoado). A chave é o id estável da unidade — nunca nome de empresa ou de loja.
//
// Independente do Events: liberar uma unidade NÃO liga polling (IFOOD_EVENTS_EMBEDDED_ENABLED é outra flag).
// Mas, com o Events ligado, esta lista é o ESCOPO do poller: só as unidades daqui são consultadas, têm token
// renovado, eventos reconhecidos e pendentes reprocessados (ifoodEvents.poller.js). Vazia = poller ocioso.
// Puro (sem config/rede): o env.js chama `parsearUnidadesPiloto` no boot; as decisões leem `config`.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * @param {string|undefined|null} bruto valor da variável de ambiente
 * @returns {{ unidades: string[], ignorados: number }} ids normalizados (minúsculos, sem repetição)
 */
export function parsearUnidadesPiloto(bruto) {
  if (typeof bruto !== "string" || !bruto.trim()) return { unidades: [], ignorados: 0 };
  const unidades = new Set();
  let ignorados = 0;
  for (const parte of bruto.split(/[\s,;]+/)) {
    if (!parte) continue;
    const id = parte.trim().toLowerCase();
    if (UUID.test(id)) unidades.add(id);
    else ignorados += 1;
  }
  return { unidades: [...unidades], ignorados };
}

/**
 * A unidade está na lista do piloto? Comparação exata do id normalizado.
 * @param {string[]|undefined} unidadesPiloto lista já parseada (config.ifood.orderPilotoUnidades)
 * @param {string|null|undefined} unidadeId
 */
export function unidadeNoPilotoOrder(unidadesPiloto, unidadeId) {
  if (!Array.isArray(unidadesPiloto) || unidadesPiloto.length === 0) return false;
  if (typeof unidadeId !== "string" || !unidadeId) return false;
  return unidadesPiloto.includes(unidadeId.trim().toLowerCase());
}
