// Fichas Técnicas — modelo puro: filtros, selos e textos. Rodar: node --test frontend/test/fichasModelo.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { filtrarFichas, contarPorCategoria, seloHomologacao, rotuloMotivo, descreverPendencia, pendenciasDoItem, rotuloCusto, idsProntos } from "../src/fichasModelo.js";

const F = (o) => ({ id: o.nome, categoria: null, natureza: "produto_final", ficha_completa: true, homologacao: "pendente", pode_homologar: true, pendencias: [], ...o });
const itens = [
  F({ nome: "Bolo de Cenoura", categoria: "DOCES" }),
  F({ nome: "Calda de Chocolate", categoria: "DOCES", natureza: "preparacao", unidade_rendimento: "g" }),
  F({ nome: "Empadão", categoria: "SALGADOS", homologacao: "homologada", pode_homologar: false, homologado_por_nome: "Ana", homologado_em: "2026-11-10" }),
  F({ nome: "Cappuccino", categoria: "BEBIDAS", ficha_completa: false, pode_homologar: false, pendencias: [{ codigo: "insumo_sem_custo" }, { codigo: "unidade_inferida" }] }),
  F({ nome: "Pão de Queijo Manual", categoria: null, homologacao: "nao_aplicavel", pode_homologar: false }),
];

test("filtra por categoria (incluindo sem categoria), natureza e situação", () => {
  assert.deepEqual(filtrarFichas(itens, { categoria: "DOCES" }).map((i) => i.nome), ["Bolo de Cenoura", "Calda de Chocolate"]);
  assert.deepEqual(filtrarFichas(itens, { categoria: "sem" }).map((i) => i.nome), ["Pão de Queijo Manual"]);
  assert.deepEqual(filtrarFichas(itens, { natureza: "preparacao" }).map((i) => i.nome), ["Calda de Chocolate"]);
  assert.deepEqual(filtrarFichas(itens, { situacao: "incompletas" }).map((i) => i.nome), ["Cappuccino"]);
  assert.deepEqual(filtrarFichas(itens, { situacao: "homologadas" }).map((i) => i.nome), ["Empadão"]);
  assert.deepEqual(filtrarFichas(itens, { situacao: "prontas" }).map((i) => i.nome), ["Bolo de Cenoura", "Calda de Chocolate"]);
});
test("busca ignora acento e caixa; filtros se combinam", () => {
  assert.deepEqual(filtrarFichas(itens, { busca: "EMPADAO" }).map((i) => i.nome), ["Empadão"]);
  assert.deepEqual(filtrarFichas(itens, { busca: "pao", categoria: "SALGADOS" }).map((i) => i.nome), []);
  assert.equal(filtrarFichas(itens, {}).length, 5);
});
test("contagem por categoria respeita os outros filtros (número da aba = linhas da lista)", () => {
  const c = contarPorCategoria(itens, { situacao: "pendentes" });
  assert.equal(c.todas, 3); assert.equal(c.DOCES, 2); assert.equal(c.BEBIDAS, 1); assert.equal(c.SALGADOS, undefined);
});
test("selo: homologada mostra quem e quando; incompleta bloqueia; pendente explica o motivo; manual sem controle", () => {
  const fmt = (d) => d.split("-").reverse().join("/");
  assert.deepEqual(seloHomologacao(itens[2], fmt), { texto: "Homologada", classe: "ok", detalhe: "Homologada por Ana em 10/11/2026." });
  assert.equal(seloHomologacao(itens[3]).texto, "Incompleta");
  const inv = seloHomologacao(F({ homologacao_motivo: "custo_alterado" }));
  assert.equal(inv.texto, "Pendente"); assert.match(inv.detalhe, /0,5%/);
  assert.equal(seloHomologacao(itens[4]).texto, "Sem controle");
});
test("motivos e pendências em linguagem clara, separando o que BLOQUEIA do que é aviso", () => {
  assert.match(rotuloMotivo("composicao_alterada"), /composição/);
  assert.equal(rotuloMotivo(null), "");
  const p = pendenciasDoItem(itens[3]);
  assert.deepEqual(p.bloqueantes.map((x) => x.codigo), ["insumo_sem_custo"]);
  assert.deepEqual(p.avisos.map((x) => x.codigo), ["unidade_inferida"]);
  assert.match(p.bloqueantes[0].acao, /preço/i);
  assert.equal(descreverPendencia({ codigo: "codigo_novo" }).bloqueia, false); // desconhecida nunca bloqueia nem some
});
test("rótulo do custo: por porção para produto final; por g/ml para preparação", () => {
  assert.equal(rotuloCusto(itens[0]), "por porção");
  assert.equal(rotuloCusto(itens[1]), "por grama");
  assert.equal(rotuloCusto(F({ natureza: "preparacao", unidade_rendimento: null })), "por unidade de rendimento");
});
test("idsProntos só devolve fichas completas e pendentes", () => {
  assert.deepEqual(idsProntos(itens), ["Bolo de Cenoura", "Calda de Chocolate"]);
});
