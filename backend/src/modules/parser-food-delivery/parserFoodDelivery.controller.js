import { asyncHandler } from "../../shared/asyncHandler.js";
import { identidadeOperacional } from "../../shared/identidade.js";
import * as service from "./parserFoodDelivery.service.js";

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
