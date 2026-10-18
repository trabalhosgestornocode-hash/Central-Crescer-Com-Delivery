// QA da F-2 (checkpoint F-1/F-2): comportamento da tela de pré-fechamento depois de um 409 de dados. Requer servidor-qa-integrado.mjs na 4174 (estado LIMPO: reinicie antes).
// Roteiro: abrir a prévia -> outra pessoa muda os dados (/qa/mudar-dados, mudança REAL no domínio) -> confirmar -> 409 de verdade.
// Esperado: aviso claro; confirmação DESABILITADA; mesma prévia não pode ser reenviada; "Atualizar pré-fechamento" recalcula; só então a confirmação volta.
import { createRequire } from "node:module";
const { chromium } = createRequire(`${process.env.QA_MODULOS || process.cwd()}/`)("playwright-core");
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(aqui, "shots"); mkdirSync(SHOTS, { recursive: true });
const BASE = "http://127.0.0.1:4174";
const res = []; const erros = [];
const checar = (nome, ok, d = "") => res.push({ nome, ok: !!ok, d });
const api = (p) => fetch(BASE + p).then((r) => r.json());
await api("/qa/cenario?nome=financeiro"); await api("/qa/nivel?n=gestor");
const nav = await chromium.launch({ executablePath: process.env.QA_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });

async function cenario({ rotulo, largura, altura, tema }) {
  const ctx = await nav.newContext({ viewport: { width: largura, height: altura }, colorScheme: tema });
  await ctx.addInitScript((t) => { try { localStorage.setItem("cd.tema", t); } catch {} }, tema);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => erros.push(`${rotulo} PAGEERROR ${String(e.message).slice(0, 140)}`));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) erros.push(`${rotulo} console: ${m.text().slice(0, 140)}`); });
  const posts = []; page.on("request", (r) => { if (r.method() === "POST" && /\/periodos\/[^/]+\/fechar$/.test(r.url())) posts.push(r.postData()); });
  await page.goto(BASE + "/", { waitUntil: "load" }); await page.waitForTimeout(1500);
  if (largura < 600) await page.locator("#btn-menu").click().catch(() => {});
  await page.locator('#menu li[data-rota="fin-periodos"]').click(); await page.waitForTimeout(1200);
  const { mes } = await api("/qa/mes-limpo");
  await page.reload({ waitUntil: "load" }); await page.waitForTimeout(1500);
  if (largura < 600) await page.locator("#btn-menu").click().catch(() => {});
  await page.locator('#menu li[data-rota="fin-periodos"]').click(); await page.waitForTimeout(1200);
  const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const linha = page.locator(`#view tr:has-text("${MESES[Number(mes.slice(5)) - 1]}/${mes.slice(0, 4)}")`).first();
  await linha.locator('button:has-text("Pré-fechamento")').click(); await page.waitForTimeout(1500);
  const dlg = page.locator("dialog.fin-dialogo[open]");
  const submit = dlg.locator('[type="submit"]');
  checar(`${rotulo}: prévia aberta com a confirmação habilitável (mês limpo)`, await dlg.isVisible() && !(await submit.isDisabled()));
  await dlg.locator('input[name="confirmo"]').check();
  await api("/qa/mudar-dados");                                // OUTRA pessoa muda os dados depois da prévia
  await submit.click(); await page.waitForTimeout(1200);
  checar(`${rotulo}: 409 real => aviso claro de que os dados mudaram`, /dados financeiros deste mês mudaram/i.test(await dlg.innerText()), (await dlg.innerText()).slice(0, 120));
  checar(`${rotulo}: confirmação DESABILITADA após o 409`, await submit.isDisabled());
  checar(`${rotulo}: botão "Atualizar pré-fechamento" presente e visível`, await dlg.locator("[data-atualizar]").isVisible());
  const n = posts.length;
  await submit.click({ force: true, timeout: 800 }).catch(() => {}); await dlg.locator("form").press("Enter").catch(() => {}); await page.waitForTimeout(500);
  checar(`${rotulo}: a MESMA prévia não pode ser reenviada (nenhum POST novo)`, posts.length === n, `POSTs: ${posts.length} (antes ${n})`);
  const larg = await page.evaluate(() => document.documentElement.scrollWidth);
  checar(`${rotulo}: sem rolagem horizontal da página`, larg <= largura + 2, `scrollWidth=${larg}`);
  const caixa = await dlg.boundingBox();
  checar(`${rotulo}: diálogo cabe na tela`, caixa && caixa.x >= -1 && caixa.x + caixa.width <= largura + 1, JSON.stringify(caixa));
  await page.screenshot({ path: path.join(SHOTS, `50-f2-409-${rotulo}.png`) });
  await dlg.locator("[data-atualizar]").click(); await page.waitForTimeout(1500);
  checar(`${rotulo}: depois de atualizar, o aviso some e a prévia é nova (confirmação ainda NÃO marcada)`, !(await dlg.locator("[data-mudou]").count()) && !(await dlg.locator('input[name="confirmo"]').isChecked()));
  await dlg.locator('input[name="confirmo"]').check();
  checar(`${rotulo}: com a prévia nova a confirmação volta a ser possível`, !(await submit.isDisabled()));
  await page.screenshot({ path: path.join(SHOTS, `51-f2-atualizada-${rotulo}.png`) });
  await submit.click(); await page.waitForTimeout(1500);
  checar(`${rotulo}: fecha com a prévia nova`, /Período fechado|Fechado/i.test(await page.locator("body").innerText()) && !(await page.locator("dialog.fin-dialogo[open]").count()));
  await ctx.close();
}

// cada variação precisa de um mês limpo novo: reinicia o estado do servidor entre elas (o script chama /qa/novo-mes)
const variacoes = [{ rotulo: "desktop", largura: 1366, altura: 860, tema: "light" }, { rotulo: "celular", largura: 390, altura: 844, tema: "light" }, { rotulo: "escuro", largura: 1366, altura: 860, tema: "dark" }];
for (const v of variacoes) { await api("/qa/novo-mes"); await cenario(v); }
await nav.close();
const falhas = res.filter((r) => !r.ok);
for (const r of res) console.log(`${r.ok ? "OK   " : "FALHA"} ${r.nome}${r.ok || !r.d ? "" : `  (${r.d})`}`);
console.log(`\n${res.length - falhas.length}/${res.length} verificações OK · erros de script: ${erros.length}`);
for (const e of erros) console.log("  !", e);
process.exit(falhas.length || erros.length ? 1 : 0);
