// Renovação automática no APP REAL, em navegador real, com o RELÓGIO DO NAVEGADOR simulado (Playwright clock):
// um expediente de 17 h passa em segundos. A API é falsa mas tem relógio PRÓPRIO (virtual), como o servidor de verdade
// — o aparelho não decide nada: o servidor é quem diz quando o contexto vence, quando dá para renovar e o limite de 20 h.
//
// Rodar: CHECKLIST_PLAYWRIGHT_PATH=<...>/worker-martinbrower/node_modules/playwright CHECKLIST_BROWSER_CHANNEL=chrome \
//        node --test test/renovacaoExibicao.browser.test.js     (sem Playwright o teste é PULADO)
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { ORG, UNIDADE, respostaResumo } from "./checklistOperacionalFixture.js";

let chromium;
try { ({ chromium } = createRequire(import.meta.url)(process.env.CHECKLIST_PLAYWRIGHT_PATH || process.env.PERFORMANCE_PLAYWRIGHT_PATH || "playwright")); } catch { /* pulado */ }
const PULAR = !chromium && "Configure CHECKLIST_PLAYWRIGHT_PATH (Playwright) para rodar no navegador";
const CANAL = process.env.CHECKLIST_BROWSER_CHANNEL || process.env.PERFORMANCE_BROWSER_CHANNEL;
const RAIZ = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CONTA = "00000000-0000-4000-8000-0000000000a1";
const MIME = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".html": "text/html; charset=utf-8", ".json": "application/json" };
const H = 3_600_000; const MIN = 60_000;
const INICIO = Date.UTC(2026, 9, 10, 6, 0, 0);

const json = (res, status, corpo) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(corpo)); };
let servidor; let base; let browser;
/** Estado do "servidor": relógio virtual, contextos vivos (token -> vencimento) e roteiro de falhas. */
const S = {};
const zerar = () => Object.assign(S, { virt: INICIO, login: INICIO, ctxs: new Map(), n: 0, selecoes: 0, renovacoes: 0, cedo: 0, polls: 0, polls409: 0, falhasRede: 0, renovarModo: "normal", chamadas: [] });
zerar();

const corpoContexto = (token, exp) => ({
  contextToken: token, expiraEm: new Date(exp).toISOString(), servidorEm: new Date(S.virt).toISOString(), sessionId: token,
  perfil: { id: CONTA, nome: "Conta" }, empresa: { id: ORG, nome: "Empresa de teste", logoUrl: null, status: "ativa" }, unidade: { id: UNIDADE.id, nome: UNIDADE.nome },
  papel: "display_operator", papelRotulo: "Operador de Exibição", permissoes: ["checklist.visualizar"], modulos: ["ifood"], impersonando: false,
  limiteAbsolutoEm: new Date(S.login + 20 * H).toISOString(),
});
function novoContexto(ms = 8 * H) {
  const exp = Math.min(S.virt + ms, S.login + 20 * H);
  const token = `ctx-${++S.n}`; S.ctxs.set(token, { exp, grace: null });
  return corpoContexto(token, exp);
}
const valido = (token) => { const c = S.ctxs.get(token); return !!c && S.virt < (c.grace ?? c.exp); };

before(async () => {
  if (PULAR) return;
  servidor = createServer((req, res) => {
    const caminho = new URL(req.url, "http://x").pathname;
    if (caminho === "/api/config") return json(res, 200, { supabaseUrl: "http://127.0.0.1:9", supabaseAnonKey: "x" });
    if (caminho.startsWith("/api/v1/")) {
      S.chamadas.push(`${req.method} ${caminho}`);
      const tok = req.headers["x-context-token"];
      if (caminho === "/api/v1/me") return json(res, 200, { data: { id: CONTA, email: "tv@exemplo.test", nome: "TV Loja", superadmin: false, painelAdministrativo: false, senhaProvisoria: false } });
      if (caminho === "/api/v1/sessao/perfis") return json(res, 200, { data: [{ id: CONTA, nome: "TV Loja", ativo: true, temPin: false }] });
      if (caminho === "/api/v1/sessao/acessos") {
        return json(res, 200, { data: { superadmin: false, painelAdministrativo: false, opcoes: [{ organizacaoId: ORG, unidadeId: UNIDADE.id, empresaNome: "Empresa de teste", unidadeNome: UNIDADE.nome, papel: "display_operator", papelRotulo: "Operador de Exibição", acessivel: true, empresaStatus: "ativa" }] } });
      }
      if (caminho === "/api/v1/sessao/selecionar") { S.selecoes += 1; return json(res, 201, { data: novoContexto() }); }
      if (caminho === "/api/v1/realtime/credencial") return json(res, 200, { data: { topicos: [`unidade:${UNIDADE.id}`], expiraEm: new Date(S.virt + 300e3).toISOString(), validadeS: 300 } });
      if (caminho === "/api/v1/sessao/encerrar") return json(res, 200, { data: { encerrada: true } });
      if (!valido(tok)) {
        if (caminho.endsWith("/resumo")) S.polls409 += 1;
        return json(res, 409, { error: "Contexto expirado. Selecione a unidade novamente.", details: { contexto: "invalido" } });
      }
      if (caminho === "/api/v1/sessao/atual") return json(res, 200, { data: corpoContexto(tok, S.ctxs.get(tok).exp) });
      if (caminho === "/api/v1/sessao/unidades") return json(res, 200, { data: { unidades: [{ id: UNIDADE.id, nome: UNIDADE.nome }] } });
      if (caminho === "/api/v1/checklist-operacional/resumo") { S.polls += 1; return json(res, 200, { data: respostaResumo(Date.now()) }); }
      if (caminho === "/api/v1/sessao/renovar") {
        if (S.renovarModo === "rede" && S.falhasRede < 2) { S.falhasRede += 1; req.socket.destroy(); return; }
        if (S.renovarModo === "limite") return json(res, 401, { error: "Autentique-se novamente.", details: { codigo: "REAUTENTICACAO_NECESSARIA" } });
        const c = S.ctxs.get(tok);
        if (c.exp - S.virt > 2 * H) { S.cedo += 1; return json(res, 200, { data: { renovado: false, expiraEm: new Date(c.exp).toISOString(), servidorEm: new Date(S.virt).toISOString() } }); }
        S.renovacoes += 1; c.grace = Math.min(c.exp, S.virt + 90_000);
        return json(res, 201, { data: { ...novoContexto(), renovado: true } });
      }
      return json(res, 403, { error: "Permissão insuficiente para esta ação." });
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

async function abrirApp() {
  const contexto = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await contexto.route((url) => url.origin !== base, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  const pagina = await contexto.newPage();
  const erros = [];
  pagina.on("pageerror", (e) => erros.push(e.message));
  pagina.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR/.test(m.text())) erros.push(m.text()); });
  await pagina.clock.install({ time: INICIO });
  await pagina.addInitScript(({ conta }) => {
    window.__sinais = { signOut: 0 };
    window.__sessaoSupabase = { access_token: "jwt-de-teste", user: { id: conta, email: "tv@exemplo.test" } };
    const canal = { on() { return canal; }, subscribe(cb) { try { cb?.("SUBSCRIBED"); } catch { /* */ } return canal; }, unsubscribe() {}, send() {} };
    window.supabase = { createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session: window.__sessaoSupabase } }),
        signOut: async () => { window.__sinais.signOut += 1; window.__sessaoSupabase = null; return { error: null }; },
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        getUser: async () => ({ data: { user: window.__sessaoSupabase?.user ?? null } }),
      },
      realtime: { setAuth() {}, connect() {}, disconnect() {} }, channel: () => canal, removeChannel: async () => {},
    }) };
  }, { conta: CONTA });
  await pagina.goto(base + "/");
  return { pagina, contexto, erros };
}
/** Avança o relógio do navegador E o do servidor juntos, em passos, dando tempo real para as chamadas de rede assentarem. */
async function passar(pagina, ms, passo = 5 * MIN) {
  for (let feito = 0; feito < ms; feito += passo) {
    const d = Math.min(passo, ms - feito);
    S.virt += d; await pagina.clock.fastForward(d); await pagina.waitForTimeout(40);
  }
}
const entrarNaTv = async (pagina) => {
  await pagina.waitForFunction(() => !document.querySelector("#app").hidden && document.querySelector("[data-ckm]"));
  await pagina.locator('[data-acao="iniciar-modo"][data-modo="tv"]').click();
  await pagina.locator(".cko--tv").waitFor();
};
const renovacoesPedidas = () => S.chamadas.filter((c) => c.endsWith("/sessao/renovar")).length;

describe("RENOVAÇÃO AUTOMÁTICA no app real (relógio simulado)", { skip: PULAR, timeout: 900_000 }, () => {
  test("17 h SEM interação: Modo TV aberto o tempo todo, polling contínuo, 2 renovações, nenhum 409, mesma identidade", async () => {
    zerar();
    const { pagina, contexto, erros } = await abrirApp();
    try {
      await entrarNaTv(pagina);
      await pagina.evaluate(() => { document.querySelector("[data-cko]").dataset.marca = "mesmo-no"; });
      const fs0 = await pagina.evaluate(() => !!document.fullscreenElement);
      const selecoes0 = S.selecoes; let pollsAnt = S.polls;
      for (let h = 0; h < 17; h++) {
        await passar(pagina, H);
        assert.ok(S.polls > pollsAnt, `o polling continuou na hora ${h + 1}`); pollsAnt = S.polls;
        assert.ok(await pagina.locator(".cko--tv").count(), `Modo TV segue aberto na hora ${h + 1}`);
      }
      assert.equal(S.renovacoes, 2, "exatamente 2 renovações em 17 h");
      assert.equal(S.polls409, 0, "nenhuma consulta recusada: o contexto nunca venceu");
      assert.equal(S.selecoes, selecoes0, "nenhuma reentrada: o fluxo de 'contexto vencido' nunca foi necessário");
      assert.equal(await pagina.evaluate(() => document.querySelector("[data-cko]")?.dataset.marca), "mesmo-no", "o painel NÃO foi recriado: a TV não piscou nem saiu do modo");
      assert.equal(await pagina.evaluate(() => !!document.fullscreenElement), fs0, "tela cheia como estava");
      const est = await pagina.evaluate(async () => { const { state } = await import("/src/state.js"); return [state.sessao.papel, state.sessao.permissoes, state.sessao.unidade.id, state.sessao.empresa.id]; });
      assert.deepEqual(est, ["display_operator", ["checklist.visualizar"], UNIDADE.id, ORG]);
      assert.equal(renovacoesPedidas(), 2, "e só pediu quando precisava");
      assert.deepEqual(erros, []);
    } finally { await contexto.close(); }
  });

  test("falha de REDE temporária na renovação: tenta de novo e renova, sem sair do Modo TV", async () => {
    zerar(); S.renovarModo = "rede";
    const { pagina, contexto } = await abrirApp();
    try {
      await entrarNaTv(pagina);
      await passar(pagina, 7 * H + 30 * MIN, 30_000);
      assert.equal(S.falhasRede, 2, "duas quedas de conexão no pedido");
      assert.ok(S.renovacoes >= 1, "mesmo assim renovou");
      assert.ok(await pagina.locator(".cko--tv").count());
      await passar(pagina, 2 * H);
      assert.equal(S.polls409, 0);
    } finally { await contexto.close(); }
  });

  test("LIMITE ABSOLUTO / reautenticação exigida (401 na renovação): para de tentar, segue o fluxo de login, sem laço", async () => {
    zerar(); S.renovarModo = "limite";
    const { pagina, contexto } = await abrirApp();
    try {
      await entrarNaTv(pagina);
      await passar(pagina, 7 * H + 30 * MIN, 10 * MIN);
      await pagina.waitForFunction(() => !document.querySelector("#login-screen").hidden, null, { timeout: 15_000 });
      const pedidos = renovacoesPedidas();
      await passar(pagina, 3 * H);
      assert.equal(renovacoesPedidas(), pedidos, "não insiste depois do 401");
      assert.equal(await pagina.locator("[data-cko]").count(), 0, "nenhum dado do Checklist na tela");
    } finally { await contexto.close(); }
  });

  test("duas ABAS: a que perde a corrida recebe 409 e REENTRA sozinha; cada aba termina numa tela válida do Checklist", async () => {
    zerar();
    const a = await abrirApp(); const b = await abrirApp();
    try {
      await entrarNaTv(a.pagina); await entrarNaTv(b.pagina);
      for (let feito = 0; feito < 8 * H; feito += 5 * MIN) {
        S.virt += 5 * MIN;
        await Promise.all([a.pagina.clock.fastForward(5 * MIN), b.pagina.clock.fastForward(5 * MIN)]);
        await a.pagina.waitForTimeout(40);
      }
      assert.ok(S.renovacoes >= 1);
      for (const p of [a.pagina, b.pagina]) assert.ok(await p.locator(".cko--tv, [data-ckm]").count(), "tela válida do Checklist");
      const vivos = [...S.ctxs.values()].filter((c) => S.virt < (c.grace ?? c.exp)).length;
      assert.ok(vivos <= 4, `poucos contextos vivos: ${vivos}`);
    } finally { await a.contexto.close(); await b.contexto.close(); }
  });
});
