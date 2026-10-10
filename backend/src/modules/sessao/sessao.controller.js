import { asyncHandler } from "../../shared/asyncHandler.js";
import * as service from "./sessao.service.js";
import { renovarContexto } from "./sessao.renovacao.service.js";
import * as perfilService from "./perfil.service.js";
import * as v from "../../shared/validar.js";
import { auditar, ACOES } from "../../shared/auditoria.js";

/** Origem da requisição — usada na auditoria e gravada na sessão. */
function origem(req) {
  const encaminhado = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(encaminhado) ? encaminhado[0] : encaminhado)?.split(",")[0]?.trim()
    || req.socket?.remoteAddress || null;
  return { ip, userAgent: req.header("user-agent") || null };
}

// GET /api/v1/sessao/perfis — perfis operacionais ATIVOS da conta autenticada.
// Fase C: entre o login e a seleção de contexto. NÃO exige contexto. A conta
// vem SEMPRE de req.user.id — nunca do cliente. Conta A jamais lista perfis de
// Conta B. Nunca devolve pin_hash (só o booleano `temPin`).
export const perfis = asyncHandler(async (req, res) => {
  res.json({ data: await perfilService.listarPerfisDaConta(req.user.id) });
});

// POST /api/v1/sessao/selecionar-perfil — Fase H. Valida a posse do perfil e,
// para conta MULTI-PERFIL, o PIN. Em caso de sucesso devolve o
// `profileSelectionToken` — a prova (assinada, 5 min) que `POST /sessao/selecionar`
// exige de conta multi-perfil. Conta de 1 perfil recebe a prova sem PIN.
// NUNCA loga `pin` nem o token (ver Fase H, ponto 37).
export const selecionarPerfil = asyncHandler(async (req, res) => {
  const body = v.corpo(req.body);
  const data = await perfilService.selecionarPerfil({
    contaId: req.user.id,
    perfilId: body.perfilId,
    pin: body.pin,
  });
  res.json({ data });
});

// GET /api/v1/sessao/acessos — empresas/unidades que o usuário pode acessar.
// É o que alimenta a tela de seleção logo após o login.
//   * sem `?perfilId=`  -> LEGACY: acessos da CONTA (usuarios_*.usuario_id).
//                          É o caminho que o frontend atual usa — INALTERADO.
//   * com `?perfilId=`   -> acessos DAQUELE PERFIL (usuarios_*.perfil_id),
//                          validando antes que o perfil é da conta. Isolamento
//                          obrigatório: Fulana 1 só enxerga as empresas dela.
//                          (Requer a migration 060 aplicada.)
export const acessos = asyncHandler(async (req, res) => {
  const perfilId = req.query.perfilId;
  const data = perfilId
    ? await perfilService.listarAcessosDoPerfil({ contaId: req.user.id, perfilId })
    : await service.listarAcessos({ usuarioId: req.user.id });
  // "Pode acessar o AMBIENTE Painel Administrativo?" — reflete o acesso EFETIVO
  // (associação explícita em painel_administrativo_usuarios OU SuperAdmin por
  // bypass, ver requirePainelAdministrativo). Não altera o valor estrutural de
  // `req.user.painelAdministrativo`, que continua sendo só a associação explícita.
  res.json({ data: { ...data, painelAdministrativo: !!(req.user.painelAdministrativo || req.user.superadmin) } });
});

// POST /api/v1/sessao/selecionar — valida CONTA → PERFIL → EMPRESA → UNIDADE e
// emite o Context Token v2. `perfilId` é OPCIONAL no corpo:
//   * ausente + conta com 1 perfil ativo -> resolvido automaticamente
//     (compat: frontend antigo / conta legada);
//   * ausente + 2+ perfis -> 400 { perfilObrigatorio: true };
//   * informado -> validado contra a conta autenticada.
// A conta vem SEMPRE de req.user.id — nunca do corpo.
export const selecionar = asyncHandler(async (req, res) => {
  const body = v.corpo(req.body);
  const data = await service.selecionarContexto({
    usuario: req.user,
    perfilId: body.perfilId,
    // Fase H — a PROVA de PIN (Profile Selection Token). Obrigatória para conta
    // multi-perfil; ignorada para conta de 1 perfil. Nunca logada.
    provaSelecao: body.profileSelectionToken,
    organizacaoId: body.organizacaoId,
    unidadeId: body.unidadeId,
    troca: v.booleano(body.troca),
    ...origem(req),
  });
  res.status(201).json({ data });
});

// POST /api/v1/sessao/trocar-unidade — troca de unidade a partir do seletor
// global do topbar (exige contexto prévio; ver
// sessao.service.js#trocarUnidadeDoContexto para a regra de impersonação).
// MODEL Y: revoga SÓ a sessão atual (req.acesso.sessionId); as sessões irmãs
// (mesmo perfil em outro device, ou outro perfil da conta) ficam intactas.
export const trocarUnidade = asyncHandler(async (req, res) => {
  const body = v.corpo(req.body);
  const data = await service.trocarUnidadeDoContexto({
    usuario: req.user,
    perfilId: req.acesso.perfilId,        // da sessão ATUAL, nunca do cliente
    organizacaoId: req.tenant.organizacaoId,
    unidadeId: body.unidadeId,
    impersonando: !!req.acesso.impersonando,
    sessionIdAtual: req.acesso.sessionId, // a ÚNICA sessão revogada
    ...origem(req),
  });
  res.status(201).json({ data });
});

// POST /api/v1/sessao/renovar — renovação automática do contexto do PERFIL DE EXIBIÇÃO (ver
// sessao.service.js#renovarContexto). NÃO lê o corpo: conta, empresa, unidade e perfil vêm da sessão já validada
// (req.user/req.tenant/req.acesso), nunca do cliente. 200 com `renovado:false` = ainda cedo (nada mudou).
export const renovar = asyncHandler(async (req, res) => {
  const data = await renovarContexto({
    usuario: req.user, acesso: req.acesso, tenant: req.tenant, ...origem(req),
  });
  res.status(data.renovado ? 201 : 200).json({ data });
});

// GET /api/v1/sessao/atual — contexto vigente (recarregamento de página).
export const atual = asyncHandler(async (req, res) => {
  res.json({ data: service.contextoAtual(req) });
});

// GET /api/v1/sessao/unidades — unidades da empresa do contexto ATUAL que a
// sessão pode escolher no seletor global do topbar (inclusive em "Todas as
// unidades", unidadeId nulo — ver sessao.service.js#listarUnidadesContexto).
export const unidades = asyncHandler(async (req, res) => {
  const data = await service.listarUnidadesContexto({
    usuarioId: req.user.id,
    organizacaoId: req.tenant.organizacaoId,
    impersonando: !!req.acesso.impersonando,
  });
  res.json({ data });
});

// POST /api/v1/sessao/encerrar — revoga o contexto. Serve tanto para "Sair"
// quanto para "Sair da empresa" (fim da impersonação). O corpo não influencia
// nada: o que é revogado vem da identidade autenticada.
export const encerrar = asyncHandler(async (req, res) => {
  const data = await service.encerrarContexto({
    usuario: req.user, acesso: req.acesso ?? null, ...origem(req),
  });
  res.json({ data });
});

// POST /api/v1/sessao/mfa/evento — o frontend avisa que o usuário cadastrou ou
// removeu o 2º fator (o enroll/verify/unenroll acontece client-side via Supabase
// Auth — nós NÃO temos nem armazenamos o segredo TOTP). O backend NÃO confia no
// que o cliente diz: relê `req.user.mfaCadastrada` (que vem de
// supabase.auth.getUser().factors em requireAuth) e audita o ESTADO REAL.
export const mfaEvento = asyncHandler(async (req, res) => {
  const body = v.corpo(req.body);
  const alegado = v.umDeOpcional(body.acao, "Ação", ["cadastrada", "removida"]);
  const temFator = req.user?.mfaCadastrada === true;

  // Estado real manda; o "alegado" só entra nos detalhes para conferência.
  const acao = temFator ? ACOES.MFA_CADASTRADA : ACOES.MFA_REMOVIDA;
  const encaminhado = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(encaminhado) ? encaminhado[0] : encaminhado)?.split(",")[0]?.trim()
    || req.socket?.remoteAddress || null;
  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "usuario",
    acao, entidade: "usuario", entidadeId: req.user.id,
    detalhes: { mfaCadastrada: temFator, alegado: alegado ?? null, aal: req.user.aal ?? null },
    ip, userAgent: req.header("user-agent") || null,
  });
  res.json({ data: { mfaCadastrada: temFator, aal: req.user.aal ?? null } });
});

// POST /api/v1/sessao/senha — define a nova senha do próprio usuário e limpa a
// flag de senha provisória. A identidade é o Access Token; não pede a senha
// atual porque o usuário acabou de autenticar com ela (é o fluxo do 1º acesso).
export const novaSenha = asyncHandler(async (req, res) => {
  const body = v.corpo(req.body);
  const data = await service.definirNovaSenha({
    usuario: req.user, senha: body.senha, ...origem(req),
  });
  res.json({ data });
});
