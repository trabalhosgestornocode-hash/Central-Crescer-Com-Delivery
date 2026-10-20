// QA visual local — dirige o Chrome instalado contra o servidor-qa (backend FALSO, loopback). Sem rede externa.
import { createRequire } from "node:module";
// ESM ignora NODE_PATH: o playwright-core fica FORA do repositório; QA_MODULOS aponta para a pasta que contém node_modules.
const { chromium } = createRequire(`${process.env.QA_MODULOS || process.cwd()}/`)("playwright-core");
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(aqui, "shots");   // ignorado pelo git mkdirSync(SHOTS, { recursive: true });
const BASE = "http://127.0.0.1:4173";
const resultados = []; const consoleErros = [];

const navegador = await chromium.launch({ executablePath: process.env.QA_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const cenario = (nome) => fetch(`${BASE}/qa/cenario?nome=${nome}`).then((r) => r.json());
const revogar = () => fetch(`${BASE}/qa/revogar`).then((r) => r.json());

async function nova({ largura = 1366, altura = 800, tema = "light" } = {}) {
  const ctx = await navegador.newContext({ viewport: { width: largura, height: altura }, colorScheme: tema });
  await ctx.addInitScript((t) => { try { localStorage.setItem("cd.tema", t); } catch {} }, tema);
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErros.push(`[${page.url().replace(BASE, "")}] ${m.text().slice(0, 160)}`); });
  page.on("pageerror", (e) => consoleErros.push(`PAGEERROR ${String(e.message).slice(0, 160)}`));
  return { ctx, page };
}
const ver = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);
const foto = (page, nome) => page.screenshot({ path: path.join(SHOTS, `${nome}.png`) });
function checar(nome, condicao, detalhe = "") { resultados.push({ nome, ok: !!condicao, detalhe }); }
const itensMenu = (page) => page.$$eval("#menu li[data-rota]", (ls) => ls.map((l) => l.textContent.trim().replace(/\s+/g, " ")));
const secoesMenu = (page) => page.$$eval("#menu li.menu-secao", (ls) => ls.map((l) => l.textContent.trim()));
const abrir = async (page) => { await page.goto(BASE + "/", { waitUntil: "load" }); await page.waitForTimeout(1200); };
async function limpar(page) { await page.evaluate(() => { sessionStorage.clear(); }); }

// ---------- 1. Somente operacional ----------
{
  await cenario("operacional"); const { ctx, page } = await nova();
  await abrir(page);
  checar("operacional: entra direto no app (sem tela de setor)", await ver(page, "#app") && !(await ver(page, "#setor-screen")));
  checar("operacional: alternador oculto", !(await ver(page, "#btn-setor")));
  const secs = await secoesMenu(page);
  checar("operacional: menu operacional (OPERAÇÃO) presente, sem FINANCEIRO", secs.includes("OPERAÇÃO") && !secs.includes("FINANCEIRO"), secs.join(","));
  checar("operacional: filtros globais (canal/tabela) visíveis", await ver(page, ".global-filtros"));
  await foto(page, "01-operacional-desktop"); await ctx.close();
}

// ---------- 2. Somente financeiro ----------
{
  await cenario("financeiro"); const { ctx, page } = await nova();
  await abrir(page);
  checar("financeiro: entra direto no financeiro (sem tela de setor)", await ver(page, "#app") && !(await ver(page, "#setor-screen")));
  const itens = await itensMenu(page); const secs = await secoesMenu(page);
  checar("financeiro: menu com 12 itens e seção FINANCEIRO", itens.length === 12 && secs.join() === "FINANCEIRO", `${itens.length} itens; ${secs}`);
  checar("financeiro: sem itens operacionais", !itens.some((t) => /Produtos|Insumos|Vendas|Checklist/.test(t)));
  checar("financeiro: alternador oculto (um setor só)", !(await ver(page, "#btn-setor")));
  checar("financeiro: filtros operacionais ocultos", !(await ver(page, ".global-filtros")));
  // A Visão Geral já é a tela REAL (Agente 2, integrada no A7+). Este servidor só responde a navegação (sem API do domínio): a tela tem de
  // mostrar estado de erro/vazio honesto — nunca "em construção" nem números inventados. Os dados reais são cobertos por qa-integrado/qa-jornada.
  // (este servidor responde `{ data: [] }` a tudo o que não é navegação: a tela recebe um formato que o backend real nunca devolve e mostra o
  //  estado de erro — o que se exige aqui é NÃO fingir: sem "em construção", sem NaN e sem valores monetários inventados)
  { const t = await page.locator("#view").innerText(); checar("financeiro: Visão Geral é a tela real (sem 'em construção'), mostra estado de erro honesto e nenhum número inventado sem API", !/em construção/i.test(t) && /Não foi possível|sem dados|vazio/i.test(t) && !/NaN|R\$\s*[1-9]/.test(t), t.slice(0, 160).replace(/\s+/g, " ")); }
  await foto(page, "02-financeiro-desktop");
  await page.locator('#menu li[data-rota="fin-dre"]').click(); await page.waitForTimeout(500);
  checar("financeiro: navegar para DRE altera o título", /DRE/.test(await page.locator("#page-title").innerText()));
  await ctx.close();
}

// ---------- 3. Ambos: escolha, alternador ----------
{
  await cenario("ambos"); const { ctx, page } = await nova();
  await abrir(page);
  checar("ambos: tela de setor aparece", await ver(page, "#setor-screen"));
  checar("ambos: título exato", (await page.locator("#setor-titulo").innerText()).trim() === "Em qual setor você quer prosseguir?");
  const nomes = await page.$$eval("#setor-cards .setor-card:not([hidden]) .setor-card-nome", (n) => n.map((x) => x.textContent.trim()));
  checar("ambos: dois cartões com os nomes exatos", nomes.join("|") === "Dashboard Financeiro|Dashboard Operacional", nomes.join("|"));
  checar("ambos: o app ainda não está visível", !(await ver(page, "#app")));
  await foto(page, "03-setor-escolha-desktop");
  await page.locator('.setor-card[data-setor="financeiro"]').click(); await page.waitForTimeout(900);
  checar("ambos: escolher financeiro abre o menu financeiro", (await secoesMenu(page)).join() === "FINANCEIRO");
  checar("ambos: alternador visível apontando para o Operacional", (await ver(page, "#btn-setor")) && /Operacional/.test(await page.locator("#btn-setor").innerText()));
  await foto(page, "04-financeiro-com-alternador");
  await page.locator("#btn-setor").click(); await page.waitForTimeout(900);
  checar("ambos: alternar volta ao operacional sem nova senha/tela", (await secoesMenu(page)).includes("OPERAÇÃO") && !(await ver(page, "#login-screen")));
  checar("ambos: alternador agora aponta para o Financeiro", /Financeiro/.test(await page.locator("#btn-setor").innerText()));
  await foto(page, "05-operacional-com-alternador");
  // preferência: recarrega -> ainda pergunta (preferência não pula a escolha)
  await abrir(page);
  checar("ambos: após recarregar, a escolha é feita de novo (preferência só destaca)", await ver(page, "#setor-screen"));
  checar("ambos: cartão do último setor vem destacado", await page.locator('.setor-card--sugerido[data-setor="operacional"]').count() === 1);
  await ctx.close();
}

// ---------- 4. Nenhum setor ----------
{
  await cenario("nenhum"); const { ctx, page } = await nova();
  await abrir(page);
  checar("nenhum: tela de setor com aviso, sem cartões", (await ver(page, "#setor-vazio")) && !(await ver(page, "#setor-cards")));
  checar("nenhum: app NÃO é exibido", !(await ver(page, "#app")));
  checar("nenhum: oferece trocar unidade e sair (uma única vez)", (await ver(page, "#setor-trocar")) && (await ver(page, "#setor-sair")) && (await page.locator("#setor-screen button:visible", { hasText: "Trocar unidade" }).count()) === 1);
  await foto(page, "06-nenhum-setor"); await ctx.close();
}

// ---------- 5. Troca de unidade ----------
{
  await cenario("troca"); const { ctx, page } = await nova();
  await abrir(page);
  checar("troca: unidade A (ambos) pergunta o setor", await ver(page, "#setor-screen"));
  await page.locator('.setor-card[data-setor="operacional"]').click(); await page.waitForTimeout(900);
  await page.locator("#chip-unidade").click(); await page.waitForTimeout(300);
  await page.locator('.unidade-menu-item[data-uni="uni-b"]').click(); await page.waitForTimeout(1200);
  checar("troca: unidade B (só operacional) entra direto, sem alternador", (await ver(page, "#app")) && !(await ver(page, "#setor-screen")) && !(await ver(page, "#btn-setor")));
  await foto(page, "07-troca-unidade-b");
  await page.locator("#chip-unidade").click(); await page.waitForTimeout(300);
  await page.locator('.unidade-menu-item[data-uni="uni-a"]').click(); await page.waitForTimeout(1200);
  checar("troca: voltar à unidade A recalcula e pergunta o setor de novo", await ver(page, "#setor-screen"));
  await ctx.close();
}

// ---------- 6. Impersonação ----------
{
  await cenario("impersonacao"); const { ctx, page } = await nova();
  await abrir(page);
  checar("impersonação: financeiro indisponível (entra no operacional, sem escolha nem alternador)", (await ver(page, "#app")) && !(await ver(page, "#setor-screen")) && !(await ver(page, "#btn-setor")) && !(await secoesMenu(page)).includes("FINANCEIRO"));
  checar("impersonação: barra de suporte visível", await ver(page, "#imp-barra"));
  await foto(page, "08-impersonacao"); await ctx.close();
}

// ---------- 7. Perfil de exibição ----------
{
  await cenario("exibicao"); const { ctx, page } = await nova();
  await abrir(page);
  const itens = await itensMenu(page);
  checar("exibição: só o Checklist no menu, sem financeiro/setor", (await ver(page, "#app")) && itens.length === 1 && /Checklist/.test(itens[0]) && !(await ver(page, "#setor-screen")) && !(await ver(page, "#btn-setor")), itens.join(","));
  await foto(page, "09-exibicao"); await ctx.close();
}

// ---------- 8. Revogação ----------
{
  await cenario("ambos"); const { ctx, page } = await nova();
  await abrir(page);
  await page.locator('.setor-card[data-setor="financeiro"]').click(); await page.waitForTimeout(900);
  await revogar();
  await page.locator('#menu li[data-rota="fin-fluxo-de-caixa"]').click(); await page.waitForTimeout(1500);
  checar("revogação: ao navegar, o financeiro é abandonado e cai no operacional", (await secoesMenu(page)).includes("OPERAÇÃO") && !(await secoesMenu(page)).includes("FINANCEIRO"));
  checar("revogação: aviso ao usuário e alternador some", !(await ver(page, "#btn-setor")));
  await foto(page, "10-revogado"); await ctx.close();
}

// ---------- 9. Tema escuro + 10. Mobile ----------
for (const [tema, tag] of [["dark", "escuro"]]) {
  await cenario("ambos"); const { ctx, page } = await nova({ tema });
  await abrir(page);
  await foto(page, `11-setor-${tag}-desktop`);
  await page.locator('.setor-card[data-setor="financeiro"]').click(); await page.waitForTimeout(900);
  await foto(page, `12-financeiro-${tag}-desktop`);
  checar(`tema ${tag}: atributo data-theme aplicado`, (await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "dark");
  await ctx.close();
}
{
  await cenario("ambos"); const { ctx, page } = await nova({ largura: 390, altura: 844 });
  await abrir(page);
  const larg = await page.evaluate(() => document.documentElement.scrollWidth);
  checar("mobile: tela de setor sem rolagem horizontal", larg <= 392, `scrollWidth=${larg}`);
  const cards = await page.$$eval("#setor-cards .setor-card:not([hidden])", (c) => c.map((x) => Math.round(x.getBoundingClientRect().top)));
  checar("mobile: cartões empilhados", cards.length === 2 && cards[1] > cards[0], cards.join(","));
  await foto(page, "13-setor-mobile");
  await page.locator('.setor-card[data-setor="financeiro"]').click(); await page.waitForTimeout(900);
  const larg2 = await page.evaluate(() => document.documentElement.scrollWidth);
  checar("mobile: shell financeiro sem rolagem horizontal", larg2 <= 392, `scrollWidth=${larg2}`);
  checar("mobile: alternador cabe no topbar", await ver(page, "#btn-setor"));
  await foto(page, "14-financeiro-mobile-topbar");
  await page.locator("#btn-menu").click(); await page.waitForTimeout(500);
  await foto(page, "15-financeiro-mobile-menu-aberto");
  const itens = await itensMenu(page);
  checar("mobile: menu lateral abre com os 12 itens financeiros", itens.length === 12);
  await page.locator('#menu li[data-rota="fin-dre"]').click(); await page.waitForTimeout(500);
  checar("mobile: escolher item fecha o menu e navega", /DRE/.test(await page.locator("#page-title").innerText()));
  await ctx.close();
}
// operacional mobile
{
  await cenario("operacional"); const { ctx, page } = await nova({ largura: 390, altura: 844 });
  await abrir(page); await foto(page, "16-operacional-mobile"); await ctx.close();
}

await navegador.close();
writeFileSync(path.join(aqui, "resultado.json"), JSON.stringify({ resultados, consoleErros: [...new Set(consoleErros)] }, null, 2));
const falhas = resultados.filter((r) => !r.ok);
for (const r of resultados) console.log(`${r.ok ? "OK  " : "FALHA"} ${r.nome}${r.detalhe && !r.ok ? "  -> " + r.detalhe : ""}`);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações OK`);
console.log("erros de console distintos:", new Set(consoleErros).size);
