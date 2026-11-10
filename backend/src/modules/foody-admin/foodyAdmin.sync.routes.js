// Rotas da SINCRONIZAÇÃO MANUAL Foody (piloto em sombra). Montadas em routes.js sob
//   tenant.use("/integracoes/foody/sincronizacoes", foodySyncRouter)   (ANTES do router de administração)
//
// SEPARADAS da administração de propósito: o router de administração continua sem nenhum caminho de coleta (teste de
// arquitetura). Este é o ÚNICO arquivo fora de modules/foody que alcança a coleta, e só via foody.sync.manual.js.
// QUEM: permissão `integracoes.gerenciar` + organization_admin da titular, sem impersonação (o serviço confere de novo).
// FLAGS: FOODY_CENTRAL_ADMIN_ENABLED + FOODY_CENTRAL_ENABLED + unidade na FOODY_CENTRAL_UNIDADES; senão 404.
// API Foody: só GET (foody.client.js). Nenhuma mensagem é enviada. Respostas sem cache, só códigos e contagens.
import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { ApiError } from "../../shared/ApiError.js";
import { requirePermissao } from "../../middlewares/auth.js";
import { PERMISSOES } from "../../shared/permissoes.js";
import { limiteDeTaxa } from "../../shared/rateLimit.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import { supabase } from "../../config/supabase.js";
import { criarRepositorioFoody } from "../foody/foody.repository.js";
import { criarSegurancaFoody } from "../foody/foody.seguranca.js";
import { ENV_SEGREDO } from "../foody/foody.constants.js";
import { atorDeAcesso } from "../foody/foody.compartilhamento.service.js";
import { solicitarSyncManual, listarSincronizacoes, criarEstadoSyncManual, previaRecuperacaoMes } from "../foody/foody.sync.manual.js";

const STATUS = {
  DESLIGADO: 404, SEM_CONEXAO: 404,
  SEM_PERMISSAO: 403,
  COMPETENCIA_INVALIDA: 400, COMPETENCIA_ABERTA: 400, LIMITE_DIAS: 400, MOTIVO_INVALIDO: 400, PARAMETRO_INVALIDO: 400, SEM_UNIDADE: 400,
  CONCORRENCIA: 409, CONEXAO_INATIVA: 409, TOKEN_INVALIDO: 409, TOKEN_DIVERGENTE: 409,
  SEGREDO_AUSENTE: 503,
};
const NAO_INSTALADA = new Set(["42P01", "42883", "PGRST202", "PGRST205"]);

export function erroHttpSync(e) {
  if (e instanceof ApiError) return e;
  if (NAO_INSTALADA.has(e?.pgCodigo)) return Object.assign(ApiError.notFound("integração Foody não instalada neste ambiente."), { codigo: "NAO_INSTALADA" });
  const status = STATUS[e?.codigo];
  if (status) return Object.assign(new ApiError(status, String(e.message || "Não foi possível concluir.")), { codigo: e.codigo });
  return Object.assign(ApiError.internal("Falha ao sincronizar a integração Foody. Tente de novo em instantes."), { codigo: "FOODY_INTERNO" });
}

const semCache = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };
const semImpersonacao = (req, _res, next) => (req.acesso?.impersonando
  ? next(Object.assign(ApiError.forbidden("Em impersonação a sincronização Foody não está disponível."), { codigo: "SEM_PERMISSAO" }))
  : next());

/**
 * @param {{db?:object, env?:object, agora?:()=>Date, seguranca?:()=>object, criarCliente?:Function, auditoria?:Function, estado?:object}} [o]
 */
export function criarFoodySyncRouter({ db = supabase, env = process.env, agora = () => new Date(), seguranca = null, criarCliente,
  auditoria = auditar, estado = criarEstadoSyncManual() } = {}) {
  const router = Router();
  const repo = criarRepositorioFoody(db);
  const seg = seguranca ?? (() => criarSegurancaFoody(env[ENV_SEGREDO]));
  const ctx = (req) => ({ ator: atorDeAcesso(req.acesso), tenant: { organizacaoId: req.tenant?.organizacaoId, unidadeId: req.tenant?.unidadeId ?? null } });
  // Por usuário: a API Foody tem limite de 100 req/min por conta; isto segura clique repetido.
  const limite = limiteDeTaxa({ escopo: "foody-sync-manual", max: 6, janelaMs: 10 * 60_000 });

  router.use(semCache, semImpersonacao, requirePermissao(PERMISSOES.INTEGRACOES_GERENCIAR));

  router.get("/", asyncHandler(async (req, res) => {
    try { res.json({ data: await listarSincronizacoes(ctx(req), { env, repo }) }); } catch (e) { throw erroHttpSync(e); }
  }));

  // Prévia do "Preencher mês" (Parser): SOMENTE LEITURA na API Foody (GET) e no banco; nada é gravado. Mesmo orçamento da coleta.
  router.get("/previa-mes", limite, asyncHandler(async (req, res) => {
    let s;
    try { s = seg(); } catch { throw erroHttpSync(Object.assign(new Error("segredo da integração Foody não configurado."), { codigo: "SEGREDO_AUSENTE" })); }
    try {
      res.json({ data: await previaRecuperacaoMes({ ...ctx(req), mes: String(req.query?.mes ?? "") },
        { env, repo, seguranca: s, agora, estado, ...(criarCliente ? { criarCliente } : {}) }) });
    } catch (e) { throw erroHttpSync(e); }
  }));

  router.post("/", limite, asyncHandler(async (req, res) => {
    const c = ctx(req);
    const corpo = req.body ?? {};
    const competencias = Array.isArray(corpo.competencias) ? corpo.competencias : (typeof corpo.competencia === "string" ? [corpo.competencia] : null);
    const base = { atorId: req.user?.id ?? null, perfilId: c.ator.perfilId, atorTipo: "usuario", entidade: "foody_sync_execucoes",
      organizacaoId: c.tenant.organizacaoId, ip: req.ip ?? null, userAgent: req.headers?.["user-agent"] ?? null };
    let resposta;
    try {
      let s;
      try { s = seg(); } catch { throw Object.assign(new Error("segredo da integração Foody não configurado."), { codigo: "SEGREDO_AUSENTE" }); }
      resposta = await solicitarSyncManual({ ...c, competencias, motivo: corpo.motivo ?? null, chaveIdempotencia: req.headers?.["idempotency-key"] ?? null },
        { env, repo, seguranca: s, agora, estado, ...(criarCliente ? { criarCliente } : {}) });
    } catch (e) {
      const http = erroHttpSync(e);
      if (http.statusCode !== 404) {
        await auditoria({ ...base, acao: ACOES.FOODY_SYNC_MANUAL_RECUSADA, entidadeId: null,
          detalhes: { unidade_id: c.tenant.unidadeId, codigo: http.codigo ?? "FOODY_INTERNO", dias: Array.isArray(competencias) ? competencias.slice(0, 7) : null } });
      }
      throw http;
    }
    if (!resposta.repetida) {
      await auditoria({ ...base, acao: ACOES.FOODY_SYNC_MANUAL_EXECUTADA, entidadeId: null, detalhes: {
        unidade_id: c.tenant.unidadeId, totais: resposta.totais, interrompido_por: resposta.interrompidoPor,
        dias: resposta.dias.map((d) => ({ competencia: d.competencia, origem: d.origem, execucao_id: d.execucaoId ?? null, erro: d.erro ?? null,
          concluido: d.concluido ?? null, completa: d.cobertura?.completa ?? null })) } });
    }
    res.status(200).json({ data: resposta });
  }));

  return router;
}

export const foodySyncRouter = criarFoodySyncRouter();
