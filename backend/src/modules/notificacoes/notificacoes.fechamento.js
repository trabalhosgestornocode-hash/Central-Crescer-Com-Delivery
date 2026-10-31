// Fechamento operacional diário → Central de Notificações (SÓ SIMULAÇÃO nesta versão).
//
// Disparo pela CONSOLIDAÇÃO, nunca pelo relógio: chamado logo depois de `operacional_fechamento_registrar` devolver REGISTRADO.
//   * CONSOLIDADO  → aviso "inicial" a cada destinatário com escopo ATIVO da unidade na categoria `fechamento_operacional_diario`;
//   * REVISADO     → aviso de "correcao" só a quem marcou "avisar correções";
//   * PRELIMINAR / INCOMPLETO → nada.
// O texto é a MESMA prévia do Dashboard 2.0 (previaWhatsapp: mesmos números da tela, do PDF e do Excel) — nada é recalculado.
// Registro em `operacional_mensagens_simuladas` (transporte 'noop', CHECK no banco), chave
// `wa:fech:{fechamento_id}:{destinatario}:{inicial|correcao}` → a MESMA versão nunca vai duas vezes ao mesmo destinatário.
// Não entra na fila do D-1, não consome cota real (a cota da categoria só é CONSULTADA), não chama gateway nem Baileys.
// Legados (LEGACY_ACTIVE) nunca recebem esta categoria (CHECK no banco + filtro aqui).
import * as repo from "./notificacoes.repository.js";
import { logNotificacoes } from "./notificacoes.basico.js";

export const CATEGORIA_FECHAMENTO = "fechamento_operacional_diario";

/**
 * @param {{organizacaoId: string, unidadeId: string, fechamento: {id: string, versao: number, status: string},
 *          mensagem: string|null, inicioDiaIso: string, deps: {repo?: object, op: {registrarSimulacao: Function}}}} p
 */
export async function simularNotificacaoFechamento({ organizacaoId, unidadeId, fechamento, mensagem, inicioDiaIso, deps }) {
  const r = deps?.repo ?? repo;
  if (!["CONSOLIDADO", "REVISADO"].includes(fechamento?.status)) return { simuladas: 0, motivo: "STATUS_SEM_AVISO" };
  if (!mensagem) return { simuladas: 0, motivo: "SEM_MENSAGEM" };
  const proposito = fechamento.status === "REVISADO" ? "correcao" : "inicial";
  const dados = await r.listarDestinatarios({ organizacaoId }, deps);
  const ledger = await r.listarConsentimentos({ organizacaoId, contatoEmpresaIds: dados.destinatarios.map((d) => d.id) }, deps);
  const ativo = new Map(dados.destinatarios.map((d) => [d.id, d.ativo !== false]));
  const consentiu = (ce) => ledger.find((l) => l.contato_empresa_id === ce && l.categoria === CATEGORIA_FECHAMENTO && (l.acao === "CONCEDIDO" || l.acao === "REVOGADO"))?.acao === "CONCEDIDO";
  const alvos = dados.escopos.filter((e) => e.unidade_escopo_id === unidadeId && e.categoria === CATEGORIA_FECHAMENTO
    && e.origem_autorizacao === "CONVITE_OTP" && e.habilitado && !e.suspenso_em && ativo.get(e.contato_empresa_id)
    && consentiu(e.contato_empresa_id) && (proposito === "inicial" || e.notificar_correcao));
  const resultados = [];
  for (const e of alvos) {
    const cota = await r.cotaCategoria({ categoria: CATEGORIA_FECHAMENTO, contatoEmpresaId: e.contato_empresa_id, unidadeId, organizacaoId, inicioDiaIso }, deps)
      .catch(() => ({ disponivel: false, motivo: "COTA_INDISPONIVEL" }));
    const linha = {
      organizacao_id: organizacaoId, unidade_id: unidadeId, fechamento_id: fechamento.id, fechamento_versao: fechamento.versao, canal: "whatsapp", transporte: "noop",
      status: cota?.disponivel ? "SIMULATED" : "BLOCKED", chave_idempotencia: `wa:fech:${fechamento.id}:${e.contato_empresa_id}:${proposito}`,
      mensagem, tamanho: mensagem.length,
      validacao: { origem: "central_notificacoes", destinatario: e.contato_empresa_id, proposito, cota, verificacaoSimulada: e.verificacao_simulada === true },
      erro: cota?.disponivel ? null : (cota?.motivo ?? "COTA"), criado_por: "central-notificacoes",
    };
    try {
      const reg = await deps.op.registrarSimulacao(linha);
      resultados.push({ destinatario: e.contato_empresa_id, status: linha.status, duplicada: !!reg?.duplicada });
    } catch (erro) {
      logNotificacoes("warn", "fechamento.simulacao_falhou", { fechamento: fechamento.id, motivo: erro?.message });
    }
  }
  return { simuladas: resultados.filter((x) => !x.duplicada).length, proposito, resultados };
}
