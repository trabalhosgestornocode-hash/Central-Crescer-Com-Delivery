import { Router } from "express";
import * as controller from "./cmv.controller.js";
import { requirePermissao } from "../../middlewares/auth.js";
import { PERMISSOES } from "../../shared/permissoes.js";

export const cmvRouter = Router();
// Condições comerciais DA EMPRESA do contexto (comissão por canal) — base do Simulador de Preço.
cmvRouter.get("/condicoes-comerciais", requirePermissao(PERMISSOES.CMV_VER), controller.condicoes);
cmvRouter.get("/", controller.listar);              // /cmv?canal=balcao&tabela=A
cmvRouter.get("/produto/:id", controller.porProduto);
