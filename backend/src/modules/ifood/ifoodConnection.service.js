// Vínculo merchant -> unidade + status da integração iFood.
//
// REGRAS (todas verificadas por teste):
//   * recebe SÓ merchantId; tenant vem de req.tenant (via controller);
//   * REVALIDA o merchant na Merchant API (token financial) ANTES de gravar —
//     nome/razão social usados são os DA API, nunca os do frontend;
//   * grava na CONEXÃO VIVA da unidade (não cria outra se já existe uma
//     pendente/viva); promove status para 'ativa';
//   * bloqueia merchant já vinculado a OUTRA unidade (busca global) com
//     mensagem amigável; re-vincular o MESMO merchant à MESMA unidade é
//     idempotente (atualiza nome/razão e retorna ok);
//   * corrida de dois vínculos simultâneos: a 1ª barreira é
//     conexaoVivaDoMerchant, a 2ª é o índice único parcial no banco
//     (23505 -> IFOOD_VINCULO_DUPLICADO).
//
// Nenhuma chamada Analytics / Sales / Financial Events / Settlement /
// Reconciliation. Nenhuma escrita no Merchant.

import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";
import { ifoodLog, mascararId } from "./ifood.logsafe.js";
import { IFOOD_APPS, IFOOD_APP_TYPES } from "./ifood.constants.js";
import * as repositorio from "./ifood.repository.js";
import * as merchantService from "./ifoodMerchant.service.js";
import { estaEmHomologacaoIfood } from "./ifoodToken.service.js";

/**
 * Vincula um merchant do iFood à unidade do contexto.
 * @param {{organizacaoId, unidadeId, merchantId, usuarioId, deps?: object}} p
 * @returns {Promise<object>} status sanitizado da integração (mesmo shape de obterStatus)
 */
export async function vincularMerchant({ organizacaoId, unidadeId, merchantId, usuarioId, deps = {} }) {
  const repo = deps.repo ?? repositorio;

  const id = String(merchantId ?? "").trim();
  if (!id) throw ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_NAO_ENCONTRADO);

  // 1) Precisa de uma conexão viva (criada no /oauth/complete). Sem ela, não
  //    há token financial para validar nada.
  const conexao = await repo.obterConexaoViva({ organizacaoId, unidadeId });
  if (!conexao) throw ifoodErro(IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA);

  // 2) REVALIDA na API (token financial). Aqui 401/403/404/reauth_required já
  //    são tratados por validarMerchant -> comAccessTokenValido.
  const merchant = await merchantService.validarMerchant({ organizacaoId, unidadeId, merchantId: id, deps });

  // 3) Duplicidade GLOBAL (o merchant só pode estar vivo em uma unidade).
  const jaVinculado = await repo.conexaoVivaDoMerchant({ merchantId: id });
  if (jaVinculado && jaVinculado.id !== conexao.id) {
    // Não revela de qual empresa/unidade é — só que já está em uso.
    throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_DUPLICADO);
  }

  const jaEraDestaUnidade = conexao.merchant_id === id && conexao.status === "ativa";

  // 4) Grava (nome/razão SEMPRE da API). Corrida -> 23505 -> duplicidade.
  await repo.definirMerchantDaConexao({
    organizacaoId, unidadeId, conexaoId: conexao.id,
    merchantId: id, nome: merchant.nome, razaoSocial: merchant.razaoSocial,
  });

  ifoodLog("info", jaEraDestaUnidade ? "merchant.revinculado" : "merchant.vinculado", {
    organizacaoId, unidadeId, conexaoId: conexao.id, merchantId: mascararId(id),
  });

  return obterStatus({ organizacaoId, unidadeId, deps });
}

/**
 * Status da integração iFood da unidade — analytics e financial SEPARADOS.
 * Sanitizado: nenhum token, secret ou merchantId completo.
 * @param {{organizacaoId, unidadeId, deps?: object}} p
 */
export async function obterStatus({ organizacaoId, unidadeId, deps = {} }) {
  const repo = deps.repo ?? repositorio;

  const conexao = await repo.obterConexaoViva({ organizacaoId, unidadeId });

  const appsVazio = Object.fromEntries(IFOOD_APP_TYPES.map((a) => [a, { conectado: false, status: null, expiraEm: null }]));

  if (!conexao) {
    return {
      conectado: false,
      status: "nao_conectado",
      merchant: null,
      apps: appsVazio,
      conectadaEm: null,
      ultimaSincronizacao: null,
      ultimoErro: null,
      homologacao: estaEmHomologacaoIfood(),
    };
  }

  const credenciais = await repo.listarCredenciaisDaConexao({ conexaoId: conexao.id });
  const porApp = new Map(credenciais.map((c) => [c.app_type, c]));
  const apps = Object.fromEntries(IFOOD_APP_TYPES.map((a) => {
    const c = porApp.get(a);
    return [a, {
      conectado: !!c && c.status === "ativa",
      status: c?.status ?? null,           // 'ativa' | 'reauth_required' | null
      expiraEm: c?.expira_em ?? null,
    }];
  }));

  const financialOk = apps[IFOOD_APPS.FINANCIAL]?.conectado === true;
  const algumReauth = credenciais.some((c) => c.status === "reauth_required");

  return {
    conectado: conexao.status === "ativa" && !!conexao.merchant_id && financialOk,
    status: algumReauth ? "reauth_required" : conexao.status,
    merchant: conexao.merchant_id
      ? { idMascarado: mascararId(conexao.merchant_id), nome: conexao.merchant_nome ?? null, razaoSocial: conexao.merchant_razao_social ?? null }
      : null,
    apps,
    conectadaEm: conexao.conectada_em ?? null,
    ultimaSincronizacao: conexao.ultima_sincronizacao_em ?? null,   // sempre null nesta fase
    ultimoErro: conexao.ultimo_erro ?? null,
    // Só um booleano — nunca clientId/clientSecret/token. Alimenta a badge
    // discreta "Ambiente de homologação iFood" no frontend.
    homologacao: estaEmHomologacaoIfood(),
  };
}

/**
 * DESCONEXÃO LOCAL. Não existe endpoint de revogação documentado no iFood —
 * aqui só desativamos o uso local:
 *   * apaga as credenciais (tokens cifrados) da conexão;
 *   * cancela sessões OAuth pendentes;
 *   * marca a conexão como 'revogada' (o índice único parcial libera o
 *     merchant para outra unidade, e obterConexaoViva passa a devolver null).
 *
 * Idempotente: sem conexão viva, responde ok sem erro.
 * @returns {Promise<{ok: true, jaDesconectado: boolean, revogacaoNoIfood: 'manual_no_portal'}>}
 */
export async function desconectar({ organizacaoId, unidadeId, usuarioId, deps = {} }) {
  const repo = deps.repo ?? repositorio;

  const conexao = await repo.obterConexaoViva({ organizacaoId, unidadeId });
  await repo.cancelarSessoesPendentes({ organizacaoId, unidadeId }).catch(() => {});

  if (!conexao) {
    return { ok: true, jaDesconectado: true, revogacaoNoIfood: "manual_no_portal" };
  }

  await repo.apagarCredenciais({ conexaoId: conexao.id });
  await repo.atualizarConexao({
    organizacaoId, unidadeId, conexaoId: conexao.id,
    campos: { status: "revogada", ultimo_erro: null },
  });

  ifoodLog("info", "conexao.desconectada_localmente", { organizacaoId, unidadeId, conexaoId: conexao.id, por: usuarioId });

  return { ok: true, jaDesconectado: false, revogacaoNoIfood: "manual_no_portal" };
}
