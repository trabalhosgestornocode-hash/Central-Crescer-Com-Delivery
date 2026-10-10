// O perfil de EXIBIÇÃO nas rotas FORA do conjunto tenant (sessao, plataforma, administrativo, contexto, /me, públicas)
// — pela CADEIA REAL (createApp + requireAuth + requireContexto) contra Postgres LOCAL descartável.
//
// O teste de isolamento do tenant (perfil-exibicao-isolamento.test.js) cobre as rotas montadas em `tenant`. Aqui se
// enumeram TODAS as demais rotas de routes.js (percorrendo a pilha Express, inclusive routers aninhados) e se dispara
// cada uma com a sessão de exibição real e um Context Token real. Regra: fora a lista fechada abaixo, NENHUMA rota
// pode responder 2xx — e as permitidas só devolvem dados da própria conta.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55420/postgres node --test test/perfil-exibicao-rotas-fora-do-tenant-real-pg.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { motivoPular, criarBancoDescartavel, sql } from "./helpers/pg-descartavel.js";
import { iniciarSupabaseFalso } from "./helpers/supabase-falso-pg.js";
import { SCHEMA_BASE } from "./helpers/schema-perfil-exibicao.js";

const MIG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "database", "migrations");
const ORG = "a0000000-0000-4000-8000-00000000000a";
const UNI = "a1000000-0000-4000-8000-0000000000a1";
const UUID = "11111111-1111-4111-8111-111111111111";
const MODULOS = ["dashboard", "products_cmv", "ingredients", "sales", "ifood", "ifood_dashboard", "monthly_bonus", "parser_food_delivery", "inteligencia", "agente_ia"];
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** Rotas de conta/sessão que a TV legitimamente usa (ou que respondem só sobre a própria conta). */
const PERMITIDAS_2XX = new Set([
  "GET /me", "GET /sessao/perfis", "GET /sessao/acessos", "GET /sessao/atual", "GET /sessao/unidades",
  "POST /sessao/selecionar", "POST /sessao/encerrar", "POST /sessao/renovar", "POST /sessao/mfa/evento", "GET /checklist-operacional/resumo", "POST /realtime/credencial",
]);

const USUARIOS = new Map();
let banco; let falso; let servidor; let BASE; let routerRaiz; let ctx; let jwt; let rotas;

/** Percorre a pilha de um router Express 4 (inclusive routers aninhados), devolvendo { metodo, modelo }. */
function percorrer(router, prefixo = "") {
  const saida = [];
  for (const camada of router.stack) {
    if (camada.route) {
      for (const m of Object.keys(camada.route.methods)) saida.push({ metodo: m.toUpperCase(), modelo: `${prefixo}${camada.route.path === "/" ? "" : camada.route.path}` || "/" });
    } else if (camada.name === "router" && camada.handle?.stack) {
      const fonte = camada.regexp?.source ?? "";
      const m = fonte.match(/^\^\\?(\/[^?]*?)\\\/\?\(\?=\\\/\|\$\)$/);
      const sub = m ? m[1].replace(/\\\//g, "/") : "";
      saida.push(...percorrer(camada.handle, `${prefixo}${sub}`));
    }
  }
  return saida;
}
const preencher = (modelo) => modelo.replace(/:([A-Za-z0-9_]+)\??/g, UUID);

async function chamar(metodo, caminho, { comContexto = true, corpo = {} } = {}) {
  const ehEscrita = ["POST", "PUT", "PATCH", "DELETE"].includes(metodo);
  const r = await fetch(`${BASE}/api/v1${caminho}`, {
    method: metodo, signal: AbortSignal.timeout(8000),
    headers: { authorization: `Bearer ${jwt}`, ...(comContexto ? { "x-context-token": ctx } : {}), ...(ehEscrita ? { "content-type": "application/json" } : {}) },
    body: ehEscrita && metodo !== "DELETE" ? JSON.stringify(corpo) : undefined,
  }).catch((e) => ({ status: `erro:${e.name}`, text: async () => "" }));
  return { status: r.status, texto: await r.text().catch(() => "") };
}

describe("PERFIL DE EXIBIÇÃO × rotas FORA do tenant (cadeia real)", { skip: motivoPular, timeout: 900_000 }, () => {
  before(async () => {
    banco = criarBancoDescartavel("rotas_fora");
    sql(banco.url, SCHEMA_BASE);
    sql(banco.url, "", { arquivo: join(MIG, "112_papel_operador_exibicao.sql") });
    sql(banco.url, "", { arquivo: join(MIG, "113_papel_exibicao_somente_unidade.sql") });
    const id = randomUUID();
    sql(banco.url, `
      insert into organizacoes (id, nome) values ('${ORG}', 'Empresa A');
      insert into unidades (id, organizacao_id, nome) values ('${UNI}', '${ORG}', 'Unidade A1');
      insert into organizacao_modulos select '${ORG}'::uuid, m from unnest(array[${MODULOS.map(lit).join(",")}]) m;
      insert into unidade_modulos select '${UNI}'::uuid, m from unnest(array[${MODULOS.map(lit).join(",")}]) m;
      insert into perfis (id, nome, email) values ('${id}', 'TV', 'tv-${id.slice(0, 6)}@exemplo.test');
      insert into perfis_operacionais (id, conta_id, nome) values ('${id}', '${id}', 'TV');
      insert into usuarios_unidades (usuario_id, perfil_id, unidade_id, papel) values ('${id}', '${id}', '${UNI}', 'display_operator');`);
    falso = await iniciarSupabaseFalso({ pgUrl: banco.url, usuarios: USUARIOS });
    Object.assign(process.env, {
      SUPABASE_URL: falso.url, SUPABASE_SERVICE_ROLE_KEY: "chave-service-role-de-teste-".padEnd(48, "z"), SUPABASE_ANON_KEY: "chave-anon-de-teste-".padEnd(48, "a"),
      CONTEXT_TOKEN_SECRET: "segredo-do-token-de-contexto-de-teste-".padEnd(64, "k"), NODE_ENV: "test",
      RATE_LIMIT_API_MAX: "1000000", RATE_LIMIT_CONTEXTO_MAX: "1000000", RATE_LIMIT_RENOVAR_MAX: "1000000",
    });
    const agoraS = Math.floor(Date.now() / 1000);
    jwt = `h.${Buffer.from(JSON.stringify({ sub: id, aal: "aal1", amr: [{ method: "password", timestamp: agoraS }] })).toString("base64url")}.s`;
    USUARIOS.set(jwt, { id, email: `tv-${id.slice(0, 6)}@exemplo.test` });
    const { createApp } = await import("../src/app.js");
    ({ router: routerRaiz } = await import("../src/routes.js"));
    servidor = await new Promise((r) => { const s = http.createServer(createApp()).listen(0, "127.0.0.1", () => r(s)); });
    servidor.unref();
    BASE = `http://127.0.0.1:${servidor.address().port}`;
    const sel = await fetch(`${BASE}/api/v1/sessao/selecionar`, { method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify({ organizacaoId: ORG, unidadeId: UNI }) });
    assert.equal(sel.status, 201);
    ctx = (await sel.json()).data.contextToken;
    rotas = percorrer(routerRaiz);
  });
  after(async () => { if (servidor) await new Promise((r) => servidor.close(r)); await falso?.parar(); banco?.derrubar(); });

  test("a enumeração enxerga os routers de verdade (sessao, plataforma, administrativo, contexto e todo o tenant)", () => {
    const prefixos = new Set(rotas.map((r) => `/${r.modelo.split("/")[1]}`));
    for (const p of ["/sessao", "/plataforma", "/administrativo", "/contexto", "/produtos", "/vendas", "/usuarios", "/checklist-operacional", "/realtime", "/agente", "/inteligencia"]) assert.ok(prefixos.has(p), `faltou ${p}`);
    assert.ok(rotas.length > 250, `rotas enumeradas: ${rotas.length}`);
  });

  test("CADA rota de routes.js, com a sessão de exibição + Context Token: só a lista fechada responde 2xx", async () => {
    const vistas = []; const vazou = [];
    for (const { metodo, modelo } of rotas) {
      const caminho = preencher(modelo);
      const r = await chamar(metodo, caminho);
      vistas.push({ chave: `${metodo} ${modelo}`, status: r.status });
      const dois = typeof r.status === "number" && r.status >= 200 && r.status < 300;
      if (dois && !PERMITIDAS_2XX.has(`${metodo} ${modelo}`)) vazou.push(`${metodo} ${modelo} -> ${r.status}`);
      assert.notEqual(typeof r.status === "string" ? r.status : "ok", "timeout", `${metodo} ${modelo}`);
    }
    assert.deepEqual(vazou, [], "rotas que o perfil de exibição NÃO podia alcançar responderam 2xx");
    const codigos = new Set(vistas.map((v) => v.status));
    for (const c of codigos) assert.ok([200, 201, 400, 401, 403, 404, 409, 429].includes(c), `status inesperado ${c}: ${vistas.filter((v) => v.status === c).map((v) => v.chave).slice(0, 3)}`);
    // E nenhuma das rotas permitidas devolveu 5xx
    assert.ok(!vistas.some((v) => typeof v.status === "number" && v.status >= 500), `5xx: ${vistas.filter((v) => v.status >= 500).map((v) => v.chave)}`);
  });

  test("rotas administrativas e de plataforma: 403 (nunca 2xx) mesmo com corpo plausível; sem Context Token também não abre nada", async () => {
    const administrativas = rotas.filter((r) => /^\/(plataforma|administrativo|contexto)\b/.test(r.modelo));
    assert.ok(administrativas.length > 60, `administrativas: ${administrativas.length}`);
    for (const { metodo, modelo } of administrativas) {
      for (const comContexto of [true, false]) {
        const r = await chamar(metodo, preencher(modelo), { comContexto, corpo: { email: "x@x.test", papel: "organization_admin", nome: "x", organizacaoId: ORG, unidadeId: UNI } });
        assert.ok([401, 403, 404, 409, 400].includes(r.status), `${metodo} ${modelo} (contexto=${comContexto}) -> ${r.status}`);
        assert.ok(!(r.status >= 200 && r.status < 300));
      }
    }
  });

  test("trocar de unidade / senha / PIN / MFA pela sessão de exibição: nada muda de empresa ou de unidade", async () => {
    for (const [metodo, caminho, corpo] of [
      ["POST", "/sessao/trocar-unidade", { unidadeId: UUID }], ["POST", "/sessao/selecionar", { organizacaoId: UUID, unidadeId: UUID }],
      ["POST", "/sessao/selecionar", { organizacaoId: ORG, unidadeId: null }], ["POST", "/sessao/selecionar", { organizacaoId: ORG }],
    ]) {
      const r = await chamar(metodo, caminho, { corpo });
      const j = r.texto ? JSON.parse(r.texto) : {};
      if (r.status === 201) assert.deepEqual([j.data?.papel, j.data?.unidade?.id, j.data?.empresa?.id], ["display_operator", UNI, ORG], `${caminho} só pode devolver o próprio contexto`);
      else assert.ok([400, 403, 404, 409].includes(r.status), `${caminho} ${JSON.stringify(corpo)} -> ${r.status}`);
    }
    // (a enumeração anterior já encerrou o contexto: o que vale é que NUNCA existiu sessão fora da unidade da TV)
    const fora = Number(sql(banco.url, `select count(*) from sessoes_contexto where unidade_id is distinct from '${UNI}'`));
    assert.equal(fora, 0, "nenhuma sessão, viva ou não, em outra unidade/empresa");
  });

  test("rotas públicas e de app: /health e /api/config respondem sem dados de tenant; o gateway WhatsApp não está montado (sem env)", async () => {
    const h = await fetch(`${BASE}/health`); const hj = await h.json();
    assert.equal(h.status, 200); assert.deepEqual(Object.keys(hj).sort(), ["csp", "ifoodEvents", "ok", "service", "ts"]);
    const c = await fetch(`${BASE}/api/config`); const cj = await c.json();
    assert.deepEqual(Object.keys(cj).sort(), ["supabaseAnonKey", "supabaseUrl"]);
    assert.ok(!JSON.stringify(cj).includes("service-role"));
    for (const p of ["/internal/whatsapp-gateway", "/internal/whatsapp", "/internal/martin-brower"]) {
      const r = await fetch(`${BASE}${p}`, { method: "POST" });
      assert.ok([401, 403, 404].includes(r.status), `${p} -> ${r.status}`);
    }
    // sem login nada de /api/v1 abre (inclusive /me)
    assert.equal((await fetch(`${BASE}/api/v1/me`)).status, 401);
  });
});
