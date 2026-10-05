// Cenários de HOMOLOGAÇÃO do módulo Financial do iFood (critérios oficiais:
// developer.ifood.com.br > Financial > Critérios de homologação).
//
//   P0-1  arquivo de conciliação: só `impacto_no_repasse = SIM` compõe o repasse
//   P0-2  exportação segura do CSV (proxy autenticado, posse do requestId)
//   P0-3  Reconciliation On Demand: requestId registrado, 409 reaproveita o id
//   P1    404 de Settlements / Anticipation com mensagem fiel à API
//   +     header x-request-homologation, isolamento de tenant, nada de token/URL
//
// Zero rede real e zero banco: http/fetch/download/supabase falsos.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-client-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-client-secret-NUNCA-VAZA";

const financial = await import("../src/modules/ifood/ifoodFinancial.service.js");
const mapper = await import("../src/modules/ifood/ifoodFinancial.mapper.js");
const solicitacoesReal = await import("../src/modules/ifood/ifoodFinancial.solicitacoes.js");
const httpClient = await import("../src/modules/ifood/ifoodHttp.client.js");
const { IFOOD_ERROS, ifoodErro, erroPorStatusHttp } = await import("../src/modules/ifood/ifood.errors.js");
const { cifrar } = await import("../src/shared/cripto.js");
const { supabase } = await import("../src/config/supabase.js");
const { ifoodRouter } = await import("../src/modules/ifood/ifood.routes.js");
const { requireModulo } = await import("../src/middlewares/auth.js");
const { errorHandler } = await import("../src/middlewares/errorHandler.js");
const { MODULOS } = await import("../src/shared/modulos.js");
const { permissoesDoPapel } = await import("../src/shared/permissoes.js");
const { config } = await import("../src/config/env.js");

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const TENANT_A = { organizacaoId: "org-A", unidadeId: "uni-A" };
const TENANT_B = { organizacaoId: "org-B", unidadeId: "uni-B" };
const MERCHANT_A = "55c8f464-e65f-4340-b2c7-62d143027040";
const MERCHANT_B = "11111111-2222-3333-4444-555555555555";
const REQ_A = "123e4567-e89b-12d3-a456-426614174000";
const REQ_B = "99999999-e89b-12d3-a456-426614174999";
const URL_ASSINADA = "https://ifood-recon.s3.amazonaws.com/arquivo.csv?X-Amz-Signature=SEGREDO-ASSINATURA-NUNCA-VAZA";
const daquiA = (ms) => new Date(Date.now() + ms).toISOString();

function competenciaFechada() {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const COMP = competenciaFechada();

// Arquivo no formato OFICIAL: CSV ; compactado .gz (doc da API On Demand).
const CSV_OFICIAL = [
  "competencia;fato_gerador;descricao_lancamento;valor;valor_transacao;impacto_no_repasse;metodo_pagamento",
  `${COMP};VENDA;Pagamento do pedido;100,00;5000,00;SIM;CREDIT`,
  `${COMP};VENDA;Comissão iFood;-12,00;5000,00;SIM;CREDIT`,
  `${COMP};VENDA;Pedido vale-refeição;40,00;0,00;NÃO;MEAL_VOUCHER`,
  `${COMP};PROMOCAO;Promoção da loja;-5,00;0,00;NAO;CREDIT`,
  `${COMP};AJUSTE;Ajuste sem indicação;3,00;0,00;;CREDIT`,
].join("\n");
const GZ_OFICIAL = zlib.gzipSync(Buffer.from(CSV_OFICIAL, "utf8"));

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------
const CONEXOES = {
  "uni-A": { id: "conx-A", organizacao_id: "org-A", status: "ativa", merchant_id: MERCHANT_A },
  "uni-B": { id: "conx-B", organizacao_id: "org-B", status: "ativa", merchant_id: MERCHANT_B },
};
const credValida = () => ({ access_token_cifrado: cifrar("AT-ATUAL-NUNCA-VAZA"), refresh_token_cifrado: cifrar("RT-ATUAL-NUNCA-VAZA"), expira_em: daquiA(3_600_000), status: "ativa" });

function repoFalso() {
  let cred = credValida();
  return {
    async obterConexaoViva({ organizacaoId, unidadeId }) { const c = CONEXOES[unidadeId]; return c && c.organizacao_id === organizacaoId ? c : null; },
    async obterCredencial() { return cred ? { ...cred } : null; },
    async salvarCredencial(a) { cred = { access_token_cifrado: a.accessTokenCifrado, refresh_token_cifrado: a.refreshTokenCifrado ?? cred?.refresh_token_cifrado, expira_em: a.expiraEm, status: "ativa" }; return cred; },
    async atualizarCredencial({ campos }) { cred = { ...cred, ...campos }; return cred; },
  };
}

const registroA = (over = {}) => ({ organizacao_id: "org-A", unidade_id: "uni-A", conexao_id: "conx-A", competencia: COMP, request_id: REQ_A, status: "solicitado", expira_em: daquiA(3_600_000), ...over });
const registroB = (over = {}) => ({ organizacao_id: "org-B", unidade_id: "uni-B", conexao_id: "conx-B", competencia: COMP, request_id: REQ_B, status: "processed", expira_em: daquiA(3_600_000), ...over });

function solicitacoesFalso(registros = [registroA(), registroB()]) {
  const lista = registros.map((r) => ({ ...r }));
  const chamadas = { registrar: [], atualizarStatus: [] };
  const casa = (r, k) => r.organizacao_id === k.organizacaoId && r.unidade_id === k.unidadeId && r.conexao_id === k.conexaoId;
  return {
    lista, chamadas,
    async registrar(k) {
      chamadas.registrar.push(k);
      const r = { organizacao_id: k.organizacaoId, unidade_id: k.unidadeId, conexao_id: k.conexaoId, competencia: k.competencia, request_id: k.requestId, merchant_id: k.merchantId, status: "solicitado", expira_em: daquiA(86_400_000) };
      const i = lista.findIndex((x) => casa(x, k) && x.competencia === k.competencia);
      if (i >= 0) lista[i] = r; else lista.push(r);
      return r;
    },
    async obterVigente(k) { const r = lista.find((x) => casa(x, k) && x.competencia === k.competencia); return r && Date.parse(r.expira_em) > Date.now() ? r : null; },
    async obterPorRequestId(k) { return lista.find((x) => casa(x, k) && x.request_id === k.requestId) ?? null; },
    async atualizarStatus(k) { chamadas.atualizarStatus.push(k); const r = lista.find((x) => casa(x, k) && x.request_id === k.requestId); if (r) r.status = k.status; return r ?? null; },
  };
}

function httpFalso({ get, post } = {}) {
  const chamadas = { get: [], post: [], form: [] };
  return {
    chamadas,
    async getJson(caminho, opts) { chamadas.get.push({ caminho, opts }); return get(caminho, opts, chamadas.get.length); },
    async postJson(caminho, corpo, opts) { chamadas.post.push({ caminho, corpo, opts }); return post(caminho, corpo, opts, chamadas.post.length); },
    async postForm(caminho, campos) { chamadas.form.push({ caminho }); return { accessToken: "AT-RENOVADO", refreshToken: "RT-RENOVADO", expiresIn: 21600 }; },
  };
}

function downloadFalso(bytes = GZ_OFICIAL) {
  const chamadas = [];
  return { chamadas, async baixarArquivoConciliacao({ url }) { chamadas.push(url); return bytes; } };
}

const statusProcessed = (requestId = REQ_A) => ({ id: requestId, status: "processed", competence: COMP, downloadPath: URL_ASSINADA });

function silenciar() {
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const linhas = [];
  for (const k of Object.keys(orig)) console[k] = (...a) => linhas.push(a.map(String).join(" "));
  return { linhas, restaurar: () => Object.assign(console, orig) };
}
async function quieto(fn) { const s = silenciar(); try { return await fn(); } finally { s.restaurar(); } }

const SEGREDOS = ["SEGREDO-ASSINATURA-NUNCA-VAZA", "X-Amz-Signature", "AT-ATUAL-NUNCA-VAZA", "RT-ATUAL-NUNCA-VAZA", "AT-RENOVADO", "fin-client-secret-NUNCA-VAZA", "Bearer "];
function semSegredo(texto, rotulo = "") {
  for (const s of SEGREDOS) assert.ok(!String(texto).includes(s), `${rotulo} vazou: ${s}`);
}

// ===========================================================================
// P0-1 — impacto no repasse
// ===========================================================================
describe("P0-1 — arquivo de conciliação: impacto_no_repasse = SIM", () => {
  test("arquivo oficial (.gz, ;): total bruto x total com impacto x informativo, contagens", () => {
    const r = mapper.parsearArquivoConciliacao(GZ_OFICIAL);
    assert.equal(r.eraGzip, true);
    assert.equal(r.delimitador, ";");
    assert.deepEqual(r.resumoRepasse, {
      colunaImpactoEncontrada: true, colunaValorEncontrada: true,
      totalLinhas: 5, linhasComImpacto: 2, linhasSemImpacto: 2, linhasImpactoNaoInformado: 1, linhasValorInvalido: 0,
      totalBruto: 126, totalComImpacto: 88, totalSemImpacto: 35,
    });
    // Nada é descartado da tabela: as 5 linhas continuam lá.
    assert.equal(r.linhas.length, 5);
  });

  test("usa a coluna `valor` (lançamento), nunca `valor_transacao` (título bancário inteiro)", () => {
    const r = mapper.parsearArquivoConciliacao(GZ_OFICIAL);
    assert.notEqual(r.resumoRepasse.totalComImpacto, 10000);
    assert.equal(r.resumoRepasse.totalComImpacto, 88);
  });

  test("SIM / NÃO com caixa, acento e espaços variados", () => {
    for (const v of ["SIM", "Sim", "sim", " SIM "]) assert.equal(mapper.interpretarImpactoNoRepasse(v), true, v);
    for (const v of ["NÃO", "Não", "não", "NAO", "nao", " NÃO "]) assert.equal(mapper.interpretarImpactoNoRepasse(v), false, v);
    for (const v of ["", null, undefined, "S", "N", "talvez", "true"]) assert.equal(mapper.interpretarImpactoNoRepasse(v), null, String(v));
  });

  test("campo ausente/vazio = não informado: entra no bruto, FORA do total com impacto", () => {
    const r = mapper.resumirImpactoNoRepasse(["valor", "impacto_no_repasse"], [["10", "SIM"], ["7", ""], ["2"]]);
    assert.equal(r.linhasImpactoNaoInformado, 2);
    assert.equal(r.totalBruto, 19);
    assert.equal(r.totalComImpacto, 10);
  });

  test("valores positivos, negativos e zero; formatos 1.234,56 / -0,01 / 1,234.56", () => {
    assert.equal(mapper.valorCsvEmCentavos("1.234,56"), 123456);
    assert.equal(mapper.valorCsvEmCentavos("1,234.56"), 123456);
    assert.equal(mapper.valorCsvEmCentavos("-0,01"), -1);
    assert.equal(mapper.valorCsvEmCentavos("0"), 0);
    assert.equal(mapper.valorCsvEmCentavos("12.5"), 1250);
    assert.equal(mapper.valorCsvEmCentavos(""), null);
    assert.equal(mapper.valorCsvEmCentavos("abc"), null);
    const r = mapper.resumirImpactoNoRepasse(["valor", "impacto_no_repasse"], [["1.234,56", "SIM"], ["-34,56", "SIM"], ["0", "SIM"], ["x", "SIM"]]);
    assert.equal(r.totalComImpacto, 1200);
    assert.equal(r.linhasValorInvalido, 1);
  });

  test("soma sem ruído de ponto flutuante (0,10 + 0,20)", () => {
    const r = mapper.resumirImpactoNoRepasse(["valor", "impacto_no_repasse"], [["0,10", "SIM"], ["0,20", "SIM"]]);
    assert.equal(r.totalComImpacto, 0.3);
  });

  test("sem a coluna impacto_no_repasse: total bruto existe, total com impacto é null (nunca R$ 0)", () => {
    const r = mapper.parsearArquivoConciliacao(Buffer.from("competencia;valor\n2026-08;10\n", "utf8"));
    assert.equal(r.resumoRepasse.colunaImpactoEncontrada, false);
    assert.equal(r.resumoRepasse.totalBruto, 10);
    assert.equal(r.resumoRepasse.totalComImpacto, null);
  });

  test("sem a coluna valor: totais null, contagens preservadas", () => {
    const r = mapper.parsearArquivoConciliacao(Buffer.from("competencia;impacto_no_repasse\n2026-08;SIM\n", "utf8"));
    assert.equal(r.resumoRepasse.colunaValorEncontrada, false);
    assert.equal(r.resumoRepasse.totalBruto, null);
    assert.equal(r.resumoRepasse.linhasComImpacto, 1);
  });

  test("cabeçalho com BOM e nome com acento/caixa é reconhecido", () => {
    const r = mapper.parsearArquivoConciliacao(Buffer.from("﻿Valor;Impacto_No_Repasse\n5;Sim\n", "utf8"));
    assert.equal(r.colunas[0], "Valor");
    assert.equal(r.resumoRepasse.totalComImpacto, 5);
  });

  test("resumo cobre o arquivo INTEIRO mesmo com a tabela cortada em 2000 linhas", () => {
    const linhas = ["valor;impacto_no_repasse", ...Array.from({ length: 2500 }, () => "1;SIM")].join("\n");
    const r = mapper.parsearArquivoConciliacao(Buffer.from(linhas, "utf8"));
    assert.equal(r.truncado, true);
    assert.equal(r.linhas.length, 2000);
    assert.equal(r.resumoRepasse.linhasComImpacto, 2500);
    assert.equal(r.resumoRepasse.totalComImpacto, 2500);
  });

  test("o status On Demand 'processed' entrega o resumo ao frontend", async () => {
    const http = httpFalso({ get: () => statusProcessed() });
    const r = await quieto(() => financial.consultarReconciliationOnDemand({ ...TENANT_A, requestId: REQ_A, deps: { repo: repoFalso(), http, download: downloadFalso(), solicitacoes: solicitacoesFalso() } }));
    assert.equal(r.arquivoDisponivel, true);
    assert.equal(r.finalizado, true);
    assert.equal(r.arquivo.resumoRepasse.totalComImpacto, 88);
    semSegredo(JSON.stringify(r), "status");
  });
});

// ===========================================================================
// P0-2 — exportação segura do CSV
// ===========================================================================
describe("P0-2 — download do CSV de conciliação", () => {
  test("download permitido: link NOVO pedido ao iFood, .gz descompactado, CSV original íntegro", async () => {
    const http = httpFalso({ get: () => statusProcessed() });
    const download = downloadFalso();
    const r = await quieto(() => financial.baixarArquivoReconciliationOnDemand({ ...TENANT_A, requestId: REQ_A, deps: { repo: repoFalso(), http, download, solicitacoes: solicitacoesFalso() } }));
    assert.equal(r.conteudo.toString("utf8"), CSV_OFICIAL);
    assert.equal(r.contentType, "text/csv; charset=utf-8");
    assert.equal(r.nomeArquivo, `conciliacao-ifood-${COMP}.csv`);
    assert.equal(http.chamadas.get.length, 1, "consulta o status para obter um link novo");
    assert.equal(http.chamadas.get[0].opts.homologacao, false, "unidade fora da allowlist: dado real");
    assert.deepEqual(download.chamadas, [URL_ASSINADA], "o backend baixa — a URL não vai ao frontend");
    semSegredo(r.nomeArquivo + r.contentType, "metadados do download");
  });

  test("CSV sem gzip também é exportado como veio", async () => {
    const http = httpFalso({ get: () => statusProcessed() });
    const r = await quieto(() => financial.baixarArquivoReconciliationOnDemand({ ...TENANT_A, requestId: REQ_A, deps: { repo: repoFalso(), http, download: downloadFalso(Buffer.from("a;b\n1;2\n")), solicitacoes: solicitacoesFalso() } }));
    assert.equal(r.conteudo.toString("utf8"), "a;b\n1;2\n");
  });

  test("cross-tenant: requestId registrado para OUTRA unidade -> 404, sem chamar iFood nem baixar", async () => {
    const http = httpFalso({ get: () => { throw new Error("não deveria chamar o iFood"); } });
    const download = downloadFalso();
    await assert.rejects(
      () => quieto(() => financial.baixarArquivoReconciliationOnDemand({ ...TENANT_A, requestId: REQ_B, deps: { repo: repoFalso(), http, download, solicitacoes: solicitacoesFalso() } })),
      (e) => e.codigo === IFOOD_ERROS.IFOOD_RECONCILIATION_SOLICITACAO_NAO_ENCONTRADA && e.statusCode === 404,
    );
    assert.equal(http.chamadas.get.length, 0);
    assert.equal(download.chamadas.length, 0);
  });

  test("requestId inexistente -> 404; requestId malformado -> 400; nenhum chama o iFood", async () => {
    const http = httpFalso({ get: () => { throw new Error("não deveria chamar"); } });
    const deps = { repo: repoFalso(), http, download: downloadFalso(), solicitacoes: solicitacoesFalso([]) };
    await assert.rejects(() => quieto(() => financial.baixarArquivoReconciliationOnDemand({ ...TENANT_A, requestId: REQ_A, deps })), (e) => e.statusCode === 404);
    await assert.rejects(() => financial.baixarArquivoReconciliationOnDemand({ ...TENANT_A, requestId: "../../etc/passwd", deps }), (e) => e.codigo === IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA);
    assert.equal(http.chamadas.get.length, 0);
  });

  test("unidade sem conexão viva -> IFOOD_CONEXAO_NAO_ENCONTRADA", async () => {
    await assert.rejects(
      () => financial.baixarArquivoReconciliationOnDemand({ organizacaoId: "org-X", unidadeId: "uni-X", requestId: REQ_A, deps: { repo: repoFalso(), http: httpFalso(), download: downloadFalso(), solicitacoes: solicitacoesFalso() } }),
      (e) => e.codigo === IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA,
    );
  });

  test("arquivo ainda processando -> 409 ARQUIVO_INDISPONIVEL, sem baixar", async () => {
    const http = httpFalso({ get: () => ({ id: REQ_A, status: "enqueue", competence: COMP }) });
    const download = downloadFalso();
    await assert.rejects(
      () => quieto(() => financial.baixarArquivoReconciliationOnDemand({ ...TENANT_A, requestId: REQ_A, deps: { repo: repoFalso(), http, download, solicitacoes: solicitacoesFalso() } })),
      (e) => e.codigo === IFOOD_ERROS.IFOOD_RECONCILIATION_ARQUIVO_INDISPONIVEL && e.statusCode === 409,
    );
    assert.equal(download.chamadas.length, 0);
  });

  test("401 do iFood: 1 refresh + 1 repetição; persistente -> IFOOD_TOKEN_EXPIRADO (sem loop)", async () => {
    const http = httpFalso({ get: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO); } });
    await assert.rejects(
      () => quieto(() => financial.baixarArquivoReconciliationOnDemand({ ...TENANT_A, requestId: REQ_A, deps: { repo: repoFalso(), http, download: downloadFalso(), solicitacoes: solicitacoesFalso() } })),
      (e) => e.codigo === IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO,
    );
    assert.equal(http.chamadas.get.length, 2);
    assert.equal(http.chamadas.form.length, 1);
  });

  for (const [status, codigo] of [[403, IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO], [404, IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA], [429, IFOOD_ERROS.IFOOD_RATE_LIMITED], [503, IFOOD_ERROS.IFOOD_INDISPONIVEL]]) {
    test(`HTTP ${status} do iFood no status -> ${codigo}, sem baixar`, async () => {
      const http = httpFalso({ get: () => { throw erroPorStatusHttp(status, { contexto: "reconciliation" }); } });
      const download = downloadFalso();
      await assert.rejects(
        () => quieto(() => financial.baixarArquivoReconciliationOnDemand({ ...TENANT_A, requestId: REQ_A, deps: { repo: repoFalso(), http, download, solicitacoes: solicitacoesFalso() } })),
        (e) => e.codigo === codigo,
      );
      assert.equal(download.chamadas.length, 0);
    });
  }

  test("link expirado no S3 -> mensagem para gerar nova solicitação (sem URL na mensagem)", async () => {
    const http = httpFalso({ get: () => statusProcessed() });
    const download = { async baixarArquivoConciliacao() { throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_INVALIDA, { mensagem: "Não foi possível baixar o arquivo de conciliação. O link pode ter expirado — gere uma nova solicitação." }); } };
    await assert.rejects(
      () => quieto(() => financial.baixarArquivoReconciliationOnDemand({ ...TENANT_A, requestId: REQ_A, deps: { repo: repoFalso(), http, download, solicitacoes: solicitacoesFalso() } })),
      (e) => { semSegredo(e.message, "erro"); return /expirado/.test(e.message); },
    );
  });

  test("nome de arquivo seguro: só [A-Za-z0-9._-], competência inválida vira fallback", () => {
    assert.equal(financial.nomeArquivoConciliacao("2026-08"), "conciliacao-ifood-2026-08.csv");
    for (const ruim of ['../../x"', "2026-08\r\nSet-Cookie: a=b", null, "<script>"]) {
      const n = financial.nomeArquivoConciliacao(ruim);
      assert.match(n, /^[A-Za-z0-9._-]+$/, String(ruim));
      assert.equal(n, "conciliacao-ifood-competencia.csv");
    }
  });
});

// ===========================================================================
// P0-3 — On Demand: requestId registrado e 409
// ===========================================================================
describe("P0-3 — Reconciliation On Demand: requestId e 409", () => {
  test("POST aceito: registra o requestId com organização + unidade + conexão + competência", async () => {
    const sol = solicitacoesFalso([]);
    const http = httpFalso({ post: () => ({ competence: COMP, merchantId: MERCHANT_A, requestId: REQ_A }) });
    const r = await quieto(() => financial.solicitarReconciliationOnDemand({ ...TENANT_A, competencia: COMP, usuarioId: "u-1", deps: { repo: repoFalso(), http, solicitacoes: sol } }));
    assert.deepEqual(r, { requestId: REQ_A, competencia: COMP, reutilizado: false });
    assert.equal(sol.chamadas.registrar.length, 1);
    assert.deepEqual(sol.chamadas.registrar[0], { organizacaoId: "org-A", unidadeId: "uni-A", conexaoId: "conx-A", competencia: COMP, merchantId: MERCHANT_A, requestId: REQ_A, usuarioId: "u-1" });
    assert.equal(http.chamadas.post[0].opts.homologacao, false, "unidade fora da allowlist: dado real");
  });

  test("409 com requestId registrado: reaproveita o MESMO id (reutilizado), sem novo registro", async () => {
    const sol = solicitacoesFalso([registroA()]);
    const http = httpFalso({ post: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_EM_ANDAMENTO); } });
    const r = await quieto(() => financial.solicitarReconciliationOnDemand({ ...TENANT_A, competencia: COMP, deps: { repo: repoFalso(), http, solicitacoes: sol } }));
    assert.deepEqual(r, { requestId: REQ_A, competencia: COMP, reutilizado: true });
    assert.equal(sol.chamadas.registrar.length, 0);
  });

  test("409 trazendo requestId no corpo: usa o do iFood e registra", async () => {
    const sol = solicitacoesFalso([]);
    const http = httpFalso({ post: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_EM_ANDAMENTO, { detalhes: { requestId: REQ_A } }); } });
    const r = await quieto(() => financial.solicitarReconciliationOnDemand({ ...TENANT_A, competencia: COMP, deps: { repo: repoFalso(), http, solicitacoes: sol } }));
    assert.equal(r.requestId, REQ_A);
    assert.equal(r.reutilizado, true);
    assert.equal(sol.chamadas.registrar[0].requestId, REQ_A);
  });

  test("409 sem requestId conhecido -> IFOOD_RECONCILIATION_EM_ANDAMENTO (409) com mensagem clara", async () => {
    const http = httpFalso({ post: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_EM_ANDAMENTO); } });
    await assert.rejects(
      () => quieto(() => financial.solicitarReconciliationOnDemand({ ...TENANT_A, competencia: COMP, deps: { repo: repoFalso(), http, solicitacoes: solicitacoesFalso([]) } })),
      (e) => e.codigo === IFOOD_ERROS.IFOOD_RECONCILIATION_EM_ANDAMENTO && e.statusCode === 409 && /Aguarde/.test(e.message),
    );
  });

  test("409 NUNCA reaproveita requestId de outra unidade (mesma competência)", async () => {
    const sol = solicitacoesFalso([registroB()]);
    const http = httpFalso({ post: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_EM_ANDAMENTO); } });
    await assert.rejects(
      () => quieto(() => financial.solicitarReconciliationOnDemand({ ...TENANT_A, competencia: COMP, deps: { repo: repoFalso(), http, solicitacoes: sol } })),
      (e) => e.codigo === IFOOD_ERROS.IFOOD_RECONCILIATION_EM_ANDAMENTO,
    );
  });

  test("409 com registro EXPIRADO (> 24h) não é reaproveitado", async () => {
    const sol = solicitacoesFalso([registroA({ expira_em: daquiA(-1000) })]);
    const http = httpFalso({ post: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_RECONCILIATION_EM_ANDAMENTO); } });
    await assert.rejects(() => quieto(() => financial.solicitarReconciliationOnDemand({ ...TENANT_A, competencia: COMP, deps: { repo: repoFalso(), http, solicitacoes: sol } })));
  });

  test("POST sem requestId válido na resposta -> IFOOD_RESPOSTA_INVALIDA, nada registrado", async () => {
    const sol = solicitacoesFalso([]);
    const http = httpFalso({ post: () => ({ competence: COMP }) });
    await assert.rejects(() => quieto(() => financial.solicitarReconciliationOnDemand({ ...TENANT_A, competencia: COMP, deps: { repo: repoFalso(), http, solicitacoes: sol } })), (e) => e.codigo === IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA);
    assert.equal(sol.chamadas.registrar.length, 0);
  });

  test("status: grava o último status visto e só aceita requestId da unidade", async () => {
    const sol = solicitacoesFalso();
    const http = httpFalso({ get: () => ({ id: REQ_A, status: "enqueue", competence: COMP }) });
    const r = await quieto(() => financial.consultarReconciliationOnDemand({ ...TENANT_A, requestId: REQ_A, deps: { repo: repoFalso(), http, download: downloadFalso(), solicitacoes: sol } }));
    assert.equal(r.status, "enqueue");
    assert.equal(r.finalizado, false);
    assert.equal(r.arquivoDisponivel, false);
    assert.equal(sol.chamadas.atualizarStatus[0].status, "enqueue");
    await assert.rejects(
      () => quieto(() => financial.consultarReconciliationOnDemand({ ...TENANT_A, requestId: REQ_B, deps: { repo: repoFalso(), http, download: downloadFalso(), solicitacoes: sol } })),
      (e) => e.statusCode === 404,
    );
    assert.equal(http.chamadas.get.length, 1, "o requestId da unidade B não chegou ao iFood");
  });

  test("reentrada/reload: solicitação vigente da competência é devolvida; de outra unidade não", async () => {
    const sol = solicitacoesFalso();
    const a = await financial.obterSolicitacaoReconciliationOnDemand({ ...TENANT_A, competencia: COMP, deps: { repo: repoFalso(), solicitacoes: sol } });
    assert.equal(a.requestId, REQ_A);
    assert.equal(a.finalizado, false);
    const b = await financial.obterSolicitacaoReconciliationOnDemand({ ...TENANT_B, competencia: COMP, deps: { repo: repoFalso(), solicitacoes: sol } });
    assert.equal(b.requestId, REQ_B);
    assert.equal(b.finalizado, true);
    const vazio = await financial.obterSolicitacaoReconciliationOnDemand({ ...TENANT_A, competencia: COMP, deps: { repo: repoFalso(), solicitacoes: solicitacoesFalso([registroB()]) } });
    assert.equal(vazio, null);
  });

  test("cliente HTTP: 409 do POST on-demand vira EM_ANDAMENTO e anexa SÓ o requestId (UUID) do corpo", async () => {
    const resposta = (corpo) => ({ ok: false, status: 409, headers: { get: () => "application/json" }, text: async () => JSON.stringify(corpo) });
    const comId = async () => resposta({ code: "Conflict", message: "There is already a recent and valid request.", requestId: REQ_A });
    await assert.rejects(
      () => quieto(() => httpClient.postJson("/x", { competence: COMP }, { accessToken: "AT", contexto: "reconciliation", fetchImpl: comId })),
      (e) => e.codigo === IFOOD_ERROS.IFOOD_RECONCILIATION_EM_ANDAMENTO && e.details?.requestId === REQ_A,
    );
    const lixo = async () => resposta({ requestId: "../nao-uuid" });
    await assert.rejects(
      () => quieto(() => httpClient.postJson("/x", {}, { accessToken: "AT", contexto: "reconciliation", fetchImpl: lixo })),
      (e) => e.codigo === IFOOD_ERROS.IFOOD_RECONCILIATION_EM_ANDAMENTO && e.details?.requestId === undefined,
    );
  });
});

// ===========================================================================
// Registro das solicitações (ifoodFinancial.solicitacoes.js)
// ===========================================================================
describe("registro de solicitações — banco e fallback em memória", () => {
  function dbFalso({ erro } = {}) {
    const ops = [];
    const q = (tabela) => {
      const filtros = [];
      const b = {
        upsert: (linha, opt) => { ops.push({ tabela, op: "upsert", linha, opt }); return b; },
        update: (campos) => { ops.push({ tabela, op: "update", campos }); return b; },
        select: () => b,
        eq: (c, v) => { filtros.push([c, v]); return b; },
        single: async () => (erro ? { data: null, error: erro } : { data: { ok: true, filtros }, error: null }),
        maybeSingle: async () => (erro ? { data: null, error: erro } : { data: null, error: null, filtros }),
      };
      ops.push({ tabela, filtros });
      return b;
    };
    return { ops, from: q };
  }
  const K = { organizacaoId: "org-A", unidadeId: "uni-A", conexaoId: "conx-A", competencia: COMP };

  test("toda consulta filtra organização + unidade + conexão (isolamento na camada de dados)", async () => {
    const db = dbFalso();
    await solicitacoesReal.obterPorRequestId({ ...K, requestId: REQ_A, db });
    const f = db.ops.find((o) => o.filtros)?.filtros.map(([c]) => c);
    assert.deepEqual(f, ["organizacao_id", "unidade_id", "conexao_id", "request_id"]);
  });

  test("registrar faz upsert por conexão+competência com validade de 24h", async () => {
    const db = dbFalso();
    await solicitacoesReal.registrar({ ...K, merchantId: MERCHANT_A, requestId: REQ_A, db });
    const up = db.ops.find((o) => o.op === "upsert");
    assert.equal(up.opt.onConflict, "conexao_id,competencia");
    assert.equal(up.linha.request_id, REQ_A);
    const validade = Date.parse(up.linha.expira_em) - Date.parse(up.linha.solicitado_em);
    assert.equal(validade, 24 * 60 * 60 * 1000);
    assert.equal(JSON.stringify(up.linha).includes("token"), false);
  });

  test("tabela ausente (migration 106 não aplicada): cai para memória, mantendo o isolamento", async () => {
    solicitacoesReal._limparMemoria();
    const db = dbFalso({ erro: { code: "PGRST205", message: "Could not find the table" } });
    await quieto(() => solicitacoesReal.registrar({ ...K, merchantId: MERCHANT_A, requestId: REQ_A, db }));
    const vig = await quieto(() => solicitacoesReal.obterVigente({ ...K, db }));
    assert.equal(vig.request_id, REQ_A);
    const outra = await quieto(() => solicitacoesReal.obterPorRequestId({ organizacaoId: "org-B", unidadeId: "uni-B", conexaoId: "conx-B", requestId: REQ_A, db }));
    assert.equal(outra, null);
    solicitacoesReal._limparMemoria();
  });

  test("outros erros de banco NÃO são engolidos", async () => {
    const db = dbFalso({ erro: { code: "42501", message: "permission denied" } });
    await assert.rejects(() => solicitacoesReal.obterVigente({ ...K, db }), /permission denied/);
  });

  test("sem escopo de tenant -> falha alta (nunca consulta sem filtro)", async () => {
    await assert.rejects(() => solicitacoesReal.obterVigente({ organizacaoId: "org-A", unidadeId: null, conexaoId: "conx-A", competencia: COMP, db: dbFalso() }));
  });
});

// ===========================================================================
// P1 — 404 de Settlements e Anticipation
// ===========================================================================
describe("P1 — 404 com mensagem fiel à API", () => {
  test("Settlements 404 -> 'Nenhuma liquidação encontrada para o período.' (não 'loja não encontrada')", () => {
    const e = erroPorStatusHttp(404, { contexto: "settlements" });
    assert.equal(e.codigo, IFOOD_ERROS.IFOOD_FINANCIAL_SEM_DADOS);
    assert.equal(e.message, "Nenhuma liquidação encontrada para o período.");
  });
  test("Anticipation 404 -> 'A loja não possui plano de antecipação disponível no iFood.'", () => {
    const e = erroPorStatusHttp(404, { contexto: "anticipations" });
    assert.equal(e.codigo, IFOOD_ERROS.IFOOD_FINANCIAL_SEM_DADOS);
    assert.match(e.message, /plano de antecipação/);
  });
  test("403 de Settlements/Anticipation mantém a mensagem financeira", () => {
    for (const contexto of ["settlements", "anticipations", "financial"]) {
      assert.match(erroPorStatusHttp(403, { contexto }).message, /dados financeiros/);
    }
  });
  test("o service usa os contextos próprios nas duas APIs", async () => {
    const http = httpFalso({ get: () => { throw erroPorStatusHttp(404, { contexto: "settlements" }); } });
    await assert.rejects(() => quieto(() => financial.listarSettlements({ ...TENANT_A, inicio: "2026-09-01", fim: "2026-09-07", deps: { repo: repoFalso(), http } })), /Nenhuma liquidação/);
    assert.equal(http.chamadas.get[0].opts.contexto, "settlements");
    const http2 = httpFalso({ get: () => ({ anticipations: [] }) });
    await quieto(() => financial.listarAnticipations({ ...TENANT_A, inicio: "2026-09-01", fim: "2026-09-07", deps: { repo: repoFalso(), http: http2 } }));
    assert.equal(http2.chamadas.get[0].opts.contexto, "anticipations");
  });
});

// ===========================================================================
// Header x-request-homologation
// ===========================================================================
describe("header x-request-homologation decidido POR UNIDADE (allowlist)", () => {
  // Unidade A na allowlist; unidade B fora. Mesmas chamadas, mesmos fakes.
  const naAllowlist = (u) => u === TENANT_A.unidadeId;
  async function todasAsApis(tenant, requestId) {
    const http = httpFalso({ get: (c) => (c.includes("on-demand") ? statusProcessed(requestId) : c.includes("/reconciliation") ? [{ downloadPath: null }] : {}), post: () => ({ requestId, competence: COMP }) });
    const deps = { repo: repoFalso(), http, download: downloadFalso(), solicitacoes: solicitacoesFalso(), homologacaoFinancial: naAllowlist };
    const periodo = { inicio: "2026-09-01", fim: "2026-09-07" };
    await quieto(async () => {
      await financial.listarSales({ ...tenant, ...periodo, deps }).catch(() => {});
      await financial.listarFinancialEvents({ ...tenant, ...periodo, deps }).catch(() => {});
      await financial.listarSettlements({ ...tenant, ...periodo, deps });
      await financial.listarAnticipations({ ...tenant, ...periodo, deps });
      await financial.obterReconciliation({ ...tenant, competencia: COMP, deps });
      await financial.solicitarReconciliationOnDemand({ ...tenant, competencia: COMP, deps });
      await financial.consultarReconciliationOnDemand({ ...tenant, requestId, deps });
      await financial.baixarArquivoReconciliationOnDemand({ ...tenant, requestId, deps });
    });
    return [...http.chamadas.get, ...http.chamadas.post].map((c) => ({ rotulo: c.opts.rotulo, homologacao: c.opts.homologacao }));
  }
  const ROTULOS = ["financial.sales", "financial.events", "financial.settlements", "financial.anticipations", "financial.reconciliation",
    "financial.reconciliation.on_demand.status", "financial.reconciliation.on_demand.status", "financial.reconciliation.on_demand.solicitar"];

  test("unidade A (na allowlist): TODAS as APIs Financial enviam o header — POST, status e download no mesmo modo", async () => {
    const chamadas = await todasAsApis(TENANT_A, REQ_A);
    assert.deepEqual(chamadas.map((c) => c.rotulo).sort(), [...ROTULOS].sort());
    for (const c of chamadas) assert.equal(c.homologacao, true, c.rotulo);
  });

  test("unidade B (fora da allowlist): NENHUMA API Financial envia o header (dado real)", async () => {
    const chamadas = await todasAsApis(TENANT_B, REQ_B);
    assert.deepEqual(chamadas.map((c) => c.rotulo).sort(), [...ROTULOS].sort());
    for (const c of chamadas) assert.equal(c.homologacao, false, c.rotulo);
  });

  test("sem allowlist injetada, a config vazia vale: nenhuma unidade em homologação", async () => {
    const http = httpFalso({ get: () => ({}) });
    await quieto(() => financial.listarSettlements({ ...TENANT_A, inicio: "2026-09-01", fim: "2026-09-07", deps: { repo: repoFalso(), http } }));
    assert.equal(http.chamadas.get[0].opts.homologacao, false);
  });
});

// ===========================================================================
describe("rotas HTTP do On Demand (download, solicitação vigente)", async () => {
  // A unidade do tenant (req.tenant.unidadeId = "uni-A") está na allowlist desta suíte:
  // prova a decisão ponta a ponta a partir do TENANT, não de query/body.
  const allowlistOriginal = config.ifood.financialHomologacaoUnidades;
  before(() => { config.ifood.financialHomologacaoUnidades = ["uni-a"]; });
  const fromOriginal = supabase.from;
  const fetchOriginal = globalThis.fetch;
  const TABELAS = {
    ifood_conexoes: [{ id: "conx-A", organizacao_id: "org-A", unidade_id: "uni-A", status: "ativa", merchant_id: MERCHANT_A }],
    ifood_credenciais: [{ conexao_id: "conx-A", app_type: "financial", ...credValida() }],
    ifood_financial_reconciliacoes_on_demand: [registroA({ status: "processed" }), registroB()],
  };
  supabase.from = (tabela) => {
    const filtros = [];
    const filtrar = () => (TABELAS[tabela] ?? []).filter((l) => filtros.every(([c, v, neg]) => (neg ? l[c] !== v : l[c] === v)));
    const q = {
      select: () => q, eq: (c, v) => { filtros.push([c, v]); return q; }, neq: (c, v) => { filtros.push([c, v, true]); return q; },
      in: () => q, order: () => q, limit: () => q, gt: () => q, lt: () => q,
      insert: () => q, update: () => q, upsert: () => q, delete: () => q,
      maybeSingle: async () => ({ data: filtrar()[0] ?? null, error: null }),
      single: async () => ({ data: filtrar()[0] ?? null, error: null }),
      then: (ok, err) => Promise.resolve({ data: filtrar(), error: null }).then(ok, err),
    };
    return q;
  };
  const chamadasExternas = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    chamadasExternas.push({ url: u, headers: init.headers ?? {} });
    if (u.startsWith("https://ifood-recon.s3")) {
      return { ok: true, status: 200, headers: { get: () => "application/octet-stream" }, arrayBuffer: async () => GZ_OFICIAL.buffer.slice(GZ_OFICIAL.byteOffset, GZ_OFICIAL.byteOffset + GZ_OFICIAL.length) };
    }
    return { ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) }, text: async () => JSON.stringify(statusProcessed()) };
  };

  const app = express();
  app.use("/api/v1", (req, _res, next) => {
    req.user = { id: "u-rota" };
    req.acesso = { papel: "unit_manager", permissoes: permissoesDoPapel("unit_manager"), modulos: [MODULOS.IFOOD], impersonando: false };
    req.tenant = { ...TENANT_A };
    next();
  }, requireModulo(MODULOS.IFOOD), ifoodRouter);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  after(() => { server.close(); supabase.from = fromOriginal; globalThis.fetch = fetchOriginal; config.ifood.financialHomologacaoUnidades = allowlistOriginal; });

  const get = (url) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method: "GET", path: url }, (res) => {
      const partes = []; res.on("data", (c) => partes.push(c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, corpo: Buffer.concat(partes).toString("utf8") }));
    });
    req.on("error", reject); req.end();
  });

  test("GET .../on-demand/:requestId/arquivo -> 200 text/csv, attachment seguro, no-store, CSV íntegro, sem segredo", async () => {
    const r = await quieto(() => get(`/api/v1/financial/reconciliation/on-demand/${REQ_A}/arquivo`));
    assert.equal(r.status, 200, r.corpo);
    assert.equal(r.headers["content-type"], "text/csv; charset=utf-8");
    assert.equal(r.headers["content-disposition"], `attachment; filename="conciliacao-ifood-${COMP}.csv"`);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.corpo, CSV_OFICIAL);
    semSegredo(r.corpo + JSON.stringify(r.headers), "resposta do download");
    const ifood = chamadasExternas.find((c) => c.url.includes("/reconciliation/on-demand/"));
    assert.ok(ifood.headers["x-request-homologation"] === "true", "status consultado com o header de homologação");
  });

  test("cross-tenant pela rota: requestId da unidade B -> 404 JSON, sem chamada externa", async () => {
    const antes = chamadasExternas.length;
    const r = await quieto(() => get(`/api/v1/financial/reconciliation/on-demand/${REQ_B}/arquivo`));
    assert.equal(r.status, 404);
    assert.equal(JSON.parse(r.corpo).codigo, IFOOD_ERROS.IFOOD_RECONCILIATION_SOLICITACAO_NAO_ENCONTRADA);
    assert.equal(chamadasExternas.length, antes);
  });

  test("GET .../on-demand?competencia= -> solicitação vigente da unidade (sem chamar o iFood)", async () => {
    const antes = chamadasExternas.length;
    const r = await quieto(() => get(`/api/v1/financial/reconciliation/on-demand?competencia=${COMP}`));
    assert.equal(r.status, 200, r.corpo);
    const { data } = JSON.parse(r.corpo);
    assert.equal(data.requestId, REQ_A);
    assert.equal(data.finalizado, true);
    assert.equal(chamadasExternas.length, antes);
  });

  test("status pela rota devolve arquivoDisponivel + resumo, nunca o downloadPath", async () => {
    const r = await quieto(() => get(`/api/v1/financial/reconciliation/on-demand/${REQ_A}`));
    assert.equal(r.status, 200, r.corpo);
    const { data } = JSON.parse(r.corpo);
    assert.equal(data.arquivoDisponivel, true);
    assert.equal(data.arquivo.resumoRepasse.totalComImpacto, 88);
    semSegredo(r.corpo, "status");
  });
});

describe("rotas: as novas rotas exigem a permissão de gerenciar integrações", () => {
  const ROTAS = readFileSync(path.join(AQUI, "../src/modules/ifood/ifood.routes.js"), "utf8");
  for (const [rota, handler] of [
    ['"/financial/reconciliation/on-demand"', "financialReconciliationOnDemandAtual"],
    ['"/financial/reconciliation/on-demand/:requestId/arquivo"', "financialReconciliationOnDemandArquivo"],
  ]) {
    test(`${rota} -> gerenciar + rate limit Financial`, () => {
      assert.match(ROTAS, new RegExp(`ifoodRouter\\.get\\(${rota.replace(/[/:]/g, "\\$&")}, gerenciar, limitarFinancial, controller\\.${handler}\\)`));
    });
  }
});
