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
parserFoodDeliveryRouter.get("/catalogos", ver, controller.catalogos);

// Cadastro mestre de entregadores (item 16 — reusa importar p/ gestão operacional).
parserFoodDeliveryRouter.get("/entregadores", ver, controller.listarEntregadores);
parserFoodDeliveryRouter.get("/entregadores/sugestoes", importar, controller.sugestoesEntregadores);
parserFoodDeliveryRouter.post("/entregadores", importar, controller.criarEntregador);
parserFoodDeliveryRouter.post("/entregadores/reconhecer", importar, controller.reconhecerEntregadores);
parserFoodDeliveryRouter.patch("/entregadores/:id", importar, controller.editarEntregador);

// Lançamentos operacionais (manual / taxa_adicional / avulso).
parserFoodDeliveryRouter.get("/lancamentos", ver, controller.listarLancamentos);
parserFoodDeliveryRouter.post("/lancamentos", importar, controller.criarLancamento);
parserFoodDeliveryRouter.patch("/lancamentos/:id", importar, controller.editarLancamento);
parserFoodDeliveryRouter.post("/lancamentos/:id/excluir", excluir, controller.excluirLancamento);
parserFoodDeliveryRouter.post("/lancamentos/:id/restaurar", excluir, controller.restaurarLancamento);
parserFoodDeliveryRouter.delete("/lancamentos/:id", excluir, controller.hardDeleteLancamento);

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
