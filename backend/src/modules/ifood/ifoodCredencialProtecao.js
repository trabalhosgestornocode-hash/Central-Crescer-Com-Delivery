// iFood — PROTEÇÃO DA CREDENCIAL ORDER ATIVA ao concluir uma (re)autorização OAuth.
//
// Gravar tokens por cima da credencial de uma conexão já em uso troca o acesso da loja que FUNCIONA por um token que pode cobrir outras lojas
// (ou só a nova). Por isso, quando já existe credencial Order:
//   * o token NOVO tem de declarar (claim `merchant_scope`) TODAS as lojas que a conexão usa hoje — a principal e as adicionais vivas — com os
//     mesmos módulos do token atual. Sem essa prova (token opaco, sem escopo, faltando loja): NÃO grava, mantém a credencial atual e avisa;
//   * a troca é CONDICIONAL: só grava se o token atual ainda for o que foi lido (uma renovação concorrente nunca é sobrescrita);
//   * se não for possível saber quais lojas proteger (erro ao ler as lojas adicionais), recusa (falha segura).
// Ler a claim NÃO prova que o servidor do iFood aceita o token — prova só o que ele declara; o poller continua tratando 401/403 como sempre.
// Primeira conexão (sem credencial) e os apps Financial/Analytics seguem exatamente como antes.
//
// Nunca loga token, verifier nem código de autorização: só ids mascarados e motivos.

import { cifrar, decifrar } from "../../shared/cripto.js";
import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";
import { ifoodLog } from "./ifood.logsafe.js";
import { IFOOD_APP_ORDER } from "./ifood.constants.js";
import { coberturaDoToken, mascararMerchant } from "./ifoodTokenEscopo.js";

/**
 * @returns {Promise<{substituida: boolean, novasLojas?: string[]}>}
 * @throws IFOOD_CREDENCIAL_SEM_COBERTURA — nada foi gravado; a sessão OAuth é encerrada como `failed`.
 */
export async function gravarCredencialComProtecao({ conexao, appType, tokens, repo, token, organizacaoId, unidadeId, sessaoId }) {
  const atual = appType === IFOOD_APP_ORDER ? await repo.obterCredencial({ conexaoId: conexao.id, appType }) : null;
  if (!atual) {
    await token.salvarTokens({ conexaoId: conexao.id, appType, tokens, repo });
    return { substituida: false };
  }

  const recusar = async (motivo, extra = {}) => {
    await repo.fecharSessaoOAuth({ organizacaoId, unidadeId, sessaoId, status: "failed" });
    ifoodLog("warn", "oauth.credencial_preservada", { organizacaoId, unidadeId, appType, conexaoId: conexao.id, motivo, ...extra });
    throw ifoodErro(IFOOD_ERROS.IFOOD_CREDENCIAL_SEM_COBERTURA, { detalhes: { motivo } });
  };

  let extras;
  try {
    extras = typeof repo.listarLojasExtrasVivasDaConexao === "function" ? await repo.listarLojasExtrasVivasDaConexao({ conexaoId: conexao.id }) : [];
  } catch { return recusar("lojas_adicionais_ilegiveis"); }
  const exigidos = [conexao.merchant_id, ...extras].filter(Boolean);

  let novasLojas = [];
  if (exigidos.length > 0) {
    let tokenAtual = null;
    try { tokenAtual = decifrar(atual.access_token_cifrado); } catch { tokenAtual = null; }
    const prova = coberturaDoToken({ novo: tokens.accessToken, atual: tokenAtual, merchantsExigidos: exigidos });
    if (!prova.cobre) {
      return recusar(prova.motivo, { exigidas: exigidos.length, faltando: prova.faltando.map((f) => `${f.merchant}:${f.modulos.join("+")}`) });
    }
    novasLojas = prova.novasLojas;
  }

  const campos = {
    access_token_cifrado: cifrar(tokens.accessToken), expira_em: tokens.expiraEm, token_type: tokens.tokenType ?? null, status: "ativa",
    ...(tokens.refreshToken ? { refresh_token_cifrado: cifrar(tokens.refreshToken) } : {}),
  };
  const gravou = await repo.atualizarCredencial({ conexaoId: conexao.id, appType, campos, seAccessCifradoIgual: atual.access_token_cifrado });
  if (!gravou) return recusar("credencial_mudou_durante_a_troca");
  ifoodLog("info", "oauth.credencial_substituida", { organizacaoId, unidadeId, appType, conexaoId: conexao.id, lojasExigidas: exigidos.map(mascararMerchant), lojasNovasNoToken: novasLojas });
  return { substituida: true, novasLojas };
}
