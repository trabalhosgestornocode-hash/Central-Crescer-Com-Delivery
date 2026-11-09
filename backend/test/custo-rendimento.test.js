// Custo com RENDIMENTO, homologação e mão de obra separada (migration 157) — espelha fn_custo_produto.
import test from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);

const { custoTotalProduto, ingredientesExplodidos, resumoProduto, rendimentoDe, custoMaoDeObraUnitario } =
  await import("../src/modules/produtos/custo.js");

const ins = (id, preco, extra = {}) => [id, { id, nome: id, tipo: "outro", unidade_medida: "g", preco_unitario: preco, ativo: true, ...extra }];
const L = (produto_id, o) => ({ id: `${produto_id}-${o.insumo_id ?? o.subproduto_id}`, produto_id, ativo: true, ...o });

function grafo({ insumos, fichas, rendimentos = {}, homologacao = {} }) {
  const fichaByProd = new Map();
  for (const f of fichas) { if (!fichaByProd.has(f.produto_id)) fichaByProd.set(f.produto_id, []); fichaByProd.get(f.produto_id).push(f); }
  const ids = new Set([...fichaByProd.keys(), ...Object.keys(rendimentos)]);
  return {
    insumoById: new Map(insumos), fichaByProd, nomeProdById: new Map([...ids].map((i) => [i, i])), produtos: [],
    rendimentoById: new Map(Object.entries(rendimentos)), homologacaoById: new Map(Object.entries(homologacao)),
  };
}
const perto = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

test("REGRESSÃO Subway: sem rendimento no grafo (ou rendimento 1) o custo é idêntico ao legado", () => {
  const base = { insumos: [ins("frango", 0.03), ins("pao", 1.25, { unidade_medida: "un" })], fichas: [
    L("rech", { insumo_id: "frango", quantidade: 76 }),
    L("sand", { subproduto_id: "rech", quantidade: 2 }), L("sand", { insumo_id: "pao", quantidade: 1 }),
  ] };
  const legado = custoTotalProduto("sand", grafo(base));
  perto(legado, 2 * 76 * 0.03 + 1.25);
  perto(custoTotalProduto("sand", grafo({ ...base, rendimentos: { rech: 1, sand: 1 } })), legado);
  assert.equal(rendimentoDe("qualquer", grafo(base)), 1);
});
test("rendimento 8: custo unitário = custo do lote / 8", () => {
  const g = grafo({ insumos: [ins("req", 0.0466)], fichas: [L("emp", { insumo_id: "req", quantidade: 200 })], rendimentos: { emp: 8 } });
  perto(custoTotalProduto("emp", g), (200 * 0.0466) / 8);
});
test("rendimento inválido (0, negativo, texto) cai para 1 em vez de dividir por zero", () => {
  for (const r of [0, -3, "abc", null, undefined]) {
    const g = grafo({ insumos: [ins("a", 2)], fichas: [L("p", { insumo_id: "a", quantidade: 5 })], rendimentos: { p: r } });
    assert.equal(custoTotalProduto("p", g), 10);
  }
});
test("preparação por peso: 700 g de base que rende 1554 g, numa torta que rende 4", () => {
  const g = grafo({
    insumos: [ins("req", 0.0466)],
    fichas: [L("base", { insumo_id: "req", quantidade: 200 }), L("torta", { subproduto_id: "base", quantidade: 700 })],
    rendimentos: { base: 1554, torta: 4 },
  });
  perto(custoTotalProduto("torta", g), (700 * ((200 * 0.0466) / 1554)) / 4);
});
test("ingredientesExplodidos é consistente com o custo (Σ qtd×custo = custo × rendimento)", () => {
  const g = grafo({
    insumos: [ins("req", 0.0466), ins("leite", 0.005)],
    fichas: [L("base", { insumo_id: "leite", quantidade: 500 }), L("torta", { subproduto_id: "base", quantidade: 100 }), L("torta", { insumo_id: "req", quantidade: 40 })],
    rendimentos: { base: 500, torta: 4 },
  });
  const soma = ingredientesExplodidos("torta", g).reduce((s, i) => s + i.custo_total, 0);
  perto(soma, custoTotalProduto("torta", g)); // explodidos já estão POR UNIDADE de torta
});
test("linha inativa continua ignorada com rendimento", () => {
  const g = grafo({ insumos: [ins("a", 1)], fichas: [L("p", { insumo_id: "a", quantidade: 10 }), L("p", { insumo_id: "a", quantidade: 90, ativo: false })], rendimentos: { p: 2 } });
  perto(custoTotalProduto("p", g), 5);
});
test("CMV HOMOLOGADO: pendente de homologação não produz CMV homologado", () => {
  const f = (h) => grafo({ insumos: [ins("a", 1)], fichas: [L("p", { insumo_id: "a", quantidade: 3 })], homologacao: h ? { p: h } : {} });
  const pend = resumoProduto({ produtoId: "p", grafo: f("pendente"), precoVenda: 10 });
  assert.equal(pend.cmv_homologado_pct, null); assert.equal(pend.motivo_sem_cmv_homologado, "pendente_homologacao");
  assert.equal(pend.cmv_pct, 30); // o CMV "técnico" continua visível, só não é "homologado"
  const ok = resumoProduto({ produtoId: "p", grafo: f("homologada"), precoVenda: 10 });
  assert.equal(ok.cmv_homologado_pct, 30); assert.equal(ok.motivo_sem_cmv_homologado, null);
  const legado = resumoProduto({ produtoId: "p", grafo: f(null), precoVenda: 10 }); // Subway: sem coluna/valor => nao_aplicavel
  assert.equal(legado.homologacao, "nao_aplicavel"); assert.equal(legado.cmv_homologado_pct, 30);
});
test("CMV HOMOLOGADO: ficha incompleta (insumo sem custo / sem componentes / sem preço) nunca é homologada", () => {
  const semCusto = grafo({ insumos: [ins("a", 0)], fichas: [L("p", { insumo_id: "a", quantidade: 3 })], homologacao: { p: "homologada" } });
  const r1 = resumoProduto({ produtoId: "p", grafo: semCusto, precoVenda: 10 });
  assert.equal(r1.cmv_homologado_pct, null); assert.equal(r1.motivo_sem_cmv_homologado, "ficha_incompleta");
  const vazia = grafo({ insumos: [], fichas: [], rendimentos: { p: 1 }, homologacao: { p: "homologada" } });
  assert.equal(resumoProduto({ produtoId: "p", grafo: vazia, precoVenda: 10 }).motivo_sem_cmv_homologado, "ficha_incompleta");
  const semPreco = grafo({ insumos: [ins("a", 1)], fichas: [L("p", { insumo_id: "a", quantidade: 3 })], homologacao: { p: "homologada" } });
  const r3 = resumoProduto({ produtoId: "p", grafo: semPreco, precoVenda: null });
  assert.equal(r3.cmv_homologado_pct, null); assert.equal(r3.motivo_sem_cmv_homologado, "sem_preco");
});
test("alteração de custo de insumo atualiza o custo derivado (e o rendimento continua valendo)", () => {
  const mk = (preco) => grafo({ insumos: [ins("a", preco)], fichas: [L("p", { insumo_id: "a", quantidade: 100 })], rendimentos: { p: 4 } });
  perto(custoTotalProduto("p", mk(0.01)), 0.25);
  perto(custoTotalProduto("p", mk(0.02)), 0.5);
});
test("mão de obra: indicador à parte; null se faltar custo por minuto (não inventa)", () => {
  perto(custoMaoDeObraUnitario([{ minutos: 10, custo_minuto: 0.2795 }, { minutos: 4, custo_minuto: 0.2 }], 2), (2.795 + 0.8) / 2);
  assert.equal(custoMaoDeObraUnitario([{ minutos: 10, custo_minuto: null }], 2), null);
  assert.equal(custoMaoDeObraUnitario([], 2), 0);
});

// ---- homologação efetiva (invalidação por custo) -----------------------------------------------
const { homologacaoEfetiva, HOMOLOGACAO_TOLERANCIA_CUSTO } = await import("../src/modules/produtos/custo.js");
function gHom(preco, { estado = "homologada", custoHom = 3, motivo = null } = {}) {
  const g = grafo({ insumos: [ins("a", preco)], fichas: [L("p", { insumo_id: "a", quantidade: 100 })], homologacao: { p: estado } });
  g.homologadoCustoById = new Map([["p", custoHom]]); g.homologacaoMotivoById = new Map([["p", motivo]]);
  return g;
}
test("homologação efetiva: dentro da tolerância permanece homologada", () => {
  assert.deepEqual(homologacaoEfetiva("p", gHom(0.03)), { estado: "homologada", motivo: null }); // custo 3,00 = homologado
  assert.deepEqual(homologacaoEfetiva("p", gHom(0.0301)), { estado: "homologada", motivo: null }); // +0,33% < 0,5%
});
test("homologação efetiva: mudança de preço de insumo além de 0,5% invalida (custo_alterado)", () => {
  assert.equal(HOMOLOGACAO_TOLERANCIA_CUSTO, 0.005);
  assert.deepEqual(homologacaoEfetiva("p", gHom(0.0320)), { estado: "pendente", motivo: "custo_alterado" });
  assert.deepEqual(homologacaoEfetiva("p", gHom(0.0250)), { estado: "pendente", motivo: "custo_alterado" }); // para baixo também
});
test("homologação efetiva: pendente traz o motivo gravado; nao_aplicavel (Subways) nunca muda", () => {
  assert.deepEqual(homologacaoEfetiva("p", gHom(0.03, { estado: "pendente", motivo: "composicao_alterada" })), { estado: "pendente", motivo: "composicao_alterada" });
  assert.deepEqual(homologacaoEfetiva("p", gHom(0.5, { estado: "nao_aplicavel" })), { estado: "nao_aplicavel", motivo: null });
});
test("CMV homologado some quando o custo se afasta do homologado", () => {
  const r = resumoProduto({ produtoId: "p", grafo: gHom(0.05), precoVenda: 20 });
  assert.equal(r.homologacao, "pendente"); assert.equal(r.homologacao_motivo, "custo_alterado");
  assert.equal(r.cmv_homologado_pct, null); assert.equal(r.motivo_sem_cmv_homologado, "pendente_homologacao");
});
