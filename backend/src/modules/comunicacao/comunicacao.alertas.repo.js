// comunicacao_alertas — I/O. A UNIQUE NULLS NOT DISTINCT da migration 082
// é a autoridade real do dedup; este arquivo só decide o que fazer diante
// de "já existe" (nada, ou escalonar severidade) vs. "não existe" (criar).

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import { STATUS_ALERTA, STATUS_ALERTA_ATIVOS } from "./comunicacao.constants.js";

/**
 * Busca o alerta ATIVO (não resolvido/cancelado) para esta chave lógica,
 * se existir. `unidadeId`/`destinatarioPerfilId` nulos são tratados
 * explicitamente com `.is(...)` — o Supabase JS não trata `null` em
 * `.eq()` como "IS NULL".
 * @param {{organizacaoId: string, unidadeId: string|null, tipoAlerta: string, dataReferencia: string, destinatarioPerfilId: string|null}} chave
 */
export async function buscarAlertaAtivo(chave, deps = {}) {
  const db = deps.supabase ?? supabase;
  let q = db.from("comunicacao_alertas").select("*")
    .eq("organizacao_id", chave.organizacaoId)
    .eq("tipo_alerta", chave.tipoAlerta)
    .eq("data_referencia", chave.dataReferencia)
    .in("status", STATUS_ALERTA_ATIVOS);
  q = chave.unidadeId ? q.eq("unidade_id", chave.unidadeId) : q.is("unidade_id", null);
  q = chave.destinatarioPerfilId ? q.eq("destinatario_perfil_id", chave.destinatarioPerfilId) : q.is("destinatario_perfil_id", null);
  const { data, error } = await q.maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return data;
}

/**
 * Cria o alerta se a chave lógica ainda não tem um ATIVO; se já existe e a
 * severidade mudou, escalona (atualiza severidade + guarda histórico em
 * `metadados`) SEM criar uma segunda linha — "mesma pendência processada
 * duas vezes gera um único alerta" (teste 4), com escalonamento permitido.
 * @param {{organizacaoId, unidadeId, tipoAlerta, dataReferencia, destinatarioPerfilId, severidade, motivo}} params
 * @returns {Promise<{alerta: object, criado: boolean, escalonado: boolean}>}
 */
export async function criarOuEscalonarAlerta(params, deps = {}) {
  const db = deps.supabase ?? supabase;
  const chave = {
    organizacaoId: params.organizacaoId, unidadeId: params.unidadeId ?? null,
    tipoAlerta: params.tipoAlerta, dataReferencia: params.dataReferencia,
    destinatarioPerfilId: params.destinatarioPerfilId ?? null,
  };
  const existente = await buscarAlertaAtivo(chave, deps);

  if (!existente) {
    const { data, error } = await db.from("comunicacao_alertas").insert({
      organizacao_id: chave.organizacaoId, unidade_id: chave.unidadeId,
      tipo_alerta: chave.tipoAlerta, data_referencia: chave.dataReferencia,
      destinatario_perfil_id: chave.destinatarioPerfilId,
      severidade: params.severidade, motivo: params.motivo ?? null,
      status: STATUS_ALERTA.DETECTED,
    }).select("*").single();
    if (error) {
      // corrida: outro processo criou com a MESMA chave entre o SELECT e o INSERT
      // — a UNIQUE do banco barra a duplicata; buscamos o que já existe.
      if (String(error.code) === "23505") {
        const jaExiste = await buscarAlertaAtivo(chave, deps);
        if (jaExiste) return { alerta: jaExiste, criado: false, escalonado: false };
      }
      throw ApiError.internal(error.message);
    }
    await auditar({
      acao: ACOES.COMUNICACAO_ALERTA_CRIADO, atorTipo: "sistema",
      organizacaoId: chave.organizacaoId, entidade: "comunicacao_alertas", entidadeId: data.id,
      detalhes: { tipo_alerta: chave.tipoAlerta, unidade_id: chave.unidadeId, severidade: params.severidade },
    });
    return { alerta: data, criado: true, escalonado: false };
  }

  if (existente.severidade !== params.severidade) {
    const historico = [...(existente.metadados?.historico_severidade ?? []), { de: existente.severidade, para: params.severidade, em: new Date().toISOString() }];
    const { data, error } = await db.from("comunicacao_alertas")
      .update({ severidade: params.severidade, motivo: params.motivo ?? existente.motivo, metadados: { ...existente.metadados, historico_severidade: historico } })
      .eq("id", existente.id).select("*").single();
    if (error) throw ApiError.internal(error.message);
    return { alerta: data, criado: false, escalonado: true };
  }

  return { alerta: existente, criado: false, escalonado: false };
}

/** Marca um alerta como RESOLVIDO — a pendência que o originou deixou de existir. */
export async function resolverAlerta(alertaId, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_alertas")
    .update({ status: STATUS_ALERTA.RESOLVED, resolvido_em: new Date().toISOString() })
    .eq("id", alertaId).select("organizacao_id").single();
  if (error) throw ApiError.internal(error.message);
  await auditar({ acao: ACOES.COMUNICACAO_ALERTA_RESOLVIDO, atorTipo: "sistema", organizacaoId: data?.organizacao_id ?? null, entidade: "comunicacao_alertas", entidadeId: alertaId });
}

/** @param {string} alertaId @param {string} motivo */
export async function cancelarAlerta(alertaId, motivo, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_alertas")
    .update({ status: STATUS_ALERTA.CANCELLED, cancelado_em: new Date().toISOString(), motivo_cancelamento: motivo })
    .eq("id", alertaId).select("organizacao_id").single();
  if (error) throw ApiError.internal(error.message);
  await auditar({ acao: ACOES.COMUNICACAO_ALERTA_CANCELADO, atorTipo: "sistema", organizacaoId: data?.organizacao_id ?? null, entidade: "comunicacao_alertas", entidadeId: alertaId, detalhes: { motivo } });
}

/** @param {string} alertaId @param {string} status */
export async function atualizarStatusAlerta(alertaId, status, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { error } = await db.from("comunicacao_alertas").update({ status }).eq("id", alertaId);
  if (error) throw ApiError.internal(error.message);
}

/**
 * Alertas ATIVOS. `organizacaoId` omitido/null = TODAS as organizações —
 * usado por `agendarEnviosPendentes` (a distribuição de horários é
 * GLOBAL, entre toda a frota, não por empresa — evita rajada na conexão
 * de WhatsApp inteira, não só dentro de uma organização). Com
 * `organizacaoId`, escopado a ela — usado por
 * `detectarESincronizarAlertas` para varrer "o que sumiu" org a org.
 * @param {{organizacaoId?: string|null, tipoAlerta: string}} params
 */
export async function listarAlertasAtivos({ organizacaoId = null, tipoAlerta }, deps = {}) {
  const db = deps.supabase ?? supabase;
  let q = db.from("comunicacao_alertas").select("*").eq("tipo_alerta", tipoAlerta).in("status", STATUS_ALERTA_ATIVOS);
  if (organizacaoId) q = q.eq("organizacao_id", organizacaoId);
  const { data, error } = await q;
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

/** @param {string} id */
export async function obterAlerta(id, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_alertas").select("*").eq("id", id).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return data;
}
