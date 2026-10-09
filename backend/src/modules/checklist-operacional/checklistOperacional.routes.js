// Rotas do Checklist Operacional.
//
// Montadas em routes.js sob:
//   tenant.use("/checklist-operacional", requireModulo(MODULOS.IFOOD), checklistOperacionalRouter)
// Mesma régua de acesso dos pedidos iFood (GET /integracoes/ifood/pedidos): módulo `ifood` contratado +
// INTEGRACOES_VER. O Checklist mostra o mesmo dado operacional, então não pode ser mais aberto do que ele.

import { Router } from "express";
import { requirePermissao } from "../../middlewares/auth.js";
import { PERMISSOES } from "../../shared/permissoes.js";
import * as controller from "./checklistOperacional.controller.js";

export const checklistOperacionalRouter = Router();

checklistOperacionalRouter.get("/resumo", requirePermissao(PERMISSOES.INTEGRACOES_VER), controller.resumo);
