// Checklist Operacional — resumo operacional da unidade (somente leitura, somente banco local).
//
// Não chama a API do iFood, não liga polling, não muda estado. Junta:
//   1. o vínculo oficial unidade ↔ loja iFood (ifood_conexoes + credencial `order`);
//   2. o sinal de vida do recebimento (lease do poller + último evento DESTA loja);
//   3. os pedidos do tenant em `ifood_pedidos`, calculados por checklistOperacional.calc.js.
//
// O tenant vem SEMPRE do Context Token (req.tenant). Nenhum id de unidade ou merchant vem do navegador.
//
// ESTADO DA INTEGRAÇÃO — separa "não há pedidos" de "não há integração":
//   nao_ativada    sem loja vinculada, sem credencial Order, ou o recebimento nunca rodou para esta loja
//   desatualizado  havia recebimento, mas parou (lease vencido) ou a credencial pede nova autorização
//   ao_vivo        o poller renovou o lease há pouco
// Os pedidos já persistidos aparecem em QUALQUER estado — o selo diz se eles ainda refletem a operação.

import * as repo from "./checklistOperacional.repository.js";
import * as ifoodRepo from "../ifood/ifood.repository.js";
import { orderLiberadoParaUnidade } from "../ifood/ifoodToken.service.js";
import { montarResumo, diaOperacional, LIMITE_ATIVO_MIN } from "./checklistOperacional.calc.js";
import { EVENTO_PEDIDOS_ATUALIZADOS, checklistRealtimeHabilitado } from "../ifood/ifoodPedidosAviso.js";

export const VERSAO_CONTRATO = 1;
/** Lease renovado a cada ciclo (30 s). Sem renovação por mais que isto, o recebimento é tratado como parado. */
export const LIMITE_SINCRONIZACAO_S = 120;
/** Intervalo que a tela usa para consultar de novo (polling de segurança; o Realtime só antecipa). */
export const INTERVALO_ATUALIZACAO_S = 30;

const MENSAGENS = {
  sem_loja_vinculada: "Esta unidade ainda não tem uma loja iFood vinculada à Central.",
  sem_credencial_order: "A loja não autorizou o aplicativo de pedidos da Central.",
  tabelas_ausentes: "O recebimento de pedidos ainda não foi instalado neste ambiente.",
  recebimento_desligado: "O recebimento de pedidos do iFood ainda não foi ativado para esta loja.",
  recebimento_parado: "O recebimento de pedidos do iFood parou. Os números podem não refletir a operação atual.",
  reautorizacao_necessaria: "A autorização do iFood expirou. Os números podem não refletir a operação atual.",
};

const est = (estado, motivo, extra = {}) => ({ estado, motivo, mensagem: motivo ? MENSAGENS[motivo] : null, ...extra });

/**
 * PURA: estado da integração da unidade.
 * @param {{conexao: object|null, credencialOrder: object|null, observabilidade: object|null, agoraMs: number}} p
 */
export function derivarEstadoIntegracao({ conexao, credencialOrder, observabilidade, agoraMs }) {
  const ultimoEventoEm = observabilidade?.ultimoEvento ?? null;
  const base = { ultimaSincronizacao: null, ultimoEventoEm };
  if (!conexao || !conexao.merchant_id || !["ativa", "reauth_required"].includes(conexao.status)) return est("nao_ativada", "sem_loja_vinculada", base);
  if (!credencialOrder) return est("nao_ativada", "sem_credencial_order", base);
  if (conexao.status === "reauth_required" || credencialOrder.status === "reauth_required") {
    return est("desatualizado", "reautorizacao_necessaria", { ...base, ultimaSincronizacao: ultimoEventoEm });
  }
  if (!observabilidade?.disponivel) return est("nao_ativada", "tabelas_ausentes", base);

  const lease = observabilidade.lease;
  const renovado = lease ? Date.parse(lease.atualizadoEm) : NaN;
  const vigente = lease ? Date.parse(lease.leaseAte) > agoraMs : false;
  if (vigente && Number.isFinite(renovado) && agoraMs - renovado <= LIMITE_SINCRONIZACAO_S * 1000) {
    return est("ao_vivo", null, { ...base, ultimaSincronizacao: lease.atualizadoEm });
  }
  if (ultimoEventoEm) return est("desatualizado", "recebimento_parado", { ...base, ultimaSincronizacao: ultimoEventoEm });
  return est("nao_ativada", "recebimento_desligado", base);
}

/**
 * @param {{organizacaoId: string, unidadeId: string, agora?: () => Date,
 *          deps?: {repo?: object, ifoodRepo?: object, pilotoOrder?: (unidadeId: string) => boolean, env?: object}}} p
 */
export async function obterResumo({ organizacaoId, unidadeId, agora = () => new Date(), deps = {} }) {
  const r = deps.repo ?? repo;
  const ir = deps.ifoodRepo ?? ifoodRepo;
  const piloto = deps.pilotoOrder ?? orderLiberadoParaUnidade;
  const realtimeLigado = checklistRealtimeHabilitado(deps.env ?? process.env);
  const agoraMs = agora().getTime();

  const conexao = await ir.obterConexaoViva({ organizacaoId, unidadeId });
  let credencialOrder = null;
  let observabilidade = null;
  if (conexao?.id) {
    const credenciais = await ir.listarCredenciaisDaConexao({ conexaoId: conexao.id });
    credencialOrder = credenciais.find((c) => c.app_type === "order") ?? null;
    if (conexao.merchant_id) {
      observabilidade = await ir.obterObservabilidadeOrder({ organizacaoId, unidadeId, merchantId: conexao.merchant_id });
    }
  }
  const integracao = derivarEstadoIntegracao({ conexao, credencialOrder, observabilidade, agoraMs });

  // Janela: o dia operacional inteiro + a folga do "sem conclusão" (pedido de ontem ainda aberto aparece como alerta).
  const dia = diaOperacional(agoraMs);
  const desdeMs = Math.min(dia.inicioMs, agoraMs - LIMITE_ATIVO_MIN * 60_000) - 24 * 3_600_000;
  const semTabelas = integracao.motivo === "tabelas_ausentes";
  const desdeIso = new Date(desdeMs).toISOString();
  const [pedidos, abertosAntigos] = semTabelas ? [[], 0] : await Promise.all([
    r.listarPedidosDaJanela({ organizacaoId, unidadeId, desdeIso }),
    r.contarAbertosAntesDe({ organizacaoId, unidadeId, antesIso: desdeIso }),
  ]);

  const resumo = montarResumo({ pedidos, agoraMs });
  if (abertosAntigos > 0) {
    // Abertos desde antes da janela: continuam ATIVOS pelo estado oficial — entram na contagem e no alerta crítico.
    resumo.contagemDia.abertosForaDaJanela = abertosAntigos;
    resumo.contagemDia.emAndamento += abertosAntigos;
    resumo.contagemDia.semConclusao += abertosAntigos;
    const total = resumo.contagemDia.semConclusao;
    const alerta = resumo.alertas.find((a) => a.codigo === "pedidos_sem_conclusao");
    const texto = `${total} ${total === 1 ? "pedido aberto" : "pedidos abertos"} há mais de ${LIMITE_ATIVO_MIN / 60} h sem conclusão`;
    if (alerta) Object.assign(alerta, { quantidade: total, texto });
    else resumo.alertas.unshift({ codigo: "pedidos_sem_conclusao", nivel: "critico", quantidade: total, texto });
  } else {
    resumo.contagemDia.abertosForaDaJanela = 0;
  }
  if (pedidos.length >= (r.LIMITE_LINHAS ?? repo.LIMITE_LINHAS)) {
    resumo.alertas.push({ codigo: "janela_truncada", nivel: "atencao", quantidade: pedidos.length, texto: "Pedidos demais na janela: o resumo considera só os mais recentes" });
  }
  if ((observabilidade?.eventosComFalha ?? 0) > 0) {
    const n = observabilidade.eventosComFalha;
    resumo.alertas.push({ codigo: "eventos_com_falha", nivel: "atencao", quantidade: n, texto: `${n} ${n === 1 ? "evento do iFood não processado" : "eventos do iFood não processados"}` });
  }

  return {
    versao: VERSAO_CONTRATO,
    origem: "api",
    servidorEm: new Date(agoraMs).toISOString(),
    atualizarEmS: INTERVALO_ATUALIZACAO_S,
    integracao: { ...integracao, pilotoOrder: piloto(unidadeId) === true },
    semPedidosNoDia: resumo.contagemDia.recebidos === 0 && resumo.contagemDia.emAndamento === 0,
    ...resumo,
    avaliacoes: { disponivel: false, motivo: "As avaliações do iFood ainda não estão conectadas à Central." },
    // Realtime: o Events emite este evento SÓ no tópico privado da unidade depois de gravar um pedido; a tela,
    // ao receber (ou ao resincronizar), consulta este endpoint de novo. Payload: só tipo + organização + unidade.
    // Três coisas DIFERENTES, nunca confundidas:
    //   habilitado    a emissão de avisos está ligada (IFOOD_CHECKLIST_REALTIME_ENABLED, lida neste processo);
    //   avisosAtivos  habilitado E o recebimento está ao vivo — só assim existem avisos para chegar;
    //   (conexão do canal) quem sabe é a tela: "tempo real" só com avisosAtivos E o canal da unidade assinado.
    tempoReal: {
      habilitado: realtimeLigado,
      avisosAtivos: realtimeLigado && integracao.estado === "ao_vivo",
      topico: `unidade:${unidadeId}`,
      evento: EVENTO_PEDIDOS_ATUALIZADOS,
    },
  };
}
