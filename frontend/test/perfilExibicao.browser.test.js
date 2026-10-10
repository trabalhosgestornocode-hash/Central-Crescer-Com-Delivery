// Perfil de EXIBIÇÃO no APP REAL (index.html + app.js + router + menu de verdade), em navegador real.
//
// Diferente de checklistOperacionalModos.browser.test.js (que monta uma página mínima só com o painel), aqui o que
// roda é a Central inteira, com um "Supabase" de mentira no navegador e uma API falsa que REGISTRA cada chamada.
// Prova: o menu só tem o Checklist, a entrada cai nele (login, reinício do navegador e reentrada depois do vencimento
// do contexto), nada além do necessário é chamado na API, e sair/expirar não deixa dado na tela.
//
// Rodar:  CHECKLIST_PLAYWRIGHT_PATH=<...>/worker-martinbrower/node_modules/playwright CHECKLIST_BROWSER_CHANNEL=chrome \
//         node --test test/perfilExibicao.browser.test.js        (sem Playwright o teste é PULADO, não falha)
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { ORG, UNIDADE, respostaResumo } from "./checklistOperacionalFixture.js";

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)(process.env.CHECKLIST_PLAYWRIGHT_PATH || process.env.PERFORMANCE_PLAYWRIGHT_PATH || "playwright"));
} catch { /* sem Playwright: pulado */ }
const PULAR = !chromium && "Configure CHECKLIST_PLAYWRIGHT_PATH (Playwright) para rodar no navegador";
const CANAL = process.env.CHECKLIST_BROWSER_CHANNEL || process.env.PERFORMANCE_BROWSER_CHANNEL;
const RAIZ = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CONTA = "00000000-0000-4000-8000-0000000000a1";
const MIME = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".html": "text/html; charset=utf-8", ".json": "application/json" };

// Só isto pode ser chamado pela sessão de exibição (espelha ROTAS_PERFIL_EXIBICAO do backend + o que a Central faz em qualquer login).
const PERMITIDO = [/^GET \/api\/v1\/me$/, /^GET \/api\/v1\/sessao\/(perfis|acessos|unidades|atual)$/, /^POST \/api\/v1\/sessao\/(selecionar|encerrar|renovar)$/,
  /^GET \/api\/v1\/checklist-operacional\/resumo$/, /^POST \/api\/v1\/realtime\/credencial$/];

const PERFIS = {
  display_operator: { papelRotulo: "Operador de Exibição", permissoes: ["checklist.visualizar"], modulos: ["ifood"] },
  unit_manager: { papelRotulo: "Gestor de Unidade", permissoes: ["dashboard.ver", "produtos.ver", "vendas.ver", "cmv.ver", "integracoes.ver", "checklist.visualizar", "configuracoes.ver"],
    modulos: ["dashboard", "products_cmv", "ingredients", "sales", "ifood", "ifood_dashboard", "monthly_bonus", "parser_food_delivery", "inteligencia", "agente_ia"] },
};

const api = { chamadas: [], papel: "display_operator", resumo: null, selecoes: 0, encerrar: 0 };
let servidor; let base; let browser;

const zerar = (papel = "display_operator") => Object.assign(api, { chamadas: [], papel, resumo: null, selecoes: 0, encerrar: 0 });
const json = (res, status, corpo) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(corpo)); };

before(async () => {
  if (PULAR) return;
  servidor = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const caminho = u.pathname;
    if (caminho === "/api/config") return json(res, 200, { supabaseUrl: "http://127.0.0.1:9", supabaseAnonKey: "x" });
    if (caminho.startsWith("/api/v1/")) {
      api.chamadas.push(`${req.method} ${caminho}`);
      const perfil = PERFIS[api.papel];
      const exibicao = api.papel === "display_operator";
      const ctxOk = () => ({ contextToken: `ctx-${api.selecoes}`, expiraEm: new Date(Date.now() + 8 * 3600e3).toISOString(), sessionId: `sess-${api.selecoes}`,
        perfil: { id: CONTA, nome: "Conta" }, empresa: { id: ORG, nome: "Empresa de teste", logoUrl: null, status: "ativa" }, unidade: { id: UNIDADE.id, nome: UNIDADE.nome },
        papel: api.papel, papelRotulo: perfil.papelRotulo, permissoes: perfil.permissoes, modulos: perfil.modulos, impersonando: false });
      if (caminho === "/api/v1/me") return json(res, 200, { data: { id: CONTA, email: "tv@exemplo.test", nome: "TV Loja", superadmin: false, painelAdministrativo: false, senhaProvisoria: false } });
      if (caminho === "/api/v1/sessao/perfis") return json(res, 200, { data: [{ id: CONTA, nome: "TV Loja", ativo: true, temPin: false }] });
      if (caminho === "/api/v1/sessao/acessos") {
        return json(res, 200, { data: { superadmin: false, painelAdministrativo: false, opcoes: [{ organizacaoId: ORG, unidadeId: UNIDADE.id, empresaNome: "Empresa de teste", unidadeNome: UNIDADE.nome,
          papel: api.papel, papelRotulo: perfil.papelRotulo, acessivel: true, empresaStatus: "ativa" }] } });
      }
      if (caminho === "/api/v1/sessao/selecionar") { api.selecoes += 1; api.resumo = null; return json(res, 201, { data: ctxOk() }); }
      if (caminho === "/api/v1/sessao/atual") return json(res, 200, { data: ctxOk() });
      if (caminho === "/api/v1/sessao/unidades") return json(res, 200, { data: { unidades: [{ id: UNIDADE.id, nome: UNIDADE.nome }] } });
      if (caminho === "/api/v1/sessao/encerrar") { api.encerrar += 1; return json(res, 200, { data: { encerrada: true } }); }
      if (caminho === "/api/v1/realtime/credencial") return json(res, 200, { data: { topicos: [`unidade:${UNIDADE.id}`], expiraEm: new Date(Date.now() + 300e3).toISOString(), validadeS: 300 } });
      if (caminho === "/api/v1/checklist-operacional/resumo") {
        if (api.resumo) return json(res, api.resumo.status, api.resumo.corpo);
        return json(res, 200, { data: respostaResumo(Date.now()) });
      }
      // O backend real recusa TUDO o mais para o perfil de exibição; os demais papéis (controle) recebem um corpo vazio.
      if (exibicao) return json(res, 403, { error: "Permissão insuficiente para esta ação." });
      return json(res, 200, { data: [] });
    }
    const arq = resolve(RAIZ, "." + (caminho === "/" ? "/index.html" : caminho));
    if (!arq.startsWith(RAIZ + sep)) { res.writeHead(403).end(); return; }
    try { res.setHeader("Content-Type", MIME[extname(arq)] ?? "application/octet-stream"); res.end(readFileSync(arq)); } catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  browser = await chromium.launch({ headless: true, ...(CANAL ? { channel: CANAL } : {}) });
});
after(async () => { await browser?.close(); if (servidor) await new Promise((r) => servidor.close(r)); });

/** Abre a Central REAL numa aba NOVA (contexto novo = sessionStorage vazio), com um Supabase falso que já está logado. */
async function abrirApp({ logado = true } = {}) {
  const contexto = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  // Nada de rede externa (CDN do Supabase/Chart.js, fontes): o cliente Supabase é a stub abaixo.
  await contexto.route((url) => url.origin !== base, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  const pagina = await contexto.newPage();
  const erros = [];
  pagina.on("pageerror", (e) => erros.push(e.message));
  pagina.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) erros.push(m.text()); });
  await pagina.addInitScript(({ logado, conta }) => {
    window.__sinais = { signOut: 0 };
    window.__sessaoSupabase = logado ? { access_token: "jwt-de-teste", user: { id: conta, email: "tv@exemplo.test" } } : null;
    const canal = { on() { return canal; }, subscribe(cb) { try { cb?.("SUBSCRIBED"); } catch { /* */ } return canal; }, unsubscribe() {}, send() {} };
    window.supabase = { createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session: window.__sessaoSupabase } }),
        signOut: async () => { window.__sinais.signOut += 1; window.__sessaoSupabase = null; return { error: null }; },
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        getUser: async () => ({ data: { user: window.__sessaoSupabase?.user ?? null } }),
      },
      realtime: { setAuth() {}, connect() {}, disconnect() {} },
      channel: () => canal, removeChannel: async () => {},
    }) };
  }, { logado, conta: CONTA });
  await pagina.goto(base + "/");
  return { pagina, contexto, erros };
}

const menuItens = (pagina) => pagina.evaluate(() => [...document.querySelectorAll("#menu li[data-rota]")].map((li) => ({ id: li.dataset.rota, texto: li.textContent.replace(/\s+/g, " ").trim() })));
const esperarChecklist = async (pagina) => {
  await pagina.waitForFunction(() => !document.querySelector("#app").hidden && document.querySelector("[data-ckm]"));
};
const proibidas = () => api.chamadas.filter((c) => !PERMITIDO.some((r) => r.test(c)));
const visivel = (pagina, sel) => pagina.evaluate((s) => { const n = document.querySelector(s); return !!n && !n.hidden && n.getClientRects().length > 0; }, sel);
/** O elemento foi ESCONDIDO pelo código da Central (atributo `hidden` dele)? Vale mesmo para itens dentro de menus fechados. */
const escondido = (pagina, sel) => pagina.evaluate((s) => { const n = document.querySelector(s); return !!n && n.hidden === true; }, sel);
const ESTADO = (pagina) => pagina.evaluate(async () => { const { state } = await import("/src/state.js"); return { rota: state.rota, papel: state.sessao.papel, permissoes: state.sessao.permissoes }; });

describe("PERFIL DE EXIBIÇÃO no app real (navegador)", { skip: PULAR, timeout: 300_000 }, () => {
  test("entrada: o app cai SOZINHO no Checklist, o menu tem só ele e nenhum controle administrativo aparece", async () => {
    zerar();
    const { pagina, contexto, erros } = await abrirApp();
    try {
      await esperarChecklist(pagina);
      assert.deepEqual((await menuItens(pagina)).map((i) => i.id), ["checklist-operacional"]);
      assert.equal(await pagina.locator("#menu li.menu-secao").count(), 1, "só o título da seção do Checklist; nenhum outro");
      const est = await ESTADO(pagina);
      assert.deepEqual([est.rota, est.papel, est.permissoes], ["checklist-operacional", "display_operator", ["checklist.visualizar"]]);
      for (const sel of ["#btn-notif", "#btn-refresh", "#btn-agente", "#um-trocar", "#um2-empresas", "#um-painel"]) {
        assert.equal(await escondido(pagina, sel), true, `${sel} deve estar escondido`);
      }
      assert.match(await pagina.locator("#um-papel").textContent(), /Operador de Exibição/);
      // a escolha do modo (TV/Tablet) está lá
      assert.ok(await pagina.locator('[data-acao="iniciar-modo"][data-modo="tv"]').count());
      assert.ok(await pagina.locator('[data-acao="iniciar-modo"][data-modo="tablet"]').count());
      assert.deepEqual(proibidas(), [], "a sessão de exibição só chamou rotas permitidas");
      assert.deepEqual(erros, []);
    } finally { await contexto.close(); }
  });

  test("nenhuma carga que o backend recusaria é feita: nem tabelas comerciais, nem metas de CMV, nem CMV, nem dashboards", async () => {
    zerar();
    const { pagina, contexto } = await abrirApp();
    try {
      await esperarChecklist(pagina);
      await pagina.waitForTimeout(500);
      for (const trecho of ["/unidade/", "/cmv", "/produtos", "/insumos", "/dashboard", "/vendas", "/usuarios", "/agente", "/inteligencia", "/integracoes", "/bonificacao", "/parser-food"]) {
        assert.ok(!api.chamadas.some((c) => c.includes(trecho)), `chamou ${trecho}: ${api.chamadas.join(" | ")}`);
      }
      assert.equal(api.chamadas.filter((c) => c === "GET /api/v1/checklist-operacional/resumo").length, 0, "o Checklist só consulta DEPOIS de escolher o modo");
    } finally { await contexto.close(); }
  });

  test("navegar na mão para outra rota (irPara) não sai do Checklist e não dispara chamada nenhuma", async () => {
    zerar();
    const { pagina, contexto } = await abrirApp();
    try {
      await esperarChecklist(pagina);
      const antes = api.chamadas.length;
      const rota = await pagina.evaluate(async () => {
        const { irPara } = await import("/src/router.js"); const { state } = await import("/src/state.js");
        const vistas = [];
        for (const alvo of ["dashboard", "vendas", "produtos", "configuracoes", "dashboard-executivo", "parser-food-delivery", "ia", "integracoes", "rota-inexistente"]) { irPara(alvo); vistas.push(state.rota); }
        return vistas;
      });
      assert.deepEqual([...new Set(rota)], ["checklist-operacional"]);
      await pagina.waitForTimeout(300);
      assert.equal(api.chamadas.length, antes, "nenhuma chamada nova");
      assert.ok(await pagina.locator("[data-ckm]").count(), "continua na escolha do modo do Checklist");
    } finally { await contexto.close(); }
  });

  test("Modo Televisão abre, consulta SÓ o resumo e mostra o painel (tela cheia fica por conta do navegador)", async () => {
    zerar();
    const { pagina, contexto, erros } = await abrirApp();
    try {
      await esperarChecklist(pagina);
      await pagina.locator('[data-acao="iniciar-modo"][data-modo="tv"]').click();
      await pagina.locator(".cko--tv").waitFor();
      await pagina.waitForFunction(() => document.querySelector("[data-cko] .cko-selo"));
      assert.ok(api.chamadas.includes("GET /api/v1/checklist-operacional/resumo"));
      assert.deepEqual(proibidas(), []);
      assert.deepEqual(erros, []);
    } finally { await contexto.close(); }
  });

  test("CONTEXTO VENCIDO (409) com o painel aberto: fecha o modo, reentra sozinho e VOLTA AO CHECKLIST (não à página inicial)", async () => {
    zerar();
    const { pagina, contexto } = await abrirApp();
    try {
      await esperarChecklist(pagina);
      await pagina.locator('[data-acao="iniciar-modo"][data-modo="tv"]').click();
      await pagina.locator(".cko--tv").waitFor();
      assert.equal(api.selecoes, 1);
      api.resumo = { status: 409, corpo: { error: "Contexto expirado. Selecione a unidade novamente.", details: { contexto: "invalido" } } };
      await pagina.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); // "a TV voltou a ficar visível": consulta já
      await pagina.waitForFunction(() => !document.querySelector("[data-cko]") && document.querySelector("[data-ckm]"));
      assert.equal(api.selecoes, 2, "reentrou sozinho (um único acesso, sem senha) e com NOVO contexto");
      const est = await ESTADO(pagina);
      assert.equal(est.rota, "checklist-operacional");
      assert.deepEqual((await menuItens(pagina)).map((i) => i.id), ["checklist-operacional"]);
      assert.equal(await visivel(pagina, "#login-screen"), false);
      assert.deepEqual(proibidas(), [], "nem na reentrada a sessão chamou algo fora do Checklist");
      assert.ok(await pagina.locator('[data-acao="iniciar-modo"][data-modo="tv"]').count(), "pronto para escolher o modo (a tela cheia exige um clique)");
    } finally { await contexto.close(); }
  });

  test("REVOGADA no servidor (409 'encerrado'): mesmo caminho — nenhum dado na tela e volta ao Checklist", async () => {
    zerar();
    const { pagina, contexto } = await abrirApp();
    try {
      await esperarChecklist(pagina);
      await pagina.locator('[data-acao="iniciar-modo"][data-modo="tablet"]').click();
      await pagina.locator(".cko--tablet").waitFor();
      api.resumo = { status: 409, corpo: { error: "Contexto encerrado. Selecione a unidade novamente.", details: { contexto: "invalido" } } };
      await pagina.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await pagina.waitForFunction(() => !document.querySelector("[data-cko]") && document.querySelector("[data-ckm]"));
      const texto = await pagina.locator("#view").textContent();
      assert.doesNotMatch(texto, /Pedidos|Em andamento|Recebidos/, "nenhum indicador da sessão revogada ficou na página");
    } finally { await contexto.close(); }
  });

  test("LOGIN SUPABASE EXPIRADO (401): vai para o login, encerra o contexto no servidor e não deixa o painel na página", async () => {
    zerar();
    const { pagina, contexto } = await abrirApp();
    try {
      await esperarChecklist(pagina);
      await pagina.locator('[data-acao="iniciar-modo"][data-modo="tv"]').click();
      await pagina.locator(".cko--tv").waitFor();
      api.resumo = { status: 401, corpo: { error: "Sessão inválida ou expirada." } };
      await pagina.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await pagina.waitForFunction(() => !document.querySelector("#login-screen").hidden);
      assert.equal(await visivel(pagina, "#app"), false);
      assert.equal(await pagina.locator("[data-cko]").count(), 0);
      assert.equal(await pagina.evaluate(() => window.__sinais.signOut), 1);
      assert.ok(api.encerrar >= 1, "o contexto foi revogado no servidor ANTES de derrubar o login");
    } finally { await contexto.close(); }
  });

  test("REINÍCIO DO NAVEGADOR (aba/contexto novo, sem sessionStorage; login Supabase persistido): reentra e cai no Checklist", async () => {
    zerar();
    const { pagina, contexto } = await abrirApp();
    try {
      await esperarChecklist(pagina);
      assert.equal(api.selecoes, 1);
    } finally { await contexto.close(); }
    // "reinício": nova aba sem o contexto da anterior; o login Supabase continua (persistSession).
    const nova = await abrirApp();
    try {
      await esperarChecklist(nova.pagina);
      assert.equal(api.selecoes, 2, "escolheu a unidade de novo, sozinho");
      assert.equal((await ESTADO(nova.pagina)).rota, "checklist-operacional");
      assert.deepEqual(proibidas(), []);
    } finally { await nova.contexto.close(); }
  });

  test("SAIR: encerra o contexto no servidor, apaga o login e mostra o login — sem dado do Checklist", async () => {
    zerar();
    const { pagina, contexto } = await abrirApp();
    try {
      await esperarChecklist(pagina);
      await pagina.locator('[data-acao="iniciar-modo"][data-modo="tv"]').click();
      await pagina.locator(".cko--tv").waitFor();
      await pagina.evaluate(() => document.querySelector("#btn-logout").click());
      await pagina.waitForFunction(() => !document.querySelector("#login-screen").hidden);
      assert.ok(api.encerrar >= 1);
      assert.equal(await pagina.evaluate(() => window.__sinais.signOut), 1);
      assert.equal(await pagina.locator("[data-cko]").count(), 0);
    } finally { await contexto.close(); }
  });

  test("SEM LOGIN no navegador: vai para o login e nenhuma rota de dados é chamada", async () => {
    zerar();
    const { pagina, contexto } = await abrirApp({ logado: false });
    try {
      await pagina.waitForFunction(() => !document.querySelector("#login-screen").hidden);
      assert.equal(await visivel(pagina, "#app"), false);
      assert.deepEqual(api.chamadas, [], "sem login não há chamada à API");
    } finally { await contexto.close(); }
  });

  test("CONTROLE — gestor da empresa: o menu completo continua aparecendo (o perfil de exibição não afetou os demais)", async () => {
    zerar("unit_manager");
    const { pagina, contexto } = await abrirApp();
    try {
      await pagina.waitForFunction(() => !document.querySelector("#app").hidden && document.querySelectorAll("#menu li[data-rota]").length > 5);
      const ids = (await menuItens(pagina)).map((i) => i.id);
      for (const esperado of ["dashboard", "produtos", "vendas", "checklist-operacional", "dashboard-executivo", "configuracoes"]) assert.ok(ids.includes(esperado), esperado);
      assert.ok(ids.length >= 8);
      for (const sel of ["#um2-empresas", "#um-trocar", "#btn-refresh", "#btn-notif"]) {
        assert.equal(await escondido(pagina, sel), false, `${sel} continua disponível para o gestor`);
      }
    } finally { await contexto.close(); }
  });
});
