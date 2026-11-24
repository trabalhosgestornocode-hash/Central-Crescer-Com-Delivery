// MOVA CORE — F3: camada de RESOLUÇÃO de entidades e conceitos. Unidade (morfologia, digitação, ambiguidade) e integração com
// as ferramentas reais do catálogo sobre uma porta de leitura sintética (cadastro com nomes parecidos de propósito).
import assert from "node:assert/strict";
import test from "node:test";
import { resolverEntidade, criarResolvedorDeConceitos, radical, pontuar, distancia, GLOSSARIO_BASE } from "../../src/modules/mova-core/resolucao.js";
import { CATALOGO } from "../../src/modules/mova-core/catalogo.js";

const CADASTRO = [{ nome: "Atacadão Embalagens LTDA" }, { nome: "Matheus Rocha" }, { nome: "Matheus Lima" }, { nome: "Coca-Cola FEMSA" }, { nome: "Distribuidora Brownie & Cia" }, { nome: "Pães da Vila ME" }];

test("RS-01 flexão do português, acento e sufixo societário: singular/plural e sem acento acham o MESMO cadastro", () => {
  for (const [w, r] of [["embalagens", "embalagem"], ["pães", "pao"], ["limões", "limao"], ["papéis", "papel"], ["brownies", "brownie"], ["fornecedores", "fornecedor"], ["motoboys", "motoboy"]]) assert.equal(radical(w), r, w);
  for (const t of ["embalagem", "embalagens", "EMBALAGEM", "atacadao", "Atacadão embalagem"]) assert.equal(resolverEntidade(t, CADASTRO).escolhido?.nome, "Atacadão Embalagens LTDA", t);
  assert.equal(resolverEntidade("pao da vila", CADASTRO).escolhido?.nome, "Pães da Vila ME");
  assert.equal(resolverEntidade("ltda", CADASTRO).estado, "NENHUM", "sufixo societário sozinho não identifica ninguém");
});

test("RS-02 erro de digitação e abreviação proporcionais ao tamanho; palavra curta exige exatidão", () => {
  assert.equal(resolverEntidade("mateus rocha", CADASTRO).escolhido?.nome, "Matheus Rocha");
  assert.equal(resolverEntidade("atacadao embalagems", CADASTRO).escolhido?.nome, "Atacadão Embalagens LTDA");
  assert.equal(resolverEntidade("atac", CADASTRO).escolhido?.nome, "Atacadão Embalagens LTDA", "abreviação ≥ 4 letras");
  assert.equal(resolverEntidade("coco", CADASTRO).estado, "NENHUM", "4 letras: sem tolerância a erro (coco ≠ coca)");
  assert.ok(distancia("embalagem", "embalagme") <= 1, "transposição conta 1");
  assert.equal(pontuar("xyz", "Atacadão"), 0);
});

test("RS-03 AMBIGUIDADE real: dois cadastros diferentes igualmente plausíveis ⇒ AMBIGUO (nunca o primeiro); contexto da conversa desempata", () => {
  const r = resolverEntidade("matheus", CADASTRO);
  assert.equal(r.estado, "AMBIGUO");
  assert.deepEqual(r.candidatos.map((c) => c.nome).sort(), ["Matheus Lima", "Matheus Rocha"]);
  assert.equal(resolverEntidade("matheus", CADASTRO, { preferidos: ["Matheus Rocha"] }).escolhido?.nome, "Matheus Rocha", "esclarecido na conversa");
  assert.equal(resolverEntidade("matheus lima", CADASTRO).escolhido?.nome, "Matheus Lima");
  assert.equal(resolverEntidade("matheus", [{ id: "x", nome: "Matheus Rocha" }, { id: "x", nome: "Matheus Rocha" }]).estado, "UNICO", "o mesmo registro duas vezes não é ambiguidade");
});

test("RS-04 APELIDOS do cadastro (quando existem) resolvem; apelido não cadastrado não é inventado", () => {
  const C = [{ nome: "Francisco Alves", apelidos: ["Chico"] }, { nome: "Francisco Souza" }];
  assert.equal(resolverEntidade("chico", C).escolhido?.nome, "Francisco Alves");
  assert.equal(resolverEntidade("francisco", C).estado, "AMBIGUO");
  assert.equal(resolverEntidade("tico", C).estado, "NENHUM");
});

test("RS-05 CONCEITOS financeiros: entrada de caixa × reforço, retirada × despesa, receita × recebimento, total × saldo, quantidade × custo", () => {
  const k = criarResolvedorDeConceitos();
  const ids = (q) => k.conceitos(q).map((c) => c.id);
  assert.deepEqual(ids("quanto entrou no caixa hoje?"), ["ENTRADA_DE_CAIXA"]);
  assert.ok(ids("teve sangria pra comprar grampo").includes("RETIRADA_DE_CAIXA"));
  assert.deepEqual(ids("receita x recebimento de outubro"), ["RECEITA", "RECEBIMENTO"]);
  assert.ok(ids("quanto falta pagar da coca").includes("SALDO_EM_ABERTO"));
  assert.ok(ids("qnto o motoboy custou").includes("ENTREGADOR"));
  assert.deepEqual(ids("caixa e bancos"), [], "'caixa' ≠ 'baixa' (sem tolerância em palavra curta)");
  const o = k.orientacao("quanto entrou no caixa hoje?");
  assert.match(o, /Reforço sozinho NÃO é a entrada do caixa/);
  for (const c of GLOSSARIO_BASE.conceitos) for (const x of c.confundirCom) assert.ok(GLOSSARIO_BASE.conceitos.some((y) => y.id === x), `${c.id} → ${x}`);
  assert.equal(GLOSSARIO_BASE.aprovadoPor, null, "glossário base ainda NÃO aprovado (F5): não é regra vigente");
});

// ------------------------------------------------------------------------- integração com as ferramentas do catálogo
const conta = (fornecedor, descricao, valor, extra = {}) => ({ id: `c-${fornecedor}-${valor}`, fornecedor: { nome: fornecedor }, descricao, categoria: { nome: "Embalagens" }, competencia: "2026-10", situacao: "EM_ABERTO", saldoCentavos: valor, valorOriginalCentavos: valor, pagoCentavos: 0, ...extra });
const portaCom = (itens) => ({ async ler(op) { if (op === "consultarContasAPagar") return { itens, paginacao: { paginas: 1 } }; if (op === "consultarEntregadoresProprios") return { entregadores: itens }; throw new Error(op); } });
const escopo = { organizacaoId: "o", unidadeId: "u" };

test("RS-06 contas_a_pagar: 'embalagem' acha o fornecedor 'Atacadão Embalagens' (achado I049 da suíte independente, corrigido pela causa)", async () => {
  const r = await CATALOGO.contas_a_pagar.executar({ porta: portaCom([conta("Atacadão Embalagens", "caixas de pizza", 30000), conta("Coca-Cola FEMSA", "refrigerantes", 50000, { categoria: { nome: "Bebidas" } })]), escopo, args: { termo: "embalagem", situacao: "TODAS_EM_ABERTO" } });
  assert.equal(r.dados.totais.quantidade, 1);
  assert.equal(r.dados.totais.saldoCentavos, 30000);
  assert.equal(r.dados.ambiguidade, undefined);
});

test("RS-07 contas_a_pagar e entregadores: nome que combina com DOIS cadastros diferentes ⇒ a ferramenta devolve a ambiguidade para o modelo perguntar", async () => {
  const r = await CATALOGO.contas_a_pagar.executar({ porta: portaCom([conta("Matheus Rocha", "entregas", 46200), conta("Matheus Lima", "entregas", 12000)]), escopo, args: { termo: "Matheus" } });
  assert.deepEqual(r.dados.ambiguidade?.candidatos.sort(), ["Matheus Lima", "Matheus Rocha"]);
  const s = await CATALOGO.contas_a_pagar.executar({ porta: portaCom([conta("Matheus Rocha", "entregas", 46200), conta("Matheus Lima", "entregas", 12000)]), escopo, args: { termo: "Matheus Rocha" } });
  assert.equal(s.dados.ambiguidade, undefined); assert.equal(s.dados.totais.quantidade, 1);
  const e = await CATALOGO.entregadores_da_semana.executar({ porta: portaCom([{ nome: "Matheus Rocha", entregas: 40, totalCentavos: 46200 }, { nome: "Matheus Lima", entregas: 10, totalCentavos: 12000 }, { nome: "João", entregas: 5, totalCentavos: 5000 }]), escopo, args: { entregador: "matheus" } });
  assert.equal(e.dados.entregadores.length, 2); assert.ok(e.dados.ambiguidade);
});

test("RS-08 termo de PRODUTO na descrição (brownie) não é ambiguidade de fornecedor: soma as contas que o citam", async () => {
  const r = await CATALOGO.contas_a_pagar.executar({ porta: portaCom([conta("Doce Sabor", "brownies para revenda", 8000), conta("Padaria Central", "brownie de chocolate", 4000), conta("Coca-Cola FEMSA", "refrigerantes", 50000)]), escopo, args: { termo: "brownies" } });
  assert.equal(r.dados.totais.quantidade, 2);
  assert.equal(r.dados.ambiguidade, undefined, "o termo não combina com NOME de fornecedor nenhum");
});
