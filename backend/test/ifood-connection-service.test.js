// Vínculo merchant -> unidade + status da integração iFood.
// Sem rede real, sem banco real. Exercita o caminho completo
// (vincularMerchant -> validarMerchant -> comAccessTokenValido) com fakes.
import test from "node:test";
import assert from "node:assert/strict";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-client-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-client-secret";

const conn = await import("../src/modules/ifood/ifoodConnection.service.js");
const { IFOOD_ERROS, ifoodErro } = await import("../src/modules/ifood/ifood.errors.js");
const { cifrar } = await import("../src/shared/cripto.js");

const TENANT = { organizacaoId: "org-1", unidadeId: "uni-1", usuarioId: "user-1" };
const MERCHANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const daquiA = (ms) => new Date(Date.now() + ms).toISOString();

function repoFalso({ conexao, outrasConexoesMerchant = [], credenciais = [], duplicidadeNaGravacao = false } = {}) {
  const estado = {
    conexao: conexao === undefined ? { id: "conx-1", organizacao_id: "org-1", unidade_id: "uni-1", status: "pendente", merchant_id: null } : conexao,
    credenciais: [...credenciais],
    definido: null,
  };
  return {
    estado,
    async obterConexaoViva() { return estado.conexao ? { ...estado.conexao } : null; },
    async conexaoVivaDoMerchant({ merchantId }) {
      return outrasConexoesMerchant.find((c) => c.merchant_id === merchantId && c.status !== "revogada") ?? null;
    },
    async definirMerchantDaConexao(args) {
      if (duplicidadeNaGravacao) throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_DUPLICADO);
      estado.definido = args;
      estado.conexao = {
        ...estado.conexao, merchant_id: args.merchantId, merchant_nome: args.nome,
        merchant_razao_social: args.razaoSocial, status: "ativa", conectada_em: daquiA(0),
      };
      return estado.conexao;
    },
    async listarCredenciaisDaConexao() { return estado.credenciais.map((c) => ({ ...c })); },
    async obterCredencial({ appType }) {
      const c = estado.credenciais.find((x) => x.app_type === appType);
      if (!c) return null;
      return {
        access_token_cifrado: cifrar(`AT-${appType}`),
        refresh_token_cifrado: cifrar(`RT-${appType}`),
        expira_em: c.expira_em ?? daquiA(60 * 60 * 1000),
        status: c.status ?? "ativa",
      };
    },
    async salvarCredencial() {},
    async atualizarCredencial() {},
    async apagarCredenciais() { estado.credenciaisApagadas = true; return []; },
    async cancelarSessoesPendentes() { estado.sessoesCanceladas = true; return []; },
    async atualizarConexao({ campos }) { estado.conexao = { ...estado.conexao, ...campos }; return estado.conexao; },
  };
}

// http falso: getJson = detalhe do merchant; postForm = refresh de token.
function httpFalso({ detalhe } = {}) {
  const chamadas = { get: [], post: [] };
  return {
    chamadas,
    async getJson(caminho, opts) {
      chamadas.get.push({ caminho, opts });
      if (typeof detalhe === "function") return detalhe(caminho);
      if (detalhe?.erro) throw detalhe.erro;
      return detalhe ?? { id: MERCHANT_ID, name: "Loja da API", corporateName: "Razao da API LTDA", type: "RESTAURANT", status: "AVAILABLE" };
    },
    async postForm() { chamadas.post.push({}); return { accessToken: "AT-novo", refreshToken: "RT-novo", expiresIn: 21600 }; },
  };
}

const credFinancial = { app_type: "financial", status: "ativa", expira_em: daquiA(60 * 60 * 1000) };
const credAnalytics = { app_type: "analytics", status: "ativa", expira_em: daquiA(60 * 60 * 1000) };

// =====================================================================
// vincularMerchant
// =====================================================================
test("merchant válido: revalida na API, grava nome/razão DA API e ativa a conexão", async () => {
  const repo = repoFalso({ credenciais: [credFinancial] });
  const http = httpFalso();
  const r = await conn.vincularMerchant({ ...TENANT, merchantId: MERCHANT_ID, deps: { repo, http } });

  assert.equal(repo.estado.definido.merchantId, MERCHANT_ID);
  assert.equal(repo.estado.definido.nome, "Loja da API");            // NÃO veio do frontend
  assert.equal(repo.estado.definido.razaoSocial, "Razao da API LTDA");
  assert.equal(r.conectado, true);
  assert.equal(r.status, "ativa");
  assert.equal(r.merchant.idMascarado, "550e****0000");
  assert.equal(r.merchant.nome, "Loja da API");
  assert.equal(r.apps.financial.conectado, true);
});

test("resposta do vínculo é sanitizada — sem token/secret/merchantId completo", async () => {
  const repo = repoFalso({ credenciais: [credFinancial, credAnalytics] });
  const r = await conn.vincularMerchant({ ...TENANT, merchantId: MERCHANT_ID, deps: { repo, http: httpFalso() } });
  const txt = JSON.stringify(r).toLowerCase();
  assert.equal(txt.includes("token"), false);
  assert.equal(txt.includes("secret"), false);
  assert.equal(txt.includes("cifrado"), false);
  assert.equal(txt.includes(MERCHANT_ID.toLowerCase()), false, "merchantId completo não pode aparecer");
});

test("merchant inexistente (404) -> IFOOD_MERCHANT_NAO_ENCONTRADO, nada gravado", async () => {
  const repo = repoFalso({ credenciais: [credFinancial] });
  const http = httpFalso({ detalhe: { erro: ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_NAO_ENCONTRADO) } });
  await assert.rejects(() => conn.vincularMerchant({ ...TENANT, merchantId: "sumiu", deps: { repo, http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_MERCHANT_NAO_ENCONTRADO);
  assert.equal(repo.estado.definido, null);
});

test("403 na revalidação -> IFOOD_MERCHANT_SEM_PERMISSAO, nada gravado", async () => {
  const repo = repoFalso({ credenciais: [credFinancial] });
  const http = httpFalso({ detalhe: { erro: ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO) } });
  await assert.rejects(() => conn.vincularMerchant({ ...TENANT, merchantId: MERCHANT_ID, deps: { repo, http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO);
  assert.equal(repo.estado.definido, null);
});

test("merchant já vinculado à MESMA unidade: idempotente (sem erro)", async () => {
  const repo = repoFalso({
    conexao: { id: "conx-1", organizacao_id: "org-1", unidade_id: "uni-1", status: "ativa", merchant_id: MERCHANT_ID },
    outrasConexoesMerchant: [{ id: "conx-1", unidade_id: "uni-1", status: "ativa", merchant_id: MERCHANT_ID }],
    credenciais: [credFinancial],
  });
  const r = await conn.vincularMerchant({ ...TENANT, merchantId: MERCHANT_ID, deps: { repo, http: httpFalso() } });
  assert.equal(r.conectado, true);
  assert.ok(repo.estado.definido, "re-grava (atualiza nome/razão)");
});

test("merchant já vinculado a OUTRA unidade -> IFOOD_VINCULO_DUPLICADO, nada gravado", async () => {
  const repo = repoFalso({
    outrasConexoesMerchant: [{ id: "conx-OUTRA", unidade_id: "uni-99", status: "ativa", merchant_id: MERCHANT_ID }],
    credenciais: [credFinancial],
  });
  await assert.rejects(() => conn.vincularMerchant({ ...TENANT, merchantId: MERCHANT_ID, deps: { repo, http: httpFalso() } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_VINCULO_DUPLICADO);
  assert.equal(repo.estado.definido, null);
});

test("unidade sem conexão -> IFOOD_CONEXAO_NAO_ENCONTRADA (antes de chamar a API)", async () => {
  const repo = repoFalso({ conexao: null, credenciais: [credFinancial] });
  const http = httpFalso();
  await assert.rejects(() => conn.vincularMerchant({ ...TENANT, merchantId: MERCHANT_ID, deps: { repo, http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA);
  assert.equal(http.chamadas.get.length, 0);
});

test("financial não autorizado -> IFOOD_CREDENCIAL_NAO_ENCONTRADA", async () => {
  const repo = repoFalso({ credenciais: [credAnalytics] }); // só analytics
  await assert.rejects(() => conn.vincularMerchant({ ...TENANT, merchantId: MERCHANT_ID, deps: { repo, http: httpFalso() } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_CREDENCIAL_NAO_ENCONTRADA);
});

test("financial em reauth_required -> IFOOD_REFRESH_FALHOU", async () => {
  const repo = repoFalso({ credenciais: [{ app_type: "financial", status: "reauth_required" }] });
  await assert.rejects(() => conn.vincularMerchant({ ...TENANT, merchantId: MERCHANT_ID, deps: { repo, http: httpFalso() } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_REFRESH_FALHOU);
});

test("reconexão após revogação local: conexão antiga revogada com o merchant NÃO bloqueia", async () => {
  const repo = repoFalso({
    conexao: { id: "conx-NOVA", organizacao_id: "org-1", unidade_id: "uni-1", status: "pendente", merchant_id: null },
    outrasConexoesMerchant: [{ id: "conx-VELHA", unidade_id: "uni-1", status: "revogada", merchant_id: MERCHANT_ID }],
    credenciais: [credFinancial],
  });
  const r = await conn.vincularMerchant({ ...TENANT, merchantId: MERCHANT_ID, deps: { repo, http: httpFalso() } });
  assert.equal(r.conectado, true);
  assert.equal(repo.estado.definido.conexaoId, "conx-NOVA");
});

test("concorrência: gravação bate no índice único (23505) -> IFOOD_VINCULO_DUPLICADO", async () => {
  const repo = repoFalso({ credenciais: [credFinancial], duplicidadeNaGravacao: true });
  await assert.rejects(() => conn.vincularMerchant({ ...TENANT, merchantId: MERCHANT_ID, deps: { repo, http: httpFalso() } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_VINCULO_DUPLICADO);
});

// =====================================================================
// obterStatus
// =====================================================================
test("status sem conexão: não conectado, ambos apps desligados", async () => {
  const r = await conn.obterStatus({ ...TENANT, deps: { repo: repoFalso({ conexao: null }) } });
  assert.deepEqual(r, {
    conectado: false, status: "nao_conectado", merchant: null,
    apps: { analytics: { conectado: false, status: null, expiraEm: null }, financial: { conectado: false, status: null, expiraEm: null } },
    order: null,                           // app Order tem bloco próprio (ifood-status-order.test.js)
    atencao: { total: 0, apps: [] },
    conectadaEm: null, ultimaSincronizacao: null, ultimoErro: null,
    homologacao: false,
  });
});

test("status: apenas analytics conectado (sem merchant, sem financial) -> conectado=false", async () => {
  const repo = repoFalso({
    conexao: { id: "c1", organizacao_id: "org-1", unidade_id: "uni-1", status: "pendente", merchant_id: null },
    credenciais: [credAnalytics],
  });
  const r = await conn.obterStatus({ ...TENANT, deps: { repo } });
  assert.equal(r.apps.analytics.conectado, true);
  assert.equal(r.apps.financial.conectado, false);
  assert.equal(r.conectado, false);
  assert.equal(r.merchant, null);
});

test("status: apenas financial + merchant -> conectado=true", async () => {
  const repo = repoFalso({
    conexao: { id: "c1", organizacao_id: "org-1", unidade_id: "uni-1", status: "ativa", merchant_id: MERCHANT_ID, merchant_nome: "Subway Saci", merchant_razao_social: "Saci LTDA", conectada_em: daquiA(0) },
    credenciais: [credFinancial],
  });
  const r = await conn.obterStatus({ ...TENANT, deps: { repo } });
  assert.equal(r.conectado, true);
  assert.equal(r.apps.financial.conectado, true);
  assert.equal(r.apps.analytics.conectado, false);
  assert.equal(r.merchant.idMascarado, "550e****0000");
  assert.equal(r.merchant.nome, "Subway Saci");
});

test("status: ambos conectados", async () => {
  const repo = repoFalso({
    conexao: { id: "c1", organizacao_id: "org-1", unidade_id: "uni-1", status: "ativa", merchant_id: MERCHANT_ID, merchant_nome: "Subway Saci" },
    credenciais: [credFinancial, credAnalytics],
  });
  const r = await conn.obterStatus({ ...TENANT, deps: { repo } });
  assert.equal(r.conectado, true);
  assert.equal(r.apps.analytics.conectado, true);
  assert.equal(r.apps.financial.conectado, true);
});

test("status: financial em reauth_required -> status geral 'reauth_required', conectado=false", async () => {
  const repo = repoFalso({
    conexao: { id: "c1", organizacao_id: "org-1", unidade_id: "uni-1", status: "ativa", merchant_id: MERCHANT_ID },
    credenciais: [{ app_type: "financial", status: "reauth_required", expira_em: daquiA(-1000) }],
  });
  const r = await conn.obterStatus({ ...TENANT, deps: { repo } });
  assert.equal(r.status, "reauth_required");
  assert.equal(r.apps.financial.conectado, false);
  assert.equal(r.apps.financial.status, "reauth_required");
  assert.equal(r.conectado, false);
});

// =====================================================================
// desconectar (local)
// =====================================================================
test("desconectar: apaga tokens, cancela sessões e marca conexão 'revogada'", async () => {
  const repo = repoFalso({
    conexao: { id: "c1", organizacao_id: "org-1", unidade_id: "uni-1", status: "ativa", merchant_id: MERCHANT_ID },
    credenciais: [credFinancial, credAnalytics],
  });
  const r = await conn.desconectar({ ...TENANT, deps: { repo } });
  assert.equal(r.ok, true);
  assert.equal(r.jaDesconectado, false);
  assert.equal(r.revogacaoNoIfood, "manual_no_portal");
  assert.equal(repo.estado.credenciaisApagadas, true);
  assert.equal(repo.estado.sessoesCanceladas, true);
  assert.equal(repo.estado.conexao.status, "revogada");
});

test("desconectar sem conexão viva: idempotente (jaDesconectado=true, sem erro)", async () => {
  const repo = repoFalso({ conexao: null });
  const r = await conn.desconectar({ ...TENANT, deps: { repo } });
  assert.deepEqual(r, { ok: true, jaDesconectado: true, revogacaoNoIfood: "manual_no_portal" });
});

test("após desconectar, obterStatus volta a 'nao_conectado'", async () => {
  const repo = repoFalso({
    conexao: { id: "c1", organizacao_id: "org-1", unidade_id: "uni-1", status: "ativa", merchant_id: MERCHANT_ID },
    credenciais: [credFinancial],
  });
  await conn.desconectar({ ...TENANT, deps: { repo } });
  // obterConexaoViva do fake ainda devolve a linha (agora status 'revogada');
  // o service real filtra no banco (neq status revogada). Simulamos isso:
  repo.obterConexaoViva = async () => (repo.estado.conexao.status === "revogada" ? null : repo.estado.conexao);
  const s = await conn.obterStatus({ ...TENANT, deps: { repo } });
  assert.equal(s.status, "nao_conectado");
  assert.equal(s.conectado, false);
  assert.equal(s.merchant, null);
});

test("status nunca vaza token/secret", async () => {
  const repo = repoFalso({
    conexao: { id: "c1", organizacao_id: "org-1", unidade_id: "uni-1", status: "ativa", merchant_id: MERCHANT_ID, merchant_nome: "X" },
    credenciais: [credFinancial],
  });
  const r = await conn.obterStatus({ ...TENANT, deps: { repo } });
  const txt = JSON.stringify(r).toLowerCase();
  assert.equal(txt.includes("token"), false);
  assert.equal(txt.includes("secret"), false);
  assert.equal(txt.includes(MERCHANT_ID.toLowerCase()), false);
});
