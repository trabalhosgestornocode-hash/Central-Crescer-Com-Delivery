// Trava do ambiente de HOMOLOGAÇÃO iFood (sandbox).
//
// POR QUE EXISTE
//   `node --env-file=A --env-file=B` NÃO isola: o último arquivo vence por
//   chave, mas chaves que só existem no primeiro sobrevivem (mistura parcial),
//   e variáveis já exportadas no shell vencem os dois arquivos. Subir a
//   integração iFood em modo homologação (que grava conexões/credenciais no
//   banco) com UMA chave Supabase de produção seria um incidente.
//
// COMO PROVA QUE AS CHAVES SÃO DO PROJETO DE TESTE (sem depender do nome do arquivo)
//   1. SUPABASE_URL: o host tem que ser o projeto de teste (e nunca o de produção).
//   2. Chave em formato JWT (legado): o claim `ref` tem que ser o projeto de teste.
//   3. Chave em formato novo (`sb_publishable_…` / `sb_secret_…`, sem `ref`
//      embutido): PROVA ATIVA — um GET somente-leitura ao SUPABASE_URL de teste.
//      Uma chave de outro projeto (produção) é rejeitada pelo Supabase (401/403),
//      então HTTP 200 comprova que a chave pertence ao projeto de teste.
//   Nunca devolve nem loga valores secretos — só nomes de variáveis e o `ref`
//   (identificador público).

// Fonte única dos refs (src/modules/ifood/ifood.ambienteTeste.js) — re-exportados aqui.
import { PROJETO_TESTE_REF, PROJETO_PRODUCAO_REF, centralizadoTestePermitido } from "../src/modules/ifood/ifood.ambienteTeste.js";
export { PROJETO_TESTE_REF, PROJETO_PRODUCAO_REF };

/** `ref` do payload de um JWT do Supabase (anon/service_role legados), ou null. */
export function refDoJwt(jwt) {
  try {
    const partes = String(jwt ?? "").trim().split(".");
    if (partes.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(partes[1], "base64url").toString("utf8"));
    return typeof payload.ref === "string" ? payload.ref : null;
  } catch {
    return null;
  }
}

/** Chave no formato novo do Supabase (não carrega `ref`; exige prova ativa). */
export function ehChaveFormatoNovo(chave) {
  return /^sb_(publishable|secret)_/.test(String(chave ?? "").trim());
}

/** Host de uma URL, ou null. */
function hostDe(url) {
  try { return new URL(String(url ?? "").trim()).host; } catch { return null; }
}

/**
 * Parte comum aos dois modos de teste: TODAS as credenciais Supabase têm que
 * ser do projeto de TESTE (estático; chaves no formato novo pedem prova ativa).
 */
function validarSupabaseDeTeste(env) {
  const erros = [];
  const provaAtivaNecessaria = [];

  // 1) SUPABASE_URL
  const host = hostDe(env.SUPABASE_URL);
  const refUrl = host?.endsWith(".supabase.co") ? host.slice(0, -".supabase.co".length) : null;
  if (!env.SUPABASE_URL) erros.push("SUPABASE_URL ausente.");
  else if (refUrl === PROJETO_PRODUCAO_REF) erros.push("SUPABASE_URL aponta para o projeto de PRODUÇÃO.");
  else if (refUrl !== PROJETO_TESTE_REF) erros.push(`SUPABASE_URL não é o projeto de teste esperado (ref lido: ${refUrl ?? "inválido"}).`);

  // 2) Chaves
  const refs = {};
  for (const nome of ["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
    const valor = env[nome];
    if (!valor) { erros.push(`${nome} ausente.`); continue; }
    const ref = refDoJwt(valor);
    refs[nome] = ref;
    if (ref) {
      if (ref === PROJETO_PRODUCAO_REF) erros.push(`${nome} pertence ao projeto de PRODUÇÃO.`);
      else if (ref !== PROJETO_TESTE_REF) erros.push(`${nome} não comprova o projeto de teste (ref lido: ${ref}).`);
    } else if (ehChaveFormatoNovo(valor)) {
      provaAtivaNecessaria.push(nome);
    } else {
      erros.push(`${nome} em formato desconhecido — não é possível comprovar o projeto.`);
    }
  }
  return { erros, provaAtivaNecessaria, resumo: { supabaseRef: refUrl, jwtRefs: refs } };
}

/**
 * Validação ESTÁTICA (sem rede) do modo HOMOLOGAÇÃO (Teste (D), distribuído).
 * @param {Record<string, string|undefined>} env normalmente `process.env`
 * @returns {{ok: boolean, erros: string[], provaAtivaNecessaria: string[], resumo: object}}
 */
export function validarAmbienteHomologIfood(env) {
  const { erros, provaAtivaNecessaria, resumo } = validarSupabaseDeTeste(env);

  // 3) Modo de homologação + app de teste + cifra de tokens
  if (env.IFOOD_HOMOLOGATION_MODE !== "true") erros.push("IFOOD_HOMOLOGATION_MODE precisa ser exatamente 'true'.");
  if (!env.IFOOD_TEST_CLIENT_ID) erros.push("IFOOD_TEST_CLIENT_ID ausente.");
  if (!env.IFOOD_TEST_CLIENT_SECRET) erros.push("IFOOD_TEST_CLIENT_SECRET ausente.");
  if (!env.IFOOD_TOKEN_SECRET || env.IFOOD_TOKEN_SECRET.length < 16) erros.push("IFOOD_TOKEN_SECRET ausente ou com menos de 16 caracteres.");

  // 4) Base URL do iFood: só o padrão (ou vazio); um valor estranho poderia
  //    enviar credenciais para outro host.
  if (env.IFOOD_API_BASE_URL && hostDe(env.IFOOD_API_BASE_URL) !== "merchant-api.ifood.com.br") {
    erros.push("IFOOD_API_BASE_URL diferente de merchant-api.ifood.com.br.");
  }

  return { ok: erros.length === 0, erros, provaAtivaNecessaria, resumo };
}

/**
 * Validação ESTÁTICA (sem rede) do modo CENTRALIZED_TEST (Teste (C), centralizado,
 * TEMPORÁRIO). Mais estrita que a homologação: além do Supabase de teste, exige
 * fora do Render/produção e SEM credenciais dos apps reais no ambiente (sinal de
 * que um .env de produção vazou para o processo). Não exige IFOOD_TOKEN_SECRET:
 * o token centralizado nunca é persistido.
 * @param {Record<string, string|undefined>} env
 */
export function validarAmbienteCentralizadoTesteIfood(env) {
  const { erros, provaAtivaNecessaria, resumo } = validarSupabaseDeTeste(env);

  if (env.IFOOD_CENTRALIZED_TEST_MODE !== "true") erros.push("IFOOD_CENTRALIZED_TEST_MODE precisa ser exatamente 'true'.");
  if (!env.IFOOD_CENTRALIZED_TEST_CLIENT_ID) erros.push("IFOOD_CENTRALIZED_TEST_CLIENT_ID ausente.");
  if (!env.IFOOD_CENTRALIZED_TEST_CLIENT_SECRET) erros.push("IFOOD_CENTRALIZED_TEST_CLIENT_SECRET ausente.");

  // Modos mutuamente exclusivos: não misturar semântica do Teste (C) com a do Teste (D).
  if (env.IFOOD_HOMOLOGATION_MODE === "true") erros.push("IFOOD_HOMOLOGATION_MODE=true (Teste (D), distribuído) não pode ser combinado com o modo centralizado de teste.");

  // Sinais de ambiente de produção / apps reais.
  const permitido = centralizadoTestePermitido({ ...env, SUPABASE_URL: `https://${PROJETO_TESTE_REF}.supabase.co` });
  for (const m of permitido.motivos) erros.push(`Ambiente não permitido para o modo centralizado de teste: ${m}.`);
  for (const nome of ["IFOOD_ANALYTICS_CLIENT_ID", "IFOOD_ANALYTICS_CLIENT_SECRET", "IFOOD_FINANCIAL_CLIENT_ID", "IFOOD_FINANCIAL_CLIENT_SECRET"]) {
    if (env[nome]) erros.push(`${nome} presente: credencial de app REAL no ambiente de teste (.env de produção carregado?).`);
  }

  if (env.IFOOD_API_BASE_URL && hostDe(env.IFOOD_API_BASE_URL) !== "merchant-api.ifood.com.br") {
    erros.push("IFOOD_API_BASE_URL diferente de merchant-api.ifood.com.br.");
  }

  return { ok: erros.length === 0, erros, provaAtivaNecessaria, resumo };
}

/**
 * PROVA ATIVA, somente leitura: cada chave em formato novo tem que ser aceita
 * pelo SUPABASE_URL de TESTE. GET sem corpo, nada é gravado.
 *   anon    -> GET /auth/v1/settings   (200 só com chave do projeto)
 *   service -> GET /rest/v1/           (200 só com chave do projeto)
 * Qualquer resposta que não seja 200 (ou erro de rede) REPROVA.
 * @param {Record<string,string|undefined>} env
 * @param {string[]} nomes chaves que exigem prova (de validarAmbienteHomologIfood)
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string[]>} lista de erros (vazia = comprovado)
 */
export async function provarChavesNoProjetoTeste(env, nomes, fetchImpl = globalThis.fetch) {
  const erros = [];
  const base = String(env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const sondas = {
    SUPABASE_ANON_KEY: `${base}/auth/v1/settings`,
    SUPABASE_SERVICE_ROLE_KEY: `${base}/rest/v1/`,
  };
  for (const nome of nomes) {
    try {
      const resp = await fetchImpl(sondas[nome], {
        method: "GET",
        headers: { apikey: env[nome] },
        signal: AbortSignal.timeout(8000),
      });
      if (resp.status !== 200) erros.push(`${nome} foi REJEITADA pelo projeto de teste (HTTP ${resp.status}) — provavelmente é de outro projeto.`);
    } catch (e) {
      erros.push(`${nome}: não foi possível comprovar o projeto (${e?.name ?? "erro de rede"}).`);
    }
  }
  return erros;
}
