// Repositório do vínculo MANUAL de merchant (migration 116 — ifood_merchant_vinculos).
//
// Única porta de acesso à tabela. Sem regra de negócio: as decisões ficam em ifoodMerchantVinculo.service.js.
//   * Toda leitura/escrita de UMA unidade filtra por organizacao_id + unidade_id (o backend usa service_role
//     e ignora RLS: o isolamento efetivo é esta camada).
//   * A busca por merchant é GLOBAL de propósito (um merchant só pode estar em aberto numa conexão).
//   * Nada é apagado: cada tentativa fica como histórico.
//   * Tabela ausente (migration 116 não aplicada) vira IFOOD_VINCULO_MANUAL_INDISPONIVEL — nunca erro 500 cru.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";

const TABELA = "ifood_merchant_vinculos";
export const ESTADOS_ABERTOS = Object.freeze(["informado", "aguardando_validacao"]);

/** A tabela não existe (PostgREST: PGRST205; Postgres: 42P01)? */
export const tabelaAusente = (error) => error?.code === "PGRST205" || error?.code === "42P01";

const ok = (res) => {
  if (res.error) {
    if (tabelaAusente(res.error)) throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_MANUAL_INDISPONIVEL);
    throw ApiError.internal(res.error.message);
  }
  return res.data;
};

function exigirTenant(organizacaoId, unidadeId) {
  if (!organizacaoId || !unidadeId) throw ApiError.internal("Escopo de tenant ausente no vínculo manual iFood.");
}

/** O vínculo em aberto (informado/aguardando_validacao) da conexão da unidade, se existir. */
export async function obterVinculoAberto({ organizacaoId, unidadeId, conexaoId, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await db.from(TABELA).select("*")
    .eq("conexao_id", conexaoId).eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .in("estado", ESTADOS_ABERTOS)
    .maybeSingle());
}

/** O vínculo mais recente da conexão (qualquer estado) — para o painel mostrar também a rejeição. */
export async function obterUltimoVinculo({ organizacaoId, unidadeId, conexaoId, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  const linhas = ok(await db.from(TABELA).select("*")
    .eq("conexao_id", conexaoId).eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .order("criado_em", { ascending: false }).limit(1)) ?? [];
  return linhas[0] ?? null;
}

/** Vínculo EM ABERTO deste merchant em QUALQUER conexão (global, como o índice único parcial). */
export async function vinculoAbertoDoMerchant({ merchantId, db = supabase }) {
  if (!merchantId) return null;
  return ok(await db.from(TABELA)
    .select("id, conexao_id, organizacao_id, unidade_id, estado, merchant_id")
    .eq("merchant_id", merchantId).in("estado", ESTADOS_ABERTOS)
    .maybeSingle());
}

/** Rejeições por falta de autorização desta conexão desde `desdeIso` (freio contra tentativa e erro no iFood). */
export async function contarRejeicoesRecentes({ organizacaoId, unidadeId, conexaoId, desdeIso, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  const linhas = ok(await db.from(TABELA).select("id")
    .eq("conexao_id", conexaoId).eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .eq("estado", "rejeitado").eq("encerrado_motivo", "SEM_AUTORIZACAO")
    .gte("rejeitado_em", desdeIso)) ?? [];
  return linhas.length;
}

/** Cria o vínculo `informado`. Corrida com outro vínculo em aberto (índices únicos) vira duplicidade. */
export async function criarVinculo({ organizacaoId, unidadeId, conexaoId, merchantId, usuarioId, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  const res = await db.from(TABELA).insert({
    conexao_id: conexaoId, organizacao_id: organizacaoId, unidade_id: unidadeId,
    merchant_id: merchantId, estado: "informado", informado_por: usuarioId ?? null,
  }).select().single();
  if (res.error?.code === "23505") throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_DUPLICADO);
  return ok(res);
}

/**
 * COMPARE-AND-SET: só grava se o vínculo ainda é do tenant e está em `seEstado` (e, opcionalmente, com o
 * mesmo número de tentativas lido). Devolve a linha gravada ou null (alguém mudou antes — nada foi escrito).
 */
export async function atualizarVinculo({ organizacaoId, unidadeId, id, seEstado, seTentativas, campos, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  let q = db.from(TABELA).update(campos)
    .eq("id", id).eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).eq("estado", seEstado);
  if (seTentativas !== undefined) q = q.eq("autorizacao_tentativas", seTentativas);
  return ok(await q.select().maybeSingle());
}

/** Encerra (cancelado) o que estiver em aberto na conexão — troca de ID, desistência ou desconexão. */
export async function cancelarVinculosAbertos({ organizacaoId, unidadeId, conexaoId, motivo, db = supabase }) {
  exigirTenant(organizacaoId, unidadeId);
  const linhas = ok(await db.from(TABELA).update({ estado: "cancelado", encerrado_motivo: motivo ?? "CANCELADO" })
    .eq("conexao_id", conexaoId).eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .in("estado", ESTADOS_ABERTOS).select("id")) ?? [];
  return linhas.length;
}
