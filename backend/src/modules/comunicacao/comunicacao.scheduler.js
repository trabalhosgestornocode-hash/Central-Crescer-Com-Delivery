// Scheduler — SÓ lógica pura de janela e distribuição de horários. Nenhum
// I/O aqui (mesmo espírito de administrativo.status.js). A configuração
// (janelas, limites) é lida por quem chama, via comunicacao.config.js, e
// passada como parâmetro — mantém isto 100% testável sem banco.
//
// REGRA IMPORTANTE (pedido explícito): a distribuição existe para
// CAPACIDADE/CARGA — evitar rajada, não para "parecer humano". Determinística:
// mesma entrada, mesma saída, sempre. Nada de Math.random() aqui.

/** @typedef {{inicio: string, fim: string}|null} JanelaDia  "HH:MM" ou null (sem expediente) */
/** @typedef {{seg_sex: JanelaDia, sab: JanelaDia, dom: JanelaDia}} Janelas */

const DIA_SEMANA_GRUPO = ["dom", "seg_sex", "seg_sex", "seg_sex", "seg_sex", "seg_sex", "sab"]; // getDay(): 0=dom..6=sab

function grupoDoDia(data) {
  return DIA_SEMANA_GRUPO[data.getDay()];
}

function paraMinutosDoDia(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * A janela do dia (ou null se não há expediente naquele dia da semana).
 * @param {Date} data
 * @param {Janelas} janelas
 * @returns {JanelaDia}
 */
export function janelaDoDia(data, janelas) {
  return janelas[grupoDoDia(data)] ?? null;
}

/**
 * `data` cai dentro do horário comercial permitido?
 * @param {Date} data
 * @param {Janelas} janelas
 * @returns {boolean}
 */
export function dentroDaJanela(data, janelas) {
  const j = janelaDoDia(data, janelas);
  if (!j) return false;
  const minutos = data.getHours() * 60 + data.getMinutes();
  return minutos >= paraMinutosDoDia(j.inicio) && minutos < paraMinutosDoDia(j.fim);
}

/**
 * Próximo instante (>= `data`) dentro de uma janela permitida — usado para
 * REAGENDAR (nunca descartar) um job que caiu fora do horário. Anda dia a
 * dia até achar um grupo com janela definida; se o horário atual do dia já
 * passou do fim, pula para o início do PRÓXIMO dia elegível.
 * @param {Date} data
 * @param {Janelas} janelas
 * @param {number} [limiteDias]  proteção contra loop infinito se `janelas` estiver
 *   mal configurada (todo dia null) — lança nesse caso, nunca trava.
 * @returns {Date}
 */
export function proximoInicioDeJanela(data, janelas, limiteDias = 14) {
  let cursor = new Date(data.getTime());
  for (let i = 0; i <= limiteDias; i++) {
    const j = janelaDoDia(cursor, janelas);
    if (j) {
      const inicioMin = paraMinutosDoDia(j.inicio);
      const fimMin = paraMinutosDoDia(j.fim);
      const minutosAtuais = cursor.getHours() * 60 + cursor.getMinutes();
      if (minutosAtuais >= inicioMin && minutosAtuais < fimMin) {
        return cursor; // já está dentro da janela agora
      }
      if (minutosAtuais < inicioMin) {
        const r = new Date(cursor); r.setHours(0, inicioMin, 0, 0); return r;
      }
      // minutosAtuais >= fimMin -> já passou da janela HOJE (só pode acontecer em
      // i===0, já que a partir de i>0 o cursor sempre começa à meia-noite) -> cai
      // para o avanço de dia abaixo, tenta o próximo elegível.
    }
    cursor = new Date(cursor.getTime() + 24 * 60 * 60_000);
    cursor.setHours(0, 0, 0, 0);
  }
  throw new Error("proximoInicioDeJanela: nenhuma janela elegível encontrada — configuração de janelas inválida (todos os dias fechados?).");
}

/**
 * Distribui N itens dentro de uma janela [inicio, fim), com espaçamento
 * MÍNIMO garantido entre eles — carga/capacidade, NUNCA "parecer humano".
 * Determinístico: item i sempre recebe `inicio + i * passo`, onde `passo =
 * max(intervaloMinimoMs, duração/quantidade)`. Itens que excederiam o fim
 * da janela transbordam para o mesmo horário-de-início do PRÓXIMO dia
 * elegível (chamando `proximoInicioDeJanela` recursivamente) — nunca ficam
 * sem horário.
 *
 * @param {{quantidade: number, inicio: Date, fim: Date, intervaloMinimoMs: number, janelas: Janelas}} params
 * @returns {Date[]} um horário por item, na mesma ordem
 */
export function distribuirHorarios({ quantidade, inicio, fim, intervaloMinimoMs, janelas }) {
  if (quantidade <= 0) return [];
  const duracaoMs = fim.getTime() - inicio.getTime();
  const passoMs = Math.max(intervaloMinimoMs, quantidade > 1 ? Math.floor(duracaoMs / quantidade) : 0);

  const horarios = [];
  for (let i = 0; i < quantidade; i++) {
    const candidato = new Date(inicio.getTime() + i * passoMs);
    if (candidato.getTime() < fim.getTime()) {
      horarios.push(candidato);
    } else {
      // transbordou a janela de hoje — próximo dia elegível, mesmo princípio
      const proxima = proximoInicioDeJanela(candidato, janelas);
      horarios.push(proxima);
    }
  }
  return horarios;
}
