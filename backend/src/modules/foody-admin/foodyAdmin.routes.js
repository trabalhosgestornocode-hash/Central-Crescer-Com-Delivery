// Rotas da ADMINISTRAÇÃO da integração Foody (Configurações → Integrações → Foody Delivery). Montadas em routes.js sob
//   tenant.use("/integracoes/foody", foodyAdminRouter)    (depois de requireContexto + restringirPerfilExibicao)
//
// QUEM: permissão `integracoes.gerenciar` para entrar; toda AÇÃO exige organization_admin da organização do contexto, sem
// impersonação (serviço) — e o banco confere de novo o papel em usuarios_organizacoes no momento de cada escrita (145/146).
// O superadmin em impersonação só CONSULTA o estado (suporte); qualquer escrita dele é recusada aqui e no serviço.
// FLAG: FOODY_CENTRAL_ADMIN_ENABLED (só a administração). Desligada, tudo responde 404 — menos as REVOGAÇÕES (da conexão e do
// compartilhamento), que funcionam sempre: desligar nunca depende de ligar algo.
// NADA aqui coleta pedidos: este router não importa cliente HTTP, sync nem agendador (teste de arquitetura).
// TOKEN: só no corpo do POST (nunca na URL), cifrado no serviço; nenhuma resposta o devolve. Respostas sem cache.
import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { ApiError } from "../../shared/ApiError.js";
import { requirePermissao } from "../../middlewares/auth.js";
import { PERMISSOES } from "../../shared/permissoes.js";
import { limiteDeTaxa } from "../../shared/rateLimit.js";
import { supabase } from "../../config/supabase.js";
import { criarRepositorioFoody, FoodyRepoErro } from "../foody/foody.repository.js";
import { criarSegurancaFoody } from "../foody/foody.seguranca.js";
import { ENV_SEGREDO } from "../foody/foody.constants.js";
import * as adm from "../foody/foody.administracao.service.js";
import * as comp from "../foody/foody.compartilhamento.service.js";
import { criarPlataformaFoody } from "./foodyAdmin.plataforma.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Código do serviço/banco → status HTTP. Mensagens 4xx são as do próprio serviço (sem SQL); 5xx sai genérica.
const STATUS_POR_CODIGO = {
  DESLIGADO: 404, SEM_CONEXAO: 404, SEM_DESTINO: 404, SEM_PEDIDO: 404,
  SEM_PERMISSAO: 403, DESTINO_NAO_PERMITIDO: 403, UNIDADE_FORA_DA_ORGANIZACAO: 403,
  TOKEN_INVALIDO: 400, MOTIVO_INVALIDO: 400, PONTO_COLETA_INVALIDO: 400, OPERACAO_INVALIDA: 400, DESTINO_INVALIDO: 400,
  PEDIDO_INVALIDO: 400, COMPETENCIA_INVALIDA: 400, SEM_UNIDADE: 400, ACAO_INVALIDA: 400, PARAMETRO_INVALIDO: 400,
  CONEXAO_EXISTENTE: 409, CONEXAO_REVOGADA: 409, CONTA_JA_CONECTADA: 409, DESTINO_VIVO: 409, COMPARTILHAMENTO_VIVO: 409,
  TRANSICAO_INVALIDA: 409, ESTADO_INVALIDO: 409, CONCORRENCIA: 409, CONEXAO_INATIVA: 409, SEM_DESTINO_ATIVO: 409,
  DESTINO_COM_CONEXAO_PROPRIA: 409, VINCULO_EXISTENTE: 409, DESTINO_JA_VINCULADO: 409, ATO_SEPARADO: 409,
  SEGREDO_AUSENTE: 503,
};

export function erroHttp(e) {
  if (e instanceof ApiError) return e;
  const codigo = e?.codigo;
  const status = STATUS_POR_CODIGO[codigo];
  if (status && status < 500) return Object.assign(new ApiError(status, String(e.message || "Não foi possível concluir.")), { codigo });
  if (status === 503) return new ApiError(503, String(e.message), { codigo });
  // BANCO, TENANT_DIVERGENTE, INTEGRIDADE ou erro inesperado: nada de detalhe interno para o cliente.
  return Object.assign(ApiError.internal("Falha ao acessar a integração Foody. Tente de novo em instantes."),
    { codigo: e instanceof FoodyRepoErro ? `FOODY_${e.codigo}` : "FOODY_INTERNO" });
}

// Respostas de escrita: SÓ o que a tela usa. Nunca a linha crua do banco (ela traz ids de perfil de quem propôs/aprovou/decidiu,
// e a tela mostra autoria só como "você" / "outro administrador").
export const vinculoParaResposta = (d) => (d ? {
  id: d.id, conexaoId: d.conexao_id, estado: d.estado, operacao: d.operacao,
  aprovadoTitularEm: d.aprovado_titular_em ?? null, aprovadoDestinoEm: d.aprovado_destino_em ?? null,
  revogadoEm: d.revogado_em ?? null, revogadoMotivo: d.revogado_motivo ?? null,
} : null);
export const decisaoParaResposta = (d) => (d ? {
  id: d.id, foodyUid: d.foody_uid, operacao: d.operacao_decidida, motivo: d.motivo, competencia: d.competencia ?? null,
  decididoEm: d.decidido_em ?? null, aplicacao: d.aplicacao ?? null,
} : null);

const semCache = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };
/** Defesa em profundidade: escrita em impersonação nunca chega ao serviço. */
const semImpersonacaoEmEscrita = (req, _res, next) =>
  (req.method !== "GET" && req.acesso?.impersonando
    ? next(Object.assign(ApiError.forbidden("Em impersonação a integração Foody é só consulta."), { codigo: "SEM_PERMISSAO" }))
    : next());
const uuidParam = (nome) => (req, _res, next) =>
  (UUID.test(String(req.params[nome] ?? "")) ? next() : next(Object.assign(ApiError.badRequest("identificador inválido."), { codigo: "PARAMETRO_INVALIDO" })));

/**
 * @param {{db?: object, env?: object, agora?: () => Date, plataforma?: object, seguranca?: () => object}} [opcoes]
 *   injeção para testes; em produção: supabase (service_role), process.env, relógio real.
 */
export function criarFoodyAdminRouter({ db = supabase, env = process.env, agora = () => new Date(), plataforma = null, seguranca = null } = {}) {
  const router = Router();
  const repo = criarRepositorioFoody(db);
  const plat = plataforma ?? criarPlataformaFoody(db);
  const seg = seguranca ?? (() => criarSegurancaFoody(env[ENV_SEGREDO]));
  const deps = { env, repo, plataforma: plat, seguranca: seg, agora };
  const ctx = (req) => ({ ator: comp.atorDeAcesso(req.acesso), tenant: { organizacaoId: req.tenant?.organizacaoId, unidadeId: req.tenant?.unidadeId ?? null } });
  const h = (fn, status = 200) => asyncHandler(async (req, res) => {
    try {
      const data = await fn(req, ctx(req));
      res.status(status).json({ data });
    } catch (e) {
      throw erroHttp(e);
    }
  });
  // Tentativas de token: por usuário, janela curta (o token não aparece em log; isso só segura força bruta/erro de digitação em loop).
  const limiteToken = limiteDeTaxa({ escopo: "foody-admin-token", max: 10, janelaMs: 15 * 60_000 });

  router.use(semCache, requirePermissao(PERMISSOES.INTEGRACOES_GERENCIAR), semImpersonacaoEmEscrita);

  router.get("/estado", h((req, c) => adm.estadoDaIntegracao(c, {
    ...deps, segredoConfigurado: String(env[ENV_SEGREDO] ?? "").trim().length >= 32,
  })));

  // Conexão da unidade do contexto.
  router.post("/conexao", limiteToken, h((req, c) => adm.cadastrarConexao({ ...c, token: req.body?.token, pontoColetaEsperado: req.body?.pontoColetaEsperado }, deps), 201));
  router.post("/conexao/token", limiteToken, h((req, c) => adm.substituirToken({ ...c, token: req.body?.token, motivo: req.body?.motivo }, deps)));
  router.post("/conexao/ativar", h((req, c) => adm.ativarConexao(c, deps)));
  router.post("/conexao/pausar", h((req, c) => adm.pausarConexao({ ...c, motivo: req.body?.motivo }, deps)));
  router.post("/conexao/revogar", h((req, c) => adm.revogarConexao({ ...c, motivo: req.body?.motivo }, deps)));
  router.put("/conexao/ponto-coleta", h((req, c) => adm.alterarPontoColeta({ ...c, pontoColetaEsperado: req.body?.pontoColetaEsperado }, deps)));

  // Compartilhamento entre organizações.
  router.get("/destinos-possiveis", h((req, c) => adm.destinosPossiveis(c, deps)));
  router.post("/compartilhamentos", h(async (req, c) => vinculoParaResposta(await adm.proporCompartilhamento({ ...c, destino: {
    organizacaoId: req.body?.organizacaoId, unidadeId: req.body?.unidadeId, operacao: req.body?.operacao } }, deps)), 201));
  router.post("/compartilhamentos/:id/aprovar", uuidParam("id"), h(async (req, c) =>
    vinculoParaResposta(await comp.aprovarDestino({ ator: c.ator, destinoId: req.params.id }, deps))));
  router.post("/compartilhamentos/:id/revogar", uuidParam("id"), h(async (req, c) =>
    vinculoParaResposta(await comp.revogarDestino({ ator: c.ator, destinoId: req.params.id, motivo: req.body?.motivo }, deps))));

  // Triagem (admin de uma organização do vínculo: a titular ou o destino ATIVO).
  router.get("/conexoes/:conexaoId/triagem/dias", uuidParam("conexaoId"), h((req, c) => comp.listarDiasDeTriagem({ ator: c.ator, conexaoId: req.params.conexaoId }, deps)));
  router.get("/conexoes/:conexaoId/triagem/decisoes", uuidParam("conexaoId"), h((req, c) => comp.historicoDeDecisoes({ ator: c.ator, conexaoId: req.params.conexaoId }, deps)));
  router.get("/conexoes/:conexaoId/triagem", uuidParam("conexaoId"), h((req, c) => comp.listarTriagem({
    ator: c.ator, conexaoId: req.params.conexaoId, competencia: typeof req.query.competencia === "string" ? req.query.competencia : "" }, deps)));
  router.post("/conexoes/:conexaoId/triagem/:foodyUid/decisao", uuidParam("conexaoId"), h(async (req, c) => decisaoParaResposta(await comp.decidirTriagem({
    ator: c.ator, conexaoId: req.params.conexaoId, foodyUid: req.params.foodyUid, operacao: req.body?.operacao, motivo: req.body?.motivo }, deps)), 201));

  return router;
}

export const foodyAdminRouter = criarFoodyAdminRouter();
