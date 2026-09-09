import { asyncHandler } from "../../shared/asyncHandler.js";
import { identidadeOperacional } from "../../shared/identidade.js";
import { ApiError } from "../../shared/ApiError.js";
import * as service from "./parserFoodDelivery.service.js";
import * as entregadores from "./parserFoodDelivery.entregadores.js";
import * as lancamentos from "./parserFoodDelivery.lancamentos.js";
import {
  MOTIVOS_TAXA_ADICIONAL, MOTIVOS_AVULSO, ROTULO_ORIGEM,
} from "./parserFoodDelivery.lancamentos.calc.js";

const tenant = (req) => ({ organizacaoId: req.tenant.organizacaoId, unidadeId: req.tenant.unidadeId });

export const importacoes = asyncHandler(async (req, res) => {
  const data = await service.listarImportacoes(tenant(req));
  res.json({ data });
});

export const importacaoDetalhe = asyncHandler(async (req, res) => {
  const data = await service.obterImportacao({ ...tenant(req), importacaoId: req.params.id });
  res.json({ data });
});

export const arquivoImportacao = asyncHandler(async (req, res) => {
  const data = await service.arquivoOriginal({ ...tenant(req), importacaoId: req.params.id });
  res.json({ data });
});

// passo 1 — só lê e valida o arquivo (formato/período/quantidade)
export const importarPreview = asyncHandler(async (req, res) => {
  const data = await service.previewArquivo({ ...tenant(req), arquivo: req.body?.arquivo });
  res.json({ data });
});

// passo 2/3 — reclassifica com a lista de códigos "sem taxa" (idempotente, não salva)
export const conciliarPreview = asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const data = await service.conciliarPreview({
    ...tenant(req), arquivo: body.arquivo, codigosSemTaxa: body.codigosSemTaxa,
    periodoInicioManual: body.periodoInicio, periodoFimManual: body.periodoFim,
  });
  res.json({ data });
});

// confirma e persiste
export const conciliarConfirmar = asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const data = await service.confirmarImportacao({
    ...tenant(req), usuario: identidadeOperacional(req), arquivo: body.arquivo, codigosSemTaxa: body.codigosSemTaxa,
    periodoInicioManual: body.periodoInicio, periodoFimManual: body.periodoFim,
  });
  res.status(201).json({ data });
});

export const editarCodigos = asyncHandler(async (req, res) => {
  const data = await service.editarCodigosSemTaxa({
    ...tenant(req), importacaoId: req.params.id, novosCodigos: req.body?.codigosSemTaxa, usuario: identidadeOperacional(req),
  });
  res.json({ data });
});

// Alteração manual de UMA classificação automática de cancelamento (item 29).
export const alterarClassificacao = asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const data = await service.alterarClassificacaoCancelamento({
    ...tenant(req), importacaoId: req.params.id, pedidoId: req.params.pedidoId,
    classificacaoFinal: body.classificacaoFinal, motivo: body.motivo, usuario: identidadeOperacional(req),
  });
  res.json({ data });
});

export const excluirImportacao = asyncHandler(async (req, res) => {
  const data = await service.excluirImportacao({
    ...tenant(req), importacaoId: req.params.id, motivo: req.body?.motivo, usuario: identidadeOperacional(req),
  });
  res.json({ data });
});

export const periodo = asyncHandler(async (req, res) => {
  const data = await service.analisarPeriodo({ ...tenant(req), dataInicio: req.query.dataInicio, dataFim: req.query.dataFim });
  res.json({ data });
});

// ---------------------------------------------------------------------------
// CATÁLOGOS — motivos padronizados (item 3/4). Consumido pelo frontend.
// ---------------------------------------------------------------------------
export const catalogos = asyncHandler(async (_req, res) => {
  res.json({ data: {
    motivosTaxaAdicional: MOTIVOS_TAXA_ADICIONAL,
    motivosAvulso: MOTIVOS_AVULSO,
    rotulosOrigem: ROTULO_ORIGEM,
  } });
});

// ---------------------------------------------------------------------------
// ENTREGADORES (cadastro mestre)
// ---------------------------------------------------------------------------
export const listarEntregadores = asyncHandler(async (req, res) => {
  const data = await entregadores.listarEntregadores({ ...tenant(req), incluirInativos: req.query.incluirInativos === "true" });
  res.json({ data });
});

export const criarEntregador = asyncHandler(async (req, res) => {
  const data = await entregadores.criarEntregador({ ...tenant(req), nome: req.body?.nome, usuario: identidadeOperacional(req) });
  res.status(201).json({ data });
});

export const editarEntregador = asyncHandler(async (req, res) => {
  const data = await entregadores.editarEntregador({
    ...tenant(req), entregadorId: req.params.id, nome: req.body?.nome, ativo: req.body?.ativo, usuario: identidadeOperacional(req),
  });
  res.json({ data });
});

export const sugestoesEntregadores = asyncHandler(async (req, res) => {
  const data = await entregadores.sugestoesReconhecimento(tenant(req));
  res.json({ data });
});

export const reconhecerEntregadores = asyncHandler(async (req, res) => {
  const data = await entregadores.reconhecerEntregadores({ ...tenant(req), nomes: req.body?.nomes, usuario: identidadeOperacional(req) });
  res.json({ data });
});

// ---------------------------------------------------------------------------
// LANÇAMENTOS OPERACIONAIS
// ---------------------------------------------------------------------------
export const listarLancamentos = asyncHandler(async (req, res) => {
  const data = await lancamentos.listarLancamentos({
    ...tenant(req), dataInicio: req.query.dataInicio, dataFim: req.query.dataFim,
    origem: req.query.origem, incluirExcluidos: req.query.incluirExcluidos === "true",
  });
  res.json({ data });
});

export const criarLancamento = asyncHandler(async (req, res) => {
  const data = await lancamentos.criarLancamento({ ...tenant(req), usuario: identidadeOperacional(req), ...(req.body ?? {}) });
  res.status(201).json({ data });
});

export const editarLancamento = asyncHandler(async (req, res) => {
  const data = await lancamentos.editarLancamento({
    ...tenant(req), lancamentoId: req.params.id, usuario: identidadeOperacional(req), ...(req.body ?? {}),
  });
  res.json({ data });
});

export const excluirLancamento = asyncHandler(async (req, res) => {
  const data = await lancamentos.excluirLancamento({
    ...tenant(req), lancamentoId: req.params.id, motivo: req.body?.motivo, usuario: identidadeOperacional(req),
  });
  res.json({ data });
});

export const restaurarLancamento = asyncHandler(async (req, res) => {
  const data = await lancamentos.restaurarLancamento({ ...tenant(req), lancamentoId: req.params.id, usuario: identidadeOperacional(req) });
  res.json({ data });
});

export const hardDeleteLancamento = asyncHandler(async (req, res) => {
  if (!req.user?.superadmin) throw ApiError.forbidden("Exclusão definitiva restrita ao SuperAdmin da plataforma.");
  const data = await lancamentos.hardDeleteLancamento({
    ...tenant(req), lancamentoId: req.params.id, motivo: req.body?.motivo, usuario: identidadeOperacional(req),
  });
  res.json({ data });
});
