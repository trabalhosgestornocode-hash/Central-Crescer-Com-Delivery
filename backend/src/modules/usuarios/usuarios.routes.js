import { Router } from "express";
import * as controller from "./usuarios.controller.js";
import { requirePermissao } from "../../middlewares/auth.js";
import { PERMISSOES } from "../../shared/permissoes.js";

// A autorização passou de PAPEL para PERMISSÃO. O motivo prático: os papéis
// mudaram de nome no modelo multiempresa ('admin' -> 'organization_admin'), e
// listar nomes de papel em cada rota espalharia essa renomeação por todo o
// código. `usuarios.gerenciar` continua significando a mesma coisa
// independentemente de como os cargos venham a se chamar.
const podeVer = requirePermissao(PERMISSOES.USUARIOS_VER);
const podeGerenciar = requirePermissao(PERMISSOES.USUARIOS_GERENCIAR);

export const usuariosRouter = Router();
usuariosRouter.get("/papeis", podeVer, controller.papeis);   // antes de qualquer /:id
usuariosRouter.get("/convites", podeGerenciar, controller.listarConvites);
usuariosRouter.delete("/convites/:id", podeGerenciar, controller.revogarConvite);
usuariosRouter.get("/", podeVer, controller.listar);
usuariosRouter.post("/", podeGerenciar, controller.criar);
usuariosRouter.patch("/:id", podeGerenciar, controller.atualizar);
usuariosRouter.delete("/:id", podeGerenciar, controller.excluir);

// D-14 — aceite do convite (autenticado, SEM contexto de empresa: o convidado ainda não tem vínculo). Montado em routes.js.
export const conviteUsuarioRouter = Router();
conviteUsuarioRouter.post("/aceitar", controller.aceitarConvite);
