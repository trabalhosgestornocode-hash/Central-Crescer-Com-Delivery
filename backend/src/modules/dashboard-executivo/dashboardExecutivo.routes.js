import { Router } from "express";
import * as controller from "./dashboardExecutivo.controller.js";
import { requirePermissao } from "../../middlewares/auth.js";
import { PERMISSOES } from "../../shared/permissoes.js";

// Leitura exige dashboard_executivo.ver; lançar exige .lancar. A correção de
// um lançamento já finalizado exige .corrigir — isso é verificado dentro do
// service (a regra depende do STATUS do registro, não só da rota), nunca só
// no frontend.
export const dashboardExecutivoRouter = Router();

const ver = requirePermissao(PERMISSOES.DASHBOARD_EXECUTIVO_VER);
const lancar = requirePermissao(PERMISSOES.DASHBOARD_EXECUTIVO_LANCAR);
const corrigir = requirePermissao(PERMISSOES.DASHBOARD_EXECUTIVO_CORRIGIR);
const configurar = requirePermissao(PERMISSOES.DASHBOARD_EXECUTIVO_CONFIGURAR);
const resetarTeste = requirePermissao(PERMISSOES.DASHBOARD_EXECUTIVO_RESETAR_TESTE);
const excluir = requirePermissao(PERMISSOES.DASHBOARD_EXECUTIVO_EXCLUIR);

dashboardExecutivoRouter.get("/unidades", ver, controller.unidades);
dashboardExecutivoRouter.get("/mes", ver, controller.mes);
dashboardExecutivoRouter.get("/historico", ver, controller.historico);
dashboardExecutivoRouter.get("/simulador-preco", ver, controller.simuladorPreco);
dashboardExecutivoRouter.get("/lancamentos/:data", ver, controller.lancamentoPorData);
dashboardExecutivoRouter.post("/lancamentos", lancar, controller.criarLancamento);
dashboardExecutivoRouter.put("/lancamentos/:id", lancar, controller.atualizarLancamento);

// Exclusão universal do lançamento de um dia — real ou teste, restrita a
// organization_admin (ver permissoes.js). Sempre exige motivo no corpo.
dashboardExecutivoRouter.post("/lancamentos/:id/excluir", excluir, controller.excluirLancamento);

// Lançamento de faturamento mensal (distribuição p/ meses históricos sem dado
// diário). Mesma permissão de lançar um dia — é uma outra forma de criar
// lançamento, não uma ação mais sensível.
dashboardExecutivoRouter.post("/lancamentos-mensais", lancar, controller.lancamentoMensal);

// Ver o lançamento mensal original de um mês (mesma permissão de leitura).
dashboardExecutivoRouter.get("/lancamentos-mensais", ver, controller.obterLancamentoMensal);

// Editar/complementar um lançamento mensal existente — os dias que ele gerou
// já nascem 'finalizado', então editar exige CORRIGIR (mesma régua usada em
// atualizarLancamento por dia), não só LANCAR.
dashboardExecutivoRouter.put("/lancamentos-mensais/:id", corrigir, controller.atualizarLancamentoMensal);

// Excluir um lançamento mensal (só os dias que ele gerou) — mesma permissão
// restrita da exclusão universal de um dia (organization_admin).
dashboardExecutivoRouter.post("/lancamentos-mensais/:id/excluir", excluir, controller.excluirLancamentoMensal);

// Modelo logístico do iFood (Marketplace x Full Service) — quem só vê usa VER;
// trocar exige CONFIGURAR (finance/operations/organization_admin, não unit_manager).
dashboardExecutivoRouter.get("/unidades/:unidadeId/modelo-logistico", ver, controller.modeloLogistico);
dashboardExecutivoRouter.put("/unidades/:unidadeId/modelo-logistico", configurar, controller.atualizarModeloLogistico);
dashboardExecutivoRouter.get("/unidades/:unidadeId/modelo-logistico/historico", ver, controller.historicoModeloLogistico);

// Reset de dia — SÓ em unidade de teste (eh_teste=true), revalidado sempre no
// service. Mesma permissão de correção não serve aqui de propósito: é uma
// ação estritamente de desenvolvimento/teste, com sua própria permissão.
dashboardExecutivoRouter.post("/unidades/:unidadeId/reset-teste", resetarTeste, controller.resetTeste);
