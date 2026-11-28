import { test } from "node:test";
import assert from "node:assert/strict";
import { moeda, segmentosSituacao, fraseSaude, filtrarProdutos, filtrarCausas, ajudaEtapa, progressoEtapas, leituraSimulacao, unidadeRend } from "../src/produtosCmv2Modelo.js";

const nb = (s) => s.replace(/\s/g, " ");

test("moeda: custo por grama mantém casas; não arredonda R$ 0,0149 para R$ 0,01", () => {
  assert.equal(nb(moeda(0.01493, { unidade: "g" })), "R$ 0,0149/g");
  assert.equal(nb(moeda(20.0009)), "R$ 20,00");
  assert.equal(moeda(null), "—");
});

test("situação: barra na ordem problema → pronto; frase distingue franquia e unidade vazia", () => {
  assert.deepEqual(segmentosSituacao({ aguardando_revisao: 2, inconsistente: 1 }).map((s) => s.chave), ["inconsistente", "aguardando_revisao"]);
  assert.match(fraseSaude({ resumo: { produtos_finais: 3, preparacoes: 1, fichas_sem_pendencia: 1 }, dimensoes: { custo_confiavel: 1 }, perfil: { modelo: "marca_propria" } }).titulo, /1 de 4 fichas com custo confiável/);
  assert.match(fraseSaude({ resumo: { produtos_finais: 59, preparacoes: 2 }, dimensoes: { custo_confiavel: 55 }, perfil: { modelo: "franquia_padronizada" } }).titulo, /franquia/);
  assert.match(fraseSaude({ resumo: { produtos_finais: 0, preparacoes: 0 } }).titulo, /Nenhuma ficha/);
});

test("filtros de produtos e causas", () => {
  const itens = [{ nome: "Bolo", tipo: "sobremesa", situacao: "incompleta" }, { nome: "Base", tipo: "submontagem", situacao: "inconsistente" }];
  assert.equal(filtrarProdutos(itens, { tipo: "preparacao" }).length, 1);
  assert.equal(filtrarProdutos(itens, { busca: "bol", tipo: "final" }).length, 1);
  assert.equal(filtrarCausas([{ criticidade: "critica", codigo: "a" }, { criticidade: "alta", codigo: "b" }], { criticidade: "critica" }).length, 1);
});

test("ajuda ensina a obter o dado: tara da balança e 2.600 g (não 2,6)", () => {
  assert.ok(ajudaEtapa("aproveitamento", "preparacao").passos.some((p) => /tara/.test(p)));
  assert.ok(ajudaEtapa("porcionamento", "preparacao").passos.some((p) => /2\.600 g/.test(p)));
  assert.ok(ajudaEtapa("precos", "produto_final").passos.some((p) => /promocional/.test(p)));
});

test("progresso e leitura da simulação (margem de contribuição não é lucro)", () => {
  assert.deepEqual(progressoEtapas([{ etapa: "a", estado: "valida" }, { etapa: "b", estado: "pendente" }, { etapa: "revisao", estado: "bloqueada" }]), { ok: 1, total: 2, pct: 50 });
  assert.match(leituraSimulacao({ disponivel: true, margem_contribuicao: 5 }), /ainda não é lucro/);
  assert.match(leituraSimulacao({ disponivel: true, margem_contribuicao: -1 }), /não cobre/);
  assert.equal(unidadeRend("un", 1), "unidade");
});
