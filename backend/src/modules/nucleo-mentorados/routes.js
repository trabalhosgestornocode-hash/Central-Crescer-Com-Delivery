// Rotas do NÚCLEO MENTORADOS — montadas DENTRO de administrativoRouter (/api/v1/administrativo/nucleo-mentorados), então
// já passaram por requireAuth -> requirePainelAdministrativo -> MFA (quando exigido) -> limite de taxa do Painel.
// Nenhuma rota usa contexto de empresa: o usuário de uma empresa (inclusive a mentorada) não alcança nada daqui.
// Escritas têm um limite de taxa próprio e auditoria; nenhuma toca registro financeiro oficial.

import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { identidadeOperacional } from "../../shared/identidade.js";
import { limiteDeTaxa } from "../../shared/rateLimit.js";
import * as s from "./service.js";

const ok = (res, data, status = 200) => res.status(status).json({ data });
const deps = (req) => req.app?.locals?.nucleoDeps ?? undefined;
const hoje = (req) => req.app?.locals?.adminHoje ?? undefined;
const autor = (req) => {
  const id = identidadeOperacional(req);
  return { id: id.contaId, perfilId: id.perfilId, nome: id.nome, email: id.email };
};

export const nucleoMentoradosRouter = Router();
const limiteEscrita = limiteDeTaxa({ escopo: "nucleo_mentorados_escrita", max: 60, janelaMs: 5 * 60 * 1000 });
const org = (req) => req.params.organizacaoId;

nucleoMentoradosRouter.get("/", asyncHandler(async (req, res) => ok(res, await s.listar({ hojeIso: hoje(req) }, deps(req)))));
nucleoMentoradosRouter.get("/candidatas", asyncHandler(async (req, res) => ok(res, await s.candidatas({ hojeIso: hoje(req) }, deps(req)))));
nucleoMentoradosRouter.post("/vinculos", limiteEscrita, asyncHandler(async (req, res) =>
  ok(res, await s.vincularEmMassa({ corpo: req.body, autor: autor(req), req }, deps(req)), 201)));
nucleoMentoradosRouter.get("/:organizacaoId", asyncHandler(async (req, res) => ok(res, await s.perfil({ organizacaoId: org(req), hojeIso: hoje(req) }, deps(req)))));
nucleoMentoradosRouter.put("/:organizacaoId", limiteEscrita, asyncHandler(async (req, res) =>
  ok(res, await s.salvarParticipante({ organizacaoId: org(req), corpo: req.body, autor: autor(req), req }, deps(req)))));

nucleoMentoradosRouter.post("/:organizacaoId/registros", limiteEscrita, asyncHandler(async (req, res) =>
  ok(res, await s.criarRegistro({ organizacaoId: org(req), corpo: req.body, autor: autor(req), req }, deps(req)), 201)));
nucleoMentoradosRouter.put("/:organizacaoId/registros/:registroId", limiteEscrita, asyncHandler(async (req, res) =>
  ok(res, await s.alterarRegistro({ organizacaoId: org(req), registroId: req.params.registroId, corpo: req.body, autor: autor(req), req }, deps(req)))));
nucleoMentoradosRouter.delete("/:organizacaoId/registros/:registroId", limiteEscrita, asyncHandler(async (req, res) =>
  ok(res, await s.removerRegistro({ organizacaoId: org(req), registroId: req.params.registroId, autor: autor(req), req }, deps(req)))));

nucleoMentoradosRouter.post("/:organizacaoId/fontes", limiteEscrita, asyncHandler(async (req, res) =>
  ok(res, await s.escolherFonte({ organizacaoId: org(req), corpo: req.body, autor: autor(req), req }, deps(req)), 201)));
nucleoMentoradosRouter.post("/:organizacaoId/fontes/:escolhaId/revogacao", limiteEscrita, asyncHandler(async (req, res) =>
  ok(res, await s.revogarEscolhaFonte({ organizacaoId: org(req), escolhaId: req.params.escolhaId, corpo: req.body, autor: autor(req), req }, deps(req)))));
nucleoMentoradosRouter.post("/:organizacaoId/importacoes/previa", limiteEscrita, asyncHandler(async (req, res) =>
  ok(res, await s.previaImportacao({ organizacaoId: org(req), corpo: req.body }, deps(req)))));
nucleoMentoradosRouter.post("/:organizacaoId/importacoes", limiteEscrita, asyncHandler(async (req, res) =>
  ok(res, await s.confirmarImportacao({ organizacaoId: org(req), corpo: req.body, autor: autor(req), req }, deps(req)), 201)));

nucleoMentoradosRouter.post("/:organizacaoId/apresentacoes", limiteEscrita, asyncHandler(async (req, res) =>
  ok(res, await s.gerarApresentacao({ organizacaoId: org(req), corpo: req.body, autor: autor(req), req, hojeIso: hoje(req) }, deps(req)), 201)));
nucleoMentoradosRouter.get("/:organizacaoId/apresentacoes/:apresentacaoId", asyncHandler(async (req, res) =>
  ok(res, await s.obterApresentacao({ organizacaoId: org(req), apresentacaoId: req.params.apresentacaoId }, deps(req)))));
nucleoMentoradosRouter.post("/:organizacaoId/apresentacoes/:apresentacaoId/exportacoes", limiteEscrita, asyncHandler(async (req, res) =>
  ok(res, await s.registrarExportacao({ organizacaoId: org(req), apresentacaoId: req.params.apresentacaoId, formato: req.body?.formato, autor: autor(req), req }, deps(req)), 201)));
