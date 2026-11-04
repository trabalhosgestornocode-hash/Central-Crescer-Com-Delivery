// Foody Delivery (Configurações → Integrações) em NAVEGADOR REAL (Chrome via Playwright), com as ROTAS REAIS do backend
// (criarFoodyAdminRouter → serviços → repositório) sobre o banco FALSO com o contrato da 149. Nunca fala com produção,
// Supabase ou a API Foody: qualquer fetch do servidor para fora seria contado (e o teste exige zero).
//
// Rodar:
//   CHECKLIST_PLAYWRIGHT_PATH=<...>/worker-martinbrower/node_modules/playwright CHECKLIST_BROWSER_CHANNEL=chrome \
//   node --test frontend/test/configuracoesFoody.browser.test.js
// (precisa de backend/node_modules). CHECKLIST_SCREENSHOTS=<pasta> grava capturas.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

let chromium;
try { ({ chromium } = createRequire(import.meta.url)(process.env.CHECKLIST_PLAYWRIGHT_PATH || "playwright")); } catch { /* sem Playwright: pulado */ }
const PULAR = !chromium && "Configure CHECKLIST_PLAYWRIGHT_PATH (Playwright) para rodar no navegador";
const CANAL = process.env.CHECKLIST_BROWSER_CHANNEL;
const CAPTURAS = process.env.CHECKLIST_SCREENSHOTS;
const RAIZ = resolve(fileURLToPath(new URL("..", import.meta.url)));

const ORG_T = "11111111-1111-4111-8111-111111111111", UNI_T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_D = "22222222-2222-4222-8222-222222222222", UNI_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ADM_T = "a1000000-0000-4000-8000-000000000001", ADM_D = "a2000000-0000-4000-8000-000000000002";
const TOKEN = "foody_tok_TESTE_nao_real_0123456789";
const NOMES_ORG = { [ORG_T]: "Subway Teste", [ORG_D]: "Açaí Teste" };
const NOMES_UNI = { [UNI_T]: "Loja Subway", [UNI_D]: "Loja Açaí" };

const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/configuracoes.css">
<script>window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:"acc"}}}),
  mfa:{getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:"aal1",nextLevel:"aal1"}}),listFactors:async()=>({data:{totp:[]}})}}})};</script>
</head><body>
<div id="app" class="app"><div class="main"><main id="view" class="content"></main></div></div><div id="toast" class="toast"></div>
</body></html>`;

let servidor, base, db, env, express, chamadasExternas = 0;
const foodyGets = [];
// Quem está "logado" no contexto (o servidor de teste monta req.acesso a partir daqui, como requireContexto faria).
const sessao = { perfil: ADM_T, org: ORG_T, unidade: UNI_T, papel: "organization_admin", impersonando: false };

before(async () => {
  if (PULAR) return;
  Object.assign(process.env, { SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "ficticio_service_role_key_0123456789abcdef", SUPABASE_ANON_KEY: "ficticio_anon_key_0123456789abcdef0123" });
  const back = (m) => import(new URL(`../../backend/${m}`, import.meta.url));
  const req = createRequire(new URL("../../backend/package.json", import.meta.url));
  express = req("express");
  const { criarFoodyAdminRouter } = await back("src/modules/foody-admin/foodyAdmin.routes.js");
  const { criarFoodySyncRouter } = await back("src/modules/foody-admin/foodyAdmin.sync.routes.js");
  const { criarClienteFoody } = await back("src/modules/foody/foody.client.js");
  const { pedidoApi } = await back("test/helpers/foody-fixtures.js");
  const { errorHandler } = await back("src/middlewares/errorHandler.js");
  const { permissoesDoPapel } = await back("src/shared/permissoes.js");
  const { criarSegurancaFoody } = await back("src/modules/foody/foody.seguranca.js");
  const { criarFakeDb } = await back("test/helpers/fake-db-foody.js");
  const { SEGREDO_TESTE } = await back("test/helpers/foody-fixtures.js");
  db = criarFakeDb({ unidades: { [UNI_T]: ORG_T, [UNI_D]: ORG_D }, admins: [[ADM_T, ORG_T], [ADM_D, ORG_D]] });
  env = { FOODY_CENTRAL_ADMIN_ENABLED: "true", FOODY_CENTRAL_SECRET: SEGREDO_TESTE };
  const plataforma = {
    nomes: async ({ organizacoes, unidades }) => ({ organizacoes: new Map(organizacoes.map((o) => [o, NOMES_ORG[o]])), unidades: new Map(unidades.map((u) => [u, NOMES_UNI[u]])) }),
    organizacoesDoPerfil: async (p) => (p === ADM_T ? [ORG_T, ORG_D] : p === ADM_D ? [ORG_D] : []).map((o) => ({ id: o, nome: NOMES_ORG[o] })),
    unidadesDaOrganizacao: async (o) => [{ id: o === ORG_T ? UNI_T : UNI_D, nome: NOMES_UNI[o === ORG_T ? UNI_T : UNI_D] }],
  };
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (url, ...r) => { if (!String(url).startsWith("http://127.0.0.1:")) chamadasExternas += 1; return fetchOriginal(url, ...r); };

  const app = express();
  app.use(express.json());
  app.get("/", (_q, res) => res.type("html").send(PAGINA));
  app.get("/favicon.ico", (_q, res) => res.status(204).end());
  app.get("/api/config", (_q, res) => res.json({ supabaseUrl: "http://127.0.0.1:9", supabaseAnonKey: "x" }));
  app.get("/api/v1/inteligencia/integracoes", (_q, res) => res.json({ data: [{ id: "ifood", nome: "iFood", conectado: true }] }));
  app.use("/api/v1", (rq, _res, next) => {
    rq.user = { id: `u-${sessao.perfil}` };
    rq.tenant = { organizacaoId: sessao.org, unidadeId: sessao.unidade };
    rq.acesso = { perfilId: sessao.impersonando ? null : sessao.perfil, papel: sessao.papel, permissoes: permissoesDoPapel(sessao.papel), modulos: [],
      impersonando: sessao.impersonando, empresa: { id: sessao.org, nome: NOMES_ORG[sessao.org], status: "ativa" } };
    next();
  });
  // API Foody FALSA (só para a sincronização manual): pedidos de ONTEM em Brasília, Subway + Açaí + um item desconhecido.
  const ontem = new Date(Date.now() - 3 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
  const pedidosFoody = [
    pedidoApi({ uid: "b-s1", pontoColeta: "Loja Subway Centro", orderDetails: "1x Sub Frango Teriyaki 15cm", date: `${ontem}T11:00:00-03:00` }),
    pedidoApi({ uid: "b-a1", pontoColeta: "Loja Subway Centro", orderDetails: "1x Açaí Premium 500ml", date: `${ontem}T12:00:00-03:00` }),
    pedidoApi({ uid: "b-t1", pontoColeta: "Loja Subway Centro", orderDetails: "1x Produto Novo Misterioso", date: `${ontem}T13:00:00-03:00` }),
  ];
  const criarCliente = ({ token, ...r }) => criarClienteFoody({ token, ...r, esperar: async () => {}, fetch: async (url) => {
    foodyGets.push(String(url));
    const u = new URL(String(url)); const ini = Date.parse(u.searchParams.get("startDate")), fim = Date.parse(u.searchParams.get("endDate"));
    return { ok: true, status: 200, json: async () => structuredClone(pedidosFoody.filter((o) => Date.parse(o.date) >= ini && Date.parse(o.date) < fim)) };
  } });
  app.use("/api/v1/integracoes/foody/sincronizacoes", criarFoodySyncRouter({ db, env, seguranca: () => criarSegurancaFoody(env.FOODY_CENTRAL_SECRET),
    criarCliente, auditoria: async () => {} }));
  app.use("/api/v1/integracoes/foody", criarFoodyAdminRouter({ db, env, plataforma, seguranca: () => criarSegurancaFoody(env.FOODY_CENTRAL_SECRET) }));
  app.use("/api", (_q, res) => res.status(404).json({ error: "não encontrado" }));
  app.use(errorHandler);
  app.use((rq, res) => {
    const arq = resolve(RAIZ, "." + decodeURIComponent(rq.path));
    if (!arq.startsWith(RAIZ + sep)) return res.status(403).end();
    try { res.type(arq.endsWith(".css") ? "text/css" : arq.endsWith(".svg") ? "image/svg+xml" : "text/javascript").send(readFileSync(arq)); }
    catch { res.status(404).end(); }
  });
  servidor = app.listen(0, "127.0.0.1");
  await new Promise((r) => servidor.once("listening", r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  if (CAPTURAS) mkdirSync(CAPTURAS, { recursive: true });
});
after(async () => { if (servidor) await new Promise((r) => servidor.close(r)); });

async function abrir(browser, { viewport = { width: 390, height: 844 }, tema = "light" } = {}) {
  const ctx = await browser.newContext({ viewport });
  const pagina = await ctx.newPage();
  const erros = [];
  pagina.on("pageerror", (e) => erros.push(e.message));
  pagina.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) erros.push(m.text()); });
  await pagina.goto(base + "/");
  await pagina.evaluate(async ({ org, uni, nomeOrg, nomeUni, papel, tema: t }) => {
    sessionStorage.clear();
    document.documentElement.setAttribute("data-theme", t);
    const { state } = await import("/src/state.js");
    const { permissoesDoPapel } = { permissoesDoPapel: () => ["configuracoes.ver", "configuracoes.gerenciar", "integracoes.ver", "integracoes.gerenciar"] };
    Object.assign(state.sessao, { empresa: { id: org, nome: nomeOrg }, unidade: { id: uni, nome: nomeUni }, permissoes: permissoesDoPapel(), papel, modulos: [] });
    state.rota = "configuracoes";
    const cfg = await import("/src/configuracoes.js");
    cfg.renderConfiguracoes();
  }, { org: sessao.org, uni: sessao.unidade, nomeOrg: NOMES_ORG[sessao.org], nomeUni: NOMES_UNI[sessao.unidade], papel: sessao.papel, tema });
  await pagina.locator("[data-cfg2]").waitFor();
  await pagina.locator('[data-cat="integracoes"]').click();
  await pagina.locator("#cfg-corpo-integracoes").waitFor({ state: "attached" });
  return { ctx, pagina, erros };
}
const foto = async (pagina, nome) => { if (CAPTURAS) await pagina.screenshot({ path: resolve(CAPTURAS, `${nome}.png`), fullPage: true, animations: "disabled" }); };
const semRolagemHorizontal = (pagina) => pagina.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const secao = (pagina) => pagina.locator("#cfg-secao-foody");
/** Acessibilidade estrutural dentro da seção: todo controle com nome acessível, ids únicos, tabs coerentes. */
const auditarA11y = (pagina) => pagina.evaluate(() => {
  const raiz = document.querySelector("#cfg-secao-foody") ?? document;
  const problemas = [];
  for (const c of raiz.querySelectorAll("input:not([type=hidden]), select, textarea")) {
    const nome = c.labels?.length || c.getAttribute("aria-label") || c.getAttribute("aria-labelledby");
    if (!nome) problemas.push(`controle sem rótulo: ${c.outerHTML.slice(0, 80)}`);
  }
  for (const b of raiz.querySelectorAll("button")) if (!b.textContent.trim() && !b.getAttribute("aria-label")) problemas.push(`botão sem nome: ${b.outerHTML.slice(0, 80)}`);
  const ids = [...document.querySelectorAll("[id]")].map((x) => x.id);
  for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) problemas.push(`id duplicado: ${id}`);
  for (const ref of raiz.querySelectorAll("[aria-describedby],[aria-controls],[aria-labelledby]")) {
    for (const at of ["aria-describedby", "aria-controls", "aria-labelledby"]) for (const id of (ref.getAttribute(at) ?? "").split(/\s+/).filter(Boolean)) {
      if (!document.getElementById(id)) problemas.push(`${at} aponta para id inexistente: ${id}`);
    }
  }
  const abas = [...raiz.querySelectorAll('[role="tab"]')];
  if (abas.length && abas.filter((a) => a.getAttribute("aria-selected") === "true").length !== 1) problemas.push("tablist sem exatamente uma aba selecionada");
  return problemas;
});
const OPC = { skip: PULAR };

describe("Foody Delivery — navegador real", OPC, () => {
  let browser;
  before(async () => { if (!PULAR) browser = await chromium.launch(CANAL ? { channel: CANAL } : {}); });
  after(async () => { await browser?.close(); });

  test("administração DESLIGADA: a seção não aparece e o resto de Integrações segue normal", async () => {
    env.FOODY_CENTRAL_ADMIN_ENABLED = "false";
    const { ctx, pagina, erros } = await abrir(browser, { viewport: { width: 1280, height: 900 } });
    await pagina.locator("#cfg-corpo-integracoes .cfg-integracao").first().waitFor();
    await pagina.waitForFunction(() => document.querySelector("#cfg-secao-foody")?.hidden === true);
    assert.equal(await secao(pagina).isVisible(), false);
    assert.doesNotMatch(await pagina.evaluate(() => document.body.innerText), /Foody/);
    assert.deepEqual(erros, []);
    await ctx.close();
    env.FOODY_CENTRAL_ADMIN_ENABLED = "true";
  });

  test("titular no celular (390px): conectar com validação acessível, token some do DOM, ativar sem coletar, abas pelo teclado", async () => {
    Object.assign(sessao, { perfil: ADM_T, org: ORG_T, unidade: UNI_T, impersonando: false });
    const { ctx, pagina, erros } = await abrir(browser);
    const s = secao(pagina);
    await s.getByRole("tab", { name: /Conexão/ }).waitFor();
    assert.match(await s.innerText(), /coleta de pedidos está desligada/i);
    const campo = s.getByLabel("Token da conta Foody");
    assert.equal(await campo.getAttribute("type"), "password");
    await campo.fill("curto");
    await s.getByRole("button", { name: "Conectar" }).click();
    assert.match(await s.locator("#fdy-cadastro-token-erro").innerText(), /Token inválido/);
    assert.equal(await campo.getAttribute("aria-invalid"), "true");
    assert.equal(await pagina.evaluate(() => document.activeElement?.id), "fdy-cadastro-token", "foco volta para o campo com erro");
    await campo.fill(TOKEN);
    await s.getByLabel(/Ponto de coleta esperado/).fill("Loja Subway Centro");
    await s.getByRole("button", { name: "Conectar" }).click();
    await s.locator(".pill", { hasText: /^Pausada$/ }).first().waitFor();
    assert.ok(!(await pagina.content()).includes(TOKEN), "o token não fica em lugar nenhum da página");
    assert.match(await s.innerText(), /…[0-9a-f]{4}/);
    await foto(pagina, "foody-390-conectada");
    await s.getByRole("button", { name: /Ativar/ }).click();
    const dlg = pagina.locator("dialog.cfg-dialogo");
    assert.match(await dlg.innerText(), /nenhum pedido é coletado/);
    await dlg.getByRole("button", { name: "Ativar" }).click();
    await s.locator(".pill", { hasText: /^Ativa$/ }).first().waitFor();
    assert.equal(chamadasExternas, 0, "nenhuma chamada à API Foody"); assert.equal(db.tabelas.foody_sync_execucoes.length, 0);
    // Abas: setas movem o foco e a seleção (padrão WAI-ARIA).
    await s.getByRole("tab", { name: /Conexão/ }).focus();
    await pagina.keyboard.press("ArrowRight");
    assert.equal(await pagina.evaluate(() => document.activeElement?.id), "fdy-aba-compartilhamento");
    assert.equal(await s.getByRole("tab", { name: /Compartilhamento/ }).getAttribute("aria-selected"), "true");
    await pagina.keyboard.press("End");
    assert.equal(await pagina.evaluate(() => document.activeElement?.id), "fdy-aba-auditoria");
    assert.match(await s.innerText(), /Conexão ativada[\s\S]*Você/);
    assert.ok(await semRolagemHorizontal(pagina), "sem rolagem horizontal em 390px");
    assert.deepEqual(await auditarA11y(pagina), []);
    assert.deepEqual(erros, []);
    await ctx.close();
  });

  test("propor compartilhamento (titular) e aprovar no contexto do destino; tema escuro; sem rolagem", async () => {
    Object.assign(sessao, { perfil: ADM_T, org: ORG_T, unidade: UNI_T });
    let { ctx, pagina, erros } = await abrir(browser);
    let s = secao(pagina);
    await s.getByRole("tab", { name: /Compartilhamento/ }).click();
    await s.getByRole("button", { name: /Propor compartilhamento/ }).click();
    await s.getByLabel("Empresa e unidade destino").waitFor();
    assert.equal(await pagina.evaluate(() => document.activeElement?.id), "fdy-destino");
    await s.getByRole("button", { name: "Propor" }).click();
    assert.match(await s.locator("#fdy-destino-erro").innerText(), /Escolha/);
    await s.getByLabel("Empresa e unidade destino").selectOption({ label: "Açaí Teste — Loja Açaí" });
    await s.getByRole("button", { name: "Propor" }).click();
    await s.getByText("Aguardando aprovação").waitFor();
    assert.match(await s.innerText(), /Aguardando um Administrador da empresa destino/);
    assert.equal(await s.getByRole("button", { name: "Aprovar" }).count(), 0, "a titular não aprova pelo destino");
    assert.deepEqual(erros, []);
    await ctx.close();

    Object.assign(sessao, { perfil: ADM_D, org: ORG_D, unidade: UNI_D });
    ({ ctx, pagina, erros } = await abrir(browser, { tema: "dark" }));
    s = secao(pagina);
    await s.getByRole("tab", { name: /Compartilhamento/ }).click();
    assert.match(await s.innerText(), /Subway Teste — Loja Subway → Açaí Teste — Loja Açaí/);
    await s.getByRole("button", { name: "Aprovar" }).click();
    await pagina.locator("dialog.cfg-dialogo").getByRole("button", { name: "Aprovar" }).click();
    await s.locator(".pill", { hasText: /^Ativo$/ }).first().waitFor();
    // Destino vivo não pode ter conexão própria: a tela não oferece o cadastro e explica.
    await s.getByRole("tab", { name: /Conexão/ }).click();
    assert.equal(await s.getByLabel("Token da conta Foody").count(), 0);
    assert.match(await s.innerText(), /já recebe pedidos Foody por compartilhamento/);
    // Nada da conexão da titular aparece para o destino (ponto de coleta, final da conta, token).
    const tudoD = await pagina.evaluate(() => document.body.innerText + document.documentElement.outerHTML);
    assert.doesNotMatch(tudoD, /Loja Subway Centro|…[0-9a-f]{4}/); assert.ok(!tudoD.includes(TOKEN));
    await foto(pagina, "foody-390-destino-escuro");
    assert.ok(await semRolagemHorizontal(pagina));
    assert.deepEqual(await auditarA11y(pagina), []);
    assert.deepEqual(erros, []);
    await ctx.close();
  });

  test("triagem pelo destino: dia, itens mínimos, decisão exige operação e justificativa, histórico", async () => {
    const cx = db.tabelas.foody_conexoes[0].id;
    db.tabelas.foody_pedidos.push({ id: "p1", organizacao_id: ORG_T, unidade_id: UNI_T, conexao_id: cx, foody_uid: "t1", numero_pedido: "#481", competencia: "2026-11-02",
      data_hora: "2026-11-02T13:00:00-03:00", operacao: "triagem", roteamento_ativo: true, detalhes_pedido: "1x Produto Novo Misterioso", triagem_motivo: "ITEM_DESCONHECIDO",
      operacao_motivo: "1 sem evidência", catalogo_versao: "2026-11-03.1", situacao: "Finalizado", valor_total: 55 });
    Object.assign(sessao, { perfil: ADM_D, org: ORG_D, unidade: UNI_D });
    const { ctx, pagina, erros } = await abrir(browser);
    const s = secao(pagina);
    await s.getByRole("tab", { name: /Triagem/ }).click();
    await s.getByText("Pedido #481").waitFor();
    const txt = await s.innerText();
    assert.match(txt, /produto novo misterioso/i); assert.match(txt, /Item fora do catálogo/);
    assert.doesNotMatch(txt, /55/, "sem valor do pedido na triagem");
    await s.getByRole("button", { name: "Registrar decisão" }).click();
    assert.match(await s.locator(".cfg-erro[role=alert]").first().innerText(), /Escolha a operação/);
    await s.getByRole("radio", { name: "Açaí no Grau" }).check();
    await s.getByRole("button", { name: "Registrar decisão" }).click();
    assert.match(await s.locator(".fdy-pedido .cfg-erro").innerText(), /motivo/);
    await s.getByLabel("Justificativa").fill("conferido no Gestor");
    await s.getByRole("button", { name: "Registrar decisão" }).click();
    await s.getByText(/Decidido: Açaí no Grau \(você\)/).waitFor();
    await s.getByRole("cell", { name: "conferido no Gestor" }).waitFor();
    assert.ok(await semRolagemHorizontal(pagina));
    assert.deepEqual(await auditarA11y(pagina), []);
    await foto(pagina, "foody-390-triagem");
    assert.deepEqual(erros, []);
    await ctx.close();
  });

  test("sincronização manual: só a titular vê a aba; desligada informa; ligada sincroniza ontem e mostra contagens (sem valores)", async () => {
    Object.assign(sessao, { perfil: ADM_D, org: ORG_D, unidade: UNI_D, impersonando: false });
    let { ctx, pagina, erros } = await abrir(browser);
    let s = secao(pagina);
    await s.getByRole("tab", { name: /Conexão/ }).waitFor();
    assert.equal(await s.getByRole("tab", { name: /Sincronização/ }).count(), 0, "o destino não tem a aba");
    await ctx.close();

    Object.assign(sessao, { perfil: ADM_T, org: ORG_T, unidade: UNI_T });
    ({ ctx, pagina, erros } = await abrir(browser));
    s = secao(pagina);
    await s.getByRole("tab", { name: /Sincronização/ }).click();
    await s.getByText(/coleta está desligada no servidor para esta unidade/).waitFor();
    assert.equal(await s.getByRole("button", { name: /Sincronizar/ }).count(), 0);
    await ctx.close();

    Object.assign(env, { FOODY_CENTRAL_ENABLED: "true", FOODY_CENTRAL_UNIDADES: UNI_T, FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED: "true" });
    ({ ctx, pagina, erros } = await abrir(browser));
    s = secao(pagina);
    await s.getByRole("tab", { name: /Sincronização/ }).click();
    await s.getByRole("button", { name: /Sincronizar/ }).click();
    await pagina.locator("dialog.cfg-dialogo").getByRole("button", { name: "Sincronizar" }).click();
    await s.getByText(/3 pedidos · 1 Açaí · 1 em triagem/).waitFor();
    const txt = await s.innerText();
    assert.match(txt, /Fechamento Açaí no Grau: Consolidado \(versão 1\)/);
    assert.doesNotMatch(txt, /R\$|\d+,\d{2}\b|taxa|custo/i, "nenhum valor monetário na tela");
    assert.ok(foodyGets.length >= 1 && foodyGets.every((u) => u.startsWith("https://app.foodydelivery.com/rest/1.2/orders?")));
    assert.equal(chamadasExternas, 0);
    assert.ok(db.tabelas.foody_pedidos.some((p) => p.foody_uid === "b-a1" && p.unidade_id === UNI_D && p.roteamento_ativo !== false));
    await s.getByRole("cell", { name: "Manual" }).first().waitFor();
    assert.ok(await semRolagemHorizontal(pagina), "sem rolagem horizontal em 390px");
    assert.deepEqual(await auditarA11y(pagina), []);
    await foto(pagina, "foody-390-sincronizacao");
    assert.deepEqual(erros, []);
    await ctx.close();
    Object.assign(env, { FOODY_CENTRAL_ENABLED: "false", FOODY_CENTRAL_UNIDADES: "", FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED: "false" });
  });

  test("impersonação: só consulta, nenhum botão de ação; revogar exige motivo no diálogo", async () => {
    Object.assign(sessao, { perfil: ADM_T, org: ORG_T, unidade: UNI_T, impersonando: true });
    let { ctx, pagina, erros } = await abrir(browser, { viewport: { width: 1280, height: 900 } });
    let s = secao(pagina);
    await s.getByText(/impersonação: esta tela é só consulta/).waitFor();
    for (const nome of [/Ativar/, /Pausar/, /Revogar/, "Conectar"]) assert.equal(await s.getByRole("button", { name: nome }).count(), 0, String(nome));
    await s.getByRole("tab", { name: /Compartilhamento/ }).click();
    assert.equal(await s.getByRole("button", { name: /Revogar|Aprovar|Propor/ }).count(), 0);
    assert.deepEqual(erros, []);
    await ctx.close();

    sessao.impersonando = false;
    ({ ctx, pagina, erros } = await abrir(browser));
    s = secao(pagina);
    await s.getByRole("button", { name: /Revogar conexão/ }).click();
    const dlg = pagina.locator("dialog.cfg-dialogo");
    await dlg.getByRole("button", { name: "Revogar" }).click();
    assert.match(await dlg.locator("#fdy-motivo-erro").innerText(), /motivo/);
    assert.equal(await dlg.evaluate((d) => d.open), true, "sem motivo o diálogo não fecha");
    await dlg.getByLabel(/Motivo/).fill("encerrando o piloto");
    await dlg.getByRole("button", { name: "Revogar" }).click();
    await s.locator(".pill", { hasText: /^Revogada$/ }).first().waitFor();
    assert.equal(db.tabelas.foody_conexao_destinos[0].estado, "REVOGADO", "revogar a conexão derruba o compartilhamento");
    assert.match(await s.innerText(), /Reconectar com um token novo/);
    assert.deepEqual(erros, []);
    await ctx.close();
  });
});
