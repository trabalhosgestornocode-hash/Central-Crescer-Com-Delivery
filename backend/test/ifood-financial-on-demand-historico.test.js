// Reconciliation On Demand — HISTÓRICO/EVIDÊNCIA de uma solicitação EXPIRADA.
//
// GET /financial/reconciliation/on-demand?competencia= (obterSolicitacaoReconciliationOnDemand)
// lê SÓ o banco. Regra: a janela de vigência (24h) decide.
//   - Existe solicitação VIGENTE (qualquer status: created/enqueue/error/processed)
//     -> fluxo operacional de sempre (requestId para retomar/consultar status/baixar).
//   - Só quando NÃO há vigente: a última persistida (expirada) vira histórico —
//     sem chamar o iFood, requestId só mascarado (`requestId: null`).
// Sempre respeitando organização + unidade + conexão.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-client-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-client-secret-NUNCA-VAZA";

const financial = await import("../src/modules/ifood/ifoodFinancial.service.js");
const solicitacoesReal = await import("../src/modules/ifood/ifoodFinancial.solicitacoes.js");
const { cifrar } = await import("../src/shared/cripto.js");

const TENANT_A = { organizacaoId: "org-A", unidadeId: "uni-A" };
const MERCHANT = "55c80000-0000-4000-8000-000000007040";
const REQ = "988e0000-0000-4000-8000-00000000f836";
const COMP = "2026-09";
const MSG_REAL = `File generation failed: No financial entries exist for merchant ${MERCHANT} in the requested time frame.`;
const MSG_MASCARADA = "File generation failed: No financial entries exist for merchant 55c8****7040 in the requested time frame.";
const daquiA = (ms) => new Date(Date.now() + ms).toISOString();
const VIGENTE = () => daquiA(3_600_000);
const EXPIRADA = () => daquiA(-2 * 86_400_000);

// Conexão viva por org|unidade. `extra` simula chaves adicionais (ex.: outra org
// apontando para a mesma conexão) para provar o filtro da camada de dados.
function repoFalso(extra = {}) {
  const conexoes = { "org-A|uni-A": { id: "conx-A", status: "ativa", merchant_id: MERCHANT }, ...extra };
  const cred = { access_token_cifrado: cifrar("AT-NUNCA-VAZA"), refresh_token_cifrado: cifrar("RT-NUNCA-VAZA"), expira_em: daquiA(3_600_000), status: "ativa" };
  return {
    async obterConexaoViva({ organizacaoId, unidadeId }) { return conexoes[`${organizacaoId}|${unidadeId}`] ?? null; },
    async obterCredencial() { return { ...cred }; },
    async salvarCredencial() { return cred; },
    async atualizarCredencial() { return cred; },
  };
}

const registro = (over = {}) => ({
  organizacao_id: "org-A", unidade_id: "uni-A", conexao_id: "conx-A", merchant_id: MERCHANT, competencia: COMP,
  request_id: REQ, status: "error", mensagem_erro: MSG_REAL,
  solicitado_em: daquiA(-3 * 86_400_000), expira_em: EXPIRADA(), atualizado_em: daquiA(-3 * 86_400_000 + 60_000),
  ...over,
});

// Mesmo contrato de ifoodFinancial.solicitacoes.js (isolamento por org + unidade + conexão).
function solicitacoesFalso(registros) {
  const lista = registros.map((r) => ({ ...r }));
  const chamadas = { registrar: 0, atualizarStatus: 0, obterUltima: 0 };
  const dono = (r, k) => r.organizacao_id === k.organizacaoId && r.unidade_id === k.unidadeId && r.conexao_id === k.conexaoId;
  const casa = (r, k) => dono(r, k) && r.competencia === k.competencia;
  return {
    chamadas,
    async obterUltima(k) { chamadas.obterUltima += 1; return lista.find((r) => casa(r, k)) ?? null; },
    async obterVigente(k) { const r = lista.find((x) => casa(x, k)); return r && Date.parse(r.expira_em) > Date.now() ? r : null; },
    async obterPorRequestId(k) { return lista.find((r) => dono(r, k) && r.request_id === k.requestId) ?? null; },
    async registrar() { chamadas.registrar += 1; throw new Error("nunca registra solicitação aqui"); },
    async atualizarStatus(k) { chamadas.atualizarStatus += 1; const r = lista.find((x) => dono(x, k) && x.request_id === k.requestId); if (r) r.status = k.status; return r ?? null; },
  };
}

// Leitura do histórico: qualquer HTTP/token é falha (não fala com o iFood).
const httpProibido = { async getJson() { throw new Error("GET ao iFood proibido"); }, async postJson() { throw new Error("POST ao iFood proibido"); } };
const tokenProibido = { async comAccessTokenValido() { throw new Error("token não deve ser usado"); } };
const depsLeitura = (sol, repo = repoFalso()) => ({ repo, solicitacoes: sol, http: httpProibido, token: tokenProibido });
const obter = (sol, tenant = TENANT_A, repo) => financial.obterSolicitacaoReconciliationOnDemand({ ...tenant, competencia: COMP, deps: depsLeitura(sol, repo) });

// Consulta de status (fluxo operacional): GET falso que registra as chamadas.
function httpStatus(resposta) {
  const chamadas = { get: 0, post: 0 };
  return { chamadas, async getJson() { chamadas.get += 1; return resposta; }, async postJson() { chamadas.post += 1; throw new Error("POST proibido"); } };
}
const CSV_GZ = zlib.gzipSync(Buffer.from(`competencia;valor;impacto_no_repasse\n${COMP};10,00;SIM\n`, "utf8"));
async function quieto(fn) { const o = console.log; const w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = o; console.warn = w; } }
const consultar = (sol, http, requestId = REQ) => quieto(() => financial.consultarReconciliationOnDemand({
  ...TENANT_A, requestId,
  deps: { repo: repoFalso(), solicitacoes: sol, http, download: { async baixarArquivoConciliacao() { return CSV_GZ; } }, homologacaoFinancial: () => true },
}));
const st = (status, extra = {}) => ({ id: REQ, status, merchantId: MERCHANT, competence: COMP, ...extra });

describe("Vigente (< 24h): fluxo operacional preservado, qualquer status", () => {
  for (const status of ["created", "enqueue", "error", "processed"]) {
    test(`vigente + ${status} -> requestId para retomar (não é histórico), sem chamar o iFood na leitura`, async () => {
      const r = await obter(solicitacoesFalso([registro({ status, mensagem_erro: status === "error" ? MSG_REAL : null, expira_em: VIGENTE() })]));
      assert.equal(r.historico, false);
      assert.equal(r.requestId, REQ);
      assert.equal(r.status, status);
      assert.equal(r.finalizado, status === "error" || status === "processed");
    });
  }

  test("vigente + created/enqueue -> GET de status segue funcionando e atualiza o estado", async () => {
    const sol = solicitacoesFalso([registro({ status: "created", mensagem_erro: null, expira_em: VIGENTE() })]);
    const http = httpStatus(st("enqueued"));
    const r = await consultar(sol, http);
    assert.equal(http.chamadas.get, 1);
    assert.equal(r.status, "enqueue");
    assert.equal(sol.chamadas.atualizarStatus, 1);
  });

  test("vigente + error -> ainda pode consultar o status no iFood (comportamento anterior)", async () => {
    const sol = solicitacoesFalso([registro({ expira_em: VIGENTE() })]);
    const http = httpStatus(st("error", { errorMessage: MSG_REAL }));
    const r = await consultar(sol, http);
    assert.equal(http.chamadas.get, 1, "GET de status executado");
    assert.equal(r.status, "error");
    assert.equal(r.mensagemErro, MSG_MASCARADA);
    assert.equal(http.chamadas.post, 0);
  });

  test("vigente + processed -> status + arquivo/download como antes", async () => {
    const sol = solicitacoesFalso([registro({ status: "processed", mensagem_erro: null, expira_em: VIGENTE() })]);
    const r = await consultar(sol, httpStatus(st("processed", { downloadPath: "https://s3.test/a.csv?X-Amz-Signature=SEGREDO" })));
    assert.equal(r.status, "processed");
    assert.equal(r.arquivoDisponivel, true);
    assert.equal(r.arquivo.totalLinhas, 1);
    assert.equal(JSON.stringify(r).includes("SEGREDO"), false, "downloadPath nunca vai para o frontend");
  });

  test("vigente encontrada -> não procura histórico", async () => {
    const sol = solicitacoesFalso([registro({ expira_em: VIGENTE() })]);
    await obter(sol);
    assert.equal(sol.chamadas.obterUltima, 0);
  });
});

describe("Expirada (> 24h): histórico/evidência só como fallback", () => {
  test("expirada + error -> histórico com status, motivo mascarado e datas do banco", async () => {
    const r = await obter(solicitacoesFalso([registro()]));
    assert.equal(r.historico, true);
    assert.equal(r.expirado, true);
    assert.equal(r.finalizado, true);
    assert.equal(r.status, "error");
    assert.equal(r.competencia, COMP);
    assert.equal(r.mensagemErro, MSG_MASCARADA);
    assert.ok(r.solicitadoEm && r.expiraEm && r.atualizadoEm);
  });

  test("expirada -> não chama o iFood, não registra nem altera status", async () => {
    const sol = solicitacoesFalso([registro()]);
    await obter(sol); // http/token proibidos: lançariam se usados
    assert.equal(sol.chamadas.registrar, 0);
    assert.equal(sol.chamadas.atualizarStatus, 0);
  });

  test("expirada sem status final (ex.: enqueue) -> histórico, nunca reativada como operação", async () => {
    const r = await obter(solicitacoesFalso([registro({ status: "enqueue", mensagem_erro: null })]));
    assert.equal(r.historico, true);
    assert.equal(r.finalizado, false);
    assert.equal(r.requestId, null);
    assert.equal(r.mensagemErro, null);
  });

  test("merchant mascarado: o UUID completo não sai em campo nenhum", async () => {
    const r = await obter(solicitacoesFalso([registro()]));
    const json = JSON.stringify(r);
    assert.equal(json.includes(MERCHANT), false);
    assert.equal("merchant_id" in r || "merchantId" in r, false);
    assert.match(r.mensagemErro, /55c8\*\*\*\*7040/);
  });

  test("requestId mascarado: só `requestIdMascarado`; `requestId` null (UI não retoma/consulta)", async () => {
    const r = await obter(solicitacoesFalso([registro()]));
    assert.equal(r.requestId, null);
    assert.equal(r.requestIdMascarado, "988e****f836");
    assert.equal(JSON.stringify(r).includes(REQ), false);
  });

  test("sem nenhuma solicitação para a competência -> null (estado normal)", async () => {
    const r = await financial.obterSolicitacaoReconciliationOnDemand({ ...TENANT_A, competencia: "2026-08", deps: depsLeitura(solicitacoesFalso([registro()])) });
    assert.equal(r, null);
  });
});

describe("Isolamento do histórico", () => {
  test("outra unidade (mesma org) -> bloqueado, mesmo se a conexão coincidisse", async () => {
    const repo = repoFalso({ "org-A|uni-B": { id: "conx-A", status: "ativa", merchant_id: MERCHANT } });
    assert.equal(await obter(solicitacoesFalso([registro()]), { organizacaoId: "org-A", unidadeId: "uni-B" }, repo), null);
  });

  test("outra organização -> bloqueado, mesmo se a conexão coincidisse", async () => {
    const repo = repoFalso({ "org-Z|uni-A": { id: "conx-A", status: "ativa", merchant_id: MERCHANT } });
    assert.equal(await obter(solicitacoesFalso([registro()]), { organizacaoId: "org-Z", unidadeId: "uni-A" }, repo), null);
  });

  test("outra conexão da mesma unidade (ex.: conexão antiga) -> bloqueado", async () => {
    assert.equal(await obter(solicitacoesFalso([registro({ conexao_id: "conx-ANTIGA" })])), null);
  });

  test("unidade sem conexão viva -> erro, sem ler o registro", async () => {
    const sol = solicitacoesFalso([registro()]);
    await assert.rejects(() => obter(sol, { organizacaoId: "org-X", unidadeId: "uni-X" }));
    assert.equal(sol.chamadas.obterUltima, 0);
  });

  test("requestId arbitrário do frontend não é aceito: 404 sem chegar ao iFood", async () => {
    const http = httpStatus(st("error"));
    await assert.rejects(
      () => consultar(solicitacoesFalso([registro({ expira_em: VIGENTE() })]), http, "11111111-2222-4333-8444-555555555555"),
      (e) => e.statusCode === 404,
    );
    assert.equal(http.chamadas.get, 0);
  });

  test("a leitura do histórico nem recebe requestId — só competência + tenant da sessão", () => {
    assert.equal(financial.obterSolicitacaoReconciliationOnDemand.length, 1);
    const fonte = financial.obterSolicitacaoReconciliationOnDemand.toString();
    assert.doesNotMatch(fonte.slice(0, fonte.indexOf(")")), /requestId/);
  });
});

describe("Camada de dados (obterUltima x obterVigente)", () => {
  function dbCom(linha) {
    const filtros = [];
    const b = { select: () => b, eq: (c, v) => { filtros.push([c, v]); return b; }, maybeSingle: async () => ({ data: linha, error: null }) };
    return { filtros, from: () => b };
  }
  const K = { organizacaoId: "org-A", unidadeId: "uni-A", conexaoId: "conx-A", competencia: COMP };

  test("obterUltima filtra org + unidade + conexão + competência e devolve mesmo expirada", async () => {
    const db = dbCom(registro());
    const r = await solicitacoesReal.obterUltima({ ...K, db });
    assert.equal(r.request_id, REQ);
    assert.deepEqual(db.filtros.map(([c]) => c), ["organizacao_id", "unidade_id", "conexao_id", "competencia"]);
  });

  test("obterVigente continua descartando a expirada (janela de 24h intacta)", async () => {
    assert.equal(await solicitacoesReal.obterVigente({ ...K, db: dbCom(registro()) }), null);
    const vig = await solicitacoesReal.obterVigente({ ...K, db: dbCom(registro({ expira_em: VIGENTE() })) });
    assert.equal(vig.request_id, REQ);
  });

  test("obterUltima sem escopo de tenant -> falha alta", async () => {
    await assert.rejects(() => solicitacoesReal.obterUltima({ ...K, conexaoId: null, db: dbCom(null) }));
  });
});
