// PAINEL ADMINISTRATIVO do Operador de Exibição em NAVEGADOR REAL contra o BACKEND REAL (createApp + Postgres local
// descartável + "Supabase" local). Nada é simulado no meio: o SuperAdmin clica na interface da Central de verdade e o
// que vale é o que ficou no banco.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55420/postgres \
//   CHECKLIST_PLAYWRIGHT_PATH=<...>/worker-martinbrower/node_modules/playwright CHECKLIST_BROWSER_CHANNEL=chrome \
//   node --test test/perfil-exibicao-interface-real-pg.test.js     (sem banco ou sem Playwright: PULADO)
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { motivoPular, criarBancoDescartavel, sql } from "./helpers/pg-descartavel.js";
import { iniciarSupabaseFalso } from "./helpers/supabase-falso-pg.js";
import { SCHEMA_BASE } from "./helpers/schema-perfil-exibicao.js";

let chromium;
try { ({ chromium } = createRequire(import.meta.url)(process.env.CHECKLIST_PLAYWRIGHT_PATH || process.env.PERFORMANCE_PLAYWRIGHT_PATH || "playwright")); } catch { /* pulado */ }
const PULAR = motivoPular || (!chromium && "Configure CHECKLIST_PLAYWRIGHT_PATH (Playwright) para rodar no navegador");
const CANAL = process.env.CHECKLIST_BROWSER_CHANNEL || process.env.PERFORMANCE_BROWSER_CHANNEL;

const MIG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "database", "migrations");
const ORG_A = "a0000000-0000-4000-8000-00000000000a"; const ORG_B = "b0000000-0000-4000-8000-00000000000b"; const ORG_VAZIA = "c0000000-0000-4000-8000-00000000000c";
const UNI_A1 = "a1000000-0000-4000-8000-0000000000a1"; const UNI_A2 = "a2000000-0000-4000-8000-0000000000a2"; const UNI_B1 = "b1000000-0000-4000-8000-0000000000b1";
const MODULOS = ["dashboard", "products_cmv", "ingredients", "sales", "ifood", "ifood_dashboard", "monthly_bonus", "parser_food_delivery", "inteligencia", "agente_ia"];
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const MSG_UMA_UNIDADE = /uma (única )?unidade/i;

const USUARIOS = new Map(); const authAdmin = [];
let banco; let falso; let servidor; let BASE; let browser;

function conta(rotulo, { superadmin = false } = {}) {
  const id = randomUUID(); const email = `${rotulo}-${id.slice(0, 6)}@exemplo.test`;
  sql(banco.url, `insert into perfis (id, nome, email) values ('${id}', ${lit(rotulo)}, ${lit(email)});
    insert into perfis_operacionais (id, conta_id, nome) values ('${id}', '${id}', ${lit(rotulo)});
    ${superadmin ? `insert into plataforma_admins (usuario_id) values ('${id}');` : ""}`);
  const agoraS = Math.floor(Date.now() / 1000);
  const jwt = `h.${Buffer.from(JSON.stringify({ sub: id, aal: "aal1", amr: [{ method: "password", timestamp: agoraS }], jti: randomUUID() })).toString("base64url")}.s`;
  USUARIOS.set(jwt, { id, email });
  return { id, email, jwt, rotulo };
}
const vUnidade = (c, uni, papel) => sql(banco.url, `insert into usuarios_unidades (usuario_id, perfil_id, unidade_id, papel) values ('${c.id}', '${c.id}', '${uni}', ${papel ? lit(papel) : "null"})`);
const vEmpresa = (c, org, papel) => sql(banco.url, `insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('${c.id}', '${c.id}', '${org}', '${papel}')`);
const linhasUnidade = (c) => JSON.parse(sql(banco.url, `select coalesce(json_agg(json_build_object('unidade', unidade_id, 'papel', papel::text, 'ativo', ativo)), '[]') from usuarios_unidades where usuario_id = '${c.id}'`));
const nEmpresa = (c) => Number(sql(banco.url, `select count(*) from usuarios_organizacoes where usuario_id = '${c.id}'`));
const vivas = (c) => Number(sql(banco.url, `select count(*) from sessoes_contexto where usuario_id = '${c.id}' and revogada_em is null and expira_em > now()`));

async function api(c, metodo, caminho, { ctx, corpo } = {}) {
  const r = await fetch(`${BASE}/api/v1${caminho}`, { method: metodo, headers: { authorization: `Bearer ${c.jwt}`, ...(ctx ? { "x-context-token": ctx } : {}), ...(corpo !== undefined ? { "content-type": "application/json" } : {}) }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text(); let json = null; try { json = JSON.parse(texto); } catch { /* */ }
  return { status: r.status, json, texto };
}
const entrar = async (c, org = ORG_A, uni = UNI_A1) => { const r = await api(c, "POST", "/sessao/selecionar", { corpo: { organizacaoId: org, unidadeId: uni } }); return r; };

/** Abre a Central REAL (servida pelo backend) logada como `c`, com o Supabase do navegador substituído por uma stub que devolve o JWT dele. */
async function abrirApp(c) {
  const contexto = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  contexto.setDefaultTimeout(90_000);   // sob a carga da suíte completa o servidor/navegador ficam lentos: nada de falso negativo por tempo
  await contexto.route((url) => !url.href.startsWith(BASE), (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  const pagina = await contexto.newPage();
  const erros = []; const dialogos = [];
  pagina.on("pageerror", (e) => erros.push(e.message));
  pagina.on("dialog", async (d) => { dialogos.push(d.message()); await d.accept(); });
  await pagina.addInitScript(({ jwt, id, email }) => {
    window.__sessao = { access_token: jwt, user: { id, email } };
    const canal = { on() { return canal; }, subscribe(cb) { try { cb?.("SUBSCRIBED"); } catch { /* */ } return canal; }, unsubscribe() {}, send() {} };
    window.supabase = { createClient: () => ({ auth: {
      getSession: async () => ({ data: { session: window.__sessao } }), signOut: async () => { window.__sessao = null; return { error: null }; },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getUser: async () => ({ data: { user: window.__sessao?.user ?? null } }) },
    realtime: { setAuth() {}, connect() {}, disconnect() {} }, channel: () => canal, removeChannel: async () => {} }) };
  }, { jwt: c.jwt, id: c.id, email: c.email });
  await pagina.goto(BASE + "/");
  return { pagina, contexto, erros, dialogos };
}
async function abrirUsuarios(pagina) {
  await pagina.waitForFunction(() => !document.querySelector("#admin").hidden);
  await pagina.locator('#adm-menu li[data-tela="usuarios"]').click();
  await pagina.locator('[data-adm-acao="usuario-novo"]').waitFor();
}
async function abrirDetalhe(pagina, c) {
  await pagina.locator(`[data-adm-acao="usuario-ver"][data-id="${c.id}"]`).click();
  await pagina.locator(`[data-adm-acao="usuario-exibicao"]`).waitFor();
}
/** Espera (polling) um EFEITO no banco: sob a carga da suíte completa o servidor demora; nada de espera fixa. */
const aguardar = async (cond, motivo, ms = 45_000) => { const fim = Date.now() + ms; for (;;) { try { if (await cond()) return; } catch { /* tenta de novo */ } if (Date.now() > fim) throw new Error(`tempo esgotado esperando: ${motivo}`); await new Promise((r) => setTimeout(r, 250)); } };
const modalAberto = (pagina) => pagina.evaluate(() => !document.querySelector("#adm-modal").hidden);
const textoErro = (pagina) => pagina.locator("#adm-modal-erro").textContent();

describe("PAINEL ADMIN do Operador de Exibição — navegador real × backend real", { skip: PULAR, timeout: 900_000 }, () => {
  before(async () => {
    banco = criarBancoDescartavel("exib_interface");
    sql(banco.url, SCHEMA_BASE);
    sql(banco.url, "", { arquivo: join(MIG, "112_papel_operador_exibicao.sql") });
    sql(banco.url, "", { arquivo: join(MIG, "113_papel_exibicao_somente_unidade.sql") });
    sql(banco.url, `
      insert into organizacoes (id, nome) values ('${ORG_A}', 'Empresa A'), ('${ORG_B}', 'Empresa B'), ('${ORG_VAZIA}', 'Empresa Sem Unidade');
      insert into unidades (id, organizacao_id, nome) values ('${UNI_A1}', '${ORG_A}', 'Unidade A1'), ('${UNI_A2}', '${ORG_A}', 'Unidade A2'), ('${UNI_B1}', '${ORG_B}', 'Unidade B1');
      insert into organizacao_modulos select o, m from unnest(array['${ORG_A}'::uuid, '${ORG_B}'::uuid]) o, unnest(array[${MODULOS.map(lit).join(",")}]) m;
      insert into unidade_modulos select u, m from unnest(array['${UNI_A1}'::uuid, '${UNI_A2}'::uuid, '${UNI_B1}'::uuid]) u, unnest(array[${MODULOS.map(lit).join(",")}]) m;`);
    falso = await iniciarSupabaseFalso({ pgUrl: banco.url, usuarios: USUARIOS, aoAuthAdmin: (e) => authAdmin.push(e) });
    Object.assign(process.env, {
      SUPABASE_URL: falso.url, SUPABASE_SERVICE_ROLE_KEY: "chave-service-role-de-teste-".padEnd(48, "z"), SUPABASE_ANON_KEY: "chave-anon-de-teste-".padEnd(48, "a"),
      CONTEXT_TOKEN_SECRET: "segredo-do-token-de-contexto-de-teste-".padEnd(64, "k"), NODE_ENV: "test",
      RATE_LIMIT_API_MAX: "1000000", RATE_LIMIT_CONTEXTO_MAX: "1000000",
    });
    const { createApp } = await import("../src/app.js");
    servidor = await new Promise((r) => { const s = http.createServer(createApp()).listen(0, "127.0.0.1", () => r(s)); });
    servidor.unref();
    BASE = `http://127.0.0.1:${servidor.address().port}`;
    browser = await chromium.launch({ headless: true, ...(CANAL ? { channel: CANAL } : {}) });
  });
  after(async () => { await browser?.close(); if (servidor) await new Promise((r) => servidor.close(r)); await falso?.parar(); banco?.derrubar(); });

  test("DIAGNÓSTICO: a API do painel responde para o SuperAdmin (listas que a tela Usuários carrega)", async () => {
    const adm = conta("super-diag", { superadmin: true });
    for (const c of ["/plataforma/usuarios", "/plataforma/empresas", "/plataforma/usuarios/papeis"]) {
      const r = await api(adm, "GET", c); assert.equal(r.status, 200, `${c} -> ${r.status} ${r.texto.slice(0, 300)}`);
    }
  });

  test("CRIAR o acesso: escolhe empresa e unidade pela interface; fica SÓ vínculo de unidade com o papel; sem vínculo de empresa; detalhe mostra o papel fixo", async () => {
    const adm = conta("super-criar", { superadmin: true }); const tv = conta("tv-criar");
    const { pagina, contexto, erros } = await abrirApp(adm);
    try {
      await abrirUsuarios(pagina); await abrirDetalhe(pagina, tv);
      await pagina.locator('[data-adm-acao="usuario-exibicao"]').click();
      await pagina.locator("#ex-empresa").waitFor();
      assert.match(await pagina.locator("#adm-modal-body").textContent(), /somente o Checklist Operacional/);
      await pagina.selectOption("#ex-empresa", ORG_A);
      await pagina.waitForFunction(() => document.querySelectorAll("#ex-unidade option").length === 2);
      await pagina.selectOption("#ex-unidade", UNI_A1);
      await pagina.locator("#adm-modal-ok").click();
      await pagina.waitForFunction(() => document.querySelector("#adm-modal").hidden);
      assert.deepEqual(linhasUnidade(tv), [{ unidade: UNI_A1, papel: "display_operator", ativo: true }]);
      assert.equal(nEmpresa(tv), 0, "nenhum vínculo de empresa foi criado");
      // O detalhe recarregado mostra o papel como rótulo fixo, SEM seletor com as opções de empresa (defeito achado no 6B.1)
      await abrirDetalhe(pagina, tv).catch(() => {});
      await pagina.locator(`[data-papel-fixo="display_operator"]`).waitFor();
      assert.equal(await pagina.locator('[data-adm-acao="vinculo-unidade-papel"]').count(), 0, "sem seletor de papel para a conta de exibição");
      // e a conta realmente consegue entrar só no Checklist
      const r = await entrar(tv); assert.equal(r.status, 201, r.texto);
      assert.deepEqual([r.json.data.papel, r.json.data.permissoes], ["display_operator", ["checklist.visualizar"]]);
      assert.deepEqual(erros, []);
    } finally { await contexto.close(); }
  });

  test("OUTRA EMPRESA/UNIDADE: a lista de unidades acompanha a empresa escolhida (nunca mistura); empresa sem unidade bloqueia com mensagem; a API recusa unidade de outra empresa", async () => {
    const adm = conta("super-outra", { superadmin: true }); const tv = conta("tv-outra");
    const { pagina, contexto } = await abrirApp(adm);
    try {
      await abrirUsuarios(pagina); await abrirDetalhe(pagina, tv);
      await pagina.locator('[data-adm-acao="usuario-exibicao"]').click(); await pagina.locator("#ex-empresa").waitFor();
      // Escolhe a empresa e ESPERA a lista de unidades ficar exatamente igual à esperada (a atualização é assíncrona).
      const unidadesDe = async (org, esperado) => {
        await pagina.selectOption("#ex-empresa", org);
        await pagina.waitForFunction((e) => [...document.querySelectorAll("#ex-unidade option")].map((o) => o.textContent.trim()).sort().join("|") === e.join("|"), esperado, { timeout: 10_000 });
        return pagina.evaluate(() => [...document.querySelectorAll("#ex-unidade option")].map((o) => o.textContent.trim()).sort());
      };
      assert.deepEqual(await unidadesDe(ORG_B, ["Unidade B1"]), ["Unidade B1"]);
      assert.deepEqual(await unidadesDe(ORG_A, ["Unidade A1", "Unidade A2"]), ["Unidade A1", "Unidade A2"]);
      assert.deepEqual(await unidadesDe(ORG_VAZIA, ["Nenhuma unidade nesta empresa"]), ["Nenhuma unidade nesta empresa"]);
      await pagina.locator("#adm-modal-ok").click();
      await pagina.locator("#adm-modal-erro").waitFor();
      assert.match(await textoErro(pagina), /Selecione uma unidade/);
      assert.equal(await modalAberto(pagina), true, "o modal fica aberto com o erro à vista");
      assert.equal(await pagina.locator("#adm-modal-ok").isDisabled(), false, "o botão volta a ficar utilizável");
      assert.deepEqual(linhasUnidade(tv), []);
    } finally { await contexto.close(); }
    // Direto na API (sem a interface): unidade inexistente / empresa errada não cria nada.
    for (const unidadeId of [randomUUID(), "00000000-0000-0000-0000-000000000000"]) {
      const r = await api(adm, "POST", `/plataforma/usuarios/${tv.id}/unidades`, { corpo: { unidadeId, papel: "display_operator" } });
      assert.ok([400, 404, 409, 422].includes(r.status), `${r.status} ${r.texto}`);
    }
    assert.deepEqual(linhasUnidade(tv), []);
  });

  test("NÃO ACUMULA: conta com vínculo de empresa não vira exibição; conta de exibição não ganha 2ª unidade, nem empresa, nem outro cargo — pela interface e pela API", async () => {
    const adm = conta("super-acumula", { superadmin: true });
    const comEmpresa = conta("ja-tem-empresa"); vEmpresa(comEmpresa, ORG_A, "viewer");
    const tv = conta("tv-acumula"); vUnidade(tv, UNI_A1, "display_operator");
    const { pagina, contexto } = await abrirApp(adm);
    try {
      await abrirUsuarios(pagina);
      // (a) conta que já tem empresa
      await abrirDetalhe(pagina, comEmpresa);
      await pagina.locator('[data-adm-acao="usuario-exibicao"]').click(); await pagina.locator("#ex-empresa").waitFor();
      await pagina.selectOption("#ex-empresa", ORG_A); await pagina.selectOption("#ex-unidade", UNI_A2);
      await pagina.locator("#adm-modal-ok").click(); await pagina.locator("#adm-modal-erro").waitFor();
      assert.match(await textoErro(pagina), /exclusiv|própria|conta/i);
      assert.deepEqual(linhasUnidade(comEmpresa), [], "nada gravado"); assert.equal(nEmpresa(comEmpresa), 1);
      await pagina.locator("#adm-modal button[data-fechar-modal]").first().click();
      // (b) conta de exibição tentando uma SEGUNDA unidade
      await pagina.locator("#adm-btn-menu, #adm-refresh").first().isVisible().catch(() => {});
      await pagina.locator('#adm-menu li[data-tela="usuarios"]').click(); await pagina.locator('[data-adm-acao="usuario-novo"]').waitFor();
      await abrirDetalhe(pagina, tv);
      await pagina.locator('[data-adm-acao="usuario-exibicao"]').click(); await pagina.locator("#ex-empresa").waitFor();
      await pagina.selectOption("#ex-empresa", ORG_A); await pagina.selectOption("#ex-unidade", UNI_A2);
      await pagina.locator("#adm-modal-ok").click(); await pagina.locator("#adm-modal-erro").waitFor();
      assert.match(await textoErro(pagina), MSG_UMA_UNIDADE);
      assert.equal(linhasUnidade(tv).length, 1);
    } finally { await contexto.close(); }
    // (c) pela API: empresa, outro cargo em unidade, lote de empresas, e a mudança do cargo da unidade de exibição
    const casos = [
      ["POST", `/plataforma/usuarios/${tv.id}/empresas`, { organizacaoId: ORG_A, papel: "viewer" }],
      ["POST", `/plataforma/usuarios/${tv.id}/unidades`, { unidadeId: UNI_A2, papel: "viewer" }],
      ["POST", `/plataforma/usuarios/${tv.id}/unidades`, { unidadeId: UNI_A2, papel: "display_operator" }],
      ["POST", `/plataforma/usuarios/${comEmpresa.id}/unidades`, { unidadeId: UNI_A2, papel: "display_operator" }],
      ["PATCH", `/plataforma/usuarios/${comEmpresa.id}/empresas/${ORG_A}`, { papel: "display_operator" }],
      ["POST", `/plataforma/usuarios/${comEmpresa.id}/empresas`, { organizacaoId: ORG_B, papel: "display_operator" }],
    ];
    for (const [metodo, caminho, corpo] of casos) {
      const r = await api(adm, metodo, caminho, { corpo });
      assert.ok([400, 404, 409, 422].includes(r.status), `${metodo} ${caminho} ${JSON.stringify(corpo)} -> ${r.status} ${r.texto}`);
    }
    assert.deepEqual(linhasUnidade(tv), [{ unidade: UNI_A1, papel: "display_operator", ativo: true }]);
    // Trocar o cargo da conta de exibição (sem vínculo de empresa) é "reaproveitar" a conta — não é acúmulo: o backend
    // permite, o papel muda por inteiro e as sessões abertas caem. Voltar a exibição também funciona (a conta segue exclusiva).
    const vira = await api(adm, "PATCH", `/plataforma/usuarios/${tv.id}/unidades/${UNI_A1}`, { corpo: { papel: "unit_manager" } });
    assert.equal(vira.status, 200, vira.texto); assert.equal(linhasUnidade(tv)[0].papel, "unit_manager");
    const volta = await api(adm, "PATCH", `/plataforma/usuarios/${tv.id}/unidades/${UNI_A1}`, { corpo: { papel: "display_operator" } });
    assert.equal(volta.status, 200, volta.texto);
    assert.equal(nEmpresa(tv), 0); assert.equal(nEmpresa(comEmpresa), 1);
    assert.equal(sql(banco.url, `select papel::text from usuarios_organizacoes where usuario_id = '${comEmpresa.id}'`), "viewer");
  });

  test("CARREGANDO e ERRO DE REDE/SERVIDOR: botão trava em 'Aguarde…' enquanto a chamada está em andamento; com 500 o erro aparece e dá para tentar de novo", async () => {
    const adm = conta("super-carga", { superadmin: true }); const tv = conta("tv-carga");
    const { pagina, contexto } = await abrirApp(adm);
    try {
      await abrirUsuarios(pagina); await abrirDetalhe(pagina, tv);
      await pagina.locator('[data-adm-acao="usuario-exibicao"]').click(); await pagina.locator("#ex-empresa").waitFor();
      await pagina.selectOption("#ex-empresa", ORG_A); await pagina.selectOption("#ex-unidade", UNI_A1);
      let modo = "lento";
      await pagina.route(`**/api/v1/plataforma/usuarios/${tv.id}/unidades`, async (rota) => {
        if (rota.request().method() !== "POST") return rota.continue();
        if (modo === "lento") { await new Promise((r) => setTimeout(r, 1500)); modo = "erro500"; return rota.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Erro interno de teste." }) }); }
        if (modo === "erro500") { modo = "rede"; return rota.abort("connectionreset"); }
        return rota.continue();
      });
      await pagina.locator("#adm-modal-ok").click();
      assert.equal(await pagina.locator("#adm-modal-ok").textContent(), "Aguarde…");
      assert.equal(await pagina.locator("#adm-modal-ok").isDisabled(), true, "não dá para clicar duas vezes");
      await pagina.locator("#adm-modal-erro").waitFor(); assert.match(await textoErro(pagina), /Erro interno de teste/);
      assert.equal(await pagina.locator("#adm-modal-ok").textContent(), "Criar acesso de exibição", "texto original de volta");
      await pagina.locator("#adm-modal-ok").click();                      // segunda tentativa: queda de rede
      await pagina.waitForFunction(() => !document.querySelector("#adm-modal-ok").disabled);
      assert.equal(await modalAberto(pagina), true); assert.ok((await textoErro(pagina)).length > 0);
      assert.deepEqual(linhasUnidade(tv), [], "nenhuma das tentativas falhas gravou");
      await pagina.locator("#adm-modal-ok").click();                      // terceira: passa
      await pagina.waitForFunction(() => document.querySelector("#adm-modal").hidden);
      assert.equal(linhasUnidade(tv).length, 1);
    } finally { await contexto.close(); }
  });

  test("REVOGAÇÃO pelos recursos existentes: Forçar logout, Bloquear/Liberar/Remover o vínculo da unidade e Bloquear conta — cada um tem efeito real no acesso da TV", async () => {
    const adm = conta("super-revoga", { superadmin: true }); const tv = conta("tv-revoga"); vUnidade(tv, UNI_A1, "display_operator");
    const { pagina, contexto, dialogos } = await abrirApp(adm);
    try {
      await abrirUsuarios(pagina);
      const detalhe = async () => { await pagina.locator('#adm-menu li[data-tela="usuarios"]').click(); await pagina.locator('[data-adm-acao="usuario-novo"]').waitFor(); await abrirDetalhe(pagina, tv); };
      const fechar = async () => { await pagina.waitForTimeout(400); if (await modalAberto(pagina)) await pagina.locator("#adm-modal button[data-fechar-modal]").first().click(); };
      // 1) Forçar logout: a sessão viva cai e o login Supabase é encerrado (admin logout)
      let r = await entrar(tv); assert.equal(r.status, 201); const ctx = r.json.data.contextToken;
      assert.equal(vivas(tv), 1);
      await detalhe(); await pagina.locator('[data-adm-acao="usuario-logout"]').click();
      await aguardar(() => vivas(tv) === 0, "Forçar logout encerrar a sessão");
      assert.equal(vivas(tv), 0, "sessão encerrada na hora");
      assert.equal((await api(tv, "GET", "/checklist-operacional/resumo", { ctx })).status, 409, "o Checklist da TV recusa o contexto revogado");
      assert.ok(authAdmin.some((e) => e.acao === "logout" && e.id === tv.id), "o login Supabase também foi derrubado");
      assert.ok(dialogos.some((d) => /Forçar logout/.test(d)), "pediu confirmação");
      await fechar();
      // 2) Bloquear o vínculo da unidade: a TV não reentra; Liberar: volta
      await detalhe(); await pagina.locator('[data-adm-acao="vinculo-unidade-toggle"]').click();
      await aguardar(() => linhasUnidade(tv)[0].ativo === false, "vínculo bloqueado");
      assert.equal(linhasUnidade(tv)[0].ativo, false);
      assert.equal((await entrar(tv)).status, 403, "vínculo bloqueado: a TV não entra");
      await fechar(); await detalhe();
      assert.match(await pagina.locator('[data-adm-acao="vinculo-unidade-toggle"]').textContent(), /Liberar/);
      await pagina.locator('[data-adm-acao="vinculo-unidade-toggle"]').click();
      await aguardar(() => linhasUnidade(tv)[0].ativo === true, "vínculo liberado");
      assert.equal(linhasUnidade(tv)[0].ativo, true);
      r = await entrar(tv); assert.equal(r.status, 201, "liberado: a TV volta a entrar");
      // 3) Bloquear a CONTA: derruba as sessões e impede a entrada
      await fechar(); await detalhe(); await pagina.locator('[data-adm-acao="usuario-toggle"]').click();
      await aguardar(() => sql(banco.url, `select ativo from perfis where id = '${tv.id}'`) === "f", "conta bloqueada");
      assert.equal(sql(banco.url, `select ativo from perfis where id = '${tv.id}'`), "f");
      await aguardar(() => vivas(tv) === 0, "sessões derrubadas ao bloquear a conta");
      assert.equal(vivas(tv), 0);
      assert.notEqual((await entrar(tv)).status, 201, "conta bloqueada não entra");
      await fechar(); await detalhe(); await pagina.locator('[data-adm-acao="usuario-toggle"]').click();
      await aguardar(() => sql(banco.url, `select ativo from perfis where id = '${tv.id}'`) === "t", "conta reativada");
      assert.equal(sql(banco.url, `select ativo from perfis where id = '${tv.id}'`), "t");
      // 4) Remover o vínculo: a conta continua existindo, mas não entra em lugar nenhum
      await fechar(); await detalhe(); await pagina.locator('[data-adm-acao="vinculo-unidade-remover"]').click();
      await aguardar(() => linhasUnidade(tv).length === 0, "vínculo removido");
      assert.deepEqual(linhasUnidade(tv), []);
      assert.equal(sql(banco.url, `select count(*) from perfis where id = '${tv.id}'`), "1");
      assert.equal((await entrar(tv)).status, 403);
      assert.ok(dialogos.some((d) => /Remover o acesso à unidade/.test(d)));
    } finally { await contexto.close(); }
  });

  test("GESTOR SEM PERMISSÃO de administrar usuários: não vê o painel, a API da plataforma recusa tudo e o tenant não deixa criar/atribuir o papel de exibição", async () => {
    const gestor = conta("gestor-sem-admin"); vEmpresa(gestor, ORG_A, "unit_manager");
    const orgAdmin = conta("org-admin"); vEmpresa(orgAdmin, ORG_A, "organization_admin");
    const tv = conta("tv-alvo"); vUnidade(tv, UNI_A1, "display_operator");
    // (a) interface: o gestor cai na Central normal e NÃO tem painel de administração
    const { pagina, contexto } = await abrirApp(gestor);
    try {
      await pagina.waitForFunction(() => !document.querySelector("#app").hidden || !document.querySelector("#selecao")?.hidden, null, { timeout: 60_000 });
      assert.equal(await pagina.evaluate(() => document.querySelector("#admin").hidden), true, "painel SuperAdmin escondido");
      assert.equal(await pagina.evaluate(() => document.querySelector("#um-painel")?.hidden ?? true), true, "sem atalho para o painel");
    } finally { await contexto.close(); }
    // (b) API da plataforma: nada abre para quem não é superadmin (gestor nem administrador da empresa)
    for (const quem of [gestor, orgAdmin]) {
      const lista = await api(quem, "GET", "/plataforma/usuarios"); assert.equal(lista.status, 403, `${quem.rotulo} ${lista.status}`);
      const criar = await api(quem, "POST", `/plataforma/usuarios/${gestor.id}/unidades`, { corpo: { unidadeId: UNI_A2, papel: "display_operator" } });
      assert.equal(criar.status, 403);
    }
    // (c) tenant (administrador da empresa COM permissão de gerenciar usuários): não cria nem atribui o papel de exibição
    const sel = await entrar(orgAdmin); assert.equal(sel.status, 201, sel.texto); const ctx = sel.json.data.contextToken;
    const novo = await api(orgAdmin, "POST", "/usuarios", { ctx, corpo: { email: `novo-${randomUUID().slice(0, 6)}@exemplo.test`, nome: "Novo", senha: "SenhaForte#123", papel: "display_operator" } });
    assert.ok([400, 403, 409, 422].includes(novo.status), `${novo.status} ${novo.texto}`);
    const muda = await api(orgAdmin, "PATCH", `/usuarios/${gestor.id}`, { ctx, corpo: { papel: "display_operator" } });
    assert.ok([400, 403, 404, 409, 422].includes(muda.status), `${muda.status} ${muda.texto}`);
    assert.equal(sql(banco.url, `select papel::text from usuarios_organizacoes where usuario_id = '${gestor.id}'`), "unit_manager", "o cargo do gestor não mudou");
    assert.equal(Number(sql(banco.url, "select count(*) from usuarios_organizacoes where papel::text = 'display_operator'")), 0, "nenhum vínculo de EMPRESA com o papel de exibição existe no banco");
    // (d) a própria conta de exibição não administra nada
    const rTv = await entrar(tv); assert.equal(rTv.status, 201);
    for (const [m, c] of [["GET", "/usuarios"], ["GET", "/usuarios/papeis"], ["GET", "/plataforma/usuarios"]]) {
      const r = await api(tv, m, c, { ctx: rTv.json.data.contextToken }); assert.ok([401, 403].includes(r.status), `${c} -> ${r.status}`);
    }
  });

  test("AVISO 'sem empresa': a conta de exibição (só unidade) NÃO é contada nem tratada como pendente; a conta realmente sem empresa continua sendo", async () => {
    const adm = conta("super-aviso", { superadmin: true });
    const tvA = conta("tv-aviso-a"); vUnidade(tvA, UNI_A1, "display_operator");
    const semEmp = conta("sem-empresa-aviso");                        // sem nenhum vínculo: pendente de verdade
    const comEmp = conta("com-empresa-aviso"); vEmpresa(comEmp, ORG_A, "viewer");
    const soUnidade = conta("so-unidade-aviso"); vUnidade(soUnidade, UNI_A1, "viewer");   // só unidade, NÃO exibição: segue pendente
    // API: a fila "sem empresa" não inclui a conta de exibição; a lista completa marca contaExibicao
    const fila = await api(adm, "GET", "/plataforma/usuarios?semEmpresa=true");
    const ids = fila.json.data.map((u) => u.id);
    assert.ok(ids.includes(semEmp.id) && ids.includes(soUnidade.id), "pendentes de verdade continuam na fila");
    assert.ok(!ids.includes(tvA.id) && !ids.includes(comEmp.id));
    const todos = (await api(adm, "GET", "/plataforma/usuarios")).json.data;
    assert.equal(todos.find((u) => u.id === tvA.id).contaExibicao, true);
    for (const u of [semEmp, comEmp, soUnidade]) assert.equal(todos.find((x) => x.id === u.id).contaExibicao, false);
    // Interface: o aviso conta só os pendentes e a conta de exibição aparece com a etiqueta própria
    const pendentes = todos.filter((u) => !u.empresas.some((e) => e.ativo) && !u.superadmin && !u.contaExibicao).length;
    const { pagina, contexto } = await abrirApp(adm);
    try {
      await abrirUsuarios(pagina);
      const aviso = await pagina.locator(".adm-aviso b").first().textContent();
      assert.ok(aviso.startsWith(`${pendentes} usuário(s) sem empresa`), aviso);
      const linha = pagina.locator("tr", { has: pagina.locator(`[data-adm-acao="usuario-ver"][data-id="${tvA.id}"]`) });
      assert.match(await linha.textContent(), /Exibição \(TV\)/);
      assert.doesNotMatch(await linha.textContent(), /nenhuma/);
      const linhaSem = pagina.locator("tr", { has: pagina.locator(`[data-adm-acao="usuario-ver"][data-id="${semEmp.id}"]`) });
      assert.match(await linhaSem.textContent(), /nenhuma/, "demais usuários: comportamento preservado");
    } finally { await contexto.close(); }
  });
});
