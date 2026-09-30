// Repositório da integração iFood (Supabase).
//
// ISOLAMENTO — regra inegociável (mesma de martinbrower.repository.js):
//   TODA query de conexão/sessão filtra organizacao_id E unidade_id. O
//   backend usa service_role (ignora RLS), então esta camada É o isolamento
//   efetivo. `exigirTenant` falha alto se faltar, em vez de rodar sem filtro.
//
//   As tabelas de token (ifood_credenciais) e de estado OAuth
//   (ifood_oauth_sessoes) são backend-only (RLS deny-all). Ainda assim o
//   acesso a credencial passa SEMPRE pela conexão, que é escopada por tenant.
//
// Os ids vêm SEMPRE de req.tenant, nunca do corpo da requisição.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";

const T = {
  conexoes: "ifood_conexoes",
  credenciais: "ifood_credenciais",
  sessoes: "ifood_oauth_sessoes",
};

function exigirTenant(organizacaoId, unidadeId) {
  if (!organizacaoId || !unidadeId) {
    throw ApiError.internal("Escopo de tenant ausente na consulta iFood.");
  }
}

const ok = (res) => {
  if (res.error) throw ApiError.internal(res.error.message);
  return res.data;
};

// =====================================================================
// SESSÕES OAUTH (estado temporário do fluxo distribuído)
// =====================================================================

export async function criarSessaoOAuth({
  organizacaoId, unidadeId, appType, userCode, verifierCifrado,
  verificationUrl, verificationUrlComplete, expiraEm, criadoPor,
}) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await supabase.from(T.sessoes).insert({
    organizacao_id: organizacaoId, unidade_id: unidadeId, app_type: appType,
    user_code: userCode,
    authorization_code_verifier_cifrado: verifierCifrado ?? null,
    verification_url: verificationUrl ?? null,
    verification_url_complete: verificationUrlComplete ?? null,
    expira_em: expiraEm, status: "pending", criado_por: criadoPor ?? null,
  }).select().single());
}

/** Sessão OAuth pelo id, já conferindo tenant + appType. */
export async function obterSessaoOAuth({ organizacaoId, unidadeId, sessaoId, appType }) {
  exigirTenant(organizacaoId, unidadeId);
  let q = supabase.from(T.sessoes).select("*")
    .eq("id", sessaoId).eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId);
  if (appType) q = q.eq("app_type", appType);
  const row = ok(await q.maybeSingle());
  if (!row) throw ifoodErro(IFOOD_ERROS.IFOOD_OAUTH_SESSAO_NAO_ENCONTRADA);
  return row;
}

/**
 * Reivindica a sessão para UMA conclusão só (atômico no banco): só uma chamada
 * concorrente consegue mudar `verifier_consumido_em` de NULL para agora enquanto
 * a sessão está 'pending'. Quem perder recebe null e deve tratar como sessão já usada.
 * Não anula o verifier aqui — quem fecha a sessão (fecharSessaoOAuth) faz isso.
 */
export async function reivindicarSessaoOAuth({ organizacaoId, unidadeId, sessaoId }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await supabase.from(T.sessoes)
    .update({ verifier_consumido_em: new Date().toISOString() })
    .eq("id", sessaoId).eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .eq("status", "pending").is("verifier_consumido_em", null)
    .select("id").maybeSingle());
}

/**
 * Marca o desfecho da sessão OAuth e (opcionalmente) ANULA o verifier.
 * O verifier nunca é reutilizável depois de concluído o fluxo.
 */
export async function fecharSessaoOAuth({ organizacaoId, unidadeId, sessaoId, status, anularVerifier = true }) {
  exigirTenant(organizacaoId, unidadeId);
  const campos = { status };
  if (anularVerifier) {
    campos.authorization_code_verifier_cifrado = null;
    campos.verifier_consumido_em = new Date().toISOString();
  }
  return ok(await supabase.from(T.sessoes).update(campos)
    .eq("id", sessaoId).eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .select().maybeSingle());
}

/** Cancela (marca 'failed' + anula verifier) toda sessão OAuth ainda pending
 *  da unidade — usado na desconexão local. */
export async function cancelarSessoesPendentes({ organizacaoId, unidadeId }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await supabase.from(T.sessoes)
    .update({ status: "failed", authorization_code_verifier_cifrado: null, verifier_consumido_em: new Date().toISOString() })
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).eq("status", "pending")
    .select("id"));
}

/** Expira em lote as sessões pending já vencidas desta unidade (higiene). */
export async function expirarSessoesVencidas({ organizacaoId, unidadeId }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await supabase.from(T.sessoes)
    .update({ status: "expired", authorization_code_verifier_cifrado: null, verifier_consumido_em: new Date().toISOString() })
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .eq("status", "pending").lt("expira_em", new Date().toISOString())
    .select("id"));
}

// =====================================================================
// CONEXÃO (vínculo unidade <-> loja iFood)
// =====================================================================

/** A conexão viva (não revogada) da unidade, se existir. */
export async function obterConexaoViva({ organizacaoId, unidadeId }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await supabase.from(T.conexoes).select("*")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .neq("status", "revogada")
    .maybeSingle());
}

/** Conexão por id, conferindo tenant. Lança se não pertencer. */
export async function obterConexaoDoTenant({ organizacaoId, unidadeId, conexaoId }) {
  exigirTenant(organizacaoId, unidadeId);
  const row = ok(await supabase.from(T.conexoes).select("*")
    .eq("id", conexaoId).eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .maybeSingle());
  if (!row) throw ifoodErro(IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA);
  return row;
}

/** Cria a conexão 'pendente' (sem merchant ainda). */
export async function criarConexao({ organizacaoId, unidadeId, criadoPor }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await supabase.from(T.conexoes).insert({
    organizacao_id: organizacaoId, unidade_id: unidadeId,
    status: "pendente", criado_por: criadoPor ?? null,
  }).select().single());
}

/** Garante que existe uma conexão viva para a unidade e a devolve. */
export async function obterOuCriarConexao({ organizacaoId, unidadeId, criadoPor }) {
  const existente = await obterConexaoViva({ organizacaoId, unidadeId });
  if (existente) return existente;
  return criarConexao({ organizacaoId, unidadeId, criadoPor });
}

export async function atualizarConexao({ organizacaoId, unidadeId, conexaoId, campos }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await supabase.from(T.conexoes).update(campos)
    .eq("id", conexaoId).eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .select().maybeSingle());
}

/**
 * Conexão VIVA (não revogada) que já usa este merchant — busca GLOBAL, de
 * propósito: um merchant do iFood só pode estar vinculado a UMA unidade em
 * todo o SaaS (espelha o índice único parcial uq_ifood_conexao_merchant_vivo).
 * Usado para bloquear "merchant já vinculado a outra unidade" ANTES de gravar.
 */
export async function conexaoVivaDoMerchant({ merchantId }) {
  if (!merchantId) return null;
  return ok(await supabase.from(T.conexoes)
    .select("id, organizacao_id, unidade_id, status, merchant_id")
    .eq("merchant_id", merchantId).neq("status", "revogada")
    .maybeSingle());
}

/**
 * Grava o merchant na conexão viva da unidade e promove para 'ativa'. O
 * nome/razão vêm SEMPRE da Merchant API (nunca do frontend). Traduz a
 * violação do índice único de merchant (corrida de dois vínculos) para o
 * erro amigável de duplicidade — o índice é a última barreira, esta função
 * a segunda, e conexaoVivaDoMerchant a primeira.
 */
export async function definirMerchantDaConexao({
  organizacaoId, unidadeId, conexaoId, merchantId, nome, razaoSocial,
}) {
  exigirTenant(organizacaoId, unidadeId);
  const res = await supabase.from(T.conexoes).update({
    merchant_id: merchantId,
    merchant_nome: nome ?? null,
    merchant_razao_social: razaoSocial ?? null,
    status: "ativa",
    conectada_em: new Date().toISOString(),
    ultimo_erro: null,
  }).eq("id", conexaoId).eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .select().maybeSingle();

  if (res.error) {
    if (res.error.code === "23505") throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_DUPLICADO);
    throw ApiError.internal(res.error.message);
  }
  return res.data;
}

// =====================================================================
// CREDENCIAIS (tokens cifrados por app) — sempre via conexão do tenant
// =====================================================================

export async function obterCredencial({ conexaoId, appType }) {
  if (!conexaoId) throw ApiError.internal("conexaoId ausente na consulta de credencial iFood.");
  return ok(await supabase.from(T.credenciais).select("*")
    .eq("conexao_id", conexaoId).eq("app_type", appType).maybeSingle());
}

export async function listarCredenciaisDaConexao({ conexaoId }) {
  if (!conexaoId) throw ApiError.internal("conexaoId ausente.");
  return ok(await supabase.from(T.credenciais)
    .select("app_type, expira_em, status, atualizado_em").eq("conexao_id", conexaoId)) ?? [];
}

/**
 * Upsert da credencial de um app (chave: conexao_id + app_type) — um único
 * statement (access + refresh + expira_em juntos). `refreshTokenCifrado`
 * undefined = o iFood não devolveu refresh novo: a coluna fica FORA do payload
 * e o refresh anterior é preservado (nunca sobrescrito por null).
 */
export async function salvarCredencial({
  conexaoId, appType, accessTokenCifrado, refreshTokenCifrado, expiraEm, tokenType,
}) {
  if (!conexaoId) throw ApiError.internal("conexaoId ausente ao salvar credencial iFood.");
  const linha = {
    conexao_id: conexaoId, app_type: appType,
    access_token_cifrado: accessTokenCifrado,
    expira_em: expiraEm, token_type: tokenType ?? null,
    status: "ativa",
  };
  if (refreshTokenCifrado !== undefined) linha.refresh_token_cifrado = refreshTokenCifrado;
  return ok(await supabase.from(T.credenciais).upsert(linha, { onConflict: "conexao_id,app_type" }).select().single());
}

/**
 * `seAccessCifradoIgual`: só atualiza se o access token gravado ainda for o que
 * quem chama leu (compare-and-set) — não sobrescreve uma renovação concorrente.
 */
export async function atualizarCredencial({ conexaoId, appType, campos, seAccessCifradoIgual }) {
  if (!conexaoId) throw ApiError.internal("conexaoId ausente ao atualizar credencial iFood.");
  let q = supabase.from(T.credenciais).update(campos)
    .eq("conexao_id", conexaoId).eq("app_type", appType);
  if (seAccessCifradoIgual !== undefined) q = q.eq("access_token_cifrado", seAccessCifradoIgual);
  return ok(await q.select().maybeSingle());
}

/** Descarta os tokens locais de uma conexão (desconexão). */
export async function apagarCredenciais({ conexaoId }) {
  if (!conexaoId) throw ApiError.internal("conexaoId ausente.");
  return ok(await supabase.from(T.credenciais).delete().eq("conexao_id", conexaoId).select("id"));
}
