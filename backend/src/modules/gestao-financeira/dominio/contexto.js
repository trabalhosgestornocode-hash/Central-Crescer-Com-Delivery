// Contexto financeiro validado. Organização/unidade NUNCA vêm do cliente: vêm do gate do Agente 1 (req.financeiro),
// que as lê do Context Token → sessoes_contexto. Qualquer serviço/repositório recusa um contexto incompleto.
import { ApiError } from "../../../shared/ApiError.js";

export const ACAO = Object.freeze({
  VER: "gestao_financeira.ver",
  LANCAR: "gestao_financeira.lancar",
  EDITAR: "gestao_financeira.editar",
  CONCILIAR: "gestao_financeira.conciliar",
  FECHAR: "gestao_financeira.fechar",
  REABRIR: "gestao_financeira.reabrir",
  EXCLUIR: "gestao_financeira.excluir",
  CONFIGURAR: "gestao_financeira.configurar",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ehUuid = (v) => typeof v === "string" && UUID.test(v);

/** Constrói o contexto a partir do request já autorizado pelo gate. Falha fechada se algo faltar. */
export function contextoDe(req) {
  const f = req?.financeiro;
  const usuarioId = req?.user?.id;
  if (!f?.organizacaoId || !f?.unidadeId || !usuarioId) throw ApiError.forbidden("Contexto financeiro ausente.", { codigo: "FINANCEIRO_SEM_CONCESSAO" });
  return exigirContexto({ organizacaoId: f.organizacaoId, unidadeId: f.unidadeId, usuarioId });
}

export function exigirContexto(ctx) {
  if (!ctx || !ehUuid(ctx.organizacaoId) || !ehUuid(ctx.unidadeId) || !ehUuid(ctx.usuarioId)) {
    throw ApiError.forbidden("Contexto financeiro inválido.", { codigo: "FINANCEIRO_SEM_CONCESSAO" });
  }
  return Object.freeze({ organizacaoId: ctx.organizacaoId, unidadeId: ctx.unidadeId, usuarioId: ctx.usuarioId });
}
