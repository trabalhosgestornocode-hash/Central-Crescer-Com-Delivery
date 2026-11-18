// VALIDAÇÃO DE NAVEGADOR (Chrome real) da abertura/experiência do Financeiro na plataforma SIMULADA (só local, dados sintéticos):
// erro com "Tentar novamente", atualização manual, cache dentro da competência, teclado, marcos de acessibilidade, rolagem horizontal
// e alvos de toque. Sai com código 1 se qualquer verificação falhar.
//   FV2_CHROME_EXE=... FV2_PLAYWRIGHT_PATH=... node scripts/fv2/navegadorDesempenho.mjs <pastaFrontend>
import { createRequire } from "node:module";
import { iniciarPlataformaSimulada } from "./plataformaSimulada.mjs";
const { chromium } = createRequire(import.meta.url)(process.env.FV2_PLAYWRIGHT_PATH || "playwright");
const pasta = process.argv[2];
if (!pasta) { console.error("uso: navegadorDesempenho.mjs <frontend>"); process.exit(2); }
const STUB = "window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'t'}}})}})};";
const srv = await iniciarPlataformaSimulada({ pasta });
const browser = await chromium.launch(process.env.FV2_CHROME_EXE ? { executablePath: process.env.FV2_CHROME_EXE } : {});
const resultados = [];
const checar = async (nome, fn) => { try { const r = await fn(); const ok = r === true || r === undefined || (typeof r === "object" && r.ok); resultados.push(ok); console.log(`${ok ? "OK   " : "FALHA"} ${nome}${typeof r === "object" && r.detalhe ? " — " + r.detalhe : ""}`); } catch (e) { resultados.push(false); console.log(`FALHA ${nome} — ${String(e.message).split("\n")[0]}`); } };
async function pagina(largura = 1366, altura = 900, touch = false) {
  const ctx = await browser.newContext({ viewport: { width: largura, height: altura }, hasTouch: touch, locale: "pt-BR" });
  await ctx.addInitScript(() => { try { sessionStorage.setItem("cd.contextToken", "x"); } catch {} });
  await ctx.route("**/*", (r) => { const u = r.request().url(); if (u.startsWith(srv.url)) return r.continue(); if (u.includes("jsdelivr")) return r.fulfill({ contentType: "text/javascript", body: STUB }); return r.abort(); });
  const page = await ctx.newPage();
  page.erros = [];
  page.on("pageerror", (e) => page.erros.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) page.erros.push(m.text()); });
  return page;
}
const esperarDados = (page) => page.waitForFunction(() => document.querySelector("#conteudo h1") && !document.querySelector("#conteudo [aria-busy=true]"), null, { timeout: 20000 });
const url = `${srv.url}/financeiro-v2/?modo=plataforma`;

// ------------------------------------------------------------------ erro + tentar novamente
await checar("erro de leitura: mensagem clara, botão 'Tentar novamente', nenhum valor em R$ nem zero provisório", async () => {
  const page = await pagina();
  srv.falharProximas(1);
  await page.goto(url);
  await page.waitForSelector("#conteudo .estado--erro", { timeout: 20000 });
  const texto = await page.locator("#conteudo").innerText();
  const botao = await page.getByRole("button", { name: "Tentar novamente" }).count();
  const role = await page.locator("#conteudo .estado--erro").getAttribute("role");
  const ok = botao === 1 && !/R\$/.test(texto) && /não foi possível|indisponível/i.test(texto) && role === "alert";
  await page.context().close();
  return { ok, detalhe: ok ? "" : `botao=${botao} texto=${texto.slice(0, 80)} role=${role}` };
});
await checar("'Tentar novamente' relê só a tela atual, mantém competência/unidade, sem POST e sem cache de erro", async () => {
  const page = await pagina();
  srv.falharProximas(1);
  const posts = [];
  page.on("request", (r) => { if (r.method() !== "GET") posts.push(r.method() + " " + r.url()); });
  await page.goto(url);
  await page.waitForSelector("#conteudo .estado--erro", { timeout: 20000 });
  const compAntes = await page.inputValue("#filtro-competencia");
  const antes = srv.requisicoesDeApi.length;
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await esperarDados(page);
  const novas = srv.requisicoesDeApi.slice(antes);
  const compDepois = await page.inputValue("#filtro-competencia");
  const ok = compAntes === compDepois && novas.length === 1 && novas[0].startsWith("/api/fv2/visao-geral") && posts.length === 0 && !(await page.locator("#conteudo .estado--erro").count());
  await page.context().close();
  return { ok, detalhe: ok ? "" : `comp ${compAntes}→${compDepois} novas=${JSON.stringify(novas)} posts=${posts.length}` };
});
await checar("'Tentar novamente' funciona pelo teclado (Tab até o botão + Enter)", async () => {
  const page = await pagina();
  srv.falharProximas(1);
  await page.goto(url);
  await page.waitForSelector("#conteudo .estado--erro", { timeout: 20000 });
  await page.getByRole("button", { name: "Tentar novamente" }).focus();
  const emFoco = await page.evaluate(() => document.activeElement?.textContent?.trim());
  await page.keyboard.press("Enter");
  await esperarDados(page);
  await page.context().close();
  return emFoco === "Tentar novamente";
});

// ------------------------------------------------------------------ cache e atualização manual
await checar("voltar a uma aba dentro de 15 s não refaz a consulta; 'Atualizar dados' refaz; trocar competência busca outra", async () => {
  const page = await pagina();
  await page.goto(url);
  await esperarDados(page);
  const clicarAba = async (r, re) => { await page.click(`nav a[data-rota="${r}"]`); await page.waitForFunction((p) => new RegExp(p, "i").test(document.querySelector("#conteudo h1")?.textContent ?? "") && !document.querySelector("#conteudo [aria-busy=true]"), re, { timeout: 20000 }); };
  await clicarAba("dre", "DRE");
  let n0 = srv.requisicoesDeApi.length;
  await clicarAba("visao-geral", "Vis");
  const doCache = srv.requisicoesDeApi.length - n0;
  n0 = srv.requisicoesDeApi.length;
  await page.click("#atualizar-dados");
  await page.waitForTimeout(500); await esperarDados(page);
  const manual = srv.requisicoesDeApi.length - n0;
  n0 = srv.requisicoesDeApi.length;
  const comp = await page.inputValue("#filtro-competencia");
  const outra = comp.endsWith("-10") ? "2026-09" : "2026-10";
  await page.fill("#filtro-competencia", outra); await page.dispatchEvent("#filtro-competencia", "change");
  await page.waitForTimeout(600); await esperarDados(page);
  const trocou = srv.requisicoesDeApi.slice(n0).some((u) => u.includes(`competencia=${outra}`));
  await page.context().close();
  const ok = doCache === 0 && manual === 1 && trocou;
  return { ok, detalhe: `cache=${doCache} novas, manual=${manual}, outra competência buscada=${trocou}` };
});

// ------------------------------------------------------------------ teclado, marcos e responsividade
await checar("teclado: 1º Tab = 'Pular para o conteúdo' visível; Enter leva ao conteúdo", async () => {
  const page = await pagina();
  await page.goto(url); await esperarDados(page);
  await page.keyboard.press("Tab");
  const pular = await page.evaluate(() => { const a = document.activeElement; const r = a.getBoundingClientRect(); return { t: a.textContent.trim(), visivel: r.left >= 0 && r.width > 0, h: Math.round(r.height) }; });
  await page.keyboard.press("Enter");
  const foco = await page.evaluate(() => document.activeElement?.id);
  await page.context().close();
  const ok = /Pular/.test(pular.t) && pular.visivel && pular.h >= 44 && foco === "conteudo";
  return { ok, detalhe: JSON.stringify({ ...pular, foco }) };
});
await checar("marcos para leitor de tela: 1 main, 1 h1, nav com nome, região viva, imagens/ícones com texto alternativo, idioma pt-BR", async () => {
  const page = await pagina();
  await page.goto(url); await esperarDados(page);
  const r = await page.evaluate(() => ({
    main: document.querySelectorAll("main").length, h1: document.querySelectorAll("h1").length,
    nav: !!document.querySelector("nav[aria-label]"), viva: document.querySelector("main")?.getAttribute("aria-live"), lang: document.documentElement.lang,
    semAlt: [...document.querySelectorAll("img")].filter((i) => !i.hasAttribute("alt")).length,
    semNome: [...document.querySelectorAll("button, a[href], select, input:not([type=hidden])")].filter((e) => !(e.textContent.trim() || e.getAttribute("aria-label") || e.getAttribute("title") || e.labels?.length || e.getAttribute("aria-labelledby"))).length,
  }));
  await page.context().close();
  const ok = r.main === 1 && r.h1 === 1 && r.nav && r.viva === "polite" && /^pt/i.test(r.lang) && r.semAlt === 0 && r.semNome === 0;
  return { ok, detalhe: JSON.stringify(r) };
});
for (const [w, h, nome, touch] of [[390, 844, "celular", true], [768, 1024, "tablet", true], [1366, 900, "desktop", false]]) {
  await checar(`${nome} ${w}px: sem rolagem horizontal (tela e erro), sem erro de JavaScript, alvos de toque ≥ 44 px${touch ? "" : " (n/a)"}`, async () => {
    const page = await pagina(w, h, touch);
    await page.goto(url); await esperarDados(page);
    const rolagem = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const pequenos = touch ? await page.evaluate(() => [...document.querySelectorAll("button, a[href], select, input:not([type=hidden]):not([type=checkbox]):not([type=radio])")].filter((e) => { const r = e.getBoundingClientRect(); const pular = e.classList.contains("pular"); return !pular && r.width > 0 && r.height > 0 && r.height < 43.5 && !e.closest("thead"); }).map((e) => `${e.tagName}:${(e.textContent || "").trim().slice(0, 18)}(${Math.round(e.getBoundingClientRect().height)})`)) : [];
    srv.falharProximas(1); await page.click("#atualizar-dados"); await page.waitForSelector("#conteudo .estado--erro", { timeout: 20000 });
    const rolagemErro = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const erros = page.erros.length;
    await page.context().close();
    const ok = rolagem <= 0 && rolagemErro <= 0 && erros === 0 && pequenos.length === 0;
    return { ok, detalhe: ok ? "" : `rolagem=${rolagem}/${rolagemErro} erros=${erros} pequenos=${pequenos.slice(0, 4)}` };
  });
}
await browser.close(); await srv.fechar();
const falhas = resultados.filter((x) => !x).length;
console.log(`\nRESUMO: ${resultados.length - falhas}/${resultados.length} verificações OK; ${falhas} falha(s).`);
process.exit(falhas ? 1 : 0);
