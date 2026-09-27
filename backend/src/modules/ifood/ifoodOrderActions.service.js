// Order do iFood — ações do Checkpoint D: readyToPickup, dispatch e cancelamento.
//
// REGRA CENTRAL (a mesma do confirm, Checkpoint C)
//   ação enviada -> HTTP aceito -> registra a INTENÇÃO local (action_state = <acao>_requested)
//   -> `status_oficial` NÃO muda -> o EVENTO oficial chega -> só então o estado oficial muda
//   (ver ifoodEvents.service.js: extrasDoEvento resolve a ação quando o evento correspondente chega).
//
// AÇÕES MUTANTES NUNCA SÃO REPETIDAS ÀS CEGAS
//   * o transporte não faz retry (`semRetry`);
//   * timeout / rede / 5xx / resposta ilegível => o iFood PODE ter processado: o estado vira `<acao>_requested`
//     com `action_uncertain = true` e o resultado é AGUARDANDO_EVENTO. Reenviar só com `permitirReenvioIncerto`
//     E depois de `IFOOD_ORDER.reenvioIncertoAposMs` sem evento;
//   * 400/401/403/404/409/422/429 => o iFood recusou: `<acao>_failed` (nova tentativa permitida).
//
// Tipos de resultado (retorno, sem exceção): SOLICITADO · JA_SOLICITADO · JA_EXECUTADO · EM_ENVIO · AGUARDANDO_EVENTO
// Exceções (nada é enviado): IFOOD_PEDIDO_LOCAL_NAO_ENCONTRADO · IFOOD_PEDIDO_ESTADO_INVALIDO · IFOOD_ACAO_NAO_ELEGIVEL ·
//   IFOOD_MOTIVO_CANCELAMENTO_INVALIDO. Erros do iFood sobem como IfoodError (o estado local já foi ajustado).
//
// TOKEN pela interface comum (appType = "order"); MULTI-TENANT: pedido sempre por organização + unidade.

import { IFOOD_APP_ORDER, IFOOD_ORDER } from "./ifood.constants.js";
import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";
import { ifoodLog } from "./ifood.logsafe.js";
import { STATUS_PEDIDO } from "./ifoodEvents.parser.js";
import * as orderClient from "./ifoodOrder.client.js";
import { classificarFalhaDeAcao, mensagemSegura, sanitizarParaAuditoria } from "./ifoodAcoes.util.js";
import { avaliarElegibilidade, estadoInvalido } from "./ifoodOrderElegibilidade.js";

export { avaliarElegibilidade };

const S = STATUS_PEDIDO;
const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const comToken = (token, conexaoId, http, fn) => token.comAccessTokenValido({ conexaoId, appType: IFOOD_APP_ORDER, deps: { http }, fn });

const res = (resultado, acao, pedido, extra = {}) => ({
  resultado, acao, statusOficial: pedido?.status_oficial ?? null, actionState: pedido?.action_state ?? null, oficial: false, ...extra,
});

/** Motivos OFICIAIS de cancelamento (GET). Só leitura; nunca lista fixa. */
export async function listarMotivosCancelamento({ organizacaoId, unidadeId, orderId, repo, token, client = orderClient, http }) {
  const pedido = await repo.obterPedidoDoTenant({ organizacaoId, unidadeId, orderId });
  if (!pedido) throw ifoodErro(IFOOD_ERROS.IFOOD_PEDIDO_LOCAL_NAO_ENCONTRADO);
  const conexao = await repo.obterConexaoAtivaDoMerchant({ organizacaoId, unidadeId, merchantId: pedido.merchant_id });
  if (!conexao) throw ifoodErro(IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA);
  return comToken(token, conexao.id, http, (accessToken) => client.listarMotivosCancelamento({ accessToken, orderId, http }));
}

async function executarAcao({
  acao, organizacaoId, unidadeId, orderId, repo, token, client, http, agora, log,
  permitirReenvioIncerto = false, substituirPendente = false, motivo = null,
}) {
  const nowMs = () => agora().getTime();
  let pedido = await repo.obterPedidoDoTenant({ organizacaoId, unidadeId, orderId });
  if (!pedido) throw ifoodErro(IFOOD_ERROS.IFOOD_PEDIDO_LOCAL_NAO_ENCONTRADO);

  const auditar = (p, resultado, extra = {}) => Promise.resolve(repo.registrarAcao({ pedido: p, acao, resultado, ...extra }))
    .catch((e) => log("warn", "order.auditoria_falhou", { orderId, acao, erro: mensagemSegura(e) }));

  for (let volta = 1; volta <= 2; volta += 1) {
    const eleg = avaliarElegibilidade(acao, pedido);
    if (eleg.tipo === "JA_EXECUTADO") return res("JA_EXECUTADO", acao, pedido);
    if (eleg.tipo === "AGUARDANDO_EVENTO") return res("AGUARDANDO_EVENTO", acao, pedido, { motivo: eleg.motivo });

    const estado = pedido.action_state ?? "none";
    const idade = nowMs() - (ms(pedido.action_requested_at) || nowMs());
    if (estado === `${acao}_requested`) {
      const podeReenviar = pedido.action_uncertain && permitirReenvioIncerto && idade >= IFOOD_ORDER.reenvioIncertoAposMs;
      if (!podeReenviar) {
        await auditar(pedido, "JA_SOLICITADA");
        return pedido.action_uncertain
          ? res("AGUARDANDO_EVENTO", acao, pedido, { incerto: true, motivo: "resultado_incerto_aguardando_evento" })
          : res("JA_SOLICITADO", acao, pedido);
      }
    } else if (estado.endsWith("_sending")) {
      const velho = idade > IFOOD_ORDER.sendingReassumivelMs;
      if (!velho) return res("EM_ENVIO", acao, pedido);
      // Outra ação está sendo enviada (ou foi interrompida): NUNCA se sobrepõe. Uma interrompida pode ter sido processada => incerta.
      if (estado === `${acao}_sending` ? !permitirReenvioIncerto : !substituirPendente) {
        return res("AGUARDANDO_EVENTO", acao, pedido, { incerto: true, motivo: "envio_interrompido", pendente: estado.split("_")[0] });
      }
    } else if (estado.endsWith("_requested")) {
      // Outra ação JÁ ACEITA pelo iFood e ainda sem o evento oficial (ou com resultado incerto). Sobrescrever o action_state perderia
      // essa informação, então NENHUMA ação começa por cima dela. Exceção explícita: `substituirPendente`, e só depois de
      // IFOOD_ORDER.reenvioIncertoAposMs sem evento (a ação anterior fica preservada nos carimbos <acao>_requested_at e na auditoria).
      const pendente = estado.split("_")[0];
      const momento = ms(pedido.action_requested_at) || ms(pedido[`${pendente}_requested_at`]) || nowMs();
      const podeSubstituir = substituirPendente && nowMs() - momento >= IFOOD_ORDER.reenvioIncertoAposMs;
      if (!podeSubstituir) {
        return res("AGUARDANDO_EVENTO", acao, pedido, { incerto: !!pedido.action_uncertain, motivo: pedido.action_uncertain ? "acao_incerta_pendente" : "acao_pendente", pendente });
      }
    }

    // Motivo de cancelamento: validado contra a lista OFICIAL (GET) — antes de reservar qualquer estado.
    let motivoOficial = null;
    const conexao = await repo.obterConexaoAtivaDoMerchant({ organizacaoId, unidadeId, merchantId: pedido.merchant_id });
    if (!conexao) throw ifoodErro(IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA);
    if (acao === "cancel") {
      const codigo = String(motivo ?? "").trim();
      if (!codigo) throw ifoodErro(IFOOD_ERROS.IFOOD_MOTIVO_CANCELAMENTO_INVALIDO, { detalhes: { motivo: "sem_motivo" } });
      const lista = await comToken(token, conexao.id, http, (accessToken) => client.listarMotivosCancelamento({ accessToken, orderId, http }));
      motivoOficial = lista.find((r) => r.code === codigo) ?? null;
      if (!motivoOficial) {
        throw ifoodErro(IFOOD_ERROS.IFOOD_MOTIVO_CANCELAMENTO_INVALIDO, { detalhes: { motivo: lista.length ? "fora_da_lista_oficial" : "sem_politica_de_cancelamento" } });
      }
    }

    // ---- reserva (compare-and-set) ----
    const tAntes = agora().toISOString();
    const tentativa = estado.startsWith(`${acao}_`) ? (pedido.action_attempts ?? 0) + 1 : 1;
    const campoSolicitado = `${acao}_requested_at`;
    const reservou = await repo.atualizarPedido({
      pedido,
      campos: {
        action_state: `${acao}_sending`, action_attempts: tentativa, action_requested_at: tAntes, action_uncertain: false, action_last_error: null,
        [campoSolicitado]: pedido[campoSolicitado] ?? tAntes,
        ...(motivoOficial ? { cancel_reason_code: motivoOficial.code, cancel_reason_description: motivoOficial.description } : {}),
      },
      condicoes: { action_state: estado, status_oficial: pedido.status_oficial ?? null },
    });
    if (!reservou) {                                            // perdeu a corrida (ex.: o evento oficial chegou): relê e reavalia
      pedido = await repo.obterPedidoDoTenant({ organizacaoId, unidadeId, orderId });
      if (!pedido) throw ifoodErro(IFOOD_ERROS.IFOOD_PEDIDO_LOCAL_NAO_ENCONTRADO);
      continue;
    }

    // ---- envia (UMA vez) ----
    const requestPayload = acao === "cancel" ? sanitizarParaAuditoria({ cancellationCode: motivoOficial.code, reason: motivoOficial.description ?? motivoOficial.code })
      : acao === "dispatch" ? sanitizarParaAuditoria({ deliveredBy: pedido.delivery_by }) : null;
    const base = { conexaoId: conexao.id, tentativa, requestedAt: tAntes, requestPayload };
    // Por que o iFood recusou (code/message do corpo do erro), quando houver — para a auditoria explicar a recusa.
    const motivoDoIfood = (e) => [e?.details?.ifoodCode, e?.details?.ifoodMessage].filter(Boolean).join(": ") || null;
    const enviar = (accessToken) => (acao === "ready" ? client.notificarPedidoPronto({ accessToken, orderId, http })
      : acao === "dispatch" ? client.despacharPedido({ accessToken, orderId, deliveredBy: pedido.delivery_by, http })
        : client.solicitarCancelamento({ accessToken, orderId, reason: motivoOficial.code, descricao: motivoOficial.description, http }));

    let envio;
    try {
      envio = await comToken(token, conexao.id, http, enviar);
    } catch (e) {
      const tDepois = agora().toISOString();
      const httpStatus = e?.details?.status ?? null;
      if (classificarFalhaDeAcao(e) === "incerto") {
        await repo.atualizarPedido({
          pedido,
          campos: { action_state: `${acao}_requested`, action_uncertain: true, action_last_error: String(e?.codigo ?? "ERRO_DESCONHECIDO").slice(0, 100), action_http_status: httpStatus },
          condicoes: { action_state: `${acao}_sending` },
        });
        await auditar(pedido, "INCERTO", { ...base, respondedAt: tDepois, httpStatus, erroCodigo: e?.codigo ?? null, erroMensagem: mensagemSegura(e) });
        log("warn", "order.acao_incerta", { orderId, acao, codigo: e?.codigo ?? null });
        const atual = await repo.obterPedidoDoTenant({ organizacaoId, unidadeId, orderId });
        return res("AGUARDANDO_EVENTO", acao, atual ?? pedido, { incerto: true, motivo: "timeout_ou_falha_de_rede" });
      }
      await repo.atualizarPedido({
        pedido,
        campos: { action_state: `${acao}_failed`, action_last_error: String(e?.codigo ?? "ERRO").slice(0, 100), action_http_status: httpStatus, action_uncertain: false },
        condicoes: { action_state: `${acao}_sending` },
      });
      await auditar(pedido, e?.codigo === IFOOD_ERROS.IFOOD_ACAO_PEDIDO_RECUSADA ? "RECUSADA" : "FALHOU",
        { ...base, respondedAt: tDepois, httpStatus, erroCodigo: e?.codigo ?? null, erroMensagem: motivoDoIfood(e) ?? mensagemSegura(e) });
      log("warn", "order.acao_falhou", { orderId, acao, codigo: e?.codigo ?? null, ifoodCode: e?.details?.ifoodCode ?? null });
      throw e;
    }

    const tDepois = agora().toISOString();
    if (!envio.aceito) {
      await repo.atualizarPedido({
        pedido, campos: { action_state: `${acao}_failed`, action_last_error: "RESPOSTA_NAO_ACEITA", action_http_status: envio.status ?? null, action_uncertain: false },
        condicoes: { action_state: `${acao}_sending` },
      });
      await auditar(pedido, "FALHOU", { ...base, respondedAt: tDepois, httpStatus: envio.status ?? null, erroCodigo: "RESPOSTA_NAO_ACEITA" });
      throw ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA, { detalhes: { status: envio.status } });
    }

    // HTTP aceito: registra a INTENÇÃO. NÃO é o estado oficial. CAS: se o evento já chegou, ele resolveu a ação (none) e não a sobrescrevemos.
    const gravou = await repo.atualizarPedido({
      pedido, campos: { action_state: `${acao}_requested`, action_http_status: envio.status, action_last_error: null, action_uncertain: false },
      condicoes: { action_state: `${acao}_sending` },
    });
    await auditar(pedido, envio.status === 202 ? "ACEITA_202" : "ACEITA", { ...base, respondedAt: tDepois, httpStatus: envio.status, responsePayload: sanitizarParaAuditoria({ status: "ACCEPTED" }) });
    const atual = await repo.obterPedidoDoTenant({ organizacaoId, unidadeId, orderId });
    log("info", "order.acao_solicitada", { orderId, acao, httpStatus: envio.status, actionState: atual?.action_state ?? null, statusOficial: atual?.status_oficial ?? null, eventoJaChegou: !gravou });
    return res("SOLICITADO", acao, atual ?? pedido, { httpStatus: envio.status, tentativa, eventoJaChegou: !gravou });
  }
  throw estadoInvalido({ motivo: "corrida_persistente" });
}

const base = (p) => ({ client: orderClient, agora: () => new Date(), log: ifoodLog, ...p });

/** POST /readyToPickup. Elegível: CONFIRMED (ou SEPARATION_STARTED) e tipo TAKEOUT/DINE_IN/DELIVERY. */
export const notificarPronto = (p) => executarAcao({ acao: "ready", ...base(p) });

/** POST /dispatch. Só DELIVERY com entrega própria e DEPOIS do evento READY_TO_PICKUP (nenhum POST antes disso). */
export const despachar = (p) => executarAcao({ acao: "dispatch", ...base(p) });

/** POST /requestCancellation com um motivo OFICIAL (`motivo` = code de GET /cancellationReasons). O estado só vira CANCELLED pelo evento. */
export const cancelar = (p) => executarAcao({ acao: "cancel", ...base(p) });
