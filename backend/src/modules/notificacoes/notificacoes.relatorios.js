// Relatórios OPERACIONAIS (diário e semanal) → Central de Notificações: ELEGIBILIDADE e PLANEJAMENTO (puro; nenhum envio, nenhuma escrita).
//
// Não reconstrói a Central: reaproveita escopos por unidade, consentimento por categoria (livro-razão), origem CONVITE_OTP, cota por categoria
// e o texto do Dashboard Operacional. Não toca no D-1 do Dashboard iFood (outra categoria, outra fila, outras cotas).
//
// ELEGIBILIDADE de uma unidade (todas precisam valer; qualquer dúvida = não elegível):
//   1. o módulo `checklist_operacional` está ativo na EMPRESA e na UNIDADE (necessário, NÃO suficiente: é só permissão de acesso);
//   2. INTEGRAÇÃO REAL: a conexão iFood de pedidos (Events/Orders) está `ao_vivo` (loja vinculada + credencial Order + recebimento renovado há pouco);
//   3. PEDIDOS REAIS comprovados no período (a projeção `operacional_pedidos` é por unidade, tenant verificado por trigger, e ignora pedidos de teste);
//   4. DADO VÁLIDO: diário = fechamento CONSOLIDADO/REVISADO; semanal = semana encerrada com ≥ 5 de 7 dias válidos.
//   Os motivos de não-elegibilidade são DISTINTOS: integração desconectada × sem pedidos × dados insuficientes.
//   5. destinatário (abaixo):
//      o destinatário tem escopo ATIVO da unidade na categoria, origem CONVITE_OTP, consentimento CONCEDIDO (último registro do livro-razão),
//      cadastro ativo e não suspenso; legados (LEGACY_ACTIVE) nunca recebem estas categorias.
import { resumirSemana, gerarMensagemSemanal, validarMensagemSemanal, chaveSemanal, ultimaSemanaEncerrada, STATUS_SEMANA } from "../checklist-operacional/checklistOperacional.semanal.js";

export const MODULO_CHECKLIST = "checklist_operacional";
export const CATEGORIA_DIARIA = "fechamento_operacional_diario";
export const CATEGORIA_SEMANAL = "resumo_semanal";
export const MOTIVO = Object.freeze({
  SEM_MODULO: "SEM_MODULO_CHECKLIST_NA_UNIDADE", SEM_FECHAMENTO_VALIDO: "SEM_FECHAMENTO_VALIDO", SEMANA_INCOMPLETA: "SEMANA_INCOMPLETA",
  SEM_DESTINATARIO: "SEM_DESTINATARIO_AUTORIZADO", MODULOS_INDISPONIVEIS: "MODULOS_INDISPONIVEIS",
  INTEGRACAO_NAO_ATIVADA: "INTEGRACAO_NAO_ATIVADA", INTEGRACAO_DESCONECTADA: "INTEGRACAO_DESCONECTADA", INTEGRACAO_NAO_VERIFICADA: "INTEGRACAO_NAO_VERIFICADA",
  SEM_PEDIDOS: "SEM_PEDIDOS_NO_PERIODO", DADOS_INSUFICIENTES: "DADOS_INSUFICIENTES",
});

/**
 * Integração iFood da unidade (saída de `derivarEstadoIntegracao`): `ao_vivo` é o único estado que libera relatório.
 *   nao_ativada   → INTEGRACAO_NAO_ATIVADA (sem loja vinculada, sem credencial Order ou recebimento nunca ligado)
 *   desatualizado → INTEGRACAO_DESCONECTADA (recebimento parou ou a autorização expirou)
 *   ausente/estado desconhecido → INTEGRACAO_NAO_VERIFICADA (fail-closed)
 */
export function motivoDeIntegracao(integracao) {
  const e = integracao?.estado;
  if (e === "ao_vivo") return null;
  if (e === "nao_ativada") return MOTIVO.INTEGRACAO_NAO_ATIVADA;
  if (e === "desatualizado") return MOTIVO.INTEGRACAO_DESCONECTADA;
  return MOTIVO.INTEGRACAO_NAO_VERIFICADA;
}

/** O fechamento diário prova que o dia tinha cobertura? INCOMPLETO por falta de sinal/cobertura/detalhes = dados insuficientes. */
const cobertoPorSinal = (f) => !(f?.cobertura?.semCobertura || f?.cobertura?.semSinalDeRecebimento);

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

/**
 * Diário: módulo + integração AO VIVO + fechamento CONSOLIDADO/REVISADO com sinal de recebimento + pedidos reais no dia.
 * Ordem do diagnóstico (a primeira falha decide o motivo): módulo → integração → dado → pedidos.
 */
export function elegibilidadeDiaria({ modulosEfetivos, integracao, fechamento }) {
  if (!temModulo(modulosEfetivos)) return { elegivel: false, motivo: MOTIVO.SEM_MODULO };
  const mi = motivoDeIntegracao(integracao); if (mi) return { elegivel: false, motivo: mi };
  if (!fechamento || !fechamento.indicadores) return { elegivel: false, motivo: MOTIVO.DADOS_INSUFICIENTES };
  if (!["CONSOLIDADO", "REVISADO"].includes(fechamento.status) || !cobertoPorSinal(fechamento)) return { elegivel: false, motivo: MOTIVO.DADOS_INSUFICIENTES };
  if (!(Number(fechamento.indicadores.pedidos?.recebidos) > 0)) return { elegivel: false, motivo: MOTIVO.SEM_PEDIDOS };
  return { elegivel: true, motivo: null };
}

/**
 * Semanal: planeja (sem escrever nem enviar) o resumo da última semana encerrada para cada destinatário autorizado.
 * @returns {{elegivel: boolean, motivo: string|null, semana?: object, mensagem?: string|null, validacao?: object, linhas: object[]}}
 */
export function planejarResumoSemanal({ organizacaoId, unidadeId, unidadeNome = null, modulosEfetivos, integracao, versoes, hojeIso, dados, ledger, cotas = {}, segunda = null }) {
  if (!temModulo(modulosEfetivos)) return { elegivel: false, motivo: MOTIVO.SEM_MODULO, linhas: [] };
  const mi = motivoDeIntegracao(integracao); if (mi) return { elegivel: false, motivo: mi, linhas: [] };
  const semanaInicio = segunda ?? ultimaSemanaEncerrada(hojeIso);
  const resumo = resumirSemana(semanaInicio, versoes);
  if (resumo.status === STATUS_SEMANA.INCOMPLETA) return { elegivel: false, motivo: MOTIVO.DADOS_INSUFICIENTES, detalhe: MOTIVO.SEMANA_INCOMPLETA, semana: { inicio: resumo.semanaInicio, diasValidos: resumo.diasValidos, diasAusentes: resumo.diasAusentes }, linhas: [] };
  if (!(resumo.indicadores.pedidos.recebidos > 0)) return { elegivel: false, motivo: MOTIVO.SEM_PEDIDOS, semana: resumo, linhas: [] };
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
