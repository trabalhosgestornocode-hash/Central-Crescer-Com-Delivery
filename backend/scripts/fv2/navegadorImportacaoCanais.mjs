// Fluxo completo de importação iFood e 99Food no navegador (Chrome real, plataforma simulada, núcleo real em memória, dados SINTÉTICOS):
// selecionar arquivo → prévia → confirmar, na Subway (SWF) e no Açaí (SAIPOS). Nada sai de 127.0.0.1.
//   FV2_PLAYWRIGHT_PATH=<playwright-core> [FV2_CHROME_EXE=<chrome>] node scripts/fv2/navegadorImportacaoCanais.mjs <pastaFrontend> [pastaFotos]
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { iniciarPlataformaSimulada } from "./plataformaSimulada.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FV2_PLAYWRIGHT_PATH || "playwright-core");
const aqui = dirname(fileURLToPath(import.meta.url));
const { xlsx } = await import(pathToFileURL(join(aqui, "../../test/financeiro-v2/helpers/formatos.js")));
const [pasta, fotos = join(tmpdir(), "fv2-importacao-canais")] = process.argv.slice(2);
mkdirSync(fotos, { recursive: true });

// ---------------------------------------------------------------- arquivos sintéticos (.xlsx, como o usuário exporta)
const COLUNAS_IFOOD = ["competencia", "fato_gerador", "tipo_lancamento", "descricao_lancamento", "valor", "base_calculo", "percentual_taxa", "pedido_associado_ifood", "pedido_associado_ifood_curto", "motivo_cancelamento", "data_criacao_pedido_associado", "data_repasse_esperada", "valor_transacao", "loja_id", "cnpj", "data_faturamento", "data_apuracao_inicio", "data_apuracao_fim", "valor_cesta_final", "responsavel_transacao", "impacto_no_repasse", "id_saldo", "metodo_pagamento"];
const P1 = "a1a1a1a1-0000-4000-8000-000000000001";
const P2 = "a2a2a2a2-0000-4000-8000-000000000002";
const linhaIfood = (o) => {
  const v = { competencia: "2026-11", fato_gerador: o.fato ?? "Venda", tipo_lancamento: o.tipo ?? "Cobrança", descricao_lancamento: o.desc, valor: o.valor, base_calculo: 0, percentual_taxa: 0,
    pedido_associado_ifood: o.pedido, pedido_associado_ifood_curto: o.pedido.slice(0, 4), motivo_cancelamento: o.motivo ?? "", data_criacao_pedido_associado: "2026-11-03T12:00:00.000Z", data_repasse_esperada: "2026-12-02",
    valor_transacao: o.saldo, loja_id: "LOJA-SINTETICA", cnpj: "00000000000000", data_faturamento: "2026-11-03T12:30:00.000Z", data_apuracao_inicio: "2026-11-02", data_apuracao_fim: "2026-11-08",
    valor_cesta_final: o.cesta, responsavel_transacao: "IFOOD", impacto_no_repasse: o.impacto ?? "SIM", id_saldo: o.idSaldo ?? "S1", metodo_pagamento: "Pix" };
  return COLUNAS_IFOOD.map((k) => v[k]);
};
// P1: venda normal; P2: pedido cancelado com "Ressarcimento iFood" (sem regra automática → pendência de classificação NA PRÉVIA).
const ARQUIVO_IFOOD = xlsx([{ nome: "Relatório de Conciliação", linhas: [COLUNAS_IFOOD,
  linhaIfood({ pedido: P1, tipo: "Entrada Financeira", desc: "Entrada Financeira", valor: 49, cesta: 50, saldo: 66.5 }),
  linhaIfood({ pedido: P1, tipo: "Subsídio", desc: "Promoção custeada pela loja", valor: -5, cesta: 50, impacto: "NÃO", saldo: 66.5 }),
  linhaIfood({ pedido: P1, tipo: "Subsídio", desc: "Promoção custeada pelo iFood", valor: 4, cesta: 50, saldo: 66.5 }),
  linhaIfood({ pedido: P1, tipo: "Retenção", desc: "Taxa de serviço iFood cobrada do cliente", valor: -1, cesta: 50, saldo: 66.5 }),
  linhaIfood({ pedido: P1, desc: "Comissão do iFood (entrega própria da loja)", valor: -8, cesta: 50, saldo: 66.5 }),
  linhaIfood({ pedido: P1, desc: "Taxa de transação", valor: -2.5, cesta: 50, saldo: 66.5 }),
  linhaIfood({ pedido: P2, fato: "Ressarcimento/Indenização", tipo: "Ressarcimento", desc: "Ressarcimento iFood", valor: 25, cesta: 26, motivo: "605 - A loja está fechada", saldo: 66.5 }),
] }]);
const CAB_99 = ["Data", "Nome do estabelecimento", "ID do loja", "Cidade", "Nome do signatário", "ID do signatário", "Vendas de itens", "Taxas de processamento de pagamento", "Despesas de comissão", "Total de vendas realizadas", "Valor médio dos pedidos", "Recompensas da plataforma", "Pedidos de oferta finalizados", "Valor do repasse", "Receita de pedidos em oferta", "Despesas de marketing"];
const linha99 = (data) => [data, "Loja Sintética", "1000000000000000001", "Cidade Sintética", "Pessoa Sintética", "SIG-1", "100,00", "2,00", "10,00", "2", "50,00", "30,00", "2", "70,00", "80,00", "5,00"];
const ARQUIVO_99 = xlsx([{ nome: "Sheet1", linhas: [CAB_99, linha99("2026-11-01"), linha99("2026-11-02")] }]);
const caminhoIfood = join(fotos, "conciliacao-ifood-sintetica.xlsx"); writeFileSync(caminhoIfood, ARQUIVO_IFOOD);
const caminho99 = join(fotos, "relatorio-99food-sintetico.xlsx"); writeFileSync(caminho99, ARQUIVO_99);

// ---------------------------------------------------------------- verificações
const resultados = [];
const registrar = (grupo, nome, ok, detalhe = "") => { resultados.push({ grupo, nome, ok }); console.log(`${ok ? "OK   " : "FALHA"} [${grupo}] ${nome}${detalhe ? ` — ${detalhe}` : ""}`); };
const STUB = "window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'t'}}}),refreshSession:async()=>({data:{session:{access_token:'t'}},error:null})}})};";
const browser = await chromium.launch(process.env.FV2_CHROME_EXE ? { executablePath: process.env.FV2_CHROME_EXE } : {});

async function fluxo(unidade) {
  const subway = unidade === "subway";
  const srv = await iniciarPlataformaSimulada({ pasta, unidadeIndice: subway ? 1 : 0, ...(subway ? { preparar: (await import(pathToFileURL(join(aqui, "cenarioSubway.mjs")))).default } : {}) });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: "pt-BR" });
  await ctx.addInitScript(() => { try { sessionStorage.setItem("cd.contextToken", "contexto-simulado"); } catch { /* sem armazenamento */ } });
  await ctx.route("**/*", (r) => { const u = r.request().url(); if (u.startsWith(srv.url)) return r.continue(); if (u.includes("cdn.jsdelivr.net")) return r.fulfill({ status: 200, contentType: "text/javascript", body: STUB }); return r.abort(); });
  const errosJs = [];
  const abrir = async () => {
    const page = await ctx.newPage(); page.setDefaultTimeout(15000);
    page.on("pageerror", (e) => { errosJs.push(e.message); console.log("  pageerror:", e.message, String(e.stack ?? "").split(String.fromCharCode(10)).slice(1, 3).join(" ")); });
    page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400) console.log("  http", r.status(), r.url().replace(srv.url, "")); });
    const pendentes = new Set(); page.on("request", (r) => { if (r.url().includes("/api/")) pendentes.add(r.url()); }); page.on("requestfinished", (r) => pendentes.delete(r.url())); globalThis.__pend = pendentes;
    page.on("requestfailed", (r) => console.log("  falhou:", r.url().replace(srv.url, "").slice(0, 160), r.failure()?.errorText));
    page.on("console", (m) => { if (m.type() === "error") console.log("  console:", m.text().slice(0, 200)); });
    return page;
  };
  let page = await abrir();
  await page.goto(`${srv.url}/financeiro-v2/?modo=plataforma#/visao-geral`);
  await page.waitForFunction(() => document.documentElement.dataset.dados === "disponivel", null, { timeout: 20000 });
  const menu = await page.locator("#navegacao, .navegacao").first().innerText();
  if (subway) registrar(unidade, "menu sem SAIPOS e sem Anota Aí", !/SAIPOS|Anota/i.test(menu));
  for (const [rota, canal, arquivo, tipo] of (process.env.ORDEM === "99" ? [["noventa-e-nove-food", "99Food", caminho99, "NOVENTA_E_NOVE_FOOD_RELATORIO"], ["ifood", "iFood", caminhoIfood, "IFOOD_CONCILIACAO"]] : [["ifood", "iFood", caminhoIfood, "IFOOD_CONCILIACAO"], ["noventa-e-nove-food", "99Food", caminho99, "NOVENTA_E_NOVE_FOOD_RELATORIO"]])) {
    const g = `${unidade}/${canal}`;
    page = await abrir(); // aba nova por canal: cada fluxo começa limpo, como uma pessoa abrindo a tela
    await page.goto(`${srv.url}/financeiro-v2/?modo=plataforma#/${rota}`);
    try { await page.waitForFunction(() => document.documentElement.dataset.dados === "disponivel" && !document.querySelector(".esqueleto-pagina"), null, { timeout: 20000 }); } catch (e) {
      await page.screenshot({ path: join(fotos, `${unidade}-${rota}-0-carregando.png`), fullPage: true });
      console.log("  pendentes:", [...(globalThis.__pend ?? [])].map((u) => u.replace(srv.url, "").slice(0, 200)));
      console.log("  estado:", await page.evaluate(() => JSON.stringify({ dados: document.documentElement.dataset.dados, boot: document.documentElement.dataset.boot, esq: document.querySelectorAll(".esqueleto-pagina").length, h1: document.querySelector("h1")?.innerText, aviso: document.querySelector(".aviso, .estado")?.innerText?.slice(0, 200) })));
      throw e;
    }
    await page.locator('[data-aba-canal="importacoes"]').first().click();
    const form = page.locator('form[data-acao$="/importacao/receber"]').first();
    await form.waitFor({ timeout: 20000 });
    registrar(g, "botão/formulário de envio disponível", await form.locator('button[type="submit"]').isEnabled());
    const opcoes = await form.locator('select[name="tipoRelatorio"] option').evaluateAll((os) => os.map((o) => o.value));
    registrar(g, `relatório oficial oferecido (${tipo})`, opcoes.includes(tipo), opcoes.join(","));
    await form.locator('select[name="tipoRelatorio"]').selectOption(tipo);
    await form.locator('input[name="periodoInicio"]').fill("2026-11-01");
    await form.locator('input[name="periodoFim"]').fill("2026-11-17");
    await form.locator('input[name="arquivo"]').setInputFiles(arquivo);
    await form.locator('input[name="confirmar"]').check();
    await form.locator('button[type="submit"]').click();
    // prévia do documento: aparece o botão de confirmar a importação
    const confirmar = page.locator('form[data-acao$="/importacao/confirmar"]').first();
    try { await confirmar.waitFor({ timeout: 20000 }); } catch (e) {
      await page.screenshot({ path: join(fotos, `${unidade}-${rota}-0-sem-previa.png`), fullPage: true });
      console.log("  resultado:", JSON.stringify(await form.locator(".resultado-acao").innerText().catch(() => "")), "| detalhe aberto:", JSON.stringify((await page.locator("[role=dialog], .detalhe, .painel-detalhe").first().innerText().catch(() => "")).slice(0, 400)));
      console.log("  forms:", JSON.stringify(await page.locator("form[data-acao]").evaluateAll((fs) => fs.map((f) => f.dataset.acao))));
      throw e;
    }
    await page.screenshot({ path: join(fotos, `${unidade}-${rota}-1-previa.png`), fullPage: true });
    const textoPrevia = await page.locator("body").innerText();
    registrar(g, "prévia exibida antes de gravar", /prévia|Prévia/.test(textoPrevia));
    if (subway) registrar(g, "prévia sem SAIPOS/Anota Aí", !/SAIPOS|Anota A[ií]/i.test(textoPrevia), (textoPrevia.match(/.{0,60}(SAIPOS|Anota A[ií]).{0,40}/i) ?? [""])[0]);
    // confirmar (com aceite e justificativa quando a prévia pede)
    for (const cx of await confirmar.locator('input[type="checkbox"]').all()) await cx.check();
    const just = confirmar.locator('[name="justificativa"]');
    if (await just.count()) await just.fill("Teste sintético do fluxo de importação.");
    await confirmar.locator('button[type="submit"]').click();
    await page.waitForFunction(() => /Importad[oa]|importação confirmada|IMPORTADO/i.test(document.body.innerText) && !document.querySelector('form[data-acao$="/importacao/confirmar"] button[disabled]'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(fotos, `${unidade}-${rota}-2-confirmado.png`), fullPage: true });
    const estado = await srv.estadoDaUltimaImportacao?.(tipo);
    const depois = await page.locator("body").innerText();
    registrar(g, "importação confirmada", /Importad[oa]( com pendências)?|IMPORTADO/i.test(depois) || estado === "IMPORTADO" || estado === "IMPORTADO_COM_PENDENCIAS", estado ?? "");
    if (tipo === "IFOOD_CONCILIACAO") {
      // prévia da aplicação (conciliação): a pendência de classificação aparece DENTRO da prévia
      const conferir = page.getByRole("button", { name: /Conferir|Ver prévia|conciliação/i }).first();
      if (await conferir.count()) await conferir.click().catch(() => {});
      await page.waitForTimeout(800);
      const t = await page.locator("body").innerText();
      await page.screenshot({ path: join(fotos, `${unidade}-${rota}-3-previa-aplicacao.png`), fullPage: true });
      registrar(g, "pendência de classificação visível na prévia (Ressarcimento iFood)", /Ressarcimento iFood/.test(t) && /Classificar antes de aplicar|classifi/i.test(t));
    }
  }
  registrar(unidade, "sem erro de JavaScript", errosJs.length === 0, errosJs.join(" | "));
  await ctx.close(); await srv.fechar();
}

for (const u of ["subway", "acai"]) {
  try { await fluxo(u); } catch (e) { registrar(u, "fluxo concluído sem exceção", false, e.message.split("\n")[0]); }
}
await browser.close();
const falhas = resultados.filter((r) => !r.ok);
console.log(`${resultados.length - falhas.length}/${resultados.length} verificações no navegador · capturas em ${fotos}`);
process.exitCode = falhas.length ? 1 : 0;
