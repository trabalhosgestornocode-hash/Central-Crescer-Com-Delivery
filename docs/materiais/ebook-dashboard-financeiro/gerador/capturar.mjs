// Capturas de tela do e-book "Domine seu Financeiro" — SEMPRE com dados sintéticos, nunca produção.
// Requer os servidores de QA locais (loopback):
//   backend/testes-seguros/qa-visual/servidor-qa-integrado.mjs <porta>   → telas do Financeiro (frontend + domínio reais, repositório em memória)
//   backend/testes-seguros/qa-visual/servidor-qa.mjs <porta>             → tela "Acesso Financeiro" do Painel SuperAdmin (backend fictício)
// Uso: QA_MODULOS=<pasta com playwright-core> FIN_BASE=http://127.0.0.1:4197 ADM_BASE=http://127.0.0.1:4198 node capturar.mjs [--rascunho]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(`${process.env.QA_MODULOS || process.cwd()}/`)("playwright-core");
const aqui = path.dirname(fileURLToPath(import.meta.url));
const RASCUNHO = process.argv.includes("--rascunho");
const SAIDA = path.join(aqui, "..", RASCUNHO ? "capturas-rascunho" : "capturas");
mkdirSync(SAIDA, { recursive: true });
const FIN = process.env.FIN_BASE || "http://127.0.0.1:4197";
const ADM = process.env.ADM_BASE || "";
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";

// Rótulos de teste do ambiente de QA → nomes de demonstração (só texto exibido; nenhum dado real existe nesse ambiente).
const TROCAS = [["Empresa QA (fictícia)", "Delivery Demonstração"], ["Usuária QA", "Ana Demonstração"], ["qa@exemplo.invalid", "ana@exemplo.invalid"], [" (QA)", ""], ["Caio Teste", "Caio Lima"], ["Usuário sem vínculo ativo", "Ex-colaborador (sem vínculo)"]];
async function limparRotulos(page) {
  await page.evaluate((trocas) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) for (const [a, b] of trocas) if (n.nodeValue.includes(a)) n.nodeValue = n.nodeValue.split(a).join(b);
    for (const el of document.querySelectorAll("input, option")) for (const [a, b] of trocas) { if (el.value?.includes?.(a)) el.value = el.value.split(a).join(b); }
  }, TROCAS);
}

// Destaque discreto: contorno vermelho da marca com halo suave, desenhado por cima (não altera o layout).
async function destacar(page, seletores) {
  await page.evaluate((sels) => {
    document.querySelectorAll(".ebook-destaque").forEach((e) => e.remove());
    for (const s of sels) {
      const el = document.querySelector(s); if (!el) continue;
      const r = el.getBoundingClientRect();
      const d = Object.assign(document.createElement("div"), { className: "ebook-destaque" });
      Object.assign(d.style, { position: "absolute", left: `${r.left + scrollX - 5}px`, top: `${r.top + scrollY - 5}px`, width: `${r.width + 10}px`, height: `${r.height + 10}px`,
        border: "2.5px solid #F42433", borderRadius: "10px", boxShadow: "0 0 0 5px rgba(244,36,51,.14)", pointerEvents: "none", zIndex: 99999 });
      document.body.appendChild(d);
    }
  }, seletores);
}
const semDestaque = (page) => page.evaluate(() => document.querySelectorAll(".ebook-destaque").forEach((e) => e.remove()));

async function ir(page, rota, espera = 1500) {
  await page.evaluate((r) => document.querySelector(`#menu li[data-rota="${r}"]`)?.click(), rota);
  await page.waitForTimeout(espera);
  await limparRotulos(page);
}

/** Recorte de um retângulo que envolve os elementos dados (coordenadas da página), com margem. */
async function recorte(page, nome, seletores, { margem = 12, alturaMax = null } = {}) {
  const box = await page.evaluate(({ sels, margem }) => {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const s of sels) for (const el of (s.startsWith("!") ? [document.querySelector(s.slice(1))].filter(Boolean) : document.querySelectorAll(s))) {
      const x = el.getBoundingClientRect(); if (!x.width) continue;
      l = Math.min(l, x.left + scrollX); t = Math.min(t, x.top + scrollY); r = Math.max(r, x.right + scrollX); b = Math.max(b, x.bottom + scrollY);
    }
    if (l === Infinity) return null;
    return { x: Math.max(0, l - margem), y: Math.max(0, t - margem), width: r - l + 2 * margem, height: b - t + 2 * margem };
  }, { sels: seletores, margem });
  if (!box) throw new Error(`recorte ${nome}: nada encontrado para ${seletores.join(", ")}`);
  if (alturaMax) box.height = Math.min(box.height, alturaMax);
  await page.mouse.move(1, 1);
  await page.screenshot({ path: path.join(SAIDA, `${nome}.jpg`), type: "jpeg", quality: 90, clip: box, fullPage: true });
  console.log("ok", nome, Math.round(box.width), "x", Math.round(box.height));
}

const nav = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await nav.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, colorScheme: "light", locale: "pt-BR" });
await ctx.addInitScript(() => { try { localStorage.setItem("cd.tema", "light"); } catch {} });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGEERROR", e.message));

await fetch(`${FIN}/qa/cenario?nome=ambos`); await fetch(`${FIN}/qa/nivel?n=gestor`); await fetch(`${FIN}/qa/vazio?on=0`); await fetch(`${FIN}/qa/falha?on=0`);
await page.goto(FIN + "/", { waitUntil: "load" }); await page.waitForTimeout(1800);
await limparRotulos(page);
if (!RASCUNHO) {   // 0. escolha do setor (primeira tela após o login)
  await page.screenshot({ path: path.join(SAIDA, "00-escolha-setor.jpg"), type: "jpeg", quality: 88 });
  console.log("ok 00-escolha-setor");
}
await page.getByText("Dashboard Financeiro", { exact: true }).first().click(); await page.waitForTimeout(2200);
await limparRotulos(page);

if (RASCUNHO) {   // reconhecimento: página inteira de cada tela
  for (const rota of ["fin-visao-geral", "fin-fluxo-de-caixa", "fin-contas", "fin-conciliacao", "fin-dre", "fin-indicadores", "fin-categorias", "fin-plano-de-contas", "fin-periodos", "fin-importacao", "fin-relatorios", "fin-configuracoes"]) {
    await ir(page, rota);
    await page.screenshot({ path: path.join(SAIDA, `${rota}.jpg`), type: "jpeg", quality: 70, fullPage: true });
  }
  await nav.close(); process.exit(0);
}

// 1. Navegação: tela inteira com o menu do Financeiro em destaque
await ir(page, "fin-visao-geral", 2200);
await destacar(page, ["#menu"]);
await page.mouse.move(1, 1);
await page.screenshot({ path: path.join(SAIDA, "01-navegacao.jpg"), type: "jpeg", quality: 88 });
console.log("ok 01-navegacao");
await semDestaque(page);

// 2. Visão Geral: indicadores (destaque: resultado gerencial × variação do caixa)
await destacar(page, ["#view .fin-kpis .fin-kpi:nth-child(5)", "#view .fin-kpis .fin-kpi:nth-child(7)"]);
await recorte(page, "02-visao-geral-kpis", ["#view .fin-regime", "#view .fin-kpis"]);
await semDestaque(page);
await recorte(page, "03-visao-geral-grafico", ["!#view [data-grafico-es]"]);

// 3. Fluxo de Caixa: lista e diálogos
await ir(page, "fin-fluxo-de-caixa");
await destacar(page, ["#view [data-novo]", "#view [data-transf]"]);
await recorte(page, "04-fluxo-de-caixa", ["#view [data-topo]", "#view [data-filtros]", "#view [data-lista] .fin-tabela thead", "#view [data-lista] .fin-tabela tbody tr:nth-child(-n+5)"]);
await semDestaque(page);
await page.locator("#view [data-novo]").first().click(); await page.waitForTimeout(900); await limparRotulos(page);
await recorte(page, "05-novo-lancamento", ["dialog.fin-dialogo[open]"], { margem: 2 });
await page.keyboard.press("Escape"); await page.waitForTimeout(400);
await page.locator("#view [data-transf]").first().click(); await page.waitForTimeout(900); await limparRotulos(page);
await recorte(page, "06-nova-transferencia", ["dialog.fin-dialogo[open]"], { margem: 2 });
await page.keyboard.press("Escape"); await page.waitForTimeout(400);

// 4. Contas
await ir(page, "fin-contas");
await recorte(page, "07-contas", ["!#view [data-corpo] > .fin-card"]);

// 5. DRE (sem as linhas de detalhe, para caber) / Indicadores / Categorias / Plano de Contas
await ir(page, "fin-dre");
await page.addStyleTag({ content: "#view .fin-det { display: none !important; }" });
await recorte(page, "08-dre", ["#view .fin-tabela-wrap"]);
await ir(page, "fin-indicadores");
await recorte(page, "09-indicadores-ponte", ["!#view [data-corpo] > .fin-card"]);
await ir(page, "fin-categorias");
await recorte(page, "10-categorias", ["!#view [data-corpo] > .fin-card"]);
await ir(page, "fin-plano-de-contas");
await recorte(page, "11-plano-de-contas", ["#view .fin-tabela thead", "#view .fin-tabela tbody tr:nth-child(-n+7)"]);

// 6. Importação
await ir(page, "fin-importacao");
await recorte(page, "12-importacao", ["#view .fin-passos", "!#view [data-corpo] .fin-card"]);

// 7. Conciliação — duas referências SINTÉTICAS (vendas e taxas do canal STONE) informadas pela própria tela, no repositório em memória
await ir(page, "fin-conciliacao");
for (const [tipo, valor] of [["venda", "30000,00"], ["taxa", "1050,00"]]) {
  await page.locator("#view [data-ref]").click(); await page.waitForTimeout(600);
  const d = page.locator("dialog.fin-dialogo[open]");
  await d.locator("select[name=tipo]").selectOption(tipo);
  await d.locator("input[name=valor]").fill(valor);
  await d.locator("input[name=canal]").fill("STONE");
  await d.locator("[type=submit]").click(); await page.waitForTimeout(1300);
}
await limparRotulos(page);
await destacar(page, ["#view [data-corpo] .fin-card:first-of-type .fin-tabela tr:last-child"]);
await recorte(page, "13-conciliacao-ponte", ["!#view [data-corpo] .fin-card"]);
await semDestaque(page);

// 8. Relatórios e Períodos
await ir(page, "fin-relatorios", 2200);
await recorte(page, "14-relatorios", ["#view nav.fin-passos", "#view [data-filtros]", "!#view [data-resultado] .fin-card"], { alturaMax: 700 });
await ir(page, "fin-periodos");
await recorte(page, "15-periodos", ["#view [data-corpo] > .fin-card:nth-child(2)"]);
await page.locator("#view [data-pre]").first().click(); await page.waitForTimeout(1800); await limparRotulos(page);
await recorte(page, "16-pre-fechamento", ["dialog.fin-dialogo[open]"], { margem: 2 });
await page.keyboard.press("Escape"); await page.waitForTimeout(400);

// 9. Configurações
await ir(page, "fin-configuracoes");
await recorte(page, "17-configuracoes", ["#view [data-corpo] > .fin-alerta:first-child", "#view [data-corpo] > .fin-card:nth-child(2)"]);

// 10. Acesso Financeiro (Painel SuperAdmin) — backend fictício, nada é gravado em lugar nenhum
if (ADM) {
  await fetch(`${ADM}/qa/cenario?nome=superadmin`); await fetch(`${ADM}/qa/escrita?on=1`);
  const p2 = await ctx.newPage();
  await p2.goto(ADM + "/", { waitUntil: "load" }); await p2.waitForTimeout(2200);
  await p2.getByText("Acesso Financeiro", { exact: true }).first().click(); await p2.waitForTimeout(1800);
  await p2.selectOption("#fa-org", "org-qa"); await p2.waitForTimeout(1200);
  await p2.selectOption("#fa-uni", "uni-a"); await p2.waitForTimeout(1800);
  await p2.getByText("Financeiro desligado", { exact: false }).first().click(); await p2.waitForTimeout(600);
  const nivelDe = async (nome, nivel) => {   // o <select> da linha que mostra o nome da pessoa
    const sel = await p2.evaluateHandle((n) => { let el = [...document.querySelectorAll("strong, b, span, div")].find((e) => e.childElementCount === 0 && e.textContent.trim() === n);
      while (el && !el.querySelector("select")) el = el.parentElement; return el?.querySelector("select"); }, nome);
    await sel.asElement().selectOption(nivel);
  };
  await nivelDe("Bruno Dias", "gestor"); await nivelDe("Caio Teste", "leitura"); await p2.waitForTimeout(500);
  await limparRotulos(p2);
  await p2.evaluate(() => {   // marca o botão Salvar e a linha da chave, para o destaque
    [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Salvar")?.setAttribute("data-ebook", "salvar");
    const t = [...document.querySelectorAll("strong, b, span")].find((e) => /^Financeiro (ligado|desligado)$/.test(e.textContent.trim()));
    t?.closest("label, div")?.setAttribute("data-ebook", "chave");
  });
  await destacar(p2, ["[data-ebook=chave]", "[data-ebook=salvar]"]);
  const caixa = await p2.evaluate(() => { const h = [...document.querySelectorAll("h1,h2,h3,div")].find((e) => e.textContent.trim() === "Acesso ao Dashboard Financeiro"); const c = h?.closest("section, .card, .painel, div[class*=card]") ?? h?.parentElement?.parentElement; const r = c.getBoundingClientRect(); return { x: r.left + scrollX - 10, y: r.top + scrollY - 10, width: r.width + 20, height: r.height + 20 }; });
  await p2.mouse.move(1, 1);
  await p2.screenshot({ path: path.join(SAIDA, "18-acesso-financeiro.jpg"), type: "jpeg", quality: 90, clip: caixa, fullPage: true });
  console.log("ok 18-acesso-financeiro");
}
await nav.close();
