// ifoodFinancial.service.js — API Sales. Sem rede real, sem banco real.
// Exercita o token service REAL (comAccessTokenValido) com http/repo falsos
// — mesmo padrão de ifood-merchant-service.test.js.
import test from "node:test";
import assert from "node:assert/strict";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-client-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-client-secret";

const financial = await import("../src/modules/ifood/ifoodFinancial.service.js");
const { IFOOD_ERROS, ifoodErro } = await import("../src/modules/ifood/ifood.errors.js");
const { cifrar } = await import("../src/shared/cripto.js");

const TENANT = { organizacaoId: "org-1", unidadeId: "uni-1" };
const MERCHANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const daquiA = (ms) => new Date(Date.now() + ms).toISOString();

function repoFalso(opts = {}) {
  const estado = {
    conexao: "conexao" in opts ? opts.conexao : { id: "conx-1", status: "ativa", merchant_id: MERCHANT_ID },
    cred: "cred" in opts ? opts.cred
      : { access_token_cifrado: cifrar("AT-atual"), refresh_token_cifrado: cifrar("RT-atual"), expira_em: daquiA(60 * 60 * 1000), status: "ativa" },
  };
  return {
    estado,
    async obterConexaoViva() { return estado.conexao; },
    async obterCredencial() { return estado.cred ? { ...estado.cred } : null; },
    async salvarCredencial(a) {
      estado.cred = { access_token_cifrado: a.accessTokenCifrado, refresh_token_cifrado: a.refreshTokenCifrado ?? estado.cred?.refresh_token_cifrado, expira_em: a.expiraEm, status: "ativa" };
      return estado.cred;
    },
    async atualizarCredencial({ campos }) { estado.cred = { ...estado.cred, ...campos }; return estado.cred; },
  };
}

function httpFalso({ get, post } = {}) {
  const chamadas = { get: [], post: [] };
  return {
    chamadas,
    async getJson(caminho, opts) { chamadas.get.push({ caminho, opts }); return get(caminho, opts, chamadas.get.length); },
    async postForm(caminho, campos) {
      chamadas.post.push({ caminho, campos });
      return post ? post(caminho, campos) : { accessToken: "AT-renovado", refreshToken: "RT-renovado", expiresIn: 21600 };
    },
  };
}

const RESP_1_VENDA = {
  page: 1, size: 1, beginSalesDate: "2025-01-01", endSalesDate: "2025-01-05",
  sales: [{ id: "s1", shortId: "1", createdAt: "2025-01-02T10:00:00Z", currentStatus: "CONCLUDED", merchant: { id: MERCHANT_ID }, saleGrossValue: { bag: 50 } }],
  total: 1, pageCount: 1,
};
const RESP_VAZIA = { page: 1, size: 0, beginSalesDate: "2025-01-01", endSalesDate: "2025-01-05", sales: [], total: 0, pageCount: 0 };

// =====================================================================
// happy path
// =====================================================================
test("resposta válida: normaliza e devolve vendas + paginação", async () => {
  const http = httpFalso({ get: () => RESP_1_VENDA });
  const r = await financial.listarSales({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso(), http } });
  assert.equal(r.vendas.length, 1);
  assert.equal(r.vendas[0].id, "s1");
  assert.equal(r.pagina.total, 1);
  assert.equal(http.chamadas.get.length, 1);
});

test("0 resultados: devolve vendas:[] sem lançar", async () => {
  const http = httpFalso({ get: () => RESP_VAZIA });
  const r = await financial.listarSales({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso(), http } });
  assert.deepEqual(r.vendas, []);
  assert.equal(r.pagina.total, 0);
});

test("caminho chamado: merchantId da CONEXÃO, page 1-indexed por padrão, beginSalesDate/endSalesDate corretos", async () => {
  const http = httpFalso({ get: () => RESP_1_VENDA });
  await financial.listarSales({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso(), http } });
  const { caminho, opts } = http.chamadas.get[0];
  assert.equal(caminho, `/financial/v3.0/merchants/${MERCHANT_ID}/sales?beginSalesDate=2025-01-01&endSalesDate=2025-01-05&page=1`);
  assert.equal(opts.homologacao, false); // unidade fora da allowlist de homologação: dado real
  assert.equal(opts.contexto, "financial");
});

test("paginação: page=2 explícito é repassado", async () => {
  const http = httpFalso({ get: () => ({ ...RESP_1_VENDA, page: 2 }) });
  await financial.listarSales({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", page: 2, deps: { repo: repoFalso(), http } });
  assert.match(http.chamadas.get[0].caminho, /page=2$/);
});

test("paginação: page inválido (0, negativo, não-inteiro) cai no padrão seguro 1", async () => {
  for (const bruto of [0, -1, "abc", 1.5]) {
    const http = httpFalso({ get: () => RESP_1_VENDA });
    await financial.listarSales({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", page: bruto, deps: { repo: repoFalso(), http } });
    assert.match(http.chamadas.get[0].caminho, /page=1$/, `page=${bruto} deveria cair para 1`);
  }
});

// =====================================================================
// período inválido
// =====================================================================
test("período inválido: formato errado -> IFOOD_FINANCIAL_PERIODO_INVALIDO, sem chamar a API", async () => {
  const http = httpFalso({ get: () => RESP_1_VENDA });
  await assert.rejects(
    () => financial.listarSales({ ...TENANT, inicio: "01/01/2025", fim: "2025-01-05", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_FINANCIAL_PERIODO_INVALIDO,
  );
  assert.equal(http.chamadas.get.length, 0);
});

test("período inválido: fim < início -> IFOOD_FINANCIAL_PERIODO_INVALIDO", async () => {
  const http = httpFalso({ get: () => RESP_1_VENDA });
  await assert.rejects(
    () => financial.listarSales({ ...TENANT, inicio: "2025-01-10", fim: "2025-01-05", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_FINANCIAL_PERIODO_INVALIDO,
  );
});

test("período inválido: mais de 90 dias -> IFOOD_FINANCIAL_PERIODO_INVALIDO (teto da API Sales)", async () => {
  const http = httpFalso({ get: () => RESP_1_VENDA });
  await assert.rejects(
    () => financial.listarSales({ ...TENANT, inicio: "2025-01-01", fim: "2025-05-01", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_FINANCIAL_PERIODO_INVALIDO,
  );
});

test("período válido: exatamente 90 dias passa (limite inclusivo)", async () => {
  const http = httpFalso({ get: () => RESP_1_VENDA });
  const r = await financial.listarSales({ ...TENANT, inicio: "2025-01-01", fim: "2025-03-31", deps: { repo: repoFalso(), http } });
  assert.ok(r);
});

// =====================================================================
// merchant / conexão
// =====================================================================
test("sem conexão viva -> IFOOD_CONEXAO_NAO_ENCONTRADA", async () => {
  const http = httpFalso({ get: () => RESP_1_VENDA });
  await assert.rejects(
    () => financial.listarSales({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso({ conexao: null }), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA,
  );
});

test("conexão sem merchant vinculado -> IFOOD_FINANCIAL_SEM_MERCHANT, sem chamar a API", async () => {
  const http = httpFalso({ get: () => RESP_1_VENDA });
  const repo = repoFalso({ conexao: { id: "conx-1", status: "ativa", merchant_id: null } });
  await assert.rejects(
    () => financial.listarSales({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo, http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_FINANCIAL_SEM_MERCHANT,
  );
  assert.equal(http.chamadas.get.length, 0);
});

// =====================================================================
// 401 / refresh, 403, 429, 5xx
// =====================================================================
test("401: 1 refresh + 1 repetição, depois sucesso", async () => {
  let chamada = 0;
  const http = httpFalso({
    get: () => { chamada += 1; if (chamada === 1) throw ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO); return RESP_1_VENDA; },
  });
  const r = await financial.listarSales({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso(), http } });
  assert.equal(r.vendas.length, 1);
  assert.equal(http.chamadas.post.length, 1); // 1 renovação
});

test("401 persistente: propaga IFOOD_TOKEN_EXPIRADO sem loop", async () => {
  const http = httpFalso({ get: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO); } });
  await assert.rejects(
    () => financial.listarSales({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO,
  );
  assert.equal(http.chamadas.post.length, 1);
});

test("403 -> IFOOD_MERCHANT_SEM_PERMISSAO propagado (mensagem financial-específica é responsabilidade do http client real)", async () => {
  const http = httpFalso({ get: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO); } });
  await assert.rejects(
    () => financial.listarSales({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO,
  );
});

test("429 -> IFOOD_RATE_LIMITED propagado", async () => {
  const http = httpFalso({ get: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_RATE_LIMITED); } });
  await assert.rejects(
    () => financial.listarSales({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_RATE_LIMITED,
  );
});

test("5xx -> IFOOD_INDISPONIVEL propagado", async () => {
  const http = httpFalso({ get: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL); } });
  await assert.rejects(
    () => financial.listarSales({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_INDISPONIVEL,
  );
});

// =====================================================================
// segurança
// =====================================================================
test("listarSales não aceita merchantId como parâmetro — usa SEMPRE o da conexão", async () => {
  const http = httpFalso({ get: () => RESP_1_VENDA });
  // Mesmo passando um merchantId "malicioso" nos argumentos, a assinatura da
  // função nem tem esse parâmetro — ele é ignorado, o da conexão prevalece.
  await financial.listarSales({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", merchantId: "outro-merchant-injetado", deps: { repo: repoFalso(), http } });
  assert.match(http.chamadas.get[0].caminho, new RegExp(`/merchants/${MERCHANT_ID}/sales`));
  assert.doesNotMatch(http.chamadas.get[0].caminho, /outro-merchant-injetado/);
});

test("header de homologação decidido pela UNIDADE: fora da allowlist sem header; na allowlist com header", async () => {
  const http = httpFalso({ get: () => RESP_1_VENDA });
  await financial.listarSales({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso(), http } });
  await financial.listarSales({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { homologacaoFinancial: (u) => u === TENANT.unidadeId, repo: repoFalso(), http } });
  assert.equal(http.chamadas.get[0].opts.homologacao, false, "unidade fora da allowlist: dado real");
  assert.equal(http.chamadas.get[1].opts.homologacao, true, "unidade na allowlist: ambiente de homologação");
});

test("resposta normalizada nunca contém token/secret/authorization", async () => {
  const http = httpFalso({ get: () => RESP_1_VENDA });
  const r = await financial.listarSales({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso(), http } });
  const txt = JSON.stringify(r).toLowerCase();
  for (const vazamento of ["accesstoken", "refreshtoken", "authorization", "clientsecret", "at-atual", "rt-atual"]) {
    assert.ok(!txt.includes(vazamento), `vazou: ${vazamento}`);
  }
});
