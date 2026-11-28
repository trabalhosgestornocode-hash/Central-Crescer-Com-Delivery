// Motor de diagnóstico das fichas e leitura numérica pt-BR — puro, sem banco.
import { test } from "node:test";
import assert from "node:assert/strict";
import { avaliarRendimento, diagnosticarOrganizacao, massaDoLote, produtosEmCiclo } from "../src/modules/produtos/diagnostico.js";
import { lerNumeroBR, dividirSeguro, converterQuantidade, custoUnitario } from "../src/modules/insumos/insumos.calc.js";
import { custoTotalProduto } from "../src/modules/produtos/custo.js";

/** Grafo no formato de carregarGrafo(). */
function grafo({ insumos = [], produtos = [], ficha = [] }) {
  const fichaByProd = new Map();
  for (const f of ficha) { if (!fichaByProd.has(f.produto_id)) fichaByProd.set(f.produto_id, []); fichaByProd.get(f.produto_id).push(f); }
  const m = (k) => new Map(produtos.map((p) => [p.id, p[k]]));
  return {
    insumoById: new Map(insumos.map((i) => [i.id, i])), nomeProdById: m("nome"), fichaByProd, produtos,
    rendimentoById: m("rendimento"), homologacaoById: m("homologacao"), homologadoCustoById: m("homologado_custo"),
    homologacaoMotivoById: m("homologacao_motivo"), unidadeRendimentoById: m("unidade_rendimento"),
  };
}

// Cenário sintético do erro real de importação: 4 insumos em g, rendimento 2,6 "g".
const quatroLeites = () => grafo({
  insumos: [
    { id: "lc", nome: "INSUMO A", unidade_medida: "g", preco_unitario: 0.015 },
    { id: "cl", nome: "CREME DE LEITE", unidade_medida: "g", preco_unitario: 0.016 },
    { id: "co", nome: "LEITE DE COCO", unidade_medida: "g", preco_unitario: 0.021 },
    { id: "lp", nome: "INSUMO D", unidade_medida: "g", preco_unitario: 0.04 },
    { id: "sc", nome: "SEM CUSTO", unidade_medida: "g", preco_unitario: null },
  ],
  produtos: [
    { id: "cb", nome: "CREME BASE", tipo: "submontagem", vendavel: false, rendimento: 2.6, unidade_rendimento: "g", homologacao: "pendente" },
    { id: "bolo", nome: "BOLO BASE", tipo: "sobremesa", rendimento: 1, unidade_rendimento: null, homologacao: "pendente" },
    { id: "fatia", nome: "FATIA BOLO", tipo: "sobremesa", rendimento: 1, homologacao: "pendente" },
  ],
  ficha: [
    { id: "a", produto_id: "cb", insumo_id: "lc", quantidade: 1200 },
    { id: "b", produto_id: "cb", insumo_id: "cl", quantidade: 700 },
    { id: "c", produto_id: "cb", insumo_id: "co", quantidade: 600 },
    { id: "d", produto_id: "cb", insumo_id: "lp", quantidade: 300 },
    { id: "e", produto_id: "bolo", subproduto_id: "cb", quantidade: 400 },
    { id: "f", produto_id: "fatia", subproduto_id: "bolo", quantidade: 0.1 },
  ],
});

test("CREME BASE: reproduz o custo por grama inflado e detecta rendimento em kg digitado como g, sugerindo 2600 g", () => {
  const g = quatroLeites();
  const lote = [...g.fichaByProd.get("cb")].reduce((s, f) => s + f.quantidade * g.insumoById.get(f.insumo_id).preco_unitario, 0);
  assert.ok(Math.abs(custoTotalProduto("cb", g) - lote / 2.6) < 1e-9, "lote ÷ 2,6 (custo por grama ~1.000× maior)");
  const d = diagnosticarOrganizacao(g);
  const raiz = d.causasRaiz.find((c) => c.codigo === "rendimento_unidade_suspeita");
  assert.equal(raiz.alvo.id, "cb");
  assert.equal(raiz.detalhe.sugestao, 2600);
  assert.equal(raiz.qtd_impactados, 3, "a preparação + bolo + fatia (cascata)");
  assert.equal(d.produtos.find((p) => p.id === "fatia").situacao, "incompleta");
  assert.ok(d.produtos.find((p) => p.id === "fatia").pendencias.some((x) => x.codigo === "preparacao_comprometida"));
  // Com o rendimento correto o custo por grama fica ~R$ 0,02 e a pendência some.
  g.rendimentoById.set("cb", 2600); g.produtos[0].rendimento = 2600;
  assert.ok(Math.abs(custoTotalProduto("cb", g) - lote / 2600) < 1e-12);
  assert.equal(diagnosticarOrganizacao(g).causasRaiz.length, 0);
});

test("rendimento: expansão alta é aviso; poucos itens comparáveis não acusam; unidade discreta não avalia", () => {
  assert.equal(avaliarRendimento({ rendimento: 4000, unidade: "g", massa: 400, comparaveis: 3, total: 3 }).codigo, "rendimento_expansao_alta");
  assert.equal(avaliarRendimento({ rendimento: 1, unidade: "g", massa: 900, comparaveis: 1, total: 5 }), null);
  assert.equal(avaliarRendimento({ rendimento: 1, unidade: "un", massa: 900, comparaveis: 3, total: 3 }), null);
  assert.equal(avaliarRendimento({ rendimento: 2400, unidade: "g", massa: 2410, comparaveis: 3, total: 3 }), null);
});

test("massa do lote converte kg→g e ignora massa↔volume (sem fator explícito)", () => {
  const g = grafo({
    insumos: [{ id: "k", unidade_medida: "kg", preco_unitario: 10 }, { id: "m", unidade_medida: "ml", preco_unitario: 1 }],
    produtos: [{ id: "p", tipo: "submontagem", rendimento: 1, unidade_rendimento: "g" }],
    ficha: [{ produto_id: "p", insumo_id: "k", quantidade: 1.5 }, { produto_id: "p", insumo_id: "m", quantidade: 200 }],
  });
  assert.deepEqual(massaDoLote("p", g), { massa: 1500, comparaveis: 1, total: 2 });
});

test("insumo sem custo vira UMA causa-raiz com todos os impactados; não presume zero", () => {
  const g = quatroLeites();
  g.fichaByProd.get("bolo").push({ id: "x", produto_id: "bolo", insumo_id: "sc", quantidade: 10 });
  g.fichaByProd.get("fatia").push({ id: "y", produto_id: "fatia", insumo_id: "sc", quantidade: 5 });
  const raiz = diagnosticarOrganizacao(g).causasRaiz.find((c) => c.codigo === "insumo_sem_custo");
  assert.deepEqual(raiz.diretos.sort(), ["bolo", "fatia"]);
  assert.equal(raiz.qtd_impactados, 2);
});

test("ciclo entre preparações é detectado", () => {
  const g = grafo({
    produtos: [{ id: "a", tipo: "submontagem" }, { id: "b", tipo: "submontagem" }, { id: "c", tipo: "sobremesa" }],
    ficha: [{ produto_id: "a", subproduto_id: "b", quantidade: 1 }, { produto_id: "b", subproduto_id: "a", quantidade: 1 }, { produto_id: "c", subproduto_id: "a", quantidade: 1 }],
  });
  assert.deepEqual([...produtosEmCiclo(g)].sort(), ["a", "b"]);
  assert.equal(diagnosticarOrganizacao(g).produtos.find((p) => p.id === "a").situacao, "inconsistente");
});

test("franquia (homologacao nao_aplicavel): preparação sem unidade não acusa e situação é 'padronizada'", () => {
  const g = grafo({
    insumos: [{ id: "i", unidade_medida: "kg", preco_unitario: 30 }],
    produtos: [{ id: "s", tipo: "submontagem", rendimento: 1, unidade_rendimento: null, homologacao: "nao_aplicavel" }],
    ficha: [{ produto_id: "s", insumo_id: "i", quantidade: 0.076 }],
  });
  const p = diagnosticarOrganizacao(g).produtos[0];
  assert.equal(p.situacao, "padronizada");
  assert.equal(p.pendencias.length, 0);
});

test("sem preço de venda só para vendáveis finais quando há tabela de preços", () => {
  const g = quatroLeites();
  const d = diagnosticarOrganizacao(g, { precoVendaPorProduto: new Map([["bolo", 59.9]]) });
  assert.ok(d.produtos.find((p) => p.id === "fatia").pendencias.some((x) => x.codigo === "sem_preco_venda"));
  assert.ok(!d.produtos.find((p) => p.id === "cb").pendencias.some((x) => x.codigo === "sem_preco_venda"), "preparação não exige preço");
});

test("lerNumeroBR: vírgula decimal, milhar com ponto, ambiguidade sinalizada", () => {
  assert.deepEqual(lerNumeroBR("1.234,56"), { valor: 1234.56, ambiguo: false });
  assert.deepEqual(lerNumeroBR("0,0151"), { valor: 0.0151, ambiguo: false });
  assert.deepEqual(lerNumeroBR("2.600"), { valor: 2600, ambiguo: true });
  assert.deepEqual(lerNumeroBR("R$ 12,90"), { valor: 12.9, ambiguo: false });
  assert.deepEqual(lerNumeroBR("2.5"), { valor: 2.5, ambiguo: true });
  assert.deepEqual(lerNumeroBR("abc"), { valor: null, ambiguo: false });
  assert.deepEqual(lerNumeroBR(""), { valor: null, ambiguo: false });
  assert.deepEqual(lerNumeroBR(2.6), { valor: 2.6, ambiguo: false });
  assert.deepEqual(lerNumeroBR("1,2,3"), { valor: null, ambiguo: false });
});

test("divisão segura e conversões incompatíveis", () => {
  assert.equal(dividirSeguro(12.9, 0), null);
  assert.equal(dividirSeguro(12.9, null), null);
  assert.equal(dividirSeguro(12.9, 2600), 12.9 / 2600);
  assert.throws(() => converterQuantidade(1, "g", "ml"), /incompatíveis/);
  assert.equal(converterQuantidade(0.2, "kg", "g"), 200);
  assert.equal(custoUnitario({ precoCompra: 5.9, quantidadeEmbalagem: 395 }), 5.9 / 395, "sem arredondar custo pequeno");
  assert.equal(custoUnitario({ precoCompra: null, quantidadeEmbalagem: 395 }), null);
});
