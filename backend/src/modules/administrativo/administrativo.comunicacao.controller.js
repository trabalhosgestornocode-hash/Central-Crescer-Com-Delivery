// Controller da área Comunicação/WhatsApp do PAINEL ADMINISTRATIVO
// (Checkpoint H.3-A). Camada fina — regra e projeção vivem em
// administrativo.comunicacao.service.js. Mesma autorização do resto do
// módulo (`requirePainelAdministrativo` no router inteiro — ver
// administrativo.routes.js); nenhuma checagem extra é necessária aqui.

import { asyncHandler } from "../../shared/asyncHandler.js";
import { identidadeOperacional } from "../../shared/identidade.js";
import * as service from "./administrativo.comunicacao.service.js";

const ok = (res, data, status = 200) => res.status(status).json({ data });
// Mesma seam de teste de administrativo.controller.js: `app.locals.adminDeps`.
const deps = (req) => req.app?.locals?.adminDeps ?? undefined;

const autor = (req) => {
  const id = identidadeOperacional(req);
  return { contaId: id.contaId, perfilId: id.perfilId, nome: id.nome, email: id.email };
};

// GET /administrativo/comunicacao/resumo
export const resumo = asyncHandler(async (req, res) => ok(res, await service.resumo(deps(req))));

// GET /administrativo/comunicacao/organizacoes?busca=
export const organizacoes = asyncHandler(async (req, res) =>
  ok(res, await service.organizacoes({ busca: req.query.busca }, deps(req))));

// GET /administrativo/comunicacao/organizacoes/:organizacaoId
export const detalheOrganizacao = asyncHandler(async (req, res) =>
  ok(res, await service.detalheOrganizacao({ organizacaoId: req.params.organizacaoId }, deps(req))));

// GET /administrativo/comunicacao/organizacoes/:organizacaoId/perfis-elegiveis
export const perfisElegiveis = asyncHandler(async (req, res) =>
  ok(res, await service.perfisElegiveis({ organizacaoId: req.params.organizacaoId }, deps(req))));

// GET /administrativo/comunicacao/organizacoes/:organizacaoId/preview-mensagem?unidadeId=
// Checkpoint H.4-A — somente leitura, nunca cria mensagem/tentativa, nunca chama o provider.
export const preverMensagem = asyncHandler(async (req, res) =>
  ok(res, await service.preverMensagem({ organizacaoId: req.params.organizacaoId, unidadeId: req.query.unidadeId }, deps(req))));

// PUT /administrativo/comunicacao/organizacoes/:organizacaoId/configuracao
export const atualizarConfiguracao = asyncHandler(async (req, res) =>
  ok(res, await service.atualizarConfiguracao({
    organizacaoId: req.params.organizacaoId,
    habilitado: req.body?.habilitado,
    telefoneE164: req.body?.telefoneE164,
    perfilOperacionalId: req.body?.perfilOperacionalId,
    timezone: req.body?.timezone,
    tiposPermitidos: req.body?.tiposPermitidos,
    pausadoAte: req.body?.pausadoAte,
    pausadoMotivo: req.body?.pausadoMotivo,
  }, autor(req), deps(req))));

// GET /administrativo/comunicacao/fila?organizacaoId=&status=&pagina=&porPagina=
export const fila = asyncHandler(async (req, res) =>
  ok(res, await service.fila({
    organizacaoId: req.query.organizacaoId, status: req.query.status,
    pagina: req.query.pagina, porPagina: req.query.porPagina,
  }, deps(req))));

// GET /administrativo/comunicacao/historico?organizacaoId=&status=&tipoAlerta=&desde=&ate=&pagina=&porPagina=
export const historico = asyncHandler(async (req, res) =>
  ok(res, await service.historico({
    organizacaoId: req.query.organizacaoId, status: req.query.status, tipoAlerta: req.query.tipoAlerta,
    desde: req.query.desde, ate: req.query.ate, pagina: req.query.pagina, porPagina: req.query.porPagina,
  }, deps(req))));
