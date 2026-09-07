import { Router } from "express";
import * as controller from "./parserFoodDelivery.controller.js";
import { requirePermissao } from "../../middlewares/auth.js";
import { PERMISSOES } from "../../shared/permissoes.js";
import { limiteDeTaxa } from "../../shared/rateLimit.js";
import { RATE_LIMIT } from "../../config/limites.js";

export const parserFoodDeliveryRouter = Router();

// Mesmo orçamento de importação compartilhado entre módulos (ver vendas.routes.js).
const limiteImport = limiteDeTaxa({ escopo: "importacao", ...RATE_LIMIT.importacao });

const ver = requirePermissao(PERMISSOES.PARSER_FD_VER);
const importar = requirePermissao(PERMISSOES.PARSER_FD_IMPORTAR);
const excluir = requirePermissao(PERMISSOES.PARSER_FD_EXCLUIR);
const classificar = requirePermissao(PERMISSOES.PARSER_FD_CLASSIFICAR);

parserFoodDeliveryRouter.get("/periodo", ver, controller.periodo);
parserFoodDeliveryRouter.get("/importacoes", ver, controller.importacoes);
parserFoodDeliveryRouter.get("/importacoes/:id", ver, controller.importacaoDetalhe);
parserFoodDeliveryRouter.get("/importacoes/:id/arquivo", ver, controller.arquivoImportacao);
parserFoodDeliveryRouter.post("/importacoes/:id/codigos-sem-taxa", importar, controller.editarCodigos);
parserFoodDeliveryRouter.post("/importacoes/:id/pedidos/:pedidoId/classificacao", classificar, controller.alterarClassificacao);
parserFoodDeliveryRouter.post("/importacoes/:id/excluir", excluir, controller.excluirImportacao);

// Importação: prévia (dry-run) do arquivo -> prévia da conciliação -> confirmação.
parserFoodDeliveryRouter.post("/importar/preview", importar, limiteImport, controller.importarPreview);
parserFoodDeliveryRouter.post("/conciliar/preview", importar, limiteImport, controller.conciliarPreview);
parserFoodDeliveryRouter.post("/conciliar/confirmar", importar, limiteImport, controller.conciliarConfirmar);
