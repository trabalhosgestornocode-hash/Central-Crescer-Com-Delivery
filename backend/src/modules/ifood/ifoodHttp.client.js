// Cliente HTTP centralizado da API do iFood (Merchant API).
//
// DESACOPLADO DO TRANSPORTE: aceita `fetchImpl` injetável (default: fetch
// global). Nos testes é um fetch falso — nenhuma chamada real ao iFood, nem
// aqui nem no CI.
//
// RESPONSABILIDADES (e SÓ estas — nada de regra de negócio):
//   * base URL + montagem de URL;
//   * headers (Accept, Authorization Bearer, Content-Type form-urlencoded);
//   * timeout por chamada (AbortController) + encadeia cancelamento externo;
//   * classificação de status HTTP -> erro de domínio (ifood.errors.js);
//   * retry SELETIVO: só 5xx / rede / 429 (respeitando Retry-After, com teto);
//   * corte de resposta anômala + parse de JSON tolerante a erro;
//   * sanitização: nunca loga corpo, header, token, clientSecret ou query
//     sensível — só URL sanitizada, rótulo, status e duração.
//
// Segredos (clientId/clientSecret/tokens) são passados pelos SERVICES; este
// módulo os coloca no lugar certo da requisição e nunca os registra.

import { ifoodBaseUrl, IFOOD_HTTP } from "./ifood.constants.js";
import { ifoodErro, IFOOD_ERROS, erroPorStatusHttp, ehTransitorio } from "./ifood.errors.js";
import { ifoodLog, urlParaLog } from "./ifood.logsafe.js";

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry-After em segundos ou data HTTP -> ms, com teto. */
function retryAfterMs(header) {
  if (!header) return null;
  const seg = Number(header);
  if (Number.isFinite(seg)) return Math.min(seg * 1000, IFOOD_HTTP.maxRetryAfterMs);
  const data = Date.parse(header);
  if (Number.isFinite(data)) return Math.min(Math.max(data - Date.now(), 0), IFOOD_HTTP.maxRetryAfterMs);
  return null;
}

async function lerCorpo(resp) {
  const bruto = await resp.text();
  if (bruto.length > IFOOD_HTTP.maxRespostaBytes) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA, { detalhes: { motivo: "resposta acima do limite" } });
  }
  if (!bruto) return {};
  try { return JSON.parse(bruto); }
  catch { throw ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA, { detalhes: { motivo: "JSON inválido" } }); }
}

/**
 * Lê (com teto) o corpo de um 403 do polling e anexa SÓ a lista de ids em
 * `unauthorizedMerchants` ao erro. Nunca guarda nem loga o corpo bruto.
 */
async function anexarMerchantsNaoAutorizados(erro, resp) {
  try {
    const bruto = String(await resp.text()).slice(0, 64 * 1024);
    const lista = JSON.parse(bruto)?.unauthorizedMerchants;
    if (Array.isArray(lista)) {
      erro.details = { ...(erro.details ?? {}), unauthorizedMerchants: lista.filter((x) => typeof x === "string").slice(0, 500) };
    }
  } catch { /* corpo ausente/ilegível: segue sem a lista */ }
}

/**
 * Order (Checkpoint D): o 400/409/422 do iFood traz `{code, message}` (ex.: OrderExceededCancellationDeadline). Anexa SÓ esses dois
 * campos (curtos, sem corpo bruto) ao erro para a auditoria explicar POR QUE o iFood recusou. Nunca loga nem guarda o corpo inteiro.
 */
async function anexarErroDoIfood(erro, resp) {
  try {
    const bruto = String(await resp.text()).slice(0, 8 * 1024);
    const j = JSON.parse(bruto);
    const c = j?.code ?? j?.error?.code ?? null;
    const m = j?.message ?? j?.error?.message ?? null;
    erro.details = {
      ...(erro.details ?? {}),
      ...(typeof c === "string" || typeof c === "number" ? { ifoodCode: String(c).slice(0, 80) } : {}),
      ...(typeof m === "string" ? { ifoodMessage: m.slice(0, 200) } : {}),
    };
  } catch { /* corpo ausente/ilegível: segue sem os campos */ }
}

/**
 * Uma requisição com timeout, classificação de erro e retry seletivo.
 * @param {object} params
 * @param {string} params.metodo 'GET' | 'POST'
 * @param {string} params.caminho começa com '/'
 * @param {Record<string,string>} [params.headers]
 * @param {string} [params.corpo] já serializado (form-urlencoded)
 * @param {string} [params.rotulo] identificador para o log
 * @param {'oauth'|'merchant'} [params.contexto] afina a tradução de 400
 * @param {AbortSignal} [params.sinal] cancelamento externo
 * @param {typeof fetch} [params.fetchImpl]
 */
async function requisitar({ metodo, caminho, headers = {}, corpo, rotulo, contexto, sinal, fetchImpl, comStatus = false, semRetry = false }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") throw ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL, { detalhes: { motivo: "fetch indisponível" } });

  const url = `${ifoodBaseUrl()}${caminho}`;
  let ultimoErro;

  // `semRetry`: ações que MUDAM o pedido (cancel, dispatch...) nunca são repetidas às cegas — timeout/5xx NÃO prova que
  // o iFood deixou de processar. Quem chama decide (aguarda o evento oficial).
  const maxTentativas = semRetry ? 1 : IFOOD_HTTP.maxTentativas;
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IFOOD_HTTP.timeoutMs);
    const aoCancelar = () => ctrl.abort();
    sinal?.addEventListener("abort", aoCancelar, { once: true });

    const t0 = Date.now();
    try {
      const resp = await doFetch(url, {
        method: metodo,
        headers: { Accept: "application/json", ...headers },
        body: corpo,
        signal: ctrl.signal,
      });
      const duracaoMs = Date.now() - t0;

      if (!resp.ok) {
        ifoodLog("warn", "api.resposta", { rotulo, url: urlParaLog(url), status: resp.status, duracaoMs, tentativa });

        if (!ehTransitorio(resp.status)) {
          const erro = erroPorStatusHttp(resp.status, { contexto });
          // Polling de eventos: o 403 traz `unauthorizedMerchants` (as lojas que o token NÃO
          // acessa) — o poller precisa disso para tirar só elas do próximo pedido.
          if (contexto === "events" && resp.status === 403) await anexarMerchantsNaoAutorizados(erro, resp);
          if (contexto === "order") await anexarErroDoIfood(erro, resp);
          throw erro;
        }

        ultimoErro = erroPorStatusHttp(resp.status, { contexto });
        if (tentativa < maxTentativas) {
          const espera = (resp.status === 429 && retryAfterMs(resp.headers?.get?.("retry-after")))
            || IFOOD_HTTP.backoffBaseMs * 2 ** (tentativa - 1);
          await dormir(espera);
          continue;
        }
        throw ultimoErro;
      }

      const ct = String(resp.headers?.get?.("content-type") ?? "").toLowerCase();
      if (ct && !ct.includes("application/json")) {
        ifoodLog("warn", "api.content_type_inesperado", { rotulo, contentType: ct, duracaoMs });
        throw ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA, { detalhes: { motivo: "content-type não-JSON" } });
      }

      const json = await lerCorpo(resp);
      ifoodLog("info", "api.ok", { rotulo, url: urlParaLog(url), status: resp.status, duracaoMs, tentativa });
      // `comStatus`: quem chama precisa do código HTTP real (ex.: 202 do confirm), não só do corpo.
      return comStatus ? { status: resp.status, corpo: json } : json;
    } catch (e) {
      clearTimeout(timer);
      sinal?.removeEventListener("abort", aoCancelar);

      if (e?.codigo) throw e;                         // erro de domínio: sobe direto
      if (sinal?.aborted) throw ifoodErro(IFOOD_ERROS.IFOOD_CANCELADO);
      if (e?.name === "AbortError") {
        ultimoErro = ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL, { detalhes: { motivo: "timeout" } });
      } else {
        ultimoErro = ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL, { detalhes: { motivo: "falha de rede" } });
      }
      ifoodLog("warn", "api.falha", { rotulo, tentativa, erro: e?.message });
      if (tentativa < maxTentativas) { await dormir(IFOOD_HTTP.backoffBaseMs * 2 ** (tentativa - 1)); continue; }
      throw ultimoErro;
    } finally {
      clearTimeout(timer);
      sinal?.removeEventListener("abort", aoCancelar);
    }
  }

  throw ultimoErro ?? ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL);
}

// Header pedido pelo suporte do iFood para os endpoints de homologação
// (formulário de teste + endpoints financeiros). Só é anexado quando o
// CHAMADOR passa `homologacao: true` explicitamente — nunca por causa de
// IFOOD_HOMOLOGATION_MODE sozinho, e nunca em produção por acidente.
const HEADER_HOMOLOGACAO = "x-request-homologation";

/**
 * POST application/x-www-form-urlencoded. Usado no fluxo OAuth (userCode e
 * troca/renovação de token). `campos` é um objeto plano string->string; o
 * clientSecret pode estar aqui e NUNCA é logado.
 * @param {string} caminho
 * @param {Record<string, string|number>} campos
 * @param {{rotulo?: string, contexto?: string, sinal?: AbortSignal, fetchImpl?: typeof fetch, homologacao?: boolean}} [opts]
 */
export async function postForm(caminho, campos, opts = {}) {
  const { homologacao, ...resto } = opts;
  const corpo = new URLSearchParams(
    Object.entries(campos).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
  ).toString();
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (homologacao === true) headers[HEADER_HOMOLOGACAO] = "true";
  return requisitar({
    metodo: "POST", caminho, corpo,
    headers,
    contexto: "oauth",
    ...resto,
  });
}

/**
 * GET autenticado por Bearer. Usado na Merchant API (blocos D/E) e, desde a
 * Fase 2, nas leituras Financial (Sales/Events/Settlements/Reconciliation/
 * Anticipation) — sempre leitura.
 * @param {string} caminho
 * @param {{accessToken: string, rotulo?: string, sinal?: AbortSignal, fetchImpl?: typeof fetch, homologacao?: boolean, contexto?: 'merchant'|'financial'|'reconciliation'}} opts
 *   `homologacao: true` anexa o header `x-request-homologation: true` —
 *   opt-in explícito por chamada (ver ifoodHttp.client.js topo do arquivo).
 *   `contexto` só afina a MENSAGEM de erro em 400/403/404/409 (ifood.errors.js)
 *   — nunca muda o comportamento de rede. Default 'merchant' preserva 100% do
 *   comportamento anterior à Fase 2.
 */
export async function getJson(caminho, { accessToken, rotulo, sinal, fetchImpl, homologacao, contexto = "merchant", headers: extra } = {}) {
  if (!accessToken) throw ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO);
  // `extra` (ex.: x-polling-merchants) NUNCA sobrescreve a autenticação.
  const headers = { ...(extra ?? {}), Authorization: `Bearer ${accessToken}` };
  if (homologacao === true) headers[HEADER_HOMOLOGACAO] = "true";
  return requisitar({
    metodo: "GET", caminho,
    headers,
    contexto,
    rotulo, sinal, fetchImpl,
  });
}

/**
 * POST application/json autenticado por Bearer. Usado só em
 * Reconciliation On Demand (o único endpoint Financial desta fase que
 * recebe corpo JSON em vez de query string) — ver ifoodFinancial.service.js.
 * @param {string} caminho
 * @param {object} corpoObjeto serializado como JSON
 * @param {{accessToken: string, rotulo?: string, sinal?: AbortSignal, fetchImpl?: typeof fetch, homologacao?: boolean, contexto?: string}} opts
 */
export async function postJson(caminho, corpoObjeto, { accessToken, rotulo, sinal, fetchImpl, homologacao, contexto, semCorpo = false, comStatus = false, semRetry = false } = {}) {
  if (!accessToken) throw ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO);
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
  if (homologacao === true) headers[HEADER_HOMOLOGACAO] = "true";
  return requisitar({
    metodo: "POST", caminho,
    corpo: semCorpo ? undefined : JSON.stringify(corpoObjeto ?? {}),   // `semCorpo`: POST de ação sem payload (ex.: /confirm)
    headers,
    contexto,
    rotulo, sinal, fetchImpl, comStatus, semRetry,
  });
}
