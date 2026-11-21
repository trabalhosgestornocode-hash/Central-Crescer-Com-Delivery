// MOVA — Execução 14: conjunto de avaliação em modo SIMULADO (leitura ideal). Valida o motor contra o gabarito e o próprio
// gabarito; a rodada real (Haiku) usa os mesmos casos e o mesmo executor (scripts/mova/avaliacaoHaiku.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CASOS } from "./avaliacao/casos.mjs";
import { clienteIdeal, executarAvaliacao } from "./avaliacao/executor.mjs";
import { motivoParaPularMova } from "./helpers/banco.js";

const PULAR = motivoParaPularMova();

test("conjunto de avaliação: ≥ 20 casos, ids únicos, cobertura mínima e ≤ 17 casos na rodada paga", () => {
  assert.ok(CASOS.length >= 20);
  assert.equal(new Set(CASOS.map((c) => c.id)).size, CASOS.length);
  const cobre = CASOS.flatMap((c) => c.cobre).join("|");
  for (const tema of ["despesa paga", "conta a pagar", "recorrente", "receita", "faturamento", "consulta de despesas", "contas a pagar", "contas a receber",
    "unidade identificada", "unidade não identificada", "valor", "competência", "categoria", "incompleta", "ambígua", "duplicidade", "não autorizada",
    "fora do escopo", "saudação", "hipotético"]) assert.match(cobre, new RegExp(tema), tema);
  assert.ok(CASOS.filter((c) => c.real).length <= 17);
  for (const c of CASOS) assert.ok(!/\b(subway|saci|açaí saci|caramelle|jah)\b/i.test(c.texto), `${c.id}: só dados fictícios`);
});

test("avaliação SIMULADA: com leitura ideal, o motor acerta 100% do gabarito (cada critério)", { skip: PULAR }, async () => {
  const { resultados, metricas } = await executarAvaliacao({ criarCliente: clienteIdeal(CASOS), casos: CASOS });
  const falhas = resultados.filter((r) => !r.aprovado).map((r) => `${r.id} ${JSON.stringify(r.criterios)} decisao=${r.decisao}/${r.motivo} propostas=${JSON.stringify(r.propostas)}`);
  assert.deepEqual(falhas, []);
  assert.equal(metricas.aprovados, CASOS.length);
});

test("avaliação: o executor NÃO aprova proposta errada só porque o JSON é válido", { skip: PULAR }, async () => {
  const errado = CASOS.filter((c) => c.id === "C01").map((c) => ({ ...c, ideal: { ...c.ideal, valorCentavos: 15500 } }));
  const { resultados } = await executarAvaliacao({ criarCliente: clienteIdeal(errado), casos: errado });
  const [r] = resultados;
  assert.equal(r.criterios.jsonValido, true);
  assert.equal(r.criterios.valor, false);
  assert.equal(r.criterios.proposta, false);
  assert.equal(r.aprovado, false);
});
