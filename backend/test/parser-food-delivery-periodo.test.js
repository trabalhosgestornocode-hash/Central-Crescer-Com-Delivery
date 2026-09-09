import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SourceTextModule, SyntheticModule } from "node:vm";
import { normalizarPeriodo, horaOperacional, consolidarPedidosPeriodo } from "../src/modules/parser-food-delivery/parserFoodDelivery.periodo.js";

for (const [inicio, fim, proximo] of [
  ["2026-09-01", "2026-09-01", "2026-09-02"],
  ["2026-09-01", "2026-09-05", "2026-09-06"],
  ["2026-08-31", "2026-09-01", "2026-09-02"],
  ["2026-12-31", "2027-01-01", "2027-01-02"],
  ["2024-02-28", "2024-02-29", "2024-03-01"],
]) test(`intervalo inclusivo ${inicio} a ${fim}`, () => {
  assert.deepEqual(normalizarPeriodo(inicio, fim), {
    dataInicio: inicio, dataFim: fim, inicio: `${inicio}T00:00:00.000Z`, fimExclusivo: `${proximo}T00:00:00.000Z`,
  });
});

for (const [inicio, fim] of [
  [null, null], ["2026-09-01", undefined], [undefined, "2026-09-01"],
  ["2026-02-30", "2026-09-01"], ["2026-09-01", "2026-02-29"],
  ["01/09/2026", "2026-09-01"], ["2026-09-01", "inválida"],
  ["2026-09-05", "2026-09-01"], [["2026-09-01"], "2026-09-01"],
]) test(`HTTP 400 para ${JSON.stringify([inicio, fim])}`, () => {
  assert.throws(() => normalizarPeriodo(inicio, fim), (e) => e.statusCode === 400);
});

test("hora operacional não desloca meia-noite para a véspera no Brasil", () => {
  assert.equal(horaOperacional("2026-09-01T00:00:00+00:00"), "2026-09-01T00:00:00.000");
  assert.equal(horaOperacional("2026-09-01T00:00:00"), "2026-09-01T00:00:00");
});

const tenant = { organizacaoId: "org-a", unidadeId: "un-a" };
const fonte = (id, extra = {}) => ({ id, organizacao_id: "org-a", unidade_id: "un-a", status: "concluida", criado_em: "2026-09-07T12:00:00Z", periodo_inicio: "2026-09-01", periodo_fim: "2026-09-05", ...extra });
const linha = (id, extra = {}) => ({ id, numero_pedido: id, importacao_id: "imp-a", organizacao_id: "org-a", unidade_id: "un-a", data_hora: "2026-09-01T12:00:00Z", situacao: "Entregue", entregador: "João", operacao: "subway", status_conciliacao: "incluido", taxa_entregador: 10, origem: "Food", ...extra });

// Executa o service real, substituindo somente I/O. O fake aplica filtros,
// inner join, ordenação e limite PostgREST; não calcula nenhum KPI.
async function ambiente({ pedidos = [], importacoes = [fonte("imp-a")], relatorio, falharLote = false } = {}) {
  const tabelas = { unidades: [{ id: "un-a", organizacao_id: "org-a" }, { id: "un-b", organizacao_id: "org-b" }],
    parser_fd_pedidos: pedidos, parser_fd_importacoes: importacoes, parser_fd_auditoria: [],
    parser_fd_lancamentos: [], parser_fd_pedido_overrides: [], parser_fd_entregadores: [] };
  const chamadas = [];
  let ids = 0;
  const db = { storage: { from: () => ({ upload: async () => ({ error: null }) }) }, from(tabela) {
    const filtros = [], ordens = []; let offset = 0, tamanho = 1000, colunas = "", op = "select", valor;
    const campo = (r, k) => k.split(".").reduce((v, p) => v?.[p], r);
    const q = {
      select(c) { colunas = c; return q; },
      eq(k, v) { filtros.push([k, "eq", v]); return q; },
      neq(k, v) { filtros.push([k, "neq", v]); return q; },
      gte(k, v) { filtros.push([k, "gte", v]); return q; },
      lte(k, v) { filtros.push([k, "lte", v]); return q; },
      lt(k, v) { filtros.push([k, "lt", v]); return q; },
      in(k, arr) { filtros.push([k, "in", arr]); return q; },
      not(k, _op, v) { filtros.push([k, "not_is", v]); return q; },
      order(k, o) { ordens.push([k, o?.ascending !== false]); return q; },
      range(a, b) { offset = a; tamanho = Math.min(1000, b - a + 1); return q; },
      limit(n) { tamanho = Math.min(1000, n); return q; },
      insert(v) { op = "insert"; valor = v; return q; },
      update(v) { op = "update"; valor = v; return q; },
      then(resolve, reject) {
        chamadas.push({ tabela, filtros, offset, tamanho, op, valor });
        if (op === "insert" && tabela === "parser_fd_pedidos" && falharLote) return Promise.resolve({ error: { message: "falha de lote" } }).then(resolve, reject);
        let rows = tabelas[tabela];
        if (colunas?.includes("!inner")) rows = rows.map((r) => ({ ...r, fonte: tabelas.parser_fd_importacoes.find((i) => i.id === r.importacao_id) })).filter((r) => r.fonte);
        rows = rows.filter((r) => filtros.every(([k, op, v]) => {
          let a = campo(r, k), b = v;
          if (op === "in") return Array.isArray(v) && v.includes(a);
          if (op === "not_is") return v === null ? a != null : a !== v;
          if (op === "neq") return a !== b;
          if (k === "data_hora" && op !== "eq") { a = a ? Date.parse(a) : NaN; b = Date.parse(b); }
          return op === "eq" ? a === b : op === "gte" ? a >= b : op === "lte" ? a <= b : op === "lt" ? a < b : a < b;
        }));
        if (op === "insert") {
          rows = (Array.isArray(valor) ? valor : [valor]).map((r) => ({ id: `persistido-${++ids}`, criado_em: "2026-09-07T12:00:00Z", ...r }));
          tabelas[tabela].push(...rows);
        } else if (op === "update") rows.forEach((r) => Object.assign(r, valor));
        for (const [k, asc] of [...ordens].reverse()) rows = [...rows].sort((a, b) => String(a[k]).localeCompare(String(b[k])) * (asc ? 1 : -1));
        return Promise.resolve({ data: rows.slice(offset, offset + tamanho), error: null }).then(resolve, reject);
      },
      async maybeSingle() { const r = await q; return { ...r, data: r.data?.[0] || null }; },
      async single() { return q.maybeSingle(); },
    }; return q;
  } };
  const url = new URL("../src/modules/parser-food-delivery/parserFoodDelivery.service.js", import.meta.url);
  const mod = new SourceTextModule(readFileSync(url, "utf8"), { identifier: url.href });
  // Linker recursivo: os módulos locais do Parser Food Delivery que tocam o
  // banco (service, shared, overrides, lancamentos, entregadores) são
  // carregados como SourceTextModule para que o STUB de `config/supabase.js`
  // se propague por toda a árvore — sem isso, um `import()` real de um
  // submódulo carregaria `config/env.js` (que faz process.exit sem .env).
  const cache = new Map();
  const linker = async (spec, referencing) => {
    if (spec.endsWith("/config/supabase.js")) {
      return new SyntheticModule(["supabase"], function () { this.setExport("supabase", db); });
    }
    const alvo = new URL(spec, referencing.identifier);
    const local = alvo.pathname.includes("/parser-food-delivery/") && alvo.pathname.endsWith(".js") && !alvo.pathname.endsWith(".parser.js");
    if (local) {
      if (!cache.has(alvo.href)) {
        cache.set(alvo.href, new SourceTextModule(readFileSync(alvo, "utf8"), { identifier: alvo.href }));
      }
      return cache.get(alvo.href);
    }
    let ns = await import(alvo);
    if (relatorio && spec.endsWith(".parser.js")) ns = { ...ns, lerRelatorio: async () => relatorio, decodificarArquivo: () => Buffer.from("teste") };
    return new SyntheticModule(Object.keys(ns), function () { for (const [k, v] of Object.entries(ns)) this.setExport(k, v); });
  };
  await mod.link(linker);
  await mod.evaluate();
  return { service: mod.namespace, chamadas, tabelas };
}

test("consulta usa data do pedido, inclui extremos e exclui véspera/dia seguinte/null", async () => {
  const a = await ambiente({ pedidos: [
    linha("antes", { data_hora: "2026-08-31T23:59:59.999Z" }),
    linha("inicio", { data_hora: "2026-09-01T00:00:00Z" }),
    linha("fim", { data_hora: "2026-09-01T23:59:59.999Z" }),
    linha("depois", { data_hora: "2026-09-02T00:00:00Z" }), linha("sem-data", { data_hora: null }),
  ] });
  const d = await a.service.analisarPeriodo({ ...tenant, dataInicio: "2026-09-01", dataFim: "2026-09-01" });
  assert.deepEqual(d.pedidos.map((p) => p.id), ["inicio", "fim"]);
  assert.equal(d.resumo.totalPedidos, 2);
  assert.equal(d.pedidos[0].dataHora.slice(0, 10), "2026-09-01");
});

test("consolida vários arquivos, deduplica sobreposição e mantém UUID/origem dos detalhes", async () => {
  const a = await ambiente({ importacoes: [fonte("imp-a"), fonte("imp-b", { criado_em: "2026-09-08T12:00:00Z" })], pedidos: [
    linha("velho", { numero_pedido: "123" }),
    linha("novo", { numero_pedido: "123", importacao_id: "imp-b", situacao: "Cancelado", status_conciliacao: "excluido", classificacao_cancelamento: "nao_recebe_taxa" }),
    linha("dia-2", { importacao_id: "imp-b", data_hora: "2026-09-02T12:00:00Z" }),
  ] });
  const d = await a.service.analisarPeriodo({ ...tenant, dataInicio: "2026-09-01", dataFim: "2026-09-05" });
  assert.equal(d.resumo.totalPedidos, 2); assert.equal(d.resumo.cancelados, 1);
  assert.equal(d.resumo.taxasValidas, 10); assert.equal(d.duplicadosSobrepostos, 1);
  assert.equal(d.pedidos.find((p) => p.id === "novo").importacaoId, "imp-b");
  assert.equal(d.entregadores[0].totalPedidos, 2);
  const historico = await a.service.obterImportacao({ ...tenant, importacaoId: "imp-a" });
  assert.equal(historico.pedidos[0].id, "velho");
  assert.equal(a.tabelas.parser_fd_pedidos.length, 3);
});

test("número repetido preserva dias/origens distintos e multiplicidade dentro do arquivo", () => {
  const linhas = [linha("1"), linha("2"), linha("3", { data_hora: "2026-09-02T12:00:00Z" }), linha("4", { origem: "Outra" })]
    .map((r) => ({ ...r, numero_pedido: "123", fonte: fonte("imp-a") }));
  assert.equal(consolidarPedidosPeriodo(linhas).length, 4);
});

test("sem identidade completa não funde linhas e mantém desempate determinístico", () => {
  const linhas = [linha("2", { data_hora: null }), linha("1", { data_hora: null })]
    .map((r) => ({ ...r, numero_pedido: "123", fonte: fonte("imp-a") }));
  assert.deepEqual(consolidarPedidosPeriodo(linhas).map((p) => p.id), ["1", "2"]);
});

test("resumo e flag de cancelamento usam a mesma regra; chave de entregador é compartilhada", async () => {
  const a = await ambiente({ pedidos: [linha("c", { situacao: "Cancelado", entregador: " João  Silva " }), linha("e", { entregador: "joao silva" })] });
  const d = await a.service.analisarPeriodo({ ...tenant, dataInicio: "2026-09-01", dataFim: "2026-09-01" });
  assert.equal(d.pedidos.filter((p) => p.cancelado).length, d.resumo.cancelados);
  assert.equal(d.entregadores.length, 1);
  assert.ok(d.pedidos.every((p) => p.entregadorChave === d.entregadores[0].chave));
});

test("override e legado mantêm contadores e filtros de classificação consistentes", async () => {
  const a = await ambiente({ pedidos: [
    linha("override", { situacao: "Cancelado", status_conciliacao: "excluido", classificacao_cancelamento: "revisar", classificacao_override_em: "2026-09-07T12:00:00Z" }),
    linha("legado", { situacao: "Cancelado", status_conciliacao: "cancelado_com_taxa" }),
  ] });
  const d = await a.service.analisarPeriodo({ ...tenant, dataInicio: "2026-09-01", dataFim: "2026-09-01" });
  assert.equal(d.resumo.canceladosNaoRecebemTaxa, 1);
  assert.equal(d.resumo.canceladosRecebemTaxa, 1);
  assert.equal(d.resumo.canceladosRevisao, 0);
  assert.equal(d.entregadores[0].canceladosRevisao, 0);
  assert.equal(d.pedidos.find((p) => p.id === "override").classificacaoCancelamento, "revisar");
  assert.equal(d.pedidos.filter((p) => p.classificacaoEfetiva === "nao_recebe_taxa").length, d.resumo.canceladosNaoRecebemTaxa);
});

test("universo completo de 1387 pedidos, incluindo cancelamento na última página", async () => {
  const pedidos = Array.from({ length: 1387 }, (_, i) => linha(String(i).padStart(4, "0"), i === 1386 ? { situacao: "Cancelado", status_conciliacao: "excluido" } : {}));
  const a = await ambiente({ pedidos });
  const d = await a.service.analisarPeriodo({ ...tenant, dataInicio: "2026-09-01", dataFim: "2026-09-01" });
  assert.equal(d.pedidos.length, 1387); assert.equal(d.resumo.totalPedidos, 1387);
  assert.equal(d.resumo.cancelados, 1); assert.equal(d.resumo.taxasValidas, 13860);
  assert.deepEqual(a.chamadas.filter((c) => c.tabela === "parser_fd_pedidos").map((c) => c.offset), [0, 500, 1000]);
});

test("isolamento por organização/unidade também no join e exclusão de importações incompletas", async () => {
  const a = await ambiente({ importacoes: [fonte("imp-a"), fonte("outra", { organizacao_id: "org-b", unidade_id: "un-b" }), fonte("erro", { status: "erro" })], pedidos: [
    linha("ok"), linha("empresa", { organizacao_id: "org-b" }), linha("unidade", { unidade_id: "un-b" }),
    linha("join-invalido", { importacao_id: "outra" }), linha("parcial", { importacao_id: "erro" }),
  ] });
  const d = await a.service.analisarPeriodo({ ...tenant, dataInicio: "2026-09-01", dataFim: "2026-09-05" });
  assert.deepEqual(d.pedidos.map((p) => p.id), ["ok"]);
  await assert.rejects(() => a.service.analisarPeriodo({ ...tenant, unidadeId: "un-b", dataInicio: "2026-09-01", dataFim: "2026-09-05" }), (e) => e.statusCode === 403);
});

test("período antigo sem dados é resposta vazia válida", async () => {
  const a = await ambiente();
  const d = await a.service.analisarPeriodo({ ...tenant, dataInicio: "2001-01-01", dataFim: "2001-01-01" });
  assert.equal(d.resumo.totalPedidos, 0); assert.equal(d.resumo.taxasValidas, 0);
  assert.deepEqual(d.pedidos, []); assert.deepEqual(d.entregadores, []);
});

test("distribuição de operações/ignorados usa exatamente o período", async () => {
  const a = await ambiente({ pedidos: [linha("ok"), linha("acai", { operacao: "acai_no_grau" }), linha("sem", { entregador: "" })] });
  const d = await a.service.analisarPeriodo({ ...tenant, dataInicio: "2026-09-01", dataFim: "2026-09-01" });
  assert.equal(d.importacao.totalPedidos, 3); assert.equal(d.resumo.totalPedidos, 1);
  assert.equal(d.importacao.pedidosAcai, 1); assert.equal(d.importacao.pedidosSemEntregador, 1);
  assert.equal(d.pedidosIgnorados.length, 2);
});

const relatorio = { hash: "novo-hash", periodoInicio: "2026-09-01", periodoFim: "2026-09-05", colunaDetalhesEncontrada: false,
  pedidos: [{ numeroPedido: "123", dataHora: "2026-09-01T00:00:00", situacao: "Cancelado", entregador: "João", taxaEntregador: 10, dadosBrutos: {} }] };

test("confirmação responde com UUID persistido e contexto utilizável sem Histórico", async () => {
  const a = await ambiente({ relatorio, importacoes: [] });
  const d = await a.service.confirmarImportacao({ ...tenant, usuario: {}, arquivo: { nomeArquivo: "novo.xls" } });
  assert.ok(d.pedidos[0].id); assert.equal(d.pedidos[0].importacaoId, d.importacao.id);
  assert.equal(d.importacao.periodoInicio, "2026-09-01"); assert.equal(d.importacao.periodoFim, "2026-09-05");
  assert.equal(d.resumo.cancelados, 1);
  const grava = a.chamadas.find((c) => c.tabela === "parser_fd_importacoes" && c.op === "insert");
  assert.equal(grava.valor.status, "erro");
  assert.equal(a.tabelas.parser_fd_importacoes[0].status, "concluida");
  assert.equal(a.tabelas.parser_fd_pedidos[0].data_hora, "2026-09-01T00:00:00Z");
});

test("falha de persistência não publica uma importação parcial na análise", async () => {
  const a = await ambiente({ relatorio, importacoes: [], falharLote: true });
  await assert.rejects(() => a.service.confirmarImportacao({ ...tenant, usuario: {}, arquivo: {} }), /Falha ao gravar/);
  assert.equal(a.tabelas.parser_fd_importacoes[0].status, "erro");
});
