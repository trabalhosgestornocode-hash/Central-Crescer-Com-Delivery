// Reconciliation On Demand — status na tela, acompanhamento e evidência do erro.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { criarAcompanhamentoReconciliacao } from "../src/ifoodReconciliacaoPolling.js";
import { montarEvidenciaOnDemand, montarEvidenciaHomologacao, MENSAGEM_ERRO_OD_SEM_MOTIVO, montarExportacaoJson } from "../src/ifoodEstado.js";

const REQ = "988ea97c-9f2b-483d-b500-cac51176f836";
const SRC = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/ifood.js"), "utf8").replace(/\r\n/g, "\n");

function acompanhar(respostas) {
  let i = 0;
  const fases = [];
  const esperas = [];
  const a = criarAcompanhamentoReconciliacao({
    consultar: async () => respostas[Math.min(i++, respostas.length - 1)],
    aoAtualizar: (e) => fases.push(e.resultado?.status ?? e.fase),
    dormir: async (ms) => { esperas.push(ms); },
    agora: () => 0,
  });
  return a.iniciar(REQ).then((fim) => ({ fim, fases, esperas }));
}

describe("acompanhamento (polling)", () => {
  test("created -> enqueue -> processed: concluído, backoff 2s/4s", async () => {
    const { fim, fases, esperas } = await acompanhar([
      { status: "created", finalizado: false }, { status: "enqueue", finalizado: false }, { status: "processed", finalizado: true, arquivoDisponivel: true },
    ]);
    assert.equal(fim.estado, "concluido");
    assert.deepEqual(fases, ["created", "enqueue"]);
    assert.deepEqual(esperas, [2000, 4000]);
  });

  test("created -> enqueue -> error: falhou e para na hora (sem nova consulta)", async () => {
    const { fim, fases } = await acompanhar([
      { status: "created", finalizado: false }, { status: "enqueue", finalizado: false }, { status: "error", finalizado: true, mensagemErro: null },
    ]);
    assert.equal(fim.estado, "falhou");
    assert.equal(fim.resultado.status, "error");
    assert.equal(fim.tentativas, 3);
    assert.deepEqual(fases, ["created", "enqueue"]);
  });
});

describe("tela — rótulos de status", () => {
  test("'enqueue' e 'enqueued' aparecem como 'Na fila'; processed 'Concluída'; error 'Erro'", () => {
    const linha = SRC.match(/const STATUS_OD_ROTULO = (\{[^}]+\});/)[1];
    const rotulos = Function(`return ${linha}`)();
    assert.deepEqual(rotulos, { created: "Criada", enqueue: "Na fila", enqueued: "Na fila", processed: "Concluída", error: "Erro" });
  });
  test("erro sem motivo usa o texto explícito (não inventa causa)", () => {
    assert.match(SRC, /esc\(rOd\.mensagemErro \|\| MENSAGEM_ERRO_OD_SEM_MOTIVO\)/);
    assert.equal(MENSAGEM_ERRO_OD_SEM_MOTIVO, "O iFood informou erro na geração do arquivo, sem detalhar o motivo.");
  });
});

describe("evidência On Demand — erro", () => {
  const base = { competencia: "2026-09", requestId: REQ, reutilizado: false };

  test("error SEM message -> status error, texto 'sem detalhar o motivo', nada de totais", () => {
    const od = montarEvidenciaOnDemand({ ...base, resultado: { requestId: REQ, competencia: "2026-09", status: "error", mensagemErro: null, arquivo: null } }, { ambiente: "homologacao" });
    assert.equal(od.status, "error");
    assert.equal(od.erro, MENSAGEM_ERRO_OD_SEM_MOTIVO);
    assert.equal(od.csvProcessado, false);
    assert.equal(od.quantidadeLinhas, null);
    assert.equal(od.requestId, "988e****f836");
  });

  test("error COM message oficial -> a mensagem do iFood", () => {
    const msg = "No financial entries found for the specified merchant and competence.";
    const od = montarEvidenciaOnDemand({ ...base, resultado: { requestId: REQ, competencia: "2026-09", status: "error", mensagemErro: msg, arquivo: null } }, { ambiente: "homologacao" });
    assert.equal(od.erro, msg);
  });

  test("erro do On Demand não aparece no mensal e o JSON não tem requestId integral", () => {
    const e = montarEvidenciaHomologacao({
      geradoEm: "2026-10-06T00:00:00Z", status: { financialHomologacao: true },
      financeiro: { reconciliation: { competencia: "2026-09", erro: null, resultado: null, onDemand: { ...base, resultado: { requestId: REQ, status: "error", mensagemErro: null } } } },
    });
    assert.equal(e.apis.reconciliation.erro, null);
    assert.equal(e.reconciliationOnDemand.erro, MENSAGEM_ERRO_OD_SEM_MOTIVO);
    assert.ok(!montarExportacaoJson(e).includes(REQ));
  });
});
