// Painel (Visão Geral 2.0), Receitas e DRE de referência com repositório EM MEMÓRIA. Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { painel, receitas, dreReferencia } from "../../src/modules/gestao-financeira/dominio/painel.service.js";
import { classificarCategoria, regrasPadrao } from "../../src/financeiro-calculos/regrasReferencia.js";

const ctx = { organizacaoId: "00000000-0000-4000-8000-000000000001", unidadeId: "00000000-0000-4000-8000-000000000002", usuarioId: "00000000-0000-4000-8000-000000000003" };
const cat = (id, nome, papel) => ({ id, nome, papel, tipo: "X", ativo: true });
const PLANO = [cat("c-rec", "RECEBIMENTO DE CLIENTE", "receita_operacional"), cat("c-ins", "INSUMOS - FRUTAS", "custo_variavel"), cat("c-fre", "FRETE", "custo_variavel"),
  cat("c-sal", "SALARIO", "despesa_pessoal"), cat("c-sim", "SIMPLES NACIONAL", "tributo"), cat("c-emp", "EMPRESTIMO", "financiamento"), cat("c-dia", "DIARIA", "despesa_pessoal")];
const repo = (o = {}) => ({
  listarPlanoContas: async () => PLANO,
  listarContas: async () => [{ id: "k1", nome: "BANCO", ativo: true }],
  listarAberturas: async () => [{ conta_id: "k1", data_referencia: "2026-09-01", valor_centavos: -1000 }],
  listarTodosLancamentos: async () => [
    { id: "l1", conta_id: "k1", categoria_id: "c-rec", sentido: "entrada", valor_centavos: 70000, data_movimento: "2026-09-05", status: "realizado" },
    { id: "l2", conta_id: "k1", categoria_id: "c-sal", sentido: "saida", valor_centavos: 20000, data_movimento: "2026-09-06", status: "realizado" },
  ],
  listarReferencias: async () => [{ tipo: "venda", data: "2026-09-05", valor_centavos: 100000 }, { tipo: "taxa", canal: "IFOOD", data: "2026-09-30", valor_centavos: 3000 }],
  listarObrigacoes: async () => o.obrigacoes ?? [
    { id: "o1", fornecedor_id: "f1", categoria_id: "c-ins", descricao: "frutas", competencia: "2026-09-01", vencimento: "2026-09-10", valor_original_centavos: 30000, status: "aberta" },
    { id: "o2", fornecedor_id: "f1", categoria_id: "c-sal", descricao: "salário", competencia: "2026-08-01", vencimento: "2026-09-05", valor_original_centavos: 20000, status: "aberta" },
    { id: "o3", fornecedor_id: "f1", categoria_id: "c-emp", descricao: "parcela", competencia: "2026-09-01", vencimento: "2026-09-15", valor_original_centavos: 9000, status: "aberta" },
    { id: "o4", fornecedor_id: "f1", categoria_id: "c-sim", descricao: "simples", competencia: "2026-08-01", vencimento: "2026-09-20", valor_original_centavos: 5000, status: "aberta" },
  ],
  listarPagamentos: async () => o.pagamentos ?? [
    { id: "p1", obrigacao_id: "o2", conta_id: "k1", data_pagamento: "2026-09-05", valor_centavos: 20000, status: "ativo" },
    { id: "p2", obrigacao_id: "o3", conta_id: "k1", data_pagamento: "2026-09-15", valor_centavos: 9000, status: "ativo" },
    { id: "p3", obrigacao_id: "o4", conta_id: "k1", data_pagamento: "2026-09-20", valor_centavos: 5050, status: "ativo" },
  ],
  listarFornecedores: async () => [{ id: "f1", nome: "Fornecedor X" }],
  listarVinculosSaidas: async () => [],
  bloqueiosFechamentoRpc: async () => [],
});
const deps = (o) => ({ repo: repo(o), db: undefined, hoje: () => "2026-11-06" });

test("faturamento (vendas registradas) e recebimentos (banco) são indicadores DIFERENTES", async () => {
  const p = await painel(ctx, { mes: "2026-09" }, deps());
  assert.equal(p.indicadores.faturamentoBruto.valorCentavos, 100000);
  assert.equal(p.indicadores.recebimentos.valorCentavos, 70000);
  assert.notEqual(p.indicadores.faturamentoBruto.origem, p.indicadores.recebimentos.origem);
});

test("critério misto: CMV pela competência (valor original), despesa e tributo pelo pagamento, empréstimo fora", async () => {
  const d = await dreReferencia(ctx, { mes: "2026-09" }, deps());
  assert.equal(d.indicadores.cmv, 30000);                       // frutas, competência set, ainda não paga
  assert.equal(d.indicadores.despesasFixas, 20000);             // salário de ago pago em set
  assert.equal(d.indicadores.deducoes, 5050);                   // Simples pelo pagamento (valor pago)
  assert.equal(d.indicadores.faturamentoLiquido, 100000 - 5050);
  assert.equal(d.indicadores.resultadoGerencial, 100000 - 5050 - 30000 - 20000);
  assert.ok(!d.grupos.flatMap((g) => g.linhas).some((l) => l.descricao === "EMPRESTIMO"), "empréstimo nunca entra no resultado");
  assert.equal(d.regrasAprovadas, false);
});

test("estados: gerencial = 'proposta' (não aprovada); contas a receber = 'indisponivel' sem número; saldo parte de abertura negativa", async () => {
  const p = await painel(ctx, { mes: "2026-09" }, deps());
  assert.equal(p.indicadores.resultadoGerencial.estado, "proposta");
  assert.equal(p.indicadores.contasAReceber.estado, "indisponivel"); assert.equal(p.indicadores.contasAReceber.valorCentavos, null);
  assert.equal(p.indicadores.saldoDisponivel.valorCentavos, -1000 + 70000 - 20000);
  assert.ok(p.indicadores.cmv.formula && p.indicadores.cmv.origem, "todo indicador traz fórmula e origem");
});

test("contas a pagar em aberto e acréscimo presumido (pago acima do original) sem virar juros confirmado", async () => {
  const p = await painel(ctx, { mes: "2026-09" }, deps());
  assert.equal(p.indicadores.contasAPagar.valorCentavos, 30000);
  assert.equal(p.indicadores.jurosEncargos.valorCentavos, 50);
  assert.equal(p.indicadores.jurosEncargos.estado, "proposta");
  assert.match(p.indicadores.jurosEncargos.nota, /Pagos no mês: R\$ 0,50/);
  assert.match(p.indicadores.jurosEncargos.nota, /presumido não é juros até a classificação/);
});

test("sem contas a pagar: indicadores gerenciais ficam 'parcial' (nunca completos de mentira)", async () => {
  const p = await painel(ctx, { mes: "2026-09" }, deps({ obrigacoes: [], pagamentos: [] }));
  assert.equal(p.indicadores.cmv.estado, "parcial");
  assert.equal(p.indicadores.faturamentoBruto.estado, "ok");
  // nunca um número enganoso: sem contas a pagar, líquido/custos/despesas/resultado/margem saem SEM valor
  for (const k of ["faturamentoLiquido", "cmv", "custos", "despesas", "resultadoGerencial", "margemLiquida"]) assert.equal(p.indicadores[k].valorCentavos, null, k);
  assert.equal(p.indicadores.faturamentoBruto.valorCentavos, 100000);
});

test("receitas: vendas por dia, taxas por canal e recebimento por conta sem transferências", async () => {
  const r = await receitas(ctx, { mes: "2026-09" }, deps());
  assert.equal(r.vendas.porDia.length, 1); assert.deepEqual(r.vendas.taxasPorCanal, { IFOOD: 3000 });
  assert.equal(r.recebimentosPorConta[0].entradasCentavos, 70000);
});

test("regras padrão: cada categoria recebe grupo e critério explícitos; categoria desconhecida fica sem regra", () => {
  assert.deepEqual(classificarCategoria({ nome: "INSUMOS - X", papel: "custo_variavel" }).criterio, "competencia");
  assert.equal(classificarCategoria({ nome: "FRETE", papel: "custo_variavel" }).grupo, "entregas");
  assert.equal(classificarCategoria({ nome: "DIARIA", papel: "despesa_pessoal" }).grupo, "variaveis");
  assert.equal(classificarCategoria({ nome: "PARCELAMENTO SIMPLES", papel: "tributo" }).criterio, "fora");
  assert.equal(classificarCategoria({ nome: "?", papel: "desconhecido" }), null);
  const r = regrasPadrao([...PLANO, { id: "z", nome: "ESTRANHA", papel: "outro" }]);
  assert.deepEqual(r.semRegra, ["ESTRANHA"]); assert.equal(r.aprovada, false);
});
