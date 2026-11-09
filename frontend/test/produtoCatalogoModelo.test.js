// Seções de catálogo no detalhe do Produto — modelo puro. Rodar: node --test frontend/test/produtoCatalogoModelo.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { itemDoProduto, podeHomologarProduto, margemPorPreco, linhasFormacao, rotuloNaoConsiderado } from "../src/produtoCatalogoModelo.js";

const perto = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} !≈ ${b}`);
const COND = { canais: [{ canal: "ifood", comissao: 0.23, taxas: 0.015, promocao: 0.05, tributos: null, entrega_responsavel: "plataforma", entrega_custo: null }] };

test("itemDoProduto/podeHomologar: completa e pendente homologa; incompleta ou homologada não", () => {
  const base = { status_ficha: { chave: "completa" }, homologacao_info: { estado: "pendente" } };
  assert.equal(podeHomologarProduto(base), true);
  assert.equal(podeHomologarProduto({ ...base, status_ficha: { chave: "insumo_sem_custo" } }), false);
  assert.equal(podeHomologarProduto({ ...base, homologacao_info: { estado: "homologada" } }), false);
  assert.equal(podeHomologarProduto({ ...base, homologacao_info: { estado: "nao_aplicavel" } }), false);
  assert.equal(itemDoProduto({ status_ficha: { chave: "sem_componentes" } }).ficha_completa, false);
});
test("margem de contribuição usa as condições do canal do PRÓPRIO preço", () => {
  const [r] = margemPorPreco({ precos: [{ canal: "ifood", tabela: "A", preco: 20 }], custo: 4, custoDisponivel: true, condicoes: COND });
  perto(r.cmvPct, 20); perto(r.lucro, 20 * (1 - 0.23 - 0.015 - 0.05) - 4);
  perto(r.margemPct, (r.lucro / 20) * 100);
  assert.equal(r.parcial, true); assert.deepEqual(r.naoConsiderados, ["tributos"]); assert.equal(r.motivo, "condicoes_incompletas"); // tributos não informado
});
test("tudo informado => completa (entrega pela plataforma não conta como faltando)", () => {
  const cond = { canais: [{ ...COND.canais[0], tributos: 0 }] };
  const [r] = margemPorPreco({ precos: [{ canal: "ifood", preco: 20 }], custo: 4, custoDisponivel: true, condicoes: cond });
  assert.equal(r.parcial, false); assert.deepEqual(r.naoConsiderados, []); assert.equal(r.motivo, null);
});
test("entrega pela loja sem custo informado conta como faltando; com custo desconta", () => {
  const cond = (custo) => ({ canais: [{ canal: "ifood", comissao: 0.2, taxas: 0, promocao: 0, tributos: 0, entrega_responsavel: "loja", entrega_custo: custo }] });
  assert.deepEqual(margemPorPreco({ precos: [{ canal: "ifood", preco: 20 }], custo: 4, custoDisponivel: true, condicoes: cond(null) })[0].naoConsiderados, ["entrega"]);
  perto(margemPorPreco({ precos: [{ canal: "ifood", preco: 20 }], custo: 4, custoDisponivel: true, condicoes: cond(6) })[0].lucro, 20 * 0.8 - 6 - 4);
});
test("canal SEM condições: nada de percentual assumido — margem null, CMV segue disponível", () => {
  const [r] = margemPorPreco({ precos: [{ canal: "uber", preco: 20 }], custo: 4, custoDisponivel: true, condicoes: COND });
  assert.equal(r.lucro, null); assert.equal(r.margemPct, null); assert.equal(r.motivo, "canal_sem_condicoes"); perto(r.cmvPct, 20);
  assert.equal(margemPorPreco({ precos: [{ canal: "ifood", preco: 20 }], custo: 4, custoDisponivel: true, condicoes: null })[0].motivo, "canal_sem_condicoes");
});
test("ficha incompleta: sem custo => sem CMV nem margem; preços zerados são ignorados", () => {
  const r = margemPorPreco({ precos: [{ canal: "ifood", preco: 20 }, { canal: "balcao", preco: 0 }], custo: 4, custoDisponivel: false, condicoes: COND });
  assert.equal(r.length, 1); assert.equal(r[0].cmvPct, null); assert.equal(r[0].motivo, "ficha_incompleta");
});
test("formação de custo: só grupos com itens, na ordem ingredientes/preparações/embalagens; total null se faltar custo", () => {
  const l = linhasFormacao({ formacao_custo: { lote: { ingredientes: { itens: 3, total: 2.5 }, preparacoes: { itens: 0, total: 0 }, embalagens: { itens: 1, total: null } } } });
  assert.deepEqual(l.map((x) => [x.chave, x.itens, x.total]), [["ingredientes", 3, 2.5], ["embalagens", 1, null]]);
  assert.deepEqual(linhasFormacao(null), []);
  assert.equal(rotuloNaoConsiderado("promocao"), "promoções custeadas pela loja");
});
