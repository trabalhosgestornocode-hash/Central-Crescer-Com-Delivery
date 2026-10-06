// Reconciliation On Demand — status e diagnóstico do erro.
//
// Swagger (Financial v3.0, GET on-demand/{requestId}): exemplos created,
// enqueue, processed e "No Financial Entries" (status "error" + `message`).
// API real de homologação (2026-10-06): created -> enqueued -> error, SEM
// `message`. Aqui: "enqueued" vira o canônico "enqueue"; `message` é o único
// motivo lido (sanitizado); sem ele, só os NOMES dos campos vão para o log.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-client-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-client-secret-NUNCA-VAZA";

const financial = await import("../src/modules/ifood/ifoodFinancial.service.js");
const mapper = await import("../src/modules/ifood/ifoodFinancial.mapper.js");
const solicitacoes = await import("../src/modules/ifood/ifoodFinancial.solicitacoes.js");
const { cifrar } = await import("../src/shared/cripto.js");

const TENANT = { organizacaoId: "org-A", unidadeId: "uni-A" };
const MERCHANT = "55c8f464-e65f-4340-b2c7-62d143027040";
const REQ = "988ea97c-9f2b-483d-b500-cac51176f836";
const COMP = "2026-09";
const URL_ASSINADA = "https://ifood-recon.s3.amazonaws.com/a.csv?X-Amz-Signature=SEGREDO-ASSINATURA-NUNCA-VAZA";
const MSG_OFICIAL = "No financial entries found for the specified merchant and competence.";
const daquiA = (ms) => new Date(Date.now() + ms).toISOString();
const GZ = zlib.gzipSync(Buffer.from([
  "competencia;fato_gerador;valor;impacto_no_repasse",
  `${COMP};VENDA;100,00;SIM`,
  `${COMP};VENDA;40,00;NÃO`,
].join("\n"), "utf8"));

function repoFalso() {
  const cred = { access_token_cifrado: cifrar("AT-ATUAL-NUNCA-VAZA"), refresh_token_cifrado: cifrar("RT-ATUAL-NUNCA-VAZA"), expira_em: daquiA(3_600_000), status: "ativa" };
  return {
    async obterConexaoViva({ organizacaoId, unidadeId }) { return organizacaoId === "org-A" && unidadeId === "uni-A" ? { id: "conx-A", organizacao_id: "org-A", status: "ativa", merchant_id: MERCHANT } : null; },
    async obterCredencial() { return { ...cred }; },
    async salvarCredencial() { return cred; },
    async atualizarCredencial() { return cred; },
  };
}
function solicitacoesFalso() {
  const r = { organizacao_id: "org-A", unidade_id: "uni-A", conexao_id: "conx-A", competencia: COMP, request_id: REQ, status: "solicitado", expira_em: daquiA(3_600_000) };
  const chamadas = { atualizarStatus: [] };
  return {
    registro: r, chamadas,
    async obterPorRequestId(k) { return k.requestId === REQ && k.conexaoId === "conx-A" ? r : null; },
    async atualizarStatus(k) { chamadas.atualizarStatus.push(k); r.status = k.status; return r; },
  };
}
function httpSequencia(respostas) {
  const chamadas = [];
  return { chamadas, async getJson(caminho, opts) { chamadas.push({ caminho, opts }); return respostas[Math.min(chamadas.length - 1, respostas.length - 1)]; } };
}
const downloadFalso = () => ({ async baixarArquivoConciliacao() { return GZ; } });

async function capturar(fn) {
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const linhas = [];
  for (const k of Object.keys(orig)) console[k] = (...a) => linhas.push(a.map(String).join(" "));
  try { return { r: await fn(), log: linhas.join("\n") }; } finally { Object.assign(console, orig); }
}

async function rodarSequencia(respostas) {
  const sol = solicitacoesFalso();
  const http = httpSequencia(respostas);
  const deps = { repo: repoFalso(), http, download: downloadFalso(), solicitacoes: sol, homologacaoFinancial: () => true };
  const resultados = [];
  let log = "";
  for (let i = 0; i < respostas.length; i++) {
    const c = await capturar(() => financial.consultarReconciliationOnDemand({ ...TENANT, requestId: REQ, deps }));
    resultados.push(c.r);
    log += `${c.log}\n`;
  }
  return { resultados, log, sol, http };
}

const st = (status, extra = {}) => ({ id: REQ, status, merchantId: MERCHANT, competence: COMP, ...extra });

describe("mapper — status do On Demand", () => {
  test("'enqueued' (valor real da API) vira o canônico 'enqueue', com o bruto preservado", () => {
    const r = mapper.mapearRespostaReconciliationStatus(st("enqueued"));
    assert.equal(r.status, "enqueue");
    assert.equal(r.statusIfood, "enqueued");
  });
  test("'enqueue' (exemplo do Swagger) continua aceito sem mudança", () => {
    const r = mapper.mapearRespostaReconciliationStatus(st("enqueue"));
    assert.equal(r.status, "enqueue");
    assert.equal(r.statusIfood, "enqueue");
  });
  test("created/processed/error preservados; desconhecido passa como veio (minúsculo); ausente = null", () => {
    for (const s of ["created", "processed", "error"]) assert.equal(mapper.mapearRespostaReconciliationStatus(st(s)).status, s);
    assert.equal(mapper.mapearRespostaReconciliationStatus(st("PROCESSING")).status, "processing");
    assert.equal(mapper.mapearRespostaReconciliationStatus({ id: REQ }).status, null);
    assert.deepEqual([...mapper.STATUS_ON_DEMAND_CONHECIDOS], ["created", "enqueue", "processed", "error"]);
  });
  test("o canônico é o que a tabela (migration 106) e o registro aceitam", () => {
    assert.ok(mapper.STATUS_ON_DEMAND_CONHECIDOS.every((s) => ["solicitado", "created", "enqueue", "processed", "error"].includes(s)));
  });
});

describe("mapper — motivo do erro", () => {
  test("error com `message` oficial -> mensagemErro, sem lista de campos", () => {
    const r = mapper.mapearRespostaReconciliationStatus(st("error", { message: MSG_OFICIAL }));
    assert.equal(r.mensagemErro, MSG_OFICIAL);
    assert.equal(r.camposRecebidosNoErro, null);
  });
  test("mensagem sanitizada: URL removida, espaços colapsados, até 300 caracteres", () => {
    assert.equal(mapper.sanitizarMensagemErroOnDemand(`falhou   em\n ${URL_ASSINADA} agora`), "falhou em [url removida] agora");
    assert.equal(mapper.sanitizarMensagemErroOnDemand("x".repeat(500)).length, 300);
    assert.equal(mapper.sanitizarMensagemErroOnDemand({ detail: "obj" }), null);
    assert.equal(mapper.sanitizarMensagemErroOnDemand("   "), null);
  });
  test("error SEM `message` -> mensagemErro null e só os NOMES dos campos recebidos", () => {
    const r = mapper.mapearRespostaReconciliationStatus(st("error", { reason: "segredo-do-valor", "chave estranha!": 1 }));
    assert.equal(r.mensagemErro, null);
    assert.deepEqual(r.camposRecebidosNoErro, ["id", "status", "merchantId", "competence", "reason"]);
    assert.ok(!JSON.stringify(r.camposRecebidosNoErro).includes("segredo-do-valor"));
  });
  test("campos recebidos só aparecem no error (nunca em created/enqueue/processed)", () => {
    for (const s of ["created", "enqueued", "processed"]) assert.equal(mapper.mapearRespostaReconciliationStatus(st(s)).camposRecebidosNoErro, null);
  });
});

describe("service — transições do acompanhamento", () => {
  test("created -> enqueued -> processed: status gravados (enqueue canônico), arquivo parseado no fim", async () => {
    const { resultados, sol, log } = await rodarSequencia([st("created"), st("enqueued"), st("processed", { downloadPath: URL_ASSINADA })]);
    assert.deepEqual(resultados.map((r) => r.status), ["created", "enqueue", "processed"]);
    assert.deepEqual(resultados.map((r) => r.finalizado), [false, false, true]);
    assert.deepEqual(sol.chamadas.atualizarStatus.map((c) => c.status), ["created", "enqueue", "processed"]);
    assert.equal(resultados[2].arquivoDisponivel, true);
    assert.equal(resultados[2].arquivo.totalLinhas, 2);
    assert.equal(resultados[2].arquivo.resumoRepasse.totalComImpacto, 100);
    assert.match(log, /"status":"enqueue","statusIfood":"enqueued"/);
    assert.ok(!log.includes("X-Amz-Signature") && !log.includes(REQ) && !log.includes("AT-ATUAL"));
  });

  test("created -> enqueued -> error COM message: motivo gravado, devolvido e logado (sanitizado)", async () => {
    const { resultados, sol, log } = await rodarSequencia([st("created"), st("enqueued"), st("error", { message: MSG_OFICIAL })]);
    const fim = resultados[2];
    assert.equal(fim.status, "error");
    assert.equal(fim.finalizado, true);
    assert.equal(fim.mensagemErro, MSG_OFICIAL);
    assert.equal(fim.arquivoDisponivel, false);
    assert.equal(sol.chamadas.atualizarStatus.at(-1).mensagemErro, MSG_OFICIAL);
    assert.match(log, /"mensagemErro":"No financial entries found/);
    assert.doesNotMatch(log, /camposRecebidos/);
  });

  test("created -> enqueued -> error SEM message (caso real): mensagemErro null + nomes dos campos no log", async () => {
    const { resultados, log } = await rodarSequencia([st("created"), st("enqueued"), st("error")]);
    assert.equal(resultados[2].mensagemErro, null);
    assert.match(log, /"status":"error".*"mensagemErro":null,"camposRecebidos":\["id","status","merchantId","competence"\]/);
    assert.ok(!log.includes(MERCHANT), "valor do merchantId nunca vai para o log, só o nome do campo");
  });

  test("download segue exigindo 'processed' (enqueued não libera arquivo)", async () => {
    const sol = solicitacoesFalso();
    await assert.rejects(
      () => capturar(() => financial.baixarArquivoReconciliationOnDemand({ ...TENANT, requestId: REQ, deps: { repo: repoFalso(), http: httpSequencia([st("enqueued")]), download: downloadFalso(), solicitacoes: sol } })).then((c) => c.r),
      (e) => e.codigo === "IFOOD_RECONCILIATION_ARQUIVO_INDISPONIVEL",
    );
  });

  test("header de homologação vem da unidade em todas as consultas de status", async () => {
    const { http } = await rodarSequencia([st("created"), st("enqueued")]);
    assert.ok(http.chamadas.every((c) => c.opts.homologacao === true));
  });
});

describe("registro (solicitacoes) — persistência do status canônico", () => {
  function dbFalso() {
    const updates = [];
    const cadeia = { eq() { return cadeia; }, select() { return cadeia; }, async maybeSingle() { return { data: { status: updates.at(-1)?.status }, error: null }; } };
    return { updates, from() { return { update(campos) { updates.push(campos); return cadeia; } }; } };
  }
  const chave = { organizacaoId: "org-A", unidadeId: "uni-A", conexaoId: "conx-A", requestId: REQ };

  test("'enqueue' é persistido; 'enqueued' bruto não chegaria ao banco (o mapper normaliza antes)", async () => {
    const db = dbFalso();
    await solicitacoes.atualizarStatus({ ...chave, status: "enqueue", db });
    assert.deepEqual(db.updates, [{ status: "enqueue", mensagem_erro: null }]);
    const db2 = dbFalso();
    assert.equal(await solicitacoes.atualizarStatus({ ...chave, status: "enqueued", db: db2 }), null);
    assert.equal(db2.updates.length, 0);
  });

  test("error grava a mensagem sanitizada; sem mensagem grava null", async () => {
    const db = dbFalso();
    await solicitacoes.atualizarStatus({ ...chave, status: "error", mensagemErro: MSG_OFICIAL, db });
    await solicitacoes.atualizarStatus({ ...chave, status: "error", mensagemErro: null, db });
    assert.deepEqual(db.updates, [{ status: "error", mensagem_erro: MSG_OFICIAL }, { status: "error", mensagem_erro: null }]);
  });
});
