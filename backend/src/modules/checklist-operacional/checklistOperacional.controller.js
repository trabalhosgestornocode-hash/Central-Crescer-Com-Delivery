// Checklist Operacional — controller fino. Tenant SEMPRE de req.tenant (Context Token validado por
// requireContexto); nenhum id de unidade/merchant é lido do corpo ou da query. Resposta em { data }.

import { asyncHandler } from "../../shared/asyncHandler.js";
import { ApiError } from "../../shared/ApiError.js";
import * as service from "./checklistOperacional.service.js";
import { gerarExcel, secoesPedidas, nomeArquivoExcel, gerarExcelFechamento, nomeArquivoFechamento } from "./checklistOperacional.exportar.js";
import * as operacional from "./checklistOperacional.operacional.service.js";

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

// ---------------------------------------------------------------------------------------------------------------------------
// Dashboard Operacional 2.0 — pedidos e Ficha 360°, fechamento diário e prévia/simulação de WhatsApp.
// Mesmo princípio: tenant do contexto; do navegador só vêm filtro, chave opaca do pedido, id do fechamento e motivo.
// ---------------------------------------------------------------------------------------------------------------------------

const quemFez = (req) => (typeof req.user?.id === "string" ? req.user.id : null);   // id, nunca nome/e-mail

export const pedidos = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ data: await operacional.listarPedidos({ ...unidadeDoContexto(req), filtro: filtroDaQuery(req.query) }) });
});

export const fichaPedido = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ data: await operacional.obterFicha({ ...unidadeDoContexto(req), chave: String(req.params.chave ?? "") }) });
});

export const listarFechamentos = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  const competencia = typeof req.query?.competencia === "string" && req.query.competencia ? req.query.competencia.slice(0, 10) : null;
  res.json({ data: await operacional.listarFechamentos({ ...unidadeDoContexto(req), competencia }) });
});

export const gerarFechamento = asyncHandler(async (req, res) => {
  const corpo = req.body ?? {};
  const r = await operacional.gerarFechamento({
    ...unidadeDoContexto(req),
    competencia: typeof corpo.competencia === "string" ? corpo.competencia.slice(0, 10) : "",
    origem: corpo.reprocessar === true ? "reprocessamento" : "manual",
    motivo: typeof corpo.motivo === "string" ? corpo.motivo : null,
    geradoPor: quemFez(req),
  });
  res.set("Cache-Control", "no-store");
  res.status(r.resultado === "REGISTRADO" ? 201 : 200).json({ data: r });
});

export const obterFechamento = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ data: await operacional.obterFechamento({ ...unidadeDoContexto(req), id: String(req.params.id ?? "") }) });
});

export const exportarFechamentoExcel = asyncHandler(async (req, res) => {
  const tenant = unidadeDoContexto(req);
  const f = await operacional.obterFechamento({ ...tenant, id: String(req.params.id ?? "") });
  const unidadeNome = await service.nomeDaUnidade(tenant);
  res.set({
    "Cache-Control": "no-store",
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${nomeArquivoFechamento(f)}"`,
  });
  res.send(gerarExcelFechamento({ fechamento: f, unidadeNome }));
});

export const previaWhatsapp = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ data: await operacional.previaWhatsapp({ ...unidadeDoContexto(req), id: String(req.params.id ?? "") }) });
});

export const simularWhatsapp = asyncHandler(async (req, res) => {
  const r = await operacional.simularWhatsapp({ ...unidadeDoContexto(req), id: String(req.params.id ?? ""), criadoPor: quemFez(req) });
  res.set("Cache-Control", "no-store");
  res.status(r.duplicada ? 200 : 201).json({ data: r });
});
