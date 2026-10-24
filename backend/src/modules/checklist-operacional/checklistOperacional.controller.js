// Checklist Operacional — controller fino. Tenant SEMPRE de req.tenant (Context Token validado por
// requireContexto); nenhum id de unidade/merchant é lido do corpo ou da query. Resposta em { data }.

import { asyncHandler } from "../../shared/asyncHandler.js";
import { ApiError } from "../../shared/ApiError.js";
import * as service from "./checklistOperacional.service.js";
import { gerarExcel, secoesPedidas, nomeArquivoExcel } from "./checklistOperacional.exportar.js";

export const resumo = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = req.tenant ?? {};
  if (!unidadeId) throw ApiError.badRequest("Selecione uma unidade para acompanhar o Checklist Operacional.");
  const data = await service.obterResumo({ organizacaoId, unidadeId });
  res.set("Cache-Control", "no-store");
  res.json({ data });
});

const unidadeDoContexto = (req) => {
  const { organizacaoId, unidadeId } = req.tenant ?? {};
  if (!unidadeId) throw ApiError.badRequest("Selecione uma unidade para acompanhar o Checklist Operacional.");
  return { organizacaoId, unidadeId };
};

/** Quem salvou: sempre da sessão relida do banco (requireContexto), nunca do corpo. */
const autorDaSessao = (req) => ({
  perfilId: req.acesso?.perfilId ?? null,
  usuarioId: req.user?.id ?? null,
  nome: req.perfil?.nome ?? req.user?.nome ?? null,
  impersonadoPor: req.acesso?.impersonadoPor ?? null,
});

export const obterMetas = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ data: await service.obterMetas(unidadeDoContexto(req)) });
});

export const salvarMetas = asyncHandler(async (req, res) => {
  const data = await service.salvarMetas({ ...unidadeDoContexto(req), corpo: req.body ?? {}, autor: autorDaSessao(req) });
  res.set("Cache-Control", "no-store");
  res.json({ data });
});

export const historicoMetas = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ data: await service.obterHistoricoMetas(unidadeDoContexto(req)) });
});

/** Só os filtros conhecidos, como texto curto (o período é validado no service). */
const filtroDaQuery = (q) => Object.fromEntries(["periodo", "inicio", "fim", "etapa"]
  .map((k) => [k, typeof q?.[k] === "string" ? q[k].slice(0, 20) : undefined]));

export const dashboard = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ data: await service.obterDashboard({ ...unidadeDoContexto(req), filtro: filtroDaQuery(req.query) }) });
});

export const exportarExcel = asyncHandler(async (req, res) => {
  const tenant = unidadeDoContexto(req);
  const d = await service.obterDashboard({ ...tenant, filtro: filtroDaQuery(req.query) });
  const unidadeNome = await service.nomeDaUnidade(tenant);
  const { analises, ...dashboard } = d;
  const buffer = gerarExcel({ dashboard, analises, unidadeNome, geradoEm: d.servidorEm, secoes: secoesPedidas(req.query?.secoes) });
  res.set({
    "Cache-Control": "no-store",
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${nomeArquivoExcel(d)}"`,
  });
  res.send(buffer);
});
