import { Router } from "express";
import * as controller from "./unidade.controller.js";
import { requirePermissao } from "../../middlewares/auth.js";
import { PERMISSOES } from "../../shared/permissoes.js";

// Ver a tabela oficial: todo mundo com acesso a Configurações (configuracoes.ver).
// Alterar de verdade: só configuracoes.gerenciar (hoje, só organization_admin
// — ver permissoes.js) — nunca a mesma permissão de quem só compara tabelas
// no Dashboard/Produtos-CMV (isso nem passa por aqui, é módulo próprio).
const podeVer = requirePermissao(PERMISSOES.CONFIG_VER);
const podeGerenciar = requirePermissao(PERMISSOES.CONFIG_GERENCIAR);

export const unidadeRouter = Router();
unidadeRouter.get("/tabelas-comerciais", podeVer, controller.obterTabelasComerciais);
unidadeRouter.patch("/tabelas-comerciais", podeGerenciar, controller.alterarTabelaComercial);

// Dados da Unidade (nome, cnpj, endereço, responsável, e-mail, telefone).
// Status é read-only aqui — ativar/desativar unidade é só do SuperAdmin.
unidadeRouter.get("/dados", podeVer, controller.obterDados);
unidadeRouter.patch("/dados", podeGerenciar, controller.atualizarDados);

// Metas e Limites de CMV da unidade (unidade_config — migration 058).
unidadeRouter.get("/metas-cmv", podeVer, controller.obterMetasCmv);
unidadeRouter.patch("/metas-cmv", podeGerenciar, controller.salvarMetasCmv);
