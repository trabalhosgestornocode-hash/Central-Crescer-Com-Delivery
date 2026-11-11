// Importar contas a pagar de planilha em NAVEGADOR REAL (Chrome via Playwright) contra o servidor financeiro real (rotas, validações e permissões)
// com repositório em MEMÓRIA e dados sintéticos. Nunca fala com Supabase, produção nem rede externa.
// Rodar:  FIN_PLAYWRIGHT_PATH=<...>/worker-martinbrower/node_modules/playwright FIN_BROWSER_CHANNEL=chrome node --test frontend/test/importarContasPagar.browser.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BACKEND = resolve(RAIZ, "..", "backend");
const reqBackend = createRequire(pathToFileURL(join(BACKEND, "package.json")));
let chromium;
try { ({ chromium } = createRequire(import.meta.url)(process.env.FIN_PLAYWRIGHT_PATH || process.env.CHECKLIST_PLAYWRIGHT_PATH || "playwright")); } catch { /* sem Playwright: pulado */ }
const PULAR = !chromium && "Configure FIN_PLAYWRIGHT_PATH (Playwright) para rodar no navegador";
const CANAL = process.env.FIN_BROWSER_CHANNEL || process.env.CHECKLIST_BROWSER_CHANNEL;
const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/financeiro/financeiro-paginas.css">
<script>window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}})}})};</script>
</head><body><div id="app" class="app"><div class="main"><main id="view" class="content"></main></div></div><div id="toast" class="toast"></div></body></html>`;
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml" };
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TODAS = ["ver", "lancar", "editar", "conciliar", "fechar", "configurar", "cancelar", "classificar"].map((a) => `gestao_financeira.${a}`);

let servidor, base, navegador, st, XLSX;
before(async () => {
  if (PULAR) return;
  process.env.SUPABASE_URL = "http://127.0.0.1:1"; process.env.SUPABASE_SERVICE_ROLE_KEY = "teste-local"; process.env.SUPABASE_ANON_KEY = "teste-local";
  const express = reqBackend("express"); XLSX = reqBackend("xlsx");
  const { criarDominioRouter } = await import(pathToFileURL(join(BACKEND, "src/modules/gestao-financeira/dominio/rotas.js")).href);
  const { criarRepoMemoria } = await import(pathToFileURL(join(BACKEND, "test/financeiro/helpers/repoMemoria.js")).href);
  const repo = criarRepoMemoria();
  st = { fornecedores: [], obrigacoes: [], pagamentos: [], quitadas: [] }; let n = 0;
  Object.assign(repo, {
    listarFornecedores: async () => st.fornecedores.map((f) => ({ ...f })), inserirFornecedor: async (_c, v) => { const f = { id: U(9000 + ++n), ativo: true, ...v }; st.fornecedores.push(f); return f; },
    listarObrigacoes: async () => st.obrigacoes.map((o) => ({ ...o })), inserirObrigacao: async (_c, v) => { const o = { id: U(9500 + ++n), status: "aberta", ...v }; st.obrigacoes.push(o); return o; },
    inserirPagamento: async (_c, v) => { const p = { id: U(9800 + ++n), status: "ativo", ...v }; st.pagamentos.push(p); return p; },
    quitarObrigacaoRpc: async (_c, id) => { st.quitadas.push(id); const o = st.obrigacoes.find((x) => x.id === id); if (o) o.status = "quitada"; },
    listarPagamentos: async () => st.pagamentos.map((p) => ({ ...p })), listarVinculosSaidas: async () => [], listarAuditoria: async () => [],
  });
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  const gate = (acao) => (req, _res, next) => {
    const perms = (req.headers["x-perms"] ?? TODAS.join(",")).split(",");
    req.financeiro = { organizacaoId: U(1), unidadeId: U(2), permissoes: perms }; req.user = { id: U(3) };
    perms.includes(acao) ? next() : next(Object.assign(new Error("Permissão financeira insuficiente."), { statusCode: 403 }));
  };
  app.get("/api/config", (_req, res) => res.json({ supabaseUrl: "http://127.0.0.1:1", supabaseAnonKey: "teste-local" }));
  app.use("/api/v1/gestao-financeira", criarDominioRouter({ autorizar: gate, deps: { repo, db: undefined }, financeiro2: () => true }));
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
  navegador = await chromium.launch({ headless: true, ...(CANAL ? { channel: CANAL } : {}) });
  const post = async (rota, corpo) => { const r = await fetch(`${base}/api/v1/gestao-financeira${rota}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) }); const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return j.data; };
  await post("/plano-contas", { tipo: "DESPESA", natureza: "FIXA", nome: "ADMINISTRATIVA", papel: "despesa_fixa" });
  await post("/plano-contas", { tipo: "CUSTO", natureza: "VARIAVEL", nome: "INSUMOS", papel: "custo_variavel" });
  await post("/contas", { nome: "UNICRED MP ALIMENTOS", tipoConta: "banco" });
  await post("/contas", { nome: "CAIXA DA LOJA", tipoConta: "outra" });
});
after(async () => { await navegador?.close(); await new Promise((r) => servidor?.close(r)); });

const linha = (v, prev, real, desc, cls, cat, nat, forma, dp, origem) => [v, prev, real, 0, desc, cls, cat, nat, "x", forma, dp, origem];
function planilha() {
  const ws = XLSX.utils.aoa_to_sheet([["Legenda"], [], ["VENCIMENTO", "VALOR PREVISTO", "VALOR REALIZADO", "JUROS / DIFERENÇA", "Descrição", "CLASSIFICAÇÃO", "CATEGORIA", "Natureza", "Conta", "BANCO / FORMA", "DATA PAGAMENTO", "ORIGEM"],
    linha("2026-09-05", 1000, 1000, "Aluguel – Imobiliária Sol", "Despesa", "Administrativa", "Fixa", "Unicred MP", "2026-09-05", "Sistema + extrato"),
    linha("2026-09-08", 250.5, 250.5, "Polpa – Frutas do Norte", "Custo", "Insumos", "Variavel", "Caixa (espécie)", "2026-09-08", "Sistema + extrato"),
    linha("2026-09-20", 400, 0, "Internet – Provedor Y", "Despesa", "Administrativa", "Fixa", null, null, "Sistema – não pago em setembro"),
    linha("2026-09-12", 99, 99, "Pix avulso", "Despesa", "Administrativa", "Fixa", "Unicred MP", "2026-09-12", "Só extrato (sem título no sistema)"),
    linha("2026-09-15", 800, 800, "Forno – Prática", "Investimento", "Imobilizado", "Não DRE", "Unicred MP", "2026-09-15", "Sistema + extrato")]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "FLUXO DE CAIXA 09.2026");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
const mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
async function abrir({ permissoes = TODAS } = {}) {
  const ctx = await navegador.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { "x-perms": permissoes.join(",") } });
  const p = await ctx.newPage(); const erros = [];
  p.on("pageerror", (e) => erros.push(e.message));
  await p.goto(base + "/");
  await p.evaluate(async ({ permissoes }) => { const m = await import("/src/financeiro/contas-a-pagar.js"); await m.render(document.querySelector("#view"), { permissoes, nivel: "gestor" }); }, { permissoes });
  await p.waitForSelector("[data-importar-cp]");
  return { p, erros, fechar: () => ctx.close() };
}

describe("Importar contas a pagar no navegador (servidor financeiro real, dados sintéticos)", { skip: PULAR, timeout: 300_000 }, () => {
  test("prévia não grava; categoria e conta vêm sugeridas; item sem sugestão bloqueia até escolher; importa, quita e não duplica", async () => {
    const { p, erros, fechar } = await abrir();
    try {
      await p.click("[data-importar-cp]");
      await p.setInputFiles("[data-arq]", { name: "contas.xlsx", mimeType: mime, buffer: planilha() });
      await p.click("[data-previa]");
      await p.waitForSelector("[data-mc]");
      if (process.env.FIN_SCREENSHOTS) await p.screenshot({ path: join(process.env.FIN_SCREENSHOTS, "importar-contas-pagar.png") });
      assert.match(await p.locator("[data-resultado]").first().innerText(), /4 título\(s\) do sistema no arquivo: 4 novo\(s\)/);
      assert.deepEqual([st.obrigacoes.length, st.pagamentos.length], [0, 0], "a prévia não grava nada");
      assert.match(await p.locator("[data-resultado]").innerText(), /1 linha\(s\) de “só extrato”/);
      const sel = async (chave) => p.locator(`select[data-mc]`).evaluateAll((ns, k) => ns.map((n) => [n.dataset.mc, n.selectedOptions[0]?.textContent]).filter(([c]) => c.includes(k)), chave);
      assert.deepEqual((await sel("ADMINISTRATIVA"))[0][1], "ADMINISTRATIVA"); assert.deepEqual((await sel("INSUMOS"))[0][1], "INSUMOS");
      assert.equal((await sel("IMOBILIZADO"))[0][1], "Escolha…", "sem base, não chuta");
      assert.equal(await p.locator("[data-confirmar]").isDisabled(), true); assert.equal(await p.locator("[data-falta]").isVisible(), true);
      assert.deepEqual(await p.$$eval("select[data-mt]", (ns) => ns.map((n) => n.selectedOptions[0].textContent).sort()), ["CAIXA DA LOJA", "UNICRED MP ALIMENTOS"]);
      // o forno: escolhe ADMINISTRATIVA só para o teste
      await p.locator('select[data-mc*="IMOBILIZADO"]').selectOption({ label: "ADMINISTRATIVA" });
      assert.equal(await p.locator("[data-confirmar]").isDisabled(), false);
      assert.match(await p.locator("[data-confirmar]").innerText(), /Importar 4 conta\(s\)/);
      await p.click("[data-confirmar]");
      await p.waitForSelector("[data-resultado] .fin-alerta:has-text('Importação concluída')");
      assert.match(await p.locator("[data-resultado]").innerText(), /4 conta\(s\) criada\(s\), 3 pagamento\(s\) registrado\(s\), 3 quitada\(s\)/);
      assert.deepEqual([st.obrigacoes.length, st.pagamentos.length, st.quitadas.length], [4, 3, 3]);
      assert.deepEqual(st.pagamentos.map((x) => x.conta_id).length, 3); assert.ok(st.obrigacoes.every((o) => /\[imp-cp:/.test(o.observacoes)));
      // reenviar o mesmo arquivo: nada a importar
      await p.click("[data-fechar]");
      await p.click("[data-importar-cp]");
      await p.setInputFiles("[data-arq]", { name: "contas.xlsx", mimeType: mime, buffer: planilha() });
      await p.click("[data-previa]");
      await p.waitForSelector("[data-resultado] .fin-alerta:has-text('Nada a importar')");
      assert.equal(st.obrigacoes.length, 4);
    } finally { await fechar(); }
    assert.deepEqual(erros, []);
  });

  test("'Não importar este grupo' deixa o grupo de fora", async () => {
    st.obrigacoes.length = 0; st.pagamentos.length = 0; st.quitadas.length = 0;
    const { p, fechar } = await abrir();
    try {
      await p.click("[data-importar-cp]");
      await p.setInputFiles("[data-arq]", { name: "contas.xlsx", mimeType: mime, buffer: planilha() });
      await p.click("[data-previa]"); await p.waitForSelector("[data-mc]");
      await p.locator('select[data-mc*="IMOBILIZADO"]').selectOption({ label: "Não importar este grupo" });
      assert.match(await p.locator("[data-confirmar]").innerText(), /Importar 3 conta\(s\)/);
      await p.click("[data-confirmar]"); await p.waitForSelector("[data-resultado] .fin-alerta:has-text('Importação concluída')");
      assert.equal(st.obrigacoes.length, 3); assert.match(await p.locator("[data-resultado]").innerText(), /1 deixada\(s\) de fora por escolha/);
    } finally { await fechar(); }
  });

  test("arquivo errado: mensagem clara e nada gravado; sem permissão de lançar não há botão", async () => {
    st.obrigacoes.length = 0;
    const { p, fechar } = await abrir();
    try {
      await p.click("[data-importar-cp]");
      const ws = XLSX.utils.aoa_to_sheet([["a", "b"], [1, 2]]); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "X");
      await p.setInputFiles("[data-arq]", { name: "errado.xlsx", mimeType: mime, buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) });
      await p.click("[data-previa]");
      await p.waitForSelector("[role=alert]");
      assert.match(await p.locator("[data-resultado]").innerText(), /Não encontrei a aba de contas a pagar/); assert.equal(st.obrigacoes.length, 0);
    } finally { await fechar(); }
    const leitura = await navegador.newContext({ extraHTTPHeaders: { "x-perms": "gestao_financeira.ver" } });
    const q = await leitura.newPage(); await q.goto(base + "/");
    await q.evaluate(async () => { const m = await import("/src/financeiro/contas-a-pagar.js"); await m.render(document.querySelector("#view"), { permissoes: ["gestao_financeira.ver"], nivel: "leitura" }); });
    await q.waitForSelector(".fin-cab");
    assert.equal(await q.locator("[data-importar-cp]").count(), 0); await leitura.close();
  });
});
