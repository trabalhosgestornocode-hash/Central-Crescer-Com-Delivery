// MEDIÇÃO da entrada no Crescer Com Delivery Financeiro (modo plataforma) num Chrome real contra a PLATAFORMA SIMULADA
// (só local, dados SINTÉTICOS, 127.0.0.1). Compara duas pastas `frontend` (antes × depois) em condições idênticas e,
// por unidade (Açaí = SAIPOS; Subway = SWF), mede:
//   FCP, tempo até o menu definitivo, tempo até o 1º conteúdo útil (<h1>), CLS, long tasks, requisições à API (e duplicadas),
//   bytes de JS/CSS e — numa passada de CORREÇÃO separada — se SAIPOS/Anota Aí chegaram a aparecer na Subway.
// Os tempos são DESTE computador com latência SIMULADA por requisição: servem para comparar versões, não são tempos de produção.
//   FV2_PLAYWRIGHT_PATH=<playwright-core> node scripts/fv2/medirRepaginacao.mjs <frontendAntes> <frontendDepois> [rtt,rtt] [repeticoes] [saida.json]
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { iniciarPlataformaSimulada } from "./plataformaSimulada.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FV2_PLAYWRIGHT_PATH || "playwright-core");
const aqui = dirname(fileURLToPath(import.meta.url));

const [pastaAntes, pastaDepois, rtts = "60,200", reps = "5", arquivoSaida] = process.argv.slice(2);
if (!pastaAntes || !pastaDepois) { console.error("uso: medirRepaginacao.mjs <frontendAntes> <frontendDepois> [rtt,rtt] [repeticoes] [saida.json]"); process.exit(2); }
const RTTS = rtts.split(",").map(Number);
const REPS = Number(reps);
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const mediana = (v) => { const o = [...v].sort((a, b) => a - b); return o.length ? o[Math.floor(o.length / 2)] : null; };
const STUB_SUPABASE = "window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'token-simulado'}}}),refreshSession:async()=>({data:{session:{access_token:'token-simulado'}},error:null})}})};";

const UNIDADES = {
  acai: { indice: 0, preparar: null, rotulo: "Açaí (SAIPOS)" },
  subway: { indice: 1, preparar: (await import(pathToFileURL(join(aqui, "cenarioSubway.mjs")))).default, rotulo: "Subway (SWF)" },
};

/** Dentro da página: métricas de desempenho + vigia visual (o que aparece, quando). */
const INSTRUMENTO = (vigiar) => {
  window.__m = { cls: 0, longTasks: [], fcp: null, menu: null, conteudo: null, h1: null, vazou: { saipos: null, saiposUltimo: null, anota: null }, telas: [] };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__m.cls += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch { /* sem suporte */ }
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__m.longTasks.push(e.duration); }).observe({ type: "longtask", buffered: true }); } catch { /* sem suporte */ }
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === "first-contentful-paint") window.__m.fcp = e.startTime; }).observe({ type: "paint", buffered: true }); } catch { /* sem suporte */ }
  const visivel = (el) => !!el && el.getClientRects().length > 0;
  const tick = () => {
    const t = performance.now();
    const nav = document.querySelector(".navegacao");
    // "menu definitivo" = menu visível E a configuração de fontes da unidade já respondida (é ela que decide os itens).
    const fontesOk = performance.getEntriesByType("resource").some((e) => /fontes-faturamento/.test(e.name) && e.responseEnd > 0);
    if (!window.__m.menu && visivel(nav) && fontesOk) window.__m.menu = t;
    const h1 = document.querySelector("#conteudo h1");
    if (!window.__m.conteudo && h1) { window.__m.conteudo = t; window.__m.h1 = h1.textContent; window.__m.bytesInicial = performance.getEntriesByType("resource").filter((e) => /\.(js|css)(\?|$)/.test(e.name) && e.name.includes("127.0.0.1")).reduce((a, e) => a + (e.decodedBodySize || 0), 0).toString(); }
    if (vigiar) {
      const texto = document.body.innerText;
      if (/SAIPOS/.test(texto)) { if (window.__m.vazou.saipos === null) window.__m.vazou.saipos = t; window.__m.vazou.saiposUltimo = t; }
      if (window.__m.vazou.anota === null && /Anota A[ií]/i.test(texto)) window.__m.vazou.anota = t;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

async function abrir(browser, srv, rtt, { vigiar = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: "pt-BR" });
  await ctx.addInitScript(() => { try { sessionStorage.setItem("cd.contextToken", "contexto-simulado"); } catch { /* sem armazenamento */ } });
  let bytesJsCss = 0;
  const idas = new Map();
  await ctx.route("**/*", async (route) => {
    const u = route.request().url();
    if (u.startsWith(srv.url)) {
      await espera(rtt);
      if (/\/api\/v1\//.test(u)) idas.set(u, (idas.get(u) ?? 0) + 1);
      return route.continue();
    }
    if (u.includes("cdn.jsdelivr.net")) { await espera(rtt); return route.fulfill({ status: 200, contentType: "text/javascript", body: STUB_SUPABASE }); }
    if (u.includes("fonts.googleapis.com") || u.includes("fonts.gstatic.com")) { await espera(rtt); return route.fulfill({ status: 200, contentType: u.includes("gstatic") ? "font/woff2" : "text/css", body: "" }); }
    return route.abort();
  });
  const page = await ctx.newPage();
  await page.addInitScript(INSTRUMENTO, vigiar);
  const t0 = Date.now();
  await page.goto(`${srv.url}/financeiro-v2/?modo=plataforma`, { waitUntil: "commit" });
  await page.waitForFunction(() => window.__m?.conteudo, null, { timeout: 60000 });
  await espera(400); // deixa o CLS e as consultas tardias assentarem
  const m = await page.evaluate(() => ({ ...window.__m, bytes: performance.getEntriesByType("resource").filter((e) => /\.(js|css)(\?|$)/.test(e.name) && e.name.includes("127.0.0.1")).reduce((a, e) => a + (e.decodedBodySize || 0), 0) }));
  bytesJsCss = Number(m.bytesInicial ?? m.bytes); // até o 1º conteúdo útil (o resto das telas é aquecido depois, em tempo ocioso)
  const duplicadas = [...idas.values()].filter((n) => n > 1).reduce((a, n) => a + n - 1, 0);
  const total = [...idas.values()].reduce((a, n) => a + n, 0);
  await ctx.close();
  return { ...m, ms: Date.now() - t0, apiTotal: total, apiDuplicadas: duplicadas, bytesJsCss };
}

async function medir(versao, pasta, chave, rtt) {
  const u = UNIDADES[chave];
  const srv = await iniciarPlataformaSimulada({ pasta, preparar: u.preparar, unidadeIndice: u.indice });
  const browser = await chromium.launch(process.env.FV2_CHROME_EXE ? { executablePath: process.env.FV2_CHROME_EXE } : {});
  const lista = [];
  for (let i = 0; i < REPS; i += 1) lista.push(await abrir(browser, srv, rtt));
  const vazamento = await abrir(browser, srv, rtt, { vigiar: true }); // passada de correção (o vigia pesa na medida, por isso é separada)
  await browser.close();
  await srv.fechar();
  const k = (c) => mediana(lista.map((x) => x[c]).filter((v) => v !== null));
  return {
    versao, unidade: u.rotulo, rtt,
    fcp: Math.round(k("fcp")), menuDefinitivo: Math.round(k("menu")), conteudoUtil: Math.round(k("conteudo")),
    cls: Number(mediana(lista.map((x) => x.cls)).toFixed(4)),
    longTasks: mediana(lista.map((x) => x.longTasks.length)), longTasksMs: Math.round(mediana(lista.map((x) => x.longTasks.reduce((a, b) => a + b, 0)))),
    apiTotal: mediana(lista.map((x) => x.apiTotal)), apiDuplicadas: mediana(lista.map((x) => x.apiDuplicadas)), kbJsCss: Math.round(mediana(lista.map((x) => x.bytesJsCss)) / 1024),
    apareceuSaipos: vazamento.vazou.saipos !== null, saiposVisivelAte: vazamento.vazou.saiposUltimo === null ? null : Math.round(vazamento.vazou.saiposUltimo), apareceuAnota: vazamento.vazou.anota !== null,
  };
}

const saida = [];
for (const rtt of RTTS) for (const chave of Object.keys(UNIDADES)) for (const [versao, pasta] of [["ANTES", pastaAntes], ["DEPOIS", pastaDepois]]) {
  const r = await medir(versao, pasta, chave, rtt);
  saida.push(r);
  console.log(JSON.stringify(r));
}
if (arquivoSaida) writeFileSync(arquivoSaida, JSON.stringify(saida, null, 2));
console.log("\nunidade | RTT | versão | FCP | menu definitivo | conteúdo útil | CLS | long tasks (n/ms) | API (dup) | KB js+css | SAIPOS? | Anota?");
for (const r of saida) console.log(`${r.unidade} | ${r.rtt} | ${r.versao} | ${r.fcp} | ${r.menuDefinitivo} | ${r.conteudoUtil} | ${r.cls} | ${r.longTasks}/${r.longTasksMs} | ${r.apiTotal} (${r.apiDuplicadas}) | ${r.kbJsCss} | ${r.apareceuSaipos ? "SIM" : "não"} | ${r.apareceuAnota ? "SIM" : "não"}`);
