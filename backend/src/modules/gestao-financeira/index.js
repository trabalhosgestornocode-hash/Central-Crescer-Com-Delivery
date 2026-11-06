import { Router } from "express";
import { PERM_FIN } from "../../shared/gestaoFinanceira.permissoes.js";
import { autorizarAcaoFinanceira } from "../../middlewares/financeiro.js";
import { dominioRouter } from "./dominio/index.js";
import { financeiro2Habilitado } from "../../shared/financeiro2.flag.js";

// Montado em routes.js sob `requireFinanceiro()` (autenticação -> contexto -> gate financeiro). O domínio (Agente 2) é anexado ao final.
export const gestaoFinanceiraRouter = Router();

gestaoFinanceiraRouter.get("/status", autorizarAcaoFinanceira(PERM_FIN.VER), (req, res) => {
  // financeiro2: feature flag (FINANCEIRO_2_ORGANIZACOES) — o frontend só mostra as telas novas quando o servidor confirma.
  res.json({ data: { habilitado: true, nivel: req.financeiro.nivel, permissoes: req.financeiro.permissoes, financeiro2: financeiro2Habilitado(req.financeiro.organizacaoId) } });
});

// Domínio financeiro (Agente 2). Já está atrás do gate de routes.js; além disso, CADA rota declara a ação mínima (autorizarAcaoFinanceira).
// /status acima responde antes: é do Agente 1 e não depende do domínio.
gestaoFinanceiraRouter.use(dominioRouter);
