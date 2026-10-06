// Evidência da Reconciliation ON DEMAND: bloco próprio, alimentado SÓ pelo
// resultado do requestId da solicitação. O Reconciliation mensal nunca
// completa campo do On Demand (e vice-versa).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  montarEvidenciaHomologacao, montarEvidenciaOnDemand, mascararRequestId, montarExportacaoJson, montarExportacaoHtml,
} from "../src/ifoodEstado.js";

const REQ = "3f2a9c1e-7b4d-4e8a-9f10-55aa66bb7c9d";
const OUTRO_REQ = "11111111-2222-4333-8444-555555555555";
const URL_ASSINADA = "https://bucket.s3.amazonaws.com/x.csv?X-Amz-Signature=abc";
const HOMOLOG = { homologacao: false, financialHomologacao: true, merchant: { idMascarado: "55c8****7040" } };
const REAL = { homologacao: false, financialHomologacao: false, merchant: { idMascarado: "55c8****7040" } };

function resumo({ linhas, bruto, sim, nao, lSim, lNao, lNi = 0 }) {
  return {
    colunaImpactoEncontrada: true, colunaValorEncontrada: true, totalLinhas: linhas,
    linhasComImpacto: lSim, linhasSemImpacto: lNao, linhasImpactoNaoInformado: lNi, linhasValorInvalido: 0,
    totalBruto: bruto, totalComImpacto: sim, totalSemImpacto: nao,
  };
}
function arquivo(r, extra = {}) {
  return { colunas: ["valor", "impacto_no_repasse"], linhas: [{ valor: "1" }], totalLinhas: r.totalLinhas, truncado: false, eraGzip: true, delimitador: ";", resumoRepasse: r, ...extra };
}

// Mensal com 271 linhas e totais X.
const MENSAL_X = resumo({ linhas: 271, bruto: 9999.99, sim: 8888.88, nao: 1111.11, lSim: 200, lNao: 71 });
function reconciliationMensal() {
  return {
    competencia: "2026-09", erro: null,
    resultado: { competencia: "2026-09", criadoEm: "2026-10-01T00:00:00Z", metadados: { totalLinhas: 271 }, arquivo: arquivo(MENSAL_X, { integridadeVerificada: true }) },
  };
}
// On Demand com CSV de totais Y.
const OD_Y = resumo({ linhas: 12, bruto: 150.5, sim: 120.25, nao: 30.25, lSim: 9, lNao: 3 });
function onDemandProcessado(over = {}) {
  return {
    competencia: "2026-09", requestId: REQ, reutilizado: false, fase: "concluido", erro: null,
    resultado: { requestId: REQ, competencia: "2026-09", status: "processed", finalizado: true, mensagemErro: null, arquivoDisponivel: true, arquivo: arquivo(OD_Y) },
    ...over,
  };
}
const evid = (status, reconciliation) => montarEvidenciaHomologacao({ geradoEm: "2026-10-06T00:00:00Z", status, financeiro: { reconciliation } });

describe("mascararRequestId", () => {
  test("abcd****wxyz e nunca o valor inteiro", () => {
    assert.equal(mascararRequestId(REQ), "3f2a****7c9d");
    assert.equal(mascararRequestId(null), null);
    assert.equal(mascararRequestId("curto"), "****");
  });
});

describe("evidência On Demand — separação do mensal", () => {
  test("mensal com 271 linhas + On Demand sem CSV processado -> On Demand NÃO mostra 271 (nem totais do mensal)", () => {
    const rec = reconciliationMensal();
    rec.onDemand = { competencia: "2026-09", requestId: REQ, reutilizado: false, fase: "processando", resultado: { requestId: REQ, competencia: "2026-09", status: "enqueue", arquivoDisponivel: false, arquivo: null } };
    const e = evid(HOMOLOG, rec);
    const od = e.reconciliationOnDemand;
    assert.equal(rec.resultado.arquivo.totalLinhas, 271, "mensal tem 271");
    assert.equal(e.apis.reconciliation.consultada, true);
    assert.equal(od.csvProcessado, false);
    assert.equal(od.status, "enqueue");
    for (const campo of ["quantidadeLinhas", "totalBruto", "impactoRepasseSim", "impactoRepasseNao", "valorLiquidoConsiderado", "formatoDetectado"]) {
      assert.equal(od[campo], null, campo);
    }
    assert.ok(!JSON.stringify(od).includes("271") && !JSON.stringify(od).includes("9999.99"));
  });

  test("mensal com totais X + On Demand com CSV de totais Y -> evidência On Demand mostra Y, nunca X", () => {
    const rec = reconciliationMensal();
    rec.onDemand = onDemandProcessado();
    const od = evid(HOMOLOG, rec).reconciliationOnDemand;
    assert.equal(od.quantidadeLinhas, 12);
    assert.equal(od.totalBruto, 150.5);
    assert.equal(od.impactoRepasseSim, 120.25);
    assert.equal(od.impactoRepasseNao, 30.25);
    assert.equal(od.linhasImpactoSim, 9);
    assert.equal(od.linhasImpactoNao, 3);
    assert.equal(od.valorLiquidoConsiderado, 120.25, "líquido = só impacto SIM");
    assert.equal(od.formatoDetectado, "csv_gzip");
    for (const x of ["271", "9999.99", "8888.88", "1111.11"]) assert.ok(!JSON.stringify(od).includes(x), x);
  });

  test("On Demand NÃO contamina o mensal: mensal sem consulta fica vazio mesmo com On Demand processado", () => {
    const e = evid(HOMOLOG, { competencia: "2026-09", erro: null, resultado: null, onDemand: onDemandProcessado() });
    const mensal = e.apis.reconciliation;
    assert.equal(mensal.consultada, false);
    assert.equal(mensal.formatoDetectado, null);
    assert.equal(mensal.delimitadorDetectado, null);
    assert.equal(mensal.exemplo, null);
    assert.equal(mensal.onDemand, undefined);
    assert.equal(e.reconciliationOnDemand.quantidadeLinhas, 12);
  });

  test("mensal com arquivo + On Demand processado: mensal mantém seus próprios dados", () => {
    const rec = reconciliationMensal();
    rec.onDemand = onDemandProcessado();
    const mensal = evid(HOMOLOG, rec).apis.reconciliation;
    assert.equal(mensal.hashVerificado, true);
    assert.equal(mensal.delimitadorDetectado, ";");
    assert.equal(mensal.consultada, true);
  });

  test("sem solicitação On Demand: bloco existe, solicitado=false, tudo null (não herda o mensal)", () => {
    const od = evid(HOMOLOG, reconciliationMensal()).reconciliationOnDemand;
    assert.equal(od.tipo, "reconciliation_on_demand");
    assert.equal(od.solicitado, false);
    assert.equal(od.requestId, null);
    assert.equal(od.status, null);
    assert.equal(od.reutilizado, null);
    assert.equal(od.quantidadeLinhas, null);
    assert.equal(od.totalBruto, null);
  });

  test("resultado de OUTRO requestId (solicitação trocada) não é usado", () => {
    const od = montarEvidenciaOnDemand(onDemandProcessado({ requestId: OUTRO_REQ }), { ambiente: "homologacao" });
    assert.equal(od.requestId, "1111****5555");
    assert.equal(od.status, "solicitado");
    assert.equal(od.quantidadeLinhas, null);
    assert.equal(od.totalBruto, null);
  });
});

describe("evidência On Demand — campos", () => {
  test("tipo, ambiente, competência, requestId mascarado, status, reutilizado", () => {
    const od = evid(HOMOLOG, { onDemand: onDemandProcessado({ reutilizado: true }) }).reconciliationOnDemand;
    assert.equal(od.tipo, "reconciliation_on_demand");
    assert.equal(od.ambiente, "homologacao");
    assert.equal(od.amostraHomologacao, true);
    assert.equal(od.competencia, "2026-09");
    assert.equal(od.requestId, "3f2a****7c9d");
    assert.equal(od.status, "processed");
    assert.equal(od.reutilizado, true);
  });

  test("status 'solicitado' logo após o POST (sem resultado de status ainda)", () => {
    const od = montarEvidenciaOnDemand({ competencia: "2026-09", requestId: REQ, reutilizado: false, resultado: null }, { ambiente: "homologacao" });
    assert.equal(od.status, "solicitado");
    assert.equal(od.reutilizado, false);
    assert.equal(od.csvProcessado, false);
  });

  test("erro do iFood (status error) aparece em `erro`, sem totais", () => {
    const od = montarEvidenciaOnDemand(onDemandProcessado({ resultado: { requestId: REQ, competencia: "2026-09", status: "error", mensagemErro: "Falha ao gerar", arquivo: null } }), { ambiente: "homologacao" });
    assert.equal(od.status, "error");
    assert.equal(od.erro, "Falha ao gerar");
    assert.equal(od.totalBruto, null);
  });

  test("arquivo/tamanho só depois do download DO MESMO requestId", () => {
    assert.equal(montarEvidenciaOnDemand(onDemandProcessado(), {}).arquivo, null);
    const ok = montarEvidenciaOnDemand(onDemandProcessado({ arquivoBaixado: { requestId: REQ, nome: "conciliacao-ifood-2026-09.csv", bytes: 4096 } }), {});
    assert.equal(ok.arquivo, "conciliacao-ifood-2026-09.csv");
    assert.equal(ok.tamanhoArquivo, 4096);
    const outro = montarEvidenciaOnDemand(onDemandProcessado({ arquivoBaixado: { requestId: OUTRO_REQ, nome: "x.csv", bytes: 1 } }), {});
    assert.equal(outro.arquivo, null);
    assert.equal(outro.tamanhoArquivo, null);
  });

  test("modo real e homologação continuam separados (ambiente/aviso de amostra)", () => {
    const real = evid(REAL, { onDemand: onDemandProcessado() }).reconciliationOnDemand;
    assert.equal(real.ambiente, "producao");
    assert.equal(real.amostraHomologacao, false);
    const html = montarExportacaoHtml(evid(REAL, { onDemand: onDemandProcessado() }));
    assert.doesNotMatch(html, /Dados de exemplo do ambiente de homologação do iFood/);
  });
});

describe("evidência On Demand — segurança e exportação", () => {
  const rec = reconciliationMensal();
  rec.onDemand = onDemandProcessado({
    arquivoBaixado: { requestId: REQ, nome: "conciliacao-ifood-2026-09.csv", bytes: 4096 },
    resultado: { ...onDemandProcessado().resultado, downloadPath: URL_ASSINADA, accessToken: "tok-secreto" },
  });
  const e = evid(HOMOLOG, rec);
  const json = montarExportacaoJson(e);
  const html = montarExportacaoHtml(e);

  test("nenhum token, URL assinada ou requestId integral no JSON/HTML", () => {
    for (const s of [json, html]) {
      assert.ok(!s.includes(REQ), "requestId integral");
      assert.ok(!s.includes("X-Amz-Signature") && !s.includes(URL_ASSINADA), "URL assinada");
      assert.ok(!s.includes("tok-secreto"), "token");
    }
    assert.match(json, /3f2a\*\*\*\*7c9d/);
  });

  test("HTML tem seção 'Conciliação sob demanda' com os textos exigidos e os totais do On Demand", () => {
    assert.match(html, /<h2>Conciliação sob demanda<\/h2>/);
    assert.match(html, /Dados obtidos a partir do arquivo gerado para esta solicitação\./);
    assert.match(html, /Dados de exemplo do ambiente de homologação do iFood/);
    const secao = html.slice(html.indexOf("<h2>Conciliação sob demanda</h2>"), html.indexOf("<h2>Validações financeiras</h2>"));
    assert.match(secao, /R\$ 150,50/);
    assert.match(secao, /R\$ 120,25/);
    assert.match(secao, /reconciliation_on_demand/);
    assert.ok(!secao.includes("271") && !secao.includes("9999"), "seção On Demand sem números do mensal");
  });
});

describe("tela (ifood.js) — estático", () => {
  const SRC = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/ifood.js"), "utf8").replace(/\r\n/g, "\n");

  test("requestId exibido mascarado na aba On Demand", () => {
    assert.match(SRC, /Identificador da solicitação no iFood: <span class="mono">\$\{esc\(mascararRequestId\(od\.requestId\)\)\}<\/span>/);
    assert.doesNotMatch(SRC, /\$\{esc\(od\.requestId\)\}/);
  });

  test("aba Evidência tem bloco próprio do On Demand e o mensal não lê mais onDemand", () => {
    assert.match(SRC, /\$\{blocoEvidenciaOnDemand\(evidencia\.reconciliationOnDemand\)\}/);
    assert.doesNotMatch(SRC, /a\.reconciliation\.onDemand/);
    const fn = SRC.slice(SRC.indexOf("function blocoEvidenciaOnDemand("), SRC.indexOf("const FORMATO_ARQUIVO_ROTULO"));
    assert.match(fn, /Conciliação sob demanda/);
    assert.match(fn, /TEXTO_FONTE_ON_DEMAND/);
    assert.match(fn, /TEXTO_AMOSTRA_HOMOLOGACAO/);
  });

  test("download registra só nome/tamanho para a evidência (sem URL)", () => {
    assert.match(SRC, /od\.arquivoBaixado = \{ requestId: od\.requestId, nome: nomeArquivo \|\| null, bytes:/);
  });
});
