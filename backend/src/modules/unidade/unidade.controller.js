import { asyncHandler } from "../../shared/asyncHandler.js";
import * as service from "./unidade.service.js";

// A unidade vem SEMPRE de req.tenant (Context Token) — nenhum handler aqui
// aceita unidadeId do corpo/query (ver comentário no topo do service).

export const obterTabelasComerciais = asyncHandler(async (req, res) => {
  const data = await service.obterTabelasComerciais({ unidadeId: req.tenant.unidadeId });
  res.json({ data });
});

export const alterarTabelaComercial = asyncHandler(async (req, res) => {
  const data = await service.alterarTabelaComercial(req, req.body ?? {});
  res.json({ data });
});

export const obterDados = asyncHandler(async (req, res) => {
  const data = await service.obterDados({ unidadeId: req.tenant.unidadeId });
  res.json({ data });
});

export const atualizarDados = asyncHandler(async (req, res) => {
  const data = await service.atualizarDados(req, req.body ?? {});
  res.json({ data });
});

export const obterMetasCmv = asyncHandler(async (req, res) => {
  const data = await service.obterMetasCmv({ unidadeId: req.tenant.unidadeId });
  res.json({ data });
});

export const salvarMetasCmv = asyncHandler(async (req, res) => {
  const data = await service.salvarMetasCmv(req, req.body ?? {});
  res.json({ data });
});
