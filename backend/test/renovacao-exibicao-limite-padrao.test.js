// O limite absoluto de renovação do perfil de exibição NÃO pode passar de 8 h por padrão: 20 h só por configuração explícita,
// depois de validar o `amr[].timestamp` do JWT real (docs/verificacao-jwt-supabase-conta-teste.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { lerPoliticaRenovacao } from "../src/shared/renovacaoExibicao.js";

test("padrão conservador: 8 h sem configuração", () => {
  assert.equal(lerPoliticaRenovacao({}).limiteAbsolutoS, 8 * 3600);
});

test("20 h só com RENOVACAO_EXIBICAO_LIMITE_S explícito; valor inválido volta ao padrão conservador", () => {
  assert.equal(lerPoliticaRenovacao({ RENOVACAO_EXIBICAO_LIMITE_S: "72000" }).limiteAbsolutoS, 20 * 3600);
  assert.equal(lerPoliticaRenovacao({ RENOVACAO_EXIBICAO_LIMITE_S: "abc" }).limiteAbsolutoS, 8 * 3600);
  assert.equal(lerPoliticaRenovacao({ RENOVACAO_EXIBICAO_LIMITE_S: "999999" }).limiteAbsolutoS, 24 * 3600);
});
