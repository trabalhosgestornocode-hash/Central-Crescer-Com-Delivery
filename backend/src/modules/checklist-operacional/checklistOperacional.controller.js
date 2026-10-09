// Checklist Operacional — controller fino. Tenant SEMPRE de req.tenant (Context Token validado por
// requireContexto); nenhum id de unidade/merchant é lido do corpo ou da query. Resposta em { data }.

import { asyncHandler } from "../../shared/asyncHandler.js";
import { ApiError } from "../../shared/ApiError.js";
import * as service from "./checklistOperacional.service.js";

export const resumo = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = req.tenant ?? {};
  if (!unidadeId) throw ApiError.badRequest("Selecione uma unidade para acompanhar o Checklist Operacional.");
  const data = await service.obterResumo({ organizacaoId, unidadeId });
  res.set("Cache-Control", "no-store");
  res.json({ data });
});
