// Gera o PDF e a capa (PNG) do e-book a partir de fonte/ebook.html, com o Chrome do sistema (texto selecionável, fontes embutidas).
// Antes de gerar, confere cada página: nada pode vazar da página nem sair da área útil.
// Uso: QA_MODULOS=<pasta com playwright-core> node gerar-pdf.mjs
import { createRequire } from "node:module";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { chromium } = createRequire(`${process.env.QA_MODULOS || process.cwd()}/`)("playwright-core");
const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.join(aqui, "..");
const FONTE = path.join(raiz, "fonte", "ebook.html");
const PDF = path.join(raiz, "Crescer-com-Delivery-Guia-Dashboard-Financeiro.pdf");
const CAPA = path.join(raiz, "Crescer-com-Delivery-Guia-Dashboard-Financeiro-capa.png");
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const nav = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await nav.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2 });
await page.emulateMedia({ media: "print" });
await page.goto(pathToFileURL(FONTE).href, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);

const problemas = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll(".pagina").forEach((pg, i) => {
    const n = i + 1;
    if (pg.scrollHeight > pg.clientHeight + 1) out.push(`página ${n}: conteúdo maior que a página (${pg.scrollHeight} > ${pg.clientHeight})`);
    const corpo = pg.querySelector(".pg-corpo");
    if (corpo && corpo.scrollHeight > corpo.clientHeight + 1) out.push(`página ${n}: corpo transborda (${corpo.scrollHeight} > ${corpo.clientHeight})`);
    const r = pg.getBoundingClientRect();
    for (const el of pg.querySelectorAll(".pg-corpo *")) {
      const e = el.getBoundingClientRect(); if (!e.width) continue;
      if (e.right > r.right - 30 || e.left < r.left + 30) { out.push(`página ${n}: <${el.tagName.toLowerCase()} class="${el.className}"> fora da margem`); break; }
    }
    for (const img of pg.querySelectorAll("img")) if (!img.complete || !img.naturalWidth) out.push(`página ${n}: imagem não carregou ${img.getAttribute("src")}`);
  });
  return out;
});
if (problemas.length) { console.error("PROBLEMAS DE DIAGRAMAÇÃO:\n" + problemas.join("\n")); process.exitCode = 1; }

await page.pdf({ path: PDF, preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false, tagged: true, outline: false });
await page.emulateMedia({ media: "screen" });
await page.locator(".pagina--capa").screenshot({ path: CAPA });
const paginas = await page.locator(".pagina").count();
console.log(`PDF: ${PDF} (${(statSync(PDF).size / 1024 / 1024).toFixed(2)} MB, ${paginas} páginas)`);
console.log(`Capa: ${CAPA}`);
await nav.close();
