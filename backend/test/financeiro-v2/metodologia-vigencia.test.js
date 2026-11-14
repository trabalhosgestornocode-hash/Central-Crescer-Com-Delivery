// Execução 08D — regressão dos "três fechamentos recusados" do gerador de desempenho: competências ANTERIORES à vigência
// da metodologia publicada (DRE_GERENCIAL_SEM_AJUSTE_DE_ESTOQUE v1, vigente desde 2026-01) não podem nem entrar em
// fechamento preliminar. A recusa é a regra, não defeito. Dados sintéticos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { montarComCadastros } from "./helpers/cenario.js";

test("08D — fechamento antes da vigência da metodologia é recusado (2025-10..12); a partir de 2026-01 é aceito", async () => {
  const { nucleo: n, c } = await montarComCadastros();
  for (const competencia of ["2025-10", "2025-11", "2025-12"]) {
    await assert.rejects(n.alterarEstadoDaCompetencia(c, { competencia, novoEstado: "FECHAMENTO_PRELIMINAR" }), (e) => e.codigo === CODIGO.TRANSICAO_INVALIDA && /metodologia vigente/.test(e.message));
    assert.equal((await n.consultarFechamento(c, { competencia })).estado, "ABERTA", "nada mudou");
  }
  const r = await n.alterarEstadoDaCompetencia(c, { competencia: "2026-01", novoEstado: "FECHAMENTO_PRELIMINAR" });
  assert.equal(r.estado, "FECHAMENTO_PRELIMINAR");
});
