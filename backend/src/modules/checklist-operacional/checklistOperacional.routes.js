// Rotas do Checklist Operacional.
//
// Montadas em routes.js sob:
//   tenant.use("/checklist-operacional", requireModulo(MODULOS.IFOOD), checklistOperacionalRouter)
// Módulo `ifood` contratado + `checklist.visualizar` (a permissão do perfil de exibição, que não tem nenhuma outra).
// `integracoes.ver` continua aceita ENQUANTO existirem sessões abertas antes desta mudança: a lista de permissões
// fica congelada na sessão de contexto (≤ 8 h) e esses contextos não têm a permissão nova. Todo papel que já abria o
// Checklist recebe `checklist.visualizar` junto com a leitura; depois de ≥ 8 h do deploy dá para tirar o "OU".
// Não abre nada além do que já abria: o perfil de exibição NÃO tem integracoes.ver.

import { Router } from "express";
import { requireAlgumaPermissao } from "../../middlewares/auth.js";
import { PERMISSOES } from "../../shared/permissoes.js";
import * as controller from "./checklistOperacional.controller.js";

export const checklistOperacionalRouter = Router();

const visualizar = requireAlgumaPermissao(PERMISSOES.CHECKLIST_VISUALIZAR, PERMISSOES.INTEGRACOES_VER);
// Editar metas: a MESMA régua que a tela já usava para mostrar o botão "Metas" (organization_admin e unit_manager).
// O perfil de exibição não tem nenhuma das duas — e o middleware dele nega qualquer rota fora da lista (só /resumo).
const gerenciarMetas = requireAlgumaPermissao(PERMISSOES.CONFIG_GERENCIAR, PERMISSOES.INTEGRACOES_GERENCIAR);

checklistOperacionalRouter.get("/resumo", visualizar, controller.resumo);

// Metas da unidade (migration 120): leitura, gravação versionada e histórico de alterações.
checklistOperacionalRouter.get("/metas", visualizar, controller.obterMetas);
checklistOperacionalRouter.put("/metas", gerenciarMetas, controller.salvarMetas);
checklistOperacionalRouter.get("/metas/historico", gerenciarMetas, controller.historicoMetas);

// Dashboard Operacional (histórico) e o relatório em Excel do MESMO cálculo.
checklistOperacionalRouter.get("/dashboard", visualizar, controller.dashboard);
checklistOperacionalRouter.get("/dashboard/exportar.xlsx", visualizar, controller.exportarExcel);
