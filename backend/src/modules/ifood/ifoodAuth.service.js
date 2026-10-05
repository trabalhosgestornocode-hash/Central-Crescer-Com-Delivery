// Fluxo OAuth distribuído do iFood — o "device flow" com código de vínculo.
//
//   iniciarConexao   -> POST /oauth/userCode. Guarda userCode + verifier
//                       (CIFRADO) numa ifood_oauth_sessoes 'pending'. Devolve
//                       ao frontend SÓ o que ele pode ver.
//   concluirAutorizacao -> recebe o authorizationCode que o parceiro copiou
//                       do Portal do iFood, troca por token, grava a
//                       credencial (cifrada) e ANULA o verifier.
//
// O `authorizationCodeVerifier` NUNCA volta ao frontend e NUNCA aparece em
// log. Ele nasce cifrado no banco e é destruído assim que o fluxo termina
// (sucesso, falha ou expiração).
//
// Tenant (organizacaoId, unidadeId) vem SEMPRE de req.tenant — o controller
// repassa, este service nunca lê do corpo.

import { cifrar, decifrar } from "../../shared/cripto.js";
import { ifoodErro, IFOOD_ERROS, IfoodError } from "./ifood.errors.js";
import { ifoodLog } from "./ifood.logsafe.js";
import { IFOOD_ROTAS, IFOOD_OAUTH, IFOOD_APP_ORDER } from "./ifood.constants.js";
import * as httpClient from "./ifoodHttp.client.js";
import * as repositorio from "./ifood.repository.js";
import * as tokenService from "./ifoodToken.service.js";

// Política de ambiente (config), não dependência injetável: sempre o tokenService real. `order` exige a
// unidade no piloto — checado AQUI, antes de qualquer chamada ao iFood, no início E na conclusão do OAuth.
function validarAppType(appType, unidadeId) {
  if (!tokenService.appTypesDoOAuth().includes(appType)) throw ifoodErro(IFOOD_ERROS.IFOOD_APP_TYPE_INVALIDO);
  if (appType === IFOOD_APP_ORDER && !tokenService.orderLiberadoParaUnidade(unidadeId)) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_ORDER_PILOTO_NAO_HABILITADO);
  }
  return appType;
}

/**
 * ETAPA 1 — gera o código de vínculo.
 * @param {{organizacaoId, unidadeId, appType, usuarioId, deps?: object}} p
 * @returns {Promise<{sessionId, userCode, verificationUrl, verificationUrlComplete, expiraEm, appType}>}
 */
export async function iniciarConexao({ organizacaoId, unidadeId, appType, usuarioId, deps = {} }) {
  const repo = deps.repo ?? repositorio;
  const http = deps.http ?? httpClient;
  const token = deps.token ?? tokenService;

  validarAppType(appType, unidadeId);
  // Unidade do TENANT (req.tenant, via controller) — decide o app de teste no Financial
  // por unidade. Lança IFOOD_APP_SEM_CREDENCIAL se faltar ENV (sem fallback de app).
  const credencial = token.credenciaisDoApp(appType, { unidadeId });
  const { clientId } = credencial;
  const origemCredencial = credencial.origem === "test" ? "test" : "producao";

  let resp;
  try {
    resp = await http.postForm(IFOOD_ROTAS.userCode, { clientId }, { rotulo: "oauth.userCode" });
  } catch (e) {
    if (e instanceof IfoodError) throw ifoodErro(IFOOD_ERROS.IFOOD_USER_CODE_FALHOU, { detalhes: { causa: e.codigo } });
    throw e;
  }

  const userCode = resp?.userCode;
  const verifier = resp?.authorizationCodeVerifier;
  if (!userCode || !verifier) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA, { detalhes: { motivo: "userCode/verifier ausente" } });
  }

  const expiresIn = Number(resp?.expiresIn ?? IFOOD_OAUTH.ttlPadraoS);
  const expiraEm = new Date(Date.now() + (Number.isFinite(expiresIn) ? expiresIn : IFOOD_OAUTH.ttlPadraoS) * 1000).toISOString();

  // Higiene: fecha sessões pendentes já vencidas da unidade antes de abrir outra.
  await repo.expirarSessoesVencidas({ organizacaoId, unidadeId }).catch(() => {});

  const sessao = await repo.criarSessaoOAuth({
    organizacaoId, unidadeId, appType,
    userCode,
    verifierCifrado: cifrar(verifier),
    verificationUrl: resp?.verificationUrl ?? null,
    verificationUrlComplete: resp?.verificationUrlComplete ?? null,
    expiraEm, criadoPor: usuarioId,
  });

  ifoodLog("info", "oauth.iniciado", { organizacaoId, unidadeId, appType, sessionId: sessao.id, expiraEm, origemCredencial });

  // NUNCA devolve o verifier.
  return {
    sessionId: sessao.id,
    appType,
    userCode,
    verificationUrl: sessao.verification_url,
    verificationUrlComplete: sessao.verification_url_complete,
    expiraEm,
  };
}

/**
 * ETAPA 2 — conclui a autorização com o authorizationCode do parceiro.
 * @param {{organizacaoId, unidadeId, appType, sessaoId, authorizationCode, usuarioId, deps?: object}} p
 * @returns {Promise<{appType, status: 'authorized', conexaoStatus: string}>}
 */
export async function concluirAutorizacao({
  organizacaoId, unidadeId, appType, sessaoId, authorizationCode, usuarioId, deps = {},
}) {
  const repo = deps.repo ?? repositorio;
  const http = deps.http ?? httpClient;
  const token = deps.token ?? tokenService;

  validarAppType(appType, unidadeId);

  const sessao = await repo.obterSessaoOAuth({ organizacaoId, unidadeId, sessaoId, appType });

  if (sessao.status !== "pending") throw ifoodErro(IFOOD_ERROS.IFOOD_OAUTH_SESSAO_JA_USADA);
  if (new Date(sessao.expira_em).getTime() <= Date.now()) {
    await repo.fecharSessaoOAuth({ organizacaoId, unidadeId, sessaoId, status: "expired" });
    throw ifoodErro(IFOOD_ERROS.IFOOD_OAUTH_SESSAO_EXPIRADA);
  }

  const verifier = decifrar(sessao.authorization_code_verifier_cifrado);
  if (!verifier) throw ifoodErro(IFOOD_ERROS.IFOOD_OAUTH_SESSAO_JA_USADA);

  // Uma sessão só pode ser concluída UMA vez: duas conclusões simultâneas
  // (duplo clique, duas abas) não podem ambas trocar o código.
  const reivindicada = await repo.reivindicarSessaoOAuth({ organizacaoId, unidadeId, sessaoId });
  if (!reivindicada) throw ifoodErro(IFOOD_ERROS.IFOOD_OAUTH_SESSAO_JA_USADA);

  let tokens;
  try {
    // Unidade da SESSÃO persistida (já filtrada por org+unidade do tenant): a mesma regra do
    // userCode escolhe o app — um userCode do app de teste nunca é trocado com o app de produção.
    tokens = await token.trocarAuthorizationCodePorToken({ appType, authorizationCode, verifier, unidadeId: sessao.unidade_id ?? unidadeId, http });
  } catch (e) {
    await repo.fecharSessaoOAuth({ organizacaoId, unidadeId, sessaoId, status: "failed" });
    throw e;
  }

  const conexao = await repo.obterOuCriarConexao({ organizacaoId, unidadeId, criadoPor: usuarioId });
  await token.salvarTokens({ conexaoId: conexao.id, appType, tokens, repo });
  await repo.fecharSessaoOAuth({ organizacaoId, unidadeId, sessaoId, status: "authorized" });

  ifoodLog("info", "oauth.concluido", { organizacaoId, unidadeId, appType, conexaoId: conexao.id });

  return { appType, status: "authorized", conexaoStatus: conexao.status };
}
