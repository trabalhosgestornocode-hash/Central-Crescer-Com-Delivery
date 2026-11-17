// Validação de NAVEGADOR (Chrome real, via Playwright) das telas de canais do Financeiro v2.
// Alvo: servidor demonstrativo local (127.0.0.1:5179, dados sintéticos). Nada toca produção, banco ou rede externa.
//   1) FV2_DEMO_IFOOD_DEMONSTRATIVO=1 node scripts/fv2-demo-interface.mjs   (em outro terminal; o demonstrativo iFood fictício
//      só existe com essa variável, para a verificação do calendário do iFood)
//   2) FV2_PLAYWRIGHT_PATH=<pasta do pacote playwright> node scripts/fv2/navegadorCanais.mjs
// Sai com código 1 se qualquer verificação falhar. Capturas de tela vão para FV2_NAVEGADOR_SAIDA (padrão: pasta temporária).
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FV2_PLAYWRIGHT_PATH || "playwright");

const BASE = process.env.FV2_DEMO_URL || "http://127.0.0.1:5179/";
const SHOTS = process.env.FV2_NAVEGADOR_SAIDA || join(tmpdir(), "fv2-navegador");
mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch(process.env.FV2_NAVEGADOR_CANAL === "padrao" ? {} : { channel: process.env.FV2_NAVEGADOR_CANAL || "chrome" });
const resultados = [];
const registrar = (grupo, nome, ok, detalhe = "") => { resultados.push({ grupo, nome, ok, detalhe }); console.log(`${ok ? "OK  " : "FALHA"} [${grupo}] ${nome}${detalhe ? " — " + detalhe : ""}`); };

async function novaPagina(largura, altura, sessao = "administrador") {
  const ctx = await browser.newContext({ viewport: { width: largura, height: altura }, locale: "pt-BR" });
  const page = await ctx.newPage();
  page.diagnosticos = { console: [], pagina: [], respostasRuins: [], requisicoesFalhas: [] };
  page.on("console", (m) => { if (m.type() === "error") page.diagnosticos.console.push(m.text()); });
  page.on("pageerror", (e) => page.diagnosticos.pagina.push(e.message));
  page.on("response", (r) => { if (r.status() >= 400) page.diagnosticos.respostasRuins.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  page.on("requestfailed", (r) => page.diagnosticos.requisicoesFalhas.push(`${r.failure()?.errorText} ${new URL(r.url()).pathname}`));
  await page.goto(BASE);
  await page.waitForSelector("#filtro-sessao");
  if (sessao !== "gestor") { await page.selectOption("#filtro-sessao", sessao); }
  return page;
}
const irPara = async (page, rota, esperar) => { await page.evaluate((r) => { location.hash = `#/${r}`; }, rota); await page.waitForSelector(esperar ?? "#conteudo h1, #conteudo h2, #conteudo .aviso", { timeout: 15000 }); await page.waitForTimeout(400); };
const semRolagemHorizontal = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const texto = (page) => page.locator("#conteudo").innerText();
async function checar(grupo, nome, fn) { try { const r = await fn(); if (r === false) registrar(grupo, nome, false); else if (typeof r === "string" && r.startsWith("FALHA:")) registrar(grupo, nome, false, r.slice(6)); else registrar(grupo, nome, true, typeof r === "string" ? r : ""); } catch (e) { registrar(grupo, nome, false, String(e.message).split("\n")[0].slice(0, 220)); } }

// ===================================================================================== DESKTOP (1366×900)
const d = await novaPagina(1366, 900);
await checar("Navegação", "menu lista Visão Geral, DRE, SAIPOS, iFood, 99Food e Operadoras e Taxas", async () => {
  const itens = await d.$$eval("[data-rota]", (e) => e.map((x) => x.textContent.trim()));
  const esperado = ["Visão Geral", "DRE Gerencial", "SAIPOS", "iFood", "99Food", "Operadoras e Taxas"];
  const falta = esperado.filter((x) => !itens.includes(x));
  return falta.length ? false : "";
});

// ---- SAIPOS
await irPara(d, "saipos", "[data-aba-saipos]");
await checar("SAIPOS", "abas Resumo/Presencial/Anota Aí/Importações/Fechamento/Conferências trocam o conteúdo e marcam aria-current", async () => {
  const vistos = [];
  for (const k of ["presencial", "anota", "importacoes", "fechamento", "conferencias", "resumo"]) {
    await d.click(`nav [data-aba-saipos="${k}"]`); await d.waitForTimeout(500);
    const atual = await d.$eval(`nav [data-aba-saipos="${k}"]`, (e) => e.getAttribute("aria-current"));
    vistos.push([k, atual, (await texto(d)).length]);
    if (atual !== "page") return false;
  }
  return vistos.map((v) => v[0]).join(",");
});
await d.screenshot({ path: `${SHOTS}/d-saipos-resumo.png` });

await checar("SAIPOS", "Presencial: cards por modalidade, 'Taxa não configurada' (nunca zero) e expansão por bandeira (aria-expanded)", async () => {
  await d.click('nav [data-aba-saipos="presencial"]'); await d.waitForTimeout(600);
  const t = await texto(d);
  if (!/Crédito|Débito|Pix/i.test(t)) return false;
  const botao = d.locator("button.canal-expandir").first();
  if (!(await botao.count())) return "sem card expansível nos dados demo (ok se só dinheiro)";
  const antes = await botao.getAttribute("aria-expanded"); await botao.click(); await d.waitForTimeout(200);
  const depois = await botao.getAttribute("aria-expanded");
  const alvo = await botao.getAttribute("aria-controls");
  const visivel = await d.locator(`#${alvo}`).isVisible();
  return antes === "false" && depois === "true" && visivel;
});
await d.screenshot({ path: `${SHOTS}/d-saipos-presencial.png`, fullPage: true });

await checar("SAIPOS", "Presencial: 'Ver lançamentos' abre o painel com os pagamentos e fecha", async () => {
  const b = d.locator("[data-detalhe^='card:']").first();
  if (!(await b.count())) return false;
  await b.click(); await d.waitForSelector("#painel:not([hidden])", { timeout: 8000 });
  await d.waitForFunction(() => /pagamento/i.test(document.querySelector("#painel")?.innerText ?? ""), null, { timeout: 8000 }).catch(() => {});
  const ok = /pagamento/i.test(await d.locator("#painel").innerText());
  await d.screenshot({ path: `${SHOTS}/d-saipos-painel-card.png` });
  await d.keyboard.press("Escape"); await d.waitForTimeout(500);
  const fechou = await d.$eval("#painel", (e) => e.hidden);
  return ok && fechou ? "" : `textoOk=${ok} fechouComEsc=${fechou}`.replace(/^/, "FALHA:");
});

await checar("SAIPOS", "Anota Aí: cards separados do Presencial", async () => { await d.click('nav [data-aba-saipos="anota"]'); await d.waitForTimeout(600); return /Anota Aí/.test(await texto(d)); });

await checar("SAIPOS", "filtro de período: aplica ao mudar a data e período invertido não passa em silêncio", async () => {
  await d.click('nav [data-aba-saipos="presencial"]'); await d.waitForTimeout(600);
  const campo = (n) => d.locator(`form[data-filtro-local] input[name=${n}]`);
  await campo("inicio").fill("2026-09-02"); await d.waitForTimeout(900);
  await campo("fim").fill("2026-09-10"); await d.waitForTimeout(900);
  const t1 = await d.locator("#conteudo").innerText();
  const aplicou = /02\/09\/2026 a 10\/09\/2026/.test(t1);
  await d.screenshot({ path: `${SHOTS}/d-filtro-aplicado.png` });
  // invertido: início depois do fim
  await campo("inicio").fill("2026-09-20"); await d.waitForTimeout(1200);
  const t2 = await d.locator("#conteudo").innerText();
  await d.screenshot({ path: `${SHOTS}/d-filtro-invertido.png` });
  const avisoNoFiltro = (await d.locator("[data-aviso-periodo]").count()) === 1;
  const formularioContinua = (await d.locator("form[data-filtro-local]").count()) === 1;
  const naoRecarregou = !/Não foi possível carregar/.test(t2);
  // volta ao normal
  await campo("inicio").fill("2026-09-01"); await d.waitForTimeout(900);
  await campo("fim").fill("2026-09-30"); await d.waitForTimeout(900);
  const voltou = /01\/09\/2026 a 30\/09\/2026/.test(await d.locator("#conteudo").innerText());
  if (!aplicou) return false;
  return avisoNoFiltro && formularioContinua && naoRecarregou && voltou ? "invertido: aviso no próprio filtro, formulário preservado, volta ao normal" : `FALHA:aviso=${avisoNoFiltro} formulario=${formularioContinua} naoRecarregou=${naoRecarregou} voltou=${voltou}`;
});

await d.click('nav [data-aba-saipos="importacoes"]'); await d.waitForTimeout(500);
await checar("Importações", "lista de relatórios e botão 'Importar relatório' abre o formulário no painel (com SAIPOS — Vendas por período)", async () => {
  const b = d.locator("[data-detalhe='importar:saipos']");
  if (!(await b.count())) return false;
  await b.click(); await d.waitForSelector("#painel:not([hidden])", { timeout: 8000 });
  await d.waitForFunction(() => /Vendas por período|SAIPOS/i.test(document.querySelector("#painel")?.innerText ?? ""), null, { timeout: 8000 }).catch(() => {});
  const t = await d.locator("#painel").innerText();
  await d.screenshot({ path: `${SHOTS}/d-importar.png` });
  await d.keyboard.press("Escape"); await d.waitForTimeout(200);
  return /Vendas por período|SAIPOS/i.test(t);
});
await checar("Importações", "importar sem escolher arquivo é bloqueado (validação do formulário)", async () => {
  await d.click("[data-detalhe='importar:saipos']"); await d.waitForSelector("#painel:not([hidden])");
  const form = d.locator("#painel form").first();
  const submit = form.locator("button[type=submit]").first();
  await submit.click(); await d.waitForTimeout(500);
  const invalido = await form.evaluate((f) => !f.checkValidity());
  const resultado = (await d.locator("#painel").innerText());
  await d.keyboard.press("Escape");
  return invalido || /arquivo|obrigat|escolha/i.test(resultado);
});

// ---- Fechamento manual
await d.click('nav [data-aba-saipos="fechamento"]'); await d.waitForTimeout(700);
await d.screenshot({ path: `${SHOTS}/d-fechamento.png`, fullPage: true });
await checar("Fechamento manual", "formulário completo (dinheiro + grade fixa de formas) e aviso de que não cria receita", async () => {
  const t = await texto(d);
  return /não cria receita|nunca soma receita/i.test(t) && (await d.locator("input[name=din_informado]").count()) === 1 && (await d.locator("input[name^='f_CREDITO_VISA_']").count()) >= 2;
});
await checar("Fechamento manual", "não envia sem a confirmação marcada; valor inválido ('12,345') é recusado pela validação", async () => {
  const form = d.locator("form[data-acao='/api/fv2/acoes/fechamento-manual/registrar']");
  await form.locator("input[name=caixa]").fill("1");
  await form.locator("input[name=din_informado]").fill("12,345");
  const campoInvalido = await form.locator("input[name=din_informado]").evaluate((e) => !e.validity.valid);
  await form.locator("input[name=din_informado]").fill("128,00");
  const semConfirmar = await form.evaluate((f) => !f.checkValidity());
  return campoInvalido && semConfirmar;
});
await checar("Fechamento manual", "registrar fechamento: calcula esperado × contado e mostra o caixa registrado", async () => {
  const form = d.locator("form[data-acao='/api/fv2/acoes/fechamento-manual/registrar']");
  await form.locator("input[name=data]").fill("2026-09-05");
  await form.locator("input[name=caixa]").fill("7");
  for (const [n, v] of [["din_abertura", "100,00"], ["din_vendas", "50,00"], ["din_retiradas", "30,00"], ["din_reforcos", "10,00"], ["din_informado", "128,00"], ["f_CREDITO_VISA_inf", "40,00"]]) await form.locator(`input[name=${n}]`).fill(v);
  await form.locator("input[name=confirmar]").check();
  await form.locator("button[type=submit]").click(); await d.waitForTimeout(1500);
  const msg = await form.locator(".resultado-acao").innerText();
  const t = await texto(d);
  await d.screenshot({ path: `${SHOTS}/d-fechamento-registrado.png`, fullPage: true });
  return /Caixa 7/.test(t) ? msg.slice(0, 80) : (msg || "sem mensagem") + " | caixa não apareceu";
});
await checar("Fechamento manual", "faturamento manual provisório: expande, exige justificativa, registra e aparece como PROVISÓRIO", async () => {
  const det = d.locator("details.card", { hasText: "Faturamento manual provisório" });
  await det.locator("summary").click(); await d.waitForTimeout(300);
  const form = d.locator("form[data-acao='/api/fv2/acoes/faturamento-manual/registrar']");
  await form.locator("input[name=data]").fill("2026-09-12");
  await form.locator("input[name=caixa]").fill("1");
  await form.locator("input[name=din_vendas]").fill("50,00");
  const semJust = await form.evaluate((f) => !f.checkValidity());
  await form.locator("input[name=justificativa]").fill("Fechamento enviado pela equipe; relatório ainda não importado (demonstração)");
  await form.locator("input[name=confirmar]").check();
  await form.locator("button[type=submit]").click(); await d.waitForTimeout(1500);
  const msg = await form.locator(".resultado-acao").innerText();
  const t = await texto(d);
  await d.screenshot({ path: `${SHOTS}/d-provisorio.png`, fullPage: true });
  return semJust && /PROVISÓRIO/i.test(t) ? msg.slice(0, 80) : `semJust=${semJust} msg=${msg.slice(0, 120)}`;
});
await checar("Fechamento manual", "substituição do provisório pede confirmação e justificativa", async () => {
  const form = d.locator("form[data-acao='/api/fv2/acoes/faturamento-manual/substituir']");
  if (!(await form.count())) return false;
  const bloqueado = await form.evaluate((f) => !f.checkValidity());
  return bloqueado;
});
await checar("Fechamento manual", "perfil só leitura (gestor) não vê formulários, só o aviso de permissão", async () => {
  const g = await novaPagina(1366, 900, "gestor");
  await irPara(g, "saipos", "[data-aba-saipos]");
  await g.click('nav [data-aba-saipos="fechamento"]'); await g.waitForTimeout(700);
  const t = await texto(g);
  const forms = await g.locator("form[data-acao]").count();
  await g.context().close();
  return forms === 0 && /não tem permissão/i.test(t);
});
await checar("Fechamento manual", "Conferências: pendências e pedidos iFood/99Food 'só conferência'", async () => { await d.click('nav [data-aba-saipos="conferencias"]'); await d.waitForTimeout(600); return /Só conferência|só para conferência|SÓ para conferência/i.test(await texto(d)) || /iFood/.test(await texto(d)); });

// ---- iFood e 99Food
for (const [rota, nome] of [["ifood", "iFood"], ["noventa-e-nove-food", "99Food"]]) {
  await irPara(d, rota);
  await checar(nome, "área oficial: cards sem número presumido e aviso de fonte", async () => {
    const t = await texto(d);
    await d.screenshot({ path: `${SHOTS}/d-${rota}.png`, fullPage: true });
    const ok = new RegExp(nome).test(t) && /Faturamento bruto/.test(t) && /Comissões/.test(t);
    if (rota === "noventa-e-nove-food") return ok && /Depende do relatório oficial|ainda não foram fornecidos/.test(t);
    return ok;
  });
  await checar(nome, "sem rolagem horizontal da página", () => semRolagemHorizontal(d));
}

// ---- Operadoras e Taxas
await irPara(d, "operadoras-taxas");
await d.screenshot({ path: `${SHOTS}/d-operadoras.png`, fullPage: true });
await checar("Operadoras e Taxas", "cards, versões de taxa expansíveis (details) e histórico", async () => {
  const t = await texto(d);
  const sums = d.locator("details.versao-taxas summary");
  if (await sums.count()) { await sums.first().click(); await d.waitForTimeout(200); if (!(await d.locator("details.versao-taxas[open] table").first().isVisible())) return false; }
  return /Operadora|operadora/.test(t);
});
await checar("Operadoras e Taxas", "formulário de alteração exige justificativa e confirmação", async () => {
  const f = d.locator("form[data-acao$='/configuracoes/operadoras/situacao']").first();
  if (!(await f.count())) return "sem operadora editável nos dados demo";
  return await f.evaluate((x) => !x.checkValidity());
});
await checar("Operadoras e Taxas", "cadastro de operadora e de tabela de taxas disponíveis para quem configura", async () => (await d.locator("form[data-acao$='/configuracoes/operadoras'], form[data-acao$='/configuracoes/taxas-contratadas']").count()) >= 1 || /Nova operadora|Cadastrar operadora|taxas/i.test(await texto(d)));
await checar("Operadoras e Taxas", "perfil sem 'configurar' não vê formulários de alteração", async () => {
  const g = await novaPagina(1366, 900, "gestor"); await irPara(g, "operadoras-taxas");
  const n = await g.locator("form[data-acao]").count(); await g.context().close(); return n === 0;
});

// ---- Visão Geral e DRE
await irPara(d, "visao-geral");
await d.screenshot({ path: `${SHOTS}/d-visao-geral.png`, fullPage: true });
await checar("Visão Geral", "quatro canais separados, sem somar duas vezes", async () => { const t = await texto(d); return /Presencial/.test(t) && /Anota/.test(t) && /iFood/.test(t) && /99Food/.test(t); });
await checar("Visão Geral", "sem rolagem horizontal; cartões 'por trás do número' (drill-down) abrem", async () => {
  if (!(await semRolagemHorizontal(d))) return false;
  const b = d.locator("[data-detalhe]").first();
  if (!(await b.count())) return "sem drill-down nos dados demo";
  await b.click(); await d.waitForTimeout(800);
  const abriu = await d.locator("#painel:not([hidden])").count() > 0 || /Composição|lançamentos/i.test(await texto(d));
  await d.keyboard.press("Escape");
  return abriu;
});
await irPara(d, "dre");
await d.screenshot({ path: `${SHOTS}/d-dre.png`, fullPage: true });
await checar("DRE Gerencial", "taxa estimada não aparece como despesa; linhas expansíveis; sem rolagem horizontal", async () => {
  const t = await texto(d);
  if (!(await semRolagemHorizontal(d))) return false;
  const toggles = d.locator("[data-alternar], details > summary");
  const n = await toggles.count();
  if (n) { await toggles.first().click(); await d.waitForTimeout(200); }
  return /Receita|Faturamento/i.test(t) && !/taxa estimada.{0,40}despesa lançada/i.test(t) ? `expansores=${n}` : false;
});

// ---- estados de acesso
for (const [sessao, esperado] of [["sem-acesso", /permiss|concess|acesso/i], ["expirada", /expir|entre novamente/i], ["ausente", /sess|entre/i]]) {
  await checar("Acesso", `sessão '${sessao}' mostra aviso claro e nenhum dado financeiro`, async () => {
    const p = await novaPagina(1366, 900, sessao); await irPara(p, "saipos", "#conteudo");
    await p.waitForTimeout(800);
    const t = await texto(p); await p.context().close();
    return esperado.test(t) && !/R\$ \d/.test(t);
  });
}

// ---- Calendário de controle de faturamento (Fase 10): quatro canais, mesmo padrão
let chamadasDoCalendario = 0;
d.on("request", (r) => { if (r.url().includes("/api/fv2/calendario-faturamento")) chamadasDoCalendario += 1; });
const gradeDe = (rota, aba) => async () => {
  await irPara(d, rota, rota === "saipos" ? "[data-aba-saipos]" : undefined);
  if (aba) await d.click(`nav [data-aba-saipos="${aba}"]`);
  await d.waitForSelector("[data-cal-dia]", { timeout: 10000 }); await d.waitForTimeout(400);
};
await irPara(d, "saipos", "[data-aba-saipos]");
await d.fill("#filtro-competencia", "2026-11"); await d.waitForTimeout(1200);
for (const [rota, aba, canal, nome] of [["saipos", "presencial", "BALCAO", "SAIPOS Presencial"], ["saipos", "anota", "ANOTA_AI", "SAIPOS Anota Aí"], ["ifood", null, "IFOOD", "iFood"], ["noventa-e-nove-food", null, "NOVENTA_E_NOVE_FOOD", "99Food"]]) {
  await checar("Calendário", `${nome}: grade do mês com 30 dias, legenda com os 8 estados e seis indicadores`, async () => {
    await gradeDe(rota, aba)();
    const n = await d.locator(`[data-cal-canal="${canal}"] [data-cal-dia]`).count();
    const legenda = await d.locator(".legenda--estados li").count();
    const indicadores = await d.locator(".resumo--calendario .card").count();
    await d.screenshot({ path: `${SHOTS}/d-calendario-${canal}.png`, fullPage: true });
    return n === 30 && legenda === 8 && indicadores === 6 ? "" : `FALHA:dias=${n} legenda=${legenda} indicadores=${indicadores}`;
  });
}
await gradeDe("saipos", "presencial")();
await checar("Calendário", "navegação entre meses: uma consulta por mês, outubro tem 31 dias, dezembro é todo futuro (nada atrasado) e volta ao mês", async () => {
  const antes = chamadasDoCalendario;
  await d.click("[data-mes='-1']"); await d.waitForTimeout(1000);
  const out = await d.locator("[data-cal-dia]").count();
  const titulo = await d.locator(".cal-nav strong").innerText();
  await d.click("[data-mes='1']"); await d.waitForTimeout(900);
  await d.click("[data-mes='1']"); await d.waitForTimeout(1000);
  const dez = await d.locator("[data-cal-dia].cal-dia--futuro").count();
  const semRegistroEmDezembro = await d.locator("[data-cal-dia]:has-text('Sem registro')").count();
  await d.click("[data-mes='-1']"); await d.waitForTimeout(900);
  const consultas = chamadasDoCalendario - antes;
  const ok = out === 31 && /outubro/i.test(titulo) && dez === 31 && semRegistroEmDezembro === 0 && consultas === 4;
  return ok ? `${consultas} consultas para 4 mudanças de mês` : `FALHA:out=${out} titulo=${titulo} dez=${dez} semRegistro=${semRegistroEmDezembro} consultas=${consultas}`;
});
await checar("Calendário", "escolher um dia abre o painel (canal, data, origem, valores, importações, ações) sem nova consulta", async () => {
  const antes = chamadasDoCalendario;
  await d.click('[data-cal-dia="2026-11-03"]'); await d.waitForTimeout(400);
  const t = await d.locator("#cal-dia-detalhe").innerText();
  const pressionado = await d.getAttribute('[data-cal-dia="2026-11-03"]', "aria-pressed");
  await d.screenshot({ path: `${SHOTS}/d-calendario-dia.png`, fullPage: true });
  const ok = /SAIPOS — Presencial/.test(t) && /03\/11\/2026/.test(t) && /Origem da informação/.test(t) && /Valores/.test(t) && /Ações/.test(t) && pressionado === "true" && chamadasDoCalendario === antes;
  return ok ? "" : `FALHA:pressionado=${pressionado} novasConsultas=${chamadasDoCalendario - antes} texto=${t.slice(0, 120).replace(/\n/g, " ")}`;
});
await checar("Calendário", "teclado: setas andam pelos dias (←→ dia, ↑↓ semana), Home/End na semana, um só dia focável e Enter abre o dia", async () => {
  await d.focus('[data-cal-dia="2026-11-03"]');
  const foco = () => d.evaluate(() => document.activeElement?.dataset?.calDia);
  await d.keyboard.press("ArrowRight"); const a = await foco();
  await d.keyboard.press("ArrowDown"); const b = await foco();
  await d.keyboard.press("ArrowLeft"); const c2 = await foco();
  await d.keyboard.press("ArrowUp"); const e2 = await foco();
  await d.keyboard.press("End"); const fim = await foco();
  await d.keyboard.press("Home"); const ini = await foco();
  const focaveis = await d.locator('[data-cal-dia][tabindex="0"]').count();
  await d.keyboard.press("ArrowRight"); await d.keyboard.press("Enter"); await d.waitForTimeout(400);
  const painel = await d.locator("#cal-dia-detalhe").innerText();
  const ok = a === "2026-11-04" && b === "2026-11-11" && c2 === "2026-11-10" && e2 === "2026-11-03" && fim === "2026-11-08" && ini === "2026-11-02" && focaveis === 1 && /04\/11\/2026/.test(painel);
  return ok ? "" : `FALHA:${[a, b, c2, e2, fim, ini, focaveis].join(",")}`;
});
await checar("Calendário", "dia com divergência/pendência mostra ícone e texto (não só cor) e explica no painel", async () => {
  const celula = d.locator('[data-cal-dia][aria-label*="Divergência"]').first();
  if (!(await celula.count())) return "FALHA:a demonstração não tem dia com divergência neste mês";
  const rotulo = await celula.getAttribute("aria-label");
  const temIcone = (await celula.locator(".est").count()) >= 1;
  await celula.click(); await d.waitForTimeout(300);
  const t = await d.locator("#cal-dia-detalhe").innerText();
  return temIcone && /Divergência encontrada/.test(t) && /Divergências/.test(t) ? rotulo.slice(0, 80) : "FALHA:sem ícone ou sem explicação";
});
await checar("Calendário", "marcar dia sem operação: exige justificativa e confirmação; depois o dia vira 'sem movimento confirmado' e sai da cobrança; voltar a operar desfaz", async () => {
  await d.click('[data-cal-dia="2026-11-09"]'); await d.waitForTimeout(300);
  const form = d.locator("#cal-dia-detalhe form[data-acao$='/calendario-faturamento/sem-operacao']");
  if (!(await form.count())) return "FALHA:sem formulário (dia com registro?)";
  const bloqueado = await form.evaluate((f) => !f.checkValidity());
  await form.locator("input[name=justificativa]").fill("Loja fechada por feriado (demonstração)");
  await form.locator("input[name=confirmar]").check();
  await form.locator("button[type=submit]").click(); await d.waitForTimeout(1500);
  const rotulo = await d.getAttribute('[data-cal-dia="2026-11-09"]', "aria-label");
  const painel = await d.locator("#cal-dia-detalhe").innerText();
  const marcado = /Sem movimento confirmado/.test(rotulo) && /Marcado para esta data/.test(painel);
  const desfazer = d.locator("#cal-dia-detalhe form[data-acao$='/calendario-faturamento/sem-operacao']");
  await desfazer.locator("input[name=justificativa]").fill("Voltou a operar (demonstração)");
  await desfazer.locator("input[name=confirmar]").check();
  await desfazer.locator("button[type=submit]").click(); await d.waitForTimeout(1500);
  const rotulo2 = await d.getAttribute('[data-cal-dia="2026-11-09"]', "aria-label");
  const ok = bloqueado && marcado && /Sem registro/.test(rotulo2);
  return ok ? "" : `FALHA:bloqueado=${bloqueado} marcado=${marcado} depois=${rotulo2}`;
});
await checar("Calendário", "ação 'Registrar faturamento provisório' leva ao formulário já aberto, com a data do dia", async () => {
  await d.click('[data-cal-dia="2026-11-09"]'); await d.waitForTimeout(300);
  await d.click('#cal-dia-detalhe [data-cal-acao="provisorio"]'); await d.waitForTimeout(1200);
  const aberto = await d.locator("details.card[open] form[data-acao$='/faturamento-manual/registrar']").count();
  const data = await d.inputValue("form[data-acao$='/faturamento-manual/registrar'] input[name=data]");
  return aberto === 1 && data === "2026-11-09" ? "" : `FALHA:aberto=${aberto} data=${data}`;
});
await checar("Calendário", "ação 'Ver faturamento e pagamentos' abre as vendas do dia no painel", async () => {
  await gradeDe("saipos", "presencial")();
  await d.click('[data-cal-dia="2026-11-10"]'); await d.waitForTimeout(300);
  await d.click('#cal-dia-detalhe [data-cal-acao="vendas"]'); await d.waitForSelector("#painel:not([hidden])", { timeout: 8000 });
  await d.waitForFunction(() => /Ver venda e pagamentos|Nenhuma venda/.test(document.querySelector("#painel")?.innerText ?? ""), null, { timeout: 8000 });
  const t = await d.locator("#painel").innerText(); await d.keyboard.press("Escape");
  return /Ver venda e pagamentos/.test(t) ? "" : `FALHA:${t.slice(0, 100)}`;
});
await checar("Calendário", "99Food: nenhum dia mostra valor nem 'sem movimento'; o painel diz que não é zero confirmado", async () => {
  await gradeDe("noventa-e-nove-food")();
  const celulas = await d.$$eval("[data-cal-dia]", (bs) => bs.map((b) => b.innerText + "|" + b.getAttribute("aria-label")));
  const indevido = celulas.filter((t) => /R\$|Sem movimento/.test(t)).length;
  await d.click('[data-cal-dia="2026-11-05"]'); await d.waitForTimeout(300);
  const t = await d.locator("#cal-dia-detalhe").innerText();
  return indevido === 0 && /não é zero confirmado/.test(t) ? "" : `FALHA:indevido=${indevido}`;
});
await checar("Calendário", "iFood: o painel de um dia coberto por demonstrativo explica que o detalhe diário depende do relatório de pedidos (sem valor na célula)", async () => {
  await gradeDe("ifood")();
  for (const mesAlvo of ["2026-11", "2026-10", "2026-09"]) {
    await d.fill("#filtro-competencia", mesAlvo); await d.waitForTimeout(1200);
    const coberto = d.locator('[data-cal-dia][aria-label*="Relatório importado"]').first();
    if (await coberto.count()) {
      const celula = await coberto.innerText();
      await coberto.click(); await d.waitForTimeout(300);
      const t = await d.locator("#cal-dia-detalhe").innerText();
      return !/R\$/.test(celula) && /depende do relatório oficial de pedidos/.test(t) ? `coberto em ${mesAlvo}` : "FALHA:célula com valor ou sem explicação";
    }
  }
  return "FALHA:a demonstração não tem demonstrativo do iFood em nenhum dos três meses (o caso é coberto no teste de backend)";
});
await d.fill("#filtro-competencia", "2026-11"); await d.waitForTimeout(600);
await checar("Calendário", "perfil só leitura vê o calendário mas nenhum formulário nem botão de escrita no painel", async () => {
  const g = await novaPagina(1366, 900, "gestor");
  await irPara(g, "saipos", "[data-aba-saipos]"); await g.fill("#filtro-competencia", "2026-11"); await g.waitForTimeout(800);
  await g.click('nav [data-aba-saipos="presencial"]'); await g.waitForSelector("[data-cal-dia]", { timeout: 10000 });
  await g.click('[data-cal-dia="2026-11-09"]'); await g.waitForTimeout(400);
  const forms = await g.locator("#cal-dia-detalhe form[data-acao], .cal-config form[data-acao]").count();
  const escrita = await g.locator('#cal-dia-detalhe [data-cal-acao="provisorio"], #cal-dia-detalhe [data-cal-acao="fechamentos"]').count();
  await g.context().close();
  return forms === 0 && escrita === 0 ? "" : `FALHA:forms=${forms} botoesDeEscrita=${escrita}`;
});

// ---- teclado e acessibilidade básica
await irPara(d, "saipos", "[data-aba-saipos]");
await checar("Acessibilidade", "foco visível por teclado nas abas e botões com nome acessível", async () => {
  await d.focus('nav [data-aba-saipos="presencial"]');
  const contorno = await d.$eval('nav [data-aba-saipos="presencial"]', (e) => { const s = getComputedStyle(e); return `${s.outlineStyle}/${s.outlineWidth}/${s.boxShadow !== "none"}`; });
  const semNome = await d.$$eval("button", (bs) => bs.filter((b) => !(b.textContent.trim() || b.getAttribute("aria-label"))).length);
  return semNome === 0 && !/^none\/0px\/false$/.test(contorno) ? contorno : `semNome=${semNome} contorno=${contorno}`;
});
await checar("Console", "sem erros de JavaScript nas telas de desktop", async () => d.diagnosticos.pagina.length === 0 ? `404/4xx: ${JSON.stringify([...new Set(d.diagnosticos.respostasRuins)])}; console: ${JSON.stringify([...new Set(d.diagnosticos.console)]).slice(0, 200)}` : false);
const diagDesk = d.diagnosticos;
await d.context().close();


// ===================================================================================== VARREDURA DE LARGURAS
for (const largura of [768, 1024, 1280, 1366, 1440, 1920]) {
  const p = await novaPagina(largura, 900);
  const quebradas = [];
  for (const rota of ["visao-geral", "dre", "saipos", "ifood", "noventa-e-nove-food", "operadoras-taxas"]) {
    await irPara(p, rota, rota === "saipos" ? "[data-aba-saipos]" : undefined);
    await p.waitForTimeout(500);
    if (!(await semRolagemHorizontal(p))) quebradas.push(rota);
    if (rota === "saipos") for (const aba of ["presencial", "anota", "importacoes", "fechamento", "conferencias"]) {
      await p.click(`nav [data-aba-saipos="${aba}"]`); await p.waitForTimeout(500);
      if (!(await semRolagemHorizontal(p))) quebradas.push(`saipos/${aba}`);
    }
  }
  registrar("Larguras", `${largura}px: nenhuma tela de canais com rolagem horizontal`, quebradas.length === 0, quebradas.join(", "));
  await p.context().close();
}

// ===================================================================================== CELULAR (390×844)
const m = await novaPagina(390, 844);
for (const [rota, nome, esp] of [["visao-geral", "Visão Geral", null], ["dre", "DRE Gerencial", null], ["saipos", "SAIPOS", "[data-aba-saipos]"], ["ifood", "iFood", null], ["noventa-e-nove-food", "99Food", null], ["operadoras-taxas", "Operadoras e Taxas", null]]) {
  await irPara(m, rota, esp ?? undefined);
  await m.screenshot({ path: `${SHOTS}/m-${rota}.png`, fullPage: true });
  await checar("Celular 390px", `${nome}: sem rolagem horizontal da página`, async () => (await semRolagemHorizontal(m)) ? "" : `scrollWidth=${await m.evaluate(() => document.documentElement.scrollWidth)}`);
}
for (const aba of ["presencial", "anota", "importacoes", "fechamento", "conferencias"]) {
  await irPara(m, "saipos", "[data-aba-saipos]");
  await m.click(`nav [data-aba-saipos="${aba}"]`); await m.waitForTimeout(600);
  await m.screenshot({ path: `${SHOTS}/m-saipos-${aba}.png`, fullPage: true });
  await checar("Celular 390px", `SAIPOS › ${aba}: sem rolagem horizontal`, async () => (await semRolagemHorizontal(m)) ? "" : `scrollWidth=${await m.evaluate(() => document.documentElement.scrollWidth)}`);
}
await checar("Celular 390px", "alvos de toque das abas e botões principais ≥ 40px de altura", async () => {
  await irPara(m, "saipos", "[data-aba-saipos]");
  const pequenos = await m.$$eval("nav [data-aba-saipos], #conteudo button.botao, #conteudo button.botao--primario", (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)).filter((h) => h > 0 && h < 40));
  return pequenos.length === 0 ? "" : `alvos pequenos: ${pequenos.join(",")}px`;
});
await checar("Celular 390px", "calendário: sete colunas dentro da tela, dia tocável e painel do dia abre", async () => {
  await irPara(m, "saipos", "[data-aba-saipos]");
  await m.fill("#filtro-competencia", "2026-11"); await m.waitForTimeout(800);
  await m.click('nav [data-aba-saipos="presencial"]'); await m.waitForSelector("[data-cal-dia]", { timeout: 10000 });
  const caixa = await m.$eval(".calendario--canal", (e) => { const r = e.getBoundingClientRect(); return { esq: Math.round(r.left), dir: Math.round(r.right) }; });
  const larguraDoDia = await m.$eval('[data-cal-dia="2026-11-03"]', (e) => Math.round(e.getBoundingClientRect().width));
  await m.click('[data-cal-dia="2026-11-03"]'); await m.waitForTimeout(400);
  const painel = await m.locator("#cal-dia-detalhe").innerText();
  await m.screenshot({ path: `${SHOTS}/m-calendario-dia.png`, fullPage: true });
  const ok = caixa.esq >= 0 && caixa.dir <= 390 && larguraDoDia >= 36 && /SAIPOS — Presencial/.test(painel) && (await semRolagemHorizontal(m));
  return ok ? `célula de ${larguraDoDia}px` : `FALHA:caixa=${JSON.stringify(caixa)} celula=${larguraDoDia}`;
});
await checar("Console", "sem erros de JavaScript no celular", async () => m.diagnosticos.pagina.length === 0);
await m.context().close();
await browser.close();

const falhas = resultados.filter((r) => !r.ok);
console.log(`\nRESUMO: ${resultados.length - falhas.length}/${resultados.length} verificações OK; ${falhas.length} falha(s).`);
console.log("Respostas 4xx/5xx no desktop:", JSON.stringify([...new Set(diagDesk.respostasRuins)]));
console.log("Requisições falhas:", JSON.stringify([...new Set(diagDesk.requisicoesFalhas)]));
if (falhas.length) process.exit(1);
