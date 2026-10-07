// Reconciliation mensal: competência CONSULTADA x competência DOS REGISTROS.
// Cenário real da homologação: consulta 2026-09 -> arquivo de exemplo do iFood
// com registros de 2025-08. A interface precisa mostrar as duas, separadas,
// e nunca apresentar a competência do arquivo como se fosse a consultada
// (nem converter uma na outra).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { derivarCompetenciaReconciliation, fmtCompetencia } from "../src/ifoodEstado.js";

const IFOOD = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/ifood.js"), "utf8");
const corpo = (nome) => {
  const i = IFOOD.indexOf(`function ${nome}(`);
  assert.ok(i >= 0, `função ${nome} não encontrada`);
  const fim = IFOOD.indexOf("\nfunction ", i + 1);
  return IFOOD.slice(i, fim < 0 ? undefined : fim);
};

const resultado = (competencia, competencias, colunaEncontrada = true) => ({
  competencia, criadoEm: "2025-09-16T19:16:00Z",
  arquivo: { totalLinhas: 271, competenciasArquivo: { colunaEncontrada, competencias, linhasSemCompetencia: 0 } },
});

describe("derivarCompetenciaReconciliation", () => {
  test("homologação: consultada 2026-09, arquivo 2025-08 -> 'amostra', as duas preservadas", () => {
    const r = resultado("2026-09", [{ competencia: "2025-08", linhas: 271 }]);
    const c = derivarCompetenciaReconciliation(r, { homologacao: true });
    assert.equal(c.situacao, "amostra");
    assert.equal(c.consultada, "2026-09");
    assert.deepEqual(c.noArquivo, [{ competencia: "2025-08", linhas: 271 }]);
    // Nada foi convertido no resultado de origem.
    assert.equal(r.arquivo.competenciasArquivo.competencias[0].competencia, "2025-08");
  });

  test("fora da homologação a mesma divergência é ALERTA ('divergente'), nunca silenciada", () => {
    const c = derivarCompetenciaReconciliation(resultado("2026-09", [{ competencia: "2025-08", linhas: 3 }]), { homologacao: false });
    assert.equal(c.situacao, "divergente");
    assert.equal(derivarCompetenciaReconciliation(resultado("2026-09", [{ competencia: "2025-08", linhas: 3 }])).situacao, "divergente");
  });

  test("arquivo com mais de uma competência, uma delas a consultada -> não confere", () => {
    const c = derivarCompetenciaReconciliation(
      resultado("2026-09", [{ competencia: "2026-08", linhas: 1 }, { competencia: "2026-09", linhas: 9 }]), { homologacao: true });
    assert.equal(c.situacao, "amostra");
  });

  test("todas as linhas da competência consultada -> 'confere'", () => {
    assert.equal(derivarCompetenciaReconciliation(resultado("2026-09", [{ competencia: "2026-09", linhas: 10 }])).situacao, "confere");
  });

  test("sem coluna competencia, sem arquivo ou sem resultado -> null (não inventa)", () => {
    assert.equal(derivarCompetenciaReconciliation(resultado("2026-09", [], false)).situacao, null);
    assert.equal(derivarCompetenciaReconciliation({ competencia: "2026-09", arquivo: null }).situacao, null);
    assert.equal(derivarCompetenciaReconciliation(null).situacao, null);
    // Resposta antiga (sem competenciasArquivo): ainda mostra a consultada, sem afirmar nada do arquivo.
    const antigo = derivarCompetenciaReconciliation({ competencia: "2026-09", arquivo: { totalLinhas: 1 } });
    assert.deepEqual(antigo, { consultada: "2026-09", noArquivo: [], situacao: null });
  });

  test("fmtCompetencia: AAAA-MM -> MM/AAAA; outros formatos voltam como vieram", () => {
    assert.equal(fmtCompetencia("2026-09"), "09/2026");
    assert.equal(fmtCompetencia("2025-08"), "08/2025");
    assert.equal(fmtCompetencia("ago/2025"), "ago/2025");
  });
});

describe("tela Reconciliation mensal — fiação", () => {
  test("bloco de competência entra no resultado, antes do 'Gerado em'", () => {
    const rec = corpo("conteudoAbaReconciliation");
    const i = rec.indexOf("blocoCompetenciaReconciliation(r)");
    assert.ok(i > 0);
    assert.ok(i < rec.indexOf("Gerado em (informado pelo iFood)"));
    assert.ok(i < rec.indexOf("Reconciliation On Demand"));
  });

  test("competência consultada vem do resultado (eco do backend), não do campo do formulário", () => {
    const f = corpo("blocoCompetenciaReconciliation");
    assert.match(f, /derivarCompetenciaReconciliation\(r, \{ homologacao: statusApi\?\.financialHomologacao === true \}\)/);
    assert.match(f, /Competência consultada/);
    assert.match(f, /Competência dos registros no arquivo/);
    assert.doesNotMatch(f, /rec\.competencia/);
  });

  test("divergência em homologação explica o arquivo de exemplo; fora dela, alerta", () => {
    const f = corpo("blocoCompetenciaReconciliation");
    assert.match(f, /c\.situacao === "amostra"/);
    assert.match(f, /A Central consultou \$\{consultada\}/);
    assert.match(f, /arquivo de exemplo com competência de referência própria/);
    assert.match(f, /sem conversão de competência/);
    assert.match(f, /não representam movimentação financeira real/);
    assert.match(f, /c\.situacao === "divergente"/);
    assert.match(f, /ifood-aviso bad/);
  });

  test("aviso geral de homologação não afirma mais que o arquivo é 'desta competência'", () => {
    const f = corpo("avisoAmostraReconciliation");
    assert.doesNotMatch(f, /desta competência/);
    assert.match(f, /pode ter competência de referência diferente da consultada/);
  });

  test("modal 'Ver todos' titula pela competência CONSULTADA do resultado", () => {
    assert.match(IFOOD, /competência consultada \$\{fmtCompetencia\(rec\.resultado\.competencia \?\? rec\.competencia\)\}/);
  });
});
