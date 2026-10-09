// Checklist Operacional — AMOSTRA DE DEMONSTRAÇÃO (retrato estático).
//
// Só existe para a tela ter o que mostrar antes da integração real. Regras:
//   * vive SÓ na memória do navegador — nunca é enviada ao backend nem gravada;
//   * sempre sai com `origem: "demonstracao"` e conexão `demonstracao`, então a
//     tela nunca a apresenta como "ao vivo";
//   * os horários são relativos a `agora`, para os contadores andarem de verdade.
// Montada para abrir com os três estados visíveis (preparo fora da meta,
// entrega dentro, vida próxima) e cruzar limites nos minutos seguintes.
// No B2 este retrato vira um simulador (pedidos entrando, mudando de etapa etc.).

import { METAS_EXEMPLO } from "./checklistOperacionalModelo.js";

const MIN = 60000;

/** @returns {import('./checklistOperacionalModelo.js').ResumoChecklist} */
export function amostraDemonstracao({ agora = Date.now(), unidadeNome = "Unidade de demonstração", metas = METAS_EXEMPLO } = {}) {
  const ha = (min) => new Date(agora - min * MIN).toISOString();
  return {
    origem: "demonstracao",
    unidade: { id: null, nome: unidadeNome },
    conexao: { estado: "demonstracao", ultimaSincronizacao: ha(0.2) },
    metas,
    indicadores: {
      preparo: { ultimo: { min: 12.4, displayId: "4521", em: ha(6) }, mediaDia: 9.1, amostras: 38 },
      entrega: { ultimo: { min: 28.6, displayId: "4517", em: ha(4) }, mediaDia: 26.4, amostras: 35 },
      vida: {
        ultimo: { min: 47.3, displayId: "4517", em: ha(4) }, mediaDia: 43.9, amostras: 35,
        decomposicao: { confirmacao: 1.4, preparo: 11.9, espera: 5.4, entrega: 28.6 },
      },
    },
    pedidosAtivos: [
      { id: "d-4531", displayId: "4531", recebidoEm: ha(1.2), status: "PLACED" },
      { id: "d-4530", displayId: "4530", recebidoEm: ha(4.1), status: "CONFIRMED", confirmadoEm: ha(3.6) },
      { id: "d-4529", displayId: "4529", recebidoEm: ha(9.5), status: "SEPARATION_STARTED", confirmadoEm: ha(8.9) },
      { id: "d-4528", displayId: "4528", recebidoEm: ha(13.6), status: "SEPARATION_STARTED", confirmadoEm: ha(12.9) },
      { id: "d-4526", displayId: "4526", recebidoEm: ha(19.5), status: "READY_TO_PICKUP", confirmadoEm: ha(18.7) },
      { id: "d-4522", displayId: "4522", recebidoEm: ha(39), status: "DISPATCHED", confirmadoEm: ha(38.2), despachadoEm: ha(18) },
    ],
    ultimosPedidos: [
      { id: "d-4527", displayId: "4527", recebidoEm: ha(15), status: "CONFIRMED", preparoMin: null, entregaMin: null, vidaMin: null },
      { id: "d-4525", displayId: "4525", recebidoEm: ha(24), status: "DISPATCHED", preparoMin: 10.5, entregaMin: null, vidaMin: null },
      { id: "d-4523", displayId: "4523", recebidoEm: ha(31), status: "CANCELLED", preparoMin: null, entregaMin: null, vidaMin: null },
      { id: "d-4521", displayId: "4521", recebidoEm: ha(41), status: "DISPATCHED", preparoMin: 12.4, entregaMin: null, vidaMin: null },
      { id: "d-4517", displayId: "4517", recebidoEm: ha(51), status: "CONCLUDED", preparoMin: 11.9, entregaMin: 28.6, vidaMin: 47.3 },
      { id: "d-4516", displayId: "4516", recebidoEm: ha(58), status: "CONCLUDED", preparoMin: 7.8, entregaMin: 24.1, vidaMin: 36.4 },
      { id: "d-4514", displayId: "4514", recebidoEm: ha(66), status: "CONCLUDED", preparoMin: 10.2, preparoAproximado: true, entregaMin: 25.0, vidaMin: 39.8 },
      { id: "d-4512", displayId: "4512", recebidoEm: ha(74), status: "CONCLUDED", preparoMin: 8.1, entregaMin: 22.7, vidaMin: 34.2 },
    ],
    avaliacoes: {
      disponivel: true,
      ultima: { nota: 5, em: ha(9), comentario: "Chegou quentinho e bem antes do previsto. Obrigado!", displayId: "4509" },
      recentes: [
        { nota: 5, em: ha(9), comentario: "Chegou quentinho e bem antes do previsto. Obrigado!", displayId: "4509" },
        { nota: 2, em: ha(26), comentario: "Faltou o molho que pedi e o lanche veio frio.", displayId: "4497" },
        { nota: 4, em: ha(41), comentario: null, displayId: "4490" },
      ],
      mediaDia: 4.6, total: 27, mediaOntem: 4.7,
      distribuicao: { 5: 20, 4: 5, 3: 1, 2: 1, 1: 0 },
    },
    contagemDia: { concluidos: 35, cancelados: 2 },
  };
}
