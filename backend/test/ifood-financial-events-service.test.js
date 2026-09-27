// ifoodFinancial.service.js#listarFinancialEvents. Sem rede real, sem banco
// real. Exercita o token service REAL (comAccessTokenValido) com http/repo
// falsos — mesmo padrão de ifood-financial-service.test.js (Sales).
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

const EVENTO = {
  name: "ORDER_COMMISSION", description: "FULLSERVICE_COMMISSION", dateTime: "2025-01-02T07:00:00Z",
  hasTransferImpact: true, amount: { value: "-4.8" },
};
const RESP_2_EVENTOS = { page: 1, size: 100, hasNextPage: false, financialEvents: [EVENTO, { ...EVENTO, hasTransferImpact: false, amount: { value: "10" } }] };
const RESP_VAZIA = { page: 1, size: 100, hasNextPage: false, financialEvents: [] };

// =====================================================================
// happy path
// =====================================================================
test("resposta válida: normaliza e devolve eventos + paginação", async () => {
  const http = httpFalso({ get: () => RESP_2_EVENTOS });
  const r = await financial.listarFinancialEvents({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso(), http } });
  assert.equal(r.eventos.length, 2);
  assert.equal(r.pagina.temProximaPagina, false);
});

test("0 resultados: devolve eventos:[] sem lançar", async () => {
  const http = httpFalso({ get: () => RESP_VAZIA });
  const r = await financial.listarFinancialEvents({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso(), http } });
  assert.deepEqual(r.eventos, []);
});

test("inicio/fim ausentes: usa HOJE (1 dia), sem lançar", async () => {
  const http = httpFalso({ get: () => RESP_VAZIA });
  const hoje = new Date().toISOString().slice(0, 10);
  const r = await financial.listarFinancialEvents({ ...TENANT, deps: { repo: repoFalso(), http } });
  assert.equal(r.periodo.inicio, hoje);
  assert.equal(r.periodo.fim, hoje);
  assert.match(http.chamadas.get[0].caminho, new RegExp(`beginDate=${hoje}&endDate=${hoje}`));
});

test("caminho chamado: merchantId da conexão, page 1-indexed, size padrão 100", async () => {
  const http = httpFalso({ get: () => RESP_2_EVENTOS });
  await financial.listarFinancialEvents({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso(), http } });
  const { caminho, opts } = http.chamadas.get[0];
  assert.equal(caminho, `/financial/v3.0/merchants/${MERCHANT_ID}/financial-events?beginDate=2025-01-01&endDate=2025-01-05&page=1&size=100`);
  assert.equal(opts.homologacao, true);
  assert.equal(opts.contexto, "financial");
});

test("size explícito é repassado", async () => {
  const http = httpFalso({ get: () => RESP_2_EVENTOS });
  await financial.listarFinancialEvents({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", size: 50, deps: { repo: repoFalso(), http } });
  assert.match(http.chamadas.get[0].caminho, /size=50$/);
});

// =====================================================================
// período inválido
// =====================================================================
test("só uma das datas informada -> IFOOD_FINANCIAL_PERIODO_INVALIDO (evita faixa ambígua)", async () => {
  const http = httpFalso({ get: () => RESP_2_EVENTOS });
  await assert.rejects(
    () => financial.listarFinancialEvents({ ...TENANT, inicio: "2025-01-01", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_FINANCIAL_PERIODO_INVALIDO,
  );
  assert.equal(http.chamadas.get.length, 0);
});

test("mais de 33 dias -> IFOOD_FINANCIAL_PERIODO_INVALIDO (teto da API Financial Events)", async () => {
  const http = httpFalso({ get: () => RESP_2_EVENTOS });
  await assert.rejects(
    () => financial.listarFinancialEvents({ ...TENANT, inicio: "2025-01-01", fim: "2025-02-15", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_FINANCIAL_PERIODO_INVALIDO,
  );
});

test("exatamente 33 dias passa (limite inclusivo)", async () => {
  const http = httpFalso({ get: () => RESP_2_EVENTOS });
  const r = await financial.listarFinancialEvents({ ...TENANT, inicio: "2025-01-01", fim: "2025-02-02", deps: { repo: repoFalso(), http } });
  assert.ok(r);
});

// =====================================================================
// merchant / conexão (reaproveita as mesmas regras de Sales)
// =====================================================================
test("sem conexão viva -> IFOOD_CONEXAO_NAO_ENCONTRADA", async () => {
  const http = httpFalso({ get: () => RESP_2_EVENTOS });
  await assert.rejects(
    () => financial.listarFinancialEvents({ ...TENANT, deps: { repo: repoFalso({ conexao: null }), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA,
  );
});

test("conexão sem merchant vinculado -> IFOOD_FINANCIAL_SEM_MERCHANT", async () => {
  const http = httpFalso({ get: () => RESP_2_EVENTOS });
  const repo = repoFalso({ conexao: { id: "conx-1", status: "ativa", merchant_id: null } });
  await assert.rejects(
    () => financial.listarFinancialEvents({ ...TENANT, deps: { repo, http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_FINANCIAL_SEM_MERCHANT,
  );
});

// =====================================================================
// 401 / refresh, 403, 429, 5xx
// =====================================================================
test("401: 1 refresh + 1 repetição, depois sucesso", async () => {
  let chamada = 0;
  const http = httpFalso({
    get: () => { chamada += 1; if (chamada === 1) throw ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO); return RESP_2_EVENTOS; },
  });
  const r = await financial.listarFinancialEvents({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso(), http } });
  assert.equal(r.eventos.length, 2);
  assert.equal(http.chamadas.post.length, 1);
});

test("403 -> IFOOD_MERCHANT_SEM_PERMISSAO propagado", async () => {
  const http = httpFalso({ get: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO); } });
  await assert.rejects(
    () => financial.listarFinancialEvents({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO,
  );
});

test("429 -> IFOOD_RATE_LIMITED propagado", async () => {
  const http = httpFalso({ get: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_RATE_LIMITED); } });
  await assert.rejects(
    () => financial.listarFinancialEvents({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_RATE_LIMITED,
  );
});

test("5xx -> IFOOD_INDISPONIVEL propagado", async () => {
  const http = httpFalso({ get: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL); } });
  await assert.rejects(
    () => financial.listarFinancialEvents({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_INDISPONIVEL,
  );
});

// =====================================================================
// segurança
// =====================================================================
test("header de homologação (homologacao:true) é sempre passado ao http client nesta fase", async () => {
  const http = httpFalso({ get: () => RESP_2_EVENTOS });
  await financial.listarFinancialEvents({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso(), http } });
  assert.equal(http.chamadas.get[0].opts.homologacao, true);
});

test("resposta normalizada nunca contém token/secret/authorization", async () => {
  const http = httpFalso({ get: () => RESP_2_EVENTOS });
  const r = await financial.listarFinancialEvents({ ...TENANT, inicio: "2025-01-01", fim: "2025-01-05", deps: { repo: repoFalso(), http } });
  const txt = JSON.stringify(r).toLowerCase();
  for (const vazamento of ["accesstoken", "refreshtoken", "authorization", "clientsecret", "at-atual", "rt-atual"]) {
    assert.ok(!txt.includes(vazamento), `vazou: ${vazamento}`);
  }
});
