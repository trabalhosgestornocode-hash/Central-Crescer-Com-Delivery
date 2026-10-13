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
// LOJA-ALVO (credencial independente por merchant, migration 118): quando a sessão OAuth tem uma loja adicional como alvo, os tokens vão
// EXCLUSIVAMENTE para a credencial PRÓPRIA dessa loja — o token tem de declarar o merchant da loja com os módulos order+events (mesmo na
// primeira gravação) e a credencial da CONEXÃO (Sanduíches) nunca é lida nem escrita. É o mesmo mecanismo (prova de cobertura + troca
// condicional), apenas com outro titular e outra lista de lojas exigidas.
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
export async function gravarCredencialComProtecao({ conexao, appType, tokens, repo, token, organizacaoId, unidadeId, sessaoId, loja = null }) {
  const alvo = loja ? { lojaId: loja.id } : {};
  const atual = appType === IFOOD_APP_ORDER ? await repo.obterCredencial({ conexaoId: conexao.id, appType, ...alvo }) : null;
  if (!atual && !loja) {
    await token.salvarTokens({ conexaoId: conexao.id, appType, tokens, repo });
    return { substituida: false };
  }

  const recusar = async (motivo, extra = {}) => {
    await repo.fecharSessaoOAuth({ organizacaoId, unidadeId, sessaoId, status: "failed" });
    ifoodLog("warn", "oauth.credencial_preservada", { organizacaoId, unidadeId, appType, conexaoId: conexao.id, motivo, ...(loja ? { lojaId: loja.id } : {}), ...extra });
    throw ifoodErro(IFOOD_ERROS.IFOOD_CREDENCIAL_SEM_COBERTURA, { detalhes: { motivo } });
  };

  // Loja-alvo: só o merchant dela. Credencial da conexão: a principal + as adicionais vivas que dependem DELA (as com credencial própria não).
  let extras = [];
  if (!loja) {
    try {
      extras = typeof repo.listarLojasExtrasVivasDaConexao === "function" ? await repo.listarLojasExtrasVivasDaConexao({ conexaoId: conexao.id }) : [];
    } catch { return recusar("lojas_adicionais_ilegiveis"); }
  }
  const exigidos = (loja ? [loja.merchant_id] : [conexao.merchant_id, ...extras]).filter(Boolean);

  let novasLojas = [];
  if (exigidos.length > 0) {
    let tokenAtual = null;
    try { tokenAtual = atual ? decifrar(atual.access_token_cifrado) : null; } catch { tokenAtual = null; }
    const prova = coberturaDoToken({ novo: tokens.accessToken, atual: tokenAtual, merchantsExigidos: exigidos });
    if (!prova.cobre) {
      return recusar(prova.motivo, { exigidas: exigidos.length, faltando: prova.faltando.map((f) => `${f.merchant}:${f.modulos.join("+")}`) });
    }
    novasLojas = prova.novasLojas;
  }

  if (!atual) {
    // Primeira credencial PRÓPRIA da loja (o token já provou cobrir o merchant dela).
    await token.salvarTokens({ conexaoId: conexao.id, appType, tokens, repo, ...alvo });
    ifoodLog("info", "oauth.credencial_loja_criada", { organizacaoId, unidadeId, appType, conexaoId: conexao.id, lojaId: loja.id, lojasExigidas: exigidos.map(mascararMerchant) });
    return { substituida: false, novasLojas };
  }

  const campos = {
    access_token_cifrado: cifrar(tokens.accessToken), expira_em: tokens.expiraEm, token_type: tokens.tokenType ?? null, status: "ativa",
    ...(tokens.refreshToken ? { refresh_token_cifrado: cifrar(tokens.refreshToken) } : {}),
  };
  const gravou = await repo.atualizarCredencial({ conexaoId: conexao.id, appType, ...alvo, campos, seAccessCifradoIgual: atual.access_token_cifrado });
  if (!gravou) return recusar("credencial_mudou_durante_a_troca");
  ifoodLog("info", "oauth.credencial_substituida", { organizacaoId, unidadeId, appType, conexaoId: conexao.id, ...(loja ? { lojaId: loja.id } : {}), lojasExigidas: exigidos.map(mascararMerchant), lojasNovasNoToken: novasLojas });
  return { substituida: true, novasLojas };
}
