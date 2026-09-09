// Testes PUROS da camada de ajustes operacionais do Parser Food Delivery —
// composição do custo real, fusão de entregadores, catálogo de motivos e
// normalização de nome. Sem banco (mesmo espírito de
// parser-food-delivery-calc.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  comporCustoReal, mesclarEntregadores, motivoObrigatorio, motivoValido,
  lancamentoEntraNoCusto, normalizarNomeEntregador, MOTIVO_MANUAL_PADRAO,
  ORIGEM_LANCAMENTO,
} from "../src/modules/parser-food-delivery/parserFoodDelivery.lancamentos.calc.js";

const lanc = (o) => ({ origem: "avulso", valor: 0, motivo: "x", excluido: false, ...o });

// ---------- comporCustoReal ----------
test("comporCustoReal: total = iFood + adicionais + manuais + avulsos, separado por origem", () => {
  const r = comporCustoReal({ taxasIfood: 1750, lancamentos: [
    lanc({ origem: "taxa_adicional", valor: 8, numeroPedido: "P1" }),
    lanc({ origem: "taxa_adicional", valor: 12, numeroPedido: "P2" }),
    lanc({ origem: "manual", valor: 50 }),
    lanc({ origem: "avulso", valor: 60 }),
  ] });
  assert.equal(r.ifood, 1750);
  assert.equal(r.taxasAdicionais, 20);
  assert.equal(r.manuais, 50);
  assert.equal(r.avulsos, 60);
  assert.equal(r.ajustesManuais, 130);
  assert.equal(r.total, 1880);
  assert.equal(r.qtdPedidosComTaxaAdicional, 2);
  assert.equal(r.valorMedioTaxaAdicional, 10);
});

test("comporCustoReal: lançamento excluído não entra no custo", () => {
  const r = comporCustoReal({ taxasIfood: 100, lancamentos: [
    lanc({ origem: "avulso", valor: 40 }),
    lanc({ origem: "avulso", valor: 999, excluido: true }),
  ] });
  assert.equal(r.avulsos, 40);
  assert.equal(r.total, 140);
});

test("comporCustoReal: entrega manual 'nao_recebe_taxa' não soma ao custo", () => {
  const r = comporCustoReal({ taxasIfood: 0, lancamentos: [
    lanc({ origem: "manual", valor: 15, classificacao: "nao_recebe_taxa" }),
    lanc({ origem: "manual", valor: 15, classificacao: "recebe_taxa" }),
  ] });
  assert.equal(r.manuais, 15);
  assert.equal(r.total, 15);
});

test("comporCustoReal: sem lançamentos, custo real == iFood", () => {
  const r = comporCustoReal({ taxasIfood: 320.5, lancamentos: [] });
  assert.equal(r.total, 320.5);
  assert.equal(r.ajustesManuais, 0);
  assert.equal(r.valorMedioTaxaAdicional, null);
});

// ---------- mesclarEntregadores ----------
test("mesclarEntregadores: soma taxa adicional no card do entregador do iFood", () => {
  const ifood = [{ entregador: "Vitor", chave: "vitor", totalPedidos: 3, entregues: 3, canceladosComTaxa: 0, canceladosSemTaxa: 0, canceladosRevisao: 0, taxasValidas: 36 }];
  const out = mesclarEntregadores(ifood, [
    { origem: "taxa_adicional", valor: 8, entregadorNomeSnapshot: "Ronaldo", excluido: false },
    { origem: "taxa_adicional", valor: 5, entregadorNomeSnapshot: "Vitor", excluido: false },
  ]);
  const vitor = out.find((e) => e.chave === "vitor");
  const ronaldo = out.find((e) => e.entregador === "Ronaldo");
  assert.equal(vitor.taxasAdicionais, 5);
  assert.equal(vitor.custoTotal, 41);
  assert.equal(ronaldo.somenteLancamentos, true);
  assert.equal(ronaldo.taxasAdicionais, 8);
  assert.equal(ronaldo.custoTotal, 8);
});

// ---------- catálogo de motivos ----------
test("motivoObrigatorio: taxa_adicional e avulso sim; manual não", () => {
  assert.equal(motivoObrigatorio(ORIGEM_LANCAMENTO.TAXA_ADICIONAL), true);
  assert.equal(motivoObrigatorio(ORIGEM_LANCAMENTO.AVULSO), true);
  assert.equal(motivoObrigatorio(ORIGEM_LANCAMENTO.MANUAL), false);
});

test("motivoValido: valor fora do catálogo é rejeitado p/ taxa_adicional; manual aceita a chave padrão", () => {
  assert.equal(motivoValido("taxa_adicional", "endereco_incorreto"), true);
  assert.equal(motivoValido("taxa_adicional", "buscar_paes"), false);
  assert.equal(motivoValido("avulso", "transferencia_entre_unidades"), true);
  assert.equal(motivoValido("manual", MOTIVO_MANUAL_PADRAO), true);
});

test("lancamentoEntraNoCusto: excluído nunca; manual nao_recebe_taxa nunca", () => {
  assert.equal(lancamentoEntraNoCusto({ origem: "avulso", excluido: true }), false);
  assert.equal(lancamentoEntraNoCusto({ origem: "manual", classificacao: "nao_recebe_taxa" }), false);
  assert.equal(lancamentoEntraNoCusto({ origem: "manual", classificacao: "recebe_taxa" }), true);
  assert.equal(lancamentoEntraNoCusto({ origem: "taxa_adicional" }), true);
});

// ---------- normalização de nome (dedup) ----------
test("normalizarNomeEntregador: caixa, acento e espaços não geram entregador diferente", () => {
  const a = normalizarNomeEntregador("  José  da   Silva ");
  const b = normalizarNomeEntregador("JOSE DA SILVA");
  const c = normalizarNomeEntregador("josé da silva");
  assert.equal(a.chave, b.chave);
  assert.equal(a.chave, c.chave);
  assert.equal(a.nome, "José da Silva");
});

test("normalizarNomeEntregador: nomes realmente diferentes não colidem", () => {
  assert.notEqual(normalizarNomeEntregador("Ronaldo").chave, normalizarNomeEntregador("Reinaldo").chave);
});
