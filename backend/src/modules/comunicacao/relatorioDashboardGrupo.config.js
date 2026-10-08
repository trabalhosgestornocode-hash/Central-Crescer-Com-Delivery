// Configuração PURA do relatório diário do grupo interno (sem I/O, sem env obrigatória) — separada de
// relatorioDashboardGrupo.js para o worker decidir se instala o passo SEM carregar Supabase/pendencias().

export const TIMEZONE_RELATORIO = "America/Sao_Paulo";
export const HORARIO_RELATORIO = Object.freeze({ hora: 16, minuto: 30 });
/** Depois disto (hora local) o relatório do dia não sai mais: fica registrado como não enviado (nunca uma mensagem fora de hora). */
export const LIMITE_RELATORIO = Object.freeze({ hora: 20, minuto: 0 });
/** 0 = domingo … 6 = sábado (comunicacao.horario.js#partesLocais). Domingo não roda. */
export const DIAS_RELATORIO = Object.freeze([1, 2, 3, 4, 5, 6]);
export const MODOS_RELATORIO = Object.freeze({ DESLIGADO: "DESLIGADO", SIMULACAO: "SIMULACAO", ATIVO: "ATIVO" });

/** IFOOD_DASHBOARD_RELATORIO_GRUPO_MODO: só ATIVO/SIMULACAO ligam algo; ausente ou qualquer outro valor = DESLIGADO. */
export function modoRelatorio(env = process.env) {
  const v = String(env.IFOOD_DASHBOARD_RELATORIO_GRUPO_MODO ?? "").trim().toUpperCase();
  return v === MODOS_RELATORIO.ATIVO || v === MODOS_RELATORIO.SIMULACAO ? v : MODOS_RELATORIO.DESLIGADO;
}
