// MOVA — 27/11/2026: o grupo financeiro COMPARTILHADO por duas empresas (multiempresa, 25/11) volta a ser o destino dos avisos de cada
// uma. Regressão do caso Açaí/Subway: depois de 25/11 17:11 todos os avisos ficaram SEM_GRUPO_DA_UNIDADE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarAuxiliaresDeUnidade } from "../../src/modules/mova-financeiro/aplicacao/unidadesDoMova.js";

const A = "4d3b75bd-79b5-4335-ae5b-a183580c3555", S = "00000000-0000-0000-0000-0000000000a1", X = "99999999-0000-4000-8000-000000000001";
const g = (grupoId, unidades, extra = {}) => ({ grupoId, unidades, privada: false, entregador: false, politicaResposta: "GRUPO_FINANCEIRO", ...extra });
const aux = (grupos, avisosNoGrupo = {}) => criarAuxiliaresDeUnidade({ cfg: { identidadeServico: { usuarioId: "u" }, unidades: [], gruposAutorizados: grupos }, avisosNoGrupo });

test("GM1 grupo exclusivo continua valendo; compartilhado COM a marca serve às duas empresas; sem a marca, não", () => {
  assert.equal(aux([g("a@g.us", [A])]).grupoDaUnidade(A).grupoId, "a@g.us");
  const compart = [g("c@g.us", [A, S], { multiempresa: true })];
  assert.equal(aux(compart).grupoDaUnidade(A).grupoId, "c@g.us");
  assert.equal(aux(compart).grupoDaUnidade(S).grupoId, "c@g.us");
  assert.equal(aux(compart).grupoDaUnidade(X), null, "outra unidade nunca");
  assert.equal(aux([g("c@g.us", [A, S])]).grupoDaUnidade(A), null, "sem a marca multiempresa: não");
});

test("GM2 ambiguidade nunca escolhe: dois grupos candidatos ⇒ nenhum; exclusivo tem prioridade; grupo de resposta restrita/privado não conta", () => {
  assert.equal(aux([g("c1@g.us", [A, S], { multiempresa: true }), g("c2@g.us", [A, S], { multiempresa: true })]).grupoDaUnidade(A), null);
  assert.equal(aux([g("a@g.us", [A]), g("c@g.us", [A, S], { multiempresa: true })]).grupoDaUnidade(A).grupoId, "a@g.us");
  assert.equal(aux([g("a1@g.us", [A]), g("a2@g.us", [A])]).grupoDaUnidade(A), null);
  assert.equal(aux([g("c@g.us", [A, S], { multiempresa: true, politicaResposta: "SOMENTE_CONSULTA" })]).grupoDaUnidade(A), null);
  assert.equal(aux([g("c@g.us", [A, S], { multiempresa: true, privada: true })]).grupoDaUnidade(A), null);
});
