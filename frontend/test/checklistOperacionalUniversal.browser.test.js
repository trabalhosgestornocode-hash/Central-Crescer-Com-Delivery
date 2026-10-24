// Checklist Operacional — verificação VISUAL da universalização e dos tempos novos, em NAVEGADOR REAL (Chromium/Chrome via Playwright).
//
// Servidor local em memória: serve o frontend e responde /resumo com o cálculo REAL do backend sobre pedidos de TESTE (fixture).
// Nunca fala com produção, Supabase ou iFood. Relógio do navegador controlado (page.clock) para polling e cronômetros serem determinísticos.
// A sessão do teste tem SÓ o módulo `checklist_operacional` (sem `ifood`) e a permissão `checklist.visualizar`: prova que a tela não
// depende do módulo iFood.
//
// Rodar:
//   CHECKLIST_PLAYWRIGHT_PATH=<...>/worker-martinbrower/node_modules/playwright CHECKLIST_BROWSER_CHANNEL=chrome \
//   node --test frontend/test/checklistOperacionalUniversal.browser.test.js
// CHECKLIST_SCREENSHOTS=<pasta> grava as capturas (evidência visual).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ORG, UNIDADE, respostaResumo, pedidosDoDia } from "./checklistOperacionalFixture.js";

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)(process.env.CHECKLIST_PLAYWRIGHT_PATH || process.env.PERFORMANCE_PLAYWRIGHT_PATH || "playwright"));
} catch { /* sem Playwright: pulado */ }
const PULAR = !chromium && "Configure CHECKLIST_PLAYWRIGHT_PATH (Playwright) para rodar no navegador";
const CANAL = process.env.CHECKLIST_BROWSER_CHANNEL || process.env.PERFORMANCE_BROWSER_CHANNEL;
const CAPTURAS = process.env.CHECKLIST_SCREENSHOTS;

const AGORA = Date.parse("2026-10-09T15:00:00.000Z"); // 12:00 em São Paulo
const RAIZ = resolve(fileURLToPath(new URL("..", import.meta.url)));

const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/checklistOperacional.css">
<script>window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}})}})};</script>
</head><body>
<div id="login-screen" hidden></div><div id="selecao-screen" hidden></div>
<div id="app" class="app"><aside id="sidebar" class="sidebar"><nav class="menu"><ul id="menu"></ul></nav></aside>
<div class="main"><header class="topbar"><h1 id="page-title">Checklist Operacional</h1></header><main id="view" class="content"></main></div></div>
</body></html>`;

const SEM_INTEGRACAO = () => ({
  ...respostaResumo(AGORA, {
    pedidos: [],
    integracao: { estado: "nao_ativada", motivo: "sem_loja_vinculada", mensagem: "Esta unidade ainda não tem uma loja iFood vinculada à Central.", ultimaSincronizacao: null },
  }),
  modo: "sem_integracao",
});
const COM_INTEGRACAO = () => ({ ...respostaResumo(AGORA), modo: "integrado" });

// Checklist 2.0: o servidor é a fonte das metas — vêm em todo resumo (com a versão) e PUT /metas grava com a versão que a
// tela tinha (versão diferente = 409 METAS_CONFLITO), como o backend real (checklistOperacional.service#salvarMetas).
const METAS_PADRAO = () => ({ origem: "padrao", versao: 0, valores: { preparo: { meta: 12, avisoPct: 80 }, entrega: { meta: 35, avisoPct: 80 }, vida: { meta: 45, avisoPct: 80 } }, atualizadoEm: null, atualizadoPor: null });
const api = { consultas: 0, falhar: false, erro: null, dados: COM_INTEGRACAO, metas: METAS_PADRAO(), gravacoes: 0 };
let servidor; let base;

before(async () => {
  if (PULAR) return;
  servidor = createServer((req, res) => {
    const caminho = new URL(req.url, "http://x").pathname;
    if (caminho === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(PAGINA); return; }
    if (caminho === "/favicon.ico") { res.writeHead(204).end(); return; }
    if (caminho === "/api/config") { res.setHeader("Content-Type", "application/json"); res.end('{"supabaseUrl":"http://127.0.0.1:9","supabaseAnonKey":"x"}'); return; }
    if (caminho === "/api/v1/checklist-operacional/resumo") {
      api.consultas += 1;
      if (api.falhar) { res.writeHead(503, { "Content-Type": "application/json" }); res.end('{"error":"indisponível"}'); return; }
      if (api.erro) { res.writeHead(api.erro.status, { "Content-Type": "application/json" }); res.end(JSON.stringify(api.erro.corpo)); return; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: { ...api.dados(), metas: api.metas } }));
      return;
    }
    if (caminho === "/api/v1/checklist-operacional/metas" && req.method === "PUT") {
      let corpo = "";
      req.on("data", (c) => { corpo += c; });
      req.on("end", () => {
        const { versao, metas } = JSON.parse(corpo || "{}");
        res.setHeader("Content-Type", "application/json");
        if (versao !== api.metas.versao) {
          res.writeHead(409);
          res.end(JSON.stringify({ error: "As metas foram alteradas em outro aparelho.", codigo: "METAS_CONFLITO", details: { metas: api.metas } }));
          return;
        }
        api.gravacoes += 1;
        api.metas = { origem: "unidade", versao: api.metas.versao + 1, valores: metas, atualizadoEm: new Date(AGORA).toISOString(), atualizadoPor: "Gestora" };
        res.end(JSON.stringify({ data: { resultado: "salvo", metas: api.metas } }));
      });
      return;
    }
    const arq = resolve(RAIZ, "." + caminho);
    if (!arq.startsWith(RAIZ + sep)) { res.writeHead(403).end(); return; }
    try {
      res.setHeader("Content-Type", arq.endsWith(".css") ? "text/css" : arq.endsWith(".svg") ? "image/svg+xml" : "text/javascript");
      res.end(readFileSync(arq));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  if (CAPTURAS) mkdirSync(CAPTURAS, { recursive: true });
});
after(async () => { if (servidor) await new Promise((r) => servidor.close(r)); });

const zerar = (dados = COM_INTEGRACAO) => Object.assign(api, { consultas: 0, falhar: false, erro: null, dados, metas: METAS_PADRAO(), gravacoes: 0 });

async function abrir(browser, { viewport = { width: 1920, height: 1080 } } = {}) {
  const pagina = await browser.newPage({ viewport });
  const erros = [];
  pagina.on("pageerror", (e) => erros.push(e.message));
  pagina.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) erros.push(m.text()); });
  await pagina.clock.install({ time: AGORA });
  await pagina.clock.pauseAt(AGORA);
  await pagina.goto(base + "/");
  await pagina.evaluate(async ({ org, unidade }) => {
    const { state } = await import("/src/state.js");
    Object.assign(state.sessao, {
      empresa: { id: org, nome: "Empresa de teste" }, unidade,
      permissoes: ["checklist.visualizar", "configuracoes.gerenciar"], modulos: ["checklist_operacional"],   // SEM o módulo ifood
    });
    state.rota = "checklist-operacional";
    window.__checklist = await import("/src/checklistOperacional.js");
    window.__state = state;
    window.__checklist.renderChecklistOperacional();
  }, { org: ORG, unidade: UNIDADE });
  return { pagina, erros };
}

const assentar = async (pagina) => { for (let i = 0; i < 3; i++) { await pagina.clock.runFor(1); await new Promise((r) => setTimeout(r, 120)); } };

async function iniciarModo(pagina, modo) {
  await pagina.locator(`[data-acao="iniciar-modo"][data-modo="${modo}"]`).click();
  await pagina.locator(`.cko--${modo}`).waitFor();
  await pagina.waitForFunction(() => !document.querySelector("[data-cko] [data-aviso]")?.textContent.startsWith("Carregando"));
  await assentar(pagina);
}

const foto = async (pagina, nome) => { if (CAPTURAS) await pagina.screenshot({ path: resolve(CAPTURAS, `${nome}.png`) }); };
const semRolagemHorizontal = (pagina) => pagina.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const textoVisivel = (pagina, seletor) => pagina.evaluate((s) => [...document.querySelectorAll(s)].map((n) => n.textContent.replace(/\s+/g, " ").trim()), seletor);

describe("Checklist Operacional — universalização e tempos em navegador real", { skip: PULAR, timeout: 180_000 }, () => {
  let browser;
  before(async () => { browser = await chromium.launch({ headless: true, ...(CANAL ? { channel: CANAL } : {}) }); });
  after(async () => { await browser?.close(); });

  test("unidade COM iFood, sessão só com o módulo checklist_operacional: indicadores, definições novas e decomposição em dois trechos", async () => {
    zerar();
    const { pagina, erros } = await abrir(browser);
    await iniciarModo(pagina, "tv");
    const cards = await textoVisivel(pagina, "[data-card]");
    assert.equal(cards.length, 3);
    assert.match(cards[0], /Tempo de preparo/);
    assert.match(cards[0], /Da chegada do pedido até a saída para entrega/);
    assert.match(cards[1], /Da saída até a conclusão registrada pelo iFood/);
    assert.match(cards[2], /Da chegada até a conclusão/);
    // Amostras e médias aparecem; entrega marcada "≈".
    assert.match(cards[0], /Média hoje \d+ pedidos?/);
    assert.ok(cards[1].includes("≈"));
    // Vida: linha da decomposta e barra com EXATAMENTE dois trechos medidos (preparo + entrega), sem sobreposição.
    assert.match(cards[2], /Com os 3 horários \(\d+ pedidos?\): [\d,]+ \+ [\d,]+ = [\d,]+ min/);
    const trechos = await pagina.locator(".cko-decomp-barra .cko-decomp-seg:not(.cko-decomp-seg--lacuna)").count();
    assert.equal(trechos, 2);
    assert.deepEqual(await textoVisivel(pagina, ".cko-decomp-legenda li").then((l) => l.map((t) => t.split(" ")[0])), ["Preparo", "Entrega"]);
    // Sem o aviso de "sem integração" quando há integração.
    assert.equal(await pagina.getByText("Unidade sem integração com o iFood").count(), 0);
    assert.equal(await pagina.locator(".cko-selo--ok").count() > 0, true);
    await foto(pagina, "universal-com-ifood-tv-1920x1080");
    assert.deepEqual(erros, []);
    await pagina.close();
  });

  test("unidade SEM iFood (TV e Tablet): abre sem erro, aviso informativo, nenhum número e nenhum horário fictício", async () => {
    for (const [modo, viewport] of [["tv", { width: 1920, height: 1080 }], ["tablet", { width: 1024, height: 768 }]]) {
      zerar(SEM_INTEGRACAO);
      const { pagina, erros } = await abrir(browser, { viewport });
      await iniciarModo(pagina, modo);
      const tudo = (await textoVisivel(pagina, "[data-cko]")).join(" ");
      assert.match(tudo, /Unidade sem integração com o iFood/);
      assert.match(tudo, /Nenhum número é estimado/);
      assert.match(tudo, /Nenhum pedido em andamento agora/);
      // Nenhum valor de tempo: nenhum "NN,N min" nos cards/lista e nenhum cronômetro.
      assert.equal(await pagina.locator('[data-card] .cko-hoje dd[class*="cko-nivel-txt"]').count(), 0, "nenhum tempo medido (média/último) pode aparecer");
      assert.equal(await pagina.locator("[data-card] .cko-hoje-vazio").count() >= 3, true, "médias e últimos aparecem como '—'");
      assert.equal(await pagina.locator("[data-crono]").count(), 0);
      assert.equal(await pagina.locator(".cko-decomp-barra").count(), 0);
      assert.doesNotMatch(tudo, /undefined|NaN|Invalid/);
      assert.equal(await semRolagemHorizontal(pagina), true);
      await foto(pagina, `universal-sem-ifood-${modo}-${viewport.width}x${viewport.height}`);
      assert.deepEqual(erros, [], modo);
      await pagina.close();
    }
  });

  test("unidade sem iFood em TV 1280×720: nada cortado e sem rolagem", async () => {
    zerar(SEM_INTEGRACAO);
    const { pagina, erros } = await abrir(browser, { viewport: { width: 1280, height: 720 } });
    await iniciarModo(pagina, "tv");
    assert.equal(await pagina.evaluate(() => document.documentElement.scrollHeight <= document.documentElement.clientHeight + 1), true, "TV sem rolagem");
    await foto(pagina, "universal-sem-ifood-tv-1280x720");
    assert.deepEqual(erros, []);
    await pagina.close();
  });

  test("cronômetros em andamento avançam com o relógio e os pedidos atualizam no ciclo seguinte", async () => {
    zerar();
    const { pagina, erros } = await abrir(browser);
    await iniciarModo(pagina, "tablet");
    const antes = await textoVisivel(pagina, "[data-crono]");
    assert.ok(antes.length >= 3, "há pedidos em andamento com cronômetro");
    await pagina.clock.runFor(10_000);
    await assentar(pagina);
    const depois = await textoVisivel(pagina, "[data-crono]");
    assert.notDeepEqual(depois, antes, "o cronômetro andou");
    // Atualização: um pedido novo aparece depois do polling (30 s).
    const consultas = api.consultas;
    api.dados = () => {
      const r = respostaResumo(AGORA, { pedidos: [...pedidosDoDia(AGORA), { ...pedidosDoDia(AGORA)[9], order_id: "novo-1", display_id: "4999", criado_em: new Date(AGORA - 60_000).toISOString(), placed_event_created_at: new Date(AGORA - 60_000).toISOString(), order_created_at: new Date(AGORA - 60_000).toISOString(), primeiro_evento_em: new Date(AGORA - 60_000).toISOString(), status_oficial: "PLACED", confirmed_event_at: null, status_oficial_em: new Date(AGORA - 60_000).toISOString() }] });
      return { ...r, modo: "integrado" };
    };
    await pagina.clock.runFor(31_000);
    await assentar(pagina);
    assert.ok(api.consultas > consultas, "consultou de novo");
    assert.ok((await textoVisivel(pagina, ".cko-painel--ativos")).join(" ").includes("#4999"), "pedido novo na lista de andamento");
    assert.deepEqual(erros, []);
    await pagina.close();
  });

  test("mensagens de indisponibilidade: sem conexão (503) e sem acesso (403, sem citar iFood)", async () => {
    zerar();
    api.falhar = true;
    let a = await abrir(browser);
    await iniciarModo(a.pagina, "tv");
    assert.match((await textoVisivel(a.pagina, "[data-aviso]")).join(" "), /Sem conexão/);
    await foto(a.pagina, "universal-indisponivel-503");
    assert.deepEqual(a.erros, []);
    await a.pagina.close();

    // 403 com o modo aberto (perdeu o módulo/permissão): volta à seleção, sem números, e a mensagem não fala em "pedidos iFood".
    zerar();
    a = await abrir(browser);
    await iniciarModo(a.pagina, "tv");
    api.erro = { status: 403, corpo: { error: "Sem permissão." } };
    await a.pagina.clock.runFor(31_000);
    await assentar(a.pagina);
    const aviso = await a.pagina.locator(".ckm-aviso").textContent();
    assert.match(aviso, /não tem mais acesso ao Checklist Operacional/);
    assert.doesNotMatch(aviso, /pedidos iFood/);
    assert.equal(await a.pagina.locator("[data-card]").count(), 0, "sem números");
    await foto(a.pagina, "universal-indisponivel-403");
    assert.deepEqual(a.erros, []);
    await a.pagina.close();
  });

  test("diálogo de metas: a referência p75 só PREENCHE o formulário; a meta da tela muda apenas ao aplicar; exemplo intacto", async () => {
    zerar();
    const { pagina, erros } = await abrir(browser, { viewport: { width: 1280, height: 900 } });
    // Fora do modo imersivo (página de seleção): o botão Metas existe na própria página do Checklist.
    await iniciarModo(pagina, "tablet");
    await pagina.locator('[data-acao="metas"]').click();
    const dlg = pagina.locator("dialog.cko-metas-dialogo, dialog[open]").first();
    await dlg.waitFor();
    const valor = (nome) => dlg.locator(`input[name="${nome}"]`).inputValue();
    assert.deepEqual([await valor("preparoMeta"), await valor("entregaMeta"), await valor("vidaMeta")], ["12", "35", "45"], "padrão = exemplo, NÃO a referência");
    assert.match(await dlg.textContent(), /Referência observada \(p75\)/);
    await dlg.locator('[data-acao="metas-referencia"]').click();
    assert.deepEqual([await valor("preparoMeta"), await valor("entregaMeta"), await valor("vidaMeta")], ["16,3", "12,6", "28,1"]);
    await foto(pagina, "universal-dialogo-metas-referencia-p75");
    await dlg.locator('[data-acao="metas-cancelar"]').click();
    // Cancelou: a tela continua com a meta de exemplo do preparo (12 min).
    assert.match((await textoVisivel(pagina, '[data-card="preparo"]')).join(" "), /Meta\s*12,0 min/);
    // Reabre, usa a referência e APLICA: agora a meta do preparo é 16,3.
    await pagina.locator('[data-acao="metas"]').click();
    await dlg.waitFor();
    await dlg.locator('[data-acao="metas-referencia"]').click();
    await dlg.locator('button[type="submit"]').click();
    await assentar(pagina);
    assert.match((await textoVisivel(pagina, '[data-card="preparo"]')).join(" "), /Meta\s*16,3 min/);
    // Checklist 2.0: aplicar = gravar no servidor UMA vez (versão 0 → 1); o cancelar de antes não gravou nada.
    assert.equal(api.gravacoes, 1);
    assert.equal(api.metas.versao, 1);
    assert.equal(api.metas.valores.preparo.meta, 16.3);
    assert.deepEqual(erros, []);
    await pagina.close();
  });

  test("layout responsivo com iFood: Tablet em quatro formatos, sem rolagem horizontal e com os três indicadores", async () => {
    for (const [w, h] of [[768, 1024], [1024, 768], [820, 1180], [1180, 820]]) {
      zerar();
      const { pagina, erros } = await abrir(browser, { viewport: { width: w, height: h } });
      await iniciarModo(pagina, "tablet");
      assert.equal(await pagina.locator("[data-card]").count(), 3, `${w}x${h}`);
      assert.equal(await semRolagemHorizontal(pagina), true, `${w}x${h}`);
      await foto(pagina, `universal-com-ifood-tablet-${w}x${h}`);
      assert.deepEqual(erros, [], `${w}x${h}`);
      await pagina.close();
    }
  });
});
