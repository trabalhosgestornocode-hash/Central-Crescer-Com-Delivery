// Dashboard Operacional 2.0 — abas, Ficha 360°, fechamento e WhatsApp SIMULADO em NAVEGADOR REAL (Chrome via Playwright).
//
// Servidor local em memória: serve o frontend e responde as rotas do Dashboard com o SERVICE REAL do backend
// (checklistOperacional.operacional.service / .service) sobre repositórios em memória e o cenário SINTÉTICO dos testes do backend.
// Nunca fala com produção, Supabase, iFood ou WhatsApp. O relógio do navegador e do servidor é fixo (28/10/2026 09:00 em SP).
//
// Rodar:
//   CHECKLIST_PLAYWRIGHT_PATH=<...>/worker-martinbrower/node_modules/playwright CHECKLIST_BROWSER_CHANNEL=chrome \
//   node --test frontend/test/checklistOperacionalDashboard2.browser.test.js
// (precisa de backend/node_modules — o service real é carregado). CHECKLIST_SCREENSHOTS=<pasta> grava capturas.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

let chromium;
try { ({ chromium } = createRequire(import.meta.url)(process.env.CHECKLIST_PLAYWRIGHT_PATH || "playwright")); } catch { /* sem Playwright: pulado */ }
const PULAR = !chromium && "Configure CHECKLIST_PLAYWRIGHT_PATH (Playwright) para rodar no navegador";
const CANAL = process.env.CHECKLIST_BROWSER_CHANNEL;
const CAPTURAS = process.env.CHECKLIST_SCREENSHOTS;

const AGORA = Date.parse("2026-10-28T12:00:00.000Z");   // 09:00 em São Paulo — 27/10 já pode ser consolidado
const RAIZ = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/checklistOperacional.css"><link rel="stylesheet" href="/src/checklistOperacionalDashboard.css">
<script>window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}})}})};</script>
</head><body>
<div id="login-screen" hidden></div><div id="selecao-screen" hidden></div>
<div id="app" class="app"><aside id="sidebar" class="sidebar"><nav class="menu"><ul id="menu"></ul></nav></aside>
<div class="main"><header class="topbar"><h1 id="page-title">Checklist Operacional</h1></header><main id="view" class="content"></main></div></div>
</body></html>`;

let servidor; let base; let mod; let XLSX;
const chamadas = [];
const estado = { db: null, deps: null };

function novoBanco() {
  const b = mod.sint.bancoSintetico();
  estado.db = b.db;
  estado.deps = { repo: mod.sint.repoFake(b.db), op: mod.sint.opFake(b.db), ia: {} };
}

before(async () => {
  if (PULAR) return;
  Object.assign(process.env, { SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "ficticio_service_role_key_0123456789abcdef", SUPABASE_ANON_KEY: "ficticio_anon_key_0123456789abcdef0123" });
  const back = (m) => import(new URL(`../../backend/${m}`, import.meta.url));
  mod = {
    op: await back("src/modules/checklist-operacional/checklistOperacional.operacional.service.js"),
    svc: await back("src/modules/checklist-operacional/checklistOperacional.service.js"),
    exp: await back("src/modules/checklist-operacional/checklistOperacional.exportar.js"),
    sint: await back("test/helpers/operacional-sintetico.js"),
    fix: await import("./checklistOperacionalFixture.js"),
  };
  XLSX = createRequire(new URL("../../backend/package.json", import.meta.url))("xlsx");
  novoBanco();
  const T = mod.sint.TENANT_A1;
  const agora = () => new Date(AGORA);
  const json = (res, status, corpo) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(corpo)); };
  const lerCorpo = (req) => new Promise((r) => { let c = ""; req.on("data", (x) => { c += x; }); req.on("end", () => r(c ? JSON.parse(c) : {})); });
  const permissoes = () => estado.permissoes ?? ["checklist.visualizar", "configuracoes.gerenciar"];
  const gerencia = () => permissoes().includes("configuracoes.gerenciar");
  servidor = createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    const q = Object.fromEntries(u.searchParams.entries());
    try {
      if (p === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(PAGINA); return; }
      if (p === "/favicon.ico") { res.writeHead(204).end(); return; }
      if (p === "/api/config") return json(res, 200, { supabaseUrl: "http://127.0.0.1:9", supabaseAnonKey: "x" });
      if (p.startsWith("/api/")) chamadas.push(`${req.method} ${p}`);
      const R = "/api/v1/checklist-operacional";
      if (p === `${R}/resumo`) return json(res, 200, { data: { ...mod.fix.respostaResumo(AGORA), modo: "integrado" } });
      if (p === `${R}/dashboard`) return json(res, 200, { data: await mod.svc.obterDashboard({ ...T, filtro: q, agora, deps: { repo: estado.deps.repo } }) });
      if (p === `${R}/pedidos`) return json(res, 200, { data: await mod.op.listarPedidos({ ...T, filtro: q, agora, deps: estado.deps }) });
      if (p.startsWith(`${R}/pedidos/`)) return json(res, 200, { data: await mod.op.obterFicha({ ...T, chave: decodeURIComponent(p.split("/").pop()), agora, deps: estado.deps }) });
      if (p === `${R}/fechamentos` && req.method === "GET") return json(res, 200, { data: await mod.op.listarFechamentos({ ...T, competencia: q.competencia ?? null, deps: estado.deps }) });
      if (p === `${R}/fechamentos` && req.method === "POST") {
        if (!gerencia()) return json(res, 403, { error: "Acesso negado" });
        const c = await lerCorpo(req);
        const r = await mod.op.gerarFechamento({ ...T, competencia: c.competencia, motivo: c.motivo ?? null, origem: c.reprocessar ? "reprocessamento" : "manual", geradoPor: "u-teste", agora, deps: estado.deps });
        return json(res, r.resultado === "REGISTRADO" ? 201 : 200, { data: r });
      }
      const m = p.match(/^\/api\/v1\/checklist-operacional\/fechamentos\/([0-9a-f-]{36})(\/.*)?$/);
      if (m) {
        const [, id, resto = ""] = m;
        if (resto === "") return json(res, 200, { data: await mod.op.obterFechamento({ ...T, id, deps: estado.deps }) });
        if (resto === "/whatsapp") return json(res, 200, { data: await mod.op.previaWhatsapp({ ...T, id, deps: estado.deps }) });
        if (resto === "/whatsapp/simular") {
          if (!gerencia()) return json(res, 403, { error: "Acesso negado" });
          const r = await mod.op.simularWhatsapp({ ...T, id, criadoPor: "u-teste", deps: estado.deps });
          return json(res, r.duplicada ? 200 : 201, { data: r });
        }
        if (resto === "/exportar.xlsx") {
          const f = await mod.op.obterFechamento({ ...T, id, deps: estado.deps });
          res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${mod.exp.nomeArquivoFechamento(f)}"` });
          res.end(mod.exp.gerarExcelFechamento({ fechamento: f, unidadeNome: "Unidade Sintética" }));
          return;
        }
      }
      if (p.startsWith("/api/")) return json(res, 404, { error: "não encontrado" });
      const arq = resolve(RAIZ, "." + p);
      if (!arq.startsWith(RAIZ + sep)) { res.writeHead(403).end(); return; }
      res.setHeader("Content-Type", arq.endsWith(".css") ? "text/css" : arq.endsWith(".svg") ? "image/svg+xml" : arq.endsWith(".jpeg") ? "image/jpeg" : "text/javascript");
      res.end(readFileSync(arq));
    } catch (e) {
      json(res, e?.statusCode ?? 500, { error: e?.message ?? "erro" });
    }
  });
  await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  if (CAPTURAS) mkdirSync(CAPTURAS, { recursive: true });
});
after(async () => { if (servidor) await new Promise((r) => servidor.close(r)); });

async function abrir(browser, { viewport = { width: 1366, height: 900 }, permissoes } = {}) {
  estado.permissoes = permissoes;
  const ctx = await browser.newContext({ viewport, acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
  await ctx.addInitScript(() => { window.__impressoes = []; window.print = () => { (window.top.__impressoes ??= []).push(document.title); }; });
  const pagina = await ctx.newPage();
  const erros = [];
  pagina.on("pageerror", (e) => erros.push(e.message));
  pagina.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) erros.push(m.text()); });
  await pagina.clock.setFixedTime(new Date(AGORA));
  await pagina.goto(base + "/");
  await pagina.evaluate(async ({ org, unidade, permissoes: perms }) => {
    sessionStorage.clear();
    const { state } = await import("/src/state.js");
    Object.assign(state.sessao, { empresa: { id: org, nome: "Empresa de teste" }, unidade, permissoes: perms, modulos: ["checklist_operacional", "ifood"] });
    state.rota = "checklist-operacional";
    const ck = await import("/src/checklistOperacional.js");
    ck.renderChecklistOperacional();
  }, { org: mod.sint.TENANT_A1.organizacaoId, unidade: { id: mod.sint.TENANT_A1.unidadeId, nome: "Unidade Sintética" }, permissoes: permissoes ?? ["checklist.visualizar", "configuracoes.gerenciar"] });
  await pagina.locator('[data-acao="abrir-dashboard"]').click();
  await pagina.locator("[data-ckd]").waitFor();
  return { ctx, pagina, erros };
}
const foto = async (pagina, nome) => { if (CAPTURAS) await pagina.screenshot({ path: resolve(CAPTURAS, `${nome}.png`), fullPage: true }); };
const semRolagemHorizontal = (pagina) => pagina.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const texto = (pagina) => pagina.evaluate(() => document.body.innerText);
async function irPara(pagina, aba) {
  await pagina.locator(`[data-acao="aba"][data-aba="${aba}"]`).click();
  await pagina.locator(`#ckd-painel-${aba}`).waitFor();
}
async function periodoOntem(pagina) {
  await pagina.locator('[data-ckd-filtros] [name="periodo"]').selectOption("ontem");
  await pagina.waitForFunction(() => /27\/10\/2026/.test(document.querySelector(".ckd-cab p")?.textContent ?? ""));
}

const OPC = { skip: PULAR };   // por teste: sem Playwright, os 6 aparecem como PULADOS (não somem da contagem)
describe("Dashboard Operacional 2.0 em navegador real", { timeout: 240_000 }, () => {
  let browser;
  before(async () => { if (PULAR) return; browser = await chromium.launch({ headless: true, ...(CANAL ? { channel: CANAL } : {}) }); });
  after(async () => { await browser?.close(); });

  test("quatro abas com teclado; Visão Geral sem Mediana/P90; Ocorrências com análises e qualidade", OPC, async () => {
    novoBanco();
    const { ctx, pagina, erros } = await abrir(browser);
    await periodoOntem(pagina);
    assert.equal(await pagina.locator('[role="tab"]').count(), 4);
    assert.equal(await pagina.locator('[role="tab"][aria-selected="true"]').getAttribute("data-aba"), "visao");
    const visao = await texto(pagina);
    assert.match(visao, /Pedidos recebidos/);
    assert.match(visao, /Preparo — tempo médio/);
    assert.doesNotMatch(visao, /mediana|\bP90\b/i, "nada de Mediana/P90 na interface gerencial");
    await foto(pagina, "d2-visao");
    await pagina.locator('[role="tab"][aria-selected="true"]').focus();
    await pagina.keyboard.press("ArrowRight");
    await pagina.locator("#ckd-painel-pedidos").waitFor();
    assert.equal(await pagina.evaluate(() => document.activeElement?.id), "ckd-aba-pedidos", "o foco acompanha a aba pelo teclado");
    await pagina.keyboard.press("End");
    await pagina.locator("#ckd-painel-fechamentos").waitFor();
    await irPara(pagina, "ocorrencias");
    const oc = await texto(pagina);
    assert.match(oc, /Inteligência operacional/);
    assert.match(oc, /Cobertura e qualidade dos dados/);
    assert.doesNotMatch(oc, /mediana|\bP90\b/i);
    assert.deepEqual(erros, []);
    await ctx.close();
  });

  test("Pedidos e Ficha 360°: lista do período, busca, ficha com tempos/linha do tempo, sem dado pessoal; fecha e devolve o foco", OPC, async () => {
    novoBanco();
    const { ctx, pagina, erros } = await abrir(browser);
    await periodoOntem(pagina);
    await irPara(pagina, "pedidos");
    await pagina.waitForFunction(() => /36 pedidos recebidos no período/.test(document.body.innerText));
    await pagina.locator('[name="busca-pedido"]').fill("110");
    await pagina.waitForFunction(() => /encontrados/.test(document.body.innerText));
    assert.equal(await pagina.locator('[data-acao="ficha"]').count(), 4, "busca por número: #1100–#1103");
    await pagina.locator('[data-acao="ficha"]', { hasText: "#1100" }).click();
    const dlg = pagina.locator("dialog.ckd-dialogo--ficha");
    await dlg.locator("#ckd-t-ficha").waitFor();
    const ficha = await dlg.textContent();   // textContent: sem o text-transform do CSS
    for (const t of ["Ficha 360° do pedido", "#1100", "Linha do tempo oficial", "Financeiro operacional", "Não são repasse", "+10 min", "Espera do entregador na loja"]) assert.ok(ficha.includes(t), t);
    for (const v of Object.values(mod.sint.PII)) assert.equal(ficha.includes(v), false, `dado pessoal: ${v}`);
    await foto(pagina, "d2-ficha");
    await dlg.locator('[data-acao="fechar-ficha"]').last().click();
    await dlg.waitFor({ state: "detached" });
    assert.deepEqual(erros, []);
    await ctx.close();
  });

  test("Fechamentos: gerar → CONSOLIDADO v1; os 11 indicadores; mesmos números na tela, na prévia do WhatsApp e no Excel; PDF impresso", OPC, async () => {
    novoBanco();
    const { ctx, pagina, erros } = await abrir(browser);
    await irPara(pagina, "fechamentos");
    await pagina.waitForFunction(() => /Nenhum fechamento registrado para 27\/10\/2026/.test(document.body.innerText));
    await pagina.locator('[data-ckd-fechamento] button[type="submit"]').click();
    await pagina.waitForFunction(() => /Versão 1 registrada \(consolidado\)/.test(document.body.innerText));
    await pagina.locator("[data-ckd-mensagem]").waitFor();
    const tela = await texto(pagina);
    for (const n of ["1 · Pedidos", "2 · Preparo — tempo médio", "3 · Entrega — tempo médio", "4 · Vida do pedido — tempo médio", "5 · Pedidos atrasados", "6 · Cancelamentos", "7 · Maior movimento", "8 · Disputas", "9 · Descontos pagos pela loja", "10 · Clientes", "11 · Diagnóstico e ação sugerida"]) assert.ok(tela.includes(n), n);
    assert.match(tela, /35\s*recebidos/);
    const msg = await pagina.locator("[data-ckd-mensagem]").innerText();
    assert.match(msg, /Recebidos: 35 · Concluídos no dia: 32 · Cancelados no dia: 3/);
    assert.match(msg, /Preparo: 16 min/);
    assert.match(tela, /Nenhuma mensagem é enviada/);
    // Excel: download real da versão armazenada
    const [download] = await Promise.all([pagina.waitForEvent("download"), pagina.locator('[data-acao="fech-excel"]').click()]);
    assert.equal(download.suggestedFilename(), "Fechamento-Operacional_2026-10-27_v1.xlsx");
    const wb = XLSX.read(readFileSync(await download.path()), { type: "buffer" });
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets.Resumo, { header: 1 });
    const valor = (rot) => linhas.find((l) => l[0] === rot)?.[1];
    assert.equal(valor("Pedidos recebidos"), 35);
    assert.equal(valor("Tempo médio de preparo (min)"), 16);
    assert.equal(valor("Descontos pagos pela loja (R$)"), 32);
    // PDF: impressão do navegador com o documento do fechamento
    await pagina.locator('[data-acao="fech-pdf"]').click();
    await pagina.waitForFunction(() => (window.__impressoes ?? []).length > 0, null, { timeout: 5000 });
    assert.deepEqual(await pagina.evaluate(() => window.__impressoes), ["Fechamento-Operacional_2026-10-27_v1"]);
    await foto(pagina, "d2-fechamento");
    assert.deepEqual(erros, []);
    await ctx.close();
  });

  test("WhatsApp: copiar devolve o texto exato; simular registra UMA vez (noop); nenhuma chamada fora das rotas de simulação", OPC, async () => {
    novoBanco();
    chamadas.length = 0;
    const { ctx, pagina, erros } = await abrir(browser);
    await irPara(pagina, "fechamentos");
    await pagina.locator('[data-ckd-fechamento] button[type="submit"]').click();
    await pagina.locator("[data-ckd-mensagem]").waitFor();
    const msg = await pagina.locator("[data-ckd-mensagem]").innerText();
    await pagina.locator('[data-acao="wa-copiar"]').click();
    await pagina.waitForFunction(() => /Mensagem copiada. Nada foi enviado./.test(document.body.innerText));
    // A área de transferência do Windows normaliza quebras para \r\n; o conteúdo tem de ser o texto ARMAZENADO da prévia.
    const copiado = (await pagina.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
    const previa = await mod.op.previaWhatsapp({ ...mod.sint.TENANT_A1, id: estado.db.fechamentos[0].id, deps: estado.deps });
    assert.equal(copiado, previa.mensagem);
    assert.equal(msg.replace(/\r\n/g, "\n").trim(), previa.mensagem.trim());
    await pagina.locator('[data-acao="wa-simular"]').click();
    await pagina.waitForFunction(() => /Simulação registrada. Nenhuma mensagem foi enviada./.test(document.body.innerText));
    await pagina.locator('[data-acao="wa-simular"]').click();
    await pagina.waitForFunction(() => /já tinha sido simulada para esta versão: nada foi duplicado/.test(document.body.innerText));
    assert.equal(estado.db.simulacoes.length, 1);
    assert.equal(estado.db.simulacoes[0].transporte, "noop");
    assert.ok(chamadas.every((c) => c.startsWith("GET ") || ["POST /api/v1/checklist-operacional/fechamentos"].includes(c) || /\/whatsapp\/simular$/.test(c)), chamadas.join(", "));
    assert.equal(chamadas.filter((c) => /comunicacao|gateway|whatsapp\/enviar/i.test(c)).length, 0);
    assert.deepEqual(erros, []);
    await ctx.close();
  });

  test("perfil só de leitura: vê o fechamento, mas não gera nem simula", OPC, async () => {
    novoBanco();
    await mod.op.gerarFechamento({ ...mod.sint.TENANT_A1, competencia: "2026-10-27", agora: () => new Date(AGORA), deps: estado.deps });
    const { ctx, pagina, erros } = await abrir(browser, { permissoes: ["checklist.visualizar"] });
    await irPara(pagina, "fechamentos");
    await pagina.locator("[data-ckd-mensagem]").waitFor();
    assert.equal(await pagina.locator('[data-ckd-fechamento] button[type="submit"]').count(), 0);
    assert.equal(await pagina.locator('[data-acao="wa-simular"]').count(), 0);
    assert.match(await texto(pagina), /Somente gestores geram ou revisam fechamentos/);
    assert.deepEqual(erros, []);
    await ctx.close();
  });

  test("celular (390 px): nenhuma aba com rolagem horizontal da página; ficha cabe na tela", OPC, async () => {
    novoBanco();
    await mod.op.gerarFechamento({ ...mod.sint.TENANT_A1, competencia: "2026-10-27", agora: () => new Date(AGORA), deps: estado.deps });
    const { ctx, pagina, erros } = await abrir(browser, { viewport: { width: 390, height: 844 } });
    await periodoOntem(pagina);
    for (const aba of ["visao", "pedidos", "ocorrencias", "fechamentos"]) {
      await irPara(pagina, aba);
      await pagina.waitForTimeout(400);
      assert.equal(await semRolagemHorizontal(pagina), true, `rolagem horizontal na aba ${aba}`);
    }
    await irPara(pagina, "pedidos");
    await pagina.waitForFunction(() => document.querySelectorAll('[data-acao="ficha"]').length > 0);
    await pagina.locator('[data-acao="ficha"]').first().click();
    const caixa = await pagina.locator("dialog.ckd-dialogo--ficha").boundingBox();
    assert.ok(caixa && caixa.width <= 390, `ficha com ${caixa?.width}px`);
    await foto(pagina, "d2-celular-ficha");
    assert.deepEqual(erros, []);
    await ctx.close();
  });
});
