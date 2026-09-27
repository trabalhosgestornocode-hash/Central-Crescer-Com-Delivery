// Rotas da integração iFood.
//
// Montadas em routes.js sob:
//   tenant.use("/integracoes/ifood", requireModulo(MODULOS.IFOOD), ifoodRouter)
// ou seja: já passaram por requireAuth + requireContexto + módulo `ifood`
// contratado pela empresa.
//
// Autorização de AÇÃO: requirePermissao(INTEGRACOES_GERENCIAR) — a permissão
// documentada como preferida (unit_manager, finance/operations e
// organization_admin a possuem). NÃO usamos requirePapel("admin").

import { Router } from "express";
import { requirePermissao } from "../../middlewares/auth.js";
import { PERMISSOES } from "../../shared/permissoes.js";
import { limitarPorUsuario } from "./ifood.ratelimit.js";
import { IFOOD_RATE_LIMIT } from "./ifood.constants.js";
import * as controller from "./ifood.controller.js";

export const ifoodRouter = Router();

const gerenciar = requirePermissao(PERMISSOES.INTEGRACOES_GERENCIAR);

// --- Fluxo OAuth distribuído --------------------------------------------
ifoodRouter.post(
  "/oauth/start",
  gerenciar,
  limitarPorUsuario({ escopo: "ifood:start", max: IFOOD_RATE_LIMIT.maxStart }),
  controller.iniciar,
);

ifoodRouter.post(
  "/oauth/complete",
  gerenciar,
  limitarPorUsuario({ escopo: "ifood:complete", max: IFOOD_RATE_LIMIT.maxComplete }),
  controller.concluir,
);

// --- Merchant API (READ-ONLY) — descoberta e validação individual --------
const limitarMerchants = limitarPorUsuario({ escopo: "ifood:merchants", max: IFOOD_RATE_LIMIT.maxMerchants });

ifoodRouter.get("/merchants", gerenciar, limitarMerchants, controller.descobrirMerchants);
ifoodRouter.post("/merchants/link", gerenciar, limitarMerchants, controller.vincularMerchant);
ifoodRouter.get("/merchants/:merchantId", gerenciar, limitarMerchants, controller.detalharMerchant);

// --- Financial (Fase 2 — Homologação, READ-ONLY) — chama a API externa ---
const limitarFinancial = limitarPorUsuario({ escopo: "ifood:financial", max: IFOOD_RATE_LIMIT.maxFinancial });

ifoodRouter.get("/financial/sales", gerenciar, limitarFinancial, controller.financialSales);
ifoodRouter.get("/financial/events", gerenciar, limitarFinancial, controller.financialEvents);
ifoodRouter.get("/financial/settlements", gerenciar, limitarFinancial, controller.financialSettlements);
ifoodRouter.get("/financial/reconciliation", gerenciar, limitarFinancial, controller.financialReconciliation);
ifoodRouter.post("/financial/reconciliation/on-demand", gerenciar, limitarFinancial, controller.financialReconciliationOnDemandSolicitar);
ifoodRouter.get("/financial/reconciliation/on-demand/:requestId", gerenciar, limitarFinancial, controller.financialReconciliationOnDemandStatus);
ifoodRouter.get("/financial/anticipations", gerenciar, limitarFinancial, controller.financialAnticipations);
ifoodRouter.get("/financial/conciliation", gerenciar, limitarFinancial, controller.financialConciliation);

// --- Status da integração (leitura — não chama a API do iFood) -----------
ifoodRouter.get("/status", requirePermissao(PERMISSOES.INTEGRACOES_VER), controller.status);

// --- Desconexão LOCAL (descarta tokens, marca conexão 'revogada') --------
ifoodRouter.delete("/", gerenciar, controller.desconectar);
