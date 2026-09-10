// Tela "Rede de Associados" do Painel Administrativo — construtores puros (sem
// DOM). Nomes internos (id/rota/funções: `mentorados`) mantidos de propósito.
//
// Rodar: node --test frontend/test/painelAdmMentorados.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { htmlMentorados, htmlDrawerVinculos } = await import("../src/painelAdmViews.js");

const JOAO = {
  id: "u-joao", nome: "João da Silva", email: "joao@ex.com", contaAtiva: true,
  perfis: [{ id: "u-joao", nome: "João da Silva", ativo: true }], multiPerfil: false,
  totalVinculos: 3, totalEmpresas: 1, totalUnidades: 2,
  vinculos: [{
    empresaId: "o1", empresaNome: "Grupo Saci", empresaStatus: "ativa",
    associacaoDireta: true, papel: "organization_admin", papelRotulo: "Administrador",
    perfilNomes: [],
    unidades: [
      { unidadeId: "ua", unidadeNome: "Subway Saci — Matriz", papelRotulo: "Gestor de Unidade", perfilNome: null },
      { unidadeId: "ub", unidadeNome: "Subway Laranjeiras", papelRotulo: "herda da empresa", perfilNome: null },
    ],
  }],
};
const MARIA = {
  id: "u-maria", nome: "Maria Oliveira", email: "maria@ex.com", contaAtiva: true,
  perfis: [{ id: "u-maria", nome: "Maria Oliveira", ativo: true }], multiPerfil: false,
  totalVinculos: 1, totalEmpresas: 1, totalUnidades: 0,
  vinculos: [{
    empresaId: "o2", empresaNome: "Grupo Montes Claros", empresaStatus: "ativa",
    associacaoDireta: true, papel: "viewer", papelRotulo: "Consulta", perfilNomes: [], unidades: [],
  }],
};
const ANA = {
  id: "u-ana", nome: "Ana", email: "ana@ex.com", contaAtiva: true,
  perfis: [{ id: "u-ana", nome: "Ana", ativo: true }, { id: "u-bea", nome: "Bea", ativo: true }],
  multiPerfil: true, totalVinculos: 2, totalEmpresas: 2, totalUnidades: 0,
  vinculos: [
    { empresaId: "o1", empresaNome: "Grupo Saci", empresaStatus: "ativa", associacaoDireta: true, papelRotulo: "Financeiro", perfilNomes: ["Ana"], unidades: [] },
    { empresaId: "o2", empresaNome: "Grupo Montes Claros", empresaStatus: "ativa", associacaoDireta: true, papelRotulo: "Consulta", perfilNomes: ["Bea"], unidades: [] },
  ],
};

describe("htmlMentorados", () => {
  test("cabeçalho, contador e linhas", () => {
    const h = htmlMentorados({ mentorados: [ANA, JOAO, MARIA], total: 3 }, { termo: "" });
    assert.match(h, /Rede de Associados/);
    assert.match(h, /Acompanhe os associados vinculados/);
    assert.match(h, /3 associados/);
    assert.match(h, /João da Silva/);
    assert.match(h, /joao@ex\.com/);
    assert.match(h, /3 vínculos/);      // João
    assert.match(h, /1 vínculo</);       // Maria (singular)
    assert.match(h, /Ver vínculos/);
    assert.match(h, /Buscar por nome ou e-mail/);
  });

  test("busca filtra por nome ou e-mail (client-side)", () => {
    const h = htmlMentorados({ mentorados: [JOAO, MARIA], total: 2 }, { termo: "maria@" });
    assert.match(h, /Maria Oliveira/);
    assert.doesNotMatch(h, /João da Silva/);
    assert.match(h, /1 de 2/);
  });

  test("estado vazio quando não há mentorados", () => {
    const h = htmlMentorados({ mentorados: [], total: 0 }, { termo: "" });
    assert.match(h, /Nenhum associado vinculado/);
  });

  test("busca sem resultado explica o escopo", () => {
    const h = htmlMentorados({ mentorados: [JOAO], total: 1 }, { termo: "zzz" });
    assert.match(h, /Nada encontrado para &quot;zzz&quot;/);
  });
});

describe("htmlDrawerVinculos", () => {
  test("agrupa por empresa e lista as unidades sob ela", () => {
    const h = htmlDrawerVinculos(JOAO);
    assert.match(h, /Vínculos de João da Silva/);
    assert.match(h, /Grupo Saci/);
    assert.match(h, /Subway Saci — Matriz/);
    assert.match(h, /Subway Laranjeiras/);
    assert.match(h, /Acesso à empresa · Administrador/);
  });

  test("conta multi-perfil mostra os perfis e marca cada empresa", () => {
    const h = htmlDrawerVinculos(ANA);
    assert.match(h, /Perfis nesta conta/);
    assert.match(h, /perfil Ana/);
    assert.match(h, /perfil Bea/);
  });

  test("empresa sem unidade específica é explicada, não fica vazia", () => {
    const h = htmlDrawerVinculos(MARIA);
    assert.match(h, /Sem unidade específica/);
  });
});
