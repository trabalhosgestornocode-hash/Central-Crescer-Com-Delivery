// QA VISUAL do acabamento premium do Dashboard Financeiro: as 12 telas em desktop claro, desktop escuro e celular (claro e escuro).
// Requer servidor-qa-integrado.mjs (dados sintéticos, loopback). Uso: QA_MODULOS=<pasta com playwright-core> QA_FASE=depois node qa-premium.mjs
// Checa: erro de página/console, rolagem horizontal da página, texto vazando do cartão e contraste mínimo de texto (AA 4.5:1) nas telas;
// diálogos centralizados; eixo do gráfico legível e redesenhado ao redimensionar; estados de erro (API 500) e vazio.
import { createRequire } from "node:module";
const { chromium } = createRequire(`${process.env.QA_MODULOS || process.cwd()}/`)("playwright-core");
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const FASE = process.env.QA_FASE || "depois";
const SHOTS = path.join(aqui, "shots", `premium-${FASE}`); mkdirSync(SHOTS, { recursive: true });   // ignorado pelo git
const BASE = process.env.QA_BASE || "http://127.0.0.1:4174";
const PAGINAS = ["fin-visao-geral", "fin-fluxo-de-caixa", "fin-contas", "fin-conciliacao", "fin-dre", "fin-indicadores",
  "fin-categorias", "fin-plano-de-contas", "fin-periodos", "fin-importacao", "fin-relatorios", "fin-configuracoes"];
const MODOS = [
  { nome: "desktop-claro", largura: 1440, altura: 900, tema: "light" },
  { nome: "desktop-escuro", largura: 1440, altura: 900, tema: "dark" },
  { nome: "celular-claro", largura: 390, altura: 844, tema: "light", mobile: true },
  { nome: "celular-escuro", largura: 390, altura: 844, tema: "dark", mobile: true },
  { nome: "celular-360", largura: 360, altura: 740, tema: "light", mobile: true },
];
const res = []; const erros = [];
const checar = (nome, ok, d = "") => res.push({ nome, ok: !!ok, d });

await fetch(`${BASE}/qa/cenario?nome=financeiro`); await fetch(`${BASE}/qa/nivel?n=gestor`); await fetch(`${BASE}/qa/vazio?on=0`); await fetch(`${BASE}/qa/falha?on=0`);
const nav = await chromium.launch({ executablePath: process.env.QA_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });

// Contraste: varre os nós de texto visíveis de #view e compara a cor do texto com o primeiro fundo opaco ancestral.
const contraste = () => {
  const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const fundo = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length === 3 || (c.length === 4 && c[3] > 0.9)) return c.slice(0, 3); } return rgb(getComputedStyle(document.body).backgroundColor).slice(0, 3); };
  const ruins = [];
  const w = document.createTreeWalker(document.querySelector("#view"), NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const el = n.parentElement; if (!n.textContent.trim() || !el || !el.checkVisibility?.()) continue;
    // botões cheios usam gradiente (backgroundColor transparente): o contraste deles é do design system do shell, fora deste verificador
    if (el.closest("svg, [disabled], .btn:disabled, [aria-disabled='true'], .btn-primary, .btn-perigo")) continue;
    const cs = getComputedStyle(el); const fg = rgb(cs.color); if (fg.length === 4 && fg[3] < 0.5) continue;
    const [a, b] = [lum(fg.slice(0, 3)), lum(fundo(el))]; const r = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const grande = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
    if (r < (grande ? 3 : 4.5)) ruins.push(`${n.textContent.trim().slice(0, 30)} (${r.toFixed(2)})`);
  }
  return [...new Set(ruins)].slice(0, 6);
};

for (const m of MODOS) {
  const ctx = await nav.newContext({ viewport: { width: m.largura, height: m.altura }, colorScheme: m.tema, isMobile: !!m.mobile, hasTouch: !!m.mobile, deviceScaleFactor: m.mobile ? 2 : 1 });
  await ctx.addInitScript((t) => { try { localStorage.setItem("cd.tema", t); } catch {} }, m.tema);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => erros.push(`${m.nome} PAGEERROR ${String(e.message).slice(0, 140)}`));
  page.on("console", (x) => { if (x.type() === "error" && !/favicon|Failed to load resource/.test(x.text())) erros.push(`${m.nome} console: ${x.text().slice(0, 140)}`); });
  await page.goto(BASE + "/", { waitUntil: "load" }); await page.waitForTimeout(1500);
  for (const rota of PAGINAS) {
    // no celular o menu é gaveta: navega pelo próprio roteador (hash), como o clique faria
    if (m.mobile) await page.evaluate((r) => document.querySelector(`#menu li[data-rota="${r}"]`)?.click(), rota);
    else await page.locator(`#menu li[data-rota="${rota}"]`).click();
    await page.waitForTimeout(1300);
    await page.screenshot({ path: path.join(SHOTS, `${m.nome}-${rota}.png`), fullPage: true });
    const larg = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vp: window.innerWidth }));
    checar(`${m.nome} ${rota}: sem rolagem horizontal da página`, larg.doc <= larg.vp + 1, JSON.stringify(larg));
    const vaza = await page.$$eval("#view .fin-kpi, #view .fin-card", (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX === "visible").length);
    checar(`${m.nome} ${rota}: nenhum cartão com conteúdo vazando`, vaza === 0, String(vaza));
    const camposVazando = await page.$$eval("#view .fin-campo :is(input, select, textarea)", (els) => els.filter((e) => e.checkVisibility() && e.getBoundingClientRect().right > e.closest(".fin-campo").getBoundingClientRect().right + 1).map((e) => e.type || e.tagName));
    checar(`${m.nome} ${rota}: nenhum campo invadindo o vizinho`, camposVazando.length === 0, camposVazando.join(","));
    const semCor = await page.$$eval("#view .btn-primary",(bs) => bs.filter((b) => b.checkVisibility() && getComputedStyle(b).backgroundImage === "none").length);
    checar(`${m.nome} ${rota}: ação principal com a cor da marca`, semCor === 0, String(semCor));
    const ruins = await page.evaluate(contraste);
    checar(`${m.nome} ${rota}: contraste de texto AA`, ruins.length === 0, ruins.join(" | "));
    if (rota === "fin-importacao") {   // regressão do redesign: --vermelho indefinido no shell deixava o passo atual sem cor
      const passo = await page.evaluate(() => { const li = document.querySelector('#view .fin-passos li[aria-current="step"]'); return li ? getComputedStyle(li, "::before").backgroundColor : null; });
      checar(`${m.nome} importação: passo atual destacado`, passo && !/rgba\(0, 0, 0, 0\)|transparent/.test(passo), String(passo));
    }
  }
  // fluxos com modal: pré-fechamento (Períodos) e novo lançamento (Fluxo de Caixa)
  for (const [rota, botao, nome] of [["fin-periodos", "[data-pre]", "modal-pre-fechamento"], ["fin-fluxo-de-caixa", "[data-novo]", "modal-novo-lancamento"]]) {
    await page.evaluate((r) => document.querySelector(`#menu li[data-rota="${r}"]`)?.click(), rota); await page.waitForTimeout(1300);
    await page.locator(botao).first().click(); await page.waitForTimeout(1500);
    const aberto = await page.locator("dialog.fin-dialogo[open]").count();
    checar(`${m.nome} ${nome}: diálogo aberto`, aberto === 1, String(aberto));
    const centro = await page.evaluate(() => { const r = document.querySelector("dialog.fin-dialogo[open]")?.getBoundingClientRect(); return r ? Math.abs((r.left + r.right) / 2 - innerWidth / 2) : 999; });
    checar(`${m.nome} ${nome}: diálogo centralizado`, centro <= 2, String(centro));
    const semCor = await page.$$eval("dialog.fin-dialogo[open] .btn-primary", (bs) => bs.filter((b) => getComputedStyle(b).backgroundImage === "none").length);
    checar(`${m.nome} ${nome}: ação principal com a cor da marca`, semCor === 0, String(semCor));
    await page.screenshot({ path: path.join(SHOTS, `${m.nome}-${nome}.png`) });
    const dlg = await page.evaluate(() => { const d = document.querySelector("dialog.fin-dialogo[open]"); if (!d) return null; const r = d.getBoundingClientRect(); return { l: r.left, r: r.right, vp: innerWidth, rolaH: d.scrollWidth > d.clientWidth + 2 }; });
    checar(`${m.nome} ${nome}: diálogo dentro da tela, sem rolagem horizontal`, dlg && dlg.l >= 0 && dlg.r <= dlg.vp && !dlg.rolaH, JSON.stringify(dlg));
    await page.keyboard.press("Escape"); await page.waitForTimeout(400);
  }
  // gráfico: eixo legível (≥ 10px na tela) e redesenho na largura nova ao redimensionar a janela (antes só redesenhava ao trocar o mês)
  const medirGrafico = () => page.evaluate(() => {
    const card = document.querySelector("#view [data-grafico-es]"); const svg = card?.querySelector("svg"); if (!svg) return null;
    const cs = getComputedStyle(card); const util = card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const vb = svg.viewBox.baseVal.width; const escala = svg.getBoundingClientRect().width / vb;
    const t = svg.querySelector("text"); return { util: Math.round(util), vb, eixoPx: t ? +(parseFloat(getComputedStyle(t).fontSize) * escala).toFixed(1) : 0 };
  });
  await page.evaluate(() => document.querySelector('#menu li[data-rota="fin-visao-geral"]')?.click()); await page.waitForTimeout(1300);
  const g0 = await medirGrafico();
  checar(`${m.nome} gráfico: eixo legível (≥ 10px)`, g0 && g0.eixoPx >= 10, JSON.stringify(g0));
  const larguraNova = m.mobile ? 640 : 1024;   // celular girado / janela reduzida
  await page.setViewportSize({ width: larguraNova, height: m.altura }); await page.waitForTimeout(900);
  const g1 = await medirGrafico();
  checar(`${m.nome} gráfico: redesenha na nova largura (${m.largura}→${larguraNova})`, g1 && Math.abs(g1.vb - Math.max(300, g1.util)) <= 20 && g1.eixoPx >= 10, JSON.stringify({ antes: g0, depois: g1 }));
  await page.screenshot({ path: path.join(SHOTS, `${m.nome}-grafico-redimensionado.png`), fullPage: true });
  await page.setViewportSize({ width: m.largura, height: m.altura }); await page.waitForTimeout(600);
  // estados de erro (API 500) e vazio (unidade sem dados): legíveis, dentro da tela, com ação de nova tentativa no erro
  // na falha, conforme o momento, quem recusa é a checagem de acesso do roteador (aviso próprio, sem botão) ou a página (com «Tentar novamente»)
  for (const [chave, sel, rotas] of [["falha", "#view .fin-estado", ["fin-visao-geral", "fin-fluxo-de-caixa", "fin-conciliacao", "fin-periodos"]], ["vazio", "#view .fin-pg", ["fin-visao-geral", "fin-dre", "fin-conciliacao", "fin-importacao"]]]) {
    await fetch(`${BASE}/qa/${chave}?on=1`);
    for (const rota of rotas) {
      await page.evaluate((r) => document.querySelector(`#menu li[data-rota="${r}"]`)?.click(), rota); await page.waitForTimeout(1300);
      const n = await page.locator(sel).count();
      checar(`${m.nome} ${chave} ${rota}: estado exibido`, n > 0, String(n));
      if (chave === "falha" && await page.locator("#view .fin-estado--erro").count()) checar(`${m.nome} falha ${rota}: botão «Tentar novamente»`, await page.locator("#view [data-fin-retry]").count() > 0);
      const larg = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vp: window.innerWidth }));
      checar(`${m.nome} ${chave} ${rota}: sem rolagem horizontal`, larg.doc <= larg.vp + 1, JSON.stringify(larg));
      const ruins = await page.evaluate(contraste);
      checar(`${m.nome} ${chave} ${rota}: contraste AA`, ruins.length === 0, ruins.join(" | "));
      await page.screenshot({ path: path.join(SHOTS, `${m.nome}-${chave}-${rota}.png`), fullPage: true });
    }
    await fetch(`${BASE}/qa/${chave}?on=0`);
  }
  await ctx.close();
}
await nav.close();
const falhas = res.filter((r) => !r.ok);
writeFileSync(path.join(SHOTS, "resultado.json"), JSON.stringify({ fase: FASE, total: res.length, falhas, erros }, null, 2));
for (const f of falhas) console.log(`FALHA ${f.nome} — ${f.d}`);
for (const e of erros) console.log(`ERRO  ${e}`);
console.log(`QA premium (${FASE}): ${res.length - falhas.length}/${res.length} ok · ${erros.length} erro(s) de página/console`);
process.exit(falhas.length || erros.length ? 1 : 0);
