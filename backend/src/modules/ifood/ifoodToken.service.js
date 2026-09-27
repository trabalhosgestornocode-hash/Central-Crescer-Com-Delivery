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
import { IFOOD_APPS, IFOOD_APP_TYPES, IFOOD_GRANT, IFOOD_ROTAS, IFOOD_TOKEN } from "./ifood.constants.js";
import * as httpClient from "./ifoodHttp.client.js";
import * as repositorio from "./ifood.repository.js";
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
 * clientId/clientSecret do app, de ENV (via config/env.js — nunca process.env
 * direto). Lança se não configurado.
 *
 * Em homologação, `analytics` e `financial` resolvem AMBOS para o mesmo app
 * de teste (IFOOD_TEST_CLIENT_ID/SECRET) — o mesmo aplicativo distribuído
 * autoriza os dois módulos nesse laboratório. Fora de homologação, cada
 * appType usa sua credencial real, como antes.
 */
export function credenciaisDoApp(appType) {
  if (!IFOOD_APP_TYPES.includes(appType)) throw ifoodErro(IFOOD_ERROS.IFOOD_APP_TYPE_INVALIDO);

  if (estaEmHomologacaoIfood()) {
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
 * @param {{appType: string, authorizationCode: string, verifier: string, http?: typeof httpClient}} p
 * @returns {Promise<{accessToken, refreshToken, tokenType, expiraEm}>}
 */
export async function trocarAuthorizationCodePorToken({ appType, authorizationCode, verifier, http = httpClient }) {
  const { clientId, clientSecret } = credenciaisDoApp(appType);
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
 * @param {{appType: string, refreshToken: string, http?: typeof httpClient}} p
 */
export async function renovarToken({ appType, refreshToken, http = httpClient }) {
  if (!refreshToken) throw ifoodErro(IFOOD_ERROS.IFOOD_REFRESH_FALHOU, { detalhes: { motivo: "sem refreshToken" } });
  const { clientId, clientSecret } = credenciaisDoApp(appType);
  let resp;
  try {
    resp = await http.postForm(IFOOD_ROTAS.token, {
      grantType: IFOOD_GRANT.REFRESH_TOKEN,
      clientId, clientSecret, refreshToken,
    }, { rotulo: "oauth.token.refresh" });
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
export async function salvarTokens({ conexaoId, appType, tokens, repo = repositorio }) {
  return repo.salvarCredencial({
    conexaoId, appType,
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
export async function getValidAccessToken({ conexaoId, appType, deps = {} }) {
  const repo = deps.repo ?? repositorio;
  const http = deps.http ?? httpClient;

  const cred = await repo.obterCredencial({ conexaoId, appType });
  if (!cred) throw ifoodErro(IFOOD_ERROS.IFOOD_CREDENCIAL_NAO_ENCONTRADA);
  if (cred.status === "reauth_required") throw ifoodErro(IFOOD_ERROS.IFOOD_REFRESH_FALHOU);

  if (!precisaRenovar(cred.expira_em)) {
    return decifrar(cred.access_token_cifrado);
  }

  // Renovação proativa.
  return renovarEArmazenar({ conexaoId, appType, cred, repo, http });
}

/** Renova, persiste e devolve o accessToken novo. Em falha: reauth_required. */
async function renovarEArmazenar({ conexaoId, appType, cred, repo, http }) {
  const refreshToken = decifrar(cred.refresh_token_cifrado);
  try {
    const tokens = await renovarToken({ appType, refreshToken, http });
    await salvarTokens({ conexaoId, appType, tokens, repo });
    ifoodLog("info", "token.renovado", { conexaoId, appType });
    return tokens.accessToken;
  } catch (e) {
    await repo.atualizarCredencial({ conexaoId, appType, campos: { status: "reauth_required" } }).catch(() => {});
    ifoodLog("warn", "token.reauth_required", { conexaoId, appType, causa: e?.codigo ?? e?.message });
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

  getAccessToken({ conexaoId, appType, deps = {} }) {
    return getValidAccessToken({ conexaoId, appType, deps });
  },

  /** Após 401: refresh por refresh_token, persiste o novo par (cifrado). */
  async renovarAposRejeicao({ conexaoId, appType, deps = {} }) {
    const repo = deps.repo ?? repositorio;
    const http = deps.http ?? httpClient;
    const cred = await repo.obterCredencial({ conexaoId, appType });
    if (!cred) throw ifoodErro(IFOOD_ERROS.IFOOD_CREDENCIAL_NAO_ENCONTRADA);
    return renovarEArmazenar({ conexaoId, appType, cred, repo, http });
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
export async function comAccessTokenValido({ conexaoId, appType, fn, deps = {} }) {
  const repo = deps.repo ?? repositorio;
  const http = deps.http ?? httpClient;
  const provider = deps.provider ?? provedorDeAutenticacao();
  const depsProvider = { repo, http };

  const token1 = await provider.getAccessToken({ conexaoId, appType, deps: depsProvider });
  try {
    return await fn(token1);
  } catch (e) {
    if (!(e instanceof IfoodError) || e.codigo !== IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO) throw e;

    // 401 mesmo com token "válido" pelo relógio: renova uma vez e tenta de novo.
    ifoodLog("warn", "token.retry_apos_401", { conexaoId, appType, modo: provider.modo });
    const token2 = await provider.renovarAposRejeicao({
      conexaoId, appType, deps: depsProvider, tokenRejeitado: token1,
    });
    return fn(token2);   // segunda e ÚLTIMA tentativa
  }
}

export { IFOOD_APPS };
