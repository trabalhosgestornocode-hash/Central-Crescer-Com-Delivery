// Perfil de EXIBIÇÃO (Operador de Exibição, `display_operator`) — catálogo de permissões e papéis.
//
// Prova, sem banco, que:
//   * o papel novo tem UMA permissão (`checklist.visualizar`) e nenhuma outra;
//   * NENHUM papel existente ganhou ou perdeu algo além de `checklist.visualizar` (linha de base fixada abaixo,
//     escrita à mão a partir do catálogo anterior — um acidente num papel antigo faz este teste falhar);
//   * o papel de exibição só é válido em vínculo de UNIDADE, nunca de empresa.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  PERMISSOES, PAPEL_EXIBICAO, PAPEIS_VINCULO, PAPEIS_UNIDADE, PAPEIS_ROTULO,
  permissoesDoPapel, papelValido, papelUnidadeValido, rotuloPapel, temPermissao,
} from "../src/shared/permissoes.js";

const LEITURA_ANTES = [
  "dashboard.ver", "produtos.ver", "insumos.ver", "cmv.ver", "vendas.ver",
  "integracoes.ver", "dashboard_executivo.ver", "bonificacao_mensal.ver", "parser_food_delivery.ver",
];

/** Catálogo ANTERIOR à mudança (commit 2d588a2), papel por papel. */
const ANTES = {
  unit_manager: [...LEITURA_ANTES, "produtos.editar", "insumos.editar", "vendas.importar", "vendas.editar",
    "integracoes.gerenciar", "usuarios.ver", "configuracoes.ver", "dashboard_executivo.lancar", "bonificacao_mensal.lancar",
    "parser_food_delivery.importar", "parser_food_delivery.classificar"],
  finance: [...LEITURA_ANTES, "financeiro.ver", "configuracoes.ver", "dashboard_executivo.lancar", "dashboard_executivo.corrigir",
    "dashboard_executivo.configurar", "dashboard_executivo.resetar_teste", "bonificacao_mensal.lancar",
    "parser_food_delivery.importar", "parser_food_delivery.classificar"],
  operations: [...LEITURA_ANTES, "produtos.editar", "insumos.editar", "vendas.importar", "dashboard_executivo.lancar",
    "dashboard_executivo.corrigir", "dashboard_executivo.configurar", "dashboard_executivo.resetar_teste",
    "bonificacao_mensal.lancar", "parser_food_delivery.importar", "parser_food_delivery.classificar"],
  viewer: [...LEITURA_ANTES],
};

const ordenar = (a) => [...a].sort();

describe("perfil de exibição — permissões", () => {
  test("o papel existe e tem EXATAMENTE checklist.visualizar", () => {
    assert.equal(PAPEL_EXIBICAO, "display_operator");
    assert.deepEqual(permissoesDoPapel(PAPEL_EXIBICAO), ["checklist.visualizar"]);
    assert.equal(PERMISSOES.CHECKLIST_VISUALIZAR, "checklist.visualizar");
  });

  test("não tem NENHUMA permissão de outro módulo (financeiro, vendas, CMV, bonificação, parser, usuários, integrações, config)", () => {
    const perms = permissoesDoPapel(PAPEL_EXIBICAO);
    for (const p of Object.values(PERMISSOES)) {
      if (p === "checklist.visualizar") continue;
      assert.equal(temPermissao(perms, p), false, `não deveria ter ${p}`);
    }
    for (const proibida of ["integracoes.ver", "dashboard.ver", "vendas.ver", "cmv.ver", "financeiro.ver", "usuarios.ver", "configuracoes.ver",
      "bonificacao_mensal.ver", "parser_food_delivery.ver", "dashboard_executivo.ver", "produtos.ver", "insumos.ver"]) {
      assert.equal(temPermissao(perms, proibida), false, proibida);
    }
  });

  test("é somente leitura: nada de editar/importar/lançar/gerenciar/excluir/configurar", () => {
    for (const p of permissoesDoPapel(PAPEL_EXIBICAO)) assert.doesNotMatch(p, /editar|importar|lancar|gerenciar|excluir|configurar|corrigir|classificar|resetar/);
  });

  test("papel desconhecido continua caindo em viewer (e NÃO no papel de exibição)", () => {
    assert.deepEqual(ordenar(permissoesDoPapel("papel_que_nao_existe")), ordenar(ANTES.viewer.concat("checklist.visualizar")));
  });

  test("os papéis EXISTENTES não mudaram: exatamente o catálogo anterior + checklist.visualizar", () => {
    for (const [papel, antes] of Object.entries(ANTES)) {
      assert.deepEqual(ordenar(permissoesDoPapel(papel)), ordenar([...antes, "checklist.visualizar"]), papel);
    }
    // organization_admin = todas as permissões (as de antes + a nova).
    const admin = permissoesDoPapel("organization_admin");
    assert.ok(admin.includes("checklist.visualizar"));
    assert.deepEqual(ordenar(admin), ordenar(Object.values(PERMISSOES)));
    // E nenhuma permissão do catálogo anterior sumiu do admin.
    for (const p of [...LEITURA_ANTES, "dashboard_executivo.excluir", "bonificacao_mensal.excluir", "parser_food_delivery.excluir", "usuarios.gerenciar"]) {
      assert.ok(admin.includes(p), p);
    }
  });

  test("todo papel que já abria o Checklist (integracoes.ver) continua abrindo, agora também por checklist.visualizar", () => {
    for (const papel of ["organization_admin", "unit_manager", "finance", "operations", "viewer"]) {
      const perms = permissoesDoPapel(papel);
      assert.ok(perms.includes("integracoes.ver") && perms.includes("checklist.visualizar"), papel);
    }
  });

  test("a permissão é única no catálogo e nenhuma outra fala de 'checklist'", () => {
    const todas = Object.values(PERMISSOES);
    assert.equal(new Set(todas).size, todas.length, "permissões duplicadas");
    assert.deepEqual(todas.filter((p) => /checklist/i.test(p)), ["checklist.visualizar"]);
  });

  test("permissoesDoPapel devolve cópia: alterar o resultado não contamina o catálogo", () => {
    const a = permissoesDoPapel(PAPEL_EXIBICAO);
    a.push("vendas.ver");
    assert.deepEqual(permissoesDoPapel(PAPEL_EXIBICAO), ["checklist.visualizar"]);
  });
});

describe("perfil de exibição — onde o papel pode existir", () => {
  test("NÃO é papel de empresa: fora de PAPEIS_VINCULO e papelValido()", () => {
    assert.equal(PAPEIS_VINCULO.includes(PAPEL_EXIBICAO), false);
    assert.equal(papelValido(PAPEL_EXIBICAO), false);
    assert.deepEqual(PAPEIS_VINCULO, ["organization_admin", "unit_manager", "finance", "operations", "viewer"]);
  });

  test("É papel de unidade: em PAPEIS_UNIDADE e papelUnidadeValido()", () => {
    assert.equal(PAPEIS_UNIDADE.includes(PAPEL_EXIBICAO), true);
    assert.equal(papelUnidadeValido(PAPEL_EXIBICAO), true);
    for (const p of PAPEIS_VINCULO) assert.equal(papelUnidadeValido(p), true, p);
    assert.equal(papelUnidadeValido("platform_superadmin"), false, "superadmin é global, nunca de vínculo");
    assert.equal(papelUnidadeValido("qualquer"), false);
  });

  test("rótulo em português", () => {
    assert.equal(rotuloPapel(PAPEL_EXIBICAO), "Operador de Exibição");
    assert.equal(PAPEIS_ROTULO.display_operator, "Operador de Exibição");
  });
});
