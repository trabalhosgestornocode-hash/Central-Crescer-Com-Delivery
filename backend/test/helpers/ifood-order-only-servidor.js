// Servidor LOCAL para o teste de navegador do fluxo "pedidos sem Financial" (frontend/test/ifoodOrderOnly.browser.test.js).
//
// Serve o frontend e responde /api/v1/integracoes/ifood/* chamando os SERVIÇOS REAIS do backend (OAuth, status,
// vínculo manual, desconexão) sobre repositórios em memória. O iFood é simulado: o "portal" devolve um código
// de vínculo fixo e a consulta de eventos é uma fila controlada pelo teste. Nada sai para a rede: sem
// Supabase, sem iFood, sem OAuth real, sem polling real, sem ACK.
//
// Tenant: o cabeçalho `x-teste-unidade` faz o papel do Context Token (no produto o tenant vem SEMPRE do
// contexto validado no servidor — coberto por ifood-merchant-vinculo-manual.test.js e ifood-rotas-montagem.test.js).
// Corpo e query nunca escolhem a unidade aqui também.
//
// IMPORTANTE: quem importa este módulo define ANTES as variáveis de ambiente do piloto (o config é lido no import).

import express from "express";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import * as authSvc from "../../src/modules/ifood/ifoodAuth.service.js";
import * as conexaoSvc from "../../src/modules/ifood/ifoodConnection.service.js";
import * as vinculoSvc from "../../src/modules/ifood/ifoodMerchantVinculo.service.js";
import * as tokenReal from "../../src/modules/ifood/ifoodToken.service.js";
import { ifoodErro, IFOOD_ERROS } from "../../src/modules/ifood/ifood.errors.js";
import { resumoEventsParaStatus } from "../../src/modules/ifood/ifoodEventsEstado.js";
import { criarAmbiente, ORG, OUTRA_ORG, SACI, UN_OUTRA_ORG } from "./ifood-vinculo-fakes.js";

export const CODIGO_PORTAL = "CODIGO-DE-AUTORIZACAO-SIMULADO";
const ORG_DA_UNIDADE = { [UN_OUTRA_ORG]: OUTRA_ORG };

/**
 * @param {{ raizFrontend: string, pagina: string }} p
 * @returns {Promise<{ base: string, ambiente: object, controle: object, fechar: () => Promise<void> }>}
 */
export async function subirServidorOrderOnly({ raizFrontend, pagina }) {
  const ambiente = criarAmbiente({ piloto: [SACI, UN_OUTRA_ORG] });
  const controle = {
    chamadas: [],                 // { metodo, caminho, unidade, corpo }
    falharProxima: null,          // { caminho, status, corpo } — uma falha de API injetada (uma vez)
    iFood: { userCode: 0, troca: 0 },   // quantas vezes o "iFood" simulado foi chamado
    eventos: "disabled",          // estado do recebimento de eventos devolvido no status
  };
  let seq = 0;
  const sessoes = [];

  // ----- OAuth: repositório em memória + "iFood" simulado -----
  const repoOAuth = {
    async expirarSessoesVencidas() {},
    async criarSessaoOAuth(d) {
      const s = {
        id: `sess-${(seq += 1)}`, status: "pending", organizacao_id: d.organizacaoId, unidade_id: d.unidadeId, app_type: d.appType,
        authorization_code_verifier_cifrado: d.verifierCifrado, expira_em: d.expiraEm,
        verification_url: d.verificationUrl, verification_url_complete: d.verificationUrlComplete,
      };
      sessoes.push(s);
      return s;
    },
    async obterSessaoOAuth({ organizacaoId, unidadeId, sessaoId, appType }) {
      const s = sessoes.find((x) => x.id === sessaoId && x.organizacao_id === organizacaoId && x.unidade_id === unidadeId && x.app_type === appType);
      if (!s) throw ifoodErro(IFOOD_ERROS.IFOOD_OAUTH_SESSAO_NAO_ENCONTRADA);
      return s;
    },
    async reivindicarSessaoOAuth({ sessaoId }) { const s = sessoes.find((x) => x.id === sessaoId); if (s.reivindicada) return false; s.reivindicada = true; return true; },
    async fecharSessaoOAuth({ sessaoId, status }) { const s = sessoes.find((x) => x.id === sessaoId); if (s) s.status = status; },
    async obterOuCriarConexao({ organizacaoId, unidadeId }) {
      const viva = await ambiente.repo.obterConexaoViva({ organizacaoId, unidadeId });
      if (viva) return viva;
      return { ...ambiente.conectar({ organizacaoId, unidadeId, apps: [] }) };
    },
  };
  const httpIfood = {
    async postForm() {
      controle.iFood.userCode += 1;
      return { userCode: "SIMU-LADO", authorizationCodeVerifier: "verifier-simulado", verificationUrl: "about:blank", verificationUrlComplete: "about:blank#portal-simulado", expiresIn: 600 };
    },
  };
  const tokenOAuth = {
    ...tokenReal,
    async trocarAuthorizationCodePorToken({ authorizationCode }) {
      controle.iFood.troca += 1;
      if (authorizationCode !== CODIGO_PORTAL) throw ifoodErro(IFOOD_ERROS.IFOOD_OAUTH_CODIGO_INVALIDO);
      return { accessToken: "token-simulado", refreshToken: "refresh-simulado", expiresIn: 10_800 };
    },
    async salvarTokens({ conexaoId, appType }) {
      const agora = ambiente.relogio.ms;
      const cred = { conexao_id: conexaoId, app_type: appType, status: "ativa", expira_em: new Date(agora + 3 * 3_600_000).toISOString(), atualizado_em: new Date(agora).toISOString() };
      const i = ambiente.credenciais.findIndex((k) => k.conexao_id === conexaoId && k.app_type === appType);
      if (i >= 0) ambiente.credenciais[i] = cred; else ambiente.credenciais.push(cred);
    },
  };

  // ----- App -----
  const app = express();
  app.use(express.json());
  const tenantDe = (req) => {
    const unidadeId = req.headers["x-teste-unidade"] ? String(req.headers["x-teste-unidade"]) : null;
    if (!unidadeId) { const e = new Error("Selecione a loja antes de conectar a integração iFood."); e.statusCode = 400; throw e; }
    return { organizacaoId: ORG_DA_UNIDADE[unidadeId] ?? ORG, unidadeId, usuarioId: `gestor-${unidadeId.slice(-2)}` };
  };
  const depsStatus = { repo: ambiente.repo, vinculos: ambiente.vinculos, agora: ambiente.deps.agora };
  const status = async (t) => ({
    ...(await conexaoSvc.obterStatus({ organizacaoId: t.organizacaoId, unidadeId: t.unidadeId, deps: depsStatus })),
    eventosRecebimento: { ...resumoEventsParaStatus(), estado: controle.eventos },
  });
  const rota = (fn) => async (req, res, next) => {
    try {
      const caminho = req.path;
      controle.chamadas.push({ metodo: req.method, caminho, unidade: req.headers["x-teste-unidade"] ?? null, corpo: req.body ?? null });
      if (controle.falharProxima && controle.falharProxima.caminho === caminho) {
        const f = controle.falharProxima; controle.falharProxima = null;
        return res.status(f.status).json(f.corpo);
      }
      const t = tenantDe(req);
      await fn(req, res, t);
    } catch (e) { next(e); }
  };

  const r = express.Router();
  r.get("/status", rota(async (_req, res, t) => res.json({ data: await status(t) })));
  r.post("/oauth/start", rota(async (req, res, t) => res.status(201).json({
    data: await authSvc.iniciarConexao({ organizacaoId: t.organizacaoId, unidadeId: t.unidadeId, appType: req.body?.appType, usuarioId: t.usuarioId, deps: { repo: repoOAuth, http: httpIfood, token: tokenOAuth } }),
  })));
  r.post("/oauth/complete", rota(async (req, res, t) => res.json({
    data: await authSvc.concluirAutorizacao({
      organizacaoId: t.organizacaoId, unidadeId: t.unidadeId, appType: req.body?.appType, sessaoId: req.body?.sessionId,
      authorizationCode: req.body?.authorizationCode, usuarioId: t.usuarioId, deps: { repo: repoOAuth, http: httpIfood, token: tokenOAuth },
    }),
  })));
  const p = (t, extra = {}) => ({ organizacaoId: t.organizacaoId, unidadeId: t.unidadeId, usuarioId: t.usuarioId, deps: ambiente.deps, ...extra });
  r.post("/merchants/manual", rota(async (req, res, t) => { await vinculoSvc.informarMerchant(p(t, { merchantId: req.body?.merchantId })); res.status(201).json({ data: await status(t) }); }));
  r.post("/merchants/manual/conferir", rota(async (req, res, t) => { await vinculoSvc.confirmarMerchant(p(t, { merchantId: req.body?.merchantId })); res.json({ data: await status(t) }); }));
  r.delete("/merchants/manual", rota(async (_req, res, t) => { await vinculoSvc.cancelarMerchantInformado(p(t)); res.json({ data: await status(t) }); }));
  r.post("/merchants/manual/verificar-autorizacao", rota(async (_req, res, t) => { const x = await vinculoSvc.verificarAutorizacao(p(t)); res.json({ data: { ...(await status(t)), autorizacaoVerificada: x.autorizacaoVerificada } }); }));
  r.post("/merchants/manual/validar", rota(async (req, res, t) => {
    await vinculoSvc.concluirValidacao(p(t, { merchantId: req.body?.merchantId, evidenciaPortalParceiro: req.body?.evidenciaPortalParceiro, confirmacaoOperacional: req.body?.confirmacaoOperacional }));
    res.json({ data: await status(t) });
  }));
  r.delete("/", rota(async (_req, res, t) => res.json({ data: await conexaoSvc.desconectar({ organizacaoId: t.organizacaoId, unidadeId: t.unidadeId, usuarioId: t.usuarioId, deps: { repo: ambiente.repo, vinculos: ambiente.vinculos } }) })));
  // Qualquer outra rota do módulo (Merchant API, Financial, pedidos) NÃO existe neste servidor: se a tela
  // chamar, o teste enxerga em `controle.chamadas` e a resposta é 404.
  r.use(rota(async (_req, res) => res.status(404).json({ error: "rota não simulada" })));
  app.use("/api/v1/integracoes/ifood", r);

  app.get("/", (_req, res) => res.type("html").send(pagina));
  app.get("/favicon.ico", (_req, res) => res.status(204).end());
  app.get("/api/config", (_req, res) => res.json({ supabaseUrl: "http://127.0.0.1:9", supabaseAnonKey: "x" }));
  app.use((req, res) => {
    const arq = resolve(raizFrontend, "." + req.path);
    if (!arq.startsWith(raizFrontend + sep)) return res.status(403).end();
    try {
      res.setHeader("Content-Type", arq.endsWith(".css") ? "text/css" : arq.endsWith(".svg") ? "image/svg+xml" : arq.endsWith(".png") ? "image/png" : "text/javascript");
      res.end(readFileSync(arq));
    } catch { res.status(404).end(); }
  });
  // Mesma forma de resposta do errorHandler do backend (error/details/codigo), sem registrar evento de segurança.
  app.use((err, _req, res, _next) => {   // eslint-disable-line no-unused-vars
    res.status(err.statusCode || 500).json({ error: err.message || "Erro interno", details: err.details, ...(err.codigo ? { codigo: err.codigo } : {}) });
  });

  const servidor = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  return {
    base: `http://127.0.0.1:${servidor.address().port}`,
    ambiente, controle,
    fechar: () => new Promise((ok) => servidor.close(ok)),
  };
}
