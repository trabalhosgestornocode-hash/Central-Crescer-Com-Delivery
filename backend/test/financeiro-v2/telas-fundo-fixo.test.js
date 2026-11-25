// Regressão do PR #226: o campo do fundo fixo existe SÓ na identificação da unidade; Documentos e Canais renderizam sem ele.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as T from "../../../frontend/financeiro-v2/telasAdministracao.js";

test("TF-1 Documentos renderiza e não tem campo de fundo fixo", () => {
  const html = T.documentos({ paginacao: { total: 0 }, itens: [], podeAbrir: false }, {});
  assert.ok(!html.includes("fundoFixoCaixa"));
});

test("TF-2 o campo do fundo fixo aparece uma única vez no arquivo (formulário da unidade)", () => {
  const src = readFileSync(new URL("../../../frontend/financeiro-v2/telasAdministracao.js", import.meta.url), "utf8");
  assert.equal(src.split('name="fundoFixoCaixa"').length - 1, 1);
});
