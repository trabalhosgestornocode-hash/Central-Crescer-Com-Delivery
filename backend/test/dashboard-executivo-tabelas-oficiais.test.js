// `precos.oficiais` (GET /dashboard-executivo/mes → protecaoPrecificacao.precos)
// é a fonte do BLOQUEIO dos Indicadores de Rentabilidade no frontend
// (frontend/src/dashboardExecutivoBloqueio.js). Garante que:
//   * vem SEMPRE de unidades.tabela_balcao/tabela_ifood (resolver real de
//     shared/tabelaComercial.js), da unidade pedida;
//   * parâmetros temporários (tabelaBalcao/tabelaIfood — comparação/Simulador)
//     mudam só `tabelas`, nunca `oficiais`;
//   * não há cache: depois de salvar em Configurações → Tabelas Comerciais, a
//     próxima chamada já enxerga a configuração nova.
//
// Rodar: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… SUPABASE_ANON_KEY=… \
//   node --experimental-vm-modules --test test/dashboard-executivo-tabelas-oficiais.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SourceTextModule, SyntheticModule } from "node:vm";

const dir = new URL("../src/modules/dashboard-executivo/", import.meta.url);
async function carregar(nome, mocks) {
  const url = new URL(nome, dir);
  const m = new SourceTextModule(readFileSync(url, "utf8"), { identifier: url.href });
  await m.link(async (spec) => {
    const ns = mocks[spec] ?? await import(new URL(spec, url));
    return new SyntheticModule(Object.keys(ns), function () { for (const [k, v] of Object.entries(ns)) this.setExport(k, v); });
  });
  await m.evaluate();
  return m.namespace;
}

// "Banco": unidades com tabelas oficiais mutáveis (simula o PATCH de Configurações).
const unidades = { a: { tabela_balcao: "E", tabela_ifood: "Z4" }, b: { tabela_balcao: "E", tabela_ifood: null } };
const leiturasUnidades = [];
function banco() {
  return {
    from(tabela) {
      const filtros = {};
      const resposta = () => {
        if (tabela === "unidades") { leiturasUnidades.push(filtros.id); return { data: unidades[filtros.id] ?? null, error: null }; }
        if (tabela === "produtos") return { data: [{ id: "p1", nome: "Churrasco 15cm", tamanho: "15cm", custo_manual: 6, ativo: true }], error: null };
        if (tabela === "produto_precos") return { data: { preco: { balcao: 24, ifood: 35 }[filtros.canal], desatualizado: false }, error: null };
        return { data: null, error: null };
      };
      const q = {
        select: () => q, eq: (k, v) => { filtros[k] = v; return q; }, ilike: () => q,
        maybeSingle: () => Promise.resolve(resposta()), then: (a, b) => Promise.resolve(resposta()).then(a, b),
      };
      return q;
    },
  };
}
const db = banco();
const tabelaComercialReal = await import("../src/shared/tabelaComercial.js");
const precosSvc = await carregar("dashboardExecutivo.precos.service.js", {
  "../../config/supabase.js": { supabase: db },
  "../produtos/custo.js": { carregarGrafo: async () => ({}), resumoProduto: () => ({ custo: 6, cmv_pct: 25, status_ficha: { chave: "ok" } }) },
  "../../shared/tabelaComercial.js": {
    resolverTabelasComerciaisUnidade: (p) => tabelaComercialReal.resolverTabelasComerciaisUnidade(p, { supabaseClient: db }),
  },
});
const carregarPrecos = (p) => precosSvc.carregarPrecosRentabilidade({ organizacaoId: "org", ...p });

test("unidade configurada: oficiais = persistidas", async () => {
  const r = await carregarPrecos({ unidadeId: "a" });
  assert.deepEqual(r.oficiais, { tabelaBalcao: "E", tabelaIfood: "Z4" });
  assert.deepEqual(r.tabelas, { balcao: "E", ifood: "Z4" });
});

test("comparação temporária Z4 com iFood oficial ausente: só `tabelas` muda, `oficiais` segue null", async () => {
  const r = await carregarPrecos({ unidadeId: "b", tabelaIfood: "Z4" });
  assert.equal(r.tabelas.ifood, "Z4");
  assert.equal(r.ifood.preco, 35); // o cálculo usou a temporária…
  assert.deepEqual(r.oficiais, { tabelaBalcao: "E", tabelaIfood: null }); // …mas a oficial não
});

test("troca de unidade: cada chamada lê a unidade pedida (A liberada, B pendente)", async () => {
  assert.equal((await carregarPrecos({ unidadeId: "a" })).oficiais.tabelaIfood, "Z4");
  assert.equal((await carregarPrecos({ unidadeId: "b" })).oficiais.tabelaIfood, null);
  assert.deepEqual(leiturasUnidades.slice(-2), ["a", "b"]);
});

test("após salvar a tabela oficial, a próxima leitura já reflete (sem cache)", async () => {
  assert.equal((await carregarPrecos({ unidadeId: "b" })).oficiais.tabelaIfood, null);
  unidades.b.tabela_ifood = "Z4"; // PATCH /unidade/tabelas-comerciais
  assert.deepEqual((await carregarPrecos({ unidadeId: "b" })).oficiais, { tabelaBalcao: "E", tabelaIfood: "Z4" });
});
