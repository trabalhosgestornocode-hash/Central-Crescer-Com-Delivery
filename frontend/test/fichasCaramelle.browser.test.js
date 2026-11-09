// Fichas técnicas, homologação, condições comerciais, modal do simulador e CMV teórico — no APP REAL, em navegador real.
// Mesma técnica de perfilExibicao.browser.test.js: servidor estático + API falsa que REGISTRA cada chamada + Supabase falso.
//
// Rodar:  CHECKLIST_PLAYWRIGHT_PATH=<...>/worker-martinbrower/node_modules/playwright CHECKLIST_BROWSER_CHANNEL=chrome \
//         node --test frontend/test/fichasCaramelle.browser.test.js     (sem Playwright o teste é PULADO, não falha)
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";

let chromium;
try { ({ chromium } = createRequire(import.meta.url)(process.env.CHECKLIST_PLAYWRIGHT_PATH || "playwright")); } catch { /* sem Playwright: pulado */ }
const PULAR = !chromium && "Configure CHECKLIST_PLAYWRIGHT_PATH (Playwright) para rodar no navegador";
const CANAL = process.env.CHECKLIST_BROWSER_CHANNEL;
const RAIZ = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ORG = "00000000-0000-4000-8000-0000000000e1";
const UND = { id: "00000000-0000-4000-8000-0000000000c1", nome: "Caramelle Centro" };
const CONTA = "00000000-0000-4000-8000-0000000000a1";
const MIME = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".html": "text/html; charset=utf-8", ".json": "application/json" };

const PAPEIS = {
  admin: { papelRotulo: "Administrador", permissoes: ["dashboard.ver", "produtos.ver", "produtos.editar", "insumos.ver", "insumos.editar", "cmv.ver", "configuracoes.ver", "configuracoes.gerenciar", "dashboard_executivo.ver"] },
  consulta: { papelRotulo: "Consulta", permissoes: ["dashboard.ver", "produtos.ver", "insumos.ver", "cmv.ver", "configuracoes.ver", "dashboard_executivo.ver"] },
};
const MODULOS = ["dashboard", "products_cmv", "ingredients", "ifood_dashboard"];

const F = (o) => ({ ativo: true, natureza: "produto_final", categoria: null, origem: null, rendimento: 1, unidade_rendimento: null, custo_unitario: 2, custo_mao_de_obra_unitario: null,
  qtd_componentes: 2, status_ficha: { chave: "completa", ok: true }, ficha_completa: true, homologacao: "pendente", homologacao_motivo: null, homologado_em: null,
  homologado_por_nome: null, pendencias: [], pode_homologar: true, ...o });
const fichasIniciais = () => [
  F({ id: "p1", nome: "Bolo de Cenoura", categoria: "DOCES", rendimento: 8, custo_unitario: 3.25, custo_mao_de_obra_unitario: 0.9 }),
  F({ id: "p2", nome: "Calda de Chocolate", categoria: "DOCES", natureza: "preparacao", unidade_rendimento: "g", rendimento: 500, custo_unitario: 0.02 }),
  F({ id: "p3", nome: "Empadão de Frango", categoria: "SALGADOS", homologacao: "homologada", homologado_por_nome: "Ana Souza", homologado_em: "2026-11-10T14:00:00Z", pode_homologar: false }),
  F({ id: "p4", nome: "Cappuccino", categoria: "BEBIDAS", custo_unitario: null, ficha_completa: false, pode_homologar: false, status_ficha: { chave: "insumo_sem_custo", ok: false },
    pendencias: [{ codigo: "insumo_sem_custo", detalhe: "insumo(s) sem custo: AGUA" }, { codigo: "unidade_inferida", detalhe: "rótulo L com 1000" }] }),
];
const CONDICOES = () => ({ configurado: true, ausentes: ["balcao", "uber", "app", "outro"], canais: [{ canal: "ifood", comissao: 0.23, taxas: null, promocao: 0.05, tributos: null, entrega_responsavel: null, entrega_custo: null, outras_deducoes: [], observacao: null }] });

const api = { chamadas: [], corpos: [], papel: "admin", fichas: fichasIniciais(), condicoes: CONDICOES(), cmv: null };
const zerar = (papel = "admin") => Object.assign(api, { chamadas: [], corpos: [], papel, fichas: fichasIniciais(), condicoes: CONDICOES(), cmv: null });
let servidor; let base; let browser;
const json = (res, status, corpo) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(corpo)); };
const lerCorpo = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { ok(b ? JSON.parse(b) : null); } catch { ok(null); } }); });

before(async () => {
  if (PULAR) return;
  servidor = createServer(async (req, res) => {
    const u = new URL(req.url, "http://x"); const caminho = u.pathname;
    if (caminho === "/api/config") return json(res, 200, { supabaseUrl: "http://127.0.0.1:9", supabaseAnonKey: "x" });
    if (caminho.startsWith("/api/v1/")) {
      const corpo = req.method === "GET" ? null : await lerCorpo(req);
      api.chamadas.push(`${req.method} ${caminho}${u.search}`);
      if (corpo) api.corpos.push({ chamada: `${req.method} ${caminho}`, corpo });
      const papel = PAPEIS[api.papel];
      const ctxOk = () => ({ contextToken: "ctx-1", expiraEm: new Date(Date.now() + 8 * 3600e3).toISOString(), sessionId: "sess-1", perfil: { id: CONTA, nome: "Conta" },
        empresa: { id: ORG, nome: "Caramelle Café", logoUrl: null, status: "ativa" }, unidade: { id: UND.id, nome: UND.nome }, papel: api.papel, papelRotulo: papel.papelRotulo,
        permissoes: papel.permissoes, modulos: MODULOS, impersonando: false });
      if (caminho === "/api/v1/me") return json(res, 200, { data: { id: CONTA, email: "admin@exemplo.test", nome: "Admin", superadmin: false, painelAdministrativo: false, senhaProvisoria: false } });
      if (caminho === "/api/v1/sessao/perfis") return json(res, 200, { data: [{ id: CONTA, nome: "Admin", ativo: true, temPin: false }] });
      if (caminho === "/api/v1/sessao/acessos") return json(res, 200, { data: { superadmin: false, painelAdministrativo: false, opcoes: [{ organizacaoId: ORG, unidadeId: UND.id, empresaNome: "Caramelle Café", unidadeNome: UND.nome, papel: api.papel, papelRotulo: papel.papelRotulo, acessivel: true, empresaStatus: "ativa" }] } });
      if (caminho === "/api/v1/sessao/selecionar") return json(res, 201, { data: ctxOk() });
      if (caminho === "/api/v1/sessao/atual") return json(res, 200, { data: ctxOk() });
      if (caminho === "/api/v1/sessao/unidades") return json(res, 200, { data: { unidades: [{ id: UND.id, nome: UND.nome }] } });
      if (caminho === "/api/v1/realtime/credencial") return json(res, 200, { data: { topicos: [], expiraEm: new Date(Date.now() + 300e3).toISOString(), validadeS: 300 } });

      if (caminho === "/api/v1/produtos/catalogo/fichas") {
        const it = api.fichas; const n = (f) => it.filter(f).length;
        return json(res, 200, { data: { resumo: { total: it.length, produtos_finais: n((i) => i.natureza === "produto_final"), preparacoes: n((i) => i.natureza === "preparacao"), homologadas: n((i) => i.homologacao === "homologada"), pendentes: n((i) => i.homologacao === "pendente"), incompletas: n((i) => !i.ficha_completa), prontas_para_homologar: n((i) => i.pode_homologar) }, itens: it } });
      }
      let m;
      if ((m = caminho.match(/^\/api\/v1\/produtos\/([^/]+)\/homologacao$/)) && req.method === "PATCH") {
        const f = api.fichas.find((x) => x.id === m[1]);
        if (corpo.acao === "homologar") Object.assign(f, { homologacao: "homologada", homologado_por_nome: "Admin", homologado_em: new Date().toISOString(), pode_homologar: false, homologacao_motivo: null });
        else Object.assign(f, { homologacao: "pendente", homologado_por_nome: null, homologado_em: null, pode_homologar: true, homologacao_motivo: "reaberta_manualmente" });
        return json(res, 200, { data: { id: f.id, homologacao: f.homologacao, alterado: true } });
      }
      if (caminho === "/api/v1/produtos/catalogo/homologar-lote" && req.method === "POST") {
        const ok = [];
        for (const id of corpo.ids) { const f = api.fichas.find((x) => x.id === id); if (f?.pode_homologar) { Object.assign(f, { homologacao: "homologada", homologado_por_nome: "Admin", pode_homologar: false }); ok.push(id); } }
        return json(res, 200, { data: { homologadas: ok, ja_estavam: [], recusadas: [] } });
      }
      if ((m = caminho.match(/^\/api\/v1\/produtos\/([^/]+)$/)) && req.method === "PUT") {
        const f = api.fichas.find((x) => x.id === m[1]);
        if (corpo.rendimento) { f.rendimento = corpo.rendimento; if (f.homologacao === "homologada") Object.assign(f, { homologacao: "pendente", homologacao_motivo: "rendimento_alterado", pode_homologar: true, homologado_por_nome: null }); }
        return json(res, 200, { data: { id: f.id } });
      }
      if ((m = caminho.match(/^\/api\/v1\/produtos\/([^/]+)$/)) && req.method === "GET" && api.fichas.some((x) => x.id === m[1])) {
        return json(res, 200, { data: { id: m[1], ficha: [{ tipo: "insumo", nome: "Cenoura", quantidade: 400, unidade: "g", custo_aplicado: 2.4, ativo: true }, { tipo: "submontagem", nome: "Calda de Chocolate", quantidade: 100, unidade: "g", custo_aplicado: 2, ativo: true }] } });
      }
      if (caminho === "/api/v1/cmv/condicoes-comerciais" && req.method === "GET") return json(res, 200, { data: api.condicoes });
      if (caminho === "/api/v1/cmv/condicoes-comerciais" && req.method === "PUT") {
        const outros = api.condicoes.canais.filter((c) => c.canal !== corpo.canal);
        api.condicoes.canais = [...outros, { canal: corpo.canal, comissao: corpo.comissao, taxas: corpo.taxas, promocao: corpo.promocao, tributos: corpo.tributos, entrega_responsavel: corpo.entrega_responsavel, entrega_custo: corpo.entrega_custo, outras_deducoes: corpo.outras_deducoes, observacao: corpo.observacao }];
        api.condicoes.ausentes = api.condicoes.ausentes.filter((c) => c !== corpo.canal);
        return json(res, 200, { data: api.condicoes });
      }
      if (caminho === "/api/v1/cmv/condicoes-comerciais/historico") return json(res, 200, { data: [] });
      if (caminho === "/api/v1/dashboard-executivo/cmv-teorico") return json(res, 200, { data: api.cmv });
      if (caminho === "/api/v1/produtos" ) return json(res, 200, { data: [] });
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

async function abrirApp() {
  const contexto = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await contexto.route((url) => url.origin !== base, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  const pagina = await contexto.newPage();
  const erros = [];
  pagina.on("pageerror", (e) => erros.push(e.message));
  pagina.on("dialog", (d) => d.accept()); // confirm() da tela
  await pagina.addInitScript(({ conta }) => {
    window.__sessaoSupabase = { access_token: "jwt", user: { id: conta, email: "admin@exemplo.test" } };
    const canal = { on() { return canal; }, subscribe(cb) { try { cb?.("SUBSCRIBED"); } catch { /* */ } return canal; }, unsubscribe() {}, send() {} };
    window.supabase = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: window.__sessaoSupabase } }), signOut: async () => ({ error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getUser: async () => ({ data: { user: window.__sessaoSupabase.user } }) }, realtime: { setAuth() {}, connect() {}, disconnect() {} }, channel: () => canal, removeChannel: async () => {} }) };
  }, { conta: CONTA });
  await pagina.goto(base + "/");
  await pagina.waitForFunction(() => !document.querySelector("#app")?.hidden && document.querySelector("#menu li[data-rota]"));
  return { pagina, contexto, erros };
}
// FICHAS_SHOTS=<pasta> grava capturas de tela para inspeção visual (opcional; não afeta o resultado)
const foto = async (pagina, nome) => { if (process.env.FICHAS_SHOTS) { await pagina.waitForTimeout(700); await pagina.screenshot({ path: resolve(process.env.FICHAS_SHOTS, nome + ".png") }); } };
const irParaFichas = async (pagina) => { await pagina.click('#menu li[data-rota="fichas"]'); await pagina.waitForSelector("#ft-tabela table"); };
const linhas = (pagina) => pagina.$$eval("#ft-tabela tbody tr", (trs) => trs.map((t) => t.querySelector("td b").textContent));

describe("Fichas técnicas / condições comerciais / simulador / CMV teórico no app real", { skip: PULAR, timeout: 300_000 }, () => {
  test("menu: 'Fichas Técnicas' aparece para quem tem o módulo de Produtos/CMV", async () => {
    zerar();
    const { pagina, contexto } = await abrirApp();
    try {
      const itens = await pagina.$$eval("#menu li[data-rota]", (l) => l.map((x) => x.dataset.rota));
      assert.ok(itens.includes("fichas"), `menu: ${itens}`);
    } finally { await contexto.close(); }
  });

  test("lista: todas as fichas, filtros por categoria/tipo/situação, selos e pendências com causas", async () => {
    zerar();
    const { pagina, contexto, erros } = await abrirApp();
    try {
      await irParaFichas(pagina);
      assert.deepEqual((await linhas(pagina)).sort(), ["Bolo de Cenoura", "Calda de Chocolate", "Cappuccino", "Empadão de Frango"]);
      await foto(pagina, "01-lista-fichas");
      assert.match(await pagina.textContent("#ft-cards"), /Prontas para homologar/);
      // abas por categoria com contagem
      assert.match(await pagina.textContent("#ft-abas"), /Doces\s*2/);
      await pagina.click('.ft-aba[data-cat="DOCES"]');
      assert.deepEqual((await linhas(pagina)).sort(), ["Bolo de Cenoura", "Calda de Chocolate"]);
      // produtos finais × preparações
      await pagina.selectOption("#ft-natureza", "preparacao");
      assert.deepEqual(await linhas(pagina), ["Calda de Chocolate"]);
      await pagina.selectOption("#ft-natureza", "todas");
      await pagina.click('.ft-aba[data-cat="todas"]');
      // incompletas
      await pagina.selectOption("#ft-situacao", "incompletas");
      assert.deepEqual(await linhas(pagina), ["Cappuccino"]);
      assert.match(await pagina.textContent("#ft-tabela"), /1 a corrigir/);
      assert.match(await pagina.textContent("#ft-tabela"), /indisponível/); // custo oculto em ficha incompleta
      // selo de homologada com quem/quando no tooltip
      await pagina.selectOption("#ft-situacao", "homologadas");
      assert.match(await pagina.getAttribute("#ft-tabela .pill", "title"), /Ana Souza/);
      // busca ignora acento
      await pagina.selectOption("#ft-situacao", "todas");
      await pagina.fill("#ft-busca", "empadao");
      await pagina.waitForFunction(() => document.querySelectorAll("#ft-tabela tbody tr").length === 1);
      assert.deepEqual(await linhas(pagina), ["Empadão de Frango"]);
      assert.deepEqual(erros, []);
    } finally { await contexto.close(); }
  });

  test("detalhe: custo por porção, mão de obra à parte, pendências com causa e ação, ingredientes; homologar e reabrir (admin)", async () => {
    zerar();
    const { pagina, contexto } = await abrirApp();
    try {
      await irParaFichas(pagina);
      await pagina.click('[data-abrir="p1"]');
      await pagina.waitForSelector(".modal-ficha #ft-ficha table");
      const txt = await pagina.textContent(".modal-ficha");
      assert.match(txt, /Custo por porção/); assert.match(txt, /R\$\s*3,25/);
      assert.match(txt, /Mão de obra por porção/); assert.match(txt, /R\$\s*0,90/);
      assert.match(txt, /Cenoura/); assert.match(txt, /preparação/);
      await pagina.click("#ft-homologar");
      await pagina.waitForFunction(() => /Homologada por Admin/.test(document.querySelector(".modal-ficha")?.textContent ?? ""));
      assert.ok(api.chamadas.includes("PATCH /api/v1/produtos/p1/homologacao"));
      assert.deepEqual(api.corpos.find((c) => c.chamada.endsWith("/p1/homologacao")).corpo, { acao: "homologar" });
      await pagina.click("#ft-reabrir");
      await pagina.waitForFunction(() => /homologação foi reaberta/i.test(document.querySelector(".modal-ficha")?.textContent ?? ""));
      // ficha incompleta: pendências com causa e ação, sem botão de homologar
      await pagina.keyboard.press("Escape");
      await pagina.click('[data-abrir="p4"]');
      await pagina.waitForSelector(".ft-pend");
      const t4 = await pagina.textContent(".modal-ficha");
      await foto(pagina, "03-detalhe-incompleta");
      assert.match(t4, /Usa insumo sem custo/); assert.match(t4, /Informe o preço do insumo/); assert.match(t4, /unidade foi deduzida/);
      assert.equal(await pagina.locator("#ft-homologar").count(), 0);
      assert.match(t4, /não é exibido para não induzir a erro/);
    } finally { await contexto.close(); }
  });

  test("editar rendimento chama a API; alterar ficha homologada pede confirmação e a homologação invalida (motivo exibido)", async () => {
    zerar();
    const { pagina, contexto } = await abrirApp();
    try {
      await irParaFichas(pagina);
      await pagina.click('[data-abrir="p3"]'); // homologada
      await pagina.waitForSelector("#ft-rend");
      await pagina.fill("#ft-rend", "12");
      await pagina.click("#ft-rend-salvar");
      await pagina.waitForFunction(() => /rendimento da receita foi alterado/i.test(document.querySelector(".modal-ficha")?.textContent ?? ""));
      assert.deepEqual(api.corpos.find((c) => c.chamada === "PUT /api/v1/produtos/p3").corpo, { rendimento: 12 });
    } finally { await contexto.close(); }
  });

  test("homologação em lote (admin) e o papel de consulta NÃO vê botões de homologar nem editar rendimento", async () => {
    zerar();
    let { pagina, contexto } = await abrirApp();
    try {
      await irParaFichas(pagina);
      assert.match(await pagina.textContent("#ft-lote"), /Homologar 2 prontas/);
      await pagina.click("#ft-lote");
      await pagina.waitForFunction(() => !document.querySelector("#ft-lote") || document.querySelector("#ft-lote").hidden);
      assert.deepEqual(api.corpos.find((c) => c.chamada.endsWith("homologar-lote")).corpo.ids.sort(), ["p1", "p2"]);
    } finally { await contexto.close(); }
    zerar("consulta");
    ({ pagina, contexto } = await abrirApp());
    try {
      await irParaFichas(pagina);
      assert.equal(await pagina.locator("#ft-lote").isVisible(), false);
      await pagina.click('[data-abrir="p1"]');
      await pagina.waitForSelector(".modal-ficha");
      assert.equal(await pagina.locator("#ft-homologar").count(), 0);
      assert.equal(await pagina.locator("#ft-rend").count(), 0);
      assert.match(await pagina.textContent(".modal-ficha"), /Somente um administrador pode homologar/);
    } finally { await contexto.close(); }
  });

  test("Configurações › Condições comerciais: lista canais, valida a comissão obrigatória e salva (PUT) o corpo correto", async () => {
    zerar();
    const { pagina, contexto, erros } = await abrirApp();
    try {
      await pagina.click('#menu li[data-rota="configuracoes"]');
      await pagina.waitForSelector("#cfg-detalhe, .cfg-nav, [data-cfg-cat]", { timeout: 10000 }).catch(() => {});
      await pagina.evaluate(async () => { (await import("/src/configuracoes.js")).abrirSecaoConfiguracoes("condicoes"); });
      await pagina.waitForSelector(".cc-canal");
      const t = await pagina.textContent(".cc-lista");
      await foto(pagina, "04-condicoes-comerciais");
      assert.match(t, /iFood/); assert.match(t, /comissão 23%/); assert.match(t, /Parcial/); assert.match(t, /Não configurado/);
      assert.match(await pagina.textContent(".cfg-tabela-explicacao"), /Nenhum percentual é copiado de outra empresa/);
      // Balcão: configurar sem comissão => erro; com 0 explícito => salva
      await pagina.click('[data-editar="balcao"]');
      await pagina.click('.cc-form button[type="submit"]');
      assert.match(await pagina.textContent(".cc-form"), /Comissão: informe o valor/);
      await pagina.fill('.cc-form input[name="comissao"]', "0");
      await pagina.fill('.cc-form input[name="taxas"]', "0");
      await pagina.fill('.cc-form input[name="promocao"]', "0");
      await pagina.click('.cc-form button[type="submit"]');
      await pagina.waitForFunction(() => /Configurado/.test(document.querySelector('[data-canal="balcao"] header')?.textContent ?? ""));
      assert.deepEqual(api.corpos.find((c) => c.chamada === "PUT /api/v1/cmv/condicoes-comerciais").corpo,
        { canal: "balcao", comissao: 0, taxas: 0, promocao: 0, tributos: null, entrega_responsavel: null, entrega_custo: null, outras_deducoes: [], observacao: null });
      // iFood: completar taxas (parcial -> configurado) com entrega pela loja
      await pagina.click('[data-editar="ifood"]');
      await pagina.fill('.cc-form input[name="taxas"]', "1,5");
      await pagina.selectOption('.cc-form select[name="entrega_responsavel"]', "loja");
      await pagina.fill('.cc-form input[name="entrega_custo"]', "6,5");
      await pagina.click(".cc-form [data-add-outra]");
      await pagina.fill('.cc-form input[name="outra_nome_0"]', "Embalagem");
      await pagina.fill('.cc-form input[name="outra_pct_0"]', "1");
      await pagina.click('.cc-form button[type="submit"]');
      await pagina.waitForFunction(() => /Configurado/.test(document.querySelector('[data-canal="ifood"] header')?.textContent ?? ""));
      const corpo = api.corpos.filter((c) => c.chamada === "PUT /api/v1/cmv/condicoes-comerciais").at(-1).corpo;
      assert.deepEqual(corpo, { canal: "ifood", comissao: 0.23, taxas: 0.015, promocao: 0.05, tributos: null, entrega_responsavel: "loja", entrega_custo: 6.5, outras_deducoes: [{ nome: "Embalagem", pct: 0.01 }], observacao: null });
      assert.deepEqual(erros, []);
    } finally { await contexto.close(); }
  });

  test("Configurações › Condições comerciais: consulta só LÊ (sem botões de editar)", async () => {
    zerar("consulta");
    const { pagina, contexto } = await abrirApp();
    try {
      await pagina.click('#menu li[data-rota="configuracoes"]');
      await pagina.evaluate(async () => { (await import("/src/configuracoes.js")).abrirSecaoConfiguracoes("condicoes"); });
      await pagina.waitForSelector(".cc-canal");
      assert.equal(await pagina.locator("[data-editar]").count(), 0);
      assert.match(await pagina.textContent(".cfg-panel"), /Somente administradores/);
    } finally { await contexto.close(); }
  });

  test("MODAL DO SIMULADOR: sem comissão do canal = cálculo PARCIAL e nada assumido; com comissão desconta; margem-alvo e comparação", async () => {
    zerar();
    const { pagina, contexto, erros } = await abrirApp();
    try {
      await pagina.evaluate(async () => {
        const { abrirSimulador } = await import("/src/simuladorModal.js");
        abrirSimulador({ nome: "Bolo de Cenoura", custo: 6, preco: 20, canal: "ifood" }, { configurado: true, canais: [{ canal: "balcao", comissao: 0 }] });
      });
      await pagina.waitForSelector(".modal-sim #sim-aviso:not([hidden])");
      await foto(pagina, "05-simulador-parcial");
      assert.match(await pagina.textContent("#sim-aviso"), /Cálculo parcial/);
      assert.match(await pagina.textContent("#sim-canal"), /iFood · comissão não configurada/);
      assert.doesNotMatch(await pagina.textContent("#sim-canal"), /27%|15%/); // nenhum percentual das Subways herdado
      assert.match(await pagina.textContent("#sim-out"), /parcial/);
      // trocar para o canal configurado (balcão, 0%) tira o aviso parcial
      await pagina.selectOption("#sim-canal", "balcao");
      assert.equal(await pagina.locator("#sim-aviso.sim-aviso-parcial").count(), 0);
      assert.match(await pagina.textContent("#sim-out"), /R\$\s*14,00/); // lucro 20 - 6
      // condições opcionais entram na conta e o preço para a margem-alvo é calculado
      await pagina.click(".sim-extras summary");
      await pagina.fill("#sim-taxas", "5");
      await pagina.fill("#sim-margem-alvo", "40");
      assert.match(await pagina.textContent("#sim-alvo-out"), /Preço necessário: R\$\s*10,91/); // 6 / (1 - 0,05 - 0,40)
      // comparação atual × simulado
      await pagina.fill("#sim-preco", "30");
      assert.match(await pagina.textContent("#sim-comp"), /Hoje/); assert.match(await pagina.textContent("#sim-comp"), /Simulado/); assert.match(await pagina.textContent("#sim-comp"), /Diferença/);
      assert.deepEqual(erros, []);
    } finally { await contexto.close(); }
  });

  test("CMV TEÓRICO no Dashboard iFood: indisponível com motivo; parcial; estimado — nunca 'conciliado'; vínculo e simulador", async () => {
    zerar();
    const { pagina, contexto, erros } = await abrirApp();
    const montar = () => pagina.evaluate(async ({ und }) => {
      document.body.insertAdjacentHTML("beforeend", '<div id="ct-teste"></div>');
      const { montarCmvTeorico } = await import("/src/cmvTeoricoIfood.js");
      montarCmvTeorico("ct-teste", und, 11, 2026);
    }, { und: UND.id });
    // o painel lembra "expandido" entre montagens (como o simulador): só clica se ainda estiver recolhido
    const expandir = async () => { if ((await pagina.getAttribute("#ct-teste [data-toggle]", "aria-expanded")) !== "true") await pagina.click("#ct-teste [data-toggle]"); };
    try {
      api.cmv = { indisponivel: true, parcial: false, motivos_indisponivel: ["pedidos_sem_detalhe_de_itens"], cobertura: {}, produtos: [], sem_correspondencia: [], adicionais_sem_correspondencia: {} };
      await montar();
      await expandir();
      await pagina.waitForSelector("#ct-teste .ct-aviso");
      assert.match(await pagina.textContent("#ct-teste"), /Indisponível/); assert.match(await pagina.textContent("#ct-teste"), /detalhe dos itens vendidos/);
      assert.ok(api.chamadas.some((c) => c.includes("/cmv-teorico") && c.includes("de=2026-11-01") && c.includes("ate=2026-11-30")), "período do mês enviado");
      await pagina.evaluate(() => document.querySelector("#ct-teste").remove());

      api.cmv = { indisponivel: false, parcial: true, motivos_indisponivel: [], cmv_teorico_pct: 31.2, cmv_teorico_homologado_pct: null, comissao_considerada: null,
        cobertura: { pct_receita_vinculada: 32.4, produtos_vinculados: 2, produtos_ficha_incompleta: 1, pct_receita_com_custo_homologado: 0 },
        produtos: [
          { produto_id: "p1", nome: "Bolo de Cenoura", quantidade: 10, receita: 240, preco_medio_praticado: 24, custo_unitario: 3.25, cmv_pct: 13.5, margem_bruta_pct: 86.5, margem_apos_comissao_pct: null, homologacao: "pendente", custo_homologado: false, sinais: [], desfavoravel: false },
          { produto_id: "p4", nome: "Cappuccino", quantidade: 4, receita: 40, preco_medio_praticado: 10, custo_unitario: null, cmv_pct: null, margem_bruta_pct: null, margem_apos_comissao_pct: null, homologacao: "pendente", custo_homologado: false, sinais: [], desfavoravel: false },
        ],
        desfavoraveis: [], sem_correspondencia: [{ nome: "Item Misterioso", codigo: "ZZZ", quantidade: 3, receita: 300, motivo: "codigo_nao_cadastrado" }], adicionais_sem_correspondencia: {} };
      await montar();
      await expandir();
      await pagina.waitForSelector("#ct-teste .ct-cards");
      const t = await pagina.textContent("#ct-teste");
      await foto(pagina, "06-cmv-teorico");
      assert.match(t, /Parcial/); assert.match(t, /32%/); assert.match(t, /31.2%/);
      assert.match(t, /nenhuma ficha homologada/);          // CMV homologado indisponível, não 0
      assert.match(t, /Pendente de homologação/); assert.match(t, /Ficha incompleta/);
      assert.match(t, /Item Misterioso/); assert.match(t, /Código do item não existe nos produtos/);
      assert.match(t, /não está configurada/);              // margem após comissão indisponível: comissão não configurada
      assert.match(t, /Não é resultado financeiro conciliado|não é resultado financeiro conciliado/i);
      // atalho para o simulador de preços com os dados do produto
      await pagina.click('#ct-teste [data-sim="0"]');
      await pagina.waitForSelector(".modal-sim");
      assert.match(await pagina.textContent(".modal-sim"), /Bolo de Cenoura/);
      assert.match(await pagina.textContent(".modal-sim .sim-topo"), /R\$\s*3,25/);
      assert.deepEqual(erros, []);
    } finally { await contexto.close(); }
  });
});
