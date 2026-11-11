// PRODUTOS: Subways inalteradas × Caramelle (catálogo próprio, ficha e formação de custo no MESMO modal), homologação, permissões,
// condições comerciais, simulador e CMV teórico — no APP REAL, em navegador real. Não existe aba "Fichas Técnicas".
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
const UND = { id: "00000000-0000-4000-8000-0000000000c1", nome: "Loja de teste" };
const CONTA = "00000000-0000-4000-8000-0000000000a1";
const MIME = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".html": "text/html; charset=utf-8", ".json": "application/json" };

const PAPEIS = {
  admin: { papelRotulo: "Administrador", permissoes: ["dashboard.ver", "produtos.ver", "produtos.editar", "insumos.ver", "insumos.editar", "cmv.ver", "configuracoes.ver", "configuracoes.gerenciar", "dashboard_executivo.ver"] },
  consulta: { papelRotulo: "Consulta", permissoes: ["dashboard.ver", "produtos.ver", "insumos.ver", "cmv.ver", "configuracoes.ver", "dashboard_executivo.ver"] },
};
const MODULOS = ["dashboard", "products_cmv", "ingredients", "ifood_dashboard"];

// ---------------------------------------------------------------- dados falsos
const F = (o) => ({ ativo: true, natureza: "produto_final", categoria: null, origem: null, codigo_pdv: null, rendimento: 1, unidade_rendimento: null, custo_unitario: 2, custo_mao_de_obra_unitario: null,
  qtd_componentes: 2, status_ficha: { chave: "completa", ok: true }, ficha_completa: true, homologacao: "pendente", homologacao_motivo: null, homologado_em: null,
  homologado_por_nome: null, pendencias: [], pode_homologar: true, ...o });
const fichasCaramelle = () => [
  F({ id: "p1", nome: "Bolo de Cenoura", categoria: "DOCES", rendimento: 8, custo_unitario: 3.25, custo_mao_de_obra_unitario: 0.9 }),
  F({ id: "p2", nome: "Calda de Frutas", categoria: "DOCES", natureza: "preparacao", unidade_rendimento: "g", rendimento: 500, custo_unitario: 0.02 }),
  F({ id: "p3", nome: "Torta de Frango", categoria: "SALGADOS", homologacao: "homologada", homologado_por_nome: "Ana Souza", homologado_em: "2026-11-10T14:00:00Z", pode_homologar: false }),
  F({ id: "p4", nome: "Cappuccino", categoria: "BEBIDAS", custo_unitario: null, ficha_completa: false, pode_homologar: false, status_ficha: { chave: "insumo_sem_custo", ok: false },
    pendencias: [{ codigo: "insumo_sem_custo", detalhe: "insumo(s) sem custo: AGUA" }, { codigo: "unidade_inferida", detalhe: "rótulo L com 1000" }] }),
];
// Detalhe do produto no formato do backend (obterProduto). `controlado` = catálogo importado/independente.
function detalhe(f, empresa) {
  if (empresa === "subway") {
    return { id: f.id, nome: f.nome, tipo: "sanduiche", tamanho: "15cm", ativo: true, custo: 6, custo_calculado: 6, qtd_componentes: 1, status_ficha: { chave: "completa", label: "Completa" },
      ficha: [{ ficha_id: "f1", tipo: "insumo", insumo_id: "i1", nome: "Frango", categoria: "proteina", insumo_ativo: true, quantidade: 76, unidade: "g", unidade_base: "kg", custo_unitario_base: 0.03, custo_aplicado: 2.28 }],
      precos: [{ canal: "balcao", tabela: "E", preco: 24 }], controlado: false, catalogo: null };
  }
  const inc = !f.ficha_completa;
  return { id: f.id, nome: f.nome, tipo: f.natureza === "preparacao" ? "submontagem" : "outro", tamanho: null, ativo: true, codigo_pdv: f.codigo_pdv,
    custo: inc ? 0 : f.custo_unitario, custo_calculado: inc ? 0 : f.custo_unitario, qtd_componentes: 3, status_ficha: f.status_ficha.chave === "completa" ? { chave: "completa", label: "Completa" } : { chave: "insumo_sem_custo", label: "Insumo sem custo" },
    ficha: [
      { ficha_id: "fi1", tipo: "insumo", insumo_id: "i1", nome: "Cenoura", categoria: "outro", insumo_ativo: true, quantidade: 400, unidade: "g", unidade_base: "g", custo_unitario_base: 0.006, custo_aplicado: 2.4 },
      { ficha_id: "fi2", tipo: "submontagem", subproduto_id: "p2", nome: "Calda de Frutas", categoria: null, insumo_ativo: true, quantidade: 100, unidade: "g", unidade_base: "g", custo_unitario_base: 0.02, custo_aplicado: 2 },
      { ficha_id: "fi3", tipo: "insumo", insumo_id: "i3", nome: "Caixa kraft", categoria: "embalagem", insumo_ativo: true, quantidade: 1, unidade: "un", unidade_base: "un", custo_unitario_base: 1.2, custo_aplicado: 1.2 },
    ],
    precos: f.id === "p1" ? [{ canal: "ifood", tabela: "A", preco: 20 }, { canal: "uber", tabela: "A", preco: 21 }] : [],
    rendimento: f.rendimento,
    homologacao_info: { estado: f.homologacao, motivo: f.homologacao_motivo, homologado_em: f.homologado_em, homologado_por_nome: f.homologado_por_nome, custo_homologado: null },
    controlado: true,
    catalogo: {
      categoria: f.categoria, natureza: f.natureza, pendencias: f.pendencias,
      formacao_custo: { lote: { ingredientes: { itens: 1, total: 2.4 }, preparacoes: { itens: 1, total: 2 }, embalagens: { itens: 1, total: 1.2 }, total: 5.6 }, rendimento: f.rendimento, unidade_rendimento: f.unidade_rendimento, custo_unitario_materiais: inc ? null : f.custo_unitario },
      mao_de_obra: { linhas: [{ funcao: "confeiteira", minutos: 30, custo_minuto: 0.2795 }], proprio_lote: 8.385, herdado_lote: 0, total_lote: 8.385, custo_unitario: f.custo_mao_de_obra_unitario },
    } };
}
const CONDICOES = () => ({ configurado: true, ausentes: ["balcao", "uber", "app", "outro"], canais: [{ canal: "ifood", comissao: 0.23, taxas: 0.015, promocao: 0.05, tributos: 0, entrega_responsavel: "plataforma", entrega_custo: null, outras_deducoes: [], observacao: null }] });
const CMV_SUBWAY = [{ produto_id: "s1", nome: "Churrasco 15cm", tamanho: "15cm", categoria: "sanduiche", canal: "balcao", tabela: "E", preco: 24, custo: 6, comissao_pct: 0, lucro_liquido: 18, cmv_pct: 25, desatualizado: false }];

const api = { chamadas: [], corpos: [], papel: "admin", empresa: "caramelle", fichas: fichasCaramelle(), condicoes: CONDICOES(), cmv: null };
const zerar = (papel = "admin", empresa = "caramelle") => Object.assign(api, { chamadas: [], corpos: [], papel, empresa, fichas: fichasCaramelle(), condicoes: CONDICOES(), cmv: null });
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
      let m;
      const papel = PAPEIS[api.papel];
      const ctxOk = () => ({ contextToken: "ctx-1", expiraEm: new Date(Date.now() + 8 * 3600e3).toISOString(), sessionId: "sess-1", perfil: { id: CONTA, nome: "Conta" },
        empresa: { id: ORG, nome: api.empresa === "subway" ? "Subway Teste" : "Caramelle Café", logoUrl: null, status: "ativa" }, unidade: { id: UND.id, nome: UND.nome }, papel: api.papel, papelRotulo: papel.papelRotulo,
        permissoes: papel.permissoes, modulos: MODULOS, impersonando: false });
      if (caminho === "/api/v1/me") return json(res, 200, { data: { id: CONTA, email: "admin@exemplo.test", nome: "Admin", superadmin: false, painelAdministrativo: false, senhaProvisoria: false } });
      if (caminho === "/api/v1/sessao/perfis") return json(res, 200, { data: [{ id: CONTA, nome: "Admin", ativo: true, temPin: false }] });
      if (caminho === "/api/v1/sessao/acessos") return json(res, 200, { data: { superadmin: false, painelAdministrativo: false, opcoes: [{ organizacaoId: ORG, unidadeId: UND.id, empresaNome: "Empresa", unidadeNome: UND.nome, papel: api.papel, papelRotulo: papel.papelRotulo, acessivel: true, empresaStatus: "ativa" }] } });
      if (caminho === "/api/v1/sessao/selecionar") return json(res, 201, { data: ctxOk() });
      if (caminho === "/api/v1/sessao/atual") return json(res, 200, { data: ctxOk() });
      if (caminho === "/api/v1/sessao/unidades") return json(res, 200, { data: { unidades: [{ id: UND.id, nome: UND.nome }] } });
      if (caminho === "/api/v1/realtime/credencial") return json(res, 200, { data: { topicos: [], expiraEm: new Date(Date.now() + 300e3).toISOString(), validadeS: 300 } });

      // lista de Produtos / CMV: guiada por preço. A Caramelle ainda não tem tabela comercial => erro esperado do servidor.
      if (caminho === "/api/v1/cmv" && req.method === "GET") {
        if (api.empresa === "subway") return json(res, 200, { data: CMV_SUBWAY, canal: "balcao", tabela: "E", tabelaOficial: "E", comparando: false });
        res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Tabela comercial (balcão) não configurada para esta unidade.", codigo: "TABELA_NAO_CONFIGURADA" }));
      }
      if (caminho === "/api/v1/produtos" && req.method === "GET") {
        if (u.searchParams.get("vendavel") === "false") return json(res, 200, { data: [
          { id: "p2", nome: "Calda de Frutas", vendavel: false, custo_cache: 0.02, rendimento: 500, unidade_rendimento: "g" },
          { id: "p5", nome: "Cobertura", vendavel: false, custo_cache: 0.05, rendimento: 200, unidade_rendimento: "g" },
          { id: "pciclo", nome: "Preparação circular", vendavel: false, custo_cache: 0.01, rendimento: 100, unidade_rendimento: "g" }] });
        return json(res, 200, { data: [] });
      }
      if ((m = caminho.match(/^\/api\/v1\/produtos\/([^/]+)\/ficha$/)) && req.method === "POST") {
        if (corpo.subproduto_id === "pciclo") { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: 'Dependência circular: "Preparação circular" já usa esta receita (direta ou indiretamente). Remova esse vínculo antes.' })); }
        return json(res, 200, { data: { produto: detalhe(api.fichas.find((x) => x.id === m[1]), api.empresa) } });
      }
      if (caminho === "/api/v1/produtos/catalogo/fichas") {
        const it = api.empresa === "subway" ? [F({ id: "s1", nome: "Churrasco 15cm", homologacao: "nao_aplicavel", pode_homologar: false })] : api.fichas;
        return json(res, 200, { data: { resumo: { total: it.length }, itens: it } });
      }
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
        if ("codigo_pdv" in corpo) f.codigo_pdv = corpo.codigo_pdv;
        return json(res, 200, { data: detalhe(f, api.empresa) });
      }
      if ((m = caminho.match(/^\/api\/v1\/produtos\/([^/]+)$/)) && req.method === "GET") {
        if (m[1] === "s1") return json(res, 200, { data: detalhe({ id: "s1", nome: "Churrasco 15cm" }, "subway") });
        const f = api.fichas.find((x) => x.id === m[1]);
        if (f) return json(res, 200, { data: detalhe(f, api.empresa) });
      }
      if ((m = caminho.match(/^\/api\/v1\/produtos\/([^/]+)\/ficha\/([^/]+)$/)) && req.method === "PATCH") return json(res, 200, { data: { produto: detalhe(api.fichas.find((x) => x.id === m[1]), api.empresa) } });
      if (caminho === "/api/v1/cmv/condicoes-comerciais" && req.method === "GET") return json(res, 200, { data: api.condicoes });
      if (caminho === "/api/v1/cmv/condicoes-comerciais" && req.method === "PUT") {
        const outros = api.condicoes.canais.filter((c) => c.canal !== corpo.canal);
        api.condicoes.canais = [...outros, { canal: corpo.canal, comissao: corpo.comissao, taxas: corpo.taxas, promocao: corpo.promocao, tributos: corpo.tributos, entrega_responsavel: corpo.entrega_responsavel, entrega_custo: corpo.entrega_custo, outras_deducoes: corpo.outras_deducoes, observacao: corpo.observacao }];
        api.condicoes.ausentes = api.condicoes.ausentes.filter((c) => c !== corpo.canal);
        return json(res, 200, { data: api.condicoes });
      }
      if (caminho === "/api/v1/cmv/condicoes-comerciais/historico") return json(res, 200, { data: [] });
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
const irParaProdutos = async (pagina) => { await pagina.click('#menu li[data-rota="produtos"]'); await pagina.waitForSelector("#tbody tr"); };
const nomes = (pagina) => pagina.$$eval("#tbody tr .prod-link", (l) => l.map((x) => x.textContent));
const abrirProduto = async (pagina, nome) => { await pagina.click(`#tbody .prod-link:text-is("${nome}")`); await pagina.waitForSelector(".modal .modal-head"); };
const textoModal = (pagina) => pagina.textContent(".modal");
// Executa uma ação do modal e espera o REDESENHO real (o elemento antigo é marcado e some quando o modal é refeito).
const aposRedesenho = async (pagina, seletorMarca, acao) => {
  await pagina.evaluate((sel) => { document.querySelector(sel).dataset.velho = "1"; }, seletorMarca);
  await acao();
  await pagina.waitForFunction((sel) => { const n = document.querySelector(sel); return n && !n.dataset.velho; }, seletorMarca);
};

describe("Produtos: Subways inalteradas × catálogo da Caramelle, no app real", { skip: PULAR, timeout: 300_000 }, () => {
  test("NÃO existe aba 'Fichas Técnicas': Produtos é o único caminho", async () => {
    zerar();
    const { pagina, contexto } = await abrirApp();
    try {
      const itens = await pagina.$$eval("#menu li[data-rota]", (l) => l.map((x) => x.dataset.rota));
      assert.ok(!itens.includes("fichas"), `menu: ${itens}`);
      assert.ok(itens.includes("produtos"));
      assert.equal(await pagina.locator("#menu").getByText("Fichas Técnicas").count(), 0);
    } finally { await contexto.close(); }
  });

  test("SUBWAY: a lista e o modal do produto ficam como sempre — sem filtros, seções ou linhas de catálogo", async () => {
    zerar("admin", "subway");
    const { pagina, contexto, erros } = await abrirApp();
    try {
      await irParaProdutos(pagina);
      assert.deepEqual(await nomes(pagina), ["Churrasco 15cm"]);
      assert.equal(await pagina.locator(".pc-linha-catalogo").count(), 0);
      assert.equal((await pagina.textContent("#pc-filtros")).trim(), "");
      assert.match(await pagina.textContent("#result-count"), /^1 de 1 produtos$/);
      await abrirProduto(pagina, "Churrasco 15cm");
      const t = await textoModal(pagina);
      assert.match(t, /Ficha técnica/); assert.match(t, /Frango/); assert.match(t, /Custo total/); assert.match(t, /Preços por canal/);
      assert.doesNotMatch(t, /Formação do custo|Homologação|Vínculo|Código do PDV|Margem de contribuição/);
      assert.equal(await pagina.locator("#pc-topo, #pc-formacao, #pc-margens").count(), 0);
      assert.ok(!api.chamadas.some((c) => c.includes("condicoes-comerciais")), "Subway não deveria buscar condições ao abrir o produto");
      assert.deepEqual(erros, []);
    } finally { await contexto.close(); }
  });

  test("CARAMELLE: produtos do catálogo aparecem na lista de Produtos (mesmo sem tabela/preço), com filtros por categoria e situação", async () => {
    zerar();
    const { pagina, contexto, erros } = await abrirApp();
    try {
      await irParaProdutos(pagina);
      await pagina.waitForSelector("#pc-cat");
      assert.deepEqual((await nomes(pagina)).sort(), ["Bolo de Cenoura", "Calda de Frutas", "Cappuccino", "Torta de Frango"]);
      await foto(pagina, "01-produtos-caramelle");
      const corpo = await pagina.textContent("#tbody");
      assert.match(corpo, /Preparação intermediária/); assert.match(corpo, /sem preço de venda/); assert.match(corpo, /indisponível/);
      await pagina.selectOption("#pc-cat", "DOCES");
      assert.deepEqual((await nomes(pagina)).sort(), ["Bolo de Cenoura", "Calda de Frutas"]);
      await pagina.selectOption("#pc-cat", "todas");
      await pagina.selectOption("#pc-sit", "incompletas");
      assert.deepEqual(await nomes(pagina), ["Cappuccino"]);
      await pagina.selectOption("#pc-sit", "homologadas");
      assert.deepEqual(await nomes(pagina), ["Torta de Frango"]);
      await pagina.selectOption("#pc-sit", "todas");
      await pagina.fill("#f-busca", "calda");
      await pagina.waitForFunction(() => document.querySelectorAll("#tbody .prod-link").length === 1);
      assert.deepEqual(erros, []);
    } finally { await contexto.close(); }
  });

  test("CARAMELLE: clicar no produto abre O MESMO modal, com ficha, formação de custo, MOD separada, preços, CMV e margem por canal", async () => {
    zerar();
    const { pagina, contexto, erros } = await abrirApp();
    try {
      await irParaProdutos(pagina);
      await abrirProduto(pagina, "Bolo de Cenoura");
      await pagina.waitForSelector("#pc-formacao");
      await pagina.waitForSelector("#pc-margens table");
      await foto(pagina, "02-modal-produto-caramelle");
      const t = await textoModal(pagina);
      assert.match(t, /Ficha técnica/); assert.match(t, /Cenoura/); assert.match(t, /Calda de Frutas/); assert.match(t, /Caixa kraft/); assert.match(t, /Preços por canal · CMV/);
      assert.match(t, /Doces/); assert.match(t, /Produto final/);
      const f = (await pagina.textContent("#pc-formacao")).replace(/\s+/g, " ");
      assert.match(f, /Ingredientes/); assert.match(f, /Preparações intermediárias/); assert.match(f, /Embalagens/);
      assert.match(f, /Custo do lote inteiro \(sem mão de obra\)\s*R\$\s*5,60/);
      assert.match(f, /Rendimento da receita\s*8/);
      assert.match(f, /Custo unitário do produto \(por porção\) — base do CMV\s*R\$\s*3,25/);
      assert.match(f, /Mão de obra \(separada do CMV\) — por porção\s*R\$\s*0,90/); assert.match(f, /confeiteira · 30 min/);
      // margem por canal: iFood (23% + 1,5% + 5% + 0% = 29,5%) => lucro 20·0,705 − 3,25 = 10,85 ; Uber sem condições => sem margem
      const linhas = await pagina.$$eval("#pc-margens tbody tr", (trs) => trs.map((tr) => [...tr.querySelectorAll("td")].map((c) => c.textContent.replace(/\s+/g, " ").trim())));
      const ifood = linhas.find((l) => l[0] === "iFood"); const uber = linhas.find((l) => l[0] === "Uber");
      assert.match(ifood[2], /R\$\s*20,00/); assert.match(ifood[3], /16\.3%/); assert.match(ifood[4], /R\$\s*10,85/); assert.match(ifood[5], /54\.3%/);
      assert.equal(uber[4], "—"); assert.equal(uber[5], "—"); assert.match(uber[6], /não foram configuradas/);
      assert.deepEqual(erros, []);
    } finally { await contexto.close(); }
  });

  test("CARAMELLE: pendências com causa e ação; ficha incompleta não exibe custo, não homologa e não simula", async () => {
    zerar();
    const { pagina, contexto } = await abrirApp();
    try {
      await irParaProdutos(pagina);
      await abrirProduto(pagina, "Cappuccino");
      await pagina.waitForSelector("#pc-topo .ft-pend");
      await foto(pagina, "03-modal-incompleta");
      const t = await textoModal(pagina);
      assert.match(t, /Usa insumo sem custo/); assert.match(t, /Informe o preço do insumo/); assert.match(t, /unidade foi deduzida/); assert.match(t, /Incompleta/);
      assert.equal(await pagina.locator("#pc-homologar").count(), 0);
      assert.match(await pagina.textContent("#pc-formacao"), /indisponível/);
      assert.equal(await pagina.locator("#pc-simular").count(), 0);
    } finally { await contexto.close(); }
  });

  test("CARAMELLE: homologar e reabrir no próprio modal (admin); mostra quem homologou", async () => {
    zerar();
    const { pagina, contexto } = await abrirApp();
    try {
      await irParaProdutos(pagina);
      await abrirProduto(pagina, "Bolo de Cenoura");
      await pagina.click("#pc-homologar");
      await pagina.waitForFunction(() => /Homologada por Admin/.test(document.querySelector("#pc-topo")?.textContent ?? ""));
      assert.deepEqual(api.corpos.find((c) => c.chamada.endsWith("/p1/homologacao")).corpo, { acao: "homologar" });
      await pagina.click("#pc-reabrir");
      await pagina.waitForFunction(() => /homologação foi reaberta/i.test(document.querySelector("#pc-topo")?.textContent ?? ""));
      await pagina.keyboard.press("Escape");
      await abrirProduto(pagina, "Torta de Frango");
      assert.match(await pagina.textContent("#pc-topo"), /Homologada por Ana Souza/);
    } finally { await contexto.close(); }
  });

  test("CARAMELLE: corrigir rendimento, código do PDV e quantidade de ingrediente/preparação no mesmo modal chamam a API", async () => {
    zerar();
    const { pagina, contexto } = await abrirApp();
    try {
      await irParaProdutos(pagina);
      await abrirProduto(pagina, "Bolo de Cenoura");
      await pagina.fill("#pc-rend", "12");
      await aposRedesenho(pagina, "#pc-rend", () => pagina.click("#pc-rend-salvar"));
      assert.equal(await pagina.inputValue("#pc-rend"), "12");
      assert.deepEqual(api.corpos.find((c) => c.chamada === "PUT /api/v1/produtos/p1" && c.corpo.rendimento).corpo, { rendimento: 12 });
      await pagina.fill("#pc-pdv", " CAP-001 ");
      await aposRedesenho(pagina, "#pc-pdv", () => pagina.click("#pc-pdv-salvar"));
      assert.equal(await pagina.inputValue("#pc-pdv"), "CAP-001");
      assert.deepEqual(api.corpos.filter((c) => c.chamada === "PUT /api/v1/produtos/p1").at(-1).corpo, { codigo_pdv: "CAP-001" });
      // a ficha continua editável pelo editor EXISTENTE: ingredientes, embalagem e também a preparação (só no catálogo controlado)
      assert.equal(await pagina.locator('[data-ficha-acao="editar"]').count(), 3);
      await pagina.locator('[data-ficha-acao="editar"]').nth(1).click();
      await pagina.waitForSelector("#pm-q");
      assert.deepEqual(await pagina.$$eval("#pm-u option", (o) => o.map((x) => x.value)), ["g"]); // unidade da preparação travada na dela
      await pagina.fill("#pm-q", "150");
      await Promise.all([pagina.waitForResponse((r) => r.url().includes("/ficha/fi2")), pagina.click("#pm-save")]);
      assert.deepEqual(api.corpos.find((c) => c.chamada === "PATCH /api/v1/produtos/p1/ficha/fi2").corpo, { quantidade: "150", unidade: "g" });
    } finally { await contexto.close(); }
  });

  test("CARAMELLE: adicionar PREPARAÇÃO existente à receita no mesmo editor (qtd + unidade compatível); ciclo vem recusado do servidor", async () => {
    zerar();
    const { pagina, contexto, erros } = await abrirApp();
    try {
      await irParaProdutos(pagina);
      await abrirProduto(pagina, "Bolo de Cenoura");
      await pagina.click("#pm-addprep-btn");
      await pagina.waitForSelector("#pm-p-sel");
      const ops = await pagina.$$eval("#pm-p-sel option", (o) => o.map((x) => ({ t: x.textContent, d: x.disabled })));
      assert.ok(ops.some((o) => /Calda de Frutas.*já na receita/.test(o.t) && o.d), "preparação já usada fica desabilitada");
      assert.ok(ops.some((o) => /Cobertura/.test(o.t) && !o.d));
      await pagina.selectOption("#pm-p-sel", "p5");
      assert.deepEqual(await pagina.$$eval("#pm-p-u option", (o) => o.map((x) => x.value)).then((v) => v.sort()), ["g", "kg"]); // só unidades compatíveis com g
      await pagina.selectOption("#pm-p-u", "kg");
      await pagina.fill("#pm-p-q", "0.1");
      assert.match(await pagina.textContent("#pm-p-prev"), /R\$\s*5,00/); // 100 g × R$ 0,05/g (prévia)
      await foto(pagina, "06-adicionar-preparacao");
      await Promise.all([pagina.waitForResponse((r) => r.url().endsWith("/produtos/p1/ficha") && r.request().method() === "POST"), pagina.click("#pm-p-add")]);
      assert.deepEqual(api.corpos.find((c) => c.chamada === "POST /api/v1/produtos/p1/ficha").corpo, { subproduto_id: "p5", quantidade: "0.1", unidade: "kg" });
      // ciclo: o servidor recusa e a mensagem aparece no próprio formulário
      await pagina.waitForSelector("#pm-addprep-btn");
      await pagina.click("#pm-addprep-btn");
      await pagina.waitForSelector("#pm-p-sel");
      await pagina.selectOption("#pm-p-sel", "pciclo");
      await pagina.fill("#pm-p-q", "10");
      await pagina.click("#pm-p-add");
      await pagina.waitForSelector("#pm-p-err:not([hidden])");
      assert.match(await pagina.textContent("#pm-p-err"), /Dependência circular/);
      assert.deepEqual(erros, []);
    } finally { await contexto.close(); }
  });

  test("PREPARAÇÃO: sem selecionar mostra erro local; Subway e consulta não têm o botão", async () => {
    zerar();
    let { pagina, contexto } = await abrirApp();
    try {
      await irParaProdutos(pagina);
      await abrirProduto(pagina, "Bolo de Cenoura");
      await pagina.click("#pm-addprep-btn");
      await pagina.click("#pm-p-add");
      assert.match(await pagina.textContent("#pm-p-err"), /Selecione uma preparação/);
    } finally { await contexto.close(); }
    zerar("admin", "subway");
    ({ pagina, contexto } = await abrirApp());
    try {
      await irParaProdutos(pagina);
      await abrirProduto(pagina, "Churrasco 15cm");
      assert.equal(await pagina.locator("#pm-addprep-btn").count(), 0);
      assert.equal(await pagina.locator("#pm-add-btn").count(), 1); // o "Adicionar insumo" das Subways segue igual
    } finally { await contexto.close(); }
    zerar("consulta");
    ({ pagina, contexto } = await abrirApp());
    try {
      await irParaProdutos(pagina);
      await abrirProduto(pagina, "Bolo de Cenoura");
      await pagina.waitForSelector("#pc-formacao");
      assert.equal(await pagina.locator("#pm-addprep-btn").count(), 0);
    } finally { await contexto.close(); }
  });

  test("PERMISSÕES: consulta vê tudo mas NÃO edita, NÃO homologa e não vê o lote", async () => {
    zerar("consulta");
    const { pagina, contexto } = await abrirApp();
    try {
      await irParaProdutos(pagina);
      await pagina.waitForSelector("#pc-cat");
      assert.equal(await pagina.locator("#pc-lote").count(), 0);
      await abrirProduto(pagina, "Bolo de Cenoura");
      await pagina.waitForSelector("#pc-formacao");
      for (const sel of ["#pc-homologar", "#pc-reabrir", "#pc-rend", "#pc-rend-salvar", "#pc-pdv-salvar", "#pm-add-btn", '[data-ficha-acao="editar"]']) assert.equal(await pagina.locator(sel).count(), 0, sel);
      assert.equal(await pagina.locator("#pc-pdv").isDisabled(), true);
      assert.match(await pagina.textContent("#pc-topo"), /Somente um administrador pode homologar/);
      assert.match(await textoModal(pagina), /Custo unitário/);
    } finally { await contexto.close(); }
  });

  test("homologação em lote pela lista de Produtos (admin)", async () => {
    zerar();
    const { pagina, contexto } = await abrirApp();
    try {
      await irParaProdutos(pagina);
      await pagina.waitForSelector("#pc-lote");
      assert.match(await pagina.textContent("#pc-lote"), /Homologar 2 prontas/);
      await pagina.click("#pc-lote");
      await pagina.waitForFunction(() => !document.querySelector("#pc-lote"));
      assert.deepEqual(api.corpos.find((c) => c.chamada.endsWith("homologar-lote")).corpo.ids.sort(), ["p1", "p2"]);
    } finally { await contexto.close(); }
  });

  test("Configurações › Condições comerciais: lista canais, valida a comissão obrigatória e salva (PUT) o corpo correto", async () => {
    zerar();
    const { pagina, contexto, erros } = await abrirApp();
    try {
      await pagina.click('#menu li[data-rota="configuracoes"]');
      await pagina.evaluate(async () => { (await import("/src/configuracoes.js")).abrirSecaoConfiguracoes("condicoes"); });
      await pagina.waitForSelector(".cc-canal");
      await foto(pagina, "04-condicoes-comerciais");
      const t = await pagina.textContent(".cc-lista");
      assert.match(t, /iFood/); assert.match(t, /comissão 23%/); assert.match(t, /Não configurado/);
      assert.match(await pagina.textContent(".cfg-tabela-explicacao"), /Nenhum percentual é copiado de outra empresa/);
      await pagina.click('[data-editar="balcao"]');
      await pagina.click('.cc-form button[type="submit"]');
      assert.match(await pagina.textContent(".cc-form"), /Comissão: informe o valor/);
      await pagina.fill('.cc-form input[name="comissao"]', "0");
      await pagina.fill('.cc-form input[name="taxas"]', "0");
      await pagina.fill('.cc-form input[name="promocao"]', "0");
      await pagina.click('.cc-form button[type="submit"]');
      await pagina.waitForFunction(() => /Parcial|Configurado/.test(document.querySelector('[data-canal="balcao"] header')?.textContent ?? ""));
      assert.deepEqual(api.corpos.find((c) => c.chamada === "PUT /api/v1/cmv/condicoes-comerciais").corpo,
        { canal: "balcao", comissao: 0, taxas: 0, promocao: 0, tributos: null, entrega_responsavel: null, entrega_custo: null, outras_deducoes: [], observacao: null });
      assert.deepEqual(erros, []);
    } finally { await contexto.close(); }
  });

  test("Condições comerciais: consulta só LÊ (sem botões de editar)", async () => {
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

  test("SIMULADOR a partir do produto da Caramelle: sem preço atual não inventa; comissão DA empresa; canal sem comissão = PARCIAL", async () => {
    zerar();
    const { pagina, contexto, erros } = await abrirApp();
    try {
      await irParaProdutos(pagina);
      await abrirProduto(pagina, "Calda de Frutas");   // preparação sem preço cadastrado
      await pagina.waitForSelector("#pc-simular");
      await pagina.click("#pc-simular");
      await pagina.waitForSelector(".modal-sim");
      await foto(pagina, "05-simulador");
      assert.match(await pagina.textContent(".modal-sim .sim-topo"), /não cadastrado/);
      assert.match(await pagina.textContent("#sim-canal"), /iFood · 23%/);
      assert.match(await pagina.textContent("#sim-canal"), /Balcão · comissão não configurada/);
      assert.doesNotMatch(await pagina.textContent("#sim-canal"), /27%|15%/);
      await pagina.selectOption("#sim-canal", "balcao");
      assert.match(await pagina.textContent("#sim-aviso"), /Cálculo parcial/);
      await pagina.selectOption("#sim-canal", "ifood");
      assert.equal(await pagina.locator("#sim-aviso.sim-aviso-parcial").count(), 0);
      assert.deepEqual(erros, []);
    } finally { await contexto.close(); }
  });

  test("MODAL DO SIMULADOR (isolado): parcial sem comissão; com comissão desconta; margem-alvo e comparação", async () => {
    zerar();
    const { pagina, contexto, erros } = await abrirApp();
    try {
      await pagina.evaluate(async () => {
        const { abrirSimulador } = await import("/src/simuladorModal.js");
        abrirSimulador({ nome: "Bolo de Cenoura", custo: 6, preco: 20, canal: "ifood" }, { configurado: true, canais: [{ canal: "balcao", comissao: 0 }] });
      });
      await pagina.waitForSelector(".modal-sim #sim-aviso:not([hidden])");
      assert.match(await pagina.textContent("#sim-aviso"), /Cálculo parcial/);
      await pagina.selectOption("#sim-canal", "balcao");
      assert.match(await pagina.textContent("#sim-out"), /R\$\s*14,00/);
      await pagina.click(".sim-extras summary");
      await pagina.fill("#sim-taxas", "5");
      await pagina.fill("#sim-margem-alvo", "40");
      assert.match(await pagina.textContent("#sim-alvo-out"), /Preço necessário: R\$\s*10,91/);
      await pagina.fill("#sim-preco", "30");
      assert.match(await pagina.textContent("#sim-comp"), /Diferença/);
      assert.deepEqual(erros, []);
    } finally { await contexto.close(); }
  });
});
