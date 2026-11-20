// Capturas de TODAS as telas do Financeiro (Chrome real, plataforma simulada, dados sintéticos) para revisão visual.
//   FV2_PLAYWRIGHT_PATH=<playwright-core> [FV2_CHROME_EXE=<chrome>] node scripts/fv2/capturarTelas.mjs <pastaFrontend> <pastaSaida> [acai|subway] [largura] [altura] [prefixo]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { iniciarPlataformaSimulada } from "./plataformaSimulada.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FV2_PLAYWRIGHT_PATH || "playwright-core");
const aqui = dirname(fileURLToPath(import.meta.url));
const [pasta, saida, unidade = "acai", largura = "1366", altura = "900", prefixo = ""] = process.argv.slice(2);
mkdirSync(saida, { recursive: true });
const subway = unidade === "subway";
const srv = await iniciarPlataformaSimulada({ pasta, unidadeIndice: subway ? 1 : 0, ...(subway ? { preparar: (await import(pathToFileURL(join(aqui, "cenarioSubway.mjs")))).default } : {}) });
const browser = await chromium.launch(process.env.FV2_CHROME_EXE ? { executablePath: process.env.FV2_CHROME_EXE } : {});
const ctx = await browser.newContext({ viewport: { width: Number(largura), height: Number(altura) }, locale: "pt-BR" });
await ctx.addInitScript(() => { try { sessionStorage.setItem("cd.contextToken", "contexto-simulado"); } catch { /* sem armazenamento */ } });
const STUB = "window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'t'}}}),refreshSession:async()=>({data:{session:{access_token:'t'}},error:null})}})};";
await ctx.route("**/*", (route) => {
  const u = route.request().url();
  if (u.startsWith(srv.url)) return route.continue();
  if (u.includes("cdn.jsdelivr.net")) return route.fulfill({ status: 200, contentType: "text/javascript", body: STUB });
  if (u.includes("fonts.googleapis.com") || u.includes("fonts.gstatic.com")) return route.fulfill({ status: 200, contentType: u.includes("gstatic") ? "font/woff2" : "text/css", body: "" });
  return route.abort();
});
const page = await ctx.newPage();
await page.goto(`${srv.url}/financeiro-v2/?modo=plataforma#/visao-geral`);
const rotas = (subway ? ["visao-geral", "dre", "swf", "ifood", "noventa-e-nove-food"] : ["visao-geral", "dre", "saipos", "ifood", "noventa-e-nove-food"])
  .concat(["operadoras-taxas", "lancamentos", "contas-a-pagar", "calendario", "contas-a-receber", "caixa-e-bancos", "fluxo-de-caixa", "vendas-e-recebimentos", "entregadores-proprios", "conferencias", "documentos", "configuracoes"]);
for (const rota of rotas) {
  await page.evaluate((r) => { location.hash = `#/${r}`; }, rota);
  await page.waitForTimeout(250);
  await page.waitForFunction(() => document.documentElement.dataset.dados && document.documentElement.dataset.dados !== "carregando", null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(saida, `${prefixo}${rota}.png`), fullPage: false });
}
await browser.close();
await srv.fechar();
console.log(`capturas em ${saida}`);
