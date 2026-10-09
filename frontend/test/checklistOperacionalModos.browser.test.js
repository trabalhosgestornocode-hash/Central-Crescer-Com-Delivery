// Checklist Operacional — modos Televisão e Tablet em NAVEGADOR REAL (Chromium via Playwright).
//
// Servidor local em memória: serve o frontend e responde /resumo com o cálculo REAL do backend sobre pedidos
// de teste. Nunca fala com produção, Supabase ou iFood. Relógio do navegador controlado (page.clock) para o
// polling e os contadores serem determinísticos.
//
// Rodar (precisa do Playwright; o repositório já o tem em worker-martinbrower):
//   CHECKLIST_PLAYWRIGHT_PATH=<...>/worker-martinbrower/node_modules/playwright CHECKLIST_BROWSER_CHANNEL=chrome \
//   node --test frontend/test/checklistOperacionalModos.browser.test.js
// CHECKLIST_SCREENSHOTS=<pasta> grava as capturas de cada resolução.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ORG, UNIDADE, OUTRA_UNIDADE, respostaResumo, pedidosEmMassa } from "./checklistOperacionalFixture.js";

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
<div id="app" class="app"><aside id="sidebar" class="sidebar"><nav class="menu"><ul id="menu"><li data-rota="checklist-operacional"><a href="#checklist">Checklist Operacional</a></li><li><a href="#vendas">Vendas</a></li></ul></nav></aside>
<div class="main"><header class="topbar"><h1 id="page-title">Checklist Operacional</h1><button type="button" id="seletor-unidade">Trocar unidade</button></header><main id="view" class="content"></main></div></div>
</body></html>`;

// ---------------------------------------------------------------------------
// Servidor de teste: frontend estático + /resumo controlável
// ---------------------------------------------------------------------------

const api = { consultas: 0, unidades: [], segurar: null, falhar: false, dados: () => respostaResumo(AGORA) };
let servidor; let base;

before(async () => {
  if (PULAR) return;
  servidor = createServer(async (req, res) => {
    const caminho = new URL(req.url, "http://x").pathname;
    if (caminho === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(PAGINA); return; }
    if (caminho === "/favicon.ico") { res.writeHead(204).end(); return; }
    if (caminho === "/api/config") { res.setHeader("Content-Type", "application/json"); res.end('{"supabaseUrl":"http://127.0.0.1:9","supabaseAnonKey":"x"}'); return; }
    if (caminho === "/api/v1/checklist-operacional/resumo") {
      api.consultas += 1;
      api.unidades.push(req.headers["x-teste-unidade"] ?? null);
      if (api.segurar) await api.segurar;
      if (api.falhar) { res.writeHead(503, { "Content-Type": "application/json" }); res.end('{"error":"indisponível"}'); return; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: api.dados() }));
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
});
after(async () => { if (servidor) await new Promise((r) => servidor.close(r)); });

function zerarApi() {
  Object.assign(api, { consultas: 0, unidades: [], segurar: null, falhar: false, dados: () => respostaResumo(AGORA) });
}

/** Abre a Central de teste com uma sessão em memória e a rota do Checklist já renderizada. */
async function abrirCentral(browser, { viewport = { width: 1920, height: 1080 }, recusarTelaCheia = false, url = "/" } = {}) {
  const pagina = await browser.newPage({ viewport });
  const erros = [];
  pagina.on("pageerror", (e) => erros.push(e.message));
  pagina.on("console", (m) => { if (m.type() === "error") erros.push(m.text()); });
  await pagina.clock.install({ time: AGORA });
  await pagina.clock.pauseAt(AGORA);
  if (recusarTelaCheia) {
    await pagina.addInitScript(() => {
      Element.prototype.requestFullscreen = function () { return Promise.reject(new TypeError("Permissions check failed")); };
    });
  }
  await pagina.goto(base + url);
  await pagina.evaluate(async ({ org, unidade }) => {
    const { state } = await import("/src/state.js");
    Object.assign(state.sessao, {
      empresa: { id: org, nome: "Empresa de teste" }, unidade, permissoes: ["integracoes.ver"], modulos: ["ifood"],
    });
    state.rota = "checklist-operacional";
    window.__checklist = await import("/src/checklistOperacional.js");
    window.__bus = await import("/src/realtime/realtimeBus.js");
    window.__contexto = await import("/src/contextoEscopo.js");
    window.__state = state;
    window.__checklist.renderChecklistOperacional();
  }, { org: ORG, unidade: UNIDADE });
  return { pagina, erros };
}

/** Deixa o navegador processar respostas e redesenhos sem avançar o relógio da tela. */
// (Os timers da página são do relógio falso: a espera real fica do lado do Node.)
const assentar = async (pagina) => {
  for (let i = 0; i < 3; i++) { await pagina.clock.runFor(1); await new Promise((r) => setTimeout(r, 120)); }
};

async function iniciarModo(pagina, modo) {
  await pagina.locator(`[data-acao="iniciar-modo"][data-modo="${modo}"]`).click();
  await pagina.locator(`.cko--${modo}`).waitFor();
  await pagina.waitForFunction(() => document.querySelector("[data-cko] [data-aviso]")?.textContent !== "Carregando. Buscando o resumo da unidade.");
  await pagina.waitForFunction(() => document.querySelector("[data-cko] .cko-selo")?.textContent.includes("Ao vivo")
    || !document.querySelector("[data-cko] [data-aviso]")?.textContent.startsWith("Carregando"));
}

async function voltar(pagina) {
  await pagina.locator('[data-acao="voltar"]').click();
  await pagina.locator("[data-ckm]").waitFor();
}

/** Tudo o que a tela INFORMA (texto visível dos indicadores, alertas e estados), na ordem. */
const informacoes = (pagina) => pagina.evaluate(() => {
  const raiz = document.querySelector("[data-cko]");
  const t = (sel) => [...raiz.querySelectorAll(sel)].map((n) => n.textContent.replace(/\s+/g, " ").trim());
  return {
    aviso: t("[data-aviso], .cko-faixa-demo"),
    selo: t(".cko-selo"),
    cards: t("[data-card]"),
    status: t(".cko-status"),
    ativos: t(".cko-painel--ativos .cko-painel-cab, .cko-painel--ativos [data-pedido]"),
    ultimos: t(".cko-painel--ultimos tbody tr"),
    avaliacoes: t(".cko-painel--avaliacoes"),
  };
});

describe("Checklist Operacional — modos no navegador", { skip: PULAR, timeout: 120_000 }, () => {
  let browser;
  before(async () => { browser = await chromium.launch({ headless: true, ...(CANAL ? { channel: CANAL } : {}) }); });
  after(async () => { await browser?.close(); });

  test("seleção mostra os dois modos e não consulta nada até escolher", async () => {
    zerarApi();
    const { pagina, erros } = await abrirCentral(browser);
    assert.equal(await pagina.locator(".ckm-opcao").count(), 2);
    assert.equal(await pagina.getByRole("button", { name: "Iniciar Modo Televisão" }).isVisible(), true);
    assert.equal(await pagina.getByRole("button", { name: "Iniciar Modo Tablet" }).isVisible(), true);
    assert.equal(await pagina.locator("#sidebar").isVisible(), true, "a seleção é uma página normal da Central");
    await pagina.clock.runFor(65_000);
    assert.equal(api.consultas, 0);
    assert.deepEqual(erros, []);
    await pagina.close();
  });

  test("Modo Televisão e Modo Tablet abrem, cobrem a Central e mostram as MESMAS informações", async () => {
    zerarApi();
    const { pagina, erros } = await abrirCentral(browser);
    await iniciarModo(pagina, "tv");
    assert.equal(await pagina.locator(".cko--tv.cko--imersivo").count(), 1);
    const cobre = await pagina.evaluate(() => {
      const r = document.querySelector("[data-cko]").getBoundingClientRect();
      const noMenu = document.elementFromPoint(20, 300);
      return { x: r.x, y: r.y, w: r.width, h: r.height, menuCoberto: !document.querySelector("#sidebar").contains(noMenu) };
    });
    assert.deepEqual([cobre.x, cobre.y, cobre.w, cobre.h, cobre.menuCoberto], [0, 0, 1920, 1080, true]);
    const tv = await informacoes(pagina);
    assert.equal(api.consultas, 1);

    await voltar(pagina);
    await iniciarModo(pagina, "tablet");
    assert.equal(await pagina.locator(".cko--tablet.cko--imersivo").count(), 1);
    const tablet = await informacoes(pagina);
    assert.deepEqual(tablet, tv);
    assert.equal(tv.cards.length, 3);
    assert.ok(tv.ativos.length >= 8, "cabeçalho + 7 pedidos em andamento");
    assert.ok(tv.ativos.some((l) => l.includes("Aberto há mais de 4 h sem conclusão")));
    assert.ok(tv.avaliacoes[0].includes("Avaliações ainda não conectadas"));
    assert.ok(tv.cards[1].includes("≈"), "entrega identificada como aproximada");
    assert.deepEqual(erros, []);
    await pagina.close();
  });

  test("alternar modos não duplica polling nem inscrição do Realtime", async () => {
    zerarApi();
    const { pagina, erros } = await abrirCentral(browser);
    const interesses = await pagina.evaluate(() => window.__bus._interessesAtivos());
    for (const modo of ["tv", "tablet", "tv", "tablet"]) {
      await iniciarModo(pagina, modo);
      await voltar(pagina);
    }
    await iniciarModo(pagina, "tv");
    assert.equal(await pagina.evaluate(() => window.__bus._interessesAtivos()), interesses, "nenhum interesse novo no bus");
    const depoisDeAbrir = api.consultas;
    assert.equal(depoisDeAbrir, 5, "uma consulta por abertura de modo");

    // Polling: em 30 s (+ folga), UMA consulta — não uma por modo já aberto.
    await pagina.clock.runFor(31_000);
    await assentar(pagina);
    assert.equal(api.consultas, depoisDeAbrir + 1);

    // Aviso do Realtime da MINHA unidade: UMA consulta; de outra unidade: nenhuma.
    await pagina.evaluate(({ org, u }) => window.__bus.receberEvento({ tipo: "ifood_pedido.estado_atualizado", organizacaoId: org, unidadeId: u }), { org: ORG, u: UNIDADE.id });
    await pagina.clock.runFor(2_000);
    await assentar(pagina);
    assert.equal(api.consultas, depoisDeAbrir + 2);
    await pagina.evaluate(({ org, u }) => window.__bus.receberEvento({ tipo: "ifood_pedido.estado_atualizado", organizacaoId: org, unidadeId: u }), { org: ORG, u: OUTRA_UNIDADE.id });
    await pagina.clock.runFor(2_000);
    await assentar(pagina);
    assert.equal(api.consultas, depoisDeAbrir + 2);

    // De volta à seleção: nada mais é consultado, nem por polling nem por aviso.
    await voltar(pagina);
    const naSelecao = api.consultas;
    await pagina.evaluate(({ org, u }) => window.__bus.receberEvento({ tipo: "ifood_pedido.estado_atualizado", organizacaoId: org, unidadeId: u, versao: 2 }), { org: ORG, u: UNIDADE.id });
    await pagina.clock.runFor(125_000);
    await assentar(pagina);
    assert.equal(api.consultas, naSelecao);
    assert.deepEqual(erros, []);
    await pagina.close();
  });

  test("troca de unidade: a resposta antiga é descartada e a tela volta à seleção da unidade nova", async () => {
    zerarApi();
    const { pagina, erros } = await abrirCentral(browser);
    let soltar;
    api.segurar = new Promise((r) => { soltar = r; });
    await pagina.locator('[data-acao="iniciar-modo"][data-modo="tv"]').click();
    await pagina.locator(".cko--tv").waitFor();
    await pagina.waitForFunction(() => true);
    // Troca de unidade com a consulta da unidade antiga ainda em voo (o mesmo funil do app: resetarEscopoDeContexto).
    await pagina.evaluate((nova) => {
      window.__state.sessao.unidade = nova;
      window.__contexto.resetarEscopoDeContexto();
      window.__checklist.renderChecklistOperacional();
    }, OUTRA_UNIDADE);
    api.segurar = null;
    soltar();
    await assentar(pagina);
    await pagina.clock.runFor(1_000);
    assert.equal(await pagina.locator("[data-cko]").count(), 0, "nenhum dashboard da unidade antiga");
    assert.match(await pagina.locator(".ckm-contexto").textContent(), /Unidade de teste Norte/);
    await pagina.clock.runFor(65_000);
    assert.equal(api.consultas, 1, "nada é consultado na seleção da unidade nova");
    assert.deepEqual(erros, []);
    await pagina.close();
  });

  test("tela cheia: entra no clique; Esc mantém o modo; voltar sai da tela cheia", async () => {
    zerarApi();
    const { pagina, erros } = await abrirCentral(browser);
    await iniciarModo(pagina, "tv");
    await assentar(pagina);
    const estado = () => pagina.evaluate(() => {
      const raiz = document.querySelector("[data-cko]");
      return {
        cheia: document.fullscreenElement === raiz,
        classe: raiz.classList.contains("cko--tela-cheia"),
        botao: raiz.querySelector("[data-rotulo-tela]").textContent,
        aviso: raiz.querySelector("[data-aviso-tela]").hidden ? "" : raiz.querySelector("[data-aviso-tela]").textContent,
      };
    });
    const dentro = await estado();
    // Nunca finge: a classe e o botão seguem o que o navegador diz.
    assert.equal(dentro.classe, dentro.cheia);
    if (dentro.cheia) {
      assert.equal(dentro.botao, "Sair da tela cheia");
      // Esc: quem encerra é o navegador (aqui, a mesma API que o Esc dispara).
      await pagina.evaluate(() => document.exitFullscreen());
      await pagina.waitForFunction(() => !document.fullscreenElement);
      await assentar(pagina);
      const fora = await estado();
      assert.deepEqual([fora.cheia, fora.classe, fora.botao], [false, false, "Tela cheia"]);
      assert.equal(await pagina.locator(".cko--tv.cko--imersivo").count(), 1, "continua no modo, dentro da página");
      assert.equal(await pagina.getByRole("button", { name: "Voltar ao Checklist" }).isVisible(), true);
      // Tentar de novo pelo botão.
      await pagina.locator('[data-acao="tela-cheia"]').click();
      await pagina.waitForFunction(() => !!document.fullscreenElement);
    }
    await voltar(pagina);
    assert.equal(await pagina.evaluate(() => document.fullscreenElement), null);
    assert.equal(await pagina.locator("#sidebar").isVisible(), true);
    assert.equal(await pagina.evaluate(() => document.activeElement?.dataset?.modo), "tv", "o foco volta para a opção usada");
    assert.deepEqual(erros, []);
    await pagina.close();
    if (!dentro.cheia) assert.fail("o Chromium de teste não entrou em tela cheia no clique — conferir o ambiente");
  });

  test("navegador recusa a tela cheia: a visualização segue imersiva, com o motivo e a opção de tentar de novo", async () => {
    zerarApi();
    const { pagina, erros } = await abrirCentral(browser, { recusarTelaCheia: true });
    await iniciarModo(pagina, "tablet");
    await pagina.waitForFunction(() => !document.querySelector("[data-aviso-tela]").hidden);
    assert.equal(await pagina.evaluate(() => document.fullscreenElement), null);
    assert.equal(await pagina.locator(".cko--tablet.cko--imersivo").isVisible(), true);
    assert.match(await pagina.locator("[data-aviso-tela]").textContent(), /não permitiu a tela cheia/);
    assert.equal(await pagina.locator("[data-rotulo-tela]").textContent(), "Tela cheia");
    assert.equal(await pagina.locator("[data-card]").count(), 3, "os dados aparecem mesmo sem tela cheia");
    assert.deepEqual(erros, []);
    await pagina.close();
  });

  test("falha da consulta: o modo mostra o estado de conexão nos dois formatos", async () => {
    zerarApi();
    api.falhar = true;
    const { pagina } = await abrirCentral(browser);
    await iniciarModo(pagina, "tv");
    await assentar(pagina);
    const tv = await informacoes(pagina);
    await voltar(pagina);
    await iniciarModo(pagina, "tablet");
    await assentar(pagina);
    const tablet = await informacoes(pagina);
    assert.deepEqual(tablet, tv);
    assert.match(tv.aviso.join(" "), /Sem conexão/);
    await pagina.close();
  });

  test("demonstração: identificada nos dois modos, sem consultar a API", async () => {
    zerarApi();
    const { pagina } = await abrirCentral(browser, { url: "/?checklist=demonstracao" });
    assert.match(await pagina.locator(".ckm-contexto").textContent(), /Modo demonstração/);
    for (const modo of ["tv", "tablet"]) {
      await pagina.locator(`[data-acao="iniciar-modo"][data-modo="${modo}"]`).click();
      await pagina.locator(`.cko--${modo}.cko--demo`).waitFor();
      assert.match(await pagina.locator(".cko-faixa-demo").first().textContent(), /Modo demonstração\./);
      await voltar(pagina);
    }
    assert.equal(api.consultas, 0);
    await pagina.close();
  });
});

// ---------------------------------------------------------------------------
// Paginação da TV (dados já recebidos, ciclo de 10 s) e teclado
// ---------------------------------------------------------------------------

/** Estado da paginação de um painel: página escrita, ids visíveis e se o paginador aparece. */
const estadoPaginas = (pagina, painel) => pagina.evaluate((chave) => {
  const p = document.querySelector(`[data-painel="${chave}"]`);
  const nav = p?.querySelector("[data-paginacao]");
  const itens = [...(p?.querySelector("[data-cabe]")?.children ?? [])];
  const id = (i) => i.dataset.pedido ?? i.querySelector("th")?.textContent.trim() ?? i.textContent.trim().slice(0, 30);
  return {
    rotulo: nav && !nav.hidden ? nav.querySelector("[data-pagina-rot]").textContent : null,
    visiveis: itens.filter((i) => !i.hidden).map(id),
    todos: itens.map(id),
    contagem: p?.querySelector(".cko-contagem")?.textContent ?? null,
  };
}, painel);

/** Avança o relógio da página (o tique de 1 s vira as páginas) e deixa o navegador aplicar. */
async function avancar(pagina, ms) {
  await pagina.clock.runFor(ms);
  await assentar(pagina);
}

/** Percorre as páginas da TV até voltar à primeira e devolve os ids na ordem em que apareceram. */
async function percorrer(pagina, painel) {
  const inicio = await estadoPaginas(pagina, painel);
  const total = Number(/de (\d+)/.exec(inicio.rotulo ?? "de 1")[1]);
  const vistos = [...inicio.visiveis];
  for (let i = 1; i < total; i++) {
    await avancar(pagina, 10_000);
    vistos.push(...(await estadoPaginas(pagina, painel)).visiveis);
  }
  await avancar(pagina, 10_000);
  return { total, vistos, inicio, volta: await estadoPaginas(pagina, painel) };
}

describe("Checklist Operacional — paginação da TV e teclado", { skip: PULAR, timeout: 300_000 }, () => {
  let browser;
  before(async () => { browser = await chromium.launch({ headless: true, ...(CANAL ? { channel: CANAL } : {}) }); });
  after(async () => { await browser?.close(); });

  test("TV pagina sozinha a cada 10 s, percorre TODOS os pedidos e volta à primeira — sem consultar o backend", async () => {
    zerarApi();
    const { pagina, erros } = await abrirCentral(browser, { viewport: { width: 1366, height: 768 } });
    await iniciarModo(pagina, "tv");
    await assentar(pagina);
    const consultas = api.consultas;
    const { total, vistos, inicio, volta } = await percorrer(pagina, "ativos");
    assert.ok(total >= 2, `mais de uma página a 1366×768 (${inicio.rotulo})`);
    assert.match(inicio.rotulo, /^Página 1 de \d+ · 7 pedidos em andamento$/);
    assert.deepEqual(vistos, inicio.todos, "cada pedido aparece uma vez, na ordem de urgência");
    assert.deepEqual(volta.visiveis, inicio.visiveis, "depois da última, a primeira");
    assert.equal(volta.contagem, "7", "o total do painel não muda com a página");
    // Os 3 ciclos de 10 s (até 30 s) cabem antes do polling de 30 s: a paginação não fez nenhuma consulta.
    assert.ok(api.consultas - consultas <= Math.floor((total * 10_000) / 30_000), "só o polling de segurança consultou");
    assert.deepEqual(erros, []);
    await pagina.close();
  });

  test("lista muito grande (60 pedidos): a TV percorre todos; o Tablet mostra todos com rolagem", async () => {
    zerarApi();
    api.dados = () => respostaResumo(AGORA, { pedidos: pedidosEmMassa(AGORA, 60) });
    const { pagina, erros } = await abrirCentral(browser, { viewport: { width: 1920, height: 1080 } });
    await iniciarModo(pagina, "tv");
    await assentar(pagina);
    const { total, vistos, inicio } = await percorrer(pagina, "ativos");
    assert.equal(inicio.todos.length, 60);
    assert.deepEqual(vistos, inicio.todos);
    assert.match(inicio.rotulo, new RegExp(`^Página 1 de ${total} · 60 pedidos em andamento$`));
    await voltar(pagina);
    await iniciarModo(pagina, "tablet");
    await assentar(pagina);
    const tablet = await estadoPaginas(pagina, "ativos");
    assert.equal(tablet.rotulo, null, "Tablet sem paginador");
    assert.deepEqual(tablet.visiveis, inicio.todos, "Tablet: lista completa, mesma ordem");
    assert.equal(await pagina.evaluate(() => { const r = document.querySelector("[data-cko]"); return r.scrollHeight > r.clientHeight; }), true);
    assert.deepEqual(erros, []);
    await pagina.close();
  });

  test("dado novo no meio do ciclo: mantém a página e o ritmo; lista que diminuiu vai para página válida", async () => {
    zerarApi();
    api.dados = () => respostaResumo(AGORA, { pedidos: pedidosEmMassa(AGORA, 30) });
    const { pagina } = await abrirCentral(browser, { viewport: { width: 1920, height: 1080 } });
    await iniciarModo(pagina, "tv");
    await assentar(pagina);
    await avancar(pagina, 10_000);
    const p2 = await estadoPaginas(pagina, "ativos");
    assert.match(p2.rotulo, /^Página 2 de/);
    // Chega dado novo (aviso do Realtime) 4 s depois da virada: mais pedidos, mesma página, e a próxima
    // virada continua no mesmo ritmo (6 s depois), não 10 s a partir do dado novo.
    api.dados = () => respostaResumo(AGORA, { pedidos: pedidosEmMassa(AGORA, 45) });
    await avancar(pagina, 4_000);
    await pagina.evaluate(({ org, u }) => window.__bus.receberEvento({ tipo: "ifood_pedido.estado_atualizado", organizacaoId: org, unidadeId: u }), { org: ORG, u: UNIDADE.id });
    await avancar(pagina, 2_000);
    const depois = await estadoPaginas(pagina, "ativos");
    assert.equal(depois.todos.length, 45, "dado novo aplicado");
    assert.match(depois.rotulo, /^Página 2 de \d+ · 45 pedidos em andamento$/);
    await avancar(pagina, 4_000);
    assert.match((await estadoPaginas(pagina, "ativos")).rotulo, /^Página 3 de/, "o ciclo não recomeçou com o dado novo");
    // Agora a lista encolhe para caber numa página: página válida (a primeira) e paginador escondido.
    api.dados = () => respostaResumo(AGORA, { pedidos: pedidosEmMassa(AGORA, 2) });
    await pagina.evaluate(({ org, u }) => window.__bus.receberEvento({ tipo: "ifood_pedido.estado_atualizado", organizacaoId: org, unidadeId: u, versao: 9 }), { org: ORG, u: UNIDADE.id });
    await avancar(pagina, 2_000);
    const pequeno = await estadoPaginas(pagina, "ativos");
    assert.equal(pequeno.rotulo, null);
    assert.equal(pequeno.visiveis.length, 2);
    await pagina.close();
  });

  test("timer único: depois de alternar modos, as páginas viram UMA vez a cada 10 s; ao sair, nada vira", async () => {
    zerarApi();
    api.dados = () => respostaResumo(AGORA, { pedidos: pedidosEmMassa(AGORA, 40) });
    const { pagina } = await abrirCentral(browser, { viewport: { width: 1920, height: 1080 } });
    for (const modo of ["tv", "tablet", "tv", "tablet"]) { await iniciarModo(pagina, modo); await voltar(pagina); }
    await iniciarModo(pagina, "tv");
    await assentar(pagina);
    assert.match((await estadoPaginas(pagina, "ativos")).rotulo, /^Página 1 de/, "cada abertura começa na primeira página");
    await avancar(pagina, 10_000);
    assert.match((await estadoPaginas(pagina, "ativos")).rotulo, /^Página 2 de/);
    await avancar(pagina, 9_000);
    assert.match((await estadoPaginas(pagina, "ativos")).rotulo, /^Página 2 de/, "nada vira antes dos 10 s");
    await avancar(pagina, 1_000);
    assert.match((await estadoPaginas(pagina, "ativos")).rotulo, /^Página 3 de/);
    await voltar(pagina);
    const consultas = api.consultas;
    await avancar(pagina, 60_000);
    assert.equal(await pagina.locator("[data-cko]").count(), 0);
    assert.equal(api.consultas, consultas, "sem consulta nem tique depois de sair");
    await pagina.close();
  });

  test("movimento reduzido: as páginas não viram sozinhas; as setas do paginador trocam a página", async () => {
    zerarApi();
    api.dados = () => respostaResumo(AGORA, { pedidos: pedidosEmMassa(AGORA, 30) });
    const { pagina } = await abrirCentral(browser, { viewport: { width: 1920, height: 1080 } });
    await pagina.emulateMedia({ reducedMotion: "reduce" });
    await iniciarModo(pagina, "tv");
    await assentar(pagina);
    await avancar(pagina, 25_000);
    assert.match((await estadoPaginas(pagina, "ativos")).rotulo, /^Página 1 de/);
    await pagina.locator('[data-paginacao="ativos"] [data-acao="pagina-proxima"]').click();
    await assentar(pagina);
    assert.match((await estadoPaginas(pagina, "ativos")).rotulo, /^Página 2 de/);
    await pagina.locator('[data-paginacao="ativos"] [data-acao="pagina-anterior"]').click();
    await pagina.locator('[data-paginacao="ativos"] [data-acao="pagina-anterior"]').click();
    await assentar(pagina);
    const ultima = await estadoPaginas(pagina, "ativos");
    const [, n] = /de (\d+)/.exec(ultima.rotulo);
    assert.match(ultima.rotulo, new RegExp(`^Página ${n} de ${n}`), "da primeira, a anterior é a última");
    await pagina.close();
  });

  test("teclado: Tab e Shift+Tab ficam nos controles do modo; Esc não tira do modo; voltar devolve a Central", async () => {
    zerarApi();
    api.dados = () => respostaResumo(AGORA, { pedidos: pedidosEmMassa(AGORA, 30) });
    const { pagina, erros } = await abrirCentral(browser, { viewport: { width: 1920, height: 1080 } });
    await iniciarModo(pagina, "tv");
    await assentar(pagina);
    const ondeEsta = () => pagina.evaluate(() => {
      const a = document.activeElement;
      const raiz = document.querySelector("[data-cko]");
      return { dentro: !!raiz && raiz.contains(a), acao: a?.dataset?.acao ?? (a === raiz ? "raiz" : a?.tagName), central: !!a?.closest?.("#sidebar, .topbar") };
    });
    assert.deepEqual(await ondeEsta(), { dentro: true, acao: "raiz", central: false }, "ao abrir, o foco vai para o modo");
    assert.equal(await pagina.evaluate(() => [document.querySelector("#sidebar"), document.querySelector(".topbar")].every((n) => n.closest("[inert]"))), true);

    const percurso = async (tecla, n) => {
      const r = [];
      for (let i = 0; i < n; i++) { await pagina.keyboard.press(tecla); r.push(await ondeEsta()); }
      return r;
    };
    const frente = await percurso("Tab", 14);
    const tras = await percurso("Shift+Tab", 14);
    for (const passo of [...frente, ...tras]) assert.equal(passo.central, false, `foco chegou à Central: ${JSON.stringify(passo)}`);
    const acoes = new Set(frente.filter((p) => p.dentro).map((p) => p.acao));
    for (const a of ["tela-cheia", "voltar", "pagina-proxima", "pagina-anterior"]) assert.ok(acoes.has(a), `Tab alcança ${a}`);

    // Redesenho com dado novo mantém o foco no mesmo controle.
    await pagina.locator('[data-acao="voltar"]').focus();
    api.dados = () => respostaResumo(AGORA, { pedidos: pedidosEmMassa(AGORA, 31) });
    await pagina.evaluate(({ org, u }) => window.__bus.receberEvento({ tipo: "ifood_pedido.estado_atualizado", organizacaoId: org, unidadeId: u }), { org: ORG, u: UNIDADE.id });
    await avancar(pagina, 2_000);
    assert.equal((await estadoPaginas(pagina, "ativos")).todos.length, 31);
    assert.equal((await ondeEsta()).acao, "voltar", "o foco continua em Voltar ao Checklist depois do redesenho");

    // Esc: o navegador sai da tela cheia; o modo continua e o foco não vai para a Central.
    const cheia = await pagina.evaluate(() => !!document.fullscreenElement);
    await pagina.keyboard.press("Escape");
    if (cheia) {
      // O Chromium sem janela nem sempre trata o Esc de tela cheia como o navegador real; a saída é a mesma API.
      await pagina.evaluate(() => document.fullscreenElement && document.exitFullscreen());
      await pagina.waitForFunction(() => !document.fullscreenElement);
    }
    await assentar(pagina);
    assert.equal(await pagina.locator(".cko--tv").count(), 1, "Esc não tira do modo");
    assert.equal((await ondeEsta()).central, false);

    // Voltar pelo teclado: Enter no botão.
    await pagina.locator('[data-acao="voltar"]').focus();
    await pagina.keyboard.press("Enter");
    await pagina.locator("[data-ckm]").waitFor();
    assert.equal(await pagina.evaluate(() => document.querySelectorAll("[inert]").length), 0, "nada fica inerte depois de sair");
    assert.equal(await pagina.evaluate(() => document.activeElement?.dataset?.modo), "tv", "o foco volta para a opção usada");
    // A Central volta a ser alcançável pelo Tab.
    const naCentral = [];
    for (let i = 0; i < 8; i++) { await pagina.keyboard.press("Shift+Tab"); naCentral.push((await ondeEsta()).central); }
    assert.ok(naCentral.includes(true), "Shift+Tab alcança o menu da Central de novo");
    assert.deepEqual(erros, []);
    await pagina.close();
  });

  test("camada criada DEPOIS da abertura (painel, overlay) não recebe foco; ao sair volta a ser alcançável", async () => {
    zerarApi();
    const { pagina, erros } = await abrirCentral(browser, { viewport: { width: 1920, height: 1080 } });
    await iniciarModo(pagina, "tv");
    await assentar(pagina);
    // A Central acrescenta camadas com o modo aberto: um painel no body e um overlay dentro do app.
    await pagina.evaluate(() => {
      const painel = document.createElement("aside");
      painel.id = "camada-agente";
      painel.innerHTML = '<button type="button" id="btn-agente">Agente Crescer</button><a href="#ajuda" id="link-agente">Ajuda</a>';
      document.body.appendChild(painel);
      const overlay = document.createElement("div");
      overlay.id = "camada-overlay";
      overlay.innerHTML = '<button type="button" id="btn-overlay">Fechar aviso</button>';
      document.querySelector("#app").appendChild(overlay);
    });
    await assentar(pagina);
    assert.deepEqual(await pagina.evaluate(() => ["#camada-agente", "#camada-overlay"].map((s) => document.querySelector(s).inert)), [true, true]);
    assert.equal(await pagina.evaluate(() => document.querySelector("[data-cko]").closest("[inert]")), null, "o Checklist nunca fica inerte");
    const focos = [];
    await pagina.locator("[data-cko]").focus();
    for (const tecla of [...Array(16).fill("Tab"), ...Array(16).fill("Shift+Tab")]) {
      await pagina.keyboard.press(tecla);
      focos.push(await pagina.evaluate(() => {
        const a = document.activeElement;
        return { id: a?.id || null, noModo: !!a?.closest?.("[data-cko]") || a === document.body };
      }));
    }
    assert.ok(focos.every((f) => !["btn-agente", "link-agente", "btn-overlay"].includes(f.id)), JSON.stringify(focos));
    assert.ok(focos.every((f) => f.noModo), "Tab e Shift+Tab ficam no modo");

    await voltar(pagina);
    assert.deepEqual(await pagina.evaluate(() => ["#camada-agente", "#camada-overlay", "#sidebar", ".topbar"].map((s) => document.querySelector(s).inert)), [false, false, false, false]);
    assert.equal(await pagina.evaluate(() => document.querySelectorAll("[inert]").length), 0);
    // Observador desligado: camada criada com o Checklist fechado não é tocada.
    await pagina.evaluate(() => { const d = document.createElement("div"); d.id = "camada-depois"; d.innerHTML = "<button>Outra tela</button>"; document.body.appendChild(d); });
    await assentar(pagina);
    assert.equal(await pagina.evaluate(() => document.querySelector("#camada-depois").inert), false);
    await pagina.locator("#btn-agente").focus();
    assert.equal(await pagina.evaluate(() => document.activeElement?.id), "btn-agente", "a camada volta a receber foco");
    assert.deepEqual(erros, []);
    await pagina.close();
  });

  test("alternar TV ↔ Tablet não acumula bloqueios; na seleção nada fica inerte", async () => {
    zerarApi();
    const { pagina } = await abrirCentral(browser, { viewport: { width: 1366, height: 768 } });
    const inertes = () => pagina.evaluate(() => [...document.querySelectorAll("[inert]")].map((n) => n.id || n.className || n.tagName).sort());
    let referencia = null;
    for (const modo of ["tv", "tablet", "tv", "tablet", "tv"]) {
      await iniciarModo(pagina, modo);
      await assentar(pagina);
      const agora = await inertes();
      referencia ??= agora;
      assert.deepEqual(agora, referencia, `mesmos bloqueios no ${modo}`);
      assert.ok(agora.includes("sidebar"));
      await voltar(pagina);
      assert.deepEqual(await inertes(), [], "nada inerte na seleção");
    }
    await pagina.close();
  });

  test("troca de unidade com camada dinâmica aberta: tudo é liberado", async () => {
    zerarApi();
    const { pagina } = await abrirCentral(browser, { viewport: { width: 1366, height: 768 } });
    await iniciarModo(pagina, "tablet");
    await assentar(pagina);
    await pagina.evaluate(() => { const d = document.createElement("div"); d.id = "camada-x"; document.body.appendChild(d); });
    await assentar(pagina);
    assert.equal(await pagina.evaluate(() => document.querySelector("#camada-x").inert), true);
    await pagina.evaluate((nova) => {
      window.__state.sessao.unidade = nova;
      window.__contexto.resetarEscopoDeContexto();
      window.__checklist.renderChecklistOperacional();
    }, OUTRA_UNIDADE);
    await assentar(pagina);
    assert.equal(await pagina.evaluate(() => document.querySelectorAll("[inert]").length), 0);
    await pagina.evaluate(() => { const d = document.createElement("div"); d.id = "camada-y"; document.body.appendChild(d); });
    await assentar(pagina);
    assert.equal(await pagina.evaluate(() => document.querySelector("#camada-y").inert), false, "observador desligado na troca de unidade");
    await pagina.close();
  });

  test("troca de unidade com o modo aberto: nada fica inerte e não sobra paginação", async () => {
    zerarApi();
    const { pagina } = await abrirCentral(browser, { viewport: { width: 1366, height: 768 } });
    await iniciarModo(pagina, "tv");
    await assentar(pagina);
    await pagina.evaluate((nova) => {
      window.__state.sessao.unidade = nova;
      window.__contexto.resetarEscopoDeContexto();
      window.__checklist.renderChecklistOperacional();
    }, OUTRA_UNIDADE);
    await assentar(pagina);
    assert.equal(await pagina.evaluate(() => document.querySelectorAll("[inert]").length), 0);
    assert.equal(await pagina.locator("[data-ckm]").count(), 1);
    await pagina.close();
  });
});

// ---------------------------------------------------------------------------
// Verificação visual por resolução (layout real do Chromium)
// ---------------------------------------------------------------------------

const TELAS_TV = [[1920, 1080], [1366, 768], [1280, 720], [3840, 2160]];
const TELAS_TABLET = [[768, 1024], [1024, 768], [820, 1180], [1180, 820]];

/** Mede a tela: o que fica fora da área visível, sobreposição, rolagem, paginador e indicadores presentes. */
const medir = (pagina) => pagina.evaluate(() => {
  const raiz = document.querySelector("[data-cko]");
  const vw = window.innerWidth; const vh = window.innerHeight;
  const fora = [];
  const essenciais = raiz.querySelectorAll("[data-card], .cko-status, .cko-painel-cab, .cko-cab, [data-aviso], .cko-status-contagem, .cko-status-motivos");
  for (const n of essenciais) {
    const r = n.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) fora.push(`${n.className || n.tagName}: horizontal`);
    if (r.bottom > vh + 1 + raiz.scrollHeight - raiz.clientHeight) fora.push(`${n.className}: abaixo do conteúdo rolável`);
  }
  // Blocos que nunca podem se sobrepor (linha de cima × linha de baixo, painel × painel).
  const blocos = [...raiz.querySelectorAll(".cko-cab, [data-card], .cko-status, .cko-painel")].map((n) => [n.className.split(" ").slice(0, 2).join("."), n.getBoundingClientRect()]);
  const sobrepostos = [];
  for (let i = 0; i < blocos.length; i++) for (let j = i + 1; j < blocos.length; j++) {
    const [na, a] = blocos[i]; const [nb, b] = blocos[j];
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) sobrepostos.push(na + " x " + nb);
  }
  // Linhas VISÍVEIS (da página atual) cortadas pelo fundo do painel, e o paginador dentro do painel.
  const cortadas = [];
  const paginadores = [];
  for (const painel of raiz.querySelectorAll("[data-painel]")) {
    const fundo = painel.getBoundingClientRect().bottom;
    for (const item of painel.querySelectorAll("[data-cabe] > :not([hidden])")) if (item.getBoundingClientRect().bottom > fundo + 1) cortadas.push(painel.dataset.painel);
    // Conteúdo mais largo que o painel (o painel corta o que transborda: a raiz não rolaria).
    for (const n of [painel, ...painel.querySelectorAll(".cko-tabela-wrap, .cko-peds, .cko-aval-lista")]) {
      if (n.scrollWidth > n.clientWidth + 1) cortadas.push(painel.dataset.painel + ": largura");
    }
    const nav = painel.querySelector("[data-paginacao]:not([hidden])");
    if (nav) {
      const r = nav.getBoundingClientRect();
      paginadores.push({ painel: painel.dataset.painel, texto: nav.textContent.replace(/\s+/g, " ").trim(), dentro: r.bottom <= fundo + 1 && r.top >= painel.getBoundingClientRect().top, fonte: parseFloat(getComputedStyle(nav.querySelector("[data-pagina-rot]")).fontSize) * (parseFloat(getComputedStyle(raiz).zoom) || 1) });
    }
  }
  for (const card of raiz.querySelectorAll("[data-card], .cko-status")) {
    const r = card.getBoundingClientRect();
    for (const filho of card.querySelectorAll("dd, dt, .cko-num, .cko-agora-pe, .cko-estado")) {
      const f = filho.getBoundingClientRect();
      if (f.right > r.right - 4 + 1 || f.left < r.left - 1) cortadas.push(`${card.dataset.card ?? "status"}: ${filho.textContent.trim().slice(0, 20)}`);
    }
  }
  const motivos = raiz.querySelector(".cko-status-motivos");
  return {
    rolaHorizontal: raiz.scrollWidth > raiz.clientWidth + 1 || document.documentElement.scrollWidth > vw + 1,
    rolaVertical: raiz.scrollHeight > raiz.clientHeight + 1,
    essenciaisVisiveisSemRolar: [...essenciais].every((n) => n.getBoundingClientRect().bottom <= vh + 1),
    fora, sobrepostos, cortadas, paginadores,
    escondidos: raiz.querySelectorAll("[data-cabe] > [hidden]").length,
    alertaCritico: motivos ? motivos.textContent.includes("aberto há mais de 4 h") && motivos.getBoundingClientRect().bottom <= vh + 1 : false,
    contagem: raiz.querySelector(".cko-painel--ativos .cko-contagem")?.textContent,
    emAndamento: [...raiz.querySelectorAll(".cko-status-contagem div")].find((d) => d.textContent.includes("Em andamento"))?.querySelector("dd")?.textContent,
    cards: raiz.querySelectorAll("[data-card]").length,
    pedidos: raiz.querySelectorAll(".cko-painel--ativos [data-pedido]").length,
    numeroCard: parseFloat(getComputedStyle(raiz.querySelector(".cko-num") ?? raiz.querySelector(".cko-status-veredito")).fontSize) * (parseFloat(getComputedStyle(raiz).zoom) || 1),
  };
});

describe("Checklist Operacional — verificação visual por resolução", { skip: PULAR, timeout: 400_000 }, () => {
  let browser;
  before(async () => {
    browser = await chromium.launch({ headless: true, ...(CANAL ? { channel: CANAL } : {}) });
    if (CAPTURAS) mkdirSync(CAPTURAS, { recursive: true });
  });
  after(async () => { await browser?.close(); });

  test("seleção em desktop e tablet: duas opções lado a lado ou empilhadas, sem rolagem horizontal", async () => {
    for (const [w, h] of [[1440, 900], [768, 1024]]) {
      zerarApi();
      const { pagina } = await abrirCentral(browser, { viewport: { width: w, height: h } });
      assert.equal(await pagina.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      if (CAPTURAS) await pagina.screenshot({ path: resolve(CAPTURAS, `selecao-${w}x${h}.png`), fullPage: true });
      await pagina.close();
    }
  });

  const casosTv = [...TELAS_TV.map(([w, h]) => ({ w, h, semZoom: false })), { w: 3840, h: 2160, semZoom: true }];
  for (const { w, h, semZoom } of casosTv) {
    test(`Televisão ${w}×${h}${semZoom ? " sem suporte a zoom" : ""}: nada cortado, alerta crítico visível, paginação legível`, async () => {
      zerarApi();
      const { pagina, erros } = await abrirCentral(browser, { viewport: { width: w, height: h } });
      // Navegador sem `zoom`: o bloco @supports some; aqui isso é reproduzido anulando o zoom do 4K.
      if (semZoom) await pagina.addStyleTag({ content: ".cko--tv { zoom: 1 !important; height: 100vh !important; height: 100dvh !important; }" });
      await iniciarModo(pagina, "tv");
      await assentar(pagina);
      const m = await medir(pagina);
      if (CAPTURAS) await pagina.screenshot({ path: resolve(CAPTURAS, `tv-${w}x${h}${semZoom ? "-sem-zoom" : ""}.png`) });
      assert.deepEqual(m.fora, []);
      assert.deepEqual(m.sobrepostos, []);
      assert.deepEqual(m.cortadas, [], "nenhuma linha da página atual cortada");
      assert.equal(m.rolaHorizontal, false);
      assert.equal(m.rolaVertical, false, "TV sem rolagem");
      assert.equal(m.cards, 3);
      assert.equal(m.pedidos, 7, "todos os pedidos no DOM; a página escolhe quais aparecem");
      assert.equal(m.contagem, "7");
      assert.equal(m.emAndamento, "7");
      assert.equal(m.alertaCritico, true, "alerta do pedido aberto há mais de 4 h visível no status");
      for (const p of m.paginadores) {
        assert.ok(p.dentro, `paginador dentro do painel ${p.painel}`);
        assert.ok(p.fonte >= 13, `paginador legível (${p.fonte}px)`);
        assert.match(p.texto, /Página 1 de \d+ · \d+ /);
      }
      console.log(`  tv ${w}x${h}${semZoom ? " sem zoom" : ""}: paginas=${JSON.stringify(m.paginadores.map((p) => p.texto))} fonteNumero=${m.numeroCard}px`);
      assert.deepEqual(erros, []);
      await pagina.close();
    });
  }

  for (const [w, h] of TELAS_TABLET) {
    test(`Tablet ${w}×${h}: todos os indicadores e pedidos, sem paginação, sem rolagem horizontal`, async () => {
      zerarApi();
      const { pagina, erros } = await abrirCentral(browser, { viewport: { width: w, height: h } });
      await iniciarModo(pagina, "tablet");
      await assentar(pagina);
      const m = await medir(pagina);
      if (CAPTURAS) {
        await pagina.screenshot({ path: resolve(CAPTURAS, `tablet-${w}x${h}.png`) });
        const alto = await pagina.evaluate(() => document.querySelector("[data-cko]").scrollHeight);
        await pagina.setViewportSize({ width: w, height: alto });
        await pagina.screenshot({ path: resolve(CAPTURAS, `tablet-${w}x${h}-inteiro.png`) });
        await pagina.setViewportSize({ width: w, height: h });
      }
      assert.deepEqual(m.fora, []);
      assert.deepEqual(m.sobrepostos, []);
      assert.equal(m.rolaHorizontal, false);
      assert.equal(m.cards, 3);
      assert.equal(m.pedidos, 7);
      assert.equal(m.escondidos, 0, "no tablet nada some por falta de espaço");
      assert.deepEqual(m.paginadores, [], "sem paginação automática no tablet");
      assert.equal(m.contagem, "7");
      console.log(`  tablet ${w}x${h}: rolaVertical=${m.rolaVertical} fonteNumero=${m.numeroCard}px`);
      assert.deepEqual(erros, []);
      await pagina.close();
    });
  }

  test("Tablet: girar (vertical ↔ horizontal) não perde indicador", async () => {
    zerarApi();
    const { pagina } = await abrirCentral(browser, { viewport: { width: 820, height: 1180 } });
    await iniciarModo(pagina, "tablet");
    await assentar(pagina);
    const vertical = await informacoes(pagina);
    await pagina.setViewportSize({ width: 1180, height: 820 });
    await assentar(pagina);
    const horizontal = await informacoes(pagina);
    assert.deepEqual(horizontal, vertical);
    const m = await medir(pagina);
    assert.equal(m.escondidos, 0);
    assert.deepEqual(m.sobrepostos, []);
    await pagina.close();
  });
});
