// Produtos / CMV 2.0 — motor puro: custo zero declarado, aproveitamento, revisão de rendimentos, precificação,
// elegibilidade, recuperação de ficha e perfil de operação. Sem banco.
import { test } from "node:test";
import assert from "node:assert/strict";
import { calcularAproveitamento } from "../src/modules/produtos/aproveitamento.js";
import { hipoteseRendimento, previaRevisaoRendimentos, validarLoteRendimentos } from "../src/modules/produtos/revisaoRendimento.js";
import { simularPreco } from "../src/modules/produtos/precificacao.js";
import { diagnosticarOrganizacao, elegibilidadeHomologacao, dimensoesDaFicha } from "../src/modules/produtos/diagnostico.js";
import { statusFicha, naturezaCusto } from "../src/modules/insumos/insumos.calc.js";
import { custoTotalProduto, lerTudo } from "../src/modules/produtos/custo.js";
import { montarRecuperacao, perfilOperacao, validarRascunho, ETAPAS_POR_NATUREZA } from "../src/modules/produtos/produtosCmv.service.js";

function grafo({ insumos = [], produtos = [], ficha = [] }) {
  const fichaByProd = new Map();
  for (const f of ficha) { if (!fichaByProd.has(f.produto_id)) fichaByProd.set(f.produto_id, []); fichaByProd.get(f.produto_id).push(f); }
  const m = (k) => new Map(produtos.map((p) => [p.id, p[k]]));
  return { insumoById: new Map(insumos.map((i) => [i.id, i])), nomeProdById: m("nome"), fichaByProd, produtos,
    rendimentoById: m("rendimento"), homologacaoById: m("homologacao"), homologadoCustoById: m("homologado_custo"),
    homologacaoMotivoById: m("homologacao_motivo"), unidadeRendimentoById: m("unidade_rendimento") };
}

// ---------------------------------------------------------------- D1
test("custo zero declarado ≠ desconhecido ≠ informado", () => {
  assert.equal(naturezaCusto({ preco_unitario: 0 }), "desconhecido");
  assert.equal(naturezaCusto({ preco_unitario: null }), "desconhecido");
  assert.equal(naturezaCusto({ preco_unitario: 0, custo_zero_declarado: true }), "zero_declarado");
  assert.equal(naturezaCusto({ preco_unitario: 0.02 }), "informado");
  assert.equal(statusFicha({ componentes: [{ custoUnitarioBase: 0 }] }).chave, "insumo_sem_custo");
  assert.equal(statusFicha({ componentes: [{ custoUnitarioBase: 0, custoZeroDeclarado: true }] }).chave, "completa");
});

test("água declarada como zero deixa de ser causa-raiz; outras pendências continuam (não promete regularizar tudo)", () => {
  const base = { insumos: [{ id: "agua", nome: "AGUA", unidade_medida: "ml", preco_unitario: 0 }, { id: "x", nome: "X", unidade_medida: "g", preco_unitario: 0 }],
    produtos: [{ id: "a", nome: "A", tipo: "bebida" }, { id: "b", nome: "B", tipo: "bebida" }],
    ficha: [{ produto_id: "a", insumo_id: "agua", quantidade: 200 }, { produto_id: "b", insumo_id: "agua", quantidade: 200 }, { produto_id: "b", insumo_id: "x", quantidade: 5 }] };
  const antes = diagnosticarOrganizacao(grafo(base));
  assert.equal(antes.causasRaiz.find((c) => c.alvo.id === "agua").qtd_impactados, 2);
  base.insumos[0].custo_zero_declarado = true;
  const depois = diagnosticarOrganizacao(grafo(base));
  assert.ok(!depois.causasRaiz.some((c) => c.alvo.id === "agua"));
  assert.equal(depois.produtos.find((p) => p.id === "a").pendencias.length, 0);
  assert.ok(depois.produtos.find((p) => p.id === "b").pendencias.some((x) => x.codigo === "insumo_sem_custo"), "B ainda depende de X sem custo");
  assert.equal(depois.resumo.insumos_custo_zero_declarado, 1);
});

// ---------------------------------------------------------------- D3
test("aproveitamento: FC derivado dos pesos, contradição recusada, perda duplicada recusada", () => {
  const r = calcularAproveitamento({ pesoBruto: 1000, pesoLiquido: 620, precoUnitarioBase: 0.08 });
  assert.ok(r.ok); assert.ok(Math.abs(r.fator_correcao - 1000 / 620) < 1e-12);
  assert.ok(Math.abs(r.aproveitamento_pct - 62) < 1e-9); assert.equal(r.perda_limpeza, 380); assert.equal(r.quantidade_cobrada, 1000);
  assert.ok(Math.abs(r.custo_por_unidade_aproveitavel - 0.08 * 1000 / 620) < 1e-12, "custo efetivo do grama aproveitável");
  assert.ok(!calcularAproveitamento({ pesoBruto: 1000, pesoLiquido: 620, fatorCorrecao: 1.2 }).ok, "FC contraditório");
  assert.ok(!calcularAproveitamento({ pesoBruto: 500, pesoLiquido: 600 }).ok, "líquido > bruto");
  assert.ok(!calcularAproveitamento({ pesoLiquido: 540, aproveitamentoPct: 60, fatorCorrecaoNoPrecoDoInsumo: 1.3 }).ok, "perda já no preço do insumo");
  const porPct = calcularAproveitamento({ pesoLiquido: 540, aproveitamentoPct: 60 });
  assert.ok(Math.abs(porPct.peso_bruto - 900) < 1e-9, "bruto = líquido × FC (60% → 900 g)");
  const coc = calcularAproveitamento({ pesoBruto: 900, pesoLiquido: 540, indiceCoccao: 0.8 });
  assert.ok(Math.abs(coc.peso_pronto - 432) < 1e-9, "rendimento após preparo");
  const legado = calcularAproveitamento({});
  assert.ok(legado.ok && legado.fator_correcao === null && legado.quantidade_cobrada === null, "linha antiga sem pesos: nada é inventado");
});

// ---------------------------------------------------------------- D2
test("hipóteses de rendimento: kg→g só com fundamento; PEIXE GRELHADO (1,4 para 560 g) NÃO recebe 1.400 g", () => {
  assert.equal(hipoteseRendimento({ rendimento: 2.6, unidade: "g", massa: 2700 }).confianca, "alta");
  assert.equal(hipoteseRendimento({ rendimento: 2.6, unidade: "g", massa: 2700 }).sugestao, 2600);
  const salmao = hipoteseRendimento({ rendimento: 1.4, unidade: "g", massa: 560 });
  assert.equal(salmao.sugestao, null); assert.equal(salmao.confianca, "nenhuma");
  assert.match(salmao.causa, /pesagem/);
  assert.equal(hipoteseRendimento({ rendimento: 1.2, unidade: "g", massa: 2000 }).confianca, "media");
});

const lojaDoces = () => grafo({
  insumos: [{ id: "lc", nome: "LC", unidade_medida: "g", preco_unitario: 0.015 }, { id: "sal", nome: "PEIXE", unidade_medida: "g", preco_unitario: 0.09 }],
  produtos: [
    { id: "cb", nome: "CREME BASE", tipo: "submontagem", vendavel: false, rendimento: 2.6, unidade_rendimento: "g", homologacao: "pendente" },
    { id: "bolo", nome: "BOLO", tipo: "sobremesa", rendimento: 1, homologacao: "pendente" },
    { id: "sg", nome: "PEIXE GRELHADO", tipo: "submontagem", vendavel: false, rendimento: 1.4, unidade_rendimento: "g", homologacao: "pendente" },
    { id: "sw", nome: "RECHEIO SUBWAY", tipo: "submontagem", rendimento: 0.001, unidade_rendimento: "g", homologacao: "nao_aplicavel" },
  ],
  ficha: [
    { produto_id: "cb", insumo_id: "lc", quantidade: 2700 }, { produto_id: "bolo", subproduto_id: "cb", quantidade: 400 },
    { produto_id: "sg", insumo_id: "sal", quantidade: 560 }, { produto_id: "sw", insumo_id: "lc", quantidade: 100 },
  ],
});

test("prévia de rendimentos: custo antes/depois, dependentes e impacto financeiro; sem alterar o grafo; franquia fora", () => {
  const g = lojaDoces();
  const custoAntes = custoTotalProduto("bolo", g);
  const itens = previaRevisaoRendimentos(g);
  assert.deepEqual(itens.map((i) => i.nome).sort(), ["CREME BASE", "PEIXE GRELHADO"], "Subway (nao_aplicavel) nunca entra");
  const q = itens.find((i) => i.nome === "CREME BASE");
  assert.equal(q.dependentes, 1); assert.equal(q.confianca, "alta");
  assert.ok(Math.abs(q.custo_unitario_depois - 2700 * 0.015 / 2600) < 1e-12);
  assert.ok(q.reducao_custo_dependentes > 0);
  assert.equal(custoTotalProduto("bolo", g), custoAntes, "a prévia restaura o grafo");
  const s = itens.find((i) => i.nome === "PEIXE GRELHADO");
  assert.equal(s.rendimento_proposto, null, "sem sugestão automática");
  const editado = previaRevisaoRendimentos(g, { sobrescritas: new Map([["sg", 430]]) }).find((i) => i.nome === "PEIXE GRELHADO");
  assert.equal(editado.rendimento_proposto, 430); assert.ok(editado.editado);
});

test("validação do lote: justificativa, concorrência, fora da prévia, repetido e valor ainda implausível", () => {
  const previa = previaRevisaoRendimentos(lojaDoces());
  const ok = { produto_id: "cb", rendimento_atual: 2.6, rendimento_novo: 2600, justificativa: "pesado 28/11" };
  assert.deepEqual(validarLoteRendimentos([ok], previa), []);
  assert.equal(validarLoteRendimentos([{ ...ok, justificativa: "" }], previa).length, 1);
  assert.equal(validarLoteRendimentos([{ ...ok, rendimento_atual: 3 }], previa).length, 1);
  assert.equal(validarLoteRendimentos([{ ...ok, produto_id: "sw" }], previa).length, 1);
  assert.equal(validarLoteRendimentos([ok, ok], previa).length, 1);
  assert.equal(validarLoteRendimentos([{ ...ok, rendimento_novo: 5 }], previa).length, 1, "5 g continua implausível");
  assert.deepEqual(validarLoteRendimentos([{ ...ok, rendimento_novo: 5, confirmar_implausivel: true }], previa), []);
  assert.equal(validarLoteRendimentos([], previa).length, 1);
});

// ---------------------------------------------------------------- precificação
test("simulador: CMV, margem bruta, margem de contribuição (não lucro), preço para meta; nunca grava", () => {
  const cond = { comissao: 0.23, taxas: 0.015, promocao: 0.05, tributos: 0.04, outras_deducoes: [{ nome: "Embalagem", pct: 0.01 }], entrega_responsavel: "loja", entrega_custo: 6.5 };
  const r = simularPreco({ custo: 9, preco: 30, metaCmv: 0.3, condicao: cond, margemContribuicaoAlvo: 0.2 });
  assert.equal(r.cmv_pct, 30); assert.equal(r.margem_bruta, 21);
  assert.ok(Math.abs(r.deducoes_pct - 0.345) < 1e-12);
  assert.ok(Math.abs(r.margem_contribuicao - (30 - 9 - 30 * 0.345 - 6.5)) < 1e-9);
  assert.equal(r.preco_para_meta_cmv, 30);
  assert.ok(Math.abs(r.preco_para_margem_alvo - (9 + 6.5) / (1 - 0.345 - 0.2)) < 1e-9);
  assert.equal(simularPreco({ custo: 9, preco: 30, condicao: { ...cond, entrega_responsavel: "plataforma" } }).deducoes_fixas, 0, "entrega da plataforma não é custo fixo da loja");
  assert.equal(simularPreco({ custo: null, preco: 30 }).disponivel, false, "sem custo confiável não precifica");
  assert.ok(simularPreco({ custo: 9, preco: 30 }).avisos.length, "sem condições do canal avisa");
  assert.ok(simularPreco({ custo: 9, preco: 30, condicao: cond, margemContribuicaoAlvo: 0.7 }).preco_para_margem_alvo === null);
  assert.ok(simularPreco({ custo: 29, preco: 30, condicao: cond }).avisos.some((a) => /negativa/.test(a)));
});

// ---------------------------------------------------------------- homologação / dimensões
test("elegibilidade: crítico e carga bloqueiam; preço não é exigido; franquia fora do fluxo", () => {
  const g = lojaDoces();
  const d = diagnosticarOrganizacao(g, { pendenciasCarga: (id) => (id === "bolo" ? [{ codigo: "componente_nao_encontrado" }] : []) });
  const porId = Object.fromEntries(d.produtos.map((p) => [p.id, p]));
  assert.equal(elegibilidadeHomologacao(porId["cb"]).elegivel, false);
  assert.equal(elegibilidadeHomologacao(porId.bolo).elegivel, false);
  assert.match(elegibilidadeHomologacao(porId.sw).motivos[0], /padronizada/);
  const limpo = diagnosticarOrganizacao(grafo({ insumos: [{ id: "i", unidade_medida: "un", preco_unitario: 2 }], produtos: [{ id: "p", tipo: "sobremesa", homologacao: "pendente" }], ficha: [{ produto_id: "p", insumo_id: "i", quantidade: 1 }] }),
    { precoVendaPorProduto: new Map([["outro", 10]]) }).produtos[0];
  assert.ok(limpo.pendencias.some((x) => x.codigo === "sem_preco_venda"));
  assert.equal(elegibilidadeHomologacao(limpo).elegivel, true, "concluível sem preço");
  assert.deepEqual(dimensoesDaFicha(limpo, { temPreco: false, temCondicoesCanal: true }),
    { receita_completa: true, custo_confiavel: true, preco_comercial: false, cmv_disponivel: false, rentabilidade_disponivel: false });
});

// ---------------------------------------------------------------- assistente
test("recuperação de ficha antiga: aproveita o válido e aponta só as etapas pendentes", () => {
  const g = lojaDoces(); const d = diagnosticarOrganizacao(g);
  const r = montarRecuperacao("cb", g, d.produtos.find((p) => p.id === "cb"));
  assert.equal(r.natureza, "preparacao");
  assert.ok(!r.etapas.some((e) => e.etapa === "precos"), "preparação não pede preço");
  assert.equal(r.proxima_etapa, "porcionamento");
  assert.equal(r.etapas.find((e) => e.etapa === "ingredientes").estado, "valida");
  assert.equal(r.etapas.find((e) => e.etapa === "revisao").estado, "bloqueada");
  assert.equal(r.dados.ingredientes.length, 1);
  const bolo = montarRecuperacao("bolo", g, d.produtos.find((p) => p.id === "bolo"));
  assert.equal(bolo.proxima_etapa, "ingredientes", "preparação comprometida aponta para ingredientes");
});

test("rascunho: natureza/etapa validadas; revenda sem etapa de ingredientes", () => {
  assert.throws(() => validarRascunho({ natureza: "x" }), /Natureza/);
  assert.throws(() => validarRascunho({ natureza: "revenda", etapa: "ingredientes" }), /Etapa/);
  assert.deepEqual(validarRascunho({ natureza: "preparacao", etapa: "porcionamento", dados: { a: 1 } }), { natureza: "preparacao", etapa: "porcionamento", dados: { a: 1 } });
  assert.ok(!ETAPAS_POR_NATUREZA.preparacao.includes("precos"));
});

test("perfil de operação vem dos DADOS: franquia padronizada sem assistente; unidade vazia = sem_catalogo", () => {
  assert.equal(perfilOperacao(grafo({ produtos: [{ id: "a", homologacao: "nao_aplicavel" }] })).modelo, "franquia_padronizada");
  assert.equal(perfilOperacao(grafo({ produtos: [{ id: "a", homologacao: "nao_aplicavel" }] })).recursos.assistente_receitas, false);
  assert.equal(perfilOperacao(grafo({ produtos: [{ id: "a", homologacao: "pendente", tipo: "submontagem" }] })).modelo, "marca_propria");
  assert.equal(perfilOperacao(grafo({})).modelo, "sem_catalogo");
});

test("motor: kg/g, custo por kg, porcionamento, cascata em 3 níveis e soma sem arredondar", () => {
  const g = grafo({
    insumos: [{ id: "farinha", unidade_medida: "kg", preco_unitario: 5.4 }, { id: "ovo", unidade_medida: "un", preco_unitario: 0.75 }, { id: "sal", unidade_medida: "g", preco_unitario: 0.000123 }],
    produtos: [
      { id: "massa", tipo: "submontagem", rendimento: 1.2, unidade_rendimento: "kg" }, // lote rende 1,2 kg
      { id: "base", tipo: "submontagem", rendimento: 600, unidade_rendimento: "g" },
      { id: "torta", tipo: "outro", rendimento: 8 },                                     // 8 fatias
    ],
    ficha: [
      { produto_id: "massa", insumo_id: "farinha", quantidade: 1 }, { produto_id: "massa", insumo_id: "ovo", quantidade: 4 }, { produto_id: "massa", insumo_id: "sal", quantidade: 7 },
      { produto_id: "base", subproduto_id: "massa", quantidade: 0.5 },   // 0,5 kg da massa
      { produto_id: "torta", subproduto_id: "base", quantidade: 600 },   // a base inteira
    ],
  });
  const loteMassa = 5.4 + 4 * 0.75 + 7 * 0.000123;
  assert.ok(Math.abs(custoTotalProduto("massa", g) - loteMassa / 1.2) < 1e-12, "custo por kg = lote ÷ rendimento em kg");
  assert.ok(Math.abs(custoTotalProduto("base", g) - (0.5 * loteMassa / 1.2) / 600) < 1e-15, "custo por grama da base");
  assert.ok(Math.abs(custoTotalProduto("torta", g) - (0.5 * loteMassa / 1.2) / 8) < 1e-12, "custo por fatia (porcionamento) atravessa 3 níveis");
  // sem arredondamento prematuro: 1.000 componentes de R$ 0,000123 somam exatamente 0,123 (não 0)
  const g2 = grafo({ insumos: [{ id: "s", unidade_medida: "g", preco_unitario: 0.000123 }], produtos: [{ id: "p", rendimento: 1 }], ficha: Array.from({ length: 1000 }, () => ({ produto_id: "p", insumo_id: "s", quantidade: 1 })) });
  assert.ok(Math.abs(custoTotalProduto("p", g2) - 0.123) < 1e-12);
});

test("Subway (rendimento 1, sem unidade, homologacao nao_aplicavel): custo idêntico à fórmula legada e nenhuma pendência nova", () => {
  const g = grafo({
    insumos: [{ id: "pao", unidade_medida: "un", preco_unitario: 1.25 }, { id: "frango", unidade_medida: "kg", preco_unitario: 30 }],
    produtos: [{ id: "rech", tipo: "submontagem", rendimento: null, homologacao: "nao_aplicavel" }, { id: "sand", tipo: "sanduiche", rendimento: null, homologacao: "nao_aplicavel" }],
    ficha: [{ produto_id: "rech", insumo_id: "frango", quantidade: 0.076 }, { produto_id: "sand", subproduto_id: "rech", quantidade: 2 }, { produto_id: "sand", insumo_id: "pao", quantidade: 1 }],
  });
  assert.ok(Math.abs(custoTotalProduto("sand", g) - (2 * 0.076 * 30 + 1.25)) < 1e-12, "mesma conta da fn_custo_produto (rendimento ausente = 1)");
  const d = diagnosticarOrganizacao(g);
  assert.deepEqual(d.produtos.map((p) => p.situacao), ["padronizada", "padronizada"]);
  assert.equal(d.causasRaiz.length, 0);
});

test("lerTudo pagina além de 1.000 linhas (bug do grafo truncado)", async () => {
  const dados = Array.from({ length: 2375 }, (_, i) => i);
  const pedidos = [];
  const r = await lerTudo(async (de, ate) => { pedidos.push([de, ate]); return { data: dados.slice(de, ate + 1), error: null }; });
  assert.equal(r.data.length, 2375); assert.equal(pedidos.length, 3);
  const e = await lerTudo(async () => ({ data: null, error: { message: "x" } }));
  assert.equal(e.error.message, "x");
});
