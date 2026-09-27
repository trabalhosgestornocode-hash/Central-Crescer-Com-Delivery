// Merchant API do iFood — SOMENTE LEITURA nesta fase.
//
// Permitido: GET /merchant/v1.0/merchants (paginado) e GET /merchants/{id}.
// PROIBIDO: qualquer escrita (interruptions, opening-hours, preparo, etc.).
//
// Regras desta fase:
//   * usa EXCLUSIVAMENTE a credencial `financial` (o módulo Merchant vive no
//     app FINANCIAL). O merchant_id descoberto aqui será reaproveitado para
//     Analytics numa fase futura — mas o vínculo é sempre feito pelo token
//     financial.
//   * refresh/retry de token via ifoodToken.comAccessTokenValido() (1 refresh
//     + 1 repetição em 401, nunca loop).
//   * tenant (organizacaoId, unidadeId) vem SEMPRE de req.tenant — repassado
//     pelo controller. Resolve a conexão viva da unidade e usa o token dela.
//   * retorno SANITIZADO para o frontend: id + idMascarado + nome + razão +
//     tipo + status. Nada além disso.
//   * merchantId vindo do frontend é SEMPRE revalidado em GET /merchants/{id}
//     antes de qualquer uso (o vínculo real é no bloco E).

import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";
import { ifoodLog, mascararId } from "./ifood.logsafe.js";
import { IFOOD_APPS, IFOOD_HTTP, IFOOD_ROTAS } from "./ifood.constants.js";
import * as httpClient from "./ifoodHttp.client.js";
import * as repositorio from "./ifood.repository.js";
import * as tokenService from "./ifoodToken.service.js";

// A Merchant API pode devolver um array cru OU um envelope. Cobrimos as
// formas conhecidas sem depender de uma só.
function extrairLista(resp) {
  if (Array.isArray(resp)) return resp;
  for (const k of ["merchants", "data", "content", "items", "results"]) {
    if (Array.isArray(resp?.[k])) return resp[k];
  }
  return [];
}

/** Merchant cru do iFood -> forma sanitizada para o frontend. */
export function sanitizarMerchant(m) {
  const id = String(m?.id ?? m?.merchantId ?? m?.uuid ?? "");
  return {
    id,                                   // real — o frontend precisa para o passo de vínculo
    idMascarado: mascararId(id),          // para exibição/telas
    nome: m?.name ?? m?.nome ?? null,
    razaoSocial: m?.corporateName ?? m?.corporate_name ?? m?.razaoSocial ?? null,
    tipo: m?.type ?? m?.tipo ?? null,
    status: m?.status ?? null,
  };
}

async function resolverConexao({ organizacaoId, unidadeId, repo }) {
  const conexao = await repo.obterConexaoViva({ organizacaoId, unidadeId });
  if (!conexao) throw ifoodErro(IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA);
  return conexao;
}

/**
 * Só resolve a conexão da unidade quando o TOKEN pertence a ela (modo
 * distribuído). Se o token é do app inteiro (modo temporário centralizado de
 * teste), não há credencial por unidade — não exige nem cria conexão. O Merchant
 * NÃO sabe qual é o modo: só pergunta a capacidade `escopoDoToken()`.
 * (Fakes de teste sem `escopoDoToken` seguem o comportamento distribuído.)
 */
async function conexaoSeOTokenForDela({ organizacaoId, unidadeId, repo, token }) {
  if ((token.escopoDoToken?.() ?? "conexao") === "app") return null;
  return resolverConexao({ organizacaoId, unidadeId, repo });
}

/** Percorre TODAS as páginas de GET /merchants com um accessToken já válido. */
async function paginarMerchants({ accessToken, http, sinal }) {
  const size = IFOOD_HTTP.pageSizePadrao;
  const porId = new Map();
  let truncado = false;

  for (let page = 1; ; page += 1) {
    const resp = await http.getJson(IFOOD_ROTAS.merchants(page, size), {
      accessToken, rotulo: "merchants.list", sinal,
    });
    const lote = extrairLista(resp);
    for (const m of lote) {
      const id = String(m?.id ?? m?.merchantId ?? m?.uuid ?? "");
      if (id && !porId.has(id)) porId.set(id, m);
    }

    if (lote.length < size) break;                 // última página
    if (page >= IFOOD_HTTP.maxPaginas) { truncado = true; break; }
  }

  if (truncado) {
    // "No silent caps": registra que a listagem pode estar incompleta.
    ifoodLog("warn", "merchants.limite_de_paginas", { maxPaginas: IFOOD_HTTP.maxPaginas, coletados: porId.size });
  }
  return { merchants: [...porId.values()], truncado };
}

/**
 * DESCOBERTA — lojas autorizadas pelo token financial da unidade.
 * Nunca lança por "0 lojas" — devolve lista vazia; o frontend mostra a
 * mensagem amigável.
 *
 * @param {{organizacaoId, unidadeId, deps?: {repo, http, token}}} p
 * @returns {Promise<{merchants: object[], total: number, truncado: boolean}>}
 */
export async function listarMerchantsAutorizados({ organizacaoId, unidadeId, deps = {} }) {
  const repo = deps.repo ?? repositorio;
  const http = deps.http ?? httpClient;
  const token = deps.token ?? tokenService;

  const conexao = await conexaoSeOTokenForDela({ organizacaoId, unidadeId, repo, token });

  const { merchants, truncado } = await token.comAccessTokenValido({
    conexaoId: conexao?.id ?? null, appType: IFOOD_APPS.FINANCIAL, deps: { repo, http },
    fn: (accessToken) => paginarMerchants({ accessToken, http }),
  });

  ifoodLog("info", "merchants.listados", { organizacaoId, unidadeId, total: merchants.length, truncado });

  return {
    merchants: merchants.map(sanitizarMerchant).filter((m) => m.id),
    total: merchants.length,
    truncado,
  };
}

/**
 * VALIDAÇÃO INDIVIDUAL — confirma que o token financial da unidade REALMENTE
 * tem acesso ao merchant informado (GET /merchants/{id}). Base obrigatória do
 * vínculo (bloco E) e da tela de confirmação.
 *
 * @param {{organizacaoId, unidadeId, merchantId, deps?: {repo, http, token}}} p
 * @returns {Promise<{id, idMascarado, nome, razaoSocial, tipo, status}>}
 */
export async function validarMerchant({ organizacaoId, unidadeId, merchantId, deps = {} }) {
  const repo = deps.repo ?? repositorio;
  const http = deps.http ?? httpClient;
  const token = deps.token ?? tokenService;

  const id = String(merchantId ?? "").trim();
  if (!id) throw ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_NAO_ENCONTRADO);

  const conexao = await conexaoSeOTokenForDela({ organizacaoId, unidadeId, repo, token });

  const detalhe = await token.comAccessTokenValido({
    conexaoId: conexao?.id ?? null, appType: IFOOD_APPS.FINANCIAL, deps: { repo, http },
    fn: (accessToken) => http.getJson(IFOOD_ROTAS.merchant(id), { accessToken, rotulo: "merchants.detail" }),
  });

  const sanitizado = sanitizarMerchant({ id, ...detalhe });
  ifoodLog("info", "merchants.validado", { organizacaoId, unidadeId, merchantId: mascararId(id) });
  return sanitizado;
}
