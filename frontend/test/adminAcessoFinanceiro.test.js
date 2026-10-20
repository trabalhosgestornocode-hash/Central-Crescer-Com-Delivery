// Modelo da tela "Acesso Financeiro" do SuperAdmin (gestão simples por unidade) — puro, sem DOM nem rede.
// Rodar: node --test frontend/test/adminAcessoFinanceiro.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  OPCOES_ACESSO, ROTULO_ACESSO, nivelDoSeletor, estadoDaEscrita, mudancas, montarPedido, resumoDoResultado,
} from "../src/adminAcessoFinanceiroModelo.js";
import { adminApi } from "../src/adminApi.js";

const inicial = {
  habilitado: false,
  usuarios: [{ id: "p1", nivel: null }, { id: "p2", nivel: "leitura" }, { id: "eu", nivel: null, propria: true }],
};
const copia = () => ({ habilitado: inicial.habilitado, niveis: Object.fromEntries(inicial.usuarios.map((u) => [u.id, u.nivel])) });

describe("opções do seletor", () => {
  test("quatro opções, na ordem da tela, com os valores do banco", () => {
    assert.deepEqual(OPCOES_ACESSO.map((o) => o.valor), [null, "leitura", "operador", "gestor"]);
    assert.deepEqual(OPCOES_ACESSO.map((o) => o.rotulo), ["Sem acesso", "Visualização", "Operador", "Gestor"]);
    assert.equal(ROTULO_ACESSO.leitura, "Visualização"); assert.equal(ROTULO_ACESSO[""], "Sem acesso");
  });
  test("valor do seletor: desconhecido ou vazio vira Sem acesso (falha fechada)", () => {
    assert.equal(nivelDoSeletor("gestor"), "gestor");
    for (const x of ["", null, undefined, "admin", "root", "Gestor"]) assert.equal(nivelDoSeletor(x), null);
  });
});

describe("estado das escritas (falha fechada)", () => {
  test("só `escritaLiberada === true` libera", () => {
    assert.equal(estadoDaEscrita({ escritaLiberada: true }).liberada, true);
    for (const x of [undefined, null, {}, { escritaLiberada: "true" }, { escritaLiberada: 1 }]) assert.equal(estadoDaEscrita(x).liberada, false);
  });
  test("mensagem do servidor ou padrão; nada de MFA na tela", () => {
    assert.equal(estadoDaEscrita({ escritaLiberada: false, mensagem: "Desligada" }).mensagem, "Desligada");
    assert.match(estadoDaEscrita(undefined).mensagem, /desligada/);
    assert.doesNotMatch(estadoDaEscrita(undefined).mensagem, /MFA|duas etapas/);
  });
});

describe("mudanças e pedido", () => {
  test("sem mexer: nada a salvar e pedido vazio", () => {
    const m = mudancas(inicial, copia());
    assert.equal(m.total, 0);
    assert.deepEqual(montarPedido(inicial, copia()), { habilitado: false, acessos: [] });
  });
  test("ligar o módulo e mudar três usuários = 4 alterações; o pedido só leva quem mudou", () => {
    const a = copia(); a.habilitado = true; a.niveis.p1 = "operador"; a.niveis.p2 = null; a.niveis.eu = "gestor";
    const m = mudancas(inicial, a);
    assert.equal(m.moduloMudou, true); assert.equal(m.total, 4);
    assert.deepEqual(montarPedido(inicial, a), { habilitado: true, acessos: [
      { perfilId: "p1", nivel: "operador" }, { perfilId: "p2", nivel: null }, { perfilId: "eu", nivel: "gestor" },
    ] });
  });
  test("voltar ao valor original desfaz a alteração", () => {
    const a = copia(); a.niveis.p2 = "gestor"; a.niveis.p2 = "leitura";
    assert.equal(mudancas(inicial, a).total, 0);
  });
  test("o pedido nunca leva concedente, empresa nem unidade", () => {
    const a = copia(); a.niveis.p1 = "leitura";
    const p = montarPedido(inicial, a);
    assert.deepEqual(Object.keys(p).sort(), ["acessos", "habilitado"]);
    assert.deepEqual(Object.keys(p.acessos[0]).sort(), ["nivel", "perfilId"]);
  });
});

describe("resumo do que o servidor confirmou", () => {
  test("descreve módulo, concessões e falhas", () => {
    assert.equal(resumoDoResultado({ modulo: { unidadeLigada: true }, concedidos: 2, alterados: 1, revogados: 0, falhas: [] }),
      "Financeiro ligado na unidade · 2 acesso(s) liberado(s) · 1 nível(is) alterado(s).");
    assert.match(resumoDoResultado({ modulo: {}, revogados: 1, falhas: [{ perfilId: "x" }] }), /1 acesso\(s\) removido\(s\)\. 1 usuário\(s\) não puderam/);
    assert.equal(resumoDoResultado({ modulo: {} }), "Nada precisou mudar.");
  });
});

describe("cliente HTTP", () => {
  test("gestão simples: leitura e gravação por unidade", () => {
    for (const m of ["acessosFinanceirosDaUnidade", "salvarAcessosFinanceirosDaUnidade"]) assert.equal(typeof adminApi[m], "function", m);
  });
});
