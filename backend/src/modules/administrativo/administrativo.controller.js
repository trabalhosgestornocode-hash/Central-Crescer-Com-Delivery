// Controller do PAINEL ADMINISTRATIVO da Crescer com Delivery.
//
// Um TERCEIRO ambiente, além do operacional (empresa/unidade) e do Painel
// SuperAdmin. É GERENCIAL: monitoramento cross-tenant do preenchimento e da
// qualidade dos dados das empresas acompanhadas pela Crescer. NÃO tem poder
// técnico de SuperAdmin.
//
// TODA rota deste módulo já passou por:
//   requireAuth  ->  exigirSenhaDefinitiva  ->  requirePainelAdministrativo
// (o último aplicado ao router INTEIRO em administrativo.routes.js — mesma
// disciplina do plataformaRouter). NENHUMA rota daqui usa requireContexto: o
// Painel Administrativo não opera sob o contexto de nenhuma empresa. As
// leituras cross-tenant vivem SOMENTE dentro deste módulo, com service_role,
// exatamente como plataforma.*.
//
// FASE F: os endpoints de monitoramento cross-tenant. Camada fina —
// validação e regra vivem no service (administrativo.service.js) e no motor
// puro (administrativo.status.js / administrativo.monitores.js).

import { asyncHandler } from "../../shared/asyncHandler.js";
import { identidadeOperacional } from "../../shared/identidade.js";
import * as service from "./administrativo.service.js";
import { listarMentorados } from "./administrativo.mentorados.js";

const ok = (res, data, status = 200) => res.status(status).json({ data });

// Seam de TESTE apenas: `app.locals.adminDeps` injeta um Supabase fake nos
// testes de integração do router. Em produção nunca é definido -> os services
// caem no `deps = {}` padrão (Supabase real, service_role).
const deps = (req) => req.app?.locals?.adminDeps ?? undefined;
// `app.locals.adminHoje` fixa "hoje" nos testes (o fuso do negócio muda a
// resposta). Produção nunca define -> os services usam `hojeIsoBrasil()`.
const hoje = (req) => req.app?.locals?.adminHoje ?? undefined;

/**
 * GET /api/v1/administrativo/ping
 * Sanidade da autorização: 200 só para quem passou por `requirePainelAdministrativo`.
 */
export function ping(req, res) {
  const viaSuperadmin = !!req.user?.superadmin && !req.user?.painelAdministrativo;
  res.json({
    data: {
      ok: true,
      ambiente: "painel_administrativo",
      usuario: { id: req.user.id, nome: req.user.nome },
      via: viaSuperadmin ? "superadmin" : "painel_administrativo",
    },
  });
}

// --------------------------------------------------------- Monitoramento (Fase F)
//
// PERÍODO ATIVO: toda rota aceita `?mes=AAAA-MM` (opcional). Ausente = mês
// corrente — exatamente o comportamento anterior. O service deriva o dia-alvo
// do período (D-1 no mês corrente; último dia num mês já fechado).

// GET /administrativo/visao-geral?mes=AAAA-MM
export const visaoGeral = asyncHandler(async (req, res) =>
  ok(res, await service.visaoGeral({ hojeIso: hoje(req), mes: req.query.mes }, deps(req))));

// GET /administrativo/monitoramento-diario?mes=&data=&organizacaoId=&status=&criticidade=
export const monitoramentoDiario = asyncHandler(async (req, res) =>
  ok(res, await service.monitoramentoDiario({
    data: req.query.data,
    mes: req.query.mes,
    organizacaoId: req.query.organizacaoId,
    status: req.query.status,
    criticidade: req.query.criticidade,
    hojeIso: hoje(req),
  }, deps(req))));

// GET /administrativo/pendencias?mes=AAAA-MM
export const pendencias = asyncHandler(async (req, res) =>
  ok(res, await service.pendencias({ hojeIso: hoje(req), mes: req.query.mes }, deps(req))));

// GET /administrativo/empresas?mes=AAAA-MM
export const empresas = asyncHandler(async (req, res) =>
  ok(res, await service.empresas({ hojeIso: hoje(req), mes: req.query.mes }, deps(req))));

// GET /administrativo/empresas/:organizacaoId?mes=AAAA-MM
export const detalheEmpresa = asyncHandler(async (req, res) =>
  ok(res, await service.detalheEmpresa({ organizacaoId: req.params.organizacaoId, hojeIso: hoje(req), mes: req.query.mes }, deps(req))));

// GET /administrativo/unidades/:unidadeId/calendario?mes=YYYY-MM
export const calendarioUnidade = asyncHandler(async (req, res) =>
  ok(res, await service.calendarioUnidade({ unidadeId: req.params.unidadeId, mes: req.query.mes, hojeIso: hoje(req) }, deps(req))));

// --------------------------------------------------------------- Mentorados
//
// Somente leitura. Consolida contas + vínculos empresa/unidade — a mesma
// leitura do Painel SuperAdmin, exposta ao Painel Administrativo. Nenhuma ação
// administrativa é alcançável por aqui.

// GET /administrativo/mentorados
export const mentorados = asyncHandler(async (req, res) =>
  ok(res, await listarMentorados({}, deps(req))));

// ------------------------------------------------- Financeiro / Relatorios

// GET /administrativo/rankings/faturamento?mes=&escopo=&limite=
export const rankingFaturamento = asyncHandler(async (req, res) =>
  ok(res, await service.rankingDeFaturamento({
    mes: req.query.mes, escopo: req.query.escopo, limite: req.query.limite, hojeIso: hoje(req),
  }, deps(req))));

// GET /administrativo/rankings/conformidade?mes=&escopo=&ordem=&limite=
export const rankingConformidade = asyncHandler(async (req, res) =>
  ok(res, await service.rankingDeConformidade({
    mes: req.query.mes, escopo: req.query.escopo, ordem: req.query.ordem, limite: req.query.limite, hojeIso: hoje(req),
  }, deps(req))));

// GET /administrativo/relatorios/resumo?mes=&topN=
export const relatorioResumo = asyncHandler(async (req, res) =>
  ok(res, await service.relatorioExecutivo({ mes: req.query.mes, topN: req.query.topN, hojeIso: hoje(req) }, deps(req))));

// GET /administrativo/relatorios/evolucao?mes=&organizacaoId=
export const relatorioEvolucao = asyncHandler(async (req, res) =>
  ok(res, await service.evolucaoFaturamento({ mes: req.query.mes, organizacaoId: req.query.organizacaoId, hojeIso: hoje(req) }, deps(req))));

// GET /administrativo/relatorios/executivo?mes=&topN=  (pacote do PDF)
export const relatorioExecutivo = asyncHandler(async (req, res) =>
  ok(res, await service.relatorioExecutivoCompleto({ mes: req.query.mes, topN: req.query.topN, hojeIso: hoje(req) }, deps(req))));

// GET /administrativo/relatorios/lucratividade?semana=AAAA-MM-DD
export const relatorioLucratividade = asyncHandler(async (req, res) =>
  ok(res, await service.lucratividadeSemanal({ semana: req.query.semana, hojeIso: hoje(req) }, deps(req))));

// ------------------------------------- Desbloqueio de dia (migration 068)
//
// As únicas rotas de ESCRITA do painel. O ator vem de `identidadeOperacional`
// (a mesma fonte do resto do sistema) — nunca do corpo da requisição, que só
// carrega data/motivo/observação.

const autor = (req) => {
  const id = identidadeOperacional(req);
  return { id: id.contaId, perfilId: id.perfilId, nome: id.nome, email: id.email };
};

// POST /administrativo/unidades/:unidadeId/desbloqueios  { data, motivo, observacao? }
export const criarDesbloqueio = asyncHandler(async (req, res) =>
  ok(res, await service.desbloquearDia({
    unidadeId: req.params.unidadeId,
    data: req.body?.data, motivo: req.body?.motivo, observacao: req.body?.observacao,
    hojeIso: hoje(req), autor: autor(req), req,
  }, deps(req)), 201));

// DELETE /administrativo/unidades/:unidadeId/desbloqueios/:desbloqueioId
export const revogarDesbloqueio = asyncHandler(async (req, res) =>
  ok(res, await service.revogarDesbloqueioDia({
    unidadeId: req.params.unidadeId, desbloqueioId: req.params.desbloqueioId,
    hojeIso: hoje(req), autor: autor(req), req,
  }, deps(req))));

// GET /administrativo/unidades/:unidadeId/desbloqueios?mes=YYYY-MM
export const listarDesbloqueios = asyncHandler(async (req, res) =>
  ok(res, await service.historicoDesbloqueios({
    unidadeId: req.params.unidadeId, mes: req.query.mes, hojeIso: hoje(req),
  }, deps(req))));

/** Qualquer rota não mapeada sob /administrativo é 404 em JSON (nunca cai no app). */
export function naoEncontrado(req, res) {
  res.status(404).json({ error: `Rota não encontrada: ${req.method} ${req.originalUrl}` });
}
