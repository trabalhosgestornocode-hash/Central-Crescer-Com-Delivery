import { Router } from "express";
import { PERM_FIN } from "../../shared/gestaoFinanceira.permissoes.js";
import { exigirPermissaoFinanceira } from "../../middlewares/financeiro.js";

// Montado em routes.js sob `requireFinanceiro()`. O domínio (Agente 2) será anexado aqui via ./dominio/index.js.
export const gestaoFinanceiraRouter = Router();

gestaoFinanceiraRouter.get("/status", exigirPermissaoFinanceira(PERM_FIN.VER), (req, res) => {
  res.json({ habilitado: true, nivel: req.financeiro.nivel, permissoes: req.financeiro.permissoes });
});
