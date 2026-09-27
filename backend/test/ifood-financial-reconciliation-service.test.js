// ifoodFinancial.service.js — Reconciliation + Reconciliation On Demand. Sem
// rede real, sem banco real. Exercita o token service REAL
// (comAccessTokenValido) com http/repo/download falsos.
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
const REQUEST_ID = "123e4567-e89b-12d3-a456-426614174000";
const URL_SEGREDA = "https://exemplo.s3.amazonaws.com/arquivo.csv?X-Amz-Signature=SEGREDO-NUNCA-PODE-VAZAR";
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
    async postJson(caminho, corpo, opts) { chamadas.post.push({ caminho, corpo, opts }); return post(caminho, corpo, opts); },
    async postForm(caminho, campos) {
      chamadas.post.push({ caminho, campos });
      return { accessToken: "AT-renovado", refreshToken: "RT-renovado", expiresIn: 21600 };
    },
  };
}

function downloadFalso(bytes) {
  const chamadas = [];
  return { chamadas, async baixarArquivoConciliacao({ url }) { chamadas.push(url); return bytes ?? Buffer.from("pedido,valor\n1,10.00\n", "utf8"); } };
}

// Competência válida "recente e fechada": mês anterior ao atual.
function competenciaFechada() {
  const hoje = new Date();
  const anoMes = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - 1, 1));
  return `${anoMes.getUTCFullYear()}-${String(anoMes.getUTCMonth() + 1).padStart(2, "0")}`;
}

// =====================================================================
// obterReconciliation (GET síncrono)
// =====================================================================
test("resposta válida: baixa e parseia o arquivo automaticamente", async () => {
  const http = httpFalso({ get: () => [{ downloadPath: URL_SEGREDA, createdAt: "2024-03-19T17:45:52Z", metadata: { sha256: null } }] });
  const download = downloadFalso();
  const r = await financial.obterReconciliation({ ...TENANT, competencia: competenciaFechada(), deps: { repo: repoFalso(), http, download } });
  assert.equal(r.arquivo.totalLinhas, 1);
  assert.deepEqual(r.arquivo.colunas, ["pedido", "valor"]);
  assert.equal(download.chamadas[0], URL_SEGREDA);
});

test("sem downloadPath: arquivo é null, sem tentar baixar", async () => {
  const http = httpFalso({ get: () => [{ downloadPath: null, createdAt: null, metadata: null }] });
  const download = downloadFalso();
  const r = await financial.obterReconciliation({ ...TENANT, competencia: competenciaFechada(), deps: { repo: repoFalso(), http, download } });
  assert.equal(r.arquivo, null);
  assert.equal(download.chamadas.length, 0);
});

test("sha256 confere -> integridadeVerificada true", async () => {
  const bytes = Buffer.from("pedido,valor\n1,10.00\n", "utf8");
  const sha = await import("node:crypto").then((c) => c.createHash("sha256").update(bytes).digest("hex"));
  const http = httpFalso({ get: () => [{ downloadPath: URL_SEGREDA, createdAt: "x", metadata: { sha256: sha } }] });
  const r = await financial.obterReconciliation({ ...TENANT, competencia: competenciaFechada(), deps: { repo: repoFalso(), http, download: downloadFalso(bytes) } });
  assert.equal(r.arquivo.integridadeVerificada, true);
});

test("sha256 não confere -> integridadeVerificada false (não lança)", async () => {
  const http = httpFalso({ get: () => [{ downloadPath: URL_SEGREDA, createdAt: "x", metadata: { sha256: "hash-errado" } }] });
  const r = await financial.obterReconciliation({ ...TENANT, competencia: competenciaFechada(), deps: { repo: repoFalso(), http, download: downloadFalso() } });
  assert.equal(r.arquivo.integridadeVerificada, false);
});

test("competência no futuro -> IFOOD_RECONCILIATION_INVALIDA, sem chamar a API", async () => {
  const http = httpFalso({ get: () => { throw new Error("não deveria chamar"); } });
  const futuro = new Date(); futuro.setMonth(futuro.getMonth() + 1);
  const comp = `${futuro.getFullYear()}-${String(futuro.getMonth() + 1).padStart(2, "0")}`;
  await assert.rejects(
    () => financial.obterReconciliation({ ...TENANT, competencia: comp, deps: { repo: repoFalso(), http, download: downloadFalso() } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA,
  );
});

test("competência é o mês atual (ainda não fechado) -> IFOOD_RECONCILIATION_INVALIDA", async () => {
  const http = httpFalso({ get: () => { throw new Error("não deveria chamar"); } });
  const hoje = new Date();
  const comp = `${hoje.getUTCFullYear()}-${String(hoje.getUTCMonth() + 1).padStart(2, "0")}`;
  await assert.rejects(
    () => financial.obterReconciliation({ ...TENANT, competencia: comp, deps: { repo: repoFalso(), http, download: downloadFalso() } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA,
  );
});

test("competência com mais de 24 meses no passado -> IFOOD_RECONCILIATION_INVALIDA", async () => {
  const http = httpFalso({ get: () => { throw new Error("não deveria chamar"); } });
  await assert.rejects(
    () => financial.obterReconciliation({ ...TENANT, competencia: "2015-01", deps: { repo: repoFalso(), http, download: downloadFalso() } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA,
  );
});

test("formato de competência inválido -> IFOOD_RECONCILIATION_INVALIDA", async () => {
  const http = httpFalso({ get: () => { throw new Error("não deveria chamar"); } });
  await assert.rejects(
    () => financial.obterReconciliation({ ...TENANT, competencia: "07/2025", deps: { repo: repoFalso(), http, download: downloadFalso() } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA,
  );
});

test("sem merchant vinculado -> IFOOD_FINANCIAL_SEM_MERCHANT", async () => {
  const http = httpFalso({ get: () => [{}] });
  const repo = repoFalso({ conexao: { id: "conx-1", status: "ativa", merchant_id: null } });
  await assert.rejects(
    () => financial.obterReconciliation({ ...TENANT, competencia: competenciaFechada(), deps: { repo, http, download: downloadFalso() } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_FINANCIAL_SEM_MERCHANT,
  );
});

test("401: 1 refresh + 1 repetição, depois sucesso", async () => {
  let n = 0;
  const http = httpFalso({ get: () => { n += 1; if (n === 1) throw ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO); return [{ downloadPath: null, metadata: null }]; } });
  const r = await financial.obterReconciliation({ ...TENANT, competencia: competenciaFechada(), deps: { repo: repoFalso(), http, download: downloadFalso() } });
  assert.ok(r);
  assert.equal(http.chamadas.post.length, 1);
});

test("homologação sempre true, contexto 'reconciliation'", async () => {
  const http = httpFalso({ get: () => [{ downloadPath: null, metadata: null }] });
  await financial.obterReconciliation({ ...TENANT, competencia: competenciaFechada(), deps: { repo: repoFalso(), http, download: downloadFalso() } });
  assert.equal(http.chamadas.get[0].opts.homologacao, true);
  assert.equal(http.chamadas.get[0].opts.contexto, "reconciliation");
});

test("downloadPath NUNCA aparece na resposta normalizada nem em texto", async () => {
  const http = httpFalso({ get: () => [{ downloadPath: URL_SEGREDA, createdAt: "x", metadata: null }] });
  const r = await financial.obterReconciliation({ ...TENANT, competencia: competenciaFechada(), deps: { repo: repoFalso(), http, download: downloadFalso() } });
  const txt = JSON.stringify(r);
  assert.ok(!txt.includes("SEGREDO-NUNCA-PODE-VAZAR"));
  assert.ok(!txt.includes(URL_SEGREDA));
});

// =====================================================================
// solicitarReconciliationOnDemand (POST)
// =====================================================================
test("solicitação válida: devolve requestId", async () => {
  const http = httpFalso({ post: () => ({ competence: competenciaFechada(), merchantId: MERCHANT_ID, requestId: REQUEST_ID }) });
  const r = await financial.solicitarReconciliationOnDemand({ ...TENANT, competencia: competenciaFechada(), deps: { repo: repoFalso(), http } });
  assert.equal(r.requestId, REQUEST_ID);
});

test("corpo enviado é {competence} — nome exato confirmado no Swagger", async () => {
  const http = httpFalso({ post: () => ({ competence: competenciaFechada(), requestId: REQUEST_ID }) });
  await financial.solicitarReconciliationOnDemand({ ...TENANT, competencia: competenciaFechada(), deps: { repo: repoFalso(), http } });
  assert.deepEqual(http.chamadas.post[0].corpo, { competence: competenciaFechada() });
});

test("409 (já existe solicitação recente) -> IFOOD_RECONCILIATION_INVALIDA", async () => {
  const http = httpFalso({ post: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA, { mensagem: "Já existe uma solicitação..." }); } });
  await assert.rejects(
    () => financial.solicitarReconciliationOnDemand({ ...TENANT, competencia: competenciaFechada(), deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA,
  );
});

test("competência inválida -> erro sem chamar a API", async () => {
  const http = httpFalso({ post: () => { throw new Error("não deveria chamar"); } });
  await assert.rejects(
    () => financial.solicitarReconciliationOnDemand({ ...TENANT, competencia: "2015-01", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA,
  );
});

// =====================================================================
// consultarReconciliationOnDemand (GET status)
// =====================================================================
test("status 'created': sem arquivo, sem tentar baixar", async () => {
  const http = httpFalso({ get: () => ({ id: REQUEST_ID, status: "created", competence: "2025-07" }) });
  const download = downloadFalso();
  const r = await financial.consultarReconciliationOnDemand({ ...TENANT, requestId: REQUEST_ID, deps: { repo: repoFalso(), http, download } });
  assert.equal(r.status, "created");
  assert.equal(r.arquivo, null);
  assert.equal(download.chamadas.length, 0);
});

test("status 'processed': baixa e parseia automaticamente", async () => {
  const http = httpFalso({ get: () => ({ id: REQUEST_ID, status: "processed", competence: "2025-07", downloadPath: URL_SEGREDA }) });
  const download = downloadFalso();
  const r = await financial.consultarReconciliationOnDemand({ ...TENANT, requestId: REQUEST_ID, deps: { repo: repoFalso(), http, download } });
  assert.equal(r.status, "processed");
  assert.equal(r.arquivo.totalLinhas, 1);
});

test("status 'error': devolve mensagemErro, sem arquivo", async () => {
  const http = httpFalso({ get: () => ({ id: REQUEST_ID, status: "error", competence: "2025-07", message: "No financial entries found." }) });
  const r = await financial.consultarReconciliationOnDemand({ ...TENANT, requestId: REQUEST_ID, deps: { repo: repoFalso(), http, download: downloadFalso() } });
  assert.equal(r.status, "error");
  assert.equal(r.mensagemErro, "No financial entries found.");
  assert.equal(r.arquivo, null);
});

test("requestId com formato inválido -> IFOOD_RECONCILIATION_INVALIDA, sem chamar a API", async () => {
  const http = httpFalso({ get: () => { throw new Error("não deveria chamar"); } });
  await assert.rejects(
    () => financial.consultarReconciliationOnDemand({ ...TENANT, requestId: "nao-e-um-uuid", deps: { repo: repoFalso(), http, download: downloadFalso() } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA,
  );
});

test("404 (requestId não encontrado/expirado) -> IFOOD_RECONCILIATION_INVALIDA", async () => {
  const http = httpFalso({ get: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA, { mensagem: "expirou" }); } });
  await assert.rejects(
    () => financial.consultarReconciliationOnDemand({ ...TENANT, requestId: REQUEST_ID, deps: { repo: repoFalso(), http, download: downloadFalso() } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA,
  );
});

test("downloadPath NUNCA aparece na resposta normalizada (mesmo quando processed)", async () => {
  const http = httpFalso({ get: () => ({ id: REQUEST_ID, status: "processed", competence: "2025-07", downloadPath: URL_SEGREDA }) });
  const r = await financial.consultarReconciliationOnDemand({ ...TENANT, requestId: REQUEST_ID, deps: { repo: repoFalso(), http, download: downloadFalso() } });
  const txt = JSON.stringify(r);
  assert.ok(!txt.includes("SEGREDO-NUNCA-PODE-VAZAR"));
});

test("resposta normalizada nunca contém token/secret/authorization", async () => {
  const http = httpFalso({ get: () => ({ id: REQUEST_ID, status: "processed", competence: "2025-07", downloadPath: URL_SEGREDA }) });
  const r = await financial.consultarReconciliationOnDemand({ ...TENANT, requestId: REQUEST_ID, deps: { repo: repoFalso(), http, download: downloadFalso() } });
  const txt = JSON.stringify(r).toLowerCase();
  for (const vazamento of ["accesstoken", "refreshtoken", "authorization", "clientsecret", "at-atual", "rt-atual"]) {
    assert.ok(!txt.includes(vazamento), `vazou: ${vazamento}`);
  }
});
