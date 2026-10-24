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

// Dashboard Operacional servido com os MÓDULOS PUROS do backend (o mesmo cálculo da API), sobre os pedidos da fixture.
let backend = null;
before(async () => {
  if (PULAR) return;
  const b = (m) => import(new URL(`../../backend/src/modules/checklist-operacional/${m}`, import.meta.url));
  backend = { ind: await b("checklistOperacional.indicadores.js"), per: await b("checklistOperacional.periodos.js"), metas: await b("checklistOperacional.metas.js"), an: await b("checklistOperacional.analises.js") };
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
    if (caminho === "/api/v1/checklist-operacional/dashboard") {
      api.consultasDashboard = (api.consultasDashboard ?? 0) + 1;
      const q = new URL(req.url, "http://x").searchParams;
      const periodo = backend.per.resolverPeriodo({ periodo: q.get("periodo") || "hoje", inicio: q.get("inicio"), fim: q.get("fim"), agoraMs: AGORA });
      // A versão salva vale desde ontem (os pedidos de hoje são avaliados por ela); sem versão salva, nenhuma meta vigente.
      const lt = api.metas.versao ? backend.metas.linhaDoTempoDasMetas([{ versao: api.metas.versao, alterado_em: new Date(AGORA - 86_400_000).toISOString(), novo: api.metas.valores }]) : [];
      const d = backend.ind.montarDashboard({ pedidos: pedidosDoDia(AGORA), periodo, linhaDoTempo: lt, etapa: q.get("etapa") || "todas" });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: { versao: 1, servidorEm: new Date(AGORA).toISOString(), ...backend.ind.paraResposta(d), analises: backend.an.gerarAnalises(d) } }));
      return;
    }
    if (caminho === "/api/v1/checklist-operacional/metas" && req.method === "PUT") {
      let corpo = "";
      req.on("data", (c) => { corpo += c; });
      req.on("end", () => {
        const { versao, metas } = JSON.parse(corpo || "{}");
        res.setHeader("Content-Type", "application/json");
        if (api.falharGravacao) { res.writeHead(503); res.end('{"error":"indisponível"}'); return; }
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

const zerar = (dados = COM_INTEGRACAO) => Object.assign(api, { consultas: 0, falhar: false, erro: null, dados, metas: METAS_PADRAO(), gravacoes: 0, falharGravacao: false });

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

// =====================================================================================================================
// Checklist 2.0 — metas sincronizadas e fundo dinâmico, no NAVEGADOR REAL, com várias telas no MESMO servidor.
// =====================================================================================================================
describe("Checklist 2.0 — sincronização de metas e fundo dinâmico (navegador real)", { skip: PULAR, timeout: 300_000 }, () => {
  let browser;
  before(async () => { browser = await chromium.launch({ headless: true, ...(CANAL ? { channel: CANAL } : {}) }); });
  after(async () => { await browser?.close(); });

  /** Só o pedido 4111 (CONFIRMED, chegou há 9 min): nenhum alerta do servidor, o nível vem só da meta. */
  const UM_ATIVO = () => ({ ...respostaResumo(AGORA, { pedidos: pedidosDoDia(AGORA).filter((p) => p.display_id === "4111") }), modo: "integrado" });
  const metaPreparo = async (pagina) => (await textoVisivel(pagina, '[data-card="preparo"]')).join(" ");
  async function salvarPeloDialogo(pagina, preparo) {
    await pagina.locator('[data-acao="metas"]').click();
    const dlg = pagina.locator("dialog[open]").first();
    await dlg.waitFor();
    await dlg.locator('input[name="preparoMeta"]').fill(String(preparo));
    await dlg.locator('button[type="submit"]').click();
    await assentar(pagina);
    return dlg;
  }
  const putDireto = (versao, preparo) => fetch(`${base}/api/v1/checklist-operacional/metas`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ versao, metas: { preparo: { meta: preparo, avisoPct: 80 }, entrega: { meta: 35, avisoPct: 80 }, vida: { meta: 45, avisoPct: 80 } } }),
  });
  const avisoRealtime = (pagina, unidadeId, versao) => pagina.evaluate(async ({ org, uni, v }) => {
    const bus = await import("/src/realtime/realtimeBus.js");
    bus.receberEvento({ tipo: "checklist_metas.atualizadas", organizacaoId: org, unidadeId: uni, versao: v });
  }, { org: ORG, uni: unidadeId, v: versao });

  test("Tablet salva → a TV recebe pelo polling; outro aparelho salva → a TV recebe pelo aviso do Realtime (sem esperar 30 s)", async () => {
    zerar();
    const tv = await abrir(browser);
    const tablet = await abrir(browser, { viewport: { width: 1024, height: 768 } });
    await iniciarModo(tv.pagina, "tv");
    await iniciarModo(tablet.pagina, "tablet");
    assert.match(await metaPreparo(tv.pagina), /Meta\s*12,0 min/);
    await salvarPeloDialogo(tablet.pagina, 20);
    assert.match(await metaPreparo(tablet.pagina), /Meta\s*20,0 min/, "o tablet aplica na hora");
    assert.deepEqual([api.gravacoes, api.metas.versao], [1, 1]);
    assert.match(await metaPreparo(tv.pagina), /Meta\s*12,0 min/, "a TV ainda não consultou");
    await tv.pagina.clock.runFor(31_000);
    await assentar(tv.pagina);
    assert.match(await metaPreparo(tv.pagina), /Meta\s*20,0 min/, "polling de segurança trouxe a versão nova");
    // Terceiro aparelho grava; a TV recebe o aviso do Realtime (o mesmo tipo que o backend publica) e consulta já.
    assert.equal((await putDireto(1, 18)).status, 200);
    await avisoRealtime(tv.pagina, UNIDADE.id, 2);
    await tv.pagina.clock.runFor(2_000);
    await assentar(tv.pagina);
    assert.match(await metaPreparo(tv.pagina), /Meta\s*18,0 min/, "o aviso antecipou a consulta");
    // Aviso de OUTRA unidade é ignorado.
    const antes = api.consultas;
    await avisoRealtime(tv.pagina, "outra-unidade", 9);
    await tv.pagina.clock.runFor(2_000);
    await assentar(tv.pagina);
    assert.equal(api.consultas, antes);
    assert.deepEqual([...tv.erros, ...tablet.erros], []);
    await tv.pagina.close(); await tablet.pagina.close();
  });

  test("edição simultânea na tela: quem salva com versão velha vê o aviso de conflito e os valores ATUAIS no formulário", async () => {
    zerar();
    const { pagina, erros } = await abrir(browser);
    await iniciarModo(pagina, "tablet");
    assert.equal((await putDireto(0, 25)).status, 200, "outro aparelho salvou primeiro (v1)");
    const dlg = await salvarPeloDialogo(pagina, 15); // esta tela ainda tem a versão 0
    assert.match(await dlg.locator("[data-metas-aviso]").textContent(), /alteradas em outro aparelho/);
    assert.equal(await dlg.locator('input[name="preparoMeta"]').inputValue(), "25", "o formulário passa a mostrar o valor do servidor");
    assert.equal(api.metas.valores.preparo.meta, 25, "nada foi sobrescrito");
    await dlg.locator('input[name="preparoMeta"]').fill("15");
    await dlg.locator('button[type="submit"]').click();
    await assentar(pagina);
    assert.deepEqual([api.metas.versao, api.metas.valores.preparo.meta], [2, 15]);
    assert.match(await metaPreparo(pagina), /Meta\s*15,0 min/);
    assert.deepEqual(erros, []);
    await pagina.close();
  });

  test("falha ao gravar (sem conexão): aviso escrito, a meta anterior continua valendo; quando volta, grava", async () => {
    zerar();
    const { pagina, erros } = await abrir(browser);
    await iniciarModo(pagina, "tablet");
    api.falharGravacao = true;
    const dlg = await salvarPeloDialogo(pagina, 30);
    assert.match(await dlg.locator("[data-metas-aviso]").textContent(), /Não foi possível salvar|não podem ser salvas/);
    await dlg.locator('[data-acao="metas-cancelar"]').click();
    assert.match(await metaPreparo(pagina), /Meta\s*12,0 min/, "a última configuração válida continua valendo");
    api.falharGravacao = false;
    await salvarPeloDialogo(pagina, 30);
    assert.match(await metaPreparo(pagina), /Meta\s*30,0 min/);
    assert.equal(api.metas.versao, 1);
    assert.deepEqual(erros.filter((e) => !/503/.test(e)), []);
    await pagina.close();
  });

  test("fundo da área operacional acompanha o status: 30 → verde, 10 → amarelo, 8 → vermelho (cores diferentes, texto e ícone)", async () => {
    zerar(UM_ATIVO);
    const { pagina, erros } = await abrir(browser, { viewport: { width: 1280, height: 720 } });
    await iniciarModo(pagina, "tv");
    const leituras = [];
    for (const [preparo, versao] of [[30, 0], [10, 1], [8, 2]]) {
      assert.equal((await putDireto(versao, preparo)).status, 200);
      await avisoRealtime(pagina, UNIDADE.id, versao + 1);
      await pagina.clock.runFor(2_000);
      await assentar(pagina);
      await new Promise((r) => setTimeout(r, 1_000)); // transição de 900 ms terminar
      leituras.push(await pagina.evaluate(() => {
        const r = document.querySelector("[data-cko]");
        return { fundo: r.dataset.fundo, cor: getComputedStyle(r).backgroundColor, icone: r.querySelector("[data-status-icone]")?.dataset.statusIcone };
      }));
    }
    assert.deepEqual(leituras.map((l) => l.fundo), ["ok", "atencao", "critico"], JSON.stringify(leituras));
    assert.deepEqual(leituras.map((l) => l.icone), ["ok", "atencao", "critico"]);
    assert.equal(new Set(leituras.map((l) => l.cor)).size, 3, "três cores de fundo diferentes");
    assert.ok(await semRolagemHorizontal(pagina));
    assert.ok(await pagina.evaluate(() => { const r = document.querySelector("[data-cko]"); return r.scrollHeight <= r.clientHeight + 1; }), "TV 1280×720 sem rolagem");
    await foto(pagina, "checklist2-fundo-critico");
    assert.deepEqual(erros, []);
    await pagina.close();
  });

  test("movimento reduzido: a troca de fundo é instantânea (sem transição)", async () => {
    zerar(UM_ATIVO);
    const pagina = await browser.newPage({ viewport: { width: 1280, height: 720 }, reducedMotion: "reduce" });
    await pagina.clock.install({ time: AGORA });
    await pagina.clock.pauseAt(AGORA);
    await pagina.goto(base + "/");
    await pagina.evaluate(async ({ org, unidade }) => {
      const { state } = await import("/src/state.js");
      Object.assign(state.sessao, { empresa: { id: org, nome: "E" }, unidade, permissoes: ["checklist.visualizar"], modulos: ["checklist_operacional"] });
      state.rota = "checklist-operacional";
      (await import("/src/checklistOperacional.js")).renderChecklistOperacional();
    }, { org: ORG, unidade: UNIDADE });
    await iniciarModo(pagina, "tv");
    const t = await pagina.evaluate(() => getComputedStyle(document.querySelector("[data-cko]")).transitionDuration);
    // A regra global da Central (styles.css) força .001ms com movimento reduzido: troca instantânea na prática.
    assert.ok(parseFloat(t) <= 0.001, `duração da transição: ${t}`);
    await pagina.close();
  });
});

describe("Checklist 2.0 — Dashboard Operacional recarrega quando as metas mudam (navegador real)", { skip: PULAR, timeout: 300_000 }, () => {
  let browser;
  before(async () => { browser = await chromium.launch({ headless: true, ...(CANAL ? { channel: CANAL } : {}) }); });
  after(async () => { await browser?.close(); });

  test("Dashboard aberto: outro aparelho salva a meta → o aviso do Realtime recarrega os números (no máximo 1 consulta a cada 15 s)", async () => {
    zerar();
    api.consultasDashboard = 0;
    const { pagina, erros } = await abrir(browser);
    await pagina.locator('[data-acao="abrir-dashboard"]').click();
    await pagina.waitForFunction(() => document.querySelector("[data-ckd]") && !document.querySelector(".ckd-carregando"));
    assert.equal(api.consultasDashboard, 1);
    assert.match((await textoVisivel(pagina, "#ckd-t-metas + p + *, .ckd-bloco")).join(" "), /Nenhuma meta salva para a unidade/);
    const r = await fetch(`${base}/api/v1/checklist-operacional/metas`, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ versao: 0, metas: { preparo: { meta: 22, avisoPct: 80 }, entrega: { meta: 35, avisoPct: 80 }, vida: { meta: 45, avisoPct: 80 } } }) });
    assert.equal(r.status, 200);
    await pagina.evaluate(async ({ org, uni }) => {
      const bus = await import("/src/realtime/realtimeBus.js");
      bus.receberEvento({ tipo: "checklist_metas.atualizadas", organizacaoId: org, unidadeId: uni, versao: 1 });
    }, { org: ORG, uni: UNIDADE.id });
    await pagina.clock.runFor(16_000);
    await assentar(pagina);
    await pagina.waitForFunction(() => !document.querySelector(".ckd-carregando"));
    assert.equal(api.consultasDashboard, 2, "recarregou uma vez");
    assert.match((await textoVisivel(pagina, ".ckd-bloco")).join(" "), /22 min/, "metas aplicáveis atualizadas");
    assert.deepEqual(erros, []);
    await pagina.close();
  });
});
