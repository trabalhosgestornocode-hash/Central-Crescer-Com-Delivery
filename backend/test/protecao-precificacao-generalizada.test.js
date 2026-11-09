// Proteção de precificação generalizada: produto escolhido + condições da PRÓPRIA organização.
// Sem produtoId, o comportamento LEGADO das Subways ("Churrasco 15cm") permanece idêntico.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SourceTextModule, SyntheticModule } from "node:vm";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);

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

// "Banco" com 2 empresas: cada uma só enxerga os próprios produtos.
const PRODUTOS = [
  { id: "11111111-1111-4111-8111-111111111111", organizacao_id: "subway", nome: "Churrasco 15cm", tamanho: "15cm", custo_manual: 6, ativo: true, vendavel: true },
  { id: "22222222-2222-4222-8222-222222222222", organizacao_id: "caramelle", nome: "Cappuccino", tamanho: null, custo_manual: null, ativo: true, vendavel: true },
  { id: "33333333-3333-4333-8333-333333333333", organizacao_id: "caramelle", nome: "Calda", tamanho: null, custo_manual: null, ativo: true, vendavel: false },
];
const consultas = [];
function banco() {
  return {
    from(tabela) {
      const f = {};
      const resposta = () => {
        consultas.push({ tabela, ...f });
        if (tabela === "produtos") {
          const achados = PRODUTOS.filter((p) => Object.entries(f).every(([k, v]) => k === "nome" || p[k] === v));
          return { data: f.id ? (achados[0] ?? null) : achados, error: null };
        }
        if (tabela === "produto_precos") return { data: { preco: { balcao: 20, ifood: 28 }[f.canal], desatualizado: false }, error: null };
        return { data: null, error: null };
      };
      const q = { select: () => q, eq: (k, v) => { f[k] = v; return q; }, ilike: () => q, maybeSingle: () => Promise.resolve(resposta()), then: (a, b) => Promise.resolve(resposta()).then(a, b) };
      return q;
    },
  };
}
const db = banco();
const condicoes = { canais: [{ canal: "ifood", comissao: 0.23, taxas: 0.015, promocao: 0.05 }] };
const svc = await carregar("dashboardExecutivo.precos.service.js", {
  "../../config/supabase.js": { supabase: db },
  "../produtos/custo.js": { carregarGrafo: async () => ({}), resumoProduto: ({ produtoId }) => ({ custo: produtoId.startsWith("2") ? 4 : 6, cmv_pct: 25, status_ficha: { chave: "completa" } }) },
  "../../shared/tabelaComercial.js": { resolverTabelasComerciaisUnidade: async () => ({ tabelaBalcao: "A", tabelaIfood: "A" }) },
  "../cmv/cmv.condicoes.js": {
    condicoesComerciais: async ({ organizacaoId }) => (organizacaoId === "caramelle" ? condicoes : { canais: [] }),
    deducoesConfiguradas: (await import("../src/modules/cmv/cmv.condicoes.js")).deducoesConfiguradas,
  },
});

test("LEGADO (sem produtoId): continua procurando 'Churrasco 15cm' e NÃO traz deduções configuradas", async () => {
  const r = await svc.carregarPrecosRentabilidade({ organizacaoId: "subway", unidadeId: "u" });
  assert.equal(r.produto.nome, "Churrasco 15cm");
  assert.equal("deducoesConfiguradas" in r, false);
  assert.equal("produtoSelecionado" in r, false);
  assert.equal(r.balcao.preco, 20); assert.equal(r.ifood.preco, 28);
});
test("sem produtoId numa empresa sem 'Churrasco 15cm': indisponível, com instrução de selecionar produto", async () => {
  const r = await svc.carregarPrecosRentabilidade({ organizacaoId: "caramelle", unidadeId: "u" });
  assert.equal(r.produto, null);
  assert.match(r.balcao.indisponivel, /Selecione um produto/);
});
test("com produtoId: usa o produto escolhido, preços/custo dele e as condições DA Caramelle", async () => {
  const r = await svc.carregarPrecosRentabilidade({ organizacaoId: "caramelle", unidadeId: "u", produtoId: "22222222-2222-4222-8222-222222222222" });
  assert.equal(r.produto.nome, "Cappuccino"); assert.equal(r.produtoSelecionado, true);
  assert.equal(r.balcao.custo, 4);
  assert.equal(r.deducoesConfiguradas.motivo, null);
  assert.ok(Math.abs(r.deducoesConfiguradas.taxasComissoesPct - 24.5) < 1e-9); // 23% + 1,5%
  assert.ok(Math.abs(r.deducoesConfiguradas.servicosPromocoesPct - 5) < 1e-9);
});
test("ISOLAMENTO: produtoId de OUTRA empresa não é encontrado (nada vaza)", async () => {
  const r = await svc.carregarPrecosRentabilidade({ organizacaoId: "caramelle", unidadeId: "u", produtoId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(r.produto, null);
  assert.match(r.ifood.indisponivel, /não encontrado nesta empresa/);
  const q = consultas.filter((c) => c.tabela === "produtos" && c.id === "11111111-1111-4111-8111-111111111111").at(-1);
  assert.equal(q.organizacao_id, "caramelle"); // a consulta sempre carrega o filtro da organização do contexto
});
test("produto NÃO vendável (preparação) não pode ser usado na proteção", async () => {
  const r = await svc.carregarPrecosRentabilidade({ organizacaoId: "caramelle", unidadeId: "u", produtoId: "33333333-3333-4333-8333-333333333333" });
  assert.equal(r.produto, null);
});
test("empresa sem condições do iFood: deduções configuradas indisponíveis, com motivo (nunca assume)", async () => {
  const r = await svc.carregarPrecosRentabilidade({ organizacaoId: "subway", unidadeId: "u", produtoId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(r.deducoesConfiguradas.taxasComissoesPct, null);
  assert.equal(r.deducoesConfiguradas.motivo, "canal_sem_condicoes");
});
test("produtoId malformado é recusado antes de consultar o banco", async () => {
  await assert.rejects(() => svc.carregarPrecosRentabilidade({ organizacaoId: "caramelle", unidadeId: "u", produtoId: "x' or 1=1" }));
});
