// Dashboard Financeiro em NAVEGADOR REAL (Chromium/Chrome via Playwright), desktop, celular e tema escuro.
//
// O servidor local serve o frontend e monta o router financeiro REAL com repositório em MEMÓRIA e dados 100% sintéticos
// (planilha gerada na hora). Nunca fala com Supabase, produção nem rede externa.
//
// Rodar:
//   FIN_PLAYWRIGHT_PATH=<...>/worker-martinbrower/node_modules/playwright FIN_BROWSER_CHANNEL=chrome \
//   node --test frontend/test/financeiro.browser.test.js
// FIN_SCREENSHOTS=<pasta> grava capturas das telas.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BACKEND = resolve(RAIZ, "..", "backend");
const reqBackend = createRequire(pathToFileURL(join(BACKEND, "package.json")));

let chromium;
try { ({ chromium } = createRequire(import.meta.url)(process.env.FIN_PLAYWRIGHT_PATH || "playwright")); } catch { /* sem Playwright: pulado */ }
const PULAR = !chromium && "Configure FIN_PLAYWRIGHT_PATH (Playwright) para rodar no navegador";
const CANAL = process.env.FIN_BROWSER_CHANNEL;
const CAPTURAS = process.env.FIN_SCREENSHOTS;

const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/src/styles.css">
<script>window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}})}})};</script>
</head><body><div id="app" class="app"><div class="main"><header class="topbar"><h1 id="page-title">Financeiro</h1></header><main id="view" class="content"></main></div></div></body></html>`;
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TODAS = ["ver", "lancar", "editar", "conciliar", "fechar", "configurar", "cancelar"].map((a) => `gestao_financeira.${a}`);
const serial = (iso) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000) + 25569;

let servidor, base, navegador, repo, planilhaB64, planilhaXlsxBuf;

function montarPlanilha(XLSX) {
  const dias = [];
  for (let d = 1; d <= 20; d++) {
    const iso = `2026-09-${String(d).padStart(2, "0")}`;
    dias.push([serial(iso), "VENDAS DO DIA", 2500 + d * 37.5, 0, "RECEITA", "RECEBIMENTO DE CLIENTE", "RECEBIMENTO DE CLIENTE", d % 2 ? "BANCO" : "ADQUIRENTE"]);
    if (d % 3 === 0) dias.push([serial(iso), "COMPRA INSUMOS", 0, 700 + d * 11.11, "CUSTO", "VARIAVEL", "INSUMOS", "BANCO"]);
  }
  const linhas = [
    ...dias,
    [serial("2026-09-05"), "ALUGUEL", 0, 1800, "DESPESA", "FIXA", "ALUGUEL", "BANCO"],
    [serial("2026-09-10"), "SALARIOS", 0, 3200, "DESPESA", "PESSOAL", "SALARIO", "BANCO"],
    [serial("2026-09-12"), "TARIFA", 0, 1.63, "DESPESA", "FINANCEIRAS", "TARIFAS", "BANCO"],
    [serial("2026-09-12"), "TARIFA", 0, 1.63, "DESPESA", "FINANCEIRAS", "TARIFAS", "BANCO"],
    [serial("2026-09-13"), "PIX ENVIADO", 0, 120, "DESPESA", "VARIAVEL", "PIX A IDENTIFICAR", "BANCO"],
    [serial("2026-09-14"), "TRANSFERENCIA ADQUIRENTE → BANCO", 900, 0, "TRANSFERENCIA", "TRANSFERENCIA ENTRE CONTAS", "ENTRE CONTAS", "BANCO"],
    [serial("2026-09-14"), "TRANSFERENCIA ADQUIRENTE → BANCO", 0, 900, "TRANSFERENCIA", "TRANSFERENCIA ENTRE CONTAS", "ENTRE CONTAS", "ADQUIRENTE"],
    [serial("2026-09-15"), "PAGAMENTO A TERCEIRO", 0, 90, "TRANSFERENCIA", "TRANSFERENCIA ENTRE CONTAS", "ENTRE CONTAS", "ADQUIRENTE"],
    [serial("2026-09-01"), "SALDO MÊS ANTERIOR - BANCO", 150, 0, "SALDO ANTERIOR", "SALDO ANTERIOR", "SALDO ANTERIOR", "BANCO"],
  ];
  const ws = XLSX.utils.aoa_to_sheet([["DATA", "LANÇAMENTOS", "ENTRADA", "SAIDA", "TIPO", "NATUREZA", "CATEGORIA", "CONTA"], ...linhas]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "FLUXO DE CAIXA");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

before(async () => {
  if (PULAR) return;
  process.env.SUPABASE_URL = "http://127.0.0.1:1"; process.env.SUPABASE_SERVICE_ROLE_KEY = "teste-local"; process.env.SUPABASE_ANON_KEY = "teste-local";
  const express = reqBackend("express");
  const XLSX = reqBackend("xlsx");
  const { criarDominioRouter } = await import(pathToFileURL(join(BACKEND, "src/modules/gestao-financeira/dominio/rotas.js")).href);
  const { criarRepoMemoria } = await import(pathToFileURL(join(BACKEND, "test/financeiro/helpers/repoMemoria.js")).href);
  repo = criarRepoMemoria();
  planilhaXlsxBuf = montarPlanilha(XLSX);
  planilhaB64 = planilhaXlsxBuf.toString("base64");

  const app = express();
  app.use(express.json({ limit: "8mb" }));
  const gate = (acao) => (req, _res, next) => {
    const perms = (req.headers["x-perms"] ?? TODAS.join(",")).split(",");
    req.financeiro = { organizacaoId: U(1), unidadeId: U(2), permissoes: perms }; req.user = { id: U(3) };
    perms.includes(acao) ? next() : next(Object.assign(new Error("Permissão financeira insuficiente."), { statusCode: 403 }));
  };
  app.get("/api/config", (_req, res) => res.json({ supabaseUrl: "http://127.0.0.1:1", supabaseAnonKey: "teste-local" }));
  app.use("/api/v1/gestao-financeira", criarDominioRouter({ autorizar: gate, deps: { repo, db: undefined } }));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message, details: err.details }));
  app.use((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/" || url.pathname === "/index.html") { res.type("html").send(PAGINA); return; }
    const arquivo = join(RAIZ, decodeURIComponent(url.pathname));
    if (arquivo.startsWith(RAIZ) && existsSync(arquivo)) { res.type(MIME[extname(arquivo)] ?? "application/octet-stream").send(readFileSync(arquivo)); return; }
    res.status(404).end();
  });
  servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  navegador = await chromium.launch({ ...(CANAL ? { channel: CANAL } : {}) });
  if (CAPTURAS) mkdirSync(CAPTURAS, { recursive: true });
});
after(async () => { await navegador?.close(); await new Promise((r) => servidor?.close(r)); });

const DESKTOP = { width: 1366, height: 800 };
const CELULAR = { width: 390, height: 844 };

async function abrir(pagina, { viewport = DESKTOP, escuro = false, permissoes = TODAS, mes = "2026-09" } = {}) {
  const contexto = await navegador.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600, colorScheme: escuro ? "dark" : "light",
    extraHTTPHeaders: { "x-perms": permissoes.join(",") } });
  const p = await contexto.newPage();
  const erros = [];
  p.on("pageerror", (e) => erros.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) erros.push(m.text()); });
  await p.goto(base + "/");
  if (escuro) await p.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await p.evaluate(async ({ nome, perms, mes }) => {
    try { sessionStorage.setItem("fin:mes", mes); } catch {}
    const m = await import(`/src/financeiro/${nome}.js`);
    await m.render(document.querySelector("#view"), { permissoes: perms, nivel: "gestor" });
  }, { nome: pagina, perms: permissoes, mes });
  if (process.env.FIN_DEBUG) { await p.waitForTimeout(2500); console.log("DEBUG view:", JSON.stringify((await p.locator("#view").innerText()).slice(0, 500)), "| erros:", JSON.stringify(erros)); }
  return { p, erros, fechar: () => contexto.close() };
}
const captura = async (p, nome) => { if (CAPTURAS) await p.screenshot({ path: resolve(CAPTURAS, `${nome}.png`), fullPage: true }); };
async function semEstouro(p, rotulo) {
  const r = await p.evaluate(() => ({ largura: document.documentElement.clientWidth, rolagem: document.documentElement.scrollWidth }));
  assert.ok(r.rolagem <= r.largura + 1, `${rotulo}: rolagem horizontal (${r.rolagem} > ${r.largura})`);
}

describe("Dashboard Financeiro no navegador (dados sintéticos)", { skip: PULAR }, () => {
  test("estado vazio honesto antes de qualquer dado: nenhum número fictício", async () => {
    const { p, erros, fechar } = await abrir("visao-geral");
    try {
      await p.locator(".fin-estado--vazio").waitFor();
      const t = await p.locator("#view").innerText();
      assert.match(t, /Sem lançamentos em setembro\/2026/);
      assert.doesNotMatch(t, /R\$\s*\d/);
      await captura(p, "00-vazio");
    } finally { await fechar(); }
    assert.deepEqual(erros, []);
  });

  test("importação pela interface: prévia sem gravar → pares → confirmação explícita → reconciliação", async () => {
    const { p, erros, fechar } = await abrir("importacao");
    try {
      await p.locator("[data-upload]").waitFor();
      await captura(p, "10-importacao-inicio");
      await p.setInputFiles('input[type="file"]', { name: "livro-sintetico.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: planilhaXlsxBuf });
      await p.locator('[data-upload] button[type="submit"]').click();
      await p.locator("[data-lote]").waitFor();
      const t = await p.locator("#view").innerText();
      assert.match(t, /Totais conferem|Arquivo sem total declarado/);
      assert.match(t, /Sem saldo de abertura informado:\s*ADQUIRENTE/);
      assert.equal(repo._t.lanc.length, 0, "prévia não grava");
      assert.equal(await p.locator('[data-confirmar] button[type="submit"]').isEnabled(), true);
      await captura(p, "11-importacao-previa");
      await semEstouro(p, "importação prévia");
      await p.locator("[data-lote]").click();
      await p.locator("text=1 confirmado(s)").waitFor();
      await p.locator('[data-confirmar] input[name="confirmo"]').check();
      await p.locator('[data-confirmar] button[type="submit"]').click();
      await p.locator("text=Reconciliada").waitFor();
      assert.ok(repo._t.lanc.length > 0);
      assert.equal(repo._t.transf.length, 1);
      assert.equal(repo._t.lanc.filter((l) => l.descricao === "TARIFA").length, 2);
      await captura(p, "12-importacao-concluida");
    } finally { await fechar(); }
    assert.deepEqual(erros, []);
  });

  for (const [nome, viewport, escuro] of [["desktop", DESKTOP, false], ["celular", CELULAR, false], ["escuro", DESKTOP, true]]) {
    test(`${nome}: visão geral mostra indicadores com fórmula, saldo parcial, gráfico com legenda e pendências`, async () => {
      const { p, erros, fechar } = await abrir("visao-geral", { viewport, escuro });
      try {
        await p.locator(".fin-kpis").waitFor();
        const t = await p.locator("#view").innerText();
        assert.match(t, /Resultado gerencial/);
        assert.match(t, /Regime de caixa/);
        assert.match(t, /Saldo final calculado/);
        assert.match(t, /Parcial/);                                // ADQUIRENTE sem abertura
        assert.match(t, /Abertura desconhecida/);
        assert.match(t, /NÃO conciliado/);
        assert.match(t, /Pendências de classificação/);
        assert.equal(await p.locator(".fin-svg").count() > 0, true);
        assert.equal(await p.locator(".fin-legenda li").count(), 2);
        assert.ok(await p.locator(".fin-bar").count() > 10);
        await p.locator(".fin-bar").first().hover();
        await p.waitForFunction(() => { const t = document.querySelector(".fin-tooltip"); return t && !t.hidden && /Entradas|Saídas/.test(t.textContent); });
        await p.locator(".fin-info summary").first().click();
        assert.match(await p.locator(".fin-info[open]").first().innerText(), /Fórmula/);
        await captura(p, `20-visao-geral-${nome}`);
        await semEstouro(p, `visão geral ${nome}`);
        if (escuro) {
          const cor = await p.evaluate(() => getComputedStyle(document.querySelector(".fin-pg")).getPropertyValue("--fin-entrada").trim());
          assert.equal(cor.toLowerCase(), "#4f8fd6");
        }
      } finally { await fechar(); }
      assert.deepEqual(erros, []);
    });
  }

  test("fluxo de caixa: lista, filtra por pendentes, lança com valor exato e reclassifica exigindo motivo", async () => {
    const { p, erros, fechar } = await abrir("fluxo-de-caixa");
    try {
      await p.locator(".fin-tabela").waitFor();
      assert.match(await p.locator("#view").innerText(), /Pendente/);
      await captura(p, "30-fluxo");
      // novo lançamento com vírgula brasileira e centavos exatos
      await p.locator("[data-novo]").click();
      const dlg = p.locator("dialog.fin-dialogo");
      await dlg.locator('select[name="contaId"]').selectOption({ label: "BANCO" });
      await dlg.locator('select[name="sentido"]').selectOption("saida");
      await dlg.locator('input[name="descricao"]').fill("Compra de teste");
      await dlg.locator('input[name="valor"]').fill("1.234,56");
      await dlg.locator('input[name="dataMovimento"]').fill("2026-09-21");
      await dlg.locator('button[type="submit"]').click();
      await dlg.waitFor({ state: "detached" });
      assert.equal(repo._t.lanc.find((l) => l.descricao === "Compra de teste").valor_centavos, 123456);
      // valor inválido é recusado no próprio diálogo, sem fechar
      await p.locator("[data-novo]").click();
      const d2 = p.locator("dialog.fin-dialogo");
      await d2.locator('select[name="contaId"]').selectOption({ label: "BANCO" });
      await d2.locator('select[name="sentido"]').selectOption("saida");
      await d2.locator('input[name="descricao"]').fill("x");
      await d2.locator('input[name="valor"]').fill("10,005");
      await d2.locator('input[name="dataMovimento"]').fill("2026-09-21");
      await d2.locator('button[type="submit"]').click();
      await d2.locator(".fin-form-erro:not([hidden])").waitFor();
      assert.match(await d2.locator(".fin-form-erro").innerText(), /valor inválido/i);
      await d2.locator("[data-cancelar]").click();
      // filtro de pendentes
      await p.locator('select[name="pendente"]').selectOption("true");
      await p.locator('[data-form-filtros] button[type="submit"]').click();
      await p.waitForFunction(() => /Mostrando 1–\d+ de [1-9]/.test(document.querySelector("#view").innerText));
      // reclassificar sem motivo: erro; com motivo: ok
      await p.locator("tr", { hasText: "PIX ENVIADO" }).locator("[data-editar]").click();
      const d3 = p.locator("dialog.fin-dialogo");
      const sel = d3.locator('select[name="categoriaId"]');
      const outras = await sel.locator("option").evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
      const atual = await sel.inputValue();
      await sel.selectOption(outras.find((v) => v !== atual));
      await d3.locator('button[type="submit"]').click();
      if (process.env.FIN_DEBUG) { await p.waitForTimeout(1500); console.log("DBG dlg:", JSON.stringify(await p.evaluate(() => [...document.querySelectorAll("dialog")].map((d) => d.innerText.slice(0, 300))))); }
      await d3.locator(".fin-form-erro:not([hidden])").waitFor();
      assert.ok(atual, "a linha escolhida já tem categoria");
      assert.match(await d3.locator(".fin-form-erro").innerText(), /motivo/i);
      await d3.locator("[data-cancelar]").click();
    } finally { await fechar(); }
    assert.deepEqual(erros, []);
  });

  test("DRE: regime explícito, detalhes sem dupla contagem, margem líquida em percentual", async () => {
    const { p, erros, fechar } = await abrir("dre");
    try {
      await p.locator(".fin-tabela").waitFor();
      const t = await p.locator("#view").innerText();
      assert.match(t, /Regime de caixa/);
      assert.match(t, /não a venda bruta/);
      assert.match(t, /Margem líquida\s+\d+,\d{2}%/);
      assert.match(t, /detalhe — já incluído na linha acima/);
      assert.doesNotMatch(t, /Margem líquida\s+R\$/);
      await captura(p, "40-dre");
      await semEstouro(p, "DRE desktop");
    } finally { await fechar(); }
    assert.deepEqual(erros, []);
    const m = await abrir("dre", { viewport: CELULAR });
    try { await m.p.locator(".fin-tabela").waitFor(); await captura(m.p, "41-dre-celular"); await semEstouro(m.p, "DRE celular"); } finally { await m.fechar(); }
    assert.deepEqual(m.erros, []);
  });

  test("indicadores: fórmula, origem, status e ponte resultado→caixa; categorias com ranking", async () => {
    const i = await abrir("indicadores");
    try {
      await i.p.locator(".fin-kpis").waitFor();
      const t = await i.p.locator("#view").innerText();
      assert.match(t, /Fórmula:/);
      assert.match(t, /Origem:/);
      assert.match(t, /Equivale a/);
      assert.match(t, /Ponte resultado → caixa/);
      assert.match(t, /Diferença|Fecha ao centavo/);
      await captura(i.p, "50-indicadores");
    } finally { await i.fechar(); }
    assert.deepEqual(i.erros, []);
    const c = await abrir("categorias");
    try {
      await c.p.locator(".fin-hbars").waitFor();
      assert.match(await c.p.locator("#view").innerText(), /% acumulado/);
      await captura(c.p, "51-categorias");
    } finally { await c.fechar(); }
    assert.deepEqual(c.erros, []);
  });

  test("contas e plano de contas: saldo parcial, extrato, plano com papéis", async () => {
    const c = await abrir("contas");
    try {
      await c.p.locator(".fin-tabela").first().waitFor();
      const t = await c.p.locator("#view").innerText();
      assert.match(t, /ADQUIRENTE/);
      assert.match(t, /Desconhecida/);
      assert.match(t, /Total consolidado indisponível/);
      await c.p.locator("[data-extrato]").first().click();
      await c.p.locator("dialog.fin-dialogo .fin-tabela").waitFor();
      assert.match(await c.p.locator("dialog.fin-dialogo").innerText(), /não é extrato bancário/);
      await captura(c.p, "60-contas-extrato");
    } finally { await c.fechar(); }
    assert.deepEqual(c.erros, []);
    const pl = await abrir("plano-de-contas");
    try {
      await pl.p.locator(".fin-tabela").waitFor();
      assert.match(await pl.p.locator("#view").innerText(), /Receita operacional/);
      await captura(pl.p, "61-plano");
    } finally { await pl.fechar(); }
    assert.deepEqual(pl.erros, []);
  });

  test("somente leitura: sem botões de escrita", async () => {
    const { p, erros, fechar } = await abrir("fluxo-de-caixa", { permissoes: ["gestao_financeira.ver"] });
    try {
      await p.locator(".fin-tabela").waitFor();
      assert.equal(await p.locator("[data-novo], [data-transf], [data-editar], [data-cancelar]").count(), 0);
    } finally { await fechar(); }
    assert.deepEqual(erros, []);
  });

  test("erro do servidor: mensagem e nova tentativa, sem tela quebrada", async () => {
    const { p, erros, fechar } = await abrir("indicadores", { mes: "2026-09" });
    try {
      await p.locator(".fin-kpis").waitFor();
      await p.route("**/relatorios/indicadores**", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Falha simulada" }) }));
      await p.locator("#fin-mes").fill("2026-08");
      await p.locator("#fin-mes").dispatchEvent("change");
      await p.locator(".fin-estado--erro").waitFor();
      assert.match(await p.locator(".fin-estado--erro").innerText(), /Falha simulada/);
      await p.unroute("**/relatorios/indicadores**");
      await p.locator("[data-fin-retry]").click();
      await p.locator(".fin-estado--vazio, .fin-kpis").first().waitFor();
    } finally { await fechar(); }
    assert.deepEqual(erros.filter((e) => !/500/.test(e)), []);
  });
});
