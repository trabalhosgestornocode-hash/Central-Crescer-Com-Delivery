// Auth Provider da integração iFood — contrato + provider CENTRALIZED_TEST.
//
// PRINCÍPIO
//   As APIs de negócio (Merchant, Financial e, adiante, Events/Order) NÃO sabem
//   de onde veio o token (authorization_code, refresh_token ou
//   client_credentials). Elas chamam UMA interface:
//
//       ifoodToken.service#comAccessTokenValido({ conexaoId, appType, fn })
//
//   que escolhe o provider e cuida do "401 -> renova UMA vez -> repete UMA vez".
//
//                    AUTH PROVIDER
//                         |
//                  getAccessToken()
//              +----------+----------+
//            Merchant   Events/Order  Financial
//
// CONTRATO (duck-typed):
//   {
//     modo: 'distributed' | 'centralized_test',
//     escopoDoToken: 'conexao' | 'app',   // o token pertence a uma conexão (unidade) ou ao app inteiro?
//     getAccessToken({ conexaoId, appType, deps }) => Promise<string>,
//     renovarAposRejeicao({ conexaoId, appType, deps, tokenRejeitado }) => Promise<string>,
//   }
//
// DOIS PROVIDERS
//   * distributed  — o modelo OFICIAL do produto. Vive em ifoodToken.service.js
//     (`distributedAuthProvider`): userCode -> authorizationCode -> access +
//     refresh token cifrados por (conexão, app), renovação, `reauth_required`.
//   * centralized_test — TEMPORÁRIO, só ambiente técnico (app "Teste (C)",
//     centralizado). client_credentials, token só EM MEMÓRIA. NÃO é o modelo do
//     produto, NÃO substitui a homologação do Teste (D) e NÃO persiste nada:
//     não existe refresh token e o token nunca é gravado como se fosse uma
//     credencial distribuída de unidade.
//
// Este arquivo NÃO importa ifoodToken.service.js (evita ciclo): o provider
// distribuído é montado lá, este só oferece o centralizado e a escolha do modo.

import { config } from "../../config/env.js";
import { ifoodErro, IFOOD_ERROS, IfoodError } from "./ifood.errors.js";
import { ifoodLog } from "./ifood.logsafe.js";
import { IFOOD_GRANT, IFOOD_ROTAS, IFOOD_TOKEN } from "./ifood.constants.js";
import * as httpClient from "./ifoodHttp.client.js";
import { centralizadoTestePermitido } from "./ifood.ambienteTeste.js";

export const MODOS_AUTH = Object.freeze({
  DISTRIBUTED: "distributed",
  CENTRALIZED_TEST: "centralized_test",
});

/** Modo de autenticação ativo neste processo. Distribuído é o PADRÃO e o modelo oficial. */
export function modoDeAutenticacao(cfg = config) {
  return cfg?.ifood?.centralizedTest?.modo === true ? MODOS_AUTH.CENTRALIZED_TEST : MODOS_AUTH.DISTRIBUTED;
}

// Depois de forçar uma renovação por 401, não força outra por este tempo: se o
// 401 persistir, o problema não é o token (permissão/loja) e martelar o
// endpoint de token só arrisca bloquear o app (a doc do iFood avisa contra
// gerar token antes de expirar).
const INTERVALO_MIN_RENOVACAO_FORCADA_MS = 30_000;

/**
 * Provider centralizado de TESTE (client_credentials, token em memória).
 * @param {{cfg?: object, env?: Record<string,string|undefined>, http?: object, agora?: () => number}} [opts]
 */
export function criarProviderCentralizadoTeste({
  cfg = config, env = process.env, http = httpClient, agora = () => Date.now(),
} = {}) {
  /** @type {{accessToken: string, expiraEmMs: number}|null} */
  let cache = null;
  /** @type {Promise<string>|null} requisição de token em voo (single-flight) */
  let emVoo = null;
  let ultimaForcadaMs = 0;

  function exigirPermitido() {
    const r = centralizadoTestePermitido(env);
    if (!r.ok) throw ifoodErro(IFOOD_ERROS.IFOOD_CENTRALIZADO_BLOQUEADO, { detalhes: { motivos: r.motivos } });
  }

  function credenciais() {
    const c = cfg?.ifood?.centralizedTest ?? {};
    if (!c.clientId || !c.clientSecret) {
      throw ifoodErro(IFOOD_ERROS.IFOOD_APP_SEM_CREDENCIAL, { detalhes: { origem: "centralized_test" } });
    }
    return { clientId: c.clientId, clientSecret: c.clientSecret };
  }

  const cacheValido = () => cache && cache.expiraEmMs - agora() > IFOOD_TOKEN.margemRenovacaoMs;

  async function buscarToken(httpEfetivo) {
    const { clientId, clientSecret } = credenciais();
    let resp;
    try {
      resp = await httpEfetivo.postForm(IFOOD_ROTAS.token, {
        grantType: IFOOD_GRANT.CLIENT_CREDENTIALS, clientId, clientSecret,
      }, { rotulo: "oauth.token.client_credentials" });
    } catch (e) {
      if (!(e instanceof IfoodError)) throw e;
      // 429 / 5xx / timeout já são transitórios e informativos: sobem como estão.
      if (e.codigo === IFOOD_ERROS.IFOOD_RATE_LIMITED || e.codigo === IFOOD_ERROS.IFOOD_INDISPONIVEL) throw e;
      // 400/401/403: credencial recusada. (Não usar a mensagem de "código de
      // autorização inválido" do fluxo distribuído — não se aplica aqui.)
      throw ifoodErro(IFOOD_ERROS.IFOOD_CENTRALIZADO_FALHOU, { detalhes: { causa: e.codigo } });
    }
    const accessToken = resp?.accessToken ?? resp?.access_token;
    if (!accessToken || typeof accessToken !== "string") {
      throw ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA, { detalhes: { motivo: "sem accessToken" } });
    }
    const expiresIn = Number(resp?.expiresIn ?? resp?.expires_in);
    const ttlS = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : IFOOD_TOKEN.expiresInPadraoS;
    cache = { accessToken, expiraEmMs: agora() + ttlS * 1000 };
    // NUNCA loga o token — só o instante de expiração.
    ifoodLog("info", "token.centralizado_teste.obtido", { expiraEm: new Date(cache.expiraEmMs).toISOString() });
    return accessToken;
  }

  function obter(httpEfetivo) {
    exigirPermitido();
    if (cacheValido()) return Promise.resolve(cache.accessToken);
    if (emVoo) return emVoo;
    emVoo = buscarToken(httpEfetivo).finally(() => { emVoo = null; });
    return emVoo;
  }

  return {
    modo: MODOS_AUTH.CENTRALIZED_TEST,
    escopoDoToken: 'app',

    /** `conexaoId`/`appType` são ignorados: o token é do APP, não de uma unidade. */
    async getAccessToken({ deps = {} } = {}) {
      return obter(deps.http ?? http);   // async: erros (inclusive a trava) sempre como rejeição
    },

    /** Chamado após 401. Renova uma vez, sem martelar o endpoint de token. */
    async renovarAposRejeicao({ deps = {}, tokenRejeitado } = {}) {
      exigirPermitido();
      // Outro request já renovou enquanto este falhava: usa o token novo.
      if (cache && tokenRejeitado && cache.accessToken !== tokenRejeitado) return cache.accessToken;
      // Renovação forçada recente e 401 de novo: não insiste.
      if (cache && agora() - ultimaForcadaMs < INTERVALO_MIN_RENOVACAO_FORCADA_MS) return cache.accessToken;
      ultimaForcadaMs = agora();
      cache = null;
      ifoodLog("warn", "token.centralizado_teste.renovacao_forcada_apos_401", {});
      return obter(deps.http ?? http);
    },

    /** Só para testes/diagnóstico: descarta o cache em memória. */
    _limparCache() { cache = null; emVoo = null; ultimaForcadaMs = 0; },
  };
}
