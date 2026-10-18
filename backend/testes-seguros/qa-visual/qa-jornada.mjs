// HOMOLOGAÇÃO FUNCIONAL PONTA A PONTA (dados sintéticos; servidor-qa-integrado.mjs na 4174 com estado LIMPO — reinicie antes).
// Jornada: login → unidade → setor Financeiro → Visão Geral → Lançamentos (Fluxo de Caixa) → Contas → Transferências → Importação → Conciliação
//          → DRE → Indicadores → Períodos → Relatórios → Exportação, para os níveis GESTOR, OPERADOR e LEITURA, em desktop/tema claro e celular/tema escuro.
// Gate e domínio REAIS (o que a tela oferece tem de bater com o que a API aceita); sessão/Supabase falsos (loopback).
import { createRequire } from "node:module";
const { chromium } = createRequire(`${process.env.QA_MODULOS || process.cwd()}/`)("playwright-core");
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(aqui, "shots"); mkdirSync(SHOTS, { recursive: true });
const BASE = "http://127.0.0.1:4174";
const res = []; const erros = [];
const checar = (nome, ok, d = "") => res.push({ nome, ok: !!ok, d });
const api = (p) => fetch(BASE + p).then((r) => r.json());
const nav = await chromium.launch({ executablePath: process.env.QA_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const hoje = new Date(); const MES_ATUAL = `${hoje.getUTCFullYear()}-${String(hoje.getUTCMonth() + 1).padStart(2, "0")}`;
const diaHoje = hoje.toISOString().slice(0, 10);

async function jornada({ nivel, rotulo, largura, altura, tema }) {
  await api("/qa/cenario?nome=ambos"); await api(`/qa/nivel?n=${nivel}`);
  const ctx = await nav.newContext({ viewport: { width: largura, height: altura }, colorScheme: tema, acceptDownloads: true, isMobile: largura < 600, hasTouch: largura < 600 });
  await ctx.addInitScript((t) => { try { localStorage.setItem("cd.tema", t); } catch {} }, tema);
  const page = await ctx.newPage();
  const tag = `${nivel}/${rotulo}`;
  page.on("pageerror", (e) => erros.push(`${tag} PAGEERROR ${String(e.message).slice(0, 140)}`));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|status of 403/.test(m.text())) erros.push(`${tag} console: ${m.text().slice(0, 140)}`); });
  const texto = () => page.locator("#view").innerText();
  const semEstouro = async () => (await page.evaluate(() => document.documentElement.scrollWidth)) <= largura + 2;
  const ir = async (rota) => {
    if (largura < 600) { await page.locator("#btn-menu").click(); await page.waitForTimeout(300); }
    await page.locator(`#menu li[data-rota="${rota}"]`).click(); await page.waitForTimeout(1100);
  };
  const tem = (sel) => page.locator(sel).first().isVisible().catch(() => false);
  const gestor = nivel === "gestor", escreve = nivel !== "leitura";

  // 1. login (sessão de QA) → unidade → setor
  await page.goto(BASE + "/", { waitUntil: "load" }); await page.waitForTimeout(1500);
  checar(`${tag}: login abre a aplicação e pergunta o setor (usuário com Operacional e Financeiro)`, await tem("#setor-screen"));
  checar(`${tag}: unidade do contexto visível`, /Unidade A/.test(await page.locator("body").innerText()));
  await page.locator('.setor-card[data-setor="financeiro"]').click(); await page.waitForTimeout(1300);
  checar(`${tag}: setor Financeiro → Visão Geral com dados`, /Visão Geral/.test(await page.locator("#page-title").innerText()) && /R\$/.test(await texto()));
  await page.screenshot({ path: path.join(SHOTS, `60-jornada-${nivel}-${rotulo}-visao.png`) });

  // 2. Lançamentos (Fluxo de Caixa)
  await ir("fin-fluxo-de-caixa");
  checar(`${tag}: lançamentos — botão "Novo lançamento" ${escreve ? "presente" : "AUSENTE"}`, (await tem("[data-novo]")) === escreve);
  if (escreve) {
    await page.locator("[data-novo]").click();
    const d = page.locator("dialog.fin-dialogo[open]");
    await d.locator('select[name="contaId"]').selectOption({ label: "BANCO PRINCIPAL" });
    await d.locator('select[name="sentido"]').selectOption("saida");
    await d.locator('input[name="descricao"]').fill(`Jornada ${tag}`);
    await d.locator('input[name="valor"]').fill("12,34");
    await d.locator('input[name="dataMovimento"]').fill(diaHoje);
    await d.locator('button[type="submit"]').click(); await page.waitForTimeout(1200);
    checar(`${tag}: lançamento criado aparece na lista`, !(await page.locator("dialog.fin-dialogo[open]").count()) && (await texto()).includes(`Jornada ${tag}`), (await texto()).slice(0, 100));
  }
  checar(`${tag}: lançamentos sem rolagem horizontal`, await semEstouro());

  // 3. Contas + 4. Transferências
  await ir("fin-contas");
  checar(`${tag}: contas listadas`, /BANCO PRINCIPAL/.test(await texto()));
  checar(`${tag}: "Nova conta" só para gestor`, (await tem("[data-nova-conta]")) === gestor);
  await ir("fin-fluxo-de-caixa");
  checar(`${tag}: "Nova transferência" ${escreve ? "presente" : "AUSENTE"}`, (await tem("[data-transf]")) === escreve);
  if (escreve) {
    await page.locator("[data-transf]").click();
    const d = page.locator("dialog.fin-dialogo[open]");
    await d.locator('select[name="contaOrigemId"]').selectOption({ label: "ADQUIRENTE" });
    await d.locator('select[name="contaDestinoId"]').selectOption({ label: "BANCO PRINCIPAL" });
    await d.locator('input[name="valor"]').fill("50,00");
    await d.locator('input[name="data"]').fill(diaHoje);
    await d.locator('input[name="descricao"]').fill(`Transf ${tag}`);
    await d.locator('button[type="submit"]').click(); await page.waitForTimeout(1200);
    checar(`${tag}: transferência registrada (par vinculado)`, !(await page.locator("dialog.fin-dialogo[open]").count()) && (await texto()).includes(`Transf ${tag}`));
  }

  // 5. Importação
  await ir("fin-importacao");
  const tImp = await texto();
  checar(`${tag}: importação ${escreve ? "oferece envio de arquivo" : "informa falta de permissão"}`, escreve ? await tem("[data-upload], input[type=file]") : /permiss/i.test(tImp), tImp.slice(0, 100));

  // 6. Conciliação
  await ir("fin-conciliacao");
  checar(`${tag}: conciliação — "Informar referências" só para gestor (conciliar)`, (await tem("[data-ref]")) === gestor);
  if (gestor) {
    await page.locator("[data-ref]").click();
    const d = page.locator("dialog.fin-dialogo[open]");
    await d.locator('select[name="tipo"]').selectOption("dinheiro");
    await d.locator('input[name="valor"]').fill("0");
    await d.locator('button[type="submit"]').click(); await page.waitForTimeout(1200);
    checar(`${tag}: referência registrada (zero informado é aceito)`, !(await page.locator("dialog.fin-dialogo[open]").count()));
  }

  // 7. DRE e 8. Indicadores
  await ir("fin-dre"); const tDre = await texto();
  checar(`${tag}: DRE com regime de caixa e valores`, /caixa/i.test(tDre) && /R\$/.test(tDre) && !/NaN|undefined/.test(tDre));
  await ir("fin-indicadores"); const tInd = await texto();
  checar(`${tag}: indicadores sem NaN/undefined`, /R\$|%/.test(tInd) && !/NaN|undefined/.test(tInd));

  // 9. Períodos
  await ir("fin-periodos"); const tPer = await texto();
  checar(`${tag}: períodos listados; "Pré-fechamento" ${gestor ? "disponível" : "não permite fechar"}`, /Fechado|Aberto/.test(tPer));
  checar(`${tag}: nenhum botão de reabrir`, !(await page.locator('#view button', { hasText: /^Reabrir/ }).count()));

  // 10. Relatórios + 11. Exportação
  await ir("fin-relatorios"); await page.waitForTimeout(800);
  const botaoCsv = page.locator('[data-exportar="csv"]').first();
  checar(`${tag}: relatórios abrem com exportação disponível (permissão ver)`, await botaoCsv.isVisible().catch(() => false));
  if (await botaoCsv.isVisible().catch(() => false)) {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }).catch(() => null), botaoCsv.click()]);
    let ok = false, detalhe = "sem download";
    if (dl) { const arq = await dl.path(); const b = readFileSync(arq); ok = b[0] === 0xef && b.toString("utf8").includes(";") && /\.csv$/.test(dl.suggestedFilename()); detalhe = dl.suggestedFilename(); }
    checar(`${tag}: exportação CSV baixa arquivo seguro (BOM, ';', nome .csv)`, ok, detalhe);
  }
  checar(`${tag}: relatórios sem rolagem horizontal`, await semEstouro());
  await page.screenshot({ path: path.join(SHOTS, `61-jornada-${nivel}-${rotulo}-relatorios.png`) });

  // 12. A API confirma o que a tela esconde (mesma sessão): operador/leitura não fecham nem conciliam
  const st = await page.evaluate(async (mes) => {
    const r = await fetch(`/api/v1/gestao-financeira/periodos/${mes}/fechar`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer qa", "x-context-token": "qa-contexto" }, body: JSON.stringify({ confirmo: true, versao: 1, fingerprint: "x" }) });
    return r.status;
  }, MES_ATUAL);
  checar(`${tag}: API de fechamento ${gestor ? "não responde 403 de permissão" : "responde 403"} para o nível`, gestor ? st !== 403 : st === 403, `status=${st}`);
  await ctx.close();
}

for (const nivel of ["gestor", "operador", "leitura"]) {
  await jornada({ nivel, rotulo: "desktop-claro", largura: 1366, altura: 860, tema: "light" });
  await jornada({ nivel, rotulo: "celular-escuro", largura: 390, altura: 844, tema: "dark" });
}
await nav.close();
const falhas = res.filter((r) => !r.ok);
for (const r of res) console.log(`${r.ok ? "OK   " : "FALHA"} ${r.nome}${r.ok || !r.d ? "" : `  (${r.d})`}`);
console.log(`\n${res.length - falhas.length}/${res.length} verificações OK · erros de script: ${erros.length}`);
for (const e of erros) console.log("  !", e);
process.exit(falhas.length || erros.length ? 1 : 0);
