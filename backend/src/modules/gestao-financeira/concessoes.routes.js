import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { avaliarLiberacaoDeConcessoes } from "./concessoes.dominio.js";
import * as service from "./concessoes.service.js";
import * as acessos from "./acessos.service.js";

// Montado DENTRO de `plataformaRouter` (que já exige SuperAdmin e nunca tem contexto de tenant):
//   /api/v1/plataforma/gestao-financeira/concessoes
// As ESCRITAS ficam fechadas enquanto FINANCEIRO_CONCESSOES_HABILITADAS != "true" (chave geral de implantação).
// Sem MFA específico do Financeiro: quem administra é o SuperAdmin autenticado. Leitura: só SuperAdmin.
export const concessoesRouter = Router();

/** Gate das escritas. Exportado para teste. */
export function exigirLiberacaoDeConcessoes(req, _res, next) {
  const r = avaliarLiberacaoDeConcessoes(req.user);
  if (r.ok) return next();
  return next(new ApiError(r.status, r.mensagem, { codigo: r.codigo }));
}

// Estado da liberação para a interface (botões desabilitados quando bloqueado). Não executa nada.
concessoesRouter.get("/estado", (req, res) => {
  const r = avaliarLiberacaoDeConcessoes(req.user);
  res.json({ data: r.ok ? { escritaLiberada: true } : { escritaLiberada: false, codigo: r.codigo, mensagem: r.mensagem } });
});

// Gestão simples por unidade: estado (módulo + usuários com nível) e gravação de tudo de uma vez.
concessoesRouter.get("/unidades/:unidadeId/acessos", asyncHandler(async (req, res) => {
  res.json({ data: await acessos.obterAcessosDaUnidade({ unidadeId: v.uuid(req.params.unidadeId, "Unidade"), atorId: req.user.id }) });
}));

concessoesRouter.put("/unidades/:unidadeId/acessos", exigirLiberacaoDeConcessoes, asyncHandler(async (req, res) => {
  res.json({ data: await acessos.salvarAcessosDaUnidade(req, v.uuid(req.params.unidadeId, "Unidade")) });
}));

concessoesRouter.get("/perfis", asyncHandler(async (req, res) => {
  res.json({ data: await service.perfisElegiveis({ unidadeId: v.uuid(req.query.unidadeId, "Unidade"), atorId: req.user.id }) });
}));

concessoesRouter.get("/auditoria", asyncHandler(async (req, res) => {
  res.json({ data: await service.auditoria({
    unidadeId: v.uuidOpcional(req.query.unidadeId, "Unidade") ?? undefined,
    perfilId: v.uuidOpcional(req.query.perfilId, "Perfil") ?? undefined,
    concessaoId: v.uuidOpcional(req.query.concessaoId, "Concessão") ?? undefined,
  }) });
}));

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
