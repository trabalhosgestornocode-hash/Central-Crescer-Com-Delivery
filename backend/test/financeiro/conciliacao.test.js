import { test } from "node:test";
import assert from "node:assert/strict";
import { PAPEL } from "../../src/financeiro-calculos/planoContas.js";
import { conciliar, estadoDe, validarResolucao, agruparPendencias, ESTADO, ESCOPO } from "../../src/financeiro-calculos/conciliacao.js";

// Sintético.
const contas = [
  { id: "cx", nome: "CAIXA", tipo_conta: "caixa_fisico", canal_referencia: null },
  { id: "st", nome: "ADQ", tipo_conta: "adquirente", canal_referencia: "stone" },
  { id: "bk", nome: "BANCO", tipo_conta: "banco", canal_referencia: null },
];
let n = 0;
const L = (contaId, sentido, valorCentavos, data, papel, categoriaId = null) => ({ id: `l${++n}`, contaId, sentido, valorCentavos, data, papel, categoriaId, status: "realizado" });
const R = (data, tipo, valorCentavos, canal = null) => ({ id: `r${++n}`, data, tipo, canal, valorCentavos });
const base = (extra = {}) => ({ mes: "2026-09", lancamentos: [], contas, referencias: [], resolucoes: [], ...extra });

test("estado: sem referência ≠ conciliado; diferença sem resolução é pendente_identificacao; resolução parcial/total", () => {
  assert.equal(estadoDe(null), ESTADO.SEM_REFERENCIA);
  assert.equal(estadoDe(0), ESTADO.CONCILIADO);
  assert.equal(estadoDe(-13101), ESTADO.PENDENTE);
  assert.equal(estadoDe(-13101, [{ valorCentavos: -5000 }]), ESTADO.PARCIAL);
  assert.equal(estadoDe(-13101, [{ valorCentavos: -5000 }, { valorCentavos: -8101 }]), ESTADO.RESOLVIDO);
});

test("ponte mensal: vendas − recebido − taxas = residual, e o residual FICA pendente (nunca prazo automático)", () => {
  const r = conciliar(base({
    lancamentos: [L("st", "entrada", 6000000, "2026-09-03", PAPEL.RECEITA_OPERACIONAL), L("cx", "entrada", 1500000, "2026-09-04", PAPEL.RECEITA_OPERACIONAL), L("bk", "entrada", 300000, "2026-09-05", PAPEL.RECEITA_OPERACIONAL)],
    referencias: [R("2026-09-30", "venda", 8000000), R("2026-09-30", "taxa", 400000, "STONE"), R("2026-09-30", "taxa", 100000, "IFOOD")],
  }));
  assert.equal(r.ponte.vendasCentavos, 8000000);
  assert.equal(r.ponte.recebidoCentavos, 7800000);
  assert.equal(r.ponte.diferencaAExplicarCentavos, 200000);
  assert.equal(r.ponte.taxasTotalCentavos, 500000);
  assert.equal(r.ponte.residualCentavos, -300000);
  assert.equal(r.ponte.estado, ESTADO.PENDENTE);
  assert.equal(r.resumo.pendenciasAbertas >= 1, true);
  assert.deepEqual(r.ponte.taxas.map((t) => t.canal), ["STONE", "IFOOD"]);
});

test("ponte: sem vendas ou sem taxas informadas não calcula residual (ausente nunca vira zero)", () => {
  const semVendas = conciliar(base({ lancamentos: [L("bk", "entrada", 100, "2026-09-01", PAPEL.RECEITA_OPERACIONAL)], referencias: [R("2026-09-01", "taxa", 5)] }));
  assert.equal(semVendas.ponte.residualCentavos, null);
  assert.equal(semVendas.ponte.estado, ESTADO.SEM_REFERENCIA);
  assert.deepEqual(semVendas.ponte.faltando, ["vendas"]);
  const semTaxas = conciliar(base({ lancamentos: [L("bk", "entrada", 100, "2026-09-01", PAPEL.RECEITA_OPERACIONAL)], referencias: [R("2026-09-01", "venda", 150)] }));
  assert.equal(semTaxas.ponte.diferencaAExplicarCentavos, 50);
  assert.equal(semTaxas.ponte.residualCentavos, null);
  assert.deepEqual(semTaxas.ponte.faltando, ["taxas"]);
  const taxaZeroExplicita = conciliar(base({ lancamentos: [L("bk", "entrada", 100, "2026-09-01", PAPEL.RECEITA_OPERACIONAL)], referencias: [R("2026-09-01", "venda", 100), R("2026-09-01", "taxa", 0)] }));
  assert.equal(taxaZeroExplicita.ponte.estado, ESTADO.CONCILIADO);
});

test("sem nenhuma referência: tudo sem_referencia e nenhuma pendência inventada", () => {
  const r = conciliar(base({ lancamentos: [L("cx", "entrada", 5000, "2026-09-01", PAPEL.RECEITA_OPERACIONAL), L("cx", "saida", 700, "2026-09-02", PAPEL.DESPESA_VARIAVEL)] }));
  assert.equal(r.resumo.semReferencia, true);
  assert.equal(r.resumo.pendenciasAbertas, 0);
  assert.ok(r.caixaDias.every((d) => d.estado === ESTADO.SEM_REFERENCIA));
  assert.ok(r.sangriaDias.every((d) => d.estado === ESTADO.SEM_REFERENCIA));
});

test("caixa em espécie por dia: confere, diverge, e dia sem referência não é tratado como zero", () => {
  const r = conciliar(base({
    lancamentos: [L("cx", "entrada", 14475, "2026-09-01", PAPEL.RECEITA_OPERACIONAL), L("cx", "entrada", 26900, "2026-09-02", PAPEL.RECEITA_OPERACIONAL), L("cx", "entrada", 100, "2026-09-03", PAPEL.RECEITA_OPERACIONAL), L("st", "entrada", 99999, "2026-09-01", PAPEL.RECEITA_OPERACIONAL)],
    referencias: [R("2026-09-01", "dinheiro", 14475), R("2026-09-02", "dinheiro", 27000)],
  }));
  const d = Object.fromEntries(r.caixaDias.map((x) => [x.data, x]));
  assert.equal(d["2026-09-01"].estado, ESTADO.CONCILIADO);        // adquirente não entra no caixa físico
  assert.equal(d["2026-09-02"].diferencaCentavos, -100);
  assert.equal(d["2026-09-02"].estado, ESTADO.PENDENTE);
  assert.equal(d["2026-09-03"].estado, ESTADO.SEM_REFERENCIA);
  assert.equal(d["2026-09-03"].diferencaCentavos, null);
});

test("sangrias: exceção APROVADA por categoria exclui do confronto; sem exceção o item entra; diferenças por dia e total", () => {
  const dados = {
    lancamentos: [L("cx", "saida", 4800, "2026-09-01", PAPEL.DESPESA_VARIAVEL, "c1"), L("cx", "saida", 5100, "2026-09-02", PAPEL.DESPESA_VARIAVEL, "c1"), L("cx", "saida", 105753, "2026-09-02", PAPEL.DESPESA_FIXA, "aluguel"), L("st", "saida", 777, "2026-09-02", PAPEL.DESPESA_VARIAVEL, "c1")],
    referencias: [R("2026-09-01", "sangria", 4800), R("2026-09-02", "sangria", 6100)],
  };
  const sem = conciliar(base(dados));
  assert.equal(sem.sangriaDias.find((d) => d.data === "2026-09-02").diferencaCentavos, 5100 + 105753 - 6100);
  const com = conciliar(base({ ...dados, excecoesSangria: new Set(["aluguel"]) }));
  const d2 = com.sangriaDias.find((d) => d.data === "2026-09-02");
  assert.equal(d2.fluxoCentavos, 5100);
  assert.equal(d2.excluidasCentavos, 105753);
  assert.equal(d2.diferencaCentavos, -1000);
  assert.equal(d2.estado, ESTADO.PENDENTE);
  assert.equal(com.sangriaDias.find((d) => d.data === "2026-09-01").estado, ESTADO.CONCILIADO);
  assert.equal(com.totalSangria.diferencaCentavos, -1000);
  assert.equal(com.totalSangria.excecoesAplicadasCentavos, 105753);
  assert.deepEqual(d2.porPapel, { despesa_variavel: 5100 });
});

test("sangria: dia com saída de caixa e sem referência fica sem_referencia e é contado", () => {
  const r = conciliar(base({ lancamentos: [L("cx", "saida", 900, "2026-09-09", PAPEL.DESPESA_VARIAVEL)], referencias: [R("2026-09-01", "sangria", 10)] }));
  assert.equal(r.sangriaDias.find((d) => d.data === "2026-09-09").estado, ESTADO.SEM_REFERENCIA);
  assert.equal(r.totalSangria.diasSemReferencia, 1);
});

test("resoluções: classificação manual explica a diferença; a ponte só vira resolvida quando o residual é totalmente explicado", () => {
  const dados = base({
    lancamentos: [L("bk", "entrada", 7000, "2026-09-02", PAPEL.RECEITA_OPERACIONAL)],
    referencias: [R("2026-09-30", "venda", 8000), R("2026-09-30", "taxa", 500)],
  });
  const r0 = conciliar(dados);
  assert.equal(r0.ponte.residualCentavos, 500);
  const parcial = conciliar({ ...dados, resolucoes: [{ id: "x", escopo: ESCOPO.PONTE, chave: "2026-09-01", classificacao: "prazo", valorCentavos: 200, nota: "n" }] });
  assert.equal(parcial.ponte.estado, ESTADO.PARCIAL);
  const total = conciliar({ ...dados, resolucoes: [{ id: "x", escopo: ESCOPO.PONTE, chave: "2026-09-01", classificacao: "prazo", valorCentavos: 200, nota: "n" }, { id: "y", escopo: ESCOPO.PONTE, chave: "2026-09-01", classificacao: "ajuste", valorCentavos: 300, nota: "n" }] });
  assert.equal(total.ponte.estado, ESTADO.RESOLVIDO);
  assert.equal(total.resumo.pendenciasAbertas, 0);
});

test("validação de classificação manual: sinal, excesso, nota, classe, item inexistente e sem referência", () => {
  const r = conciliar(base({ lancamentos: [L("cx", "entrada", 100, "2026-09-02", PAPEL.RECEITA_OPERACIONAL), L("bk", "entrada", 7000, "2026-09-02", PAPEL.RECEITA_OPERACIONAL)], referencias: [R("2026-09-02", "dinheiro", 150), R("2026-09-30", "venda", 8000), R("2026-09-30", "taxa", 500)] }));
  const ok = { escopo: ESCOPO.CAIXA, chave: "2026-09-02", classificacao: "ajuste", valorCentavos: -50, nota: "troco devolvido" };
  assert.deepEqual(validarResolucao(r, ok), []);
  assert.ok(validarResolucao(r, { ...ok, valorCentavos: 50 }).some((e) => /mesmo sinal/.test(e)));
  assert.ok(validarResolucao(r, { ...ok, valorCentavos: -80 }).some((e) => /excede/.test(e)));
  assert.ok(validarResolucao(r, { ...ok, nota: "x" }).some((e) => /nota/.test(e)));
  assert.ok(validarResolucao(r, { ...ok, classificacao: "inventada" }).some((e) => /classificação/.test(e)));
  assert.ok(validarResolucao(r, { ...ok, valorCentavos: 0 }).some((e) => /diferente de zero/.test(e)));
  assert.ok(validarResolucao(r, { ...ok, chave: "2026-09-20" }).some((e) => /não encontrado/.test(e)));
  assert.ok(validarResolucao(r, { ...ok, escopo: "outro" }).length);
  assert.deepEqual(validarResolucao(r, { escopo: ESCOPO.PONTE, chave: "2026-09-01", classificacao: "prazo", valorCentavos: 400, nota: "fim de mês" }), []);
  const semRef = conciliar(base({ lancamentos: [L("cx", "entrada", 100, "2026-09-03", PAPEL.RECEITA_OPERACIONAL)] }));
  assert.ok(validarResolucao(semRef, { escopo: ESCOPO.CAIXA, chave: "2026-09-03", classificacao: "ajuste", valorCentavos: 1, nota: "xxxxx" }).some((e) => /sem referência/.test(e)));
});

test("por conta: sem vínculo de canal é informado; com vínculo compara vendas do canal x recebido + taxas", () => {
  const r = conciliar(base({
    lancamentos: [L("st", "entrada", 9000, "2026-09-03", PAPEL.RECEITA_OPERACIONAL), L("bk", "entrada", 100, "2026-09-03", PAPEL.RECEITA_OPERACIONAL)],
    referencias: [R("2026-09-30", "venda", 9500, "stone"), R("2026-09-30", "taxa", 500, "STONE")],
  }));
  const c = Object.fromEntries(r.porConta.map((x) => [x.nome, x]));
  assert.equal(c.ADQ.estado, ESTADO.CONCILIADO);
  assert.equal(c.ADQ.diferencaCentavos, 0);
  assert.equal(c.BANCO.estado, ESTADO.SEM_VINCULO);
});

test("pendências: agrupa por motivo preservado, detecta duplicatas e soma o líquido com terceiros", () => {
  const P = (id, o) => ({ id, status: "realizado", sentido: "saida", valor_centavos: 100, data_movimento: "2026-09-01", conta_id: "a", descricao: "X", classificacao_pendente: false, revisao_motivos: [], categoria_id: "c", ...o });
  const g = agruparPendencias([
    P("1", { classificacao_pendente: true, revisao_motivos: ["a_identificar"], valor_centavos: 5500 }), P("2", { classificacao_pendente: true, revisao_motivos: ["a_identificar"], valor_centavos: 4500 }),
    P("3", { revisao_motivos: ["valor_por_formula"], sentido: "entrada" }), P("4", { descricao: "SEGURO", valor_centavos: 163 }), P("5", { descricao: "seguro ", valor_centavos: 163 }),
    P("6", { classificacao_pendente: true, revisao_motivos: ["transferencia_sem_contraparte"], valor_centavos: 90000 }),
    P("7", { classificacao_pendente: true, revisao_motivos: ["transferencia_sem_contraparte"], sentido: "entrada", valor_centavos: 20000 }),
    P("8", { status: "cancelado", classificacao_pendente: true, revisao_motivos: ["a_identificar"] }),
  ]);
  assert.equal(g.porMotivo.a_identificar.quantidade, 2);
  assert.equal(g.porMotivo.a_identificar.valorCentavos, 10000);
  assert.equal(g.porMotivo.valor_por_formula.pendentes, 0);
  assert.equal(g.possiveisDuplicatas.length, 1);
  assert.deepEqual(g.possiveisDuplicatas[0].ids.sort(), ["4", "5"]);
  assert.equal(g.movimentosComTerceiros.quantidade, 2);
  assert.equal(g.movimentosComTerceiros.liquidoSaindoCentavos, 70000);
  assert.equal(g.totalPendentes, 4); // cancelado ignorado
});
