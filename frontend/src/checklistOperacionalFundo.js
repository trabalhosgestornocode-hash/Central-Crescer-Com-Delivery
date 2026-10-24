// Checklist Operacional — FUNDO DINÂMICO das versões Televisão e Tablet (funções puras, sem DOM).
//
// A cor do fundo é o status agregado que JÁ existe: `derivarStatusOperacao(...).nivel` (checklistOperacionalModelo.js) —
// o pior entre as médias do dia (classificação final), os pedidos em andamento (classificação preventiva) e os alertas
// do servidor. Nenhuma regra nova de prioridade: com etapas em níveis diferentes, vale a pior, exatamente como no card
// "Status da operação". `neutro` (sem medição) = fundo padrão da marca.
//
// SEM PISCAR: piorar é IMEDIATO (o gerente precisa ver na hora); melhorar só depois de RETENCAO_MELHORA_MS estável.
// Assim um pedido que sai e outro que entra no mesmo ciclo não fazem o fundo ir e voltar. Mudança de meta, troca de
// modo e a primeira pintura são aplicadas na hora (`forcar`). A transição visual (CSS) é suave e some com
// `prefers-reduced-motion`.
//
// A cor nunca está sozinha: o selo do cabeçalho repete o estado com texto e ícone (ROTULO_FUNDO).

export const RETENCAO_MELHORA_MS = 5000;

const ORDEM = { neutro: 0, ok: 1, atencao: 2, critico: 3 };
const NIVEIS = Object.keys(ORDEM);

/** Texto e ícone do selo de status (o mesmo vocabulário do card "Status da operação"). */
export const ROTULO_FUNDO = Object.freeze({
  ok: { texto: "Operação dentro da meta", icone: "check-circle" },
  atencao: { texto: "Operação próxima do limite", icone: "alert-triangle" },
  critico: { texto: "Operação fora da meta", icone: "alert-octagon" },
  neutro: { texto: "Sem medições agora", icone: "activity" },
});

/**
 * Próximo estado do fundo.
 * @param {{nivel: string, candidato?: string|null, candidatoDesde?: number|null}|null} anterior
 * @param {string} nivel  nível agregado calculado agora
 * @param {number} agoraMs relógio do aparelho (cadência visual, não tempo exibido)
 * @param {{forcar?: boolean}} [opcoes]
 * @returns {{nivel: string, candidato: string|null, candidatoDesde: number|null, mudou: boolean}}
 */
export function proximoFundo(anterior, nivel, agoraMs, { forcar = false } = {}) {
  const alvo = NIVEIS.includes(nivel) ? nivel : "neutro";
  if (!anterior || forcar || ORDEM[alvo] >= ORDEM[anterior.nivel]) {
    return { nivel: alvo, candidato: null, candidatoDesde: null, mudou: !anterior || anterior.nivel !== alvo };
  }
  // Melhora: espera ficar estável (o candidato pode mudar no meio; a contagem recomeça).
  if (anterior.candidato !== alvo) return { nivel: anterior.nivel, candidato: alvo, candidatoDesde: agoraMs, mudou: false };
  if (agoraMs - anterior.candidatoDesde >= RETENCAO_MELHORA_MS) return { nivel: alvo, candidato: null, candidatoDesde: null, mudou: true };
  return { ...anterior, mudou: false };
}
