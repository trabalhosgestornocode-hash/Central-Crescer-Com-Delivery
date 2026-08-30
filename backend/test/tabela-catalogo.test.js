// Catálogo de tabelas comerciais POR EMPRESA — shared/tabelaComercial.js
// #catalogoTabelasComerciais + unidade.service.js#obterTabelasComerciais.
//
// Garante que as opções de tabela vêm do que a EMPRESA realmente tem preço
// (vw_produto_margem), nunca de uma lista global hardcoded. Empresa nova sem
// "AERO A" nunca vê "AERO A".
//
// Rodar: node --test test/tabela-catalogo.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { catalogoTabelasComerciais } from "../src/shared/tabelaComercial.js";
import { obterTabelasComerciais } from "../src/modules/unidade/unidade.service.js";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UNID_A = "11111111-1111-4111-8111-111111111111";

function fakeSupabase(rowsPorTabela) {
  return {
    from(tabela) {
      const ctx = { tabela, filtros: {}, notNull: null };
      const builder = {
        select() { return builder; },
        eq(c, v) { ctx.filtros[c] = v; return builder; },
        not(c, _op, _v) { ctx.notNull = c; return builder; },
        maybeSingle() { return resolver(true); },
        then(res, rej) { return resolver(false).then(res, rej); },
      };
      function resolver(single) {
        let linhas = (rowsPorTabela[tabela] ?? []).filter((l) =>
          Object.entries(ctx.filtros).every(([k, v]) => l[k] === v));
        if (ctx.notNull) linhas = linhas.filter((l) => l[ctx.notNull] != null);
        return Promise.resolve({ data: single ? (linhas[0] ?? null) : linhas, error: null });
      }
      return builder;
    },
  };
}

describe("catalogoTabelasComerciais", () => {
  test("só as tabelas que a empresa tem preço, por canal, ordenadas e sem repetir", async () => {
    const db = fakeSupabase({
      vw_produto_margem: [
        { organizacao_id: ORG_A, canal: "balcao", tabela: "E" },
        { organizacao_id: ORG_A, canal: "balcao", tabela: "E" },
        { organizacao_id: ORG_A, canal: "balcao", tabela: "A" },
        { organizacao_id: ORG_A, canal: "ifood", tabela: "Z1" },
        { organizacao_id: ORG_A, canal: "balcao", tabela: null },
        { organizacao_id: ORG_B, canal: "balcao", tabela: "AERO A" }, // outra empresa
      ],
    });
    const cat = await catalogoTabelasComerciais({ organizacaoId: ORG_A }, { supabaseClient: db });
    assert.deepEqual(cat.balcao, ["A", "E"]);
    assert.deepEqual(cat.ifood, ["Z1"]);
    assert.ok(!cat.balcao.includes("AERO A"), "não vaza tabela de outra empresa");
  });

  test("empresa sem preço nenhum → catálogo vazio (não inventa lista Subway)", async () => {
    const db = fakeSupabase({ vw_produto_margem: [] });
    const cat = await catalogoTabelasComerciais({ organizacaoId: ORG_B }, { supabaseClient: db });
    assert.deepEqual(cat, { balcao: [], ifood: [] });
  });

  test("sem organizacaoId → vazio", async () => {
    const cat = await catalogoTabelasComerciais({ organizacaoId: null }, { supabaseClient: fakeSupabase({}) });
    assert.deepEqual(cat, { balcao: [], ifood: [] });
  });
});

describe("obterTabelasComerciais — valor atual x catálogo", () => {
  test("devolve o valor OFICIAL da unidade e, separado, o catálogo da empresa", async () => {
    const db = fakeSupabase({
      unidades: [{ id: UNID_A, tabela_balcao: "E", tabela_ifood: null }],
      vw_produto_margem: [
        { organizacao_id: ORG_A, canal: "balcao", tabela: "E" },
        { organizacao_id: ORG_A, canal: "balcao", tabela: "F" },
      ],
    });
    const r = await obterTabelasComerciais({ unidadeId: UNID_A, organizacaoId: ORG_A }, { supabase: db });
    assert.equal(r.tabelaBalcao, "E");          // valor atual
    assert.equal(r.tabelaIfood, null);
    assert.deepEqual(r.catalogo.balcao, ["E", "F"]); // opções permitidas
  });

  test("sem unidade → 400", async () => {
    await assert.rejects(
      () => obterTabelasComerciais({ unidadeId: null, organizacaoId: ORG_A }, { supabase: fakeSupabase({}) }),
      /Selecione uma unidade/,
    );
  });
});
