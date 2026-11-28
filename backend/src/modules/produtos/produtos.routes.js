import { Router } from "express";
import * as controller from "./produtos.controller.js";
import * as cmv from "./produtosCmv.controller.js";
import { requirePermissao, requireModulo } from "../../middlewares/auth.js";
import { MODULOS } from "../../shared/modulos.js";
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
// Produtos / CMV 2.0 (todas antes de "/:id"). Leitura: qualquer papel com o módulo. Escrita: mesmas autoridades de antes.
produtosRouter.use("/cmv", requireModulo(MODULOS.PRODUTOS_CMV_2)); // piloto: só empresa/unidade habilitada
produtosRouter.get("/cmv/saude", cmv.saude);
produtosRouter.get("/cmv/pendencias", cmv.pendencias);
produtosRouter.get("/cmv/mentoria", cmv.mentoria);
produtosRouter.post("/cmv/rendimentos/previa", cmv.previaRendimentos);
produtosRouter.post("/cmv/rendimentos/aplicar", homologarFicha, cmv.aplicarRendimentos);
produtosRouter.get("/cmv/custo-zero/:insumoId/previa", cmv.previaCustoZero);
produtosRouter.post("/cmv/custo-zero/:insumoId", homologarFicha, cmv.definirCustoZero);
produtosRouter.post("/cmv/aproveitamento/validar", cmv.validarAproveitamento);
produtosRouter.get("/cmv/rascunhos", cmv.listarRascunhos);
produtosRouter.get("/cmv/rascunhos/:rid", cmv.obterRascunho);
produtosRouter.post("/cmv/rascunhos", editarProdutos, cmv.salvarRascunho);
produtosRouter.put("/cmv/rascunhos/:rid", editarProdutos, cmv.salvarRascunho);
produtosRouter.delete("/cmv/rascunhos/:rid", editarProdutos, cmv.excluirRascunho);
produtosRouter.get("/cmv/homologacao/previa", cmv.previaHomologacao);
produtosRouter.post("/cmv/homologacao/lote", homologarFicha, cmv.homologarSelecionadas);
produtosRouter.post("/cmv/fichas", editarProdutos, cmv.criarFicha);
produtosRouter.get("/cmv/fichas/:id/recuperacao", cmv.recuperarFicha);
produtosRouter.post("/cmv/fichas/:id/simular", cmv.simular);
produtosRouter.put("/cmv/fichas/:id/preco", editarProdutos, cmv.definirPreco);
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
