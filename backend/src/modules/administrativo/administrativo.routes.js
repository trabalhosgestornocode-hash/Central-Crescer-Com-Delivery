import { Router } from "express";
import { performanceRouter } from './performance/performance.routes.js';
import { desenvolvimentoRouter } from '../desenvolvimento/desenvolvimento.routes.js';
import * as c from "./administrativo.controller.js";
import { requirePainelAdministrativo, exigirMfaSeExigido } from "../../middlewares/auth.js";
import { limiteDeTaxa } from "../../shared/rateLimit.js";
import { RATE_LIMIT } from "../../config/limites.js";

// API do PAINEL ADMINISTRATIVO da Crescer com Delivery.
//
// Um TERCEIRO "mundo" da API, ao lado de:
//   1. SESSÃO      — sem contexto.
//   2. PLATAFORMA  — SuperAdmin (técnico). Nunca tem req.tenant.
//   3. TENANT      — exige Context Token; todo dado escopado por ele.
//   4. ADMINISTRATIVO — GERENCIAL. Monitoramento cross-tenant. Nunca tem
//      req.tenant. NÃO concede poder técnico de SuperAdmin.
//
// `requirePainelAdministrativo` no ROUTER INTEIRO — mesma escolha deliberada
// do plataformaRouter: uma rota nova adicionada aqui já nasce protegida. O
// SuperAdmin passa por bypass (ele já enxerga tudo); qualquer outro usuário
// precisa do flag em `painel_administrativo_usuarios`, carregado por
// requireAuth e relido a cada request (revogar surte efeito na hora).
//
// Nenhuma rota daqui passa por `requireContexto`: o Painel Administrativo não
// tem empresa. As leituras cross-tenant (fases E/F) usam service_role dentro
// deste módulo, exatamente como plataforma.* — nunca um bypass genérico dos
// middlewares multi-tenant.

export const administrativoRouter = Router();
administrativoRouter.use(requirePainelAdministrativo);
// MFA — DORMENTE (no-op enquanto MFA_ENFORCE_PAINEL_ADM != "true").
administrativoRouter.use(exigirMfaSeExigido("painelAdministrativo"));
// Rede contra script descontrolado (só leitura, já restrito ao Painel Adm).
administrativoRouter.use(limiteDeTaxa({ escopo: "administrativo", ...RATE_LIMIT.administrativo }));

// ---- Fase B: sanidade da cadeia de autorização
administrativoRouter.get("/ping", c.ping);
administrativoRouter.use('/performance', performanceRouter);

// ---- Fase F: monitoramento cross-tenant (monitor "Dashboard iFood").
// Somente leitura. O universo monitorado (unidades elegíveis) e os
// lançamentos são carregados em lote no service — nunca `for unidade: SELECT`.
//
// (A ÚNICA exceção ao "somente leitura" deste router é o bloco de
// desbloqueios logo abaixo — POST/DELETE que concedem/revogam permissão de
// lançamento de UM dia, sem tocar em nenhum dado operacional.)
administrativoRouter.get("/visao-geral", c.visaoGeral);
administrativoRouter.get("/monitoramento-diario", c.monitoramentoDiario);
administrativoRouter.get("/pendencias", c.pendencias);
administrativoRouter.get("/empresas", c.empresas);            // antes de /empresas/:id
administrativoRouter.get("/empresas/:organizacaoId", c.detalheEmpresa);
administrativoRouter.get("/unidades/:unidadeId/calendario", c.calendarioUnidade);

// ---- Desbloqueio administrativo de um dia do Dashboard iFood (migration 068).
//
// PRIMEIRA e ÚNICA escrita deste router — o resto continua somente leitura. A
// autorização é a MESMA do módulo inteiro (`requirePainelAdministrativo` no
// router, com bypass de SuperAdmin): não existe permissão nova, e usuário
// comum de empresa não alcança estas rotas nem chamando direto.
//
// Escopo estreito por construção: uma unidade, uma data, um tipo. Nunca
// atinge outra unidade/empresa/data nem qualquer outro módulo. Ver
// administrativo.service.js#desbloquearDia.
administrativoRouter.get("/unidades/:unidadeId/desbloqueios", c.listarDesbloqueios);
administrativoRouter.post("/unidades/:unidadeId/desbloqueios", c.criarDesbloqueio);
administrativoRouter.delete("/unidades/:unidadeId/desbloqueios/:desbloqueioId", c.revogarDesbloqueio);

// ---- Financeiro / Relatorios. Rankings e relatorio executivo vivem em rotas
// proprias para nao inchar o payload da Visao Geral.
administrativoRouter.get("/rankings/faturamento", c.rankingFaturamento);
administrativoRouter.get("/rankings/conformidade", c.rankingConformidade);
administrativoRouter.get("/relatorios/resumo", c.relatorioResumo);
administrativoRouter.get("/relatorios/evolucao", c.relatorioEvolucao);
administrativoRouter.get("/relatorios/executivo", c.relatorioExecutivo);

// Qualquer outra coisa sob /administrativo é 404 em JSON.
administrativoRouter.use('/desenvolvimento', desenvolvimentoRouter);
administrativoRouter.use(c.naoEncontrado);
