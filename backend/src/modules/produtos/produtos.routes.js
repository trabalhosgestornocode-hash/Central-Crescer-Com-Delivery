import { Router } from "express";
import * as controller from "./produtos.controller.js";
import { requirePermissao } from "../../middlewares/auth.js";
import { PERMISSOES } from "../../shared/permissoes.js";

export const produtosRouter = Router();

const editarProdutos = requirePermissao(PERMISSOES.PRODUTOS_EDITAR);
// Homologar a ficha define o que a empresa chama de CMV oficial: só administrador (configuracoes.gerenciar).
const homologarFicha = requirePermissao(PERMISSOES.CONFIG_GERENCIAR);

produtosRouter.get("/", controller.listar);
produtosRouter.get("/historico/recentes", controller.historicoRecente); // antes de "/:id"
produtosRouter.get("/catalogo/pendencias", controller.pendenciasCatalogo);
produtosRouter.get("/catalogo/fichas", controller.fichasCatalogo); // lista do catálogo (antes de "/:id")
produtosRouter.post("/catalogo/homologar-lote", homologarFicha, controller.homologarLote); // pendências da carga importada (antes de "/:id")
produtosRouter.get("/:id", controller.obter);
produtosRouter.get("/:id/historico", controller.historico);
produtosRouter.put("/:id", editarProdutos, controller.atualizar);
produtosRouter.patch("/:id/homologacao", homologarFicha, controller.homologacao);
produtosRouter.post("/:id/pendencias-carga/conferir", homologarFicha, controller.conferirPendenciasCarga); // mesma autoridade de homologar
produtosRouter.delete("/:id", editarProdutos, controller.remover);

// Ficha técnica editável (escrita exige permissão de edição de produtos).
produtosRouter.post("/:id/ficha", editarProdutos, controller.adicionarComponente);
produtosRouter.patch("/:id/ficha/:fichaId", editarProdutos, controller.atualizarComponente);
produtosRouter.delete("/:id/ficha/:fichaId", editarProdutos, controller.removerComponente);
