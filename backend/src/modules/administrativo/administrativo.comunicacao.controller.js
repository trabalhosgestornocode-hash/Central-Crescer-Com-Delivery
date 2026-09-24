// Controller da área Comunicação/WhatsApp do PAINEL ADMINISTRATIVO
// (Checkpoint H.3-A). Camada fina — regra e projeção vivem em
// administrativo.comunicacao.service.js. Mesma autorização do resto do
// módulo (`requirePainelAdministrativo` no router inteiro — ver
// administrativo.routes.js); nenhuma checagem extra é necessária aqui.

import { asyncHandler } from "../../shared/asyncHandler.js";
import { identidadeOperacional } from "../../shared/identidade.js";
import * as service from "./administrativo.comunicacao.service.js";
import * as central from "./administrativo.comunicacao.central.js";
import * as teste from "./administrativo.comunicacao.teste.js";

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

// POST /administrativo/comunicacao/organizacoes/:organizacaoId/consentimento
export const confirmarConsentimento = asyncHandler(async (req, res) =>
  ok(res, await service.confirmarConsentimento({
    organizacaoId: req.params.organizacaoId,
    confirmacaoExplicita: req.body?.confirmacaoExplicita,
  }, autor(req), deps(req))));

// PUT /administrativo/comunicacao/organizacoes/:organizacaoId/habilitacao   { habilitado, confirmacaoExplicita }
export const habilitacao = asyncHandler(async (req, res) =>
  ok(res, await service.definirHabilitacao({
    organizacaoId: req.params.organizacaoId,
    habilitado: req.body?.habilitado,
    confirmacaoExplicita: req.body?.confirmacaoExplicita,
  }, autor(req), deps(req))));

// PUT /administrativo/comunicacao/modo   { modo: "DISABLED"|"NORMAL", confirmacaoExplicita }
export const modo = asyncHandler(async (req, res) =>
  ok(res, await service.alterarModoGlobal({
    modo: req.body?.modo,
    confirmacaoExplicita: req.body?.confirmacaoExplicita,
  }, autor(req), deps(req))));

// GET /administrativo/comunicacao/ativacao
export const ativacao = asyncHandler(async (req, res) => ok(res, await service.ativacao(deps(req))));

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

// ---- Central de Comunicação (H.4-B.5) ----

// GET /administrativo/comunicacao/mensagens?organizacaoId=&unidadeId=&status=&origem=&desde=&ate=&busca=&pagina=&porPagina=
export const mensagens = asyncHandler(async (req, res) =>
  ok(res, await central.mensagens({
    organizacaoId: req.query.organizacaoId, unidadeId: req.query.unidadeId, status: req.query.status, origem: req.query.origem,
    desde: req.query.desde, ate: req.query.ate, busca: req.query.busca, pagina: req.query.pagina, porPagina: req.query.porPagina,
  }, deps(req))));

// GET /administrativo/comunicacao/mensagens/:id
export const detalheMensagem = asyncHandler(async (req, res) => ok(res, await central.detalheMensagem({ id: req.params.id }, deps(req))));

// GET /administrativo/comunicacao/configuracao-operacional (somente leitura)
export const configuracaoOperacional = asyncHandler(async (req, res) => ok(res, await central.configuracaoOperacional(deps(req))));

// GET /administrativo/comunicacao/teste/preparo?organizacaoId=&unidadeId=
export const preparoTeste = asyncHandler(async (req, res) =>
  ok(res, await teste.preparoTeste({ organizacaoId: req.query.organizacaoId, unidadeId: req.query.unidadeId }, deps(req))));

// POST /administrativo/comunicacao/teste   { organizacaoId, unidadeId, testeId, confirmacaoExplicita }
export const enviarTeste = asyncHandler(async (req, res) =>
  ok(res, await teste.enviarTeste({
    organizacaoId: req.body?.organizacaoId, unidadeId: req.body?.unidadeId, testeId: req.body?.testeId, confirmacaoExplicita: req.body?.confirmacaoExplicita,
  }, autor(req), deps(req))));

// GET /administrativo/comunicacao/teste/:mensagemId
export const statusTeste = asyncHandler(async (req, res) =>
  ok(res, await teste.statusTeste({ mensagemId: req.params.mensagemId }, autor(req), deps(req))));
