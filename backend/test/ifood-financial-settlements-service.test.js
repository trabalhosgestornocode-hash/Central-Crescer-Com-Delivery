// ifoodFinancial.service.js#listarSettlements. Sem rede real, sem banco
// real. Exercita o token service REAL (comAccessTokenValido) com http/repo
// falsos — mesmo padrão dos testes de Sales/Financial Events.
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

const RESP = {
  beginDate: "2024-01-01", endDate: "2024-01-31", balance: 100, merchantId: MERCHANT_ID,
  settlements: [{ id: "t1", type: "REPASSE", amount: 100, status: "SUCCEED", accountDetails: {}, paymentDate: "2024-01-05" }],
  consolidatedMerchants: [],
};
const RESP_VAZIA = { beginDate: "2024-01-01", endDate: "2024-01-31", balance: 0, merchantId: MERCHANT_ID, settlements: [], consolidatedMerchants: [] };

// =====================================================================
// happy path
// =====================================================================
test("resposta válida: normaliza e devolve títulos + saldo", async () => {
  const http = httpFalso({ get: () => RESP });
  const r = await financial.listarSettlements({ ...TENANT, inicio: "2024-01-01", fim: "2024-01-31", deps: { repo: repoFalso(), http } });
  assert.equal(r.titulos.length, 1);
  assert.equal(r.saldo, 100);
});

test("0 resultados: devolve titulos:[] sem lançar", async () => {
  const http = httpFalso({ get: () => RESP_VAZIA });
  const r = await financial.listarSettlements({ ...TENANT, inicio: "2024-01-01", fim: "2024-01-31", deps: { repo: repoFalso(), http } });
  assert.deepEqual(r.titulos, []);
});

test("modo padrão ('calculo') usa beginCalculationDate/endCalculationDate", async () => {
  const http = httpFalso({ get: () => RESP });
  await financial.listarSettlements({ ...TENANT, inicio: "2024-01-01", fim: "2024-01-31", deps: { repo: repoFalso(), http } });
  const { caminho, opts } = http.chamadas.get[0];
  assert.equal(caminho, `/financial/v3.0/merchants/${MERCHANT_ID}/settlements?beginCalculationDate=2024-01-01&endCalculationDate=2024-01-31`);
  assert.equal(opts.homologacao, true);
  assert.equal(opts.contexto, "financial");
});

test("modo 'pagamento' usa beginPaymentDate/endPaymentDate (par mutuamente exclusivo)", async () => {
  const http = httpFalso({ get: () => RESP });
  await financial.listarSettlements({ ...TENANT, modo: "pagamento", inicio: "2024-01-01", fim: "2024-01-31", deps: { repo: repoFalso(), http } });
  const { caminho } = http.chamadas.get[0];
  assert.equal(caminho, `/financial/v3.0/merchants/${MERCHANT_ID}/settlements?beginPaymentDate=2024-01-01&endPaymentDate=2024-01-31`);
  assert.doesNotMatch(caminho, /CalculationDate/);
});

test("modo inválido cai no padrão 'calculo', sem lançar", async () => {
  const http = httpFalso({ get: () => RESP });
  await financial.listarSettlements({ ...TENANT, modo: "algo-invalido", inicio: "2024-01-01", fim: "2024-01-31", deps: { repo: repoFalso(), http } });
  assert.match(http.chamadas.get[0].caminho, /beginCalculationDate/);
});

test("nunca envia page/size — a API Settlements não pagina", async () => {
  const http = httpFalso({ get: () => RESP });
  await financial.listarSettlements({ ...TENANT, inicio: "2024-01-01", fim: "2024-01-31", deps: { repo: repoFalso(), http } });
  assert.doesNotMatch(http.chamadas.get[0].caminho, /page=|size=/);
});

// =====================================================================
// período inválido — inicio/fim são SEMPRE obrigatórios aqui (sem default)
// =====================================================================
test("sem inicio/fim -> IFOOD_FINANCIAL_PERIODO_INVALIDO, sem chamar a API", async () => {
  const http = httpFalso({ get: () => RESP });
  await assert.rejects(
    () => financial.listarSettlements({ ...TENANT, deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_FINANCIAL_PERIODO_INVALIDO,
  );
  assert.equal(http.chamadas.get.length, 0);
});

test("formato de data inválido -> IFOOD_FINANCIAL_PERIODO_INVALIDO", async () => {
  const http = httpFalso({ get: () => RESP });
  await assert.rejects(
    () => financial.listarSettlements({ ...TENANT, inicio: "01/01/2024", fim: "2024-01-31", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_FINANCIAL_PERIODO_INVALIDO,
  );
});

test("fim < início -> IFOOD_FINANCIAL_PERIODO_INVALIDO", async () => {
  const http = httpFalso({ get: () => RESP });
  await assert.rejects(
    () => financial.listarSettlements({ ...TENANT, inicio: "2024-02-01", fim: "2024-01-01", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_FINANCIAL_PERIODO_INVALIDO,
  );
});

test("período longo (>90 dias) NÃO é bloqueado — sem teto documentado nesta API", async () => {
  const http = httpFalso({ get: () => RESP });
  const r = await financial.listarSettlements({ ...TENANT, inicio: "2024-01-01", fim: "2024-12-31", deps: { repo: repoFalso(), http } });
  assert.ok(r);
});

// =====================================================================
// merchant / conexão (reaproveita as mesmas regras de Sales/Events)
// =====================================================================
test("sem conexão viva -> IFOOD_CONEXAO_NAO_ENCONTRADA", async () => {
  const http = httpFalso({ get: () => RESP });
  await assert.rejects(
    () => financial.listarSettlements({ ...TENANT, inicio: "2024-01-01", fim: "2024-01-31", deps: { repo: repoFalso({ conexao: null }), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA,
  );
});

test("conexão sem merchant vinculado -> IFOOD_FINANCIAL_SEM_MERCHANT", async () => {
  const http = httpFalso({ get: () => RESP });
  const repo = repoFalso({ conexao: { id: "conx-1", status: "ativa", merchant_id: null } });
  await assert.rejects(
    () => financial.listarSettlements({ ...TENANT, inicio: "2024-01-01", fim: "2024-01-31", deps: { repo, http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_FINANCIAL_SEM_MERCHANT,
  );
});

// =====================================================================
// 401 / refresh, 403, 429, 5xx
// =====================================================================
test("401: 1 refresh + 1 repetição, depois sucesso", async () => {
  let chamada = 0;
  const http = httpFalso({
    get: () => { chamada += 1; if (chamada === 1) throw ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO); return RESP; },
  });
  const r = await financial.listarSettlements({ ...TENANT, inicio: "2024-01-01", fim: "2024-01-31", deps: { repo: repoFalso(), http } });
  assert.equal(r.titulos.length, 1);
  assert.equal(http.chamadas.post.length, 1);
});

test("403 -> IFOOD_MERCHANT_SEM_PERMISSAO propagado", async () => {
  const http = httpFalso({ get: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO); } });
  await assert.rejects(
    () => financial.listarSettlements({ ...TENANT, inicio: "2024-01-01", fim: "2024-01-31", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO,
  );
});

test("429 -> IFOOD_RATE_LIMITED propagado", async () => {
  const http = httpFalso({ get: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_RATE_LIMITED); } });
  await assert.rejects(
    () => financial.listarSettlements({ ...TENANT, inicio: "2024-01-01", fim: "2024-01-31", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_RATE_LIMITED,
  );
});

test("5xx -> IFOOD_INDISPONIVEL propagado", async () => {
  const http = httpFalso({ get: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL); } });
  await assert.rejects(
    () => financial.listarSettlements({ ...TENANT, inicio: "2024-01-01", fim: "2024-01-31", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_INDISPONIVEL,
  );
});

// =====================================================================
// segurança
// =====================================================================
test("header de homologação (homologacao:true) é sempre passado ao http client nesta fase", async () => {
  const http = httpFalso({ get: () => RESP });
  await financial.listarSettlements({ ...TENANT, inicio: "2024-01-01", fim: "2024-01-31", deps: { repo: repoFalso(), http } });
  assert.equal(http.chamadas.get[0].opts.homologacao, true);
});

test("resposta normalizada nunca contém token/secret/authorization", async () => {
  const http = httpFalso({ get: () => RESP });
  const r = await financial.listarSettlements({ ...TENANT, inicio: "2024-01-01", fim: "2024-01-31", deps: { repo: repoFalso(), http } });
  const txt = JSON.stringify(r).toLowerCase();
  for (const vazamento of ["accesstoken", "refreshtoken", "authorization", "clientsecret", "at-atual", "rt-atual"]) {
    assert.ok(!txt.includes(vazamento), `vazou: ${vazamento}`);
  }
});
