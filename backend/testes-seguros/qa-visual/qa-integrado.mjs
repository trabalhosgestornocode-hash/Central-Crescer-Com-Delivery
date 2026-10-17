// QA VISUAL das telas financeiras INTEGRADAS (gate + domínio reais, dados sintéticos). Requer servidor-qa-integrado.mjs na 4174.
import { createRequire } from "node:module";
// ESM ignora NODE_PATH: o playwright-core fica FORA do repositório; QA_MODULOS aponta para a pasta que contém node_modules.
const { chromium } = createRequire(`${process.env.QA_MODULOS || process.cwd()}/`)("playwright-core");
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(aqui, "shots"); mkdirSync(SHOTS, { recursive: true });   // ignorado pelo git
const BASE = "http://127.0.0.1:4174";
const res = []; const erros = [];
const checar = (nome, ok, d = "") => res.push({ nome, ok: !!ok, d });
const api = (p) => fetch(BASE + p).then((r) => r.json());

// [rota, rótulo, implementada pelo Agente 2?]
const PAGINAS = [
  ["fin-visao-geral", "Visão Geral", true], ["fin-fluxo-de-caixa", "Fluxo de Caixa", true], ["fin-contas", "Contas Financeiras", true],
  ["fin-conciliacao", "Conciliação", true], ["fin-dre", "DRE Gerencial", true], ["fin-indicadores", "Indicadores", true],
  ["fin-categorias", "Análise de Categorias", true], ["fin-plano-de-contas", "Plano de Contas", true], ["fin-periodos", "Períodos", true],
  ["fin-importacao", "Importação", true], ["fin-relatorios", "Relatórios", true], ["fin-configuracoes", "Configurações Financeiras", true],
];

const nav = await chromium.launch({ executablePath: process.env.QA_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
async function nova({ largura = 1366, altura = 860, tema = "light" } = {}) {
  const ctx = await nav.newContext({ viewport: { width: largura, height: altura }, colorScheme: tema });
  await ctx.addInitScript((t) => { try { localStorage.setItem("cd.tema", t); } catch {} }, tema);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => erros.push(`PAGEERROR ${String(e.message).slice(0, 140)}`));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) erros.push(`console: ${m.text().slice(0, 140)}`); });
  return { ctx, page };
}
const ver = (page, s) => page.locator(s).first().isVisible().catch(() => false);
const foto = (page, n) => page.screenshot({ path: path.join(SHOTS, `${n}.png`) });
const texto = (page) => page.locator("#view").innerText();
const abrir = async (page) => { await page.goto(BASE + "/", { waitUntil: "load" }); await page.waitForTimeout(1500); };
const irPara = async (page, rota) => { await page.locator(`#menu li[data-rota="${rota}"]`).click(); await page.waitForTimeout(1100); };
const secoes = (page) => page.$$eval("#menu li.menu-secao", (l) => l.map((x) => x.textContent.trim()));

// ---------- 1. Somente financeiro: as 12 páginas, desktop ----------
await api("/qa/cenario?nome=financeiro"); await api("/qa/nivel?n=gestor");
{
  const { ctx, page } = await nova(); await abrir(page);
  checar("financeiro-only: entra direto na Visão Geral", (await ver(page, "#app")) && !(await ver(page, "#setor-screen")) && /Visão Geral/.test(await page.locator("#page-title").innerText()));
  for (const [rota, rotulo, implementada] of PAGINAS) {
    const antes = erros.length;
    await irPara(page, rota);
    const t = await texto(page);
    const construcao = /em construção/i.test(t);
    checar(`página "${rotulo}": ${implementada ? "implementada (não é 'Em construção')" : "'Em construção' (inexistente)"}`, implementada ? (!construcao && t.trim().length > 40) : construcao, t.slice(0, 80).replace(/\s+/g, " "));
    checar(`página "${rotulo}": sem 'undefined/NaN/[object' e sem erro de script`, !/undefined|NaN|\[object/.test(t) && erros.length === antes, erros.slice(antes).join(" | "));
    await foto(page, `30-${rota}-desktop`);
  }
  await ctx.close();
}

// ---------- 2. Mobile: nenhuma página estoura a largura; menu e topbar ----------
{
  const { ctx, page } = await nova({ largura: 390, altura: 844 }); await abrir(page);
  const estourou = [];
  for (const [rota, rotulo] of PAGINAS) {
    await page.locator("#btn-menu").click(); await page.waitForTimeout(350);
    await page.locator(`#menu li[data-rota="${rota}"]`).click(); await page.waitForTimeout(1000);
    const larg = await page.evaluate(() => document.documentElement.scrollWidth);
    if (larg > 392) estourou.push(`${rotulo}=${larg}`);
    await foto(page, `31-${rota}-mobile`);
  }
  checar("mobile: nenhuma das 12 páginas gera rolagem horizontal da PÁGINA", estourou.length === 0, estourou.join(", "));
  await ctx.close();
}

// ---------- 3. Tema escuro ----------
{
  const { ctx, page } = await nova({ tema: "dark" }); await abrir(page);
  for (const rota of ["fin-visao-geral", "fin-dre", "fin-contas"]) { await irPara(page, rota); await foto(page, `32-${rota}-escuro`); }
  checar("tema escuro aplicado nas páginas financeiras", (await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "dark");
  await ctx.close();
}

// ---------- 4. Níveis: leitura não vê ações de escrita ----------
await api("/qa/nivel?n=leitura");
{
  const { ctx, page } = await nova(); await abrir(page);
  await irPara(page, "fin-contas");
  const escritaContas = await page.locator("#view button", { hasText: /Nova conta|Nova|Criar|Salvar/ }).count();
  await irPara(page, "fin-plano-de-contas");
  const escritaPlano = await page.locator("#view button", { hasText: /Nova categoria|Nova|Criar|Salvar/ }).count();
  await irPara(page, "fin-importacao");
  const t = await texto(page);
  checar("leitura: contas/plano sem botões de criar/salvar", escritaContas === 0 && escritaPlano === 0, `contas=${escritaContas} plano=${escritaPlano}`);
  checar("leitura: importação informa falta de permissão (não oferece upload)", /Sem permissão para importar/.test(t) || (await page.locator('#view input[type="file"]').count()) === 0);
  await foto(page, "33-leitura-importacao");
  await ctx.close();
}
await api("/qa/nivel?n=gestor");

// ---------- 5. Ambos os setores, troca de unidade, estados vazios, revogação, erro de API ----------
await api("/qa/cenario?nome=ambos");
{
  const { ctx, page } = await nova(); await abrir(page);
  checar("ambos: pergunta o setor", await ver(page, "#setor-screen"));
  await page.locator('.setor-card[data-setor="financeiro"]').click(); await page.waitForTimeout(1300);
  checar("ambos: financeiro abre a Visão Geral com dados", !/em construção/i.test(await texto(page)) && (await texto(page)).length > 80);
  await foto(page, "34-ambos-financeiro");
  // troca de unidade (B sem dados): recalcula setores e mostra estado vazio
  await page.locator("#chip-unidade").click(); await page.waitForTimeout(300);
  await page.locator('.unidade-menu-item', { hasText: "Unidade B" }).click(); await page.waitForTimeout(1500);
  const noSetor = await ver(page, "#setor-screen");
  checar("troca de unidade: setores recalculados (volta a perguntar o setor)", noSetor);
  if (noSetor) { await page.locator('.setor-card[data-setor="financeiro"]').click(); await page.waitForTimeout(1300); }
  const tB = await texto(page);
  checar("unidade sem dados: estado vazio explícito (não mostra números inventados)", /sem lançamentos|sem dados|nenhum|vazio|não há|ainda não/i.test(tB), tB.slice(0, 120).replace(/\s+/g, " "));
  await foto(page, "35-unidade-b-vazia");
  // erro de API: a página trata e informa
  await api("/qa/falha?on=1");
  await irPara(page, "fin-dre");
  const tErro = await texto(page);
  checar("erro de API (500): a página informa o erro (não fica em branco nem quebra)", tErro.trim().length > 10 && /erro|falha|não foi possível|tente/i.test(tErro), tErro.slice(0, 120).replace(/\s+/g, " "));
  await foto(page, "36-erro-api");
  await api("/qa/falha?on=0");
  // alternador de setor e revogação imediata
  await api("/qa/cenario?nome=ambos");   // zera estados e volta à unidade A
  await ctx.close();
}
{
  const { ctx, page } = await nova(); await abrir(page);
  await page.locator('.setor-card[data-setor="financeiro"]').click(); await page.waitForTimeout(1200);
  await page.locator("#btn-setor").click(); await page.waitForTimeout(1200);
  checar("alternador: financeiro → operacional", (await secoes(page)).includes("OPERAÇÃO"));
  await page.locator("#btn-setor").click(); await page.waitForTimeout(1200);
  checar("alternador: operacional → financeiro", (await secoes(page)).join() === "FINANCEIRO");
  await api("/qa/revogar");
  await irPara(page, "fin-fluxo-de-caixa");
  await page.waitForTimeout(800);
  checar("revogação: a próxima navegação financeira cai no operacional (backend negou)", (await secoes(page)).includes("OPERAÇÃO") && !(await secoes(page)).includes("FINANCEIRO"));
  await foto(page, "37-revogado");
  await ctx.close();
}


// ---------- 5b. A8: conciliação, períodos, reabertura e cancelamento de transferência pela tela ----------
const mesAnt = (() => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
const botoes = async (page) => [...new Set(await page.$$eval("#view button", (b) => b.map((x) => x.textContent.trim().replace(/\s+/g, " ")).filter(Boolean)))];
await api("/qa/cenario?nome=financeiro"); await api("/qa/nivel?n=gestor");
{
  const { ctx, page } = await nova(); await abrir(page);
  await irPara(page, "fin-conciliacao");
  let t = await texto(page);
  checar("conciliação (mês sem referência): 'Sem referência' e nada presumido (sem números inventados)", /Sem referência/.test(t) && /Não inventamos dados ausentes/.test(t) && !/R\$\s*0,00\s*\(=\)\s*Diferença/.test(t), t.slice(0, 160).replace(/\s+/g, " "));
  await page.locator("#fin-mes").fill(mesAnt); await page.locator("#fin-mes").dispatchEvent("change"); await page.waitForTimeout(1200);
  t = await texto(page);
  checar("conciliação (mês com diferença): residual R$ 800,00 fica 'pendente de identificação' — NUNCA explicado como prazo sozinho", /800,00/.test(t) && /(pendente|identific)/i.test(t) && /nunca é presumido|Residual/i.test(t), t.slice(0, 220).replace(/\s+/g, " "));
  await foto(page, "40-conciliacao-pendente");
  const b = await botoes(page);
  checar("conciliação (gestor): ações de registrar referência e classificar disponíveis", b.some((x) => /Informar referências/.test(x)) && b.some((x) => /Classificar/.test(x)), b.join(" | "));

  await irPara(page, "fin-periodos");
  t = await texto(page);
  checar("períodos: mês fechado mostra snapshot e NÃO oferece reabrir (texto explicativo, sem botão)", /Fechado/.test(t) && (await botoes(page)).some((x) => /Ver snapshot/.test(x)) && !(await botoes(page)).some((x) => /^Reabrir/.test(x)) && /Reabrir exige autorização específica/.test(t));
  await foto(page, "41-periodos");
  await page.locator('#view tr:has-text("outubro/2026") button:has-text("Pré-fechamento")').first().click(); await page.waitForTimeout(1500);
  t = await texto(page);
  const bb = await botoes(page);
  checar("pré-fechamento de mês com pendências: mostra as pendências e o botão 'Fechar período' está DESABILITADO (política padrão)", /pendên/i.test(t) && (await page.locator('button:has-text("Fechar período")').first().isDisabled()), `${t.slice(0, 160).replace(/\s+/g, " ")} | ${bb.join(" | ")}`);
  await foto(page, "42-pre-fechamento-bloqueado");
  await ctx.close();
}
await api("/qa/nivel?n=leitura");
{
  const { ctx, page } = await nova(); await abrir(page);
  await irPara(page, "fin-periodos");
  const b = await botoes(page);
  checar("períodos (leitura): consulta e snapshot, sem abrir/aprovar política/fechar", !b.some((x) => /Abrir período|Aprovar fechamento/.test(x)) && b.some((x) => /Pré-fechamento/.test(x)), b.join(" | "));
  await irPara(page, "fin-contas");
  checar("contas (leitura): sem cancelar/desvincular transferência", !(await botoes(page)).some((x) => /Cancelar transferência|Desvincular/.test(x)));
  await ctx.close();
}
await api("/qa/nivel?n=operador");
{
  const { ctx, page } = await nova(); await abrir(page);
  await irPara(page, "fin-contas");
  const b = await botoes(page);
  checar("contas (operador): pode transferir, mas NÃO cancela nem desvincula transferência (exige cancelar/conciliar)", b.some((x) => /Transferir/.test(x)) && !b.some((x) => /Cancelar transferência|Desvincular/.test(x)), b.join(" | "));
  await ctx.close();
}
await api("/qa/nivel?n=gestor");
{
  const { ctx, page } = await nova(); await abrir(page);
  await irPara(page, "fin-contas");
  checar("contas (gestor): oferece cancelar e desvincular transferência", (await botoes(page)).some((x) => /Cancelar transferência/.test(x)) && (await botoes(page)).some((x) => /Desvincular/.test(x)));
  await page.locator('#view button:has-text("Cancelar transferência")').first().click(); await page.waitForTimeout(600);
  checar("cancelar transferência: o diálogo exige MOTIVO e explica que nada é excluído", (await page.locator('textarea[name="motivo"]').count()) === 1 && /não é excluíd|nao e excluid|cancelad/i.test(await page.locator("body").innerText()));
  await foto(page, "43-cancelar-transferencia-dialogo");
  await page.locator('textarea[name="motivo"]').fill("curto");
  await page.locator('form button[type="submit"], .fin-dialogo button.btn-primary, [role="dialog"] button.btn-primary, dialog button.btn-primary').last().click().catch(() => {}); await page.waitForTimeout(900);
  checar("motivo curto: continua sem cancelar (a transferência segue vinculada)", !(await texto(page)).match(/Cancelada/i) || (await page.locator('textarea[name="motivo"]').count()) === 1);
  await page.locator('textarea[name="motivo"]').fill("Repasse lançado em duplicidade").catch(() => {});
  await page.locator('form button[type="submit"], .fin-dialogo button.btn-primary, [role="dialog"] button.btn-primary, dialog button.btn-primary').last().click().catch(() => {}); await page.waitForTimeout(1500);
  const apos = await texto(page);
  checar("cancelar transferência com motivo: o par aparece como cancelado (preservado, não excluído)", /Cancelada/i.test(apos), apos.slice(0, 300).replace(/\s+/g, " "));
  await foto(page, "44-transferencia-cancelada");
  await ctx.close();
}

// ---------- 6. Acesso direto à API por cenário (o frontend não é a barreira) ----------
const { ctx: c6, page: p6 } = await nova(); await p6.goto(BASE + "/", { waitUntil: "load" });
const chamar = (rota) => p6.evaluate((r) => fetch(`/api/v1/gestao-financeira${r}`, { headers: { Authorization: "Bearer qa" } }).then(async (x) => ({ s: x.status, c: (await x.json().catch(() => ({})))?.details?.codigo })), rota);
for (const [cenario, esperado, codigo] of [["operacional", 403, "FINANCEIRO_SEM_CONCESSAO"], ["nenhum", 403, "FINANCEIRO_SEM_CONCESSAO"], ["impersonacao", 403, "FINANCEIRO_BLOQUEADO_IMPERSONACAO"], ["exibicao", 403, "FINANCEIRO_SEM_CONCESSAO"], ["financeiro", 200, undefined], ["ambos", 200, undefined]]) {
  await api(`/qa/cenario?nome=${cenario}`);
  const a = await chamar("/contas"), b = await chamar("/relatorios/visao-geral?de=2026-01-01&ate=2026-12-31"), s = await chamar("/status");
  checar(`URL direta (${cenario}): /contas, /relatorios e /status => ${esperado}${codigo ? " " + codigo : ""}`, [a, b, s].every((x) => x.s === esperado) && (!codigo || [a, b, s].every((x) => x.c === codigo)), JSON.stringify([a, b, s]));
}
await api("/qa/cenario?nome=ambos"); await api("/qa/revogar");
const rv = await chamar("/contas");
checar("URL direta (revogado): 403 imediato", rv.s === 403, JSON.stringify(rv));
await c6.close();
await nav.close();

writeFileSync(path.join(aqui, "resultado-integrado.json"), JSON.stringify({ res, erros: [...new Set(erros)] }, null, 2));
for (const x of res) console.log(`${x.ok ? "OK   " : "FALHA"} ${x.nome}${!x.ok && x.d ? "  -> " + x.d : ""}`);
console.log(`\n${res.filter((x) => x.ok).length}/${res.length} verificações OK · erros de script distintos: ${new Set(erros).size}`);
for (const e of new Set(erros)) console.log("  ", e);
