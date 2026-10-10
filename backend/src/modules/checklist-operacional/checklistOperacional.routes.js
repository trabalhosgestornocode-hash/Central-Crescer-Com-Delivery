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

checklistOperacionalRouter.get(
  "/resumo",
  requireAlgumaPermissao(PERMISSOES.CHECKLIST_VISUALIZAR, PERMISSOES.INTEGRACOES_VER),
  controller.resumo,
);
