// Reconciliation mensal: competência CONSULTADA x competência DOS REGISTROS.
//
// Cenário observado na homologação: consulta de 2026-09 com
// `x-request-homologation: true` devolve o arquivo de exemplo do iFood com
// registros de 2025-08 (createdAt 2025-09-16). Estes testes provam que:
//   * a competência consultada vai INTACTA para o iFood (sem fallback/fixa);
//   * o resultado ecoa a competência consultada — nunca a do arquivo;
//   * os registros e valores do arquivo NÃO são reescritos/convertidos;
//   * a competência contida no arquivo é exposta separadamente
//     (`arquivo.competenciasArquivo`), para a interface não apresentar uma
//     como se fosse a outra.
// Sem rede real, sem banco real.
import test from "node:test";
import assert from "node:assert/strict";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-client-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-client-secret";

const financial = await import("../src/modules/ifood/ifoodFinancial.service.js");
const mapper = await import("../src/modules/ifood/ifoodFinancial.mapper.js");
const { cifrar } = await import("../src/shared/cripto.js");

const TENANT = { organizacaoId: "org-1", unidadeId: "uni-1" };
const MERCHANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const daquiA = (ms) => new Date(Date.now() + ms).toISOString();
const COMPETENCIA_FIXTURE = "2025-08";

function repoFalso() {
  const cred = { access_token_cifrado: cifrar("AT-atual"), refresh_token_cifrado: cifrar("RT-atual"), expira_em: daquiA(3_600_000), status: "ativa" };
  return {
    async obterConexaoViva() { return { id: "conx-1", status: "ativa", merchant_id: MERCHANT_ID }; },
    async obterCredencial() { return { ...cred }; },
    async salvarCredencial() { return cred; },
    async atualizarCredencial() { return cred; },
  };
}

function httpFalso(resposta) {
  const chamadas = [];
  return {
    chamadas,
    async getJson(caminho, opts) { chamadas.push({ caminho, opts }); return resposta; },
    async postJson() { throw new Error("POST proibido neste teste"); },
    async postForm() { throw new Error("OAuth proibido neste teste"); },
  };
}

const downloadFalso = (texto) => ({ async baixarArquivoConciliacao() { return Buffer.from(texto, "utf8"); } });

// Mês fechado anterior ao atual — sempre válido e sempre ≠ 2025-08.
function competenciaFechada() {
  const hoje = new Date();
  const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Arquivo de exemplo no formato real (cabeçalho do CSV oficial), competência própria.
const CSV_FIXTURE = [
  "competencia;fato_gerador;descricao_lancamento;valor;valor_transacao;impacto_no_repasse",
  `${COMPETENCIA_FIXTURE};VENDA;Pedido;100.00;100.00;SIM`,
  `${COMPETENCIA_FIXTURE};COMISSAO;Comissão;-12.50;100.00;SIM`,
  `${COMPETENCIA_FIXTURE};VOUCHER;Voucher;20.00;20.00;NAO`,
].join("\n");

const RESPOSTA_FIXTURE = [{ downloadPath: "https://exemplo.s3.test/arquivo.csv", createdAt: "2025-09-16T19:16:00Z", metadata: { total_linhas: 3 } }];

test("resumirCompetenciasDoArquivo conta competências distintas, sem converter", () => {
  const r = mapper.resumirCompetenciasDoArquivo(
    ["Competência", "valor"],
    [["2025-08", "1"], ["2025-08", "2"], ["2025-07", "3"], ["", "4"]],
  );
  assert.deepEqual(r, {
    colunaEncontrada: true,
    competencias: [{ competencia: "2025-07", linhas: 1 }, { competencia: "2025-08", linhas: 2 }],
    linhasSemCompetencia: 1,
  });
});

test("arquivo sem coluna competencia: não inventa competência", () => {
  const r = mapper.resumirCompetenciasDoArquivo(["valor"], [["1"], ["2"]]);
  assert.deepEqual(r, { colunaEncontrada: false, competencias: [], linhasSemCompetencia: 2 });
  assert.deepEqual(mapper.parsearArquivoConciliacao(Buffer.from("", "utf8")).competenciasArquivo,
    { colunaEncontrada: false, competencias: [], linhasSemCompetencia: 0 });
});

test("homologação: competência solicitada ≠ competência contida no arquivo — as duas ficam explícitas e separadas", async () => {
  const solicitada = competenciaFechada();
  assert.notEqual(solicitada, COMPETENCIA_FIXTURE);
  const http = httpFalso(RESPOSTA_FIXTURE);

  const r = await financial.obterReconciliation({
    ...TENANT, competencia: solicitada, homologacao: true,
    deps: { repo: repoFalso(), http, download: downloadFalso(CSV_FIXTURE) },
  });

  // A competência solicitada vai intacta ao iFood, com o header de homologação.
  assert.equal(http.chamadas.length, 1);
  assert.ok(http.chamadas[0].caminho.endsWith(`/reconciliation?competence=${solicitada}`), http.chamadas[0].caminho);
  assert.equal(http.chamadas[0].opts.homologacao, true);

  // O resultado ecoa a SOLICITADA; a do arquivo vem à parte.
  assert.equal(r.competencia, solicitada);
  assert.deepEqual(r.arquivo.competenciasArquivo, {
    colunaEncontrada: true, competencias: [{ competencia: COMPETENCIA_FIXTURE, linhas: 3 }], linhasSemCompetencia: 0,
  });

  // "Gerado em" é o createdAt do iFood, repassado sem cálculo local.
  assert.equal(r.criadoEm, "2025-09-16T19:16:00Z");

  // Registros e valores exatamente como vieram (nenhuma conversão para a solicitada).
  assert.ok(r.arquivo.linhas.every((l) => l.competencia === COMPETENCIA_FIXTURE));
  assert.ok(!JSON.stringify(r.arquivo.linhas).includes(solicitada));
  assert.equal(r.arquivo.resumoRepasse.totalBruto, 107.5);
  assert.equal(r.arquivo.resumoRepasse.totalComImpacto, 87.5);
  assert.equal(r.arquivo.resumoRepasse.totalSemImpacto, 20);
});

test("sem fallback/competência fixa: cada competência solicitada vira exatamente o parâmetro enviado", async () => {
  const hoje = new Date();
  const competencias = [1, 2, 5].map((n) => {
    const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - n, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  for (const c of competencias) {
    const http = httpFalso(RESPOSTA_FIXTURE);
    const r = await financial.obterReconciliation({
      ...TENANT, competencia: c, homologacao: true,
      deps: { repo: repoFalso(), http, download: downloadFalso(CSV_FIXTURE) },
    });
    assert.ok(http.chamadas[0].caminho.endsWith(`competence=${c}`));
    assert.equal(r.competencia, c);
  }
});
