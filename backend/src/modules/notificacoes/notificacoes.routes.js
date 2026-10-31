// Rotas da Central de Notificações.
//   * notificacoesRouter (TENANT, montado em /api/v1/notificacoes depois de requireContexto): o gestor. D-3 no backend
//     (escopoDeGestao) e no banco (p_unidade_permitida). Nenhum id de empresa/unidade vem do navegador além do alvo, sempre
//     conferido contra o recorte da sessão.
//   * titularRouter (PÚBLICO, montado em /api/publico/notificacoes ANTES de requireAuth): o titular sem conta. Só POST (token
//     e código nunca na URL), limite de taxa próprio por IP, respostas sem dado operacional.
//   * rotas M3 no Painel Administrativo (administrativo.routes.js), travadas por env.
import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { limiteDeTaxa, ipCliente } from "../../shared/rateLimit.js";
import { requirePermissao } from "../../middlewares/auth.js";
import { PERMISSOES } from "../../shared/permissoes.js";
import { exigirVer, exigirGerenciar } from "./notificacoes.permissoes.js";
import { origemParaLinks } from "../../shared/urlPublica.js";
import * as svc from "./notificacoes.service.js";
import * as titular from "./notificacoes.titular.service.js";
import * as m3 from "./notificacoes.m3.js";

const semCache = (res) => res.set("Cache-Control", "no-store");

export const notificacoesRouter = Router();
const ver = requirePermissao(PERMISSOES.NOTIFICACOES_VER);
const gerir = requirePermissao(PERMISSOES.NOTIFICACOES_GERENCIAR);
// gerenciar implica ver (o middleware de permissão é "um OU outro" aqui; o recorte fino é exigirVer/exigirGerenciar)
const verOuGerir = (req, res, next) => ((req.acesso?.permissoes ?? []).includes(PERMISSOES.NOTIFICACOES_GERENCIAR) ? next() : ver(req, res, next));

notificacoesRouter.get("/resumo", verOuGerir, asyncHandler(async (req, res) => { semCache(res); res.json({ data: await svc.resumo({ escopo: exigirVer(req) }) }); }));
notificacoesRouter.get("/categorias", verOuGerir, asyncHandler(async (req, res) => { exigirVer(req); res.json({ data: await svc.listarCategorias() }); }));
notificacoesRouter.get("/destinatarios", verOuGerir, asyncHandler(async (req, res) => { semCache(res); res.json({ data: await svc.listarDestinatarios({ escopo: exigirVer(req) }) }); }));
notificacoesRouter.get("/historico", verOuGerir, asyncHandler(async (req, res) => {
  semCache(res); res.json({ data: await svc.historico({ escopo: exigirVer(req), unidadeId: typeof req.query.unidadeId === "string" ? req.query.unidadeId : null }) });
}));
notificacoesRouter.get("/consentimentos", verOuGerir, asyncHandler(async (req, res) => { semCache(res); res.json({ data: await svc.consentimentos({ escopo: exigirVer(req) }) }); }));
notificacoesRouter.get("/auditoria", gerir, asyncHandler(async (req, res) => { semCache(res); res.json({ data: await svc.auditoria({ escopo: exigirGerenciar(req) }) }); }));
notificacoesRouter.post("/convites", gerir, asyncHandler(async (req, res) => {
  semCache(res); res.status(201).json({ data: await svc.criarConvite({ req, escopo: exigirGerenciar(req), corpo: req.body, baseUrl: () => origemParaLinks({ req }) }) });   // origem confiável, resolvida DEPOIS das checagens de permissão e ANTES de gravar
}));
notificacoesRouter.post("/convites/:id/cancelar", gerir, asyncHandler(async (req, res) => { res.json({ data: await svc.cancelarConvite({ req, escopo: exigirGerenciar(req), id: req.params.id }) }); }));
notificacoesRouter.post("/destinatarios/:id/suspensao", gerir, asyncHandler(async (req, res) => {
  res.json({ data: await svc.suspender({ req, escopo: exigirGerenciar(req), destinatarioId: req.params.id, corpo: req.body }) });
}));
notificacoesRouter.put("/destinatarios/:id/preferencias", gerir, asyncHandler(async (req, res) => {
  res.json({ data: await svc.definirPreferencias({ req, escopo: exigirGerenciar(req), destinatarioId: req.params.id, corpo: req.body }) });
}));
notificacoesRouter.post("/destinatarios/:id/vincular-unidade", gerir, asyncHandler(async (req, res) => {
  res.json({ data: await svc.vincularLegado({ req, escopo: exigirGerenciar(req), destinatarioId: req.params.id, corpo: req.body }) });
}));
notificacoesRouter.post("/destinatarios/:id/pedido-revogacao", gerir, asyncHandler(async (req, res) => {
  res.json({ data: await svc.registrarPedidoRevogacao({ req, escopo: exigirGerenciar(req), destinatarioId: req.params.id, corpo: req.body }) });
}));

// ---------------------------------------------------------------------------------------------------------------------------
// Público (titular)
// ---------------------------------------------------------------------------------------------------------------------------
export const titularRouter = Router();
titularRouter.use(limiteDeTaxa({ escopo: "notificacoes:titular", max: Number(process.env.RATE_LIMIT_NOTIFICACOES_TITULAR_MAX ?? 40), janelaMs: 10 * 60_000,
  chave: (req) => ipCliente(req) }));
titularRouter.use((req, res, next) => { semCache(res); res.set("Referrer-Policy", "no-referrer"); next(); });
const b = (req) => req.body ?? {};
titularRouter.post("/convite/abrir", asyncHandler(async (req, res) => res.json({ data: await titular.abrirConvite({ token: b(req).token }) })));
titularRouter.post("/convite/codigo", asyncHandler(async (req, res) => res.json({ data: await titular.pedirCodigoConvite({ token: b(req).token, ip: ipCliente(req) }) })));
titularRouter.post("/convite/verificar", asyncHandler(async (req, res) => res.json({ data: await titular.verificarCodigoConvite({
  token: b(req).token, desafio: b(req).desafio, provisorio: b(req).provisorio, codigo: b(req).codigo }) })));
titularRouter.post("/convite/consentir", asyncHandler(async (req, res) => res.json({ data: await titular.consentirConvite({
  token: b(req).token, desafio: b(req).desafio, categorias: b(req).categorias, termoVersao: b(req).termoVersao, ip: ipCliente(req), userAgent: req.get("user-agent") }) })));
titularRouter.post("/gestao/codigo", asyncHandler(async (req, res) => res.json({ data: await titular.pedirCodigoGestao({ telefone: b(req).telefone, ip: ipCliente(req) }) })));
titularRouter.post("/gestao/verificar", asyncHandler(async (req, res) => res.json({ data: await titular.verificarCodigoGestao({
  desafio: b(req).desafio, provisorio: b(req).provisorio, codigo: b(req).codigo }) })));
titularRouter.post("/gestao/inscricoes", asyncHandler(async (req, res) => res.json({ data: await titular.minhasInscricoes({ sessao: b(req).sessao, e164: b(req).telefone }) })));
titularRouter.post("/gestao/revogar", asyncHandler(async (req, res) => res.json({ data: await titular.revogarComoTitular({
  sessao: b(req).sessao, e164: b(req).telefone, organizacaoId: b(req).organizacaoId ?? null, categorias: b(req).categorias ?? null,
  sairDeTudo: b(req).sairDeTudo === true, ip: ipCliente(req) }) })));

// ---------------------------------------------------------------------------------------------------------------------------
// Painel Administrativo (M3) — montadas em administrativo.routes.js (requirePainelAdministrativo + MFA quando exigido)
// ---------------------------------------------------------------------------------------------------------------------------
// Mesma seam de teste dos controllers do Painel Administrativo: `app.locals.adminDeps` (banco/env falsos nos testes).
const adminDeps = (req) => req.app?.locals?.adminDeps;
const m3Args = (req) => { const d = adminDeps(req); return d ? { deps: d, env: d.env ?? {} } : {}; };
export const m3Controller = {
  estado: asyncHandler(async (req, res) => { semCache(res); res.json({ data: await m3.estado(m3Args(req)) }); }),
  ativar: asyncHandler(async (req, res) => res.json({ data: await m3.ativar({ req, corpo: req.body, ...m3Args(req) }) })),
  desativar: asyncHandler(async (req, res) => res.json({ data: await m3.desativar({ req, corpo: req.body, ...m3Args(req) }) })),
};
