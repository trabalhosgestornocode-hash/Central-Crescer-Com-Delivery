// Inicialização do Dashboard Financeiro no APP REAL (index.html + app.js + router + menu de verdade), navegador real.
//
// Regressão do bug de produção: ao atualizar a página de uma empresa com o Financeiro 2.0 ligado, aparecia primeiro o
// Financeiro ANTIGO (menu "FINANCEIRO" + "Carregando…") e só depois o 2.0. Aqui um MutationObserver instalado antes
// de qualquer script do app registra TODO estado intermediário do DOM (os callbacks rodam antes de cada pintura), e a
// API falsa responde o status com atraso — o pior caso da corrida. Nunca fala com produção, Supabase nem rede externa.
//
// Rodar:  CHECKLIST_PLAYWRIGHT_PATH=<...>/worker-martinbrower/node_modules/playwright CHECKLIST_BROWSER_CHANNEL=chrome \
//         node --test frontend/test/financeiroInicializacao.browser.test.js   (sem Playwright o teste é PULADO, não falha)
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)(process.env.CHECKLIST_PLAYWRIGHT_PATH || process.env.FIN_PLAYWRIGHT_PATH || "playwright"));
} catch { /* sem Playwright: pulado */ }
const PULAR = !chromium && "Configure CHECKLIST_PLAYWRIGHT_PATH (Playwright) para rodar no navegador";
const CANAL = process.env.CHECKLIST_BROWSER_CHANNEL || process.env.FIN_BROWSER_CHANNEL;
const RAIZ = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MIME = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".html": "text/html; charset=utf-8", ".json": "application/json" };
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CONTA = U(1);
const ORGS = { a: { id: U(10), nome: "Empresa A (2.0)" }, b: { id: U(20), nome: "Empresa B (legado)" } };
const UNIDADES = { a: { id: U(11), nome: "Loja A" }, b: { id: U(21), nome: "Loja B" } };

/** Cenário da API falsa. `status` = como responder GET /gestao-financeira/status por organização. */
const api = { chamadas: [], org: "a", setores: ["financeiro"], status: {}, atrasoMs: 600 };
const zerar = (extra = {}) => Object.assign(api, { chamadas: [], org: "a", setores: ["financeiro"], atrasoMs: 600,
  status: { a: { http: 200, financeiro2: true }, b: { http: 200, financeiro2: false } } }, extra);
const json = (res, status, corpo) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(corpo)); };
let servidor; let base; let browser;

before(async () => {
  if (PULAR) return;
  servidor = createServer(async (req, res) => {
    const caminho = new URL(req.url, "http://x").pathname;
    if (caminho === "/api/config") return json(res, 200, { supabaseUrl: "http://127.0.0.1:9", supabaseAnonKey: "x" });
    if (!caminho.startsWith("/api/v1/")) {
      const arq = resolve(RAIZ, "." + (caminho === "/" ? "/index.html" : caminho));
      if (!arq.startsWith(RAIZ + sep)) { res.writeHead(403).end(); return; }
      try { res.setHeader("Content-Type", MIME[extname(arq)] ?? "application/octet-stream"); res.end(readFileSync(arq)); } catch { res.writeHead(404).end(); }
      return;
    }
    api.chamadas.push(`${req.method} ${caminho}`);
    let corpo = ""; for await (const c of req) corpo += c;
    const org = ORGS[api.org]; const uni = UNIDADES[api.org];
    const ctx = () => ({ contextToken: `ctx-${api.org}`, expiraEm: new Date(Date.now() + 8 * 3600e3).toISOString(), sessionId: `s-${api.org}`,
      perfil: { id: CONTA, nome: "Conta" }, empresa: { id: org.id, nome: org.nome, logoUrl: null, status: "ativa" }, unidade: { id: uni.id, nome: uni.nome },
      papel: "organization_admin", papelRotulo: "Administrador", permissoes: ["dashboard.ver", "configuracoes.ver"], modulos: ["dashboard"], impersonando: false });
    if (caminho === "/api/v1/me") return json(res, 200, { data: { id: CONTA, email: "fin@exemplo.test", nome: "Pessoa Teste", superadmin: false, painelAdministrativo: false, senhaProvisoria: false } });
    if (caminho === "/api/v1/sessao/perfis") return json(res, 200, { data: [{ id: CONTA, nome: "Pessoa Teste", ativo: true, temPin: false }] });
    if (caminho === "/api/v1/sessao/acessos") {
      return json(res, 200, { data: { superadmin: false, painelAdministrativo: false, opcoes: Object.keys(ORGS).filter((k) => k === api.org).map((k) => ({
        organizacaoId: ORGS[k].id, unidadeId: UNIDADES[k].id, empresaNome: ORGS[k].nome, unidadeNome: UNIDADES[k].nome,
        papel: "organization_admin", papelRotulo: "Administrador", acessivel: true, empresaStatus: "ativa" })) } });
    }
    if (caminho === "/api/v1/sessao/selecionar") return json(res, 201, { data: ctx() });
    if (caminho === "/api/v1/sessao/atual") return json(res, 200, { data: ctx() });
    if (caminho === "/api/v1/sessao/unidades") return json(res, 200, { data: { unidades: [{ id: uni.id, nome: uni.nome }] } });
    if (caminho === "/api/v1/sessao/setores") return json(res, 200, { data: { setores: api.setores } });
    if (caminho === "/api/v1/sessao/encerrar") return json(res, 200, { data: { encerrada: true } });
    if (caminho === "/api/v1/gestao-financeira/status") {
      const s = api.status[api.org];
      await new Promise((r) => setTimeout(r, api.atrasoMs));
      if (s.rede) { req.socket.destroy(); return; }                       // queda de conexão (Failed to fetch)
      if (s.http !== 200) return json(res, s.http, { error: "falha", codigo: s.codigo });
      return json(res, 200, { data: { habilitado: true, nivel: "gestor", permissoes: ["gestao_financeira.ver"], financeiro2: s.financeiro2 } });
    }
    return json(res, 200, { data: [] });   // páginas financeiras: corpo vazio (o que importa aqui é QUAL interface monta)
  });
  await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  browser = await chromium.launch({ headless: true, ...(CANAL ? { channel: CANAL } : {}) });
});
after(async () => { await browser?.close(); if (servidor) await new Promise((r) => servidor.close(r)); });

/**
 * Observador instalado ANTES do app: a cada mutação, registra se o DOM está mostrando o Financeiro LEGADO (seção
 * "FINANCEIRO" no menu, ou a "Visão Geral" antiga), o "Carregando…" antigo, ou o 2.0 (seções agrupadas).
 */
function observador() {
  window.__fin = { legado: 0, carregandoAntigo: 0, dois: 0, quadros: [] };
  const olhar = () => {
    const menu = document.querySelector("#menu"); const view = document.querySelector("#view");
    if (!menu || !view) return;
    const secoes = [...menu.querySelectorAll(".menu-secao")].map((n) => n.textContent.trim());
    const visaoAntiga = [...menu.querySelectorAll('li[data-rota="fin-visao-geral"]')].some((li) => !li.hidden && /^\s*Visão Geral\s*$/.test(li.textContent));
    const legado = secoes.includes("FINANCEIRO") || visaoAntiga;
    const dois = secoes.includes("Receitas e Vendas") && secoes.includes("Controle e Relatórios");
    // o placeholder antigo do shell (`<div class="fin-estado" role="status">Carregando…</div>` direto no #view, sem o
    // spinner) — o carregamento INTERNO das páginas 2.0 (com .fin-spin) é conteúdo do próprio 2.0 e não conta.
    const carregandoAntigo = [...view.children].some((n) => n.matches(".fin-estado[role=status]") && !n.querySelector(".fin-spin") && n.textContent.trim() === "Carregando…");
    if (legado) window.__fin.legado += 1;
    if (carregandoAntigo) window.__fin.carregandoAntigo += 1;
    if (dois) window.__fin.dois += 1;
    const q = `${legado ? "L" : ""}${dois ? "2" : ""}${carregandoAntigo ? "C" : ""}${view.querySelector(".fin-carregando") ? "n" : ""}`;
    if (q && window.__fin.quadros.at(-1) !== q) window.__fin.quadros.push(q);
  };
  new MutationObserver(olhar).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class"] });
}

async function abrirApp() {
  const contexto = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await contexto.route((url) => url.origin !== base, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  const pagina = await contexto.newPage();
  const erros = [];
  pagina.on("pageerror", (e) => erros.push(e.message));
  await pagina.addInitScript(({ conta }) => {
    window.__sessaoSupabase = { access_token: "jwt-de-teste", user: { id: conta, email: "fin@exemplo.test" } };
    const canal = { on() { return canal; }, subscribe(cb) { try { cb?.("SUBSCRIBED"); } catch { /* */ } return canal; }, unsubscribe() {}, send() {} };
    window.supabase = { createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session: window.__sessaoSupabase } }),
        signOut: async () => { window.__sessaoSupabase = null; return { error: null }; },
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        getUser: async () => ({ data: { user: window.__sessaoSupabase?.user ?? null } }),
      },
      realtime: { setAuth() {}, connect() {}, disconnect() {} },
      channel: () => canal, removeChannel: async () => {},
    }) };
  }, { conta: CONTA });
  await pagina.addInitScript(observador);
  await pagina.goto(base + "/");
  return { pagina, contexto, erros };
}

const fin = (p) => p.evaluate(() => window.__fin);
const ESTADO = (p) => p.evaluate(async () => { const { state } = await import("/src/state.js"); return { rota: state.rota, estado: state.financeiroEstado, setor: state.sessao.setor }; });
const statusChamadas = () => api.chamadas.filter((c) => c === "GET /api/v1/gestao-financeira/status").length;
const esperarDois = (p) => p.waitForFunction(() => document.querySelector('#menu li.ativo[data-rota="fin-painel"]'), null, { timeout: 15_000 });
const esperarLegado = (p) => p.waitForFunction(() => document.querySelector('#menu li.ativo[data-rota="fin-visao-geral"]'), null, { timeout: 15_000 });

function assertSemLegado(f, msg) {
  assert.equal(f.legado, 0, `${msg}: o Financeiro legado apareceu (quadros: ${f.quadros.join(" → ")})`);
  assert.equal(f.carregandoAntigo, 0, `${msg}: o "Carregando…" antigo apareceu (quadros: ${f.quadros.join(" → ")})`);
}

describe("Inicialização do Financeiro no app real (navegador)", { skip: PULAR, timeout: 300_000 }, () => {
  test("empresa com 2.0, status LENTO: carregamento neutro → 2.0, legado em nenhum instante, status consultado 1 vez", async () => {
    zerar({ atrasoMs: 1200 });
    const { pagina, contexto, erros } = await abrirApp();
    try {
      await pagina.waitForSelector("#view .fin-carregando", { timeout: 15_000 });   // enquanto o status não volta: só o neutro
      assert.equal(await pagina.locator("#menu li[data-rota]").count(), 0, "nenhum menu financeiro durante o loading");
      await esperarDois(pagina);
      const f = await fin(pagina);
      assertSemLegado(f, "entrada");
      assert.ok(f.dois > 0);
      assert.equal(f.quadros[0], "n", `1º quadro tem que ser o neutro (quadros: ${f.quadros.join(" → ")})`);
      const est = await ESTADO(pagina);
      assert.deepEqual([est.estado, est.rota], ["financeiro_2", "fin-painel"]);
      assert.equal(statusChamadas(), 1, "a 1ª página reaproveita o status resolvido — sem consulta duplicada");
      assert.deepEqual(erros, []);
    } finally { await contexto.close(); }
  });

  test("Ctrl+R e Ctrl+Shift+R (recarga e recarga forçada): o legado nunca aparece", async () => {
    zerar();
    const { pagina, contexto } = await abrirApp();
    try {
      await esperarDois(pagina);
      for (const tipo of ["F5", "forcada"]) {
        api.chamadas = [];
        if (tipo === "forcada") { const cdp = await contexto.newCDPSession(pagina); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }); }
        await pagina.reload();
        await esperarDois(pagina);
        assertSemLegado(await fin(pagina), `recarga ${tipo}`);
        assert.equal(statusChamadas(), 1, `recarga ${tipo}: 1 consulta de status`);
      }
    } finally { await contexto.close(); }
  });

  test("navegação dentro do 2.0 segue reconferindo o acesso a cada página (sem voltar ao legado)", async () => {
    zerar({ atrasoMs: 300 });
    const { pagina, contexto } = await abrirApp();
    try {
      await esperarDois(pagina);
      await pagina.click('#menu li[data-rota="fin-dre-referencia"]');
      await pagina.waitForFunction(() => document.querySelector('#menu li.ativo[data-rota="fin-dre-referencia"]'));
      await pagina.waitForFunction(() => !document.querySelector("#view .fin-carregando"));
      assertSemLegado(await fin(pagina), "navegação");
      assert.equal(statusChamadas(), 2, "a 2ª página consulta o servidor de novo");
    } finally { await contexto.close(); }
  });

  test("empresa com o flag DESLIGADO: abre o legado como antes, sem nada do 2.0", async () => {
    zerar({ org: "b" });
    const { pagina, contexto } = await abrirApp();
    try {
      await esperarLegado(pagina);
      const f = await fin(pagina);
      assert.equal(f.dois, 0, "nenhuma seção do 2.0 apareceu");
      assert.deepEqual(await pagina.evaluate(() => [...document.querySelectorAll("#menu .menu-secao")].map((n) => n.textContent.trim())), ["FINANCEIRO"]);
      assert.equal(await pagina.locator('#menu li[data-rota="fin-painel"]').count(), 0);
      assert.equal((await ESTADO(pagina)).estado, "financeiro_legado");
    } finally { await contexto.close(); }
  });

  test("erro 500 e queda de rede no status: tela de erro com nova tentativa — NUNCA o legado", async () => {
    for (const falha of [{ http: 500 }, { rede: true }]) {
      zerar({ atrasoMs: 200 }); api.status.a = falha;
      const { pagina, contexto } = await abrirApp();
      try {
        await pagina.waitForSelector("#fin-tentar-novamente", { timeout: 15_000 });
        const f = await fin(pagina);
        assertSemLegado(f, `falha ${JSON.stringify(falha)}`);
        assert.equal(f.dois, 0);
        assert.equal(await pagina.locator("#menu li[data-rota]").count(), 0, "sem menu financeiro no erro");
        assert.equal((await ESTADO(pagina)).estado, "error");
        // a rede volta: "Tentar novamente" abre direto o 2.0
        api.status.a = { http: 200, financeiro2: true };
        await pagina.click("#fin-tentar-novamente");
        await esperarDois(pagina);
        assertSemLegado(await fin(pagina), "depois da nova tentativa");
      } finally { await contexto.close(); }
    }
  });

  test("usuário sem acesso (403 no status): nenhum conteúdo financeiro é montado e o setor é abandonado", async () => {
    zerar({ setores: ["financeiro", "operacional"], atrasoMs: 200 });
    api.status.a = { http: 403, codigo: "FINANCEIRO_SEM_ACESSO" };
    const { pagina, contexto } = await abrirApp();
    try {
      // com dois setores e sem preferência, a Central pergunta; escolhe Financeiro
      await pagina.waitForSelector('#setor-cards .setor-card[data-setor="financeiro"]:not([hidden])', { timeout: 15_000 });
      api.setores = ["operacional"];       // o servidor também recalcula os setores depois da recusa
      await pagina.click('#setor-cards .setor-card[data-setor="financeiro"]');
      await pagina.waitForFunction(async () => { const { state } = await import("/src/state.js"); return state.sessao.setor === "operacional"; }, null, { timeout: 15_000 });
      const f = await fin(pagina);
      assertSemLegado(f, "sem acesso");
      assert.equal(f.dois, 0, "nada do 2.0 foi montado");
    } finally { await contexto.close(); }
  });

  test("do Dashboard Operacional para o Financeiro (alternador do topo): neutro → 2.0, sem legado", async () => {
    zerar({ setores: ["financeiro", "operacional"], atrasoMs: 800 });
    const { pagina, contexto } = await abrirApp();
    try {
      await pagina.waitForSelector('#setor-cards .setor-card[data-setor="operacional"]:not([hidden])', { timeout: 15_000 });
      await pagina.click('#setor-cards .setor-card[data-setor="operacional"]');
      await pagina.waitForSelector("#btn-setor:not([hidden])", { timeout: 15_000 });
      await pagina.evaluate(() => { window.__fin.legado = 0; window.__fin.carregandoAntigo = 0; window.__fin.quadros = []; });
      await pagina.click("#btn-setor");
      await esperarDois(pagina);
      assertSemLegado(await fin(pagina), "operacional → financeiro");
    } finally { await contexto.close(); }
  });

  test("troca de organização (2.0 → legado e volta): cada uma abre a SUA interface, sem herdar a outra", async () => {
    zerar({ atrasoMs: 300 });
    const { pagina, contexto } = await abrirApp();
    try {
      await esperarDois(pagina);
      // outra organização (flag desligado): nova sessão de contexto, como depois de "Trocar unidade"
      api.org = "b";
      await pagina.evaluate(() => { sessionStorage.clear(); });
      await pagina.reload();
      await esperarLegado(pagina);
      assert.equal(await pagina.locator('#menu li[data-rota="fin-painel"]').count(), 0, "a empresa B não herda o 2.0 da A");
      // volta para a A: 2.0 direto
      api.org = "a";
      await pagina.evaluate(() => { sessionStorage.clear(); window.__fin.legado = 0; window.__fin.carregandoAntigo = 0; window.__fin.quadros = []; });
      await pagina.reload();
      await esperarDois(pagina);
      assertSemLegado(await fin(pagina), "de volta à empresa 2.0");
    } finally { await contexto.close(); }
  });
});
