// MEDIÇÃO da abertura do Crescer Com Delivery Financeiro em modo plataforma, ANTES × DEPOIS, num Chrome real contra a PLATAFORMA SIMULADA
// (só local, dados sintéticos; ver plataformaSimulada.mjs). Os tempos são deste computador com latência SIMULADA por requisição:
// servem para comparar as duas versões em condições idênticas — NÃO são tempos de produção.
//   FV2_CHROME_EXE=<chrome> FV2_PLAYWRIGHT_PATH=<pasta do playwright> node scripts/fv2/medirAbertura.mjs <pastaFrontendAntes> <pastaFrontendDepois> [rttMs,rttMs] [repeticoes]
import { createRequire } from "node:module";
import { iniciarPlataformaSimulada } from "./plataformaSimulada.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FV2_PLAYWRIGHT_PATH || "playwright");

const [pastaAntes, pastaDepois, rtts = "60,200", reps = "3"] = process.argv.slice(2);
if (!pastaAntes || !pastaDepois) { console.error("uso: medirAbertura.mjs <frontendAntes> <frontendDepois> [rtt,rtt] [repeticoes]"); process.exit(2); }
const RTTS = rtts.split(",").map(Number);
const REPS = Number(reps);
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const mediana = (v) => { const o = [...v].sort((a, b) => a - b); return o[Math.floor(o.length / 2)]; };
const STUB_SUPABASE = "window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'token-simulado'}}})}})};";

// Instrumentação dentro da página: quando a casca pinta, quando o aviso de demonstração está visível e quando a Visão Geral tem dados.
const INSTRUMENTO = () => {
  window.__m = { aviso: [], casca: null, dados: null, h1: null };
  const tick = () => {
    const t = performance.now();
    const b = document.querySelector(".faixa-demo");
    if (b && getComputedStyle(b).display !== "none" && b.offsetHeight > 0) window.__m.aviso.push(t);
    const nav = document.querySelector(".navegacao");
    if (!window.__m.casca && nav && nav.offsetHeight > 0) window.__m.casca = t;
    const h1 = document.querySelector("#conteudo h1");
    if (!window.__m.dados && h1) { window.__m.dados = t; window.__m.h1 = h1.textContent; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

async function abrir(ctx, srv, rotulo) {
  const page = await ctx.newPage();
  await page.addInitScript(INSTRUMENTO);
  const antes = srv.requisicoesDeApi.length;
  const t0 = Date.now();
  await page.goto(`${srv.url}/financeiro-v2/?modo=plataforma`, { waitUntil: "commit" });
  await page.waitForFunction(() => window.__m?.dados, null, { timeout: 60000 });
  const m = await page.evaluate(() => window.__m);
  const aviso = m.aviso.length ? { primeiro: Math.round(m.aviso[0]), ultimo: Math.round(m.aviso.at(-1)) } : null;
  const apiNaAbertura = srv.requisicoesDeApi.slice(antes).length;
  return { page, casca: Math.round(m.casca), dados: Math.round(m.dados), aviso, apiNaAbertura, h1: m.h1, ms: Date.now() - t0, rotulo };
}

async function trocarAba(page, srv, rota, padrao) {
  const antes = srv.requisicoesDeApi.length;
  const t0 = Date.now();
  await page.click(`nav a[data-rota="${rota}"]`);
  await page.waitForFunction((p) => { const h = document.querySelector("#conteudo h1"); return h && new RegExp(p, "i").test(h.textContent) && !document.querySelector("#conteudo [aria-busy=true]"); }, padrao, { timeout: 60000 });
  return { ms: Date.now() - t0, api: srv.requisicoesDeApi.length - antes };
}

async function medir(nome, pasta, rtt) {
  const srv = await iniciarPlataformaSimulada({ pasta });
  const browser = await chromium.launch(process.env.FV2_CHROME_EXE ? { executablePath: process.env.FV2_CHROME_EXE } : {});
  const frias = [];
  const mornas = [];
  const abas = { dre: [], saipos: [], voltaVisao: [] };
  const apis = { abertura: [], abas: [] };
  const avisos = [];
  for (let i = 0; i < REPS; i += 1) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: "pt-BR" });
    await ctx.addInitScript(() => { try { sessionStorage.setItem("cd.contextToken", "contexto-simulado"); } catch { /* sem armazenamento */ } });
    await ctx.route("**/*", async (route) => {
      const u = route.request().url();
      if (u.startsWith(srv.url)) { await espera(rtt); return route.continue(); }
      if (u.includes("cdn.jsdelivr.net")) { await espera(rtt); return route.fulfill({ status: 200, contentType: "text/javascript", body: STUB_SUPABASE }); }
      if (u.includes("fonts.googleapis.com") || u.includes("fonts.gstatic.com")) { await espera(rtt); return route.fulfill({ status: 200, contentType: u.includes("gstatic") ? "font/woff2" : "text/css", body: "" }); }
      return route.abort();
    });
    const a = await abrir(ctx, srv, "fria");
    frias.push(a);
    avisos.push(a.aviso ? a.aviso.ultimo : 0);
    apis.abertura.push(a.apiNaAbertura);
    const antesAbas = srv.requisicoesDeApi.length;
    abas.dre.push((await trocarAba(a.page, srv, "dre", "DRE")).ms);
    abas.saipos.push((await trocarAba(a.page, srv, "saipos", "SAIPOS")).ms);
    const volta = await trocarAba(a.page, srv, "visao-geral", "Vis");
    abas.voltaVisao.push(volta.ms);
    apis.abas.push(srv.requisicoesDeApi.length - antesAbas);
    await a.page.close();
    const b = await abrir(ctx, srv, "morna"); // mesmo navegador: arquivos já em cache (com revalidação)
    mornas.push(b);
    await b.page.close();
    await ctx.close();
  }
  await browser.close();
  await srv.fechar();
  const k = (lista, campo) => mediana(lista.map((x) => x[campo]));
  return {
    nome, rtt,
    primeiraAbertura: { casca: k(frias, "casca"), dadosVisiveis: k(frias, "dados"), avisoDemoVisivelAte: mediana(avisos), apiNaAbertura: mediana(apis.abertura) },
    reabertura: { casca: k(mornas, "casca"), dadosVisiveis: k(mornas, "dados") },
    trocaDeAba: { dre: mediana(abas.dre), saipos: mediana(abas.saipos), voltarParaVisaoGeral: mediana(abas.voltaVisao), requisicoesDeApiNas3Trocas: mediana(apis.abas) },
  };
}

const saida = [];
for (const rtt of RTTS) {
  for (const [nome, pasta] of [["ANTES", pastaAntes], ["DEPOIS", pastaDepois]]) {
    const r = await medir(nome, pasta, rtt);
    saida.push(r);
    console.log(JSON.stringify(r));
  }
}
console.log("\n=== resumo (mediana de", REPS, "execuções; ms) ===");
console.log("RTT simulado | versão  | casca pinta | dados visíveis (1ª) | aviso demo visível até | reabertura dados | DRE | SAIPOS | voltar Visão Geral | API nas 3 trocas");
for (const r of saida) console.log(`${String(r.rtt).padStart(5)} ms     | ${r.nome.padEnd(6)} | ${String(r.primeiraAbertura.casca).padStart(11)} | ${String(r.primeiraAbertura.dadosVisiveis).padStart(19)} | ${String(r.primeiraAbertura.avisoDemoVisivelAte).padStart(22)} | ${String(r.reabertura.dadosVisiveis).padStart(16)} | ${String(r.trocaDeAba.dre).padStart(3)} | ${String(r.trocaDeAba.saipos).padStart(6)} | ${String(r.trocaDeAba.voltarParaVisaoGeral).padStart(18)} | ${r.trocaDeAba.requisicoesDeApiNas3Trocas}`);
