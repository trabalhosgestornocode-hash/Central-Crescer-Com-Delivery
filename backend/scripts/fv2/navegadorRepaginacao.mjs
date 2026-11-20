// VERIFICAÇÃO NO NAVEGADOR (Chrome real) da entrada e da navegação do Crescer Com Delivery Financeiro, contra a PLATAFORMA SIMULADA
// (só local, dados SINTÉTICOS, 127.0.0.1). Cobre: etapas da entrada, fontes por unidade (Subway sem SAIPOS/Anota Aí em NENHUMA tela),
// sessão expirada (e que os botões continuam funcionando), falha de API com recuperação, troca de competência, viewports e rolagem horizontal.
//   FV2_PLAYWRIGHT_PATH=<playwright-core> [FV2_CHROME_EXE=<chrome>] [FV2_CAPTURAS=<pasta>] node scripts/fv2/navegadorRepaginacao.mjs <pastaFrontend>
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { iniciarPlataformaSimulada } from "./plataformaSimulada.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FV2_PLAYWRIGHT_PATH || "playwright-core");
const aqui = dirname(fileURLToPath(import.meta.url));
const pasta = process.argv[2];
if (!pasta) { console.error("uso: navegadorRepaginacao.mjs <pastaFrontend>"); process.exit(2); }
const capturas = process.env.FV2_CAPTURAS;
if (capturas) mkdirSync(capturas, { recursive: true });
const cenarioSubway = (await import(pathToFileURL(join(aqui, "cenarioSubway.mjs")))).default;
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const STUB_SUPABASE = "window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'token-simulado'}}}),refreshSession:async()=>({data:{session:{access_token:'token-simulado'}},error:null})}})};";
const ROTAS = ["visao-geral", "dre", "saipos", "swf", "ifood", "noventa-e-nove-food", "operadoras-taxas", "lancamentos", "contas-a-pagar", "calendario", "contas-a-receber", "caixa-e-bancos", "fluxo-de-caixa", "vendas-e-recebimentos", "entregadores-proprios", "conferencias", "configuracoes", "documentos"];
const VIEWPORTS = { desktop: [1920, 1080], notebook: [1366, 768], tablet: [820, 1180], mobile: [390, 844] };

const resultados = [];
const registrar = (grupo, nome, ok, detalhe = "") => { resultados.push({ grupo, nome, ok: Boolean(ok), detalhe }); console.log(`${ok ? "OK   " : "FALHA"} [${grupo}] ${nome}${detalhe ? " — " + detalhe : ""}`); };

async function novaPagina(browser, srv, { viewport = VIEWPORTS.notebook, rtt = 30, hash = "#/visao-geral" } = {}) {
  const ctx = await browser.newContext({ viewport: { width: viewport[0], height: viewport[1] }, locale: "pt-BR" });
  await ctx.addInitScript(() => { try { sessionStorage.setItem("cd.contextToken", "contexto-simulado"); } catch { /* sem armazenamento */ } });
  await ctx.route("**/*", async (route) => {
    const u = route.request().url();
    if (u.startsWith(srv.url)) { await espera(rtt); return route.continue(); }
    if (u.includes("cdn.jsdelivr.net")) return route.fulfill({ status: 200, contentType: "text/javascript", body: STUB_SUPABASE });
    if (u.includes("fonts.googleapis.com") || u.includes("fonts.gstatic.com")) return route.fulfill({ status: 200, contentType: u.includes("gstatic") ? "font/woff2" : "text/css", body: "" });
    return route.abort();
  });
  const page = await ctx.newPage();
  const erros = [];
  page.on("pageerror", (e) => erros.push(String(e.message ?? e)));
  await page.goto(`${srv.url}/financeiro-v2/?modo=plataforma${hash}`, { waitUntil: "commit" });
  return { ctx, page, erros };
}
const pronto = (page, t = 20000) => page.waitForFunction(() => document.documentElement.dataset.boot === "pronto" && document.documentElement.dataset.dados === "disponivel" && !document.querySelector("#conteudo [aria-busy=true]"), null, { timeout: t });
const textoVisivel = (page) => page.evaluate(() => document.body.innerText);
const foto = async (page, nome) => { if (capturas) await page.screenshot({ path: join(capturas, `${nome}.png`), fullPage: false }); };

const browser = await chromium.launch(process.env.FV2_CHROME_EXE ? { executablePath: process.env.FV2_CHROME_EXE } : {});

// ---------------------------------------------------------------- 1) Subway: nenhuma tela mostra SAIPOS nem Anota Aí; menu certo desde a primeira pintura útil
{
  const srv = await iniciarPlataformaSimulada({ pasta, preparar: cenarioSubway, unidadeIndice: 1, atrasoPorRota: { "fontes-faturamento": 700, "visao-geral": 900 } });
  const { ctx, page, erros } = await novaPagina(browser, srv);
  // fotos da entrada em câmera lenta (API lenta): esqueleto → conteúdo
  await espera(350);
  await foto(page, "subway-1-carregando-inicio");
  const durante = await page.evaluate(() => ({ boot: document.documentElement.dataset.boot, navItens: [...document.querySelectorAll(".nav-grupos a")].filter((a) => a.offsetParent).map((a) => a.textContent), temEsqueleto: !!document.querySelector(".nav-esqueleto") && getComputedStyle(document.querySelector(".nav-esqueleto")).display !== "none" }));
  registrar("entrada", "durante o carregamento só há esqueleto de menu (nenhum item de unidade)", durante.navItens.length === 0 && durante.temEsqueleto, JSON.stringify(durante));
  await pronto(page);
  await foto(page, "subway-2-visao-geral");
  const nav = await page.evaluate(() => [...document.querySelectorAll(".nav-grupos a")].filter((a) => a.offsetParent).map((a) => a.textContent));
  registrar("fontes", "menu da Subway: SWF, iFood e 99Food (sem SAIPOS)", nav.includes("SWF") && nav.includes("iFood") && nav.includes("99Food") && !nav.includes("SAIPOS"), nav.join(", "));
  const cab = await page.evaluate(() => ({ unidade: document.querySelector("#topo-unidade")?.textContent, fontes: document.querySelector("#topo-fontes")?.textContent, links: [...document.querySelectorAll(".topo-links a")].filter((a) => a.offsetParent).map((a) => [a.textContent, a.getAttribute("href")]) }));
  registrar("cabecalho", "cabeçalho mostra unidade, fontes e links da plataforma", Boolean(cab.unidade) && !/Sessão encerrada/.test(cab.unidade) && /SWF/.test(cab.fontes) && cab.links.length === 2, JSON.stringify(cab));
  for (const rota of ROTAS) {
    if (rota === "saipos") continue; // a rota SAIPOS não existe para a Subway: o app leva para o SWF (verificado abaixo)
    await page.evaluate((r) => { location.hash = `#/${r}`; }, rota);
    await espera(120);
    try { await pronto(page, 15000); } catch { /* a tela pode terminar em estado de erro de permissão; o texto é verificado do mesmo jeito */ }
    const txt = await textoVisivel(page);
    registrar("fontes", `rota ${rota}: sem "SAIPOS" e sem "Anota Aí"`, !/SAIPOS/.test(txt) && !/Anota A[ií]/i.test(txt), (txt.match(/.{0,30}(SAIPOS|Anota A[ií]).{0,30}/i) ?? [""])[0].replace(/\s+/g, " "));
    if (rota === "swf") await foto(page, "subway-3-swf");
  }
  await page.evaluate(() => { location.hash = "#/saipos"; });
  await espera(1500);
  registrar("fontes", "abrir #/saipos na Subway leva ao SWF", (await page.evaluate(() => location.hash)) === "#/swf");
  registrar("erros", "nenhum erro de JavaScript na Subway", erros.length === 0, erros.join(" | "));
  await ctx.close();
  await srv.fechar();
}

// ---------------------------------------------------------------- 2) Açaí: SAIPOS e Anota Aí preservados
{
  const srv = await iniciarPlataformaSimulada({ pasta, unidadeIndice: 0 });
  const { ctx, page, erros } = await novaPagina(browser, srv);
  await pronto(page);
  await foto(page, "acai-1-visao-geral");
  const nav = await page.evaluate(() => [...document.querySelectorAll(".nav-grupos a")].filter((a) => a.offsetParent).map((a) => a.textContent));
  registrar("fontes", "menu do Açaí: SAIPOS, iFood e 99Food (sem SWF)", nav.includes("SAIPOS") && nav.includes("iFood") && nav.includes("99Food") && !nav.includes("SWF"), nav.join(", "));
  const txt = await textoVisivel(page);
  registrar("fontes", "Visão Geral do Açaí mantém o canal Anota Aí e SAIPOS", /Anota A[ií]/.test(txt) && /SAIPOS/.test(txt));
  await page.evaluate(() => { location.hash = "#/saipos"; });
  await espera(300); await pronto(page);
  await foto(page, "acai-2-saipos");
  registrar("erros", "nenhum erro de JavaScript no Açaí", erros.length === 0, erros.join(" | "));
  // troca de competência: nada da competência anterior fica na tela enquanto a nova carrega
  await page.evaluate(() => { location.hash = "#/visao-geral"; });
  await pronto(page);
  const antes = await page.evaluate(() => document.querySelector("#conteudo h1")?.textContent);
  await page.fill("#filtro-competencia", "2026-10");
  await page.dispatchEvent("#filtro-competencia", "change");
  const durante = await page.evaluate(() => ({ busy: !!document.querySelector("#conteudo [aria-busy=true]"), h1: document.querySelector("#conteudo h1")?.textContent ?? null }));
  registrar("competencia", "ao trocar a competência a tela antiga some na hora (esqueleto)", durante.busy && durante.h1 === null, JSON.stringify({ antes, durante }));
  await pronto(page);
  const depois = await page.evaluate(() => document.querySelector("#conteudo").innerText);
  registrar("competencia", "nova competência carregada (outubro de 2026 na tela)", /outubro de 2026/i.test(depois ?? ""), (depois.match(/.{0,20}outubro.{0,20}/i) ?? [""])[0]);
  // falha de API → erro com recuperação, sem recarregar a página
  srv.falharProximas(1);
  await page.click("#atualizar-dados");
  await page.waitForSelector("#conteudo .estado--erro", { timeout: 10000 });
  await foto(page, "acai-3-erro-api");
  registrar("erro", "falha de API mostra erro com 'Tentar novamente' e o menu continua", await page.evaluate(() => !!document.querySelector("[data-tentar-novamente]") && document.documentElement.dataset.boot === "pronto"));
  await page.click("[data-tentar-novamente]");
  await pronto(page);
  registrar("erro", "recuperação sem recarregar a página", true);
  // sessão expirada
  srv.expirarSessao(true);
  await page.click("#atualizar-dados");
  await page.waitForFunction(() => document.documentElement.dataset.boot === "sessao-expirada", null, { timeout: 10000 });
  await foto(page, "acai-4-sessao-expirada");
  const exp = await page.evaluate(() => ({
    texto: document.querySelector("#conteudo").innerText, links: [...document.querySelectorAll("#conteudo .estado-acoes a")].map((a) => [a.textContent, a.getAttribute("href")]),
    topoLinks: [...document.querySelectorAll(".topo-links a")].filter((a) => a.offsetParent).map((a) => a.getAttribute("href")),
    dinheiro: /R\$\s?\d/.test(document.querySelector("#conteudo").innerText), navVisivel: [...document.querySelectorAll(".nav-grupos a")].some((a) => a.offsetParent),
    unidade: document.querySelector("#topo-unidade").textContent,
  }));
  registrar("sessao", "mensagem clara de sessão expirada", /Sua sessão expirou/.test(exp.texto), exp.texto.slice(0, 120).replace(/\s+/g, " "));
  registrar("sessao", "ação 'Entrar novamente' e links da plataforma funcionam", exp.links.some(([t, h]) => t === "Entrar novamente" && h === "/?setor=financeiro") && exp.links.length === 3 && exp.topoLinks.includes("/?setor=escolher") && exp.topoLinks.includes("/?setor=operacional"), JSON.stringify(exp.links));
  registrar("sessao", "nenhum dado financeiro antigo fica na tela e o menu some", !exp.dinheiro && !exp.navVisivel, `dinheiro=${exp.dinheiro} nav=${exp.navVisivel}`);
  registrar("sessao", "nome da unidade é limpo", /Sessão encerrada/.test(exp.unidade), exp.unidade);
  const reqs = srv.respostas401();
  registrar("sessao", "sem laço de renovação: 1 consulta = no máximo 2 tentativas (1 + 1 após renovar)", reqs > 0 && reqs <= 6, `${reqs} respostas 401 no total`);
  // links continuam funcionando com a sessão vencida (navegação real)
  const href = await page.getAttribute("#link-plataforma", "href");
  registrar("sessao", "link 'Voltar à plataforma' usa a rota oficial", href === "/?setor=escolher", href);
  // o carregamento de outra rota com a sessão vencida não fica preso em loading
  await page.evaluate(() => { location.hash = "#/dre"; });
  await page.waitForFunction(() => document.documentElement.dataset.boot === "sessao-expirada" && !document.querySelector("#conteudo [aria-busy=true]"), null, { timeout: 10000 });
  registrar("sessao", "navegar com a sessão vencida não prende em 'carregando'", true);
  // sessão volta (login em outra aba): "Tentar novamente"/Atualizar reabre normalmente
  srv.expirarSessao(false);
  await page.click("#atualizar-dados");
  await pronto(page);
  registrar("sessao", "com a sessão restabelecida, a tela volta sem recarregar a página", true);
  await ctx.close();
  await srv.fechar();
}

// ---------------------------------------------------------------- 3) Responsivo: sem rolagem horizontal; teclado
for (const [nome, vp] of Object.entries(VIEWPORTS)) {
  const srv = await iniciarPlataformaSimulada({ pasta, preparar: cenarioSubway, unidadeIndice: 1 });
  const { ctx, page } = await novaPagina(browser, srv, { viewport: vp });
  await pronto(page);
  await foto(page, `subway-${nome}-visao-geral`);
  for (const rota of ["visao-geral", "dre", "swf", "contas-a-pagar", "calendario", "caixa-e-bancos", "configuracoes"]) {
    await page.evaluate((r) => { location.hash = `#/${r}`; }, rota);
    await espera(150);
    try { await pronto(page, 15000); } catch { /* segue para a medição */ }
    const m = await page.evaluate(() => ({ larg: document.documentElement.scrollWidth, janela: window.innerWidth }));
    registrar("responsivo", `${nome} ${vp[0]}px ${rota}: sem rolagem horizontal da página`, m.larg <= m.janela + 1, `${m.larg}/${m.janela}`);
  }
  if (nome === "desktop" || nome === "mobile") {
    await page.keyboard.press("Tab");
    const primeiro = await page.evaluate(() => document.activeElement?.className);
    registrar("teclado", `${nome}: primeiro Tab vai ao 'Pular para o conteúdo'`, /pular/.test(primeiro ?? ""), primeiro);
    // menu recolhível
    await page.click("#nav-alternar");
    const rec = await page.evaluate(() => ({ nav: document.documentElement.dataset.nav, exp: document.querySelector("#nav-alternar").getAttribute("aria-expanded"), vis: getComputedStyle(document.querySelector("#navegacao")).display !== "none" }));
    registrar("menu", `${nome}: menu recolhe e reabre (aria-expanded)`, rec.nav === "recolhida" && rec.exp === "false" && !rec.vis);
    await foto(page, `subway-${nome}-menu-recolhido`);
    await page.click("#nav-alternar");
  }
  await ctx.close();
  await srv.fechar();
}
await browser.close();
const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações no navegador`);
if (capturas) writeFileSync(join(capturas, "resultado-navegador.json"), JSON.stringify(resultados, null, 2));
process.exit(falhas.length ? 1 : 0);
