import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { avaliarLiberacaoDeConcessoes } from "./concessoes.dominio.js";
import * as service from "./concessoes.service.js";

// Montado DENTRO de `plataformaRouter` (que já exige SuperAdmin e nunca tem contexto de tenant):
//   /api/v1/plataforma/gestao-financeira/concessoes
// As ESCRITAS ficam bloqueadas (falha fechada) até a flag FINANCEIRO_CONCESSOES_HABILITADAS=true E, a cada chamada,
// AAL2 com 2º fator de no máximo 10 minutos. Leitura: só SuperAdmin.
export const concessoesRouter = Router();

/** Gate das escritas. Exportado para teste. */
export function exigirLiberacaoDeConcessoes(req, _res, next) {
  const r = avaliarLiberacaoDeConcessoes(req.user);
  if (r.ok) return next();
  return next(new ApiError(r.status, r.mensagem, { codigo: r.codigo }));
}

concessoesRouter.get("/", asyncHandler(async (req, res) => {
  res.json({ data: await service.listar({
    unidadeId: v.uuidOpcional(req.query.unidadeId, "Unidade") ?? undefined,
    perfilId: v.uuidOpcional(req.query.perfilId, "Perfil") ?? undefined,
    incluirRevogadas: req.query.incluirRevogadas === "true",
  }) });
}));

concessoesRouter.post("/", exigirLiberacaoDeConcessoes, asyncHandler(async (req, res) => {
  res.status(201).json({ data: await service.conceder(req) });
}));

concessoesRouter.post("/:id/revogar", exigirLiberacaoDeConcessoes, asyncHandler(async (req, res) => {
  res.json({ data: await service.revogar(req, v.uuid(req.params.id, "Concessão")) });
}));
