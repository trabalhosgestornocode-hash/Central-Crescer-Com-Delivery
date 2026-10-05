// Controllers da integração iFood.
//
// Fino, sem regra de negócio. Tenant SEMPRE de req.tenant (Context Token,
// validado por requireContexto). Nenhum controller lê organizacaoId/unidadeId
// do corpo ou da query — trocar de loja é selecionar outro contexto via
// /sessao. Resposta sempre em { data }.
//
// NADA de token, verifier, clientSecret ou merchantId completo sai daqui para
// o frontend.

import { asyncHandler } from "../../shared/asyncHandler.js";
import { ApiError } from "../../shared/ApiError.js";
import * as authService from "./ifoodAuth.service.js";
import * as merchantService from "./ifoodMerchant.service.js";
import * as connectionService from "./ifoodConnection.service.js";
import * as financialService from "./ifoodFinancial.service.js";
import * as pedidosLeitura from "./ifoodPedidosLeitura.service.js";
import * as val from "./ifood.validators.js";
import { resumoEventsParaStatus } from "./ifoodEventsEstado.js";
import { config } from "../../config/env.js";

function tenant(req) {
  const { organizacaoId, unidadeId } = req.tenant ?? {};
  if (!unidadeId) {
    throw ApiError.badRequest("Selecione a loja antes de conectar a integração iFood.");
  }
  return { organizacaoId, unidadeId };
}

// --- ETAPA 1 — gerar código de vínculo -----------------------------------
export const iniciar = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const appType = val.validarAppType(req.body?.appType);

  const data = await authService.iniciarConexao({
    organizacaoId, unidadeId, appType, usuarioId: req.user.id,
  });
  res.status(201).json({ data });
});

// --- ETAPA 2 — concluir autorização -------------------------------------
export const concluir = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const appType = val.validarAppType(req.body?.appType);
  const sessaoId = val.validarSessionId(req.body?.sessionId);
  const authorizationCode = val.validarAuthorizationCode(req.body?.authorizationCode);

  const data = await authService.concluirAutorizacao({
    organizacaoId, unidadeId, appType, sessaoId, authorizationCode, usuarioId: req.user.id,
  });
  res.json({ data });
});

// --- Merchard API (READ-ONLY) ------------------------------------------

// Descoberta: lojas autorizadas pelo token financial da unidade (paginado).
export const descobrirMerchants = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const data = await merchantService.listarMerchantsAutorizados({ organizacaoId, unidadeId });
  res.json({ data });
});

// Validação individual: confirma acesso a UM merchant (GET /merchants/{id}).
export const detalharMerchant = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const merchantId = val.validarMerchantId(req.params.merchantId);
  const data = await merchantService.validarMerchant({ organizacaoId, unidadeId, merchantId });
  res.json({ data });
});

// --- Vínculo merchant -> unidade + status -------------------------------

// Vincula um merchant à unidade. Recebe SÓ merchantId — revalidado na API.
export const vincularMerchant = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const merchantId = val.validarMerchantId(req.body?.merchantId);
  const data = await connectionService.vincularMerchant({
    organizacaoId, unidadeId, merchantId, usuarioId: req.user.id,
  });
  res.status(201).json({ data });
});

// Status da integração da unidade — analytics e financial separados. `eventosRecebimento`: estado do
// recebimento de eventos NESTA instância (só estado e horários; nada que agregue outras lojas).
export const status = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const data = await connectionService.obterStatus({ organizacaoId, unidadeId });
  res.json({ data: { ...data, eventosRecebimento: resumoEventsParaStatus() } });
});

// Desconexão LOCAL — descarta tokens, marca a conexão como 'revogada'.
// Não revoga no iFood (não há endpoint documentado) — o frontend orienta o
// usuário a remover o acesso também no Portal do Parceiro.
export const desconectar = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const data = await connectionService.desconectar({ organizacaoId, unidadeId, usuarioId: req.user.id });
  res.json({ data });
});

// Pedidos iFood da unidade — lidos do banco local (estado OFICIAL, vindo dos eventos). Não chama o iFood.
export const pedidos = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  res.json({ data: await pedidosLeitura.listarPedidos({ organizacaoId, unidadeId }) });
});

// --- Financial (Fase 2 — Homologação, só leitura) ------------------------

// Fixture x dado real: SÓ a configuração do backend decide (IFOOD_FINANCIAL_FIXTURE).
const fixtureFinanceira = () => config.ifood?.financialFixture === true;

// API Sales. merchantId SEMPRE da conexão da unidade — nunca do query string.
// `validacao` é diagnóstico técnico (já vai para o log) — não sai para o frontend.
export const financialSales = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const { inicio, fim, page } = req.query;
  const { validacao: _validacao, ...data } = await financialService.listarSales({
    organizacaoId, unidadeId, inicio, fim, page, homologacao: fixtureFinanceira(),
  });
  res.json({ data });
});

// API Financial Events. inicio/fim opcionais (default: hoje — ver service).
export const financialEvents = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const { inicio, fim, page, size } = req.query;
  const { validacao: _validacao, ...data } = await financialService.listarFinancialEvents({
    organizacaoId, unidadeId, inicio, fim, page, size, homologacao: fixtureFinanceira(),
  });
  res.json({ data });
});

// API Settlements. inicio/fim obrigatórios; `modo` escolhe qual par de data
// a API usa (calculo = período de liquidação [padrão] | pagamento).
export const financialSettlements = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const { modo, inicio, fim } = req.query;
  const data = await financialService.listarSettlements({ organizacaoId, unidadeId, modo, inicio, fim });
  res.json({ data });
});

// API Reconciliation (mês fechado, síncrona — já devolve os dados parseados).
export const financialReconciliation = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const { competencia } = req.query;
  const data = await financialService.obterReconciliation({ organizacaoId, unidadeId, competencia });
  res.json({ data });
});

// API Reconciliation On Demand — etapa 1: solicita a geração (assíncrona).
// O requestId fica registrado por organização/unidade/competência; no 409 do
// iFood o service devolve o requestId registrado (`reutilizado: true`, HTTP 200).
export const financialReconciliationOnDemandSolicitar = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const { competencia } = req.body ?? {};
  const data = await financialService.solicitarReconciliationOnDemand({ organizacaoId, unidadeId, competencia, usuarioId: req.user?.id });
  res.status(data.reutilizado ? 200 : 201).json({ data });
});

// Solicitação vigente (< 24h) da unidade para a competência — a UI usa ao
// reabrir/recarregar para retomar o acompanhamento. Não chama o iFood.
export const financialReconciliationOnDemandAtual = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const { competencia } = req.query;
  res.json({ data: await financialService.obterSolicitacaoReconciliationOnDemand({ organizacaoId, unidadeId, competencia }) });
});

// Exportação do CSV de conciliação — proxy autenticado: o backend pede um
// link novo ao iFood, baixa e devolve o CSV. URL assinada e token nunca saem.
export const financialReconciliationOnDemandArquivo = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const { requestId } = req.params;
  const { nomeArquivo, conteudo, contentType } = await financialService.baixarArquivoReconciliationOnDemand({ organizacaoId, unidadeId, requestId });
  res.set({
    "Content-Type": contentType,
    // nomeArquivo já vem restrito a [A-Za-z0-9._-] (service#nomeArquivoConciliacao).
    "Content-Disposition": `attachment; filename="${nomeArquivo}"`,
    "Content-Length": String(conteudo.length),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.send(conteudo);
});

// API Reconciliation On Demand — etapa 2: consulta status (e baixa/parseia
// o arquivo automaticamente quando pronto). O frontend acompanha com polling
// e backoff exponencial (frontend/src/ifoodReconciliacaoPolling.js).
export const financialReconciliationOnDemandStatus = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const { requestId } = req.params;
  const data = await financialService.consultarReconciliationOnDemand({ organizacaoId, unidadeId, requestId });
  res.json({ data });
});

// API Anticipation. SOMENTE LEITURA — nenhuma ação de solicitar antecipação
// existe aqui (Bloco Q desta fase).
export const financialAnticipations = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const { modo, inicio, fim } = req.query;
  const data = await financialService.listarAnticipations({ organizacaoId, unidadeId, modo, inicio, fim });
  res.json({ data });
});

// Bloco H — Conciliação Financeira consolidada (Sales/Events/Settlements/
// Reconciliation/Anticipation). `competencia` opcional (deriva de `inicio`).
export const financialConciliation = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const { inicio, fim, competencia } = req.query;
  const data = await financialService.obterConciliacaoFinanceira({ organizacaoId, unidadeId, inicio, fim, competencia });
  res.json({ data });
});
