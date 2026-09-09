// Browser real + API controlada. Não acessa banco/produção.
// PFD_PLAYWRIGHT_PATH pode apontar para o Playwright do runtime local;
// sem ele (ou pacote playwright instalado), a suíte informa skip.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

let chromium;
try { ({ chromium } = createRequire(import.meta.url)(process.env.PFD_PLAYWRIGHT_PATH || "playwright")); } catch {}
const skip = !chromium && "Playwright não disponível; configure PFD_PLAYWRIGHT_PATH para executar testes de navegador.";
let browser, server, origem;
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pedido = (id, cancelado) => ({ id, importacaoId: "imp", numeroPedido: id, dataHora: "2026-09-01T12:00:00", entregador: "João", situacao: cancelado ? "Cancelado" : "Entregue", statusConciliacao: cancelado ? "cancelado_com_taxa" : "incluido", classificacaoCancelamento: cancelado ? "recebe_taxa" : null, taxaEntregador: 10 });
function resultado(ini, fim, pedidos, lancamentos = []) {
  const cancelados = pedidos.filter((p) => p.situacao === "Cancelado").length;
  const iaf = pedidos.length * 10;
  const ajustes = lancamentos.reduce((s, l) => s + (l.excluido ? 0 : l.valor), 0);
  return { consolidado: true, periodo: { dataInicio: ini, dataFim: fim },
    importacao: { periodoInicio: ini, periodoFim: fim, totalPedidos: pedidos.length, pedidosSubway: pedidos.length }, fontes: [],
    pedidos: pedidos.map((p) => ({ ...p, custosAdicionais: [], custoTotalPedido: p.taxaEntregador })),
    pedidosIgnorados: [], lancamentos,
    entregadores: pedidos.length ? [{ entregador: "João", chave: "joao", totalPedidos: pedidos.length, entregues: pedidos.length - cancelados, canceladosComTaxa: cancelados, canceladosSemTaxa: 0, taxasValidas: iaf, custoTotal: iaf }] : [],
    resumo: { totalPedidos: pedidos.length, entregues: pedidos.length - cancelados, cancelados, canceladosRecebemTaxa: cancelados, canceladosNaoRecebemTaxa: 0, canceladosRevisao: 0, taxasValidas: iaf, taxasBrutas: iaf, taxasDescartadas: 0,
      custoReal: { ifood: iaf, taxasAdicionais: 0, manuais: 0, avulsos: ajustes, ajustesManuais: ajustes, total: iaf + ajustes, qtdPedidosComTaxaAdicional: 0 } } };
}
const lancAvulso = { id: "l1", origem: "avulso", origemRotulo: "Avulso", entregadorNome: "Pedro", data: "2026-09-03", valor: 20, motivoRotulo: "Buscar pães", numeroPedido: null, excluido: false, pedidoDisponivel: null };
const fixtures = {
  "2026-09-01:2026-09-05": resultado("2026-09-01", "2026-09-05", [pedido("cancelado-1", true), pedido("entregue", false), pedido("cancelado-2", true)], [lancAvulso]),
  "2026-09-01:2026-09-01": resultado("2026-09-01", "2026-09-01", [pedido("cancelado-1", true), pedido("entregue", false)]),
  "2026-09-02:2026-09-02": resultado("2026-09-02", "2026-09-02", [pedido("cancelado-2", true)]),
};
const api = `
  const run = (nome, args) => { window.chamadas.push({ nome, args }); return (window.api[nome] || (async () => { throw new Error("sem mock: " + nome); }))(...args); };
  ${[
    "pfdPeriodo", "pfdImportacoes", "pfdImportacaoDetalhe", "pfdArquivoImportacao", "pfdAlterarClassificacao", "pfdExcluirImportacao",
    "pfdCatalogos", "pfdEntregadores", "pfdEntregadorCriar", "pfdEntregadorEditar", "pfdEntregadoresSugestoes", "pfdEntregadoresReconhecer",
    "pfdLancamentos", "pfdLancamentoCriar", "pfdLancamentoEditar", "pfdLancamentoExcluir", "pfdLancamentoRestaurar", "pfdLancamentoHardDelete",
  ].map((nome) => `export const ${nome} = (...args) => run("${nome}", args);`).join("\n")}`;
const mocks = {
  "/src/api.js": api,
  "/src/state.js": `export const state = { sessao: { unidade: { id: 'un-a', nome: 'Unidade de teste' } }, detalheAberto: {} };`,
  "/src/sessao.js": `export const pode = () => true;`,
  "/src/agentePainel.js": `export const botaoContextualHtml = () => ''; export const ligarBotoesContextuais = () => {}; export const sincronizarContextoPainel = () => {};`,
  "/src/parserFoodDeliveryImportModal.js": `export const abrirImportarFoodDeliveryModal = ({ onSalvo }) => { window.confirmarImportacao = onSalvo; };`,
  "/src/parserFoodDeliveryLancamentoModal.js": `export const abrirLancamentoModal = (o) => { window.ultimoLancamentoModal = o; }; export const abrirEntregadoresModal = (o) => { window.ultimoEntregadoresModal = o; };`,
};
before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, ...(process.env.PFD_BROWSER_CHANNEL ? { channel: process.env.PFD_BROWSER_CHANNEL } : {}) });
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(`<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/styles.css"><div id="view" style="padding:20px"></div>`); return; }
    const file = resolve(root, "." + path);
    if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    try { res.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : "text/javascript"); res.end(mocks[path] ?? readFileSync(file)); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origem = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await browser?.close(); if (server) await new Promise((r) => server.close(r)); });

async function tela(t, width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: "America/Fortaleza" });
  page.setDefaultTimeout(8000);
  t.after(() => page.close());
  await page.goto(origem);
  await page.evaluate(async ({ fixtures, vazio }) => {
    window.chamadas = []; window.fixtures = fixtures;
    window.api = {
      pfdImportacoes: async () => ({ data: [{ id: "imp", status: "concluida", periodoInicio: "2026-09-01", periodoFim: "2026-09-05" }] }),
      pfdPeriodo: async (ini, fim) => ({ data: fixtures[`${ini}:${fim}`] || { ...vazio, periodo: { dataInicio: ini, dataFim: fim }, importacao: { ...vazio.importacao, periodoInicio: ini, periodoFim: fim } } }),
      pfdImportacaoDetalhe: async () => ({ data: { ...fixtures["2026-09-01:2026-09-05"], consolidado: false, importacao: { ...fixtures["2026-09-01:2026-09-05"].importacao, id: "imp" } } }),
    };
    const parser = await import("/src/parserFoodDelivery.js");
    window.parser = parser;
    await parser.renderParserFoodDelivery();
  }, { fixtures, vazio: resultado("2001-01-01", "2001-01-01", []) });
  return page;
}
async function selecionar(page, ini, fim) {
  await page.locator("#pfd-cal summary").click();
  await page.locator("[data-mes]").fill(ini.slice(0, 7));
  await page.locator(`[data-dia="${ini}"]`).click();
  await page.locator(`[data-dia="${fim}"]`).click();
  await page.waitForFunction(([ini, fim]) => document.querySelector("#pfd-cal summary")?.textContent.includes(ini.split("-").reverse().join("/")) && !document.querySelector(".vd-skel"), [ini, fim]);
}

test("dia único consulta backend e mantém contexto entre abas e drill-down", { skip }, async (t) => {
  const page = await tela(t);
  await selecionar(page, "2026-09-01", "2026-09-01");
  assert.equal(await page.locator('[data-card="cancelamentos"] .vd-card-val').textContent(), "1");
  await page.locator('[data-card="cancelamentos"]').click();
  assert.equal(await page.locator("#pfd-tabela-cancelamentos tbody tr").count(), 1);
  await page.locator('[data-aba="pedidos"]').click();
  assert.equal(await page.locator("#pfd-tabela-pedidos tbody tr").count(), 2);
  await page.locator('[data-aba="entregadores"]').click();
  assert.match(await page.locator("#pfd-cal summary").textContent(), /01\/09\/2026 a 01\/09\/2026/);
  await page.locator("[data-pedidos-entregador]").click();
  assert.equal(await page.locator("#pfd-tabela-pedidos tbody tr").count(), 2);
  await page.locator('[data-aba="visao"]').click();
  assert.equal(await page.locator('[data-card="cancelamentos"] .vd-card-val').textContent(), "1");
  const chamadas = await page.evaluate(() => window.chamadas.filter((c) => c.nome === "pfdPeriodo"));
  assert.equal(chamadas.length, 2);
  assert.deepEqual(chamadas[1].args, ["2026-09-01", "2026-09-01"]);
});

test("range visual, card de entregues e consulta histórica vazia", { skip }, async (t) => {
  const page = await tela(t);
  await selecionar(page, "2026-09-01", "2026-09-05");
  await page.locator("#pfd-cal summary").click();
  assert.equal(await page.locator(".pfd-cal-dia.inicio").count(), 1);
  assert.equal(await page.locator(".pfd-cal-dia.fim").count(), 1);
  assert.equal(await page.locator(".pfd-cal-dia.intervalo").count(), 3);
  if (process.env.PFD_SCREENSHOT_DIR) await page.screenshot({ path: resolve(process.env.PFD_SCREENSHOT_DIR, "parser-calendario-desktop.png"), fullPage: true });
  await page.locator("#pfd-cal summary").click();
  await page.locator('[data-card="pedidos"][data-filtro="entregues"]').click();
  assert.equal(await page.locator("#pfd-tabela-pedidos tbody tr").count(), 1);
  await selecionar(page, "2001-01-01", "2001-01-01");
  assert.match(await page.locator("#pfd-conteudo").textContent(), /Não existem dados importados/);
});

test("pós-importação muda período e abre detalhes por UUID sem Histórico", { skip }, async (t) => {
  const page = await tela(t);
  await selecionar(page, "2001-01-01", "2001-01-01");
  await page.locator("#pfd-importar").click();
  await page.evaluate(() => window.confirmarImportacao({ importacao: { id: "nova", periodoInicio: "2026-09-01", periodoFim: "2026-09-05" } }));
  await page.locator('[data-card="cancelamentos"]').click();
  assert.equal(await page.locator("#pfd-tabela-cancelamentos tbody tr").count(), 2);
  await page.locator("[data-ver-canc]").first().click();
  assert.match(await page.locator(".bm-drawer").textContent(), /cancelado-1/);
  assert.equal(await page.evaluate(() => window.chamadas.filter((c) => c.nome === "pfdImportacaoDetalhe").length), 0);
});

test("resposta antiga não sobrescreve período novo", { skip }, async (t) => {
  const page = await tela(t);
  await page.evaluate(() => {
    const anterior = window.api.pfdPeriodo;
    window.api.pfdPeriodo = (ini, fim) => ini === "2026-09-01" && fim === ini
      ? new Promise((r) => { window.liberarAntiga = () => r({ data: window.fixtures[`${ini}:${fim}`] }); }) : anterior(ini, fim);
  });
  await page.locator("#pfd-cal summary").click();
  await page.locator('[data-dia="2026-09-01"]').click();
  await page.locator('[data-dia="2026-09-01"]').click();
  await selecionar(page, "2026-09-02", "2026-09-02");
  await page.evaluate(() => window.liberarAntiga());
  assert.match(await page.locator("#pfd-cal summary").textContent(), /02\/09\/2026 a 02\/09\/2026/);
  await page.locator('[data-card="cancelamentos"]').click();
  assert.match(await page.locator("#pfd-tabela-cancelamentos").textContent(), /cancelado-2/);
});

test("aba Lançamentos lista avulsos do período e a Visão Geral compõe o custo real", { skip }, async (t) => {
  const page = await tela(t);
  await selecionar(page, "2026-09-01", "2026-09-05");
  // Visão Geral: card de custo total = iFood (30) + avulso (20)
  assert.match(await page.locator('[data-card="entregadores"] .vd-card-val').textContent(), /50,00/);
  await page.locator('[data-aba="lancamentos"]').click();
  assert.equal(await page.locator("#pfd-tabela-lancamentos tbody tr").count(), 1);
  assert.match(await page.locator("#pfd-tabela-lancamentos").textContent(), /Avulso/);
  assert.match(await page.locator("#pfd-tabela-lancamentos").textContent(), /Buscar pães/);
  // Pedidos: coluna Origem com badge iFood + ação por linha
  await page.locator('[data-aba="pedidos"]').click();
  assert.match(await page.locator("#pfd-tabela-pedidos thead").textContent(), /Origem/);
  assert.equal(await page.locator("[data-acao-pedido]").count(), 3);
});

test("troca de empresa/unidade invalida callback de importação", { skip }, async (t) => {
  const page = await tela(t);
  await page.locator("#pfd-importar").click();
  const n = await page.evaluate(() => window.chamadas.length);
  await page.evaluate(async () => {
    const ctx = await import("/src/contextoEscopo.js"); ctx.resetarEscopoDeContexto();
    await window.confirmarImportacao({ importacao: { periodoInicio: "2026-09-01", periodoFim: "2026-09-05" } });
  });
  assert.equal(await page.evaluate(() => window.chamadas.length), n);
});

test("erro de consulta não mostra dados antigos e permite tentar novamente", { skip }, async (t) => {
  const page = await tela(t);
  await page.evaluate(() => { window.apiAnterior = window.api.pfdPeriodo; window.api.pfdPeriodo = async () => { throw new Error("Consulta indisponível"); }; });
  await selecionar(page, "2026-09-02", "2026-09-02");
  assert.match(await page.locator("#pfd-conteudo").textContent(), /Consulta indisponível/);
  assert.equal(await page.locator("[data-card]").count(), 0);
  await page.evaluate(() => { window.api.pfdPeriodo = window.apiAnterior; });
  await page.locator("#pfd-tentar").click();
  await page.waitForSelector('[data-card="cancelamentos"]');
  assert.equal(await page.locator('[data-card="cancelamentos"] .vd-card-val').textContent(), "1");
});

test("alteração manual utiliza importação de origem e recarrega o mesmo período", { skip }, async (t) => {
  const page = await tela(t);
  await page.evaluate(() => {
    window.api.pfdAlterarClassificacao = async () => ({ data: window.fixtures["2026-09-01:2026-09-05"] });
  });
  await page.locator('[data-card="cancelamentos"]').click();
  await page.locator("[data-ver-canc]").first().click();
  await page.locator("#pfd-abrir-override").click();
  await page.locator('[data-destino="nao_recebe_taxa"]').click();
  await page.locator("#pfd-override-motivo").fill("Conferência do pedido");
  await page.locator("#pfd-confirmar-override").click();
  await page.waitForFunction(() => window.chamadas.filter((c) => c.nome === "pfdPeriodo").length === 2);
  const chamada = await page.evaluate(() => window.chamadas.find((c) => c.nome === "pfdAlterarClassificacao"));
  assert.deepEqual(chamada.args.slice(0, 2), ["imp", "cancelado-1"]);
  assert.match(await page.locator("#pfd-cal summary").textContent(), /01\/09\/2026 a 05\/09\/2026/);
});

test("Histórico abre importação e permite voltar à análise de período", { skip }, async (t) => {
  const page = await tela(t);
  await page.locator('[data-aba="historico"]').click();
  await page.locator(".pfd-hist-linha").click();
  await page.waitForSelector(".pfd-periodo-setas");
  await selecionar(page, "2026-09-02", "2026-09-02");
  assert.equal(await page.locator(".pfd-periodo-setas").count(), 0);
  assert.equal(await page.locator('[data-card="cancelamentos"] .vd-card-val').textContent(), "1");
});

test("calendário mobile sem transbordamento e navegação por teclado", { skip }, async (t) => {
  const page = await tela(t, 390);
  await page.locator("#pfd-cal summary").click();
  const painel = await page.locator("#pfd-cal-painel").boundingBox();
  assert.ok(painel.x >= 0 && painel.x + painel.width <= 390);
  await page.locator('[data-dia="2026-09-01"]').focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.dia), "2026-09-02");
  if (process.env.PFD_SCREENSHOT_DIR) {
    await page.screenshot({ path: resolve(process.env.PFD_SCREENSHOT_DIR, "parser-calendario-mobile.png"), fullPage: true });
  }
  await page.setViewportSize({ width: 800, height: 900 });
  const tablet = await page.locator("#pfd-cal-painel").boundingBox();
  assert.ok(tablet.x >= 0 && tablet.x + tablet.width <= 800);
});
