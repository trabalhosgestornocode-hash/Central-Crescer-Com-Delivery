// Registro das solicitações de Reconciliation On Demand (requestId) por
// organização + unidade + conexão + competência.
//
// POR QUE EXISTE: o 409 do POST on-demand manda "reutilizar o requestId
// anterior", mas NÃO devolve esse requestId. Sem guardar o id no momento do
// POST, a Central não teria como retomar o acompanhamento (nem após reload).
//
// Tabela: ifood_financial_reconciliacoes_on_demand (migration 106) —
// backend-only (RLS sem policy), service_role. Uma linha por conexão +
// competência (a solicitação mais recente substitui a anterior). Validade
// de 24h = TTL do requestId documentado pelo iFood (404 depois disso).
//
// ISOLAMENTO: toda leitura/escrita filtra organizacao_id + unidade_id +
// conexao_id (mesma regra de ifood.repository.js — o backend usa
// service_role, então esta camada É o isolamento).
//
// IMPLANTAÇÃO SEM A MIGRATION: se a tabela ainda não existir no banco, cai
// num registro EM MEMÓRIA (mesmas chaves, mesmo isolamento) e registra um
// aviso. O fluxo continua funcionando, só não sobrevive a restart do
// processo. Nenhum outro erro de banco é engolido.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { ifoodLog } from "./ifood.logsafe.js";

const TABELA = "ifood_financial_reconciliacoes_on_demand";
export const VALIDADE_SOLICITACAO_MS = 24 * 60 * 60 * 1000;

function exigirChave({ organizacaoId, unidadeId, conexaoId }) {
  if (!organizacaoId || !unidadeId || !conexaoId) {
    throw ApiError.internal("Escopo de tenant ausente no registro de conciliação iFood.");
  }
}

// PostgREST: tabela inexistente -> PGRST205 (schema cache) / 42P01 (Postgres).
function tabelaAusente(error) {
  if (!error) return false;
  const msg = String(error.message ?? "");
  return error.code === "PGRST205" || error.code === "42P01" || /does not exist|could not find the table/i.test(msg);
}

// --- Fallback em memória (só quando a tabela não existe) -------------------
const memoria = new Map(); // `${org}|${uni}|${conexao}|${competencia}` -> registro
let avisouFallback = false;
const chaveMemoria = (k) => `${k.organizacaoId}|${k.unidadeId}|${k.conexaoId}|${k.competencia}`;
function usarFallback() {
  if (!avisouFallback) {
    avisouFallback = true;
    ifoodLog("warn", "financial.reconciliation.on_demand.registro_em_memoria", { tabela: TABELA, motivo: "tabela ausente — aplique a migration 106" });
  }
}
/** Só para testes: zera o fallback em memória. */
export function _limparMemoria() { memoria.clear(); avisouFallback = false; }

const vigente = (r, agora = Date.now()) => !!r && Date.parse(r.expira_em) > agora;

async function executar(consulta, fallback) {
  const res = await consulta();
  if (res.error) {
    if (tabelaAusente(res.error)) { usarFallback(); return fallback(); }
    throw ApiError.internal(res.error.message);
  }
  return res.data;
}

/**
 * Registra (ou substitui) a solicitação da conexão para a competência.
 * @param {{organizacaoId, unidadeId, conexaoId, competencia, merchantId, requestId, usuarioId?, db?}} p
 */
export async function registrar({ organizacaoId, unidadeId, conexaoId, competencia, merchantId, requestId, usuarioId, db = supabase }) {
  exigirChave({ organizacaoId, unidadeId, conexaoId });
  const agora = new Date();
  const linha = {
    organizacao_id: organizacaoId, unidade_id: unidadeId, conexao_id: conexaoId,
    merchant_id: merchantId, competencia, request_id: requestId,
    status: "solicitado", mensagem_erro: null,
    solicitado_por: usuarioId ?? null,
    solicitado_em: agora.toISOString(),
    expira_em: new Date(agora.getTime() + VALIDADE_SOLICITACAO_MS).toISOString(),
  };
  return executar(
    () => db.from(TABELA).upsert(linha, { onConflict: "conexao_id,competencia" }).select().single(),
    () => { memoria.set(chaveMemoria({ organizacaoId, unidadeId, conexaoId, competencia }), { ...linha }); return { ...linha }; },
  );
}

/** Solicitação ainda válida (< 24h) da conexão para a competência, ou null. */
export async function obterVigente({ organizacaoId, unidadeId, conexaoId, competencia, db = supabase }) {
  exigirChave({ organizacaoId, unidadeId, conexaoId });
  const r = await executar(
    () => db.from(TABELA).select("*")
      .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).eq("conexao_id", conexaoId)
      .eq("competencia", competencia).maybeSingle(),
    () => memoria.get(chaveMemoria({ organizacaoId, unidadeId, conexaoId, competencia })) ?? null,
  );
  return vigente(r) ? r : null;
}

/** Solicitação pelo requestId — SÓ se pertence a esta org + unidade + conexão. */
export async function obterPorRequestId({ organizacaoId, unidadeId, conexaoId, requestId, db = supabase }) {
  exigirChave({ organizacaoId, unidadeId, conexaoId });
  return executar(
    () => db.from(TABELA).select("*")
      .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).eq("conexao_id", conexaoId)
      .eq("request_id", requestId).maybeSingle(),
    () => [...memoria.values()].find((r) => r.organizacao_id === organizacaoId && r.unidade_id === unidadeId
      && r.conexao_id === conexaoId && r.request_id === requestId) ?? null,
  );
}

const STATUS_PERSISTIVEIS = new Set(["solicitado", "created", "enqueue", "processed", "error"]);

/** Atualiza o último status visto no iFood (melhor esforço — falha só loga). */
export async function atualizarStatus({ organizacaoId, unidadeId, conexaoId, requestId, status, mensagemErro, db = supabase }) {
  exigirChave({ organizacaoId, unidadeId, conexaoId });
  if (!STATUS_PERSISTIVEIS.has(status)) return null;
  const campos = { status, mensagem_erro: status === "error" ? String(mensagemErro ?? "").slice(0, 300) || null : null };
  try {
    return await executar(
      () => db.from(TABELA).update(campos)
        .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).eq("conexao_id", conexaoId)
        .eq("request_id", requestId).select().maybeSingle(),
      () => {
        const r = [...memoria.values()].find((x) => x.organizacao_id === organizacaoId && x.unidade_id === unidadeId
          && x.conexao_id === conexaoId && x.request_id === requestId);
        if (r) Object.assign(r, campos);
        return r ?? null;
      },
    );
  } catch (e) {
    ifoodLog("warn", "financial.reconciliation.on_demand.status_nao_gravado", { erro: e?.message });
    return null;
  }
}
