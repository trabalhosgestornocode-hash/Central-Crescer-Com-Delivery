// Validação de NAVEGADOR (Chrome/Chromium real, via Playwright) das retiradas e reforços de caixa da SAIPOS.
// Alvo: servidor demonstrativo local (dados sintéticos). Nada toca produção, banco ou rede externa.
//   1) node scripts/fv2-demo-interface.mjs --porta=5191 --agora=2026-11-25T15:00:00Z   (em outro terminal)
//   2) FV2_DEMO_URL=http://127.0.0.1:5191/ FV2_PLAYWRIGHT_PATH=<pasta do pacote playwright> FV2_NAVEGADOR_CANAL=padrao node scripts/fv2/navegadorMovimentosCaixa.mjs
// A demonstração guarda estado em memória: reinicie-a antes de rodar este roteiro (ele importa um arquivo e registra um fechamento).
// Sai com código 1 se qualquer verificação falhar. Capturas de tela vão para FV2_NAVEGADOR_SAIDA (padrão: pasta temporária).
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { xlsx } from "../../test/financeiro-v2/helpers/formatos.js";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FV2_PLAYWRIGHT_PATH || "playwright");

const BASE = process.env.FV2_DEMO_URL || "http://127.0.0.1:5191/";
const SAIDA = process.env.FV2_NAVEGADOR_SAIDA || join(tmpdir(), "fv2-navegador-movimentos");
mkdirSync(SAIDA, { recursive: true });

// Arquivo SINTÉTICO com a forma do export "Financeiro" (valores inventados).
const CAB = ["Vencimento", "Emissão", "Pagamento", "Conta", "Método de Pagamento", "Categoria", "Valor", "Pago", "Fornecedor", "Descrição"];
const linha = (dia, valor, descricao = "Retirada de Frente de Caixa") => { const d = `${dia}/11/2026`; return [d, d, d, "Cofre", null, "Frente de Caixa", valor, "Sim", null, descricao]; };
const ARQUIVO = join(SAIDA, "financeiro-sintetico.xlsx");
writeFileSync(ARQUIVO, xlsx([{ nome: "Financeiro 01Nov-17Nov", linhas: [CAB, linha("04", 20), linha("08", 100), linha("08", 40), linha("08", -30, "Reforço de Frente de Caixa"), linha("08", -5, "Caixa - Loja - Dinheiro - 08/11/2026"), linha("12", 25)] }]));
// Versão CORRIGIDA do mesmo período: a retirada de 08/11 passou de R$ 100,00 para R$ 110,00.
const ARQUIVO_CORRIGIDO = join(SAIDA, "financeiro-sintetico-corrigido.xlsx");
writeFileSync(ARQUIVO_CORRIGIDO, xlsx([{ nome: "Financeiro 01Nov-17Nov", linhas: [CAB, linha("04", 20), linha("08", 110), linha("08", 40), linha("08", -30, "Reforço de Frente de Caixa"), linha("08", -5, "Caixa - Loja - Dinheiro - 08/11/2026"), linha("12", 25)] }]));

// FV2_CHROME_EXE: caminho de um Chrome/Chromium já instalado (quando a revisão do Playwright não coincide com a baixada).
const browser = await chromium.launch(process.env.FV2_CHROME_EXE ? { executablePath: process.env.FV2_CHROME_EXE } : process.env.FV2_NAVEGADOR_CANAL === "padrao" ? {} : { channel: process.env.FV2_NAVEGADOR_CANAL || "chrome" });
const resultados = [];
const registrar = (nome, ok, detalhe = "") => { resultados.push({ nome, ok }); console.log(`${ok ? "OK   " : "FALHA"} ${nome}${detalhe ? " — " + detalhe : ""}`); };
async function checar(nome, fn) { try { const r = await fn(); if (r === false || (typeof r === "string" && r.startsWith("FALHA:"))) registrar(nome, false, typeof r === "string" ? r : ""); else registrar(nome, true, typeof r === "string" ? r : ""); } catch (e) { registrar(nome, false, String(e.message).split("\n")[0]); } }

const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: "pt-BR" });
const d = await ctx.newPage();
const diag = { console: [], pagina: [], ruins: [] };
d.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*404/.test(m.text())) diag.console.push(m.text()); }); // o 404 de recurso é capturado acima, com o caminho
d.on("pageerror", (e) => diag.pagina.push(e.message));
d.on("response", (r) => { if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) diag.ruins.push(`${r.status()} ${new URL(r.url()).pathname}`); }); // o favicon não existe na demonstração (não é do produto)
await d.goto(BASE);
await d.waitForSelector("#filtro-sessao");
await d.selectOption("#filtro-sessao", "administrador");
const irPara = async (rota, esperar) => { await d.evaluate((r) => { location.hash = `#/${r}`; }, rota); await d.waitForSelector(esperar ?? "#conteudo h1, #conteudo h2", { timeout: 15000 }); await d.waitForTimeout(500); };
const texto = (seletor = "#conteudo") => d.locator(seletor).innerText();
const semRolagemHorizontal = () => d.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

await irPara("saipos", "[data-aba-saipos]");
await d.fill("#filtro-competencia", "2026-11"); await d.waitForTimeout(900);
await d.click('nav [data-aba-saipos="importacoes"]'); await d.waitForSelector("[data-importacoes-canal]", { timeout: 10000 }); await d.waitForTimeout(500);

await checar("SAIPOS › Importações: o formato aparece na própria página, sem ir à Central", async () => {
  const t = await texto("[data-importacoes-canal]");
  return /Movimentações de Frente de Caixa/.test(t) && /Importar não lança nada/.test(t);
});

await checar("enviar o XLSX gera a prévia (sem gravar) com totais, classificação linha a linha e caixa pendente", async () => {
  const f = d.locator("form[data-acao$='/importacao/receber']");
  await f.locator("select[name=tipoRelatorio]").selectOption("SAIPOS_MOVIMENTOS_CAIXA");
  await f.locator("input[name=periodoInicio]").fill("2026-11-01"); await f.locator("input[name=periodoFim]").fill("2026-11-17");
  await f.locator("input[type=file]").setInputFiles(ARQUIVO);
  await f.locator("input[name=confirmar]").check();
  await f.locator("button[type=submit]").click();
  await d.waitForSelector("#painel:not([hidden])", { timeout: 15000 }); await d.waitForTimeout(1500);
  const p = await texto("#painel");
  await d.screenshot({ path: join(SAIDA, "01-previa.png"), fullPage: true });
  const ok = /Movimentações de Frente de Caixa/.test(p) && /Conferir as classificações/.test(p) && /Retirada \(sangria\)/.test(p) && /Reforço/.test(p) && /Sem classificação/.test(p) && /pendente/.test(p) && /Importar não lança nada/i.test(p);
  const semBotaoDePropostas = (await d.locator("#painel form[data-acao$='/propostas/gerar']").count()) === 0;
  return ok && semBotaoDePropostas ? "" : `FALHA: ${ok ? "apareceu o botão Gerar propostas" : p.slice(0, 200)}`;
});

await checar("confirmar a importação (aceitando as pendências) grava sem efeito financeiro", async () => {
  const f = d.locator("#painel form[data-acao$='/importacao/confirmar']").first();
  await f.locator("input[name=confirmar]").check();
  const aceitar = f.locator("input[name=aceitarPendencias]"); if (await aceitar.count()) await aceitar.check();
  const just = f.locator("[name=justificativa]"); if (await just.count()) await just.fill("Pendências sintéticas conferidas no teste de navegador.");
  await f.locator("button[type=submit]").click(); await d.waitForTimeout(1800);
  const p = await texto("#painel");
  await d.screenshot({ path: join(SAIDA, "02-importado.png"), fullPage: true });
  return /Importado/.test(p) && /sem efeito financeiro/i.test(p);
});

await d.click("[data-fechar-painel]").catch(() => {});
await d.click('nav [data-aba-saipos="presencial"]'); await d.waitForTimeout(1200);

await checar("calendário Presencial: o dia 08/11 abre retiradas, reforço, pendência de caixa e a lista", async () => {
  await d.locator('[data-cal-dia="2026-11-08"]').click(); await d.waitForTimeout(600);
  const t = await texto("#cal-dia-detalhe");
  await d.screenshot({ path: join(SAIDA, "03-calendario-dia.png"), fullPage: true });
  await d.locator("#cal-dia-detalhe .mov-caixa__lista summary").click(); await d.waitForTimeout(300);
  const lista = await texto("#cal-dia-detalhe .mov-caixa__lista");
  return /Retiradas e reforços de caixa/.test(t) && /Retiradas \(sangrias\)/.test(t) && /R\$\s?140,00/.test(t) && /Caixa não identificado/.test(t) && /Retirada de Frente de Caixa/.test(lista) && /Reforço de Frente de Caixa/.test(lista) && /Caixa - Loja - Dinheiro/.test(lista);
});

await checar("dia sem movimento não mostra o bloco (ausência não vira zero)", async () => {
  await d.locator('[data-cal-dia="2026-11-03"]').click(); await d.waitForTimeout(500);
  return !/Retiradas e reforços de caixa/.test(await texto("#cal-dia-detalhe"));
});

await d.click('nav [data-aba-saipos="fechamento"]'); await d.waitForTimeout(1200);
await checar("fechamento manual: registra o caixa de 08/11 com retiradas iguais ao relatório → possível duplicidade, contada uma vez", async () => {
  const form = d.locator("form[data-acao='/api/fv2/acoes/fechamento-manual/registrar']");
  await form.locator("input[name=data]").fill("2026-11-08");
  await form.locator("input[name=caixa]").fill("1");
  for (const [n, v] of [["din_abertura", "50,00"], ["din_vendas", "300,00"], ["din_retiradas", "140,00"], ["din_reforcos", "30,00"], ["din_informado", "240,00"]]) await form.locator(`input[name=${n}]`).fill(v);
  await form.locator("input[name=confirmar]").check();
  await form.locator("button[type=submit]").click(); await d.waitForTimeout(1800);
  const t = await texto();
  await d.screenshot({ path: join(SAIDA, "04-fechamento.png") });
  return /Conferência do dinheiro/.test(t) && /possível duplicidade/.test(t) && /contado uma vez/.test(t) && /Dinheiro esperado/.test(t);
});

await checar("a dica de onde achar o relatório na SAIPOS aparece no formato (uma linha)", async () => {
  await d.click('nav [data-aba-saipos="importacoes"]'); await d.waitForSelector("[data-importacoes-canal]", { timeout: 10000 }); await d.waitForTimeout(500);
  const t = await texto("[data-importacoes-canal]");
  const unica = (await d.locator("[data-importacoes-canal] .imp-dica").count()) === 1;
  return unica && /Na SAIPOS: Lançamentos financeiros, categoria Frente de Caixa, descrição Retirada/.test(t);
});

await checar("calendário: o dia com retirada mas sem venda importada NÃO aparece como 'sem movimento confirmado'", async () => {
  await d.click('nav [data-aba-saipos="presencial"]'); await d.waitForTimeout(1200);
  await d.locator('[data-cal-dia="2026-11-08"]').click(); await d.waitForTimeout(600);
  const t = await texto("#cal-dia-detalhe");
  return !/Sem movimento confirmado/.test(t) && !/não traz venda/.test(t) && /Retiradas e reforços de caixa/.test(t);
});

await checar("arquivo CORRIGIDO (retirada de 08/11 passou de R$ 100,00 para R$ 110,00): a prévia avisa, exige aceite e só então substitui", async () => {
  await d.click('nav [data-aba-saipos="importacoes"]'); await d.waitForSelector("[data-importacoes-canal]", { timeout: 10000 }); await d.waitForTimeout(500);
  const f = d.locator("form[data-acao$='/importacao/receber']");
  await f.locator("select[name=tipoRelatorio]").selectOption("SAIPOS_MOVIMENTOS_CAIXA");
  await f.locator("input[name=periodoInicio]").fill("2026-11-01"); await f.locator("input[name=periodoFim]").fill("2026-11-17");
  await f.locator("input[type=file]").setInputFiles(ARQUIVO_CORRIGIDO);
  await f.locator("input[name=confirmar]").check();
  await f.locator("button[type=submit]").click();
  await d.waitForSelector("#painel:not([hidden])", { timeout: 15000 }); await d.waitForTimeout(1500);
  const p = await texto("#painel");
  await d.screenshot({ path: join(SAIDA, "06-previa-correcao.png") });
  const avisa = /Dia 08\/11: já há 1 retirada\(s\) importada\(s\) \(R\$\s?100,00\) que este arquivo NÃO traz/.test(p) && /SUBSTITUÍDAS/.test(p);
  const g = d.locator("#painel form[data-acao$='/importacao/confirmar']").first();
  await g.locator("input[name=confirmar]").check();
  await g.locator("input[name=aceitarPendencias]").check();
  await g.locator("[name=justificativa]").fill("Arquivo corrigido: a retirada de 08/11 era R$ 110,00 (teste de navegador).");
  await g.locator("button[type=submit]").click(); await d.waitForTimeout(1800);
  const depois = await texto("#painel");
  return avisa && /Importado/.test(depois) ? "" : `FALHA: avisa=${avisa} | ${depois.slice(0, 160)}`;
});

await checar("depois da correção o calendário soma R$ 150,00 no dia (110 + 40; a de R$ 100,00 saiu) e o fechamento manual mostra 'valores diferentes'", async () => {
  await d.click("[data-fechar-painel]").catch(() => {});
  await d.click('nav [data-aba-saipos="presencial"]'); await d.waitForTimeout(1200);
  await d.locator('[data-cal-dia="2026-11-08"]').click(); await d.waitForTimeout(600);
  const cal = await texto("#cal-dia-detalhe");
  await d.click('nav [data-aba-saipos="fechamento"]'); await d.waitForTimeout(1200);
  const fech = await texto();
  await d.screenshot({ path: join(SAIDA, "07-fechamento-divergente.png") });
  return /Retiradas \(sangrias\)\s*2 · R\$\s?150,00/.test(cal) && /valores diferentes/.test(fech) && /Revisar movimentações antes de conferir/.test(fech) ? "" : `FALHA: ${cal.slice(0, 200)}`;
});

await checar("importação confirmada: bloco 'Lançar as retiradas como despesas pagas em dinheiro' com o que é novo e o botão (nada foi lançado ao importar)", async () => {
  await d.click('nav [data-aba-saipos="importacoes"]'); await d.waitForSelector("[data-importacoes-canal]", { timeout: 10000 }); await d.waitForTimeout(500);
  await d.locator('[data-importacoes-canal] tr:has-text("Movimentações de Frente de Caixa") button[data-detalhe^="documento:"]').last().click(); // a mais recente (a corrigida)
  await d.waitForSelector("#painel:not([hidden])", { timeout: 15000 }); await d.waitForTimeout(1200);
  const p = await texto("#painel");
  await d.screenshot({ path: join(SAIDA, "08-lancar-despesas.png") });
  const temBotao = (await d.locator("#painel form[data-acao$='/movimentos-caixa/lancar-despesas']").count()) === 1;
  return /Lançar as retiradas como despesas pagas em dinheiro/.test(p) && /Novas \(serão lançadas\)\s*4 · R\$\s?195,00/.test(p) && /Importar não lança nada/.test(p) && temBotao ? "" : `FALHA: botão=${temBotao} | ${p.slice(p.indexOf("Lançar as"), p.indexOf("Lançar as") + 300)}`;
});

await checar("lançar: cria 4 contas pagas em dinheiro e mostra o resultado; repetir não lança de novo", async () => {
  const f = d.locator("#painel form[data-acao$='/movimentos-caixa/lancar-despesas']");
  await f.locator("input[name=confirmar]").check();
  await f.locator("button[type=submit]").click(); await d.waitForTimeout(2000);
  const msg = await texto("#painel");
  await d.screenshot({ path: join(SAIDA, "09-lancado.png") });
  const lancou = /4 retirada\(s\) lançada\(s\) como despesa paga em dinheiro; 0 já estava/.test(msg) || /Nada novo a lançar/.test(msg);
  const semBotao = (await d.locator("#painel form[data-acao$='/movimentos-caixa/lancar-despesas']").count()) === 0;
  return lancou && semBotao && /Já lançadas por esta importação\s*4 · R\$\s?195,00/.test(msg) ? "" : `FALHA: ${msg.slice(msg.indexOf("Lançar as"), msg.indexOf("Lançar as") + 360)}`;
});

await checar("Contas a Pagar › Calendário: as retiradas aparecem como PAGAS no dia (fornecedor Sangrias)", async () => {
  await d.click("[data-fechar-painel]").catch(() => {});
  await irPara("calendario", "#conteudo .calendario");
  await d.fill("#filtro-competencia", "2026-11"); await d.waitForTimeout(1200);
  await d.locator('[data-dia="2026-11-08"]').click(); await d.waitForTimeout(600);
  const t = await texto("#dia-detalhe");
  await d.screenshot({ path: join(SAIDA, "10-contas-a-pagar-calendario.png") });
  return /Pagamentos feitos no dia/.test(t) && /Sangrias/i.test(t) && /R\$\s?110,00/.test(t) && /R\$\s?40,00/.test(t) ? "" : `FALHA: ${t.slice(0, 300)}`;
});

await checar("Contas a Pagar › Lista: contas do fornecedor Sangrias quitadas, categoria Outras despesas", async () => {
  await irPara("contas-a-pagar", "#conteudo table, #conteudo .vazio-lista");
  await d.waitForTimeout(800);
  const t = await texto();
  const linhas = (t.match(/Sangrias/gi) ?? []).length;
  return linhas >= 4 && /Outras despesas/i.test(t) && /Pago/.test(t) ? "" : `FALHA: ocorrências=${linhas}`;
});

await checar("sem rolagem horizontal no desktop e no celular, sem erros de console nem requisições com erro", async () => {
  const desktop = await semRolagemHorizontal();
  await d.setViewportSize({ width: 390, height: 844 }); await d.waitForTimeout(500);
  const celular = await semRolagemHorizontal();
  await d.screenshot({ path: join(SAIDA, "05-celular.png") });
  await d.setViewportSize({ width: 1366, height: 900 });
  const erros = [...diag.console, ...diag.pagina, ...diag.ruins];
  return desktop && celular && !erros.length ? "" : `FALHA: desktop=${desktop} celular=${celular} erros=${JSON.stringify(erros).slice(0, 300)}`;
});

await browser.close();
const falhas = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações OK. Capturas em ${SAIDA}`);
process.exit(falhas ? 1 : 0);
