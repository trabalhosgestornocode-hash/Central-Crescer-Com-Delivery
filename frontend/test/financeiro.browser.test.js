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
  const r = await p.evaluate(() => {
    const largura = document.documentElement.clientWidth;
    const fora = [...document.querySelectorAll("#view *")].filter((n) => n.offsetParent !== null && n.getBoundingClientRect().right > largura + 1).slice(0, 4).map((n) => `${n.tagName.toLowerCase()}.${n.className || ""}[${(n.textContent || "").trim().slice(0, 24)}]=${Math.round(n.getBoundingClientRect().right)}`);
    return { largura, rolagem: document.documentElement.scrollWidth, fora };
  });
  assert.ok(r.rolagem <= r.largura + 1, `${rotulo}: rolagem horizontal (${r.rolagem} > ${r.largura}) ${r.fora.join(" | ")}`);
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

  test("conciliação: sem referência nada é inventado; com vendas e taxas o residual fica PENDENTE e só uma classificação manual o explica", async () => {
    const { p, erros, fechar } = await abrir("conciliacao");
    try {
      await p.locator(".fin-regime").waitFor();
      const t0 = await p.locator("#view").innerText();
      assert.match(t0, /Nenhuma referência informada para setembro\/2026/);
      assert.match(t0, /Não inventamos dados ausentes/);
      await captura(p, "70-conciliacao-vazia");
      const informar = async (tipo, valor, canal) => {
        await p.locator("[data-ref]").click();
        const dlg = p.locator("dialog.fin-dialogo");
        await dlg.locator('select[name="tipo"]').selectOption(tipo);
        await dlg.locator('input[name="data"]').fill("2026-09-30");
        await dlg.locator('input[name="valor"]').fill(valor);
        if (canal) await dlg.locator('input[name="canal"]').fill(canal);
        await dlg.locator('button[type="submit"]').click();
        await dlg.waitFor({ state: "detached" });
        await p.locator(".fin-regime").waitFor();
      };
      await informar("venda", "100.000,00");
      await p.locator("text=falta informar").first().waitFor();           // sem taxas informadas o residual não é calculado
      assert.match(await p.locator("#view").innerText(), /taxas/);
      await informar("taxa", "50,00", "stone");
      const t1 = await p.locator("#view").innerText();
      assert.match(t1, /pendente de identificação, NÃO presumido como prazo/);
      assert.match(t1, /Pendente de identificação/);
      assert.equal(repo._t.resol.length, 0, "nenhuma classificação foi criada sozinha");
      await captura(p, "71-conciliacao-pendente");
      await semEstouro(p, "conciliação desktop");
      // classificação manual: nota obrigatória, e vira "Classificado" só quando explica TODO o residual
      await p.locator('[data-classificar^="ponte_mensal"]').click();
      const dlg = p.locator("dialog.fin-dialogo");
      await dlg.locator('select[name="classificacao"]').selectOption("prazo");
      await dlg.locator('textarea[name="nota"]').fill("vendas do fim do mes recebidas no mes seguinte");
      await dlg.locator('button[type="submit"]').click();
      await dlg.waitFor({ state: "detached" });
      await p.locator("text=Classificado").first().waitFor();
      assert.equal(repo._t.resol.length, 1);
      assert.equal(repo._t.resol[0].classificacao, "prazo");
      await p.locator("[data-historico]").click();
      await p.locator("dialog.fin-dialogo .fin-tabela").waitFor();
      assert.match(await p.locator("dialog.fin-dialogo").innerText(), /insert/);
      await p.locator("dialog.fin-dialogo [data-cancelar]").click();
      await captura(p, "72-conciliacao-classificada");
    } finally { await fechar(); }
    assert.deepEqual(erros, []);
    const m = await abrir("conciliacao", { viewport: CELULAR });
    try { await m.p.locator(".fin-regime").waitFor(); await captura(m.p, "73-conciliacao-celular"); await semEstouro(m.p, "conciliação celular"); } finally { await m.fechar(); }
    assert.deepEqual(m.erros, []);
  });

  test("cancelar TRANSFERÊNCIA INTEIRA pela tela: motivo obrigatório, as duas pernas juntas, e a perna vinculada não cancela sozinha", async () => {
    const { p, erros, fechar } = await abrir("contas");
    try {
      await p.locator("[data-cancelar-par]").first().waitFor();
      assert.equal(await p.locator("[data-desvincular]").count() > 0, true);
      await captura(p, "80-contas-transferencias");
      await p.locator("[data-cancelar-par]").first().click();
      const dlg = p.locator("dialog.fin-dialogo");
      assert.match(await dlg.innerText(), /duas pernas/);
      await dlg.locator('textarea[name="motivo"]').fill("curto");
      await dlg.locator('button[type="submit"]').click();       // validação do navegador (minlength) impede o envio
      assert.equal(await dlg.count(), 1);
      await dlg.locator('textarea[name="motivo"]').fill("lancada em duplicidade pelo operador");
      await dlg.locator('button[type="submit"]').click();
      await dlg.waitFor({ state: "detached" });
      await p.locator("text=Cancelada").first().waitFor();
      const par = repo._t.transf.find((x) => x.status === "cancelada");
      assert.ok(par);
      const pernas = repo._t.lanc.filter((l) => [par.lancamento_saida_id, par.lancamento_entrada_id].includes(l.id));
      assert.deepEqual(pernas.map((l) => l.status), ["cancelado", "cancelado"]);
      await captura(p, "81-transferencia-cancelada");
    } finally { await fechar(); }
    assert.deepEqual(erros, []);
  });

  test("relatórios: 7 relatórios, filtros, estado vazio, dados parciais, unidade do contexto; exporta CSV e XLSX seguros (download real)", async () => {
    const XLSXn = reqBackend("xlsx");
    const ctxA = { organizacaoId: U(1), unidadeId: U(2), usuarioId: U(3) };
    const banco = repo._t.contas.find((c) => c.nome === "BANCO");
    await repo.inserirLancamento(ctxA, { conta_id: banco.id, categoria_id: null, descricao: "=HYPERLINK(\"http://evil.example\",\"clique\")", sentido: "saida", valor_centavos: 123, data_movimento: "2026-09-23", status: "realizado", classificacao_pendente: true });
    const { p, erros, fechar } = await abrir("relatorios");
    try {
      await p.locator("[data-rel]").first().waitFor();
      assert.equal(await p.locator("[data-rel]").count(), 7);
      const t0 = await p.locator("#view").innerText();
      assert.match(t0, /Unidade: unidade do contexto atual/);
      assert.match(t0, /Regime de caixa/);
      await p.locator('table[data-relatorio="movimentacoes"]').waitFor();
      assert.match(t0 + await p.locator("#view").innerText(), /Dados parciais/);                 // há lançamentos sem classificação
      await captura(p, "100-relatorios-movimentacoes");
      await semEstouro(p, "relatórios desktop");
      // filtros: tipo = saídas
      await p.locator('select[name="tipo"]').selectOption("saida");
      await p.locator('[data-filtros] button[type="submit"]').click();
      await p.waitForFunction(() => !/<td[^>]*data-rot="Entrada \(R\$\)"[^>]*>R\$/.test(document.querySelector("table[data-relatorio]")?.innerHTML ?? "") );
      // DRE do mesmo motor
      await p.locator('[data-rel="dre"]').click();
      await p.locator('table[data-relatorio="dre"]').waitFor();
      const dreTxt = await p.locator("#view").innerText();
      assert.match(dreTxt, /Margem de contribuição/); assert.match(dreTxt, /Detalhe \(já incluído na linha acima\)/);
      assert.match(dreTxt, /Margem líquida/);
      // todos os 7 relatórios geram sem erro
      for (const id of ["fluxo-caixa", "movimentacao-conta", "categorias", "conciliacoes", "periodos"]) {
        await p.locator(`[data-rel="${id}"]`).click();
        await p.locator(`table[data-relatorio="${id}"], .fin-estado--vazio`).first().waitFor();
      }
      await captura(p, "101-relatorios-periodos");
      // estado vazio honesto: período sem dados
      await p.locator('[data-rel="movimentacoes"]').click();
      await p.locator('input[name="de"]').fill("2025-01-01"); await p.locator('input[name="ate"]').fill("2025-01-31");
      await p.locator('[data-filtros] button[type="submit"]').click();
      await p.locator(".fin-estado--vazio").waitFor();
      assert.match(await p.locator("#view").innerText(), /Nenhum valor é inventado/);
      // exporta CSV (download real) com o período de setembro
      await p.locator('input[name="de"]').fill("2026-09-01"); await p.locator('input[name="ate"]').fill("2026-09-30");
      await p.locator('select[name="tipo"]').selectOption("");
      const [dlCsv] = await Promise.all([p.waitForEvent("download"), p.locator('[data-exportar="csv"]').click()]);
      assert.match(dlCsv.suggestedFilename(), /^movimentacoes_2026-09-01_2026-09-30_\d{12}\.csv$/);
      const csv = readFileSync(await dlCsv.path(), "utf8");
      assert.equal(csv.charCodeAt(0), 0xfeff);
      assert.match(csv, /Regime;"Regime de caixa/); assert.match(csv, /Período;01\/09\/2026 a 30\/09\/2026/); assert.match(csv, /Situação dos dados;PARCIAL/);
      assert.match(csv, /Código de verificação;/);
      assert.match(csv, /'=HYPERLINK/);
      for (const linha of csv.replace("﻿", "").split("\r\n").filter(Boolean)) assert.doesNotMatch(linha, /^[=+@]/);
      // exporta XLSX (download real): sem fórmulas, moeda numérica
      const [dlX] = await Promise.all([p.waitForEvent("download"), p.locator('[data-exportar="xlsx"]').click()]);
      const wb = XLSXn.read(readFileSync(await dlX.path()), { type: "buffer" });
      assert.deepEqual(wb.SheetNames, ["Dados", "Informações"]);
      const dados = wb.Sheets.Dados;
      assert.ok(Object.keys(dados).filter((k) => !k.startsWith("!")).every((k) => dados[k].f === undefined));
      const textos = Object.keys(dados).filter((k) => !k.startsWith("!") && dados[k].t === "s").map((k) => dados[k].v);
      assert.ok(textos.some((v) => v.startsWith("'=HYPERLINK")));
      assert.ok(textos.every((v) => !/^[=+@]/.test(v)));
      assert.ok(Object.keys(dados).some((k) => dados[k].t === "n" && Math.round(dados[k].v * 100) === 123));
    } finally { await fechar(); }
    assert.deepEqual(erros, []);
    for (const [nome, viewport, escuro] of [["celular", CELULAR, false], ["escuro", DESKTOP, true]]) {
      const m = await abrir("relatorios", { viewport, escuro });
      try {
        await m.p.locator('table[data-relatorio="movimentacoes"]').waitFor();
        await captura(m.p, `102-relatorios-${nome}`);
        await semEstouro(m.p, `relatórios ${nome}`);
        if (escuro) assert.equal((await m.p.evaluate(() => getComputedStyle(document.querySelector(".fin-pg")).getPropertyValue("--fin-entrada").trim())).toLowerCase(), "#4f8fd6");
      } finally { await m.fechar(); }
      assert.deepEqual(m.erros, []);
    }
  });

  test("relatórios: somente leitura exporta (ver); sem permissão de ver, a API recusa e a tela mostra erro claro", async () => {
    const leitura = await abrir("relatorios", { permissoes: ["gestao_financeira.ver"] });
    try {
      await leitura.p.locator('[data-exportar="csv"]').waitFor();
      const [dl] = await Promise.all([leitura.p.waitForEvent("download"), leitura.p.locator('[data-exportar="csv"]').click()]);
      assert.match(dl.suggestedFilename(), /\.csv$/);
    } finally { await leitura.fechar(); }
    assert.deepEqual(leitura.erros, []);
    const sem = await abrir("relatorios", { permissoes: [] });
    try {
      await sem.p.locator(".fin-estado--erro").waitFor();
      assert.doesNotMatch(await sem.p.locator("#view").innerText(), /fin_[a-z_]{4,}|organizacao_id|violates/i);
    } finally { await sem.fechar(); }
  });

  test("períodos: pré-fechamento bloqueado por pendências; sem política nem botão de exceção; exceção de SuperAdmin + reconhecimento; snapshot; mês fechado recusa lançamento com mensagem amigável", async () => {
    // no banco a linha do período nasce com o primeiro lançamento do mês (gatilho); o repositório de teste semeia sem passar por ele
    await repo.abrirPeriodoRpc({ organizacaoId: U(1), unidadeId: U(2), usuarioId: U(3) }, "2026-09");
    const { p, erros, fechar } = await abrir("periodos");
    try {
      await p.locator(".fin-tabela").waitFor();
      assert.match(await p.locator("#view").innerText(), /Fechamento com pendências[\s\S]*Bloqueado[\s\S]*SuperAdmin[\s\S]*MFA/);
      assert.equal(await p.locator("[data-politica]").count(), 0, "o gestor não flexibiliza o controle: não existe botão de política");
      assert.equal(await p.locator("[data-reabrir]").count(), 0, "nenhum nível tem reabrir: o botão nem aparece");
      await p.locator('[data-pre^="2026-09"]').first().click();
      const dlg = p.locator("dialog.fin-dialogo");
      await dlg.locator(".fin-kpis").waitFor();
      assert.match(await dlg.innerText(), /pendência\(s\) impedem o fechamento/);
      assert.equal(await dlg.locator('button[type="submit"]').isDisabled(), true);
      await captura(p, "90-periodos-bloqueado");
      await dlg.locator("[data-cancelar]").click();
      // a exceção é aprovada FORA da tela (SuperAdmin, após a validação do MFA); aqui simulamos o registro dela e redesenhamos a tela
      await repo.concederExcecaoFechamentoRpc({ organizacaoId: U(1), unidadeId: U(2), usuarioId: U(3) }, { mes: "2026-09", justificativa: "excecao sintetica: aguardando comprovantes do mes", validadeDias: 5, pendenciasConciliacao: 99, mfaEvidencia: { aal: "aal2", em: new Date().toISOString() } });
      await p.evaluate(async (perms) => { const m = await import("/src/financeiro/periodos.js"); await m.render(document.querySelector("#view"), { permissoes: perms, nivel: "gestor" }); }, TODAS);
      await p.locator("text=Ativa").first().waitFor();
      // agora o fechamento exige RECONHECER as pendências
      await p.locator('[data-pre^="2026-09"]').first().click();
      const d2 = p.locator("dialog.fin-dialogo");
      await d2.locator('input[name="reconheco"]').waitFor();
      if (process.env.FIN_DEBUG) console.log("DBG2", JSON.stringify(await d2.innerText()));
      assert.equal(await d2.locator('button[type="submit"]').isDisabled(), false);
      await d2.locator('input[name="reconheco"]').check();
      await d2.locator('input[name="confirmo"]').check();
      await d2.locator('button[type="submit"]').click();
      await d2.waitFor({ state: "detached" });
      await p.locator("text=Fechado").first().waitFor();
      const per = repo._t.per.find((x) => x.mes === "2026-09-01");
      assert.equal(per.status, "fechado");
      assert.equal(per.snapshot.regime, "caixa");
      assert.ok(per.snapshot.pendenciasNoFechamento > 0);
      await p.locator("[data-snap]").first().click();
      assert.match(await p.locator("dialog.fin-dialogo").innerText(), /imutável|congelados/);
      await p.locator("dialog.fin-dialogo [data-cancelar]").click();
      await captura(p, "91-periodos-fechado");
      await semEstouro(p, "períodos desktop");
    } finally { await fechar(); }
    assert.deepEqual(erros, []);
    // mês fechado: o Fluxo recusa lançamento novo com mensagem amigável (sem detalhes internos)
    const f = await abrir("fluxo-de-caixa");
    try {
      await f.p.locator(".fin-tabela").first().waitFor();
      await f.p.locator("[data-novo]").click();
      const d = f.p.locator("dialog.fin-dialogo");
      await d.locator('select[name="contaId"]').selectOption({ label: "BANCO" });
      await d.locator('select[name="sentido"]').selectOption("saida");
      await d.locator('input[name="descricao"]').fill("lancamento em mes fechado");
      await d.locator('input[name="valor"]').fill("1,00");
      await d.locator('input[name="dataMovimento"]').fill("2026-09-22");
      await d.locator('button[type="submit"]').click();
      await d.locator(".fin-form-erro:not([hidden])").waitFor();
      const msg = await d.locator(".fin-form-erro").innerText();
      assert.match(msg, /mês está fechado/i);
      assert.doesNotMatch(msg, /fin_|23514|trigger|constraint/i);
      await d.locator("[data-cancelar]").click();
    } finally { await f.fechar(); }
    const m = await abrir("periodos", { viewport: CELULAR });
    try { await m.p.locator(".fin-tabela").first().waitFor(); await captura(m.p, "92-periodos-celular"); await semEstouro(m.p, "períodos celular"); } finally { await m.fechar(); }
    assert.deepEqual(m.erros, []);
  });


  test("configurações: só o que o domínio suporta; abertura desconhecida; regras históricas protegidas após o fechamento; itens indisponíveis sem controle de enfeite", async () => {
    const { p, erros, fechar } = await abrir("configuracoes");
    try {
      await p.locator(".fin-card").first().waitFor();
      const t = await p.locator("#view").innerText();
      assert.match(t, /Saldo de abertura desconhecido em \d+ conta/);
      assert.match(t, /parciais; nunca assumimos zero|parciais/);
      assert.match(t, /Contas financeiras/); assert.match(t, /Plano de contas/); assert.match(t, /Exceções de sangria/); assert.match(t, /Fechamento com pendências/);
      assert.match(t, /Indisponível ou pendente de decisão/);
      assert.match(t, /Regras de classificação automática/); assert.match(t, /Reabertura de períodos fechados/); assert.match(t, /MFA recente/);
      assert.match(t, /Bloqueado/); assert.match(t, /Não há política geral/); assert.doesNotMatch(t, /Permitido \(aprovado\)/);
      // nenhum controle para o que está indisponível
      const indisp = await p.locator(".fin-card", { hasText: "Indisponível ou pendente de decisão" }).locator("button, input, select").count();
      assert.equal(indisp, 0);
      await captura(p, "110-configuracoes");
      await semEstouro(p, "configurações desktop");
      // setembro está fechado (teste anterior): tipo/canal travados nas contas com movimento fechado; papel fixo em categorias usadas
      await p.locator("tr", { hasText: "em mês fechado" }).first().locator("[data-conta]").click();
      const dlg = p.locator("dialog.fin-dialogo");
      assert.match(await dlg.innerText(), /Tipo e canal travados/);
      assert.equal(await dlg.locator('select[name="tipoConta"]').count(), 0);
      await dlg.locator("[data-cancelar]").click();
      await p.locator("tr", { hasText: "fixo:" }).first().locator("[data-cat]").click();
      const d2 = p.locator("dialog.fin-dialogo");
      assert.match(await d2.innerText(), /Papel fixo/);
      assert.equal(await d2.locator('select[name="papel"]').count(), 0);
      await d2.locator("[data-cancelar]").click();
      // informar abertura de uma conta com abertura desconhecida (funcionalidade real)
      await p.locator('[data-abertura]', { hasText: "Informar abertura" }).first().click();
      const d3 = p.locator("dialog.fin-dialogo");
      await d3.locator('input[name="dataReferencia"]').fill("2026-10-01");
      await d3.locator('input[name="valor"]').fill("250,00");
      await d3.locator('button[type="submit"]').click();
      await d3.waitFor({ state: "detached" });
      await p.locator(".fin-alerta", { hasText: /abertura desconhecido|Todas as contas ativas/ }).first().waitFor();
      assert.ok(repo._t.aberturas.some((a) => a.valor_centavos === 25000 && a.origem === "manual"));
    } finally { await fechar(); }
    assert.deepEqual(erros, []);
    for (const [nome, viewport, escuro] of [["celular", CELULAR, false], ["escuro", DESKTOP, true]]) {
      const m = await abrir("configuracoes", { viewport, escuro });
      try { await m.p.locator(".fin-card").first().waitFor(); await captura(m.p, `111-configuracoes-${nome}`); await semEstouro(m.p, `configurações ${nome}`); } finally { await m.fechar(); }
      assert.deepEqual(m.erros, []);
    }
    // somente leitura: nenhum botão de escrita
    const leitura = await abrir("configuracoes", { permissoes: ["gestao_financeira.ver"] });
    try {
      await leitura.p.locator(".fin-card").first().waitFor();
      assert.equal(await leitura.p.locator("[data-nova-conta], [data-nova-cat], [data-conta], [data-cat], [data-abertura], [data-exc-nova], [data-exc-off]").count(), 0);
      assert.match(await leitura.p.locator("#view").innerText(), /Somente leitura/);
    } finally { await leitura.fechar(); }
    assert.deepEqual(leitura.erros, []);
  });

});
