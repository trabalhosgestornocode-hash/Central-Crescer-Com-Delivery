// EXPIRAÇÃO DO CONTEXTO da TV em NAVEGADOR REAL contra o BACKEND REAL (createApp + Postgres local descartável).
// O contexto é vencido DE VERDADE no banco (expira_em no passado) e o navegador reage com o app de produção:
// remove o que estava na tela, troca/limpa o token guardado e só reentra se a autenticação e as políticas permitirem.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55420/postgres CHECKLIST_PLAYWRIGHT_PATH=<...>/playwright \
//   CHECKLIST_BROWSER_CHANNEL=chrome node --test test/perfil-exibicao-expiracao-real-pg.test.js     (sem banco/Playwright: PULADO)
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
const ORG = "a0000000-0000-4000-8000-00000000000a"; const UNI = "a1000000-0000-4000-8000-0000000000a1";
const MODULOS = ["dashboard", "products_cmv", "ingredients", "sales", "ifood", "ifood_dashboard", "monthly_bonus", "parser_food_delivery", "inteligencia", "agente_ia"];
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const USUARIOS = new Map();
let banco; let falso; let servidor; let BASE; let browser;

function contaTv(rotulo) {
  const id = randomUUID(); const email = `${rotulo}-${id.slice(0, 6)}@exemplo.test`;
  sql(banco.url, `insert into perfis (id, nome, email) values ('${id}', ${lit(rotulo)}, ${lit(email)});
    insert into perfis_operacionais (id, conta_id, nome) values ('${id}', '${id}', ${lit(rotulo)});
    insert into usuarios_unidades (usuario_id, perfil_id, unidade_id, papel) values ('${id}', '${id}', '${UNI}', 'display_operator');`);
  const jwt = `h.${Buffer.from(JSON.stringify({ sub: id, aal: "aal1", amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) }], jti: randomUUID() })).toString("base64url")}.s`;
  USUARIOS.set(jwt, { id, email });
  return { id, email, jwt };
}
const vencerContexto = (c) => sql(banco.url, `update sessoes_contexto set expira_em = now() - interval '1 minute' where usuario_id = '${c.id}'`);
const vivas = (c) => Number(sql(banco.url, `select count(*) from sessoes_contexto where usuario_id = '${c.id}' and revogada_em is null and expira_em > now()`));
const totalSessoes = (c) => Number(sql(banco.url, `select count(*) from sessoes_contexto where usuario_id = '${c.id}'`));

async function abrirApp(c, { relogio = false } = {}) {
  const contexto = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  contexto.setDefaultTimeout(90_000);   // sob a carga da suíte completa o servidor/navegador ficam lentos: nada de falso negativo por tempo
  await contexto.route((url) => !url.href.startsWith(BASE), (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  const pagina = await contexto.newPage();
  const erros = [];
  pagina.on("pageerror", (e) => erros.push(e.message));
  if (relogio) await pagina.clock.install({ time: Date.now() });
  await pagina.addInitScript(({ jwt, id, email }) => {
    window.__sinais = { signOut: 0 };
    window.__sessao = { access_token: jwt, user: { id, email } };
    const canal = { on() { return canal; }, subscribe(cb) { try { cb?.("SUBSCRIBED"); } catch { /* */ } return canal; }, unsubscribe() {}, send() {} };
    window.supabase = { createClient: () => ({ auth: {
      getSession: async () => ({ data: { session: window.__sessao } }), signOut: async () => { window.__sinais.signOut += 1; window.__sessao = null; return { error: null }; },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getUser: async () => ({ data: { user: window.__sessao?.user ?? null } }) },
    realtime: { setAuth() {}, connect() {}, disconnect() {} }, channel: () => canal, removeChannel: async () => {} }) };
  }, { jwt: c.jwt, id: c.id, email: c.email });
  await pagina.goto(BASE + "/");
  return { pagina, contexto, erros };
}
const esperarEscolhaDeModo = (p) => p.waitForFunction(() => !document.querySelector("#app").hidden && document.querySelector("[data-ckm]"), null, { timeout: 90_000 });
const entrarNaTv = async (p) => { await esperarEscolhaDeModo(p); await p.locator('[data-acao="iniciar-modo"][data-modo="tv"]').click(); await p.locator(".cko--tv").waitFor(); await p.waitForFunction(() => document.querySelector("[data-cko] .cko-selo")); };
const tokenGuardado = (p) => p.evaluate(() => { const o = {}; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); o[k] = sessionStorage.getItem(k); } return Object.values(o).find((v) => typeof v === "string" && v.split(".").length >= 2 && v.length > 40) ?? null; });
const dispararChecagem = (p) => p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

describe("EXPIRAÇÃO do contexto da TV — navegador real × backend real", { skip: PULAR, timeout: 600_000 }, () => {
  before(async () => {
    banco = criarBancoDescartavel("exib_expiracao");
    sql(banco.url, SCHEMA_BASE);
    sql(banco.url, "", { arquivo: join(MIG, "112_papel_operador_exibicao.sql") });
    sql(banco.url, "", { arquivo: join(MIG, "113_papel_exibicao_somente_unidade.sql") });
    sql(banco.url, `
      insert into organizacoes (id, nome) values ('${ORG}', 'Empresa A');
      insert into unidades (id, organizacao_id, nome) values ('${UNI}', '${ORG}', 'Unidade A1');
      insert into organizacao_modulos select '${ORG}'::uuid, m from unnest(array[${MODULOS.map(lit).join(",")}]) m;
      insert into unidade_modulos select '${UNI}'::uuid, m from unnest(array[${MODULOS.map(lit).join(",")}]) m;
      insert into ifood_pedidos (order_id, organizacao_id, unidade_id, display_id, status_oficial, status_oficial_em, order_type, delivery_by, order_created_at, placed_event_created_at, criado_em)
        values ('p1', '${ORG}', '${UNI}', '1111', 'CONFIRMED', now(), 'DELIVERY', 'IFOOD', now(), now(), now());`);
    falso = await iniciarSupabaseFalso({ pgUrl: banco.url, usuarios: USUARIOS });
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

  test("VENCEU com a conta íntegra: remove o painel e os dados, TROCA o token guardado, reentra sozinho, volta à ÁREA DO CHECKLIST e a tela cheia NÃO volta sozinha", async () => {
    const tv = contaTv("tv-venceu");
    const { pagina, contexto, erros } = await abrirApp(tv);
    try {
      await entrarNaTv(pagina);
      const tokenAntigo = await tokenGuardado(pagina);
      assert.ok(tokenAntigo, "há um token de contexto guardado na sessão do navegador");
      assert.equal(vivas(tv), 1);
      vencerContexto(tv); await dispararChecagem(pagina);
      await pagina.waitForFunction(() => !document.querySelector("[data-cko]") && document.querySelector("[data-ckm]"), null, { timeout: 90_000 });
      assert.equal(vivas(tv), 1, "uma sessão NOVA foi criada (a antiga venceu)");
      const tokenNovo = await tokenGuardado(pagina);
      assert.ok(tokenNovo && tokenNovo !== tokenAntigo, "o token antigo foi substituído");
      const estado = await pagina.evaluate(async () => { const { state } = await import("/src/state.js"); return { rota: state.rota, papel: state.sessao.papel, permissoes: state.sessao.permissoes }; });
      assert.deepEqual([estado.rota, estado.papel, estado.permissoes], ["checklist-operacional", "display_operator", ["checklist.visualizar"]]);
      assert.equal(await pagina.evaluate(() => !!document.fullscreenElement), false, "tela cheia exige um novo gesto do usuário");
      assert.equal(await pagina.locator("[data-cko]").count(), 0, "o painel anterior não ficou na página");
      assert.ok(await pagina.locator('[data-acao="iniciar-modo"][data-modo="tv"]').count(), "pronto para escolher o modo");
      assert.deepEqual(erros, []);
    } finally { await contexto.close(); }
  });

  test("VENCEU e a política NEGA a reentrada (vínculo removido / bloqueado / conta bloqueada / empresa bloqueada): nada de dado do Checklist, nenhuma sessão nova, token limpo", async () => {
    const cenarios = [
      ["vínculo removido", (c) => sql(banco.url, `delete from usuarios_unidades where usuario_id = '${c.id}'`), () => {}],
      ["vínculo bloqueado", (c) => sql(banco.url, `update usuarios_unidades set ativo = false where usuario_id = '${c.id}'`), () => {}],
      ["conta bloqueada", (c) => sql(banco.url, `update perfis set ativo = false where id = '${c.id}'`), () => {}],
      ["empresa bloqueada", () => sql(banco.url, `update organizacoes set status = 'bloqueada' where id = '${ORG}'`), () => sql(banco.url, `update organizacoes set status = 'ativa' where id = '${ORG}'`)],
    ];
    for (const [nome, quebrar, desfazer] of cenarios) {
      const tv = contaTv(`tv-nega-${nome.replace(/\s/g, "")}`);
      const { pagina, contexto } = await abrirApp(tv);
      try {
        await entrarNaTv(pagina);
        const antes = totalSessoes(tv);
        quebrar(tv); vencerContexto(tv); await dispararChecagem(pagina);
        await pagina.waitForFunction(() => !document.querySelector("[data-cko]"), null, { timeout: 90_000 });
        await pagina.waitForTimeout(1500);
        assert.equal(vivas(tv), 0, `${nome}: nenhuma sessão viva`);
        assert.equal(totalSessoes(tv), antes, `${nome}: nenhuma sessão nova foi criada`);
        const tela = await pagina.evaluate(() => document.body.innerText);
        assert.doesNotMatch(tela, /Em andamento|Recebidos|#1111/, `${nome}: nenhum dado do Checklist ficou na tela`);
        assert.equal(await pagina.locator("[data-cko]").count(), 0);
        assert.equal(await pagina.evaluate(() => !!document.fullscreenElement), false);
        const estado = await pagina.evaluate(async () => { const { state } = await import("/src/state.js"); return { contexto: !!state.sessao.empresa, token: !!sessionStorage.getItem("contextToken") }; });
        assert.equal(estado.contexto, false, `${nome}: o app não manteve empresa/unidade em memória`);
        assert.equal(estado.token, false, `${nome}: o token de contexto não ficou guardado`);
      } finally { await contexto.close(); desfazer(); }
    }
  });

  test("VENCEU e o LOGIN do Supabase também venceu (401): vai para o login — nada de reentrada sem autenticação", async () => {
    const tv = contaTv("tv-login-venceu");
    const { pagina, contexto } = await abrirApp(tv);
    try {
      await entrarNaTv(pagina);
      USUARIOS.delete(tv.jwt);                      // o Supabase passa a não reconhecer o token (login expirado/revogado)
      vencerContexto(tv); await dispararChecagem(pagina);
      await pagina.waitForFunction(() => !document.querySelector("#login-screen").hidden, null, { timeout: 90_000 });
      assert.equal(await pagina.locator("[data-cko]").count(), 0);
      assert.equal(vivas(tv), 0);
      assert.ok(await pagina.evaluate(() => window.__sinais.signOut) >= 1, "o login local foi encerrado");
    } finally { await contexto.close(); }
  });

  describe("CONTA BLOQUEADA no meio do turno (403 CONTA_INATIVA)", () => {
    test("o backend identifica o caso por código (não por texto) e só ele", async () => {
      const tv = contaTv("tv-codigo");
      const r = await fetch(`${BASE}/api/v1/sessao/perfis`, { headers: { authorization: `Bearer ${tv.jwt}` } });
      assert.equal(r.status, 200);
      sql(banco.url, `update perfis set ativo = false where id = '${tv.id}'`);
      const b = await fetch(`${BASE}/api/v1/sessao/perfis`, { headers: { authorization: `Bearer ${tv.jwt}` } });
      const j = await b.json();
      assert.equal(b.status, 403); assert.equal(j.details?.codigo, "CONTA_INATIVA");
      // falta de permissão comum NÃO carrega esse código
      const ok = contaTv("tv-sem-perm"); const sel = await fetch(`${BASE}/api/v1/sessao/selecionar`, { method: "POST", headers: { authorization: `Bearer ${ok.jwt}`, "content-type": "application/json" }, body: JSON.stringify({ organizacaoId: ORG, unidadeId: UNI }) });
      const ctx = (await sel.json()).data.contextToken;
      const negado = await fetch(`${BASE}/api/v1/produtos`, { headers: { authorization: `Bearer ${ok.jwt}`, "x-context-token": ctx } });
      assert.equal(negado.status, 403); assert.notEqual((await negado.json()).details?.codigo, "CONTA_INATIVA");
    });

    test("DURANTE O POLLING: a TV vai para o login, sai do Modo TV, apaga os dados e o contexto, derruba o login local — e NÃO tenta reentrar", async () => {
      const tv = contaTv("tv-poll-bloq");
      const { pagina, contexto } = await abrirApp(tv);
      try {
        await entrarNaTv(pagina);
        assert.equal(vivas(tv), 1);
        const pedidos = []; pagina.on("request", (rq) => { if (/\/api\/v1\/sessao\/selecionar/.test(rq.url())) pedidos.push(rq.url()); });
        sql(banco.url, `update perfis set ativo = false where id = '${tv.id}'`);
        await dispararChecagem(pagina);
        await pagina.waitForFunction(() => !document.querySelector("#login-screen").hidden, null, { timeout: 90_000 });
        await pagina.waitForTimeout(1500);
        assert.equal(await pagina.locator("[data-cko]").count(), 0, "painel removido");
        assert.doesNotMatch(await pagina.evaluate(() => document.body.innerText), /Em andamento|Recebidos|#1111|Unidade A1/, "nenhum dado operacional na interface");
        const estado = await pagina.evaluate(async () => { const { state } = await import("/src/state.js"); return { empresa: !!state.sessao.empresa, token: !!sessionStorage.getItem("contextToken"), usuario: !!state.sessao.usuario }; });
        assert.deepEqual(estado, { empresa: false, token: false, usuario: false });
        assert.ok(await pagina.evaluate(() => window.__sinais.signOut) >= 1);
        assert.match(await pagina.locator("#login-erro").textContent(), /Usuário inativo/);
        assert.equal(await pagina.evaluate(() => !!document.fullscreenElement), false);
        assert.deepEqual(pedidos, [], "nenhuma tentativa de reentrada (selecionar)");
        // A linha de sessão não é revogada pelo encerramento do navegador (o servidor recusa a conta inativa já no login, até para
        // encerrar); pelo painel, "Bloquear conta" revoga as sessões (testado em perfil-exibicao-interface-real-pg). Aqui vale: INUTILIZÁVEL.
        const antigo = sql(banco.url, `select 1 from sessoes_contexto where usuario_id = '${tv.id}' limit 1`);
        assert.equal(antigo, "1");
        assert.equal((await fetch(`${BASE}/api/v1/checklist-operacional/resumo`, { headers: { authorization: `Bearer ${tv.jwt}` } })).status, 403, "a conta bloqueada não consegue mais nada com o login antigo");
      } finally { await contexto.close(); }
    });

    test("DURANTE A RENOVAÇÃO: o pedido de renovação recebe 403 CONTA_INATIVA → login; nenhum contexto novo; sem laço de pedidos", async () => {
      const tv = contaTv("tv-renov-bloq");
      const { pagina, contexto } = await abrirApp(tv, { relogio: true });
      try {
        await entrarNaTv(pagina);
        const antes = totalSessoes(tv);
        // Só a RENOVAÇÃO pode responder: o polling do painel fica pendente (senão, sob carga, o 403 do polling derruba a TV antes do timer de renovação e o teste mede o caminho errado).
        await pagina.route("**/api/v1/checklist-operacional/resumo", () => {});
        const chamadas = []; pagina.on("request", (rq) => { if (/\/api\/v1\/sessao\/(renovar|selecionar)/.test(rq.url())) chamadas.push(rq.url().split("/api/v1")[1]); });
        sql(banco.url, `update perfis set ativo = false where id = '${tv.id}'`);
        await pagina.clock.fastForward(7 * 3_600_000 + 30 * 60_000);          // chega a hora de renovar (cliente)
        await pagina.waitForFunction(() => !document.querySelector("#login-screen").hidden, null, { timeout: 90_000 });
        await pagina.clock.fastForward(3 * 3_600_000); await pagina.waitForTimeout(500);
        assert.equal(chamadas.filter((c) => c.startsWith("/sessao/renovar")).length, 1, "um único pedido de renovação");
        assert.deepEqual(chamadas.filter((c) => c.startsWith("/sessao/selecionar")), [], "e nenhuma reentrada");
        assert.equal(totalSessoes(tv), antes, "nenhuma sessão nova foi criada");
        assert.equal(await pagina.locator("[data-cko]").count(), 0);
        assert.match(await pagina.locator("#login-erro").textContent(), /Usuário inativo/);
      } finally { await contexto.close(); }
    });
  });
});
