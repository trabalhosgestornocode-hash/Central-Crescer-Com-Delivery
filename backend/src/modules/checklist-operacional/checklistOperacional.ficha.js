// Dashboard Operacional 2.0 — FICHA 360° DO PEDIDO (função pura: projeção + metas + disputas → ficha).
//
// Tudo vem da camada analítica (operacional_pedidos), que já não tem dado pessoal: a ficha não tem como mostrar cliente,
// endereço, telefone, documento, entregador, código de coleta/entrega nem texto de observação. Cada número diz de onde veio:
//   registrado   carimbo/valor que o iFood enviou (evento ou Order Details);
//   calculado    duração entre dois carimbos registrados (mesma régua do Checklist: medirPreparo/medirEntrega/medirVida);
//   indisponivel faltou um dos carimbos — o motivo é dito; nada é estimado.
// O identificador exibido é o número curto (displayId) e um prefixo do orderId — nunca o id completo.

import { medirPreparo, medirEntrega, medirVida, TETO_MIN } from "./checklistOperacional.calc.js";
import { metaVigenteEm } from "./checklistOperacional.metas.js";
import { paraLinhaDoChecklist } from "./checklistOperacional.projecao.js";

export const ROTULOS_EVENTO = Object.freeze({
  PLC: "Pedido recebido", CFM: "Confirmado", PRS: "Preparo iniciado (marcado no PDV)", RPS: "Início de preparo recomendado",
  RTP: "Pronto para retirada", SPS: "Separação iniciada", SPE: "Separação concluída",
  ADR: "Entregador atribuído", GTO: "Entregador a caminho da loja", AAO: "Entregador chegou à loja", CLT: "Pedido coletado",
  DSP: "Despachado", AAD: "Entregador chegou ao destino", CON: "Concluído (registrado pelo iFood)", CAN: "Cancelado",
  CAR: "Cancelamento solicitado", CARF: "Cancelamento recusado", HSD: "Disputa aberta", HSS: "Disputa encerrada",
  OPA: "Pedido alterado", CPT: "Tempo de preparo alterado pelo iFood", DDD: "Entregador desalocado",
  DRGO: "Entregador retornando à loja", DRDO: "Pedido devolvido à loja", DRCR: "Código de devolução solicitado",
  DDCR: "Código de entrega solicitado", DDCS: "Código de entrega validado", DPCR: "Código de coleta solicitado",
  DGA: "Entrega agrupada", DGAC: "Associado a grupo de entrega", DGD: "Grupo de entrega desfeito", DGDC: "Desassociado do grupo",
  DGU: "Grupo de entrega atualizado", RDR: "Entregador sob demanda solicitado", RDS: "Entregador sob demanda confirmado",
  DAR: "Alteração de endereço solicitada",
});

const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const MIN = 60_000;
const arred = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

/** Intervalo entre dois carimbos registrados (min) ou o motivo de não existir. */
function trecho(nome, ini, fim, { teto = 240, rotuloIni, rotuloFim, nota = null } = {}) {
  const a = ms(ini); const b = ms(fim);
  const base = { nome, inicio: rotuloIni, fim: rotuloFim, nota };
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { ...base, estado: "indisponivel", min: null, motivo: !Number.isFinite(a) ? `sem o carimbo "${rotuloIni}"` : `sem o carimbo "${rotuloFim}"` };
  const d = (b - a) / MIN;
  if (d < 0 || d > teto) return { ...base, estado: "indisponivel", min: null, motivo: "carimbos fora de ordem ou fora do limite plausível" };
  return { ...base, estado: "calculado", min: arred(d) };
}

const MOTIVO = Object.freeze({
  nao_delivery: "não é pedido de entrega (retirada fica fora dos tempos)", sem_detalhes: "sem detalhes do iFood",
  sem_saida: "sem o evento de despacho", nao_concluido: "pedido não concluído", inconsistente: "carimbos inconsistentes",
  carimbo_ausente: "falta um dos carimbos",
});

function medida(nome, m, meta, { inicio, fim }) {
  if (m.min == null) return { nome, inicio, fim, estado: "indisponivel", min: null, motivo: MOTIVO[m.motivo] ?? m.motivo, meta: meta ?? null, atraso: null };
  const min = arred(m.min);
  return { nome, inicio, fim, estado: "calculado", min, meta: meta ?? null, atraso: meta == null ? null : min > meta, excedenteMin: meta == null || min <= meta ? null : arred(min - meta) };
}

/**
 * @param {{projecao: object, linhaDoTempoMetas: object[], disputas?: object[], unidadeNome?: string|null}} p
 */
export function montarFicha({ projecao: p, linhaDoTempoMetas = [], disputas = [], unidadeNome = null }) {
  const linha = paraLinhaDoChecklist(p);
  const meta = metaVigenteEm(linhaDoTempoMetas, ms(p.plc_em ?? p.pedido_criado_em));
  const m = (e) => meta?.valores?.[e]?.meta ?? null;
  const preparo = medida("Preparo", medirPreparo(linha), m("preparo"), { inicio: "recebido (PLACED)", fim: "despachado (DISPATCHED)" });
  const entrega = medida("Entrega", medirEntrega(linha), m("entrega"), { inicio: "despachado (DISPATCHED)", fim: "concluído (CONCLUDED)" });
  const vida = medida("Vida do pedido", medirVida(linha), m("vida"), { inicio: "recebido (PLACED)", fim: "concluído (CONCLUDED)" });

  const codigosVistos = new Set((p.linha_do_tempo ?? []).map((e) => e.codigo));
  const etapasEsperadas = p.order_type === "DELIVERY"
    ? ["PLC", "CFM", "RTP", "DSP", "CON", ...(p.delivery_by === "IFOOD" ? ["ADR", "AAO", "CLT"] : [])]
    : p.order_type === "TAKEOUT" ? ["PLC", "CFM", "RTP", "CON"] : ["PLC", "CFM", "CON"];
  const terminal = p.status_oficial === "CANCELLED" || p.status_oficial === "CONCLUDED";

  return {
    identificacao: {
      chave: p.chave,
      numero: p.display_id ?? null,
      idParcial: p.order_id ? `${String(p.order_id).slice(0, 8)}…` : null,
      unidade: unidadeNome,
      recebidoEm: p.plc_em ?? p.pedido_criado_em ?? null,
      recebidoFonte: p.plc_em ? "evento PLACED" : p.pedido_criado_em ? "createdAt do pedido (sem PLACED)" : null,
      modalidade: p.order_type ?? null,
      logistica: p.delivery_by ?? null,
      modoEntrega: p.delivery_mode ?? null,
      agendado: p.order_timing === "SCHEDULED",
      status: p.status_oficial ?? null,
      origem: p.sales_channel ?? null,
      teste: p.is_test === true,
    },
    produtos: {
      disponivel: Array.isArray(p.itens),
      quantidadeDeItens: p.itens_qtd,
      itens: p.itens ?? [],
      observacoes: "O texto das observações do cliente não é exibido (pode conter dado pessoal); só a existência.",
      desatualizado: p.detalhes_desatualizados === true,
    },
    financeiro: {
      natureza: "Valores OPERACIONAIS do pedido (Order Details). Não são repasse líquido: taxas, comissões e repasse estão no Financial.",
      disponivel: p.valor_total != null,
      itens: p.valor_itens, taxaEntrega: p.valor_taxa_entrega, taxasAdicionais: p.valor_taxas_adicionais,
      descontos: p.valor_descontos, total: p.valor_total,
      patrocinioDescontos: { loja: p.desconto_loja, ifood: p.desconto_ifood, rede: p.desconto_rede, externo: p.desconto_externo },
      pagamento: { metodos: p.pagamento_metodos ?? [], naEntrega: p.pagamento_na_entrega },
    },
    historico: {
      linhaDoTempo: (p.linha_do_tempo ?? []).map((e) => ({ ...e, rotulo: ROTULOS_EVENTO[e.codigo] ?? `Evento ${e.codigo}` })),
      etapasSemRegistro: terminal ? etapasEsperadas.filter((c) => !codigosVistos.has(c) && !(p.status_oficial === "CANCELLED" && ["DSP", "CON", "RTP", "ADR", "AAO", "CLT"].includes(c)))
        .map((c) => ({ codigo: c, rotulo: ROTULOS_EVENTO[c] })) : [],
      alteracoes: { quantidade: p.alteracoes ?? 0, ultimaEm: p.ultima_alteracao_em ?? null },
      eventosRegistrados: p.eventos_qtd ?? 0,
    },
    indicadores: {
      metaVersao: meta?.versao ?? null,
      metaNota: meta ? "Meta vigente no recebimento do pedido." : "Sem meta vigente no recebimento: o pedido não é avaliado contra meta.",
      confirmacao: trecho("Confirmação", p.plc_em, p.cfm_em, { rotuloIni: "recebido", rotuloFim: "confirmado", teto: TETO_MIN.preparo }),
      preparo,
      ateOPronto: trecho("Até o pronto", p.plc_em, p.rtp_em, { rotuloIni: "recebido", rotuloFim: "pronto", teto: TETO_MIN.preparo, nota: "Depende de a loja marcar \"pronto\" no PDV." }),
      esperaEntregador: trecho("Espera do entregador na loja", p.aao_em, p.clt_em, { rotuloIni: "entregador chegou", rotuloFim: "coletado", nota: "Só existe com logística iFood." }),
      prontoAteColeta: trecho("Pronto até a coleta", p.rtp_em, p.clt_em, { rotuloIni: "pronto", rotuloFim: "coletado", nota: "Só existe com logística iFood e com o pronto marcado." }),
      entrega,
      vida,
      atrasos: [preparo, entrega, vida].filter((x) => x.atraso).map((x) => ({ etapa: x.nome, min: x.min, meta: x.meta, excedenteMin: x.excedenteMin })),
      nota: "Os horários mostram ONDE o tempo passou; não indicam quem causou o atraso.",
    },
    ocorrencias: {
      cancelamento: p.status_oficial === "CANCELLED" || p.can_em ? {
        em: p.can_em, codigo: p.cancel_codigo, descricao: p.cancel_descricao, origem: p.cancel_origem, estagio: p.cancel_estagio,
        fonte: p.cancel_codigo ? "evento CANCELLED (oficial)" : "motivo não informado pelo iFood",
      } : null,
      disputas: (disputas ?? []).map((d) => ({
        tipo: d.handshake_type ?? null, acao: d.action ?? null, abertaEm: d.dispute_created_at ?? null, venceEm: d.expires_at ?? null,
        desfecho: d.settlement_status ?? null, desfechoEm: d.settlement_at ?? null, situacao: d.status ?? null,
      })),
      devolucao: codigosVistos.has("DRGO") || codigosVistos.has("DRDO") ? { emRetorno: codigosVistos.has("DRGO"), devolvido: codigosVistos.has("DRDO") } : null,
      atrasos: [preparo, entrega, vida].filter((x) => x.atraso).length,
      integridade: p.integridade ?? [],
    },
    rastreabilidade: {
      fonte: "operacional_pedidos (derivada de ifood_pedidos + ifood_eventos)",
      regraVersao: p.regra_versao,
      projetadoEm: p.projetado_em ?? null,
      detalhesAtualizadosEm: p.fonte?.detalhesAtualizadoEm ?? null,
      ultimoEventoRecebidoEm: p.fonte?.ultimoEventoRecebidoEm ?? null,
      fonteHash: p.fonte_hash ? String(p.fonte_hash).slice(0, 12) : null,
    },
  };
}

/** Item da lista "Pedidos" (sem dado pessoal): o suficiente para escolher qual ficha abrir. */
export function itemDaLista(p, linhaDoTempoMetas = []) {
  const linha = paraLinhaDoChecklist(p);
  const meta = metaVigenteEm(linhaDoTempoMetas, ms(p.plc_em ?? p.pedido_criado_em));
  const prep = medirPreparo(linha); const ent = medirEntrega(linha); const vida = medirVida(linha);
  const acima = (x, e) => x.min != null && meta?.valores?.[e]?.meta != null && x.min > meta.valores[e].meta;
  return {
    chave: p.chave, numero: p.display_id ?? null, recebidoEm: p.plc_em ?? p.pedido_criado_em ?? null,
    status: p.status_oficial ?? null, modalidade: p.order_type ?? null, logistica: p.delivery_by ?? null,
    preparoMin: arred(prep.min), entregaMin: arred(ent.min), vidaMin: arred(vida.min),
    atrasado: acima(prep, "preparo") || acima(ent, "entrega") || acima(vida, "vida"),
    total: p.valor_total ?? null, cancelado: p.status_oficial === "CANCELLED",
    problemas: (p.integridade ?? []).length, alterado: (p.alteracoes ?? 0) > 0, teste: p.is_test === true,
  };
}
