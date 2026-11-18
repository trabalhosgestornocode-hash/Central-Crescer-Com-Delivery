// AUDITORIA DE RESPONSIVIDADE (só local, plataforma simulada, dados sintéticos): abre cada tela em 3 larguras e aponta
// rolagem horizontal da página, alvos de toque pequenos (< 40 px de altura) e elementos que vazam a largura da janela.
//   FV2_CHROME_EXE=... FV2_PLAYWRIGHT_PATH=... node scripts/fv2/auditarResponsivo.mjs <pastaFrontend> [captura=pasta]
import { createRequire } from "node:module";
import { iniciarPlataformaSimulada } from "./plataformaSimulada.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FV2_PLAYWRIGHT_PATH || "playwright");
const [pasta, capturas] = process.argv.slice(2);
const ROTAS = ["visao-geral", "dre", "saipos", "ifood", "noventa-e-nove-food", "operadoras-taxas", "vendas-e-recebimentos", "contas-a-pagar", "contas-a-receber", "calendario", "caixa-e-bancos", "fluxo-de-caixa", "lancamentos", "conferencias", "documentos", "configuracoes"];
const LARGURAS = [[390, 844, "celular"], [768, 1024, "tablet"], [1366, 900, "desktop"]];
const STUB = "window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'t'}}})}})};";
const srv = await iniciarPlataformaSimulada({ pasta });
const browser = await chromium.launch(process.env.FV2_CHROME_EXE ? { executablePath: process.env.FV2_CHROME_EXE } : {});
const achados = [];
for (const [w, h, nome] of LARGURAS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 1000, locale: "pt-BR" });
  await ctx.addInitScript(() => { try { sessionStorage.setItem("cd.contextToken", "x"); } catch {} });
  await ctx.route("**/*", (r) => { const u = r.request().url(); if (u.startsWith(srv.url)) return r.continue(); if (u.includes("jsdelivr")) return r.fulfill({ contentType: "text/javascript", body: STUB }); return r.abort(); });
  const page = await ctx.newPage();
  await page.goto(`${srv.url}/financeiro-v2/?modo=plataforma`);
  await page.waitForSelector("#conteudo h1", { timeout: 30000 });
  for (const rota of ROTAS) {
    await page.evaluate((r) => { location.hash = `#/${r}`; }, rota).catch(() => {});
    const link = page.locator(`nav a[data-rota="${rota}"]`).first();
    if (await link.count()) await link.evaluate((a) => a.click());
    await page.waitForFunction(() => !document.querySelector("#conteudo [aria-busy=true]"), null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(250);
    const r = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const rolagem = document.documentElement.scrollWidth - vw;
      const vaza = [];
      const dentroDeRolavel = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if ((o === "auto" || o === "scroll") && p.scrollWidth > p.clientWidth) return true; } return false; };
      for (const el of document.querySelectorAll("#conteudo *, header *, nav *")) {
        const b = el.getBoundingClientRect();
        if (b.width > 0 && b.right > vw + 1 && !dentroDeRolavel(el) && getComputedStyle(el).position !== "fixed") { vaza.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`); if (vaza.length >= 4) break; }
      }
      const pequenos = [];
      for (const el of document.querySelectorAll("button, a[href], select, input:not([type=hidden]), [role=button]")) {
        const b = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        if (b.width > 0 && b.height > 0 && cs.visibility !== "hidden" && b.height < 40) pequenos.push(`${el.tagName.toLowerCase()}:${(el.textContent || el.getAttribute("aria-label") || el.name || "").trim().slice(0, 22)}(${Math.round(b.height)}px)`);
      }
      return { rolagem, vaza: [...new Set(vaza)], nPequenos: pequenos.length, exemplosPequenos: [...new Set(pequenos)].slice(0, 4), titulo: document.querySelector("#conteudo h1")?.textContent?.trim().slice(0, 30) };
    });
    achados.push({ largura: w, nome, rota, ...r });
    if (capturas && (w === 390)) await page.screenshot({ path: `${capturas}/${nome}-${rota}.png`, fullPage: false }).catch(() => {});
  }
  await ctx.close();
}
await browser.close(); await srv.fechar();
for (const a of achados) console.log(JSON.stringify(a));
const ruins = achados.filter((a) => a.rolagem > 1 || a.vaza.length);
console.log(`\n== ${achados.length} telas×larguras; com rolagem horizontal/vazamento: ${ruins.length}; com alvos <40px: ${achados.filter((a) => a.nPequenos).length}`);
