// Checkpoint 6B.2 — (a) EXPEDIENTE 11h–04h (17 h) em duas situações de autenticação e (b) DUAS ABAS renovando ao mesmo tempo,
// pela cadeia real (createApp + Postgres local descartável + "Supabase" local) e em navegador real.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55420/postgres \
//   CHECKLIST_PLAYWRIGHT_PATH=<...>/playwright CHECKLIST_BROWSER_CHANNEL=chrome \
//   node --test test/renovacao-exibicao-expediente-abas-real-pg.test.js     (sem banco: PULADO; sem Playwright só o bloco de abas é pulado)
//
// Tempo SIMULADO: a cada passo os prazos das sessões recuam no banco e o carimbo de autenticação do JWT (amr[].timestamp)
// recua junto; o servidor usa o relógio real. O limite absoluto é de 20 h desde a AUTENTICAÇÃO — nunca desde o início do turno.
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
try { ({ chromium } = createRequire(import.meta.url)(process.env.CHECKLIST_PLAYWRIGHT_PATH || process.env.PERFORMANCE_PLAYWRIGHT_PATH || "playwright")); } catch { /* sem navegador */ }
const SEM_NAVEGADOR = !chromium && "Configure CHECKLIST_PLAYWRIGHT_PATH (Playwright) para rodar no navegador";
const CANAL = process.env.CHECKLIST_BROWSER_CHANNEL || process.env.PERFORMANCE_BROWSER_CHANNEL;

const MIG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "database", "migrations");
const ORG = "a0000000-0000-4000-8000-00000000000a"; const UNI = "a1000000-0000-4000-8000-0000000000a1";
const MODULOS = ["dashboard", "products_cmv", "ingredients", "sales", "ifood", "ifood_dashboard", "monthly_bonus", "parser_food_delivery", "inteligencia", "agente_ia"];
const H = 3_600_000; const MIN = 60_000;
/** Polling de um EFEITO (banco/página): sob a carga da suíte completa nada de espera fixa. */
const aguardar = async (cond, motivo, ms = 60_000) => { const fim = Date.now() + ms; for (;;) { try { if (await cond()) return; } catch { /* tenta de novo */ } if (Date.now() > fim) throw new Error(`tempo esgotado esperando: ${motivo}`); await new Promise((r) => setTimeout(r, 300)); } };
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const USUARIOS = new Map();
let banco; let falso; let servidor; let BASE; let browser;

function contaTv(rotulo) {
  const id = randomUUID(); const email = `${rotulo}-${id.slice(0, 6)}@exemplo.test`;
  sql(banco.url, `insert into perfis (id, nome, email) values ('${id}', ${lit(rotulo)}, ${lit(email)});
    insert into perfis_operacionais (id, conta_id, nome) values ('${id}', '${id}', ${lit(rotulo)});
    insert into usuarios_unidades (usuario_id, perfil_id, unidade_id, papel) values ('${id}', '${id}', '${UNI}', 'display_operator');`);
  return { id, email };
}
/** JWT cujo carimbo de autenticação foi `autenticadoHa` ms atrás (no tempo SIMULADO). */
function jwtDe(c, autenticadoHa = 0) {
  const agoraS = Math.floor(Date.now() / 1000);
  const jwt = `h.${Buffer.from(JSON.stringify({ sub: c.id, aal: "aal1", amr: [{ method: "password", timestamp: agoraS - Math.floor(autenticadoHa / 1000) }], jti: randomUUID() })).toString("base64url")}.s`;
  USUARIOS.set(jwt, { id: c.id, email: c.email });
  return jwt;
}
async function api(jwt, metodo, caminho, { ctx, corpo } = {}) {
  const r = await fetch(`${BASE}/api/v1${caminho}`, { method: metodo, headers: { authorization: `Bearer ${jwt}`, ...(ctx ? { "x-context-token": ctx } : {}), ...(corpo !== undefined ? { "content-type": "application/json" } : {}) }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text(); let json = null; try { json = JSON.parse(texto); } catch { /* */ }
  return { status: r.status, json, texto };
}
const selecionar = (jwt) => api(jwt, "POST", "/sessao/selecionar", { corpo: { organizacaoId: ORG, unidadeId: UNI } });
const envelhecer = (c, ms) => sql(banco.url, `update sessoes_contexto set expira_em = expira_em - interval '${Math.round(ms)} milliseconds', criada_em = criada_em - interval '${Math.round(ms)} milliseconds' where usuario_id = '${c.id}'`);
const vivas = (c) => JSON.parse(sql(banco.url, `select coalesce(json_agg(json_build_object('id', id, 'papel', papel::text, 'permissoes', permissoes)), '[]') from sessoes_contexto where usuario_id = '${c.id}' and revogada_em is null and expira_em > now()`));

/**
 * Simula um turno. `authAntesDoTurno` = há quanto tempo a conta autenticou QUANDO o turno começa (11h).
 * A cada passo de 30 min: polling; se o prazo do contexto está a ≤ 1 h, pede renovação (como o navegador faz).
 * Quando o contexto cai (limite absoluto), tenta reentrar com o login vigente; sem login mais novo, o turno PARA.
 * `reautenticaEm` (horas do turno) simula alguém entrando de novo (login novo) a partir daquele momento.
 */
async function simularTurno(c, { authAntesDoTurno, duracao = 17 * H, reautenticaEm = null }) {
  const PASSO = 30 * MIN; let e = 0; let authEm = -authAntesDoTurno; const eventos = []; let cobertoAte = null; let ctx = null;
  const jwt = () => jwtDe(c, e - authEm);
  const entrar = async () => { const r = await selecionar(jwt()); return r.status === 201 ? r : r; };
  let r = await entrar();
  if (r.status !== 201) return { eventos: [`inicio:${r.status}`], cobertoAte: 0, renovacoes: 0, motivoParada: `inicio ${r.status}` };
  ctx = r.json.data.contextToken; let renovacoes = 0; cobertoAte = 0; let parada = null;
  while (e < duracao) {
    envelhecer(c, PASSO); e += PASSO;
    if (reautenticaEm !== null && e >= reautenticaEm && authEm < reautenticaEm) authEm = reautenticaEm;   // login novo no instante `reautenticaEm`
    const poll = await api(jwt(), "GET", "/checklist-operacional/resumo", { ctx });
    if (poll.status === 200) {
      cobertoAte = e;
      const atual = await api(jwt(), "GET", "/sessao/atual", { ctx });
      if (Date.parse(atual.json.data.expiraEm) - Date.parse(atual.json.data.servidorEm) <= H) {
        const rr = await api(jwt(), "POST", "/sessao/renovar", { ctx });
        if (rr.status === 201) { ctx = rr.json.data.contextToken; renovacoes += 1; eventos.push(`renovou@${e / H}h`); }
        else { eventos.push(`renovacao-negada@${e / H}h:${rr.status}:${rr.json?.details?.codigo ?? ""}`); }
      }
      continue;
    }
    // contexto caiu (limite absoluto): a Central tenta reentrar com o login que tem
    eventos.push(`contexto-caiu@${e / H}h:${poll.status}`);
    const re = await selecionar(jwt());
    if (re.status === 201) { ctx = re.json.data.contextToken; eventos.push(`reentrou@${e / H}h`); cobertoAte = e; parada = null; continue; }
    parada = `${re.status}:${re.json?.details?.codigo ?? ""}`; eventos.push(`reentrada-negada@${e / H}h:${parada}`);
    if (reautenticaEm !== null && e < reautenticaEm) continue;   // a TV fica no login até alguém autenticar de novo
    break;
  }
  return { eventos, cobertoAte, renovacoes, motivoParada: parada, fimDoTurno: e >= duracao };
}

describe("EXPEDIENTE 11h–04h (17 h): limite absoluto de 20 h desde a AUTENTICAÇÃO", { skip: motivoPular, timeout: 900_000, concurrency: 1 }, () => {
  before(async () => {
    banco = criarBancoDescartavel("exib_expediente");
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
      RATE_LIMIT_API_MAX: "1000000", RATE_LIMIT_CONTEXTO_MAX: "1000000", RATE_LIMIT_RENOVAR_MAX: "1000000",
    });
    const { createApp } = await import("../src/app.js");
    servidor = await new Promise((r) => { const s = http.createServer(createApp()).listen(0, "127.0.0.1", () => r(s)); });
    servidor.unref();
    BASE = `http://127.0.0.1:${servidor.address().port}`;
    if (chromium) browser = await chromium.launch({ headless: true, ...(CANAL ? { channel: CANAL } : {}) });
  });
  after(async () => { await browser?.close(); if (servidor) await new Promise((r) => servidor.close(r)); await falso?.parar(); banco?.derrubar(); });

  describe("simulações de turno (independentes: rodam em paralelo, uma conta por cenário)", { concurrency: 6 }, () => {
  test("A) autenticação às 11h: cobre TODO o turno (até 04h) com 2 renovações; o limite (07h) fica depois do fim; sem reentrada nem 409", async () => {
    const c = contaTv("turno-a");
    const r = await simularTurno(c, { authAntesDoTurno: 0 });
    assert.equal(r.fimDoTurno, true, JSON.stringify(r));
    assert.equal(r.cobertoAte, 17 * H, "Checklist disponível do início ao fim (04h)");
    assert.equal(r.renovacoes, 2, JSON.stringify(r.eventos));
    assert.ok(!r.eventos.some((x) => /caiu|negada/.test(x)), `sem interrupção: ${r.eventos}`);
  });

  test("B1) autenticação 2 h antes (09h): limite às 05h > fim do turno (04h): cobre tudo", async () => {
    const c = contaTv("turno-b1");
    const r = await simularTurno(c, { authAntesDoTurno: 2 * H });
    assert.equal(r.fimDoTurno, true, JSON.stringify(r)); assert.equal(r.cobertoAte, 17 * H);
    assert.ok(!r.eventos.some((x) => /caiu|negada/.test(x)), String(r.eventos));
  });

  test("B2) autenticação exatamente 3 h antes (08h): o limite (04h) coincide com o fim do turno — cobre", async () => {
    const c = contaTv("turno-b2");
    const r = await simularTurno(c, { authAntesDoTurno: 3 * H - 5 * MIN });          // margem de 5 min (tolerância de relógio do teste)
    assert.equal(r.cobertoAte, 17 * H, JSON.stringify(r.eventos));
  });

  test("B3) autenticação 5 h antes (06h): o limite cai às 02h (15 h de turno) — o Checklist PARA ali e só volta com NOVA autenticação", async () => {
    const c = contaTv("turno-b3");
    const r = await simularTurno(c, { authAntesDoTurno: 5 * H });
    assert.equal(r.fimDoTurno, false, "o turno NÃO foi coberto até o fim");
    assert.ok(r.cobertoAte >= 14.5 * H && r.cobertoAte <= 15 * H, `coberto até ${r.cobertoAte / H} h do turno (limite = 15 h)`);
    assert.equal(r.motivoParada, "401:REAUTENTICACAO_NECESSARIA", "reentrada recusada pedindo nova autenticação");
    assert.ok(r.eventos.some((x) => x.startsWith("contexto-caiu@")), String(r.eventos));
    // A última renovação foi ENCURTADA até o limite (não estourou as 20 h)
    assert.ok(r.renovacoes >= 1);
  });

  test("B3b) …e quando alguém entra de novo logo depois do limite (02h05), o turno continua até o fim (04h); o novo limite é 20 h DEPOIS dessa autenticação", async () => {
    const c = contaTv("turno-b3b");
    const r = await simularTurno(c, { authAntesDoTurno: 5 * H, reautenticaEm: 15 * H + 5 * MIN });
    assert.equal(r.fimDoTurno, true, JSON.stringify(r)); assert.equal(r.cobertoAte, 17 * H);
    assert.ok(r.eventos.some((x) => x.startsWith("reentrou@")), String(r.eventos));
  });

  test("SEM RENOVAÇÃO INFINITA: depois do limite, renovar e reentrar com o MESMO login recusam sempre; só autenticação nova (carimbo recente) libera", async () => {
    const c = contaTv("turno-sem-infinito");
    const jwtVelho = jwtDe(c, 19 * H + 50 * MIN);
    const sel = await selecionar(jwtVelho); assert.equal(sel.status, 201);
    assert.ok(Date.parse(sel.json.data.expiraEm) - Date.now() <= 10 * MIN + 5000, "contexto nasce curto: só até o limite");
    envelhecer(c, 20 * MIN);                                                          // passou do limite
    const velho2 = jwtDe(c, 20 * H + 10 * MIN);
    for (let i = 0; i < 3; i++) {
      assert.equal((await selecionar(velho2)).status, 401, "reentrada recusada");
      const r = await api(velho2, "POST", "/sessao/renovar", { ctx: sel.json.data.contextToken });
      assert.ok([401, 409].includes(r.status), `renovar após o limite: ${r.status}`);
    }
    assert.equal(vivas(c).length, 0, "nenhum contexto vivo");
    assert.equal((await selecionar(jwtDe(c, 0))).status, 201, "login novo libera");
  });

  });
  describe("DUAS ABAS (mesmo contexto) renovando ao mesmo tempo — navegador real", { skip: SEM_NAVEGADOR, concurrency: 1 }, () => {
    async function abrir(c, jwt) {
      const contexto = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  contexto.setDefaultTimeout(90_000);   // sob a carga da suíte completa o servidor/navegador ficam lentos: nada de falso negativo por tempo
      await contexto.route((url) => !url.href.startsWith(BASE), (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
      await contexto.clock.install({ time: Date.now() });
      await contexto.addInitScript(({ jwt, id, email }) => {
        window.__sessao = { access_token: jwt, user: { id, email } };
        const canal = { on() { return canal; }, subscribe(cb) { try { cb?.("SUBSCRIBED"); } catch { /* */ } return canal; }, unsubscribe() {}, send() {} };
        window.supabase = { createClient: () => ({ auth: {
          getSession: async () => ({ data: { session: window.__sessao } }), signOut: async () => { window.__sessao = null; return { error: null }; },
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getUser: async () => ({ data: { user: window.__sessao?.user ?? null } }) },
        realtime: { setAuth() {}, connect() {}, disconnect() {} }, channel: () => canal, removeChannel: async () => {} }) };
      }, { jwt, id: c.id, email: c.email });
      const a = await contexto.newPage();
      await a.goto(BASE + "/");
      await a.waitForFunction(() => document.querySelector("#app") && !document.querySelector("#app").hidden && document.querySelector("[data-ckm]"), null, { timeout: 90_000 });
      await a.locator('[data-acao="iniciar-modo"][data-modo="tv"]').click(); await a.locator(".cko--tv").waitFor();
      // "Duplicar aba": window.open do mesmo documento copia o sessionStorage → a 2ª aba nasce com O MESMO Context Token.
      const [b] = await Promise.all([contexto.waitForEvent("page"), a.evaluate(() => { window.open("/", "_blank"); })]);
      await b.waitForFunction(() => document.querySelector("#app") && !document.querySelector("#app").hidden && document.querySelector("[data-ckm]"), null, { timeout: 90_000 });
      await b.locator('[data-acao="iniciar-modo"][data-modo="tv"]').click(); await b.locator(".cko--tv").waitFor();
      return { contexto, a, b };
    }
    const token = (p) => p.evaluate(() => { for (let i = 0; i < sessionStorage.length; i++) { const v = sessionStorage.getItem(sessionStorage.key(i)); if (v && v.split(".").length >= 2 && v.length > 40) return v; } return null; });

    test("as duas abas pedem a renovação juntas: UMA vence, a perdedora NÃO ganha permissão nem token da vencedora, reentra sozinha pelo caminho normal e ambas seguem no Checklist", async () => {
      const c = contaTv("abas"); const jwt = jwtDe(c, 0);
      const { contexto, a, b } = await abrir(c, jwt);
      try {
        const t0a = await token(a); const t0b = await token(b);
        assert.ok(t0a && t0a === t0b, "as duas abas partem do MESMO contexto");
        assert.equal(vivas(c).length, 1, "a 2ª aba RESTAUROU o contexto da 1ª (não criou outro)");
        envelhecer(c, 7 * H + 20 * MIN);                                              // no servidor: faltam ~40 min (dentro da janela)
        const pedidos = []; for (const p of [a, b]) p.on("request", (rq) => { if (/\/sessao\/renovar$/.test(rq.url())) pedidos.push(rq.url()); });
        await contexto.clock.fastForward(7 * H + 5 * MIN);                           // as duas dispararam o timer de renovação quase juntas
        await aguardar(() => pedidos.length >= 2 && Number(sql(banco.url, `select count(*) from sessoes_contexto where usuario_id = '${c.id}' and motivo_revogacao = 'renovada'`)) === 1, "as duas abas pedirem e UMA vencer");
        assert.ok(pedidos.length >= 2, `as duas pediram: ${pedidos.length}`);
        // passa a graça (90 s) e o polling da perdedora: ela cai no 409 e reentra
        envelhecer(c, 3 * MIN); await contexto.clock.fastForward(5 * MIN);
        await aguardar(async () => (await token(a)) !== t0a && (await token(b)) !== t0b, "as duas abas trocarem o token antigo (vencedora pela renovação; perdedora pela reentrada)");
        for (const p of [a, b]) {
          await p.waitForFunction(() => document.querySelector(".cko--tv, [data-ckm]"), null, { timeout: 90_000 });
          const est = await p.evaluate(async () => { const { state } = await import("/src/state.js"); return [state.sessao.papel, state.sessao.permissoes]; });
          assert.deepEqual(est, ["display_operator", ["checklist.visualizar"]], "nenhuma ampliação de permissões em nenhuma aba");
        }
        for (const s of vivas(c)) assert.deepEqual([s.papel, s.permissoes], ["display_operator", ["checklist.visualizar"]]);
        const renovadas = Number(sql(banco.url, `select count(*) from sessoes_contexto where usuario_id = '${c.id}' and motivo_revogacao = 'renovada'`));
        assert.equal(renovadas, 1, "exatamente UMA renovação venceu a disputa");
        const t1a = await token(a); const t1b = await token(b);
        assert.ok(t1a !== t0a && t1b !== t0b, "ambas trocaram o token antigo");
      } finally { await contexto.close(); }
    });

    test("sessão REVOGADA no servidor: nenhuma aba a ressuscita pela renovação (a linha continua revogada, motivo intacto, zero renovação); a entrada só acontece pelo caminho normal de login/seleção", async () => {
      const c = contaTv("abas-revogada"); const jwt = jwtDe(c, 0);
      const { contexto, a, b } = await abrir(c, jwt);
      try {
        const antigo = await token(a);
        const sidAntigo = sql(banco.url, `select id from sessoes_contexto where usuario_id = '${c.id}' order by criada_em limit 1`);
        sql(banco.url, `update sessoes_contexto set revogada_em = now(), motivo_revogacao = 'revogada_pelo_admin' where id = '${sidAntigo}'`);
        envelhecer(c, 7 * H + 20 * MIN);
        await contexto.clock.fastForward(7 * H + 5 * MIN); await aguardar(() => vivas(c).length >= 1, "a aba reentrar pelo caminho normal depois do 409"); await contexto.clock.fastForward(2 * MIN);
        const linha = JSON.parse(sql(banco.url, `select row_to_json(t) from (select revogada_em, motivo_revogacao from sessoes_contexto where id = '${sidAntigo}') t`));
        assert.ok(linha.revogada_em && linha.motivo_revogacao === "revogada_pelo_admin", "a sessão revogada continua revogada, com o motivo original");
        assert.equal(Number(sql(banco.url, `select count(*) from sessoes_contexto where id = '${sidAntigo}' and motivo_revogacao = 'renovada'`)), 0);
        const r = await api(jwt, "POST", "/sessao/renovar", { ctx: antigo });
        assert.equal(r.status, 409, "renovar o contexto revogado é recusado");
        for (const s of vivas(c)) assert.deepEqual([s.papel, s.permissoes], ["display_operator", ["checklist.visualizar"]]);
        for (const pg of [a, b]) await pg.waitForFunction(() => document.querySelector(".cko--tv, [data-ckm]"), null, { timeout: 60_000 });   // as duas terminam numa tela válida do Checklist
      } finally { await contexto.close(); }
    });
  });
});
