import { asyncHandler } from "../../shared/asyncHandler.js";
import * as service from "./usuarios.service.js";
import * as convites from "./usuarios.convites.js";

// A empresa vem SEMPRE de req.tenant (Context Token). Nenhum handler aqui lê
// organizacaoId do corpo ou da query.

export const listar = asyncHandler(async (req, res) => {
  const data = await service.listarUsuarios({ organizacaoId: req.tenant.organizacaoId });
  res.json({ data });
});

// D-14: conta existente = vínculo imediato; conta nova = convite por e-mail. Senha vinda da tela é IGNORADA (nunca aceita).
export const criar = asyncHandler(async (req, res) => {
  const { nome, email, papel, unidadeId } = req.body ?? {};
  const data = await convites.concederOuConvidar({ req, organizacaoId: req.tenant.organizacaoId, nome, email, papel, unidadeId,
    baseUrl: `${req.protocol}://${req.get("host")}` });
  res.status(201).json({ data });
});

export const listarConvites = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ data: await convites.listarConvites({ organizacaoId: req.tenant.organizacaoId }) });
});

export const revogarConvite = asyncHandler(async (req, res) => {
  res.json({ data: await convites.revogarConvite({ req, organizacaoId: req.tenant.organizacaoId, id: req.params.id }) });
});

/** Sem contexto: o convidado autenticado aceita o convite (o token vem no corpo, nunca na URL). */
export const aceitarConvite = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ data: await convites.aceitarConvite({ req, token: req.body?.token }) });
});

export const atualizar = asyncHandler(async (req, res) => {
  const { papel, ativo } = req.body ?? {};
  const data = await service.atualizarUsuario({
    organizacaoId: req.tenant.organizacaoId, id: req.params.id,
    papel, ativo,
    solicitanteId: req.user.id,             // conta
    solicitantePerfilId: req.perfil?.id,    // PESSOA que agiu (Fase E — guarda de auto-rebaixamento)
  });
  res.json({ data });
});

// Remove o ACESSO a esta empresa. A conta global permanece — só o SuperAdmin
// exclui contas.
export const excluir = asyncHandler(async (req, res) => {
  const data = await service.excluirUsuario({
    organizacaoId: req.tenant.organizacaoId, id: req.params.id,
    solicitanteId: req.user.id,
    solicitantePerfilId: req.perfil?.id,
  });
  res.json({ data });
});

// Cargos disponíveis, para o seletor da tela de usuários.
export const papeis = asyncHandler(async (_req, res) => {
  res.json({ data: service.papeisDisponiveis() });
});
