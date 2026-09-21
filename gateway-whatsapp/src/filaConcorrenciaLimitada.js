// Checkpoint G.0.1 (Partes C-J) — fila local de CONCORRÊNCIA LIMITADA para chamadas ao backend.
//
// PROBLEMA AUDITADO (Parte C): `aoMessagesUpsert` (baileysSession.js) iterava `messages` e chamava
// `backendClient.notificarMensagemRecebida(evento)` num `for` SEM `await` e SEM limite — cada mensagem de um
// flush abre uma promise/requisição HTTP própria, todas em voo ao mesmo tempo. Não é uma exceção não tratada
// (cada uma já tinha `.catch()`) nem falta de timeout (backendClient.js já usa AbortController por chamada) — é
// falta de TETO: um flush de centenas/milhares de mensagens (o próprio objetivo do Checkpoint G quando o
// OFFLINE_RECOVERY termina com sucesso) dispara centenas/milhares de chamadas simultâneas.
//
// SOLUÇÃO (Parte D): fila local + N workers fixos ("bounded worker pool"), sem nenhuma dependência nova. Nunca
// serializa (Parte E): até `concorrencia` tarefas rodam ao mesmo tempo; o resto espera EM MEMÓRIA (nunca
// `Promise.all` sobre o lote inteiro).
//
// PRIORIDADE (Parte J): duas filas internas — `alta` (LIVE) e `normal` (OFFLINE_NORMAL/OFFLINE_RECOVERY/demais).
// Um worker livre SEMPRE puxa da fila `alta` primeiro. Isto NÃO pausa nem cancela uma tarefa `normal` já em
// execução (não dá para "pausar" um `fetch()` em voo) — só garante que uma mensagem LIVE enfileirada DEPOIS de um
// backlog de recovery não fica atrás dele na fila: ela entra pela frente assim que um worker vagar.
//
// Nunca lança: uma tarefa que rejeita é isolada (Promise.allSettled-like) — quem enfileira decide o que fazer com
// a rejeição (ver baileysSession.js: hoje é best-effort, só loga — ver Parte G do checkpoint).
export const PRIORIDADES = Object.freeze(["alta", "normal"]);

/**
 * @param {object} [o]
 * @param {number} [o.concorrencia] nº máximo de tarefas em voo ao mesmo tempo (>= 1)
 */
export function criarFilaConcorrenciaLimitada({ concorrencia = 4 } = {}) {
  if (!Number.isInteger(concorrencia) || concorrencia < 1) throw new RangeError("concorrencia deve ser inteiro >= 1");

  const filas = { alta: [], normal: [] };
  let ativos = 0;
  let picoConcorrencia = 0;
  let enfileiradas = 0;
  let concluidas = 0;
  let falhas = 0;

  function proximaTarefa() {
    if (filas.alta.length > 0) return filas.alta.shift();
    if (filas.normal.length > 0) return filas.normal.shift();
    return null;
  }

  function bombear() {
    while (ativos < concorrencia) {
      const item = proximaTarefa();
      if (!item) return;
      ativos += 1;
      if (ativos > picoConcorrencia) picoConcorrencia = ativos;
      // `Promise.resolve().then(tarefa)` — mesmo uma tarefa SÍNCRONA que lança nunca escapa daqui.
      Promise.resolve().then(item.tarefa).then(
        (valor) => { ativos -= 1; concluidas += 1; item.resolver(valor); bombear(); },
        (e) => { ativos -= 1; concluidas += 1; falhas += 1; item.rejeitar(e); bombear(); },
      );
    }
  }

  return {
    /**
     * @param {() => Promise<any>} tarefa
     * @param {{prioridade?: 'alta'|'normal'}} [opcoes]
     * @returns {Promise<any>} resolve/rejeita com o resultado da tarefa, quando ela finalmente rodar
     */
    enfileirar(tarefa, { prioridade = "normal" } = {}) {
      const fila = filas[PRIORIDADES.includes(prioridade) ? prioridade : "normal"];
      enfileiradas += 1;
      return new Promise((resolver, rejeitar) => {
        fila.push({ tarefa, resolver, rejeitar });
        bombear();
      });
    },
    /** só números — para métricas/teste (Parte I: prova que a concorrência nunca passou do limite). */
    metricas: () => ({
      concorrencia, ativos, pendentesAlta: filas.alta.length, pendentesNormal: filas.normal.length,
      enfileiradas, concluidas, falhas, picoConcorrencia,
    }),
  };
}
