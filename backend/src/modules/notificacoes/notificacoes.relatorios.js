// Relatórios OPERACIONAIS (diário e semanal) → Central de Notificações: ELEGIBILIDADE e PLANEJAMENTO (puro; nenhum envio, nenhuma escrita).
//
// Não reconstrói a Central: reaproveita escopos por unidade, consentimento por categoria (livro-razão), origem CONVITE_OTP, cota por categoria
// e o texto do Dashboard Operacional. Não toca no D-1 do Dashboard iFood (outra categoria, outra fila, outras cotas).
//
// ELEGIBILIDADE de uma unidade (todas precisam valer; qualquer dúvida = não elegível):
//   1. o módulo `checklist_operacional` está ativo na EMPRESA e na UNIDADE (interseção de `modulosEfetivosDaUnidade`);
//   2. o relatório tem DADO VÁLIDO: diário = fechamento CONSOLIDADO/REVISADO; semanal = semana encerrada com ≥ 5 de 7 dias válidos;
//   3. o destinatário tem escopo ATIVO da unidade na categoria, origem CONVITE_OTP, consentimento CONCEDIDO (último registro do livro-razão),
//      cadastro ativo e não suspenso; legados (LEGACY_ACTIVE) nunca recebem estas categorias.
import { resumirSemana, gerarMensagemSemanal, validarMensagemSemanal, chaveSemanal, ultimaSemanaEncerrada, STATUS_SEMANA } from "../checklist-operacional/checklistOperacional.semanal.js";

export const MODULO_CHECKLIST = "checklist_operacional";
export const CATEGORIA_DIARIA = "fechamento_operacional_diario";
export const CATEGORIA_SEMANAL = "resumo_semanal";
export const MOTIVO = Object.freeze({
  SEM_MODULO: "SEM_MODULO_CHECKLIST_NA_UNIDADE", SEM_FECHAMENTO_VALIDO: "SEM_FECHAMENTO_VALIDO", SEMANA_INCOMPLETA: "SEMANA_INCOMPLETA",
  SEM_DESTINATARIO: "SEM_DESTINATARIO_AUTORIZADO", MODULOS_INDISPONIVEIS: "MODULOS_INDISPONIVEIS",
});

export const temModulo = (modulosEfetivos) => Array.isArray(modulosEfetivos) && modulosEfetivos.includes(MODULO_CHECKLIST);

/** Mantém só as unidades com o Checklist Operacional ativo. Falha ao ler os módulos de uma unidade = fora (fail-closed), sem derrubar as outras. */
export async function filtrarUnidadesComChecklist(unidades, { modulosDe }) {
  const elegiveis = []; const recusadas = [];
  for (const u of unidades ?? []) {
    try {
      const mods = await modulosDe(u.organizacaoId, u.unidadeId);
      if (temModulo(mods)) elegiveis.push(u); else recusadas.push({ ...u, motivo: MOTIVO.SEM_MODULO });
    } catch { recusadas.push({ ...u, motivo: MOTIVO.MODULOS_INDISPONIVEIS }); }
  }
  return { elegiveis, recusadas };
}

/** Destinatários autorizados de UMA unidade e categoria (mesmas regras do aviso diário simulado). */
export function destinatariosAutorizados({ categoria, unidadeId, dados, ledger, proposito = "inicial" }) {
  const ativo = new Map((dados?.destinatarios ?? []).map((d) => [d.id, d.ativo !== false]));
  const consentiu = (ce) => (ledger ?? []).find((l) => l.contato_empresa_id === ce && l.categoria === categoria && (l.acao === "CONCEDIDO" || l.acao === "REVOGADO"))?.acao === "CONCEDIDO";
  return (dados?.escopos ?? []).filter((e) => e.unidade_escopo_id === unidadeId && e.categoria === categoria && e.origem_autorizacao === "CONVITE_OTP"
    && e.habilitado && !e.suspenso_em && ativo.get(e.contato_empresa_id) && consentiu(e.contato_empresa_id) && (proposito === "inicial" || e.notificar_correcao));
}

/** Diário: o fechamento já armazenado precisa ser CONSOLIDADO/REVISADO. */
export function elegibilidadeDiaria({ modulosEfetivos, fechamento }) {
  if (!temModulo(modulosEfetivos)) return { elegivel: false, motivo: MOTIVO.SEM_MODULO };
  if (!fechamento || !["CONSOLIDADO", "REVISADO"].includes(fechamento.status) || !fechamento.indicadores) return { elegivel: false, motivo: MOTIVO.SEM_FECHAMENTO_VALIDO };
  return { elegivel: true, motivo: null };
}

/**
 * Semanal: planeja (sem escrever nem enviar) o resumo da última semana encerrada para cada destinatário autorizado.
 * @returns {{elegivel: boolean, motivo: string|null, semana?: object, mensagem?: string|null, validacao?: object, linhas: object[]}}
 */
export function planejarResumoSemanal({ organizacaoId, unidadeId, unidadeNome = null, modulosEfetivos, versoes, hojeIso, dados, ledger, cotas = {}, segunda = null }) {
  if (!temModulo(modulosEfetivos)) return { elegivel: false, motivo: MOTIVO.SEM_MODULO, linhas: [] };
  const semanaInicio = segunda ?? ultimaSemanaEncerrada(hojeIso);
  const resumo = resumirSemana(semanaInicio, versoes);
  if (resumo.status === STATUS_SEMANA.INCOMPLETA) return { elegivel: false, motivo: MOTIVO.SEMANA_INCOMPLETA, semana: { inicio: resumo.semanaInicio, diasValidos: resumo.diasValidos, diasAusentes: resumo.diasAusentes }, linhas: [] };
  const mensagem = gerarMensagemSemanal({ resumo, unidadeNome });
  const validacao = validarMensagemSemanal(mensagem, resumo);
  const alvos = destinatariosAutorizados({ categoria: CATEGORIA_SEMANAL, unidadeId, dados, ledger });
  if (!alvos.length) return { elegivel: false, motivo: MOTIVO.SEM_DESTINATARIO, semana: resumo, mensagem, validacao, linhas: [] };
  const linhas = alvos.map((e) => {
    const cota = cotas[e.contato_empresa_id] ?? { disponivel: false, motivo: "COTA_NAO_CONSULTADA" };
    const ok = validacao.ok && cota.disponivel === true;
    return {
      organizacao_id: organizacaoId, unidade_id: unidadeId, destinatario: e.contato_empresa_id, canal: "whatsapp", transporte: "noop",
      status: ok ? "SIMULATED" : "BLOCKED", chave_idempotencia: chaveSemanal(unidadeId, resumo.semanaInicio, e.contato_empresa_id, resumo.hash),
      mensagem, tamanho: mensagem.length, erro: ok ? null : (!validacao.ok ? "VALIDACAO" : (cota.motivo ?? "COTA")),
    };
  });
  return { elegivel: true, motivo: null, semana: resumo, mensagem, validacao, linhas };
}
