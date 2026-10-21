// Ciclo de vida do token OAuth do iFood.
//
// MODELO OFICIAL DO PRODUTO: aplicativo DISTRIBUÍDO (tudo abaixo, exceto o que
// diz "CENTRALIZED_TEST"). Existe um segundo modo, TEMPORÁRIO e só para
// desenvolvimento (app centralizado "Teste (C)", client_credentials) — vive em
// ifoodAuthProvider.js e é escolhido por `provedorDeAutenticacao()`. As APIs de
// negócio só chamam `comAccessTokenValido()` e não sabem qual dos dois é.
//
// Responsabilidades:
//   * ler clientId/clientSecret do app a partir de ENV (nunca de banco/log);
//   * trocar authorizationCode por token (fim do fluxo distribuído);
//   * renovar via refresh_token;
//   * getValidAccessToken(): devolve um accessToken válido, renovando ANTES
//     de expirar (margem de 10 min);
//   * comAccessTokenValido(): executa uma chamada e, em 401, tenta refresh
//     UMA vez e repete a chamada UMA vez (sem loop infinito).
//
// SEGREDOS: clientSecret vem só de config.ifood.<app>.clientSecret (ENV).
// accessToken/refreshToken são gravados CIFRADOS (shared/cripto.js). Nada
// disso aparece em log ou em resposta de API.

import { config } from "../../config/env.js";
import { cifrar, decifrar } from "../../shared/cripto.js";
import { ifoodErro, IFOOD_ERROS, IfoodError } from "./ifood.errors.js";
import { ifoodLog } from "./ifood.logsafe.js";
import { IFOOD_APPS, IFOOD_APP_TYPES, IFOOD_APP_ORDER, IFOOD_GRANT, IFOOD_ROTAS, IFOOD_TOKEN } from "./ifood.constants.js";
import * as httpClient from "./ifoodHttp.client.js";
import * as repositorio from "./ifood.repository.js";
import { unidadeNoPilotoOrder } from "./ifoodOrderPiloto.js";
import { unidadeEmHomologacaoFinancial, totalUnidadesHomologacaoFinancial } from "./ifoodFinancialHomologacao.js";
import {
  MODOS_AUTH, modoDeAutenticacao as modoDaConfig, criarProviderCentralizadoTeste,
} from "./ifoodAuthProvider.js";

/**
 * Modo de homologação iFood (IFOOD_HOMOLOGATION_MODE=true): usa o aplicativo
 * distribuído de teste do iFood no lugar dos apps reais (analytics/financial),
 * sem alterar o `app_type` gravado no banco nem o fluxo OAuth. Único ponto de
 * leitura dessa flag — nada além disto lê `config.ifood.homologacao` direto.
 */
export function estaEmHomologacaoIfood() {
  return config.ifood?.homologacao === true;
}

/**
 * appTypes que o fluxo OAuth distribuído aceita. `order` (Events/Order):
 *   * em homologação: resolve para o mesmo app de teste (Teste D);
 *   * fora de homologação: SÓ quando o app homologado de Order/Events está configurado
 *     (IFOOD_ORDER_CLIENT_ID + IFOOD_ORDER_CLIENT_SECRET, app central-ccd). Sem ele, recusado como antes.
 * Em ambos o poller distribuído usa a SUA credencial `order`, nunca a do financial.
 */
export function appTypesDoOAuth() {
  if (estaEmHomologacaoIfood()) return [...IFOOD_APP_TYPES, IFOOD_APP_ORDER];
  const o = config.ifood?.order ?? {};
  return o.clientId && o.clientSecret ? [...IFOOD_APP_TYPES, IFOOD_APP_ORDER] : [...IFOOD_APP_TYPES];
}

/**
 * Unidades do piloto Order (IFOOD_ORDER_PILOT_UNITS), já normalizadas. É a ÚNICA fonte do poller de Events
 * para decidir quais lojas consultar. Cópia: quem recebe não altera a config. Vazia = nenhuma unidade.
 * @returns {string[]}
 */
export function unidadesPilotoOrder() {
  return [...(config.ifood?.orderPilotoUnidades ?? [])];
}

/**
 * A validação FINAL do vínculo manual de merchant está liberada neste ambiente?
 * (IFOOD_ORDER_MERCHANT_VALIDACAO_ENABLED=true). Fail-closed: qualquer outro valor = não.
 */
export function validacaoMerchantManualHabilitada() {
  return config.ifood?.orderMerchantValidacao === true;
}

/**
 * O autoatendimento do app Order está ligado neste ambiente? (IFOOD_ORDER_SELF_SERVICE_ENABLED=true). Fail-closed.
 * Ligado, a liberação deixa de ser a lista do piloto: vale o módulo `ifood` da unidade (gate da rota) + a permissão
 * `integracoes.gerenciar` + a loja PROVADA pelo token e verificada no iFood (ifoodOrderAutoatendimento.service.js).
 */
export function autoatendimentoOrderHabilitado() {
  return config.ifood?.orderAutoatendimento === true;
}

/**
 * O autoatendimento vale PARA ESTA UNIDADE? Flag ligada e, durante a liberação gradual, a unidade em IFOOD_ORDER_SELF_SERVICE_UNITS
 * (lista vazia = todas). É a única decisão usada pela ativação, pelo status e pelo escopo do poller. Fail-closed.
 * A lista é TEMPORÁRIA (homologação): não é uma etapa por conexão — esvaziada, qualquer unidade com o módulo `ifood` conecta sozinha.
 * @param {string|null|undefined} unidadeId SEMPRE de req.tenant (ou da conexão persistida)
 */
export function autoatendimentoLiberadoParaUnidade(unidadeId) {
  if (!autoatendimentoOrderHabilitado() || typeof unidadeId !== "string" || !unidadeId) return false;
  const restritas = config.ifood?.orderAutoatendimentoUnidades ?? [];
  return restritas.length === 0 || unidadeNoPilotoOrder(restritas, unidadeId);
}

/**
 * O app Order está liberado PARA ESTA UNIDADE? Exige as duas coisas:
 *   1. o app existe neste ambiente (appTypesDoOAuth inclui `order` — credenciais ou homologação);
 *   2. a unidade está no piloto (IFOOD_ORDER_PILOT_UNITS) OU o autoatendimento está ligado. Fail-closed.
 * As credenciais sozinhas NUNCA liberam o Order. Não tem relação com o Events (outra flag).
 * @param {string|null|undefined} unidadeId SEMPRE de req.tenant (contexto validado no servidor)
 */
export function orderLiberadoParaUnidade(unidadeId) {
  if (!appTypesDoOAuth().includes(IFOOD_APP_ORDER)) return false;
  if (autoatendimentoLiberadoParaUnidade(unidadeId)) return true;
  return unidadeNoPilotoOrder(config.ifood?.orderPilotoUnidades, unidadeId);
}

/**
 * ESCOPO do poller de Events: as unidades do piloto + (com o autoatendimento ligado e credencial por conexão) as unidades
 * cuja loja passou pela ativação — vínculo `validado` cuja conexão está `ativa` com o MESMO merchant.
 * Nunca "todas as conexões": uma conexão com credencial `order` mas sem ativação concluída continua fora.
 * Falha ao ler o banco = só o piloto (o recebimento das lojas do piloto nunca depende desta consulta).
 * @param {{listarAtivadas?: () => Promise<string[]>, log?: Function}} [opc]
 * @returns {Promise<string[]>}
 */
export async function unidadesOrderNoEscopo({ listarAtivadas, log } = {}) {
  const piloto = unidadesPilotoOrder();
  if (!autoatendimentoOrderHabilitado() || escopoDoToken() !== "conexao" || typeof listarAtivadas !== "function") return piloto;
  try {
    // Ativadas que continuam liberadas (restringir a liberação gradual tira a unidade do escopo no ciclo seguinte; nada é apagado).
    const ativadas = ((await listarAtivadas()) ?? []).map((u) => String(u).toLowerCase()).filter((u) => autoatendimentoLiberadoParaUnidade(u));
    return [...new Set([...piloto, ...ativadas])];
  } catch (e) {
    log?.("warn", "events.escopo_autoatendimento_indisponivel", { erro: String(e?.message ?? e).slice(0, 200) });
    return piloto;
  }
}

/**
 * De onde vem a credencial do app para esta chamada:
 *   * 'test' — app distribuído de TESTE (IFOOD_TEST_CLIENT_ID/SECRET):
 *       - modo global IFOOD_HOMOLOGATION_MODE=true (legado: TODOS os appTypes, todas as unidades); ou
 *       - appType 'financial' + unidade na allowlist IFOOD_FINANCIAL_HOMOLOGATION_UNITS
 *         (homologação Financial POR UNIDADE — Order/Analytics/Events nunca entram aqui);
 *   * 'app'  — a credencial real do próprio appType (config.ifood[appType]).
 * `unidadeId` vem sempre do backend (tenant, sessão OAuth ou conexão persistida).
 */
export function fonteDaCredencial(appType, { unidadeId } = {}) {
  if (estaEmHomologacaoIfood()) return "test";
  if (appType === IFOOD_APPS.FINANCIAL && unidadeEmHomologacaoFinancial(unidadeId)) return "test";
  return "app";
}

/**
 * clientId/clientSecret do app, de ENV (via config/env.js — nunca process.env
 * direto). Lança se não configurado.
 *
 * Em homologação global, `analytics`, `financial` e `order` resolvem TODOS para o
 * mesmo app de teste (IFOOD_TEST_CLIENT_ID/SECRET). Fora dela, só o `financial`
 * de uma unidade na allowlist de homologação usa o app de teste; todo o resto usa
 * SÓ a sua credencial real (config.ifood[appType]) — nunca a de outro app.
 *
 * FAIL-CLOSED: se a fonte é 'test' e IFOOD_TEST_CLIENT_* faltar, lança
 * IFOOD_APP_SEM_CREDENCIAL — NUNCA cai para a credencial de produção (um userCode
 * do app de teste trocado/renovado com o app de produção falharia de qualquer jeito,
 * e a unidade de homologação jamais deve autorizar o app real por engano).
 */
export function credenciaisDoApp(appType, { unidadeId } = {}) {
  if (!appTypesDoOAuth().includes(appType)) throw ifoodErro(IFOOD_ERROS.IFOOD_APP_TYPE_INVALIDO);

  if (fonteDaCredencial(appType, { unidadeId }) === "test") {
    const t = config.ifood?.test ?? {};
    if (!t.clientId || !t.clientSecret) {
      throw ifoodErro(IFOOD_ERROS.IFOOD_APP_SEM_CREDENCIAL, { detalhes: { appType, origem: "test" } });
    }
    return { clientId: t.clientId, clientSecret: t.clientSecret, origem: "test" };
  }

  const c = config.ifood?.[appType] ?? {};
  if (!c.clientId || !c.clientSecret) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_APP_SEM_CREDENCIAL, { detalhes: { appType } });
  }
  // Forma exata de antes da homologação (sem `origem`) — não quebra o
  // contrato já testado em config-ifood.test.js (Fase 1).
  return { clientId: c.clientId, clientSecret: c.clientSecret };
}

/** Resposta de token do iFood -> forma interna normalizada. */
function normalizarToken(resp) {
  const accessToken = resp?.accessToken ?? resp?.access_token;
  if (!accessToken || typeof accessToken !== "string") {
    throw ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA, { detalhes: { motivo: "sem accessToken" } });
  }
  const expiresIn = Number(resp?.expiresIn ?? resp?.expires_in ?? IFOOD_TOKEN.expiresInPadraoS);
  return {
    accessToken,
    refreshToken: resp?.refreshToken ?? resp?.refresh_token ?? null,
    tokenType: resp?.type ?? resp?.tokenType ?? resp?.token_type ?? "bearer",
    expiraEm: new Date(Date.now() + (Number.isFinite(expiresIn) ? expiresIn : IFOOD_TOKEN.expiresInPadraoS) * 1000).toISOString(),
  };
}

/**
 * ETAPA FINAL DO FLUXO: troca authorizationCode + verifier por token.
 * `unidadeId`: a da SESSÃO OAuth persistida — a mesma regra do userCode escolhe o app.
 * @param {{appType: string, authorizationCode: string, verifier: string, unidadeId?: string, http?: typeof httpClient}} p
 * @returns {Promise<{accessToken, refreshToken, tokenType, expiraEm}>}
 */
export async function trocarAuthorizationCodePorToken({ appType, authorizationCode, verifier, unidadeId, http = httpClient }) {
  const { clientId, clientSecret } = credenciaisDoApp(appType, { unidadeId });
  let resp;
  try {
    resp = await http.postForm(IFOOD_ROTAS.token, {
      grantType: IFOOD_GRANT.AUTHORIZATION_CODE,
      clientId, clientSecret,
      authorizationCode,
      authorizationCodeVerifier: verifier,
    }, { rotulo: "oauth.token.authorization_code" });
  } catch (e) {
    if (e instanceof IfoodError && (e.codigo === IFOOD_ERROS.IFOOD_OAUTH_CODIGO_INVALIDO || e.codigo === IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA)) {
      throw ifoodErro(IFOOD_ERROS.IFOOD_OAUTH_CODIGO_INVALIDO);
    }
    if (e instanceof IfoodError) throw ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_TROCA_FALHOU, { detalhes: { causa: e.codigo } });
    throw e;
  }
  return normalizarToken(resp);
}

/**
 * Renova o accessToken usando o refreshToken.
 * `unidadeId`: a da CONEXÃO persistida (ver unidadeParaCredencial) — mesma regra do userCode.
 * @param {{appType: string, refreshToken: string, unidadeId?: string, http?: typeof httpClient}} p
 */
export async function renovarToken({ appType, refreshToken, unidadeId, http = httpClient }) {
  if (!refreshToken) throw ifoodErro(IFOOD_ERROS.IFOOD_REFRESH_FALHOU, { detalhes: { motivo: "sem refreshToken" } });
  const { clientId, clientSecret } = credenciaisDoApp(appType, { unidadeId });
  let resp;
  try {
    resp = await http.postForm(IFOOD_ROTAS.token, {
      grantType: IFOOD_GRANT.REFRESH_TOKEN,
      clientId, clientSecret, refreshToken,
    // semRetry: um 5xx/timeout não prova que o iFood não rotacionou o refresh — nunca repetir às cegas.
    }, { rotulo: "oauth.token.refresh", semRetry: true });
  } catch (e) {
    if (e instanceof IfoodError) throw ifoodErro(IFOOD_ERROS.IFOOD_REFRESH_FALHOU, { detalhes: { causa: e.codigo } });
    throw e;
  }
  return normalizarToken(resp);
}

function precisaRenovar(expiraEmIso) {
  return new Date(expiraEmIso).getTime() - Date.now() <= IFOOD_TOKEN.margemRenovacaoMs;
}

/**
 * Persiste um conjunto de tokens (cifrados) para um app da conexão.
 * @param {{conexaoId: string, appType: string, tokens: {accessToken, refreshToken, tokenType, expiraEm}, repo?: typeof repositorio}} p
 */
export async function salvarTokens({ conexaoId, appType, tokens, repo = repositorio, lojaId = null }) {
  return repo.salvarCredencial({
    conexaoId, appType, ...(lojaId ? { lojaId } : {}),
    accessTokenCifrado: cifrar(tokens.accessToken),
    // Se o iFood não devolver refreshToken novo, mantém o anterior (não apaga).
    refreshTokenCifrado: tokens.refreshToken ? cifrar(tokens.refreshToken) : undefined,
    expiraEm: tokens.expiraEm,
    tokenType: tokens.tokenType,
  });
}

/**
 * Devolve um accessToken VÁLIDO para (conexao, app), renovando antes de
 * expirar se necessário. Marca a credencial como `reauth_required` se o
 * refresh falhar — e nesse caso lança IFOOD_REFRESH_FALHOU.
 *
 * @param {{conexaoId: string, appType: string, deps?: {repo, http}}} p
 * @returns {Promise<string>} accessToken em claro (só em memória)
 */
export async function getValidAccessToken({ conexaoId, appType, lojaId = null, deps = {} }) {
  const repo = deps.repo ?? repositorio;
  const http = deps.http ?? httpClient;

  const cred = await repo.obterCredencial({ conexaoId, appType, ...(lojaId ? { lojaId } : {}) });
  if (!cred) throw ifoodErro(IFOOD_ERROS.IFOOD_CREDENCIAL_NAO_ENCONTRADA);
  if (cred.status === "reauth_required") throw ifoodErro(IFOOD_ERROS.IFOOD_REFRESH_FALHOU);

  if (!precisaRenovar(cred.expira_em)) {
    return decifrar(cred.access_token_cifrado);
  }

  // Renovação proativa.
  return renovarEArmazenar({ conexaoId, appType, cred, repo, http, lojaId });
}

// Falha passageira do iFood (rede, timeout, 429, 5xx): o refresh token pode estar
// ótimo — NÃO marca reauth_required (isso exigiria nova autorização manual).
const CAUSAS_TRANSITORIAS = new Set([IFOOD_ERROS.IFOOD_INDISPONIVEL, IFOOD_ERROS.IFOOD_RATE_LIMITED, IFOOD_ERROS.IFOOD_CANCELADO]);

// Single-flight por credencial NESTE processo: renovações simultâneas da mesma
// (conexão, app) compartilham UMA chamada ao iFood — sem isso, se o iFood
// rotacionar o refresh token, a segunda chamada falharia e derrubaria a credencial.
const renovacoesEmVoo = new Map();

/** Renova, persiste e devolve o accessToken novo (uma renovação por credencial por vez). */
function renovarEArmazenar({ conexaoId, appType, cred, repo, http, lojaId = null }) {
  const chave = lojaId ? `loja:${lojaId}:${appType}` : `${conexaoId}:${appType}`;   // a credencial própria de uma loja é OUTRA credencial
  const emVoo = renovacoesEmVoo.get(chave);
  if (emVoo) return emVoo;
  const p = executarRenovacao({ conexaoId, appType, cred, repo, http, lojaId })
    .finally(() => renovacoesEmVoo.delete(chave));
  renovacoesEmVoo.set(chave, p);
  return p;
}

/**
 * Unidade da CONEXÃO persistida, para escolher a credencial do refresh — só quando
 * pode fazer diferença: appType 'financial' com allowlist de homologação não vazia.
 * Fora disso devolve null sem consultar nada (Order/Analytics e produção sem
 * homologação: comportamento idêntico ao anterior). Fail-closed: sem conseguir
 * descobrir a unidade, NÃO renova (nunca adivinha a credencial).
 */
async function unidadeParaCredencial({ conexaoId, appType, repo }) {
  if (appType !== IFOOD_APPS.FINANCIAL || totalUnidadesHomologacaoFinancial() === 0) return null;
  const unidadeId = typeof repo.obterUnidadeDaConexao === "function" ? await repo.obterUnidadeDaConexao({ conexaoId }) : null;
  if (!unidadeId) throw ifoodErro(IFOOD_ERROS.IFOOD_REFRESH_FALHOU, { detalhes: { motivo: "unidade da conexão não encontrada" } });
  return unidadeId;
}

async function executarRenovacao({ conexaoId, appType, cred, repo, http, lojaId = null }) {
  const alvo = lojaId ? { lojaId } : {};   // acrescentado só quando há loja: chamadas da conexão ficam idênticas às de antes
  const refreshToken = cred.refresh_token_cifrado ? decifrar(cred.refresh_token_cifrado) : null;
  // Antes do try: falha ao descobrir a unidade não é "refresh recusado" — não marca reauth.
  const unidadeId = await unidadeParaCredencial({ conexaoId, appType, repo });
  try {
    const tokens = await renovarToken({ appType, refreshToken, unidadeId, http });
    // GRAVAÇÃO CONDICIONAL: só substitui a credencial que ESTA renovação leu. Se uma credencial mais nova entrou nesse meio tempo (outra
    // instância renovou, ou uma nova autorização OAuth foi concluída), ela é preservada e o resultado desta renovação é descartado.
    if (typeof repo.atualizarCredencial === "function") {
      const gravou = await repo.atualizarCredencial({
        conexaoId, appType, ...alvo,
        campos: {
          access_token_cifrado: cifrar(tokens.accessToken), expira_em: tokens.expiraEm, token_type: tokens.tokenType ?? null, status: "ativa",
          ...(tokens.refreshToken ? { refresh_token_cifrado: cifrar(tokens.refreshToken) } : {}),
        },
        seAccessCifradoIgual: cred.access_token_cifrado,
      });
      if (!gravou) {
        const maisNova = await repo.obterCredencial({ conexaoId, appType, ...alvo }).catch(() => null);
        if (maisNova && maisNova.status === "ativa" && maisNova.access_token_cifrado !== cred.access_token_cifrado && !precisaRenovar(maisNova.expira_em)) {
          ifoodLog("info", "token.renovacao_descartada_credencial_mais_nova", { conexaoId, appType, ...(lojaId ? { lojaId } : {}) });
          return decifrar(maisNova.access_token_cifrado);
        }
        await salvarTokens({ conexaoId, appType, tokens, repo, ...alvo });   // nada mais novo e utilizável: não perde o refresh rotacionado
      }
    } else {
      await salvarTokens({ conexaoId, appType, tokens, repo, ...alvo });
    }
    ifoodLog("info", "token.renovado", { conexaoId, appType, rotacionado: !!tokens.refreshToken, origemCredencial: fonteDaCredencial(appType, { unidadeId }), ...(lojaId ? { lojaId } : {}) });
    return tokens.accessToken;
  } catch (e) {
    const causa = e?.details?.causa ?? e?.codigo ?? null;
    if (CAUSAS_TRANSITORIAS.has(causa)) {
      ifoodLog("warn", "token.renovacao_transitoria", { conexaoId, appType, causa });
      throw e instanceof IfoodError ? e : ifoodErro(IFOOD_ERROS.IFOOD_REFRESH_FALHOU);
    }

    // Outro processo pode ter renovado primeiro (e o iFood invalidado o refresh que
    // usamos): se a credencial gravada mudou e está ativa, usa a dela.
    const atual = await repo.obterCredencial({ conexaoId, appType, ...alvo }).catch(() => null);
    if (atual && atual.status === "ativa" && atual.access_token_cifrado !== cred.access_token_cifrado && !precisaRenovar(atual.expira_em)) {
      ifoodLog("info", "token.renovado_por_concorrente", { conexaoId, appType });
      return decifrar(atual.access_token_cifrado);
    }

    // Só marca reauth se ninguém gravou credencial nova desde a nossa leitura (compare-and-set).
    await repo.atualizarCredencial({
      conexaoId, appType, ...alvo, campos: { status: "reauth_required" }, seAccessCifradoIgual: cred.access_token_cifrado,
    }).catch(() => {});
    ifoodLog("warn", "token.reauth_required", { conexaoId, appType, causa: causa ?? e?.message, ...(lojaId ? { lojaId } : {}) });
    throw e instanceof IfoodError ? e : ifoodErro(IFOOD_ERROS.IFOOD_REFRESH_FALHOU);
  }
}

// ---------------------------------------------------------------------------
// AUTH PROVIDERS (ver ifoodAuthProvider.js para o contrato)
// ---------------------------------------------------------------------------

/**
 * Provider DISTRIBUÍDO — o modelo OFICIAL do produto. Nada de novo aqui: só dá
 * a getValidAccessToken/renovarEArmazenar (acima) a forma do contrato comum,
 * para que quem consome tokens não precise saber que existem dois modos.
 */
export const distributedAuthProvider = Object.freeze({
  modo: MODOS_AUTH.DISTRIBUTED,
  escopoDoToken: "conexao",   // credenciais persistidas POR conexão (unidade)

  getAccessToken({ conexaoId, appType, lojaId = null, deps = {} }) {
    return getValidAccessToken({ conexaoId, appType, lojaId, deps });
  },

  /** Após 401: refresh por refresh_token, persiste o novo par (cifrado). */
  async renovarAposRejeicao({ conexaoId, appType, lojaId = null, deps = {} }) {
    const repo = deps.repo ?? repositorio;
    const http = deps.http ?? httpClient;
    const cred = await repo.obterCredencial({ conexaoId, appType, ...(lojaId ? { lojaId } : {}) });
    if (!cred) throw ifoodErro(IFOOD_ERROS.IFOOD_CREDENCIAL_NAO_ENCONTRADA);
    return renovarEArmazenar({ conexaoId, appType, cred, repo, http, lojaId });
  },
});

/** Modo de autenticação ativo: 'distributed' (padrão, oficial) ou 'centralized_test' (temporário). */
export function modoDeAutenticacao() {
  return modoDaConfig(config);
}

/**
 * O token do modo ativo pertence a uma CONEXÃO (unidade) — 'conexao', distribuído —
 * ou ao APP inteiro — 'app', centralizado de teste? Permite às APIs de negócio
 * decidirem se precisam resolver a conexão da unidade SEM saber qual é o modo.
 */
export function escopoDoToken() {
  return provedorDeAutenticacao().escopoDoToken;
}

let providerCentralizadoTeste = null;

/** Provider do modo ativo. O centralizado é um singleton (o cache do token é do processo). */
export function provedorDeAutenticacao() {
  if (modoDeAutenticacao() === MODOS_AUTH.CENTRALIZED_TEST) {
    providerCentralizadoTeste ??= criarProviderCentralizadoTeste();
    return providerCentralizadoTeste;
  }
  return distributedAuthProvider;
}

/**
 * ÚNICA porta de entrada de token para as APIs de negócio (Merchant, Financial,
 * Events, Order...). Executa `fn(accessToken)` e, se o iFood responder 401
 * (IFOOD_TOKEN_EXPIRADO), pede ao provider UMA renovação e repete `fn` UMA vez.
 * Sem loop. Quem chama não sabe se o token veio de authorization_code,
 * refresh_token ou client_credentials.
 *
 * @param {{conexaoId?: string|null, appType: string, fn: (token: string) => Promise<any>,
 *          deps?: {repo?, http?, provider?}}} p
 *   `conexaoId` só é usado pelo provider distribuído (credencial por conexão).
 */
export async function comAccessTokenValido({ conexaoId, appType, fn, deps = {}, lojaId = null }) {
  const repo = deps.repo ?? repositorio;
  const http = deps.http ?? httpClient;
  const provider = deps.provider ?? provedorDeAutenticacao();
  const depsProvider = { repo, http };

  const alvo = lojaId ? { lojaId } : {};   // credencial PRÓPRIA de uma loja adicional (118); sem loja, tudo como antes
  const token1 = await provider.getAccessToken({ conexaoId, appType, ...alvo, deps: depsProvider });
  try {
    return await fn(token1);
  } catch (e) {
    if (!(e instanceof IfoodError) || e.codigo !== IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO) throw e;

    // 401 mesmo com token "válido" pelo relógio: renova uma vez e tenta de novo.
    ifoodLog("warn", "token.retry_apos_401", { conexaoId, appType, modo: provider.modo, ...alvo });
    const token2 = await provider.renovarAposRejeicao({
      conexaoId, appType, ...alvo, deps: depsProvider, tokenRejeitado: token1,
    });
    return fn(token2);   // segunda e ÚLTIMA tentativa
  }
}

export { IFOOD_APPS };
