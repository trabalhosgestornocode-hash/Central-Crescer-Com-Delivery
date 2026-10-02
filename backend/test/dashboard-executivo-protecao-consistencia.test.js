// REGRESSÃO 2026-10-02 — Simulador mostrava Proteção 32,86% (D × Z4) e os
// Indicadores de Rentabilidade mostravam Serviços 7,00% / Total 32,00%.
// Causa: trava `min(limiteServicos, …)` em calc.js#metasComProtecaoPrecificacao
// (NÃO era falha de lookup nem fallback — a proteção era encontrada).
//
// Aqui a cadeia é a REAL de ponta a ponta — obterMes → carregarPrecosRentabilidade
// → resolverTabelasComerciaisUnidade → calcularProtecaoPrecificacao →
// metasComProtecaoPrecificacao — e o Simulador é o adaptador real
// (simulador.service.js). Só o banco é falso. Preços = catálogo real do
// Churrasco 15cm (D 23,50 · E 24,00 · F 24,50 · Z4 35,00).
//
// Rodar: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… SUPABASE_ANON_KEY=… \
//   node --experimental-vm-modules --test test/dashboard-executivo-protecao-consistencia.test.js
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

// --- banco falso ------------------------------------------------------------
const UNIDADES = {
  "u-e": { tabela_balcao: "E", tabela_ifood: "Z4" },
  "u-d": { tabela_balcao: "D", tabela_ifood: "Z4" },
  "u-f": { tabela_balcao: "F", tabela_ifood: "Z4" },
  "u-sem-preco": { tabela_balcao: "D", tabela_ifood: "Z9" }, // Z9 sem preço cadastrado
  "u-sem-ifood": { tabela_balcao: "E", tabela_ifood: null },
};
const PRECOS = { balcao: { D: 23.5, E: 24, F: 24.5 }, ifood: { Z4: 35 } };
function banco() {
  return {
    from(tabela) {
      const f = {};
      const resposta = () => {
        if (tabela === "unidades") {
          const u = UNIDADES[f.id];
          return { data: u ? { id: f.id, organizacao_id: "org", ...u } : null, error: null };
        }
        if (tabela === "produtos") return { data: [{ id: "p1", nome: "Churrasco 15cm", tamanho: "15cm", custo_manual: 6, ativo: true }], error: null };
        if (tabela === "produto_precos") {
          const preco = PRECOS[f.canal]?.[f.tabela];
          return { data: preco != null ? { preco, desatualizado: false } : null, error: null };
        }
        return { data: [], error: null };
      };
      const q = {
        select: () => q, eq: (k, v) => { f[k] = v; return q; }, ilike: () => q, gte: () => q, lte: () => q,
        in: () => q, order: () => q, limit: () => q, not: () => q,
        maybeSingle: () => { const r = resposta(); return Promise.resolve(Array.isArray(r.data) ? { data: null, error: null } : r); },
        then: (a, b) => Promise.resolve(resposta()).then(a, b),
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
// metas_indicadores reais (globais) do Marketplace
const METAS_MP = { taxas_comissoes: { metaIdeal: 13, limite: 13 }, servicos_promocoes: { metaIdeal: 5, limite: 7 }, taxas_entregadores: { metaIdeal: 12, limite: 15 }, total_deducoes: { metaIdeal: 30, limite: 35 } };
const svc = await carregar("dashboardExecutivo.service.js", {
  "../../config/supabase.js": { supabase: db },
  "../../shared/desbloqueiosIfood.js": { carregarDatasLiberadas: async () => new Set() },
  "./dashboardExecutivo.metas.service.js": {
    resolverMetas: async () => structuredClone(METAS_MP),
    obterModeloLogistico: async () => ({ modeloLogistico: "marketplace" }),
    definirModeloLogistico() {}, historicoModeloLogistico() {},
  },
  "./dashboardExecutivo.precos.service.js": precosSvc,
});
const sim = await carregar("dashboardExecutivo.simulador.service.js", { "./dashboardExecutivo.service.js": svc });

const mes = (unidadeIdSolicitado, extra = {}) => svc.obterMes({ organizacaoId: "org", unidadeIdSessao: null, unidadeIdSolicitado, mes: 10, ano: 2026, ...extra });
const metaIdeal = (d, k) => d.indicadoresRentabilidade[k].metaIdeal;
const dois = (v) => v.toFixed(2); // mesma precisão da UI (fmtPctRentabilidade: 2 casas)

test("CASO 1 — E × Z4 (Marketplace): Serviços 6,43 · Total 31,43", async () => {
  const d = await mes("u-e");
  assert.equal(dois(d.protecaoPrecificacao.protecaoPrecificacaoPct), "31.43");
  assert.equal(dois(metaIdeal(d, "servicos_promocoes")), "6.43");
  assert.equal(dois(metaIdeal(d, "total_deducoes")), "31.43");
  assert.equal(metaIdeal(d, "taxas_comissoes"), 13);
  assert.equal(metaIdeal(d, "taxas_entregadores"), 12);
});

test("CASO 2 — D × Z4 (Marketplace): Serviços 7,86 · Total 32,86 (regressão: não 7,00 / 32,00)", async () => {
  const d = await mes("u-d");
  assert.deepEqual(d.protecaoPrecificacao.precos.oficiais, { tabelaBalcao: "D", tabelaIfood: "Z4" });
  assert.equal(d.protecaoPrecificacao.precos.balcao.preco, 23.5);
  assert.equal(d.protecaoPrecificacao.precos.ifood.preco, 35);
  assert.equal(dois(d.protecaoPrecificacao.protecaoPrecificacaoPct), "32.86");
  assert.equal(dois(metaIdeal(d, "servicos_promocoes")), "7.86");
  assert.equal(dois(metaIdeal(d, "total_deducoes")), "32.86");
  // limite logístico intacto; status acima dele continua "Atenção"
  assert.equal(d.indicadoresRentabilidade.servicos_promocoes.limite, 7);
  assert.equal(d.protecaoPrecificacao.metaServicosAcimaDoLimite, true);
});

test("CASO 3 — proteção não calculável (tabela sem preço): mantém o fallback atual (metas_indicadores 5 / 30)", async () => {
  const d = await mes("u-sem-preco");
  assert.equal(d.protecaoPrecificacao.protecaoPrecificacaoPct, null);
  assert.equal(metaIdeal(d, "servicos_promocoes"), 5);
  assert.equal(metaIdeal(d, "total_deducoes"), 30);
});

test("CASO 4 — tabela oficial ausente: payload sinaliza oficiais null (bloqueio 'Tabelas oficiais não selecionadas' no front)", async () => {
  const d = await mes("u-sem-ifood");
  assert.deepEqual(d.protecaoPrecificacao.precos.oficiais, { tabelaBalcao: "E", tabelaIfood: null });
  assert.equal(d.protecaoPrecificacao.protecaoPrecificacaoPct, null);
});

test("CASO 5 — tabela temporária (Comparar/Simulador) não substitui a oficial", async () => {
  const d = await mes("u-sem-ifood", { tabelaIfood: "Z4" });
  assert.equal(d.protecaoPrecificacao.precos.tabelas.ifood, "Z4");             // simulação usou Z4…
  assert.deepEqual(d.protecaoPrecificacao.precos.oficiais, { tabelaBalcao: "E", tabelaIfood: null }); // …oficial segue null
  // o Dashboard (fetch principal) nunca envia tabela: continua sem proteção
  assert.equal((await mes("u-sem-ifood")).protecaoPrecificacao.protecaoPrecificacaoPct, null);
});

test("CONSISTÊNCIA Simulador × Indicadores — mesma resolução para toda combinação oficial (D/E/F × Z4)", async () => {
  for (const unidade of ["u-d", "u-e", "u-f"]) {
    const painel = await mes(unidade);
    const simulador = await sim.simularPrecoProduto({ organizacaoId: "org", unidadeIdSessao: null, unidadeIdSolicitado: unidade, mes: 10, ano: 2026, canal: "ifood" });
    const pct = simulador.protecaoPrecificacao.protecaoPrecificacaoPct;
    // valor BRUTO idêntico (sem arredondamento intermediário) nos dois consumidores
    assert.equal(pct, painel.protecaoPrecificacao.protecaoPrecificacaoPct, unidade);
    // e é exatamente essa proteção que gera a Meta Ideal (reserva MP = 13 + 12)
    assert.equal(metaIdeal(painel, "total_deducoes"), 13 + (pct - 25) + 12, unidade);
    assert.equal(dois(metaIdeal(painel, "total_deducoes")), dois(pct), unidade);
    assert.equal(dois(metaIdeal(painel, "servicos_promocoes")), dois(pct - 25), unidade);
  }
});
