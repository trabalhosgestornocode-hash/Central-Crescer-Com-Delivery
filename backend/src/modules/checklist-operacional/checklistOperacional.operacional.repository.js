// Dashboard Operacional 2.0 — acesso ao banco da camada analítica, dos fechamentos e das simulações (migration 130).
//
// Toda leitura "do tenant" filtra organizacao_id + unidade_id; o tenant vem sempre do Context Token (nunca do navegador).
// ifood_pedidos / ifood_eventos / ifood_disputas são só LIDOS aqui (o poller e o ACK não são tocados). `db` é injetável
// para os testes. Sem a migration 130, as funções que tocam tabelas novas lançam erro com `codigo = OPERACIONAL_INDISPONIVEL`
// (o service devolve 503 e o Dashboard/Checklist atuais seguem funcionando).

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

const LOTE = 200;
export const LIMITE_PEDIDOS_JANELA = 3000;

/** Colunas de ifood_pedidos necessárias para projetar (inclui o Details bruto — só o backend lê; nada disso sai em resposta). */
export const COLUNAS_FONTE = [
  "order_id", "organizacao_id", "unidade_id", "merchant_id", "display_id", "order_type", "order_timing", "delivery_by",
  "sales_channel", "is_test", "status_oficial", "status_oficial_em", "order_created_at", "preparation_start_at",
  "placed_event_created_at", "confirmed_event_at", "ready_event_at", "dispatch_event_at", "cancel_event_at",
  "total_sub_total", "total_delivery_fee", "total_additional_fees", "total_benefits", "total_order_amount",
  "details_payload", "details_payload_hash", "details_atualizado_em", "details_status", "atualizado_em",
].join(", ");

/** Colunas de ifood_disputas SEM texto do cliente (message/evidences/dispute_payload nunca são lidos aqui). */
export const COLUNAS_DISPUTA = "order_id, status, action, handshake_type, expires_at, timeout_action, dispute_created_at, criado_em, settlement_status, settlement_at";

const tabelaAusente = (e) => e && (e.code === "42P01" || e.code === "PGRST205" || /operacional_/.test(e.message ?? "") && /does not exist|schema cache/i.test(e.message ?? ""));

function ok({ data, error }) {
  if (error) {
    if (tabelaAusente(error)) {
      const e = ApiError.internal("Camada operacional indisponível neste ambiente (migration 130 pendente).");
      e.codigo = "OPERACIONAL_INDISPONIVEL";
      throw e;
    }
    throw ApiError.internal(error.message);
  }
  return data;
}

const exigirTenant = (o, u) => { if (!o || !u) throw ApiError.internal("Escopo de tenant ausente na consulta operacional."); };
function emLotes(xs, n = LOTE) { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; }

// ------------------------------------------------------------------------------------------------------------------------
// Fontes (somente leitura)
// ------------------------------------------------------------------------------------------------------------------------

/** order_id + atualizado_em dos pedidos do tenant registrados na janela (barato: sem JSON). */
export async function listarVersoesDaFonte({ organizacaoId, unidadeId, desdeIso, ateIso, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await db.from("ifood_pedidos").select("order_id, atualizado_em")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .gte("criado_em", desdeIso).lt("criado_em", ateIso)
    .order("criado_em", { ascending: true }).limit(LIMITE_PEDIDOS_JANELA)) ?? [];
}

/** Pedidos completos (com Details) por order_id, SEMPRE restritos ao tenant. */
export async function listarPedidosFonte({ organizacaoId, unidadeId, orderIds, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  const out = [];
  for (const lote of emLotes(orderIds ?? [])) {
    out.push(...(ok(await db.from("ifood_pedidos").select(COLUNAS_FONTE)
      .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).in("order_id", lote)) ?? []));
  }
  return out;
}

/** Eventos dos pedidos: só código, horários e o metadata (o service usa só CAN/OPA; o resto nunca é copiado). */
export async function listarEventosDosPedidos({ organizacaoId, unidadeId, orderIds, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  const out = [];
  for (const lote of emLotes(orderIds ?? [])) {
    out.push(...(ok(await db.from("ifood_eventos").select("event_id, order_id, event_code, event_created_at, received_at, metadata:payload->metadata")
      .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).in("order_id", lote)) ?? []));
  }
  return out;
}

/**
 * Pedidos do tenant com evento recebido depois de `desdeIso` (eventos fora de ordem não mexem em ifood_pedidos).
 * @returns {Promise<Map<string, string>>} order_id → maior received_at encontrado (relógio do banco)
 */
export async function listarPedidosComEventoNovo({ organizacaoId, unidadeId, orderIds, desdeIso, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  const out = new Map();
  for (const lote of emLotes(orderIds ?? [])) {
    for (const r of ok(await db.from("ifood_eventos").select("order_id, received_at")
      .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).in("order_id", lote).gt("received_at", desdeIso)) ?? []) {
      const atual = out.get(r.order_id);
      if (!atual || Date.parse(r.received_at) > Date.parse(atual)) out.set(r.order_id, r.received_at);
    }
  }
  return out;
}

/** Disputas do tenant relevantes para a janela (abertas ou com desfecho nela) ou ainda pendentes. */
export async function listarDisputasDaJanela({ organizacaoId, unidadeId, desdeIso, ateIso, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await db.from("ifood_disputas").select(COLUNAS_DISPUTA)
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .or(`and(dispute_created_at.gte.${desdeIso},dispute_created_at.lt.${ateIso}),and(criado_em.gte.${desdeIso},criado_em.lt.${ateIso}),and(settlement_at.gte.${desdeIso},settlement_at.lt.${ateIso}),settlement_status.is.null`)
    .limit(1000)) ?? [];
}

export async function listarDisputasDoPedido({ organizacaoId, unidadeId, orderId, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await db.from("ifood_disputas").select(COLUNAS_DISPUTA)
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).eq("order_id", orderId).limit(50)) ?? [];
}

/** Cobertura: quantos eventos do tenant têm horário oficial dentro da janela e o último recebimento. */
export async function sinaisDeRecebimento({ organizacaoId, unidadeId, desdeIso, ateIso, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  const [noDia, ultimo] = await Promise.all([
    db.from("ifood_eventos").select("event_id", { count: "exact", head: true })
      .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).gte("event_created_at", desdeIso).lt("event_created_at", ateIso),
    db.from("ifood_eventos").select("received_at").eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
      .order("received_at", { ascending: false }).limit(1),
  ]);
  if (noDia.error) throw ApiError.internal(noDia.error.message);
  return { eventosNoDia: noDia.count ?? 0, ultimoEventoRecebidoEm: ok(ultimo)?.[0]?.received_at ?? null };
}

// ------------------------------------------------------------------------------------------------------------------------
// Projeção
// ------------------------------------------------------------------------------------------------------------------------

export async function listarProjetadoEm({ organizacaoId, unidadeId, orderIds, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  const out = [];
  for (const lote of emLotes(orderIds ?? [])) {
    out.push(...(ok(await db.from("operacional_pedidos").select("order_id, projetado_em, regra_versao, fonte_hash, fonte")
      .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).in("order_id", lote)) ?? []));
  }
  return out;
}

/** Upsert idempotente por order_id (o service só manda o que mudou). */
export async function gravarProjecoes(linhas, { db = supabase } = {}) {
  for (const lote of emLotes(linhas ?? [])) ok(await db.from("operacional_pedidos").upsert(lote, { onConflict: "order_id" }).select("order_id"));
}

/** Projeções do tenant com chegada, conclusão ou cancelamento dentro da janela. */
export async function listarProjecoesDaJanela({ organizacaoId, unidadeId, desdeIso, ateIso, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await db.from("operacional_pedidos").select("*")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .or(`and(plc_em.gte.${desdeIso},plc_em.lt.${ateIso}),and(con_em.gte.${desdeIso},con_em.lt.${ateIso}),and(can_em.gte.${desdeIso},can_em.lt.${ateIso})`)
    .order("plc_em", { ascending: false, nullsFirst: false }).limit(LIMITE_PEDIDOS_JANELA)) ?? [];
}

/** Uma projeção pela chave opaca, SÓ se for do tenant (outra unidade = inexistente). */
export async function obterProjecaoPorChave({ organizacaoId, unidadeId, chave, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await db.from("operacional_pedidos").select("*")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).eq("chave", chave).maybeSingle());
}

// ------------------------------------------------------------------------------------------------------------------------
// Fechamentos
// ------------------------------------------------------------------------------------------------------------------------

export async function registrarFechamento(p, { db = supabase } = {}) {
  const data = ok(await db.rpc("operacional_fechamento_registrar", {
    p_organizacao_id: p.organizacaoId, p_unidade_id: p.unidadeId, p_competencia: p.competencia, p_status: p.status,
    p_execucao_id: p.execucaoId, p_regra_versao: p.regraVersao, p_fuso: p.fuso, p_fuso_origem: p.fusoOrigem, p_origem: p.origem,
    p_gerado_por: p.geradoPor ?? null, p_motivo: p.motivo ?? null, p_fonte: p.fonte, p_cobertura: p.cobertura,
    p_indicadores: p.indicadores, p_diagnostico: p.diagnostico, p_pendencias: p.pendencias ?? [], p_hash: p.hash,
  }));
  const r = Array.isArray(data) ? data[0] : data;
  return { resultado: r?.resultado, id: r?.fechamento_id, versao: r?.versao_registrada, status: r?.status_registrado };
}

const COLUNAS_FECHAMENTO_LISTA = "id, competencia, versao, status, origem, gerado_em, motivo, regra_versao, hash_conteudo, substitui_id";

export async function listarFechamentos({ organizacaoId, unidadeId, competencia = null, limite = 60, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  let q = db.from("operacional_fechamentos").select(COLUNAS_FECHAMENTO_LISTA)
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId);
  if (competencia) q = q.eq("competencia", competencia);
  return ok(await q.order("competencia", { ascending: false }).order("versao", { ascending: false }).limit(limite)) ?? [];
}

export async function obterFechamento({ organizacaoId, unidadeId, id, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await db.from("operacional_fechamentos").select("*")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).eq("id", id).maybeSingle());
}

export async function obterUltimoFechamento({ organizacaoId, unidadeId, competencia, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await db.from("operacional_fechamentos").select("id, versao, status, hash_conteudo")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).eq("competencia", competencia)
    .order("versao", { ascending: false }).limit(1).maybeSingle());
}

// ------------------------------------------------------------------------------------------------------------------------
// Simulações de WhatsApp
// ------------------------------------------------------------------------------------------------------------------------

/** Insere a tentativa simulada; mesma chave = a já existente (nunca duplica). @returns {{linha, duplicada}} */
export async function registrarSimulacao(linha, { db = supabase } = {}) {
  const inseridas = ok(await db.from("operacional_mensagens_simuladas")
    .upsert(linha, { onConflict: "chave_idempotencia", ignoreDuplicates: true }).select("id"));
  const existente = ok(await db.from("operacional_mensagens_simuladas").select("*")
    .eq("organizacao_id", linha.organizacao_id).eq("unidade_id", linha.unidade_id)
    .eq("chave_idempotencia", linha.chave_idempotencia).maybeSingle());
  return { linha: existente, duplicada: (inseridas ?? []).length === 0 };
}

export async function listarSimulacoes({ organizacaoId, unidadeId, fechamentoId, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await db.from("operacional_mensagens_simuladas")
    .select("id, fechamento_id, fechamento_versao, status, transporte, tamanho, validacao, erro, criado_em, criado_por")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).eq("fechamento_id", fechamentoId)
    .order("criado_em", { ascending: false }).limit(50)) ?? [];
}
