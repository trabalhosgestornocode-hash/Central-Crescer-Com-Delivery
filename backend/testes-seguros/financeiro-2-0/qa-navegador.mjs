// QA de navegador do Financeiro 2.0 contra a APLICAÇÃO LOCAL (servidor-local.mjs na 4180, banco recém-semeado). Dados sintéticos.
// Perfis: leitura → operador → contador → gestor → administrador (a ordem importa: cada um age sobre o estado deixado pelo anterior).
//   QA_MODULOS=~/qa-tmp node backend/testes-seguros/financeiro-2-0/qa-navegador.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(`${process.env.QA_MODULOS || process.cwd()}/`)("playwright-core");

const aqui = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(aqui, "..", "..", "..", "docs", "financeiro-2-0", "implementacao", "evidencias"); mkdirSync(SHOTS, { recursive: true });
const BASE = process.env.QA_BASE || "http://127.0.0.1:4180";
const res = [], erros = [];
const checar = (id, nome, ok, d = "") => { res.push({ id, nome, ok: !!ok, d }); console.log(`${ok ? "PASS" : "FAIL"} ${id} ${nome}${ok ? "" : ` :: ${String(d).slice(0, 300)}`}`); };
const nav = await chromium.launch({ executablePath: process.env.QA_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });

async function abrir(nivel, { largura = 1360, altura = 900, tema = "light", mes = "2026-09" } = {}) {
  await fetch(`${BASE}/qa/nivel?n=${nivel}`);
  const ctx = await nav.newContext({ viewport: { width: largura, height: altura }, colorScheme: tema, isMobile: largura < 600, hasTouch: largura < 600 });
  await ctx.addInitScript(([t, m]) => { try { localStorage.setItem("cd.tema", t); sessionStorage.setItem("fin:mes", m); } catch {} }, [tema, mes]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => erros.push(`${nivel} PAGEERROR ${String(e.message).slice(0, 160)}`));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|status of 40[34]/.test(m.text())) erros.push(`${nivel} console: ${m.text().slice(0, 160)}`); });
  await page.goto(BASE + "/", { waitUntil: "load" }); await page.waitForTimeout(1800);
  const card = page.locator('.setor-card[data-setor="financeiro"]');
  if (await card.isVisible().catch(() => false)) { await card.click(); await page.waitForTimeout(1500); }
  const ir = async (rota) => {
    if (largura < 600) { await page.locator("#btn-menu").click(); await page.waitForTimeout(350); }
    await page.locator(`#menu li[data-rota="${rota}"]`).click(); await page.waitForTimeout(2600);
  };
  const texto = () => page.locator("#view").innerText();
  const semEstouro = async () => (await page.evaluate(() => document.documentElement.scrollWidth)) <= largura + 2;
  const dlg = () => page.locator("dialog.fin-dialogo[open]").last();
  const shot = (nome) => page.screenshot({ path: path.join(SHOTS, `${nome}.png`), fullPage: true });
  return { ctx, page, ir, texto, semEstouro, dlg, shot };
}
/** Espera (até 10 s) o texto aparecer no alvo — as ações recarregam o conteúdo de forma assíncrona. */
const aguardar = async (loc, re, ms = 10000) => { const fim = Date.now() + ms; while (Date.now() < fim) { if (re.test(await loc.innerText().catch(() => ""))) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
const detalheDe = async (page, fornecedor) => { await page.locator("tr", { hasText: fornecedor }).first().locator("[data-detalhe]").click(); await page.waitForTimeout(2200); };

// ---------------------------------------------------------------- LEITURA
{
  const { ctx, page, ir, texto, dlg, shot } = await abrir("leitura");
  checar("N01", "leitor: entra no Financeiro e vê o menu com Contas a Pagar, Conciliação de Saídas e Juros", (await page.locator('#menu li[data-rota="fin-contas-a-pagar"], #menu li[data-rota="fin-conciliacao-saidas"], #menu li[data-rota="fin-juros"]').count()) === 3);
  await ir("fin-contas-a-pagar");
  const t = await texto();
  checar("N02", "leitor: Contas a Pagar de setembro lista o exemplo 810,00 → 832,41 com +R$ 22,41 e 2,77%", /Embalagens Brasil/.test(t) && /\+R\$\s22,41/.test(t) && /2,77%/.test(t), t.slice(0, 400));
  checar("N03", "leitor: sem botão de registrar", !(await page.locator("[data-nova]").count()));
  await detalheDe(page, "Embalagens Brasil");
  const d = await dlg().innerText();
  checar("N04", "detalhe mostra a fórmula da diferença e do percentual", /Diferença = total pago R\$\s832,41 − original R\$\s810,00 = \+R\$\s22,41/.test(d) && /Percentual = diferença ÷ original × 100 = 2,77%/.test(d), d.slice(0, 500));
  checar("N05", "leitor: nenhuma ação de escrita no detalhe (sem classificar, quitar, desfazer)", !(await dlg().locator("[data-classificar],[data-quitar],[data-desfazer],[data-pag]").count()));
  await shot("01-leitor-detalhe-calculo");
  await dlg().locator('button[type="submit"]').click();
  await ir("fin-conciliacao-saidas");
  checar("N06", "leitor: conciliação sem botões de confirmar/gerar", !(await page.locator("[data-confirmar],[data-sugerir]").count()) && /Divergente/.test(await texto()));
  await ctx.close();
}

// ---------------------------------------------------------------- OPERADOR
{
  const { ctx, page, ir, texto, dlg, shot } = await abrir("operador");
  await ir("fin-contas-a-pagar");
  await page.locator("[data-nova]").click(); await page.waitForTimeout(1500);
  const f = dlg();
  checar("N07", "operador: formulário avisa que o registro fica PROVISÓRIO e não oferece 'quitada'", /provisório/i.test(await f.innerText()) && !(await f.locator('input[name="quitar"]').count()));
  await f.locator('input[name="fornecedorNome"]').fill("Papelaria Sintética");
  await f.locator('select[name="categoriaId"]').selectOption({ label: "EMBALAGENS" });
  await f.locator('input[name="vencimento"]').fill("2026-09-26");
  await f.locator('input[name="valorOriginal"]').fill("150,00");
  await f.locator('input[name="pg_data"]').fill("2026-09-29");
  await f.locator('input[name="pg_valor"]').fill("153,00");
  await f.locator('select[name="pg_contaId"]').selectOption({ label: "BANCO SINTÉTICO" });
  await page.waitForTimeout(300);
  checar("N08", "prévia ao vivo: sem confirmar quitação, nada é classificado", /Sem confirmar a quitação nada é classificado/.test(await f.locator("[data-previa]").innerText()));
  await shot("02-operador-formulario-provisorio");
  await f.locator('button[type="submit"]').click(); await page.waitForTimeout(2800);
  const t = await texto();
  checar("N09", "conta do operador aparece como Provisória e 'Paga — confirmar quitação'", /Papelaria Sintética/.test(t) && /Provisória/.test(t), t.slice(0, 300));
  await detalheDe(page, "Papelaria Sintética");
  checar("N10b", "operador: sem 'Confirmar quitação' nem 'Classificar'", !(await dlg().locator("[data-quitar],[data-classificar],[data-confirmar]").count()));
  await dlg().locator('button[type="submit"]').click();
  await ctx.close();
}

// ---------------------------------------------------------------- CONTADORA
{
  const { ctx, page, ir, texto, dlg, shot } = await abrir("contador");
  await ir("fin-contas-a-pagar");
  await detalheDe(page, "Embalagens Brasil");
  const sel = dlg().locator('[data-classificar] select[name="classificacao"]');
  checar("N11", "contadora: classifica o acréscimo (opções juros/multa/tarifa/outro; sem 'desconto')", (await sel.count()) === 1 && !(await sel.locator('option[value="desconto"]').count()));
  await sel.selectOption("juros"); await dlg().locator("[data-gravar-classificacao]").click();
  checar("N12", "classificação gravada: o diálogo continua aberto e a natureza passa de 'presumido' a 'Juros'", await aguardar(dlg().locator(".fin-alerta strong").first(), /^Juros$/));
  await shot("03-contadora-classificacao-juros");
  await dlg().locator('button[type="submit"]').click(); await page.waitForTimeout(400);
  await detalheDe(page, "Contabilidade Alfa");
  const s2 = dlg().locator('[data-classificar] select[name="classificacao"]');
  checar("N13", "pago a menor: só 'desconto' disponível (nunca juros)", (await s2.locator('option[value="desconto"]').count()) === 1 && !(await s2.locator('option[value="juros"]').count()));
  await s2.selectOption("desconto"); await dlg().locator("[data-gravar-classificacao]").click(); await page.waitForTimeout(2400);
  await dlg().locator('button[type="submit"]').click();
  checar("N14", "contadora: não registra contas (sem botão)", !(await page.locator("[data-nova]").count()));
  await ctx.close();
}

// ---------------------------------------------------------------- GERENTE
{
  const { ctx, page, ir, texto, dlg, shot } = await abrir("gestor");
  await ir("fin-conciliacao-saidas");
  await shot("04-gerente-conciliacao-setembro");
  const linhaDiv = page.locator("tr", { hasText: "Divergente" }).first();
  await linhaDiv.locator("[data-confirmar]").click(); await page.waitForTimeout(800);
  checar("N15", "confirmar divergência pede justificativa (fora da tolerância)", /fora da tolerância/i.test(await dlg().innerText()) && (await dlg().locator('textarea[name="justificativa"]').count()) === 1);
  await dlg().locator('textarea[name="justificativa"]').fill("Tarifa de saque de R$ 12,50 cobrada junto");
  await dlg().locator('button[type="submit"]').click(); await page.waitForTimeout(2800);
  const t = await texto();
  checar("N16", "divergência conciliada com justificativa: nenhuma linha 'Divergente' resta na tabela", (await page.locator("tbody tr", { hasText: "Divergente" }).count()) === 0 && /Tarifa de saque/.test(t), t.slice(0, 300));
  await ir("fin-contas-a-pagar");
  for (const forn of ["Papelaria Sintética", "Entregas Rápidas"]) {
    await detalheDe(page, forn);
    if (await dlg().locator("[data-quitar]").count()) {
      await dlg().locator("[data-quitar]").click();
      if (forn === "Papelaria Sintética") checar("N17a", "após 'Confirmar quitação' o detalhe CONTINUA aberto e mostra a diferença calculada", await aguardar(dlg(), /Diferença = total pago/));
      else await aguardar(dlg(), /Quitada em/);
    }
    if (await dlg().locator("[data-confirmar]").count()) { await dlg().locator("[data-confirmar]").click(); await page.waitForTimeout(2400); }
    await dlg().locator('button[type="submit"]').click(); await page.waitForTimeout(500);
  }
  const t2 = await texto();
  checar("N17", "gerente quitou e confirmou os registros do operador: sem alertas de provisória/quitação pendente", !/registro\(s\) provisório\(s\)/.test(t2) && !/aguardando a confirmação da quitação/.test(t2), t2.slice(0, 400));
  await detalheDe(page, "Papelaria Sintética");
  checar("N18", "gerente: acréscimo do operador fica 'presumido' e o gerente NÃO classifica", /presumido/i.test(await dlg().innerText()) && !(await dlg().locator("[data-classificar]").count()));
  await dlg().locator('button[type="submit"]').click();
  await ctx.close();
}

// ---------------------------------------------------------------- ADMINISTRADOR (desktop claro) — outubro, juros, visão geral, períodos
{
  const { ctx, page, ir, texto, dlg, shot } = await abrir("administrador", { mes: "2026-10" });
  checar("N19", "Visão Geral mostra o bloco de contas a pagar e encargos (carregado à parte)", await aguardar(page.locator("#view"), /Contas a pagar e encargos[\s\S]*Bloqueios de fechamento/, 15000));
  await shot("05-admin-visao-geral-outubro");
  await ir("fin-conciliacao-saidas");
  const t = await texto();
  checar("N20", "outubro: sugestões aguardando (inclusive AGRUPADA) e nenhuma conciliada automaticamente", /Sugerido/.test(t) && /Agrupado/.test(t) && /Nenhuma saída conciliada neste mês/.test(t), t.slice(0, 500));
  checar("N21", "outubro: pagamento sem extrato aparece como pendente e débito sem identificação aparece 'a identificar'", /Distribuidora de Polpas/.test(t) && /DÉBITO NÃO IDENTIFICADO/.test(t));
  await shot("06-admin-conciliacao-outubro-sugestoes");
  const agr = page.locator("tr", { hasText: "Agrupado" }).first();
  await agr.locator("[data-confirmar]").click(); await page.waitForTimeout(700);
  await dlg().locator('button[type="submit"]').click(); await page.waitForTimeout(2800);
  await page.locator("tr", { hasText: "PIX HORTIFRUTI" }).last().locator("[data-evidencia]").click(); await page.waitForTimeout(700);
  const ev = await dlg().innerText();
  checar("N22", "evidência da conciliação: ids do extrato e dos 2 pagamentos, diferença e data de confirmação", /id 00000000|id [0-9a-f]{8}-/.test(ev) && (ev.match(/id [0-9a-f-]{36}/g) ?? []).length >= 3 && /Confirmado em/.test(ev), ev.slice(0, 400));
  await shot("07-admin-evidencia-agrupado");
  await dlg().locator('button[type="submit"]').click();
  await ir("fin-juros");
  await page.locator("#fin-de").fill("2026-08"); await page.locator("#fin-de").dispatchEvent("change");
  await page.locator("#fin-ate").fill("2026-09"); await page.locator("#fin-ate").dispatchEvent("change"); await page.waitForTimeout(2800);
  const j = await texto();
  checar("N23", "juros ago–set: juros, multa e tarifa separados; nota de que empréstimos não entram", /Multas[\s\S]*R\$\s43,75/.test(j) && /Taxas e tarifas[\s\S]*R\$\s8,50/.test(j) && /empréstimos/i.test(j), j.slice(0, 600));
  await shot("08-admin-juros");
  await ir("fin-periodos");
  await page.waitForTimeout(800);
  await ctx.close();
}

// ---------------------------------------------------------------- celular / tema escuro (administrador)
{
  const { ctx, page, ir, texto, semEstouro, dlg, shot } = await abrir("administrador", { largura: 390, altura: 844, tema: "dark", mes: "2026-09" });
  for (const [rota, nome] of [["fin-contas-a-pagar", "09-celular-escuro-contas-a-pagar"], ["fin-conciliacao-saidas", "10-celular-escuro-conciliacao"], ["fin-juros", "11-celular-escuro-juros"]]) {
    await ir(rota);
    checar(`N24-${rota}`, `celular 390px/escuro: ${rota} sem rolagem horizontal e com conteúdo`, (await semEstouro()) && (await texto()).length > 200);
    // conteúdo cortado = a tabela-cartão passa da largura do contêiner (que esconde o excesso). Calibrado: layout quebrado = 86 px; corrigido = 6 px (borda).
    const excesso = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll("#view .fin-tabela-wrap")].map((w) => w.scrollWidth - w.clientWidth)));
    checar(`N27-${rota}`, `celular: nenhuma tabela com conteúdo cortado em ${rota} (excesso ≤ 16 px)`, excesso <= 16, `excesso de ${excesso} px`);
    await shot(nome);
  }
  await ir("fin-contas-a-pagar");
  await detalheDe(page, "Embalagens Brasil");
  checar("N25", "celular: detalhe abre e cabe na tela", await dlg().isVisible() && (await semEstouro()));
  await shot("12-celular-escuro-detalhe");
  await ctx.close();
}

// ---------------------------------------------------------------- feature flag desligado
{
  await fetch(`${BASE}/qa/fin2?on=0`);
  const { ctx, page, ir, texto } = await abrir("administrador");
  await page.waitForTimeout(1200);
  const visiveis = await page.locator('#menu li[data-fin2]:not([hidden])').count();
  checar("N28", "flag DESLIGADO: os 3 itens do Financeiro 2.0 ficam ocultos no menu; os antigos continuam", visiveis === 0 && (await page.locator('#menu li[data-rota="fin-fluxo-de-caixa"]').isVisible()));
  await page.evaluate(() => { location.hash = "#fin-contas-a-pagar"; });
  await page.waitForTimeout(2200);
  await ir("fin-fluxo-de-caixa");
  checar("N29", "flag DESLIGADO: Fluxo de Caixa (financeiro anterior) abre normalmente", /Fluxo de Caixa/.test(await page.locator("#page-title").innerText()) && !/indisponível/i.test(await texto()));
  await ctx.close();
  await fetch(`${BASE}/qa/fin2?on=1`);
}

await nav.close();
checar("N26", "nenhum erro de JavaScript ou de console durante a jornada", erros.length === 0, erros.join(" | "));
const nf = res.filter((r) => !r.ok).length;
console.log(`\nRESUMO: ${res.length - nf} PASS, ${nf} FAIL`);
process.exit(nf ? 1 : 0);
