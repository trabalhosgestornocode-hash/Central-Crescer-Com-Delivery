// Checklist Operacional 2.0 — HOMOLOGAÇÃO FUNCIONAL na CADEIA REAL: createApp + requireAuth + seleção de contexto +
// requireContexto + gate de módulo + permissões, com o supabase-js de verdade apontado para um "Supabase" local
// (helpers/supabase-falso-pg.js) em cima de um Postgres REAL e DESCARTÁVEL com o schema REAL (base + 068..128).
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55430/postgres node --experimental-vm-modules --test test/checklist-operacional-2-homologacao-real-pg.test.js
//
// Duas empresas, três unidades, papéis reais (admin, gestor, operação, consulta, exibição) e várias sessões ao mesmo
// tempo. O Realtime é observado no ponto em que o backend publica (fetch do Broadcast): tópico, tipo e payload.
// PULA sem a variável e RECUSA host que não seja local. Dados fictícios; nunca toca o Supabase de verdade.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { motivoPular, criarBancoDescartavel, sql } from "./helpers/pg-descartavel.js";
import { construirSchemaReal } from "./helpers/schema-real-pg.js";
import { hojeNoFuso, somarDias, inicioDoDia } from "../src/modules/checklist-operacional/checklistOperacional.periodos.js";

const ORG_A = "a0000000-0000-4000-8000-00000000000a";
const ORG_B = "b0000000-0000-4000-8000-00000000000b";
const UNI_A1 = "a1000000-0000-4000-8000-0000000000a1";
const UNI_A2 = "a2000000-0000-4000-8000-0000000000a2";
const UNI_B1 = "b1000000-0000-4000-8000-0000000000b1";
// Só o módulo PRÓPRIO do Checklist (migration 123), sem `ifood`: prova que as rotas 2.0 seguem o gate da main.
const MODULOS = ["dashboard", "checklist_operacional", "inteligencia", "agente_ia"];
const METAS = (preparo, entrega = 35, vida = 45) => ({ preparo: { meta: preparo, avisoPct: 80 }, entrega: { meta: entrega, avisoPct: 80 }, vida: { meta: vida, avisoPct: 80 } });

const USUARIOS = new Map();
let banco; let falso; let servidor; let BASE;
const broadcasts = []; // o que o backend publicou no Realtime (URL + payload)

const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
function conta(rotulo) {
  const id = randomUUID();
  const jwt = `jwt.${Buffer.from(JSON.stringify({ sub: id })).toString("base64url")}.sig`;
  USUARIOS.set(jwt, { id, email: `${rotulo}-${id.slice(0, 6)}@exemplo.test` });
  sql(banco.url, `insert into auth.users (id, email) values ('${id}', ${lit(USUARIOS.get(jwt).email)});
    insert into perfis (id, nome, email) values ('${id}', ${lit(rotulo)}, ${lit(USUARIOS.get(jwt).email)});
    insert into perfis_operacionais (id, conta_id, nome) values ('${id}', '${id}', ${lit(rotulo)});`);
  return { id, jwt, rotulo };
}
const vincularEmpresa = (c, org, papel) => sql(banco.url, `insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('${c.id}', '${c.id}', '${org}', '${papel}')`);
const vincularUnidade = (c, uni, papel) => sql(banco.url, `insert into usuarios_unidades (usuario_id, perfil_id, unidade_id, papel) values ('${c.id}', '${c.id}', '${uni}', ${lit(papel)})`);

async function api(c, metodo, caminho, { ctx, corpo } = {}) {
  const r = await fetch(`${BASE}/api/v1${caminho}`, {
    method: metodo,
    headers: { authorization: `Bearer ${c.jwt}`, ...(ctx ? { "x-context-token": ctx } : {}), ...(corpo !== undefined ? { "content-type": "application/json" } : {}) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString("utf8")); } catch { /* binário */ }
  return { status: r.status, json, buf, tipo: r.headers.get("content-type"), texto: buf.toString("utf8").slice(0, 400) };
}
async function entrar(c, org, uni) {
  const r = await api(c, "POST", "/sessao/selecionar", { corpo: { organizacaoId: org, unidadeId: uni } });
  assert.equal(r.status, 201, `${c.rotulo}: ${r.texto}`);
  return r.json.data.contextToken;
}

// ---- datas no fuso da operação (relativas a HOJE: o servidor usa o relógio real) ----------------------------------
const HOJE = hojeNoFuso(Date.now());
const dia = (off) => somarDias(HOJE, off);
const em = (off, hh, mm = 0) => new Date(inicioDoDia(dia(off)) + (hh * 60 + mm) * 60_000).toISOString();
const mais = (iso, min) => new Date(Date.parse(iso) + min * 60_000).toISOString();

/** Pedido de entrega concluído com preparo (PLC→DSP) e entrega (DSP→CON) em minutos — régua "Etapa 2". */
function pedido({ id, org, uni, rec, preparo, entrega = 20, status = "CONCLUDED", tipo = "DELIVERY" }) {
  const dsp = preparo == null ? null : mais(rec, preparo);
  const con = dsp && status === "CONCLUDED" ? mais(dsp, entrega) : null;
  return `('${id}', 'm-${uni.slice(0, 4)}', '${org}', '${uni}', '${id.slice(-4)}', '${status}', ${lit(con ?? rec)}, '${tipo}', 'IFOOD', 'IMMEDIATE', false,
    ${lit(rec)}, ${lit(rec)}, ${lit(mais(rec, 1))}, ${dsp ? lit(dsp) : "null"}, ${lit(rec)}, ${lit(rec)})`;
}
const inserirPedidos = (linhas) => sql(banco.url, `insert into ifood_pedidos (order_id, merchant_id, organizacao_id, unidade_id, display_id, status_oficial,
  status_oficial_em, order_type, delivery_by, order_timing, is_test, order_created_at, placed_event_created_at, confirmed_event_at,
  dispatch_event_at, primeiro_evento_em, criado_em) values ${linhas.join(",\n")}`);

const P = {};
describe("Checklist 2.0 — homologação funcional na cadeia real (schema real 068..128)", { skip: motivoPular, timeout: 900_000 }, () => {
  before(async () => {
    banco = criarBancoDescartavel("hml_checklist2");
    const falhas = construirSchemaReal(banco.url);
    assert.deepEqual(falhas, [], JSON.stringify(falhas));
    sql(banco.url, `
      insert into organizacoes (id, nome) values ('${ORG_A}', 'Empresa A'), ('${ORG_B}', 'Empresa B');
      insert into unidades (id, organizacao_id, nome) values ('${UNI_A1}', '${ORG_A}', 'Unidade A1'), ('${UNI_A2}', '${ORG_A}', 'Unidade A2'), ('${UNI_B1}', '${ORG_B}', 'Unidade B1');
      insert into organizacao_modulos (organizacao_id, modulo_id) select o, m from unnest(array['${ORG_A}'::uuid, '${ORG_B}'::uuid]) o, unnest(array[${MODULOS.map(lit).join(",")}]) m;
      insert into unidade_modulos (unidade_id, modulo_id) select u, m from unnest(array['${UNI_A1}'::uuid, '${UNI_A2}'::uuid, '${UNI_B1}'::uuid]) u, unnest(array[${MODULOS.map(lit).join(",")}]) m;`);

    // A1: 5 entregas concluídas (preparo 8, 10, 14 em D-3; 9 e 30 em D-2) + 1 retirada (fora dos tempos) + 1 ATIVO agora.
    // A2: histórico de metas no passado (v1 preparo 12 em D-30; v2 preparo 8 em D-5): preparo 10 em D-7 (dentro da v1) e
    //     preparo 10 em D-3 (fora da v2) — a meta vigente NO RECEBIMENTO decide. Comparativo: D-12 com preparo 20.
    // B1 (outra empresa): pedidos que nunca podem aparecer para A.
    inserirPedidos([
      pedido({ id: "a1-d3-a", org: ORG_A, uni: UNI_A1, rec: em(-3, 12), preparo: 8 }),
      pedido({ id: "a1-d3-b", org: ORG_A, uni: UNI_A1, rec: em(-3, 13), preparo: 10 }),
      pedido({ id: "a1-d3-c", org: ORG_A, uni: UNI_A1, rec: em(-3, 19), preparo: 14 }),
      pedido({ id: "a1-d2-a", org: ORG_A, uni: UNI_A1, rec: em(-2, 12), preparo: 9 }),
      pedido({ id: "a1-d2-b", org: ORG_A, uni: UNI_A1, rec: em(-2, 20), preparo: 30, entrega: 25 }),
      pedido({ id: "a1-d2-ret", org: ORG_A, uni: UNI_A1, rec: em(-2, 21), preparo: 5, tipo: "TAKEOUT" }),
      pedido({ id: "a2-d12", org: ORG_A, uni: UNI_A2, rec: em(-12, 12), preparo: 20 }),
      pedido({ id: "a2-d7", org: ORG_A, uni: UNI_A2, rec: em(-7, 12), preparo: 10 }),
      pedido({ id: "a2-d3", org: ORG_A, uni: UNI_A2, rec: em(-3, 12), preparo: 10 }),
      pedido({ id: "b1-d3", org: ORG_B, uni: UNI_B1, rec: em(-3, 12), preparo: 99, entrega: 99 }),
    ]);
    // Pedido EM ANDAMENTO em A1: chegou há 6 min, ainda não despachado (cronômetro de preparo a partir da chegada).
    const ha6 = new Date(Date.now() - 6 * 60_000).toISOString();
    sql(banco.url, `insert into ifood_pedidos (order_id, merchant_id, organizacao_id, unidade_id, display_id, status_oficial, status_oficial_em,
      order_type, delivery_by, order_timing, is_test, order_created_at, placed_event_created_at, confirmed_event_at, primeiro_evento_em, criado_em)
      values ('a1-ativo', 'm-a100', '${ORG_A}', '${UNI_A1}', '7777', 'CONFIRMED', ${lit(ha6)}, 'DELIVERY', 'IFOOD', 'IMMEDIATE', false, ${lit(ha6)}, ${lit(ha6)}, ${lit(ha6)}, ${lit(ha6)}, ${lit(ha6)})`);
    // Histórico de metas de A2 no PASSADO (como se salvo há dias): inserção direta só no preparo do teste.
    const j = (m) => `'${JSON.stringify(m)}'::jsonb`;
    sql(banco.url, `insert into checklist_metas_historico (organizacao_id, unidade_id, versao, anterior, novo, origem, alterado_em, alterado_por_nome) values
      ('${ORG_A}', '${UNI_A2}', 1, null, ${j(METAS(12))}, 'interface', ${lit(em(-30, 9))}, 'Gestora'),
      ('${ORG_A}', '${UNI_A2}', 2, ${j(METAS(12))}, ${j(METAS(8))}, 'interface', ${lit(em(-5, 12))}, 'Gestora');`);

    const { iniciarSupabaseFalso } = await import("./helpers/supabase-falso-pg.js");
    falso = await iniciarSupabaseFalso({ pgUrl: banco.url, usuarios: USUARIOS });
    Object.assign(process.env, {
      SUPABASE_URL: falso.url,
      SUPABASE_SERVICE_ROLE_KEY: "chave-service-role-de-teste-".padEnd(48, "z"),
      SUPABASE_ANON_KEY: "chave-anon-de-teste-".padEnd(48, "a"),
      CONTEXT_TOKEN_SECRET: "segredo-do-token-de-contexto-de-teste-".padEnd(64, "k"),
      RATE_LIMIT_API_MAX: "1000000", RATE_LIMIT_CONTEXTO_MAX: "1000000", RATE_LIMIT_PLATAFORMA_MAX: "1000000", RATE_LIMIT_ADMINISTRATIVO_MAX: "1000000",
      NODE_ENV: "test",
    });
    // Observa o Broadcast do Realtime (o backend publica por fetch HTTP): registra e responde 202 sem rede.
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/realtime/v1/api/broadcast/")) {
        broadcasts.push({ url: decodeURIComponent(String(url)), payload: JSON.parse(init?.body ?? "{}") });
        return new Response(null, { status: 202 });
      }
      return fetchOriginal(url, init);
    };
    const { createApp } = await import("../src/app.js");
    servidor = await new Promise((r) => { const s = http.createServer(createApp()).listen(0, "127.0.0.1", () => r(s)); });
    servidor.unref();
    BASE = `http://127.0.0.1:${servidor.address().port}`;

    P.admin = conta("Admin A"); vincularEmpresa(P.admin, ORG_A, "organization_admin");
    P.gestor = conta("Gestora A"); vincularEmpresa(P.gestor, ORG_A, "unit_manager");
    P.operacao = conta("Operação A"); vincularEmpresa(P.operacao, ORG_A, "operations");
    P.consulta = conta("Consulta A"); vincularEmpresa(P.consulta, ORG_A, "viewer");
    P.tv = conta("TV A1"); vincularUnidade(P.tv, UNI_A1, "display_operator");
    P.adminB = conta("Admin B"); vincularEmpresa(P.adminB, ORG_B, "organization_admin");
    for (const k of ["admin", "gestor", "operacao", "consulta", "tv"]) P[`ctx_${k}`] = await entrar(P[k], ORG_A, UNI_A1);
    P.ctx_adminB = await entrar(P.adminB, ORG_B, UNI_B1);
  });
  after(async () => {
    if (servidor) await new Promise((r) => servidor.close(r));
    await falso?.parar();
    banco?.derrubar();
  });

  // ===================================================================================================================
  describe("1. metas: persistência e propagação (TV, Tablet, Dashboard) entre sessões", () => {
    test("sem metas salvas: todas as telas recebem o exemplo marcado 'padrao' (versão 0)", async () => {
      const r = await api(P.gestor, "GET", "/checklist-operacional/metas", { ctx: P.ctx_gestor });
      assert.equal(r.status, 200, r.texto);
      assert.deepEqual([r.json.data.origem, r.json.data.versao], ["padrao", 0]);
      const tv = await api(P.tv, "GET", "/checklist-operacional/resumo", { ctx: P.ctx_tv });
      assert.equal(tv.status, 200, tv.texto);
      assert.equal(tv.json.data.metas.origem, "padrao");
    });

    test("a gestora salva (0 → 1): a TV (perfil de exibição), o tablet (outra sessão) e o Dashboard passam a ver a v1", async () => {
      broadcasts.length = 0;
      const s = await api(P.gestor, "PUT", "/checklist-operacional/metas", { ctx: P.ctx_gestor, corpo: { versao: 0, metas: METAS(15) } });
      assert.equal(s.status, 200, s.texto);
      assert.deepEqual([s.json.data.resultado, s.json.data.metas.versao, s.json.data.metas.atualizadoPor], ["salvo", 1, "Gestora A"]);
      const tv = await api(P.tv, "GET", "/checklist-operacional/resumo", { ctx: P.ctx_tv });
      const tablet = await api(P.admin, "GET", "/checklist-operacional/resumo", { ctx: P.ctx_admin });
      for (const r of [tv, tablet]) {
        assert.equal(r.json.data.metas.versao, 1);
        assert.equal(r.json.data.metas.valores.preparo.meta, 15);
      }
      const dash = await api(P.operacao, "GET", "/checklist-operacional/dashboard?periodo=hoje", { ctx: P.ctx_operacao });
      assert.equal(dash.status, 200, dash.texto);
      assert.deepEqual(dash.json.data.metasAplicaveis.versoes.map((v) => v.valores.preparo.meta), [15]);
      // Persistido de verdade: linha + histórico no banco.
      assert.equal(sql(banco.url, `select versao || '|' || preparo_meta_min from checklist_metas where unidade_id = '${UNI_A1}'`), "1|15.0");
      assert.equal(sql(banco.url, `select count(*) from checklist_metas_historico where unidade_id = '${UNI_A1}'`), "1");
      // Realtime: UM aviso, só no tópico da UNIDADE, sem os valores.
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(broadcasts.length, 1, JSON.stringify(broadcasts));
      assert.match(broadcasts[0].url, new RegExp(`/broadcast/unidade:${UNI_A1}/events/evento_dominio\\?private=true$`));
      assert.equal(broadcasts[0].payload.tipo, "checklist_metas.atualizadas");
      assert.equal(broadcasts[0].payload.versao, 1);
      assert.ok(!("metas" in broadcasts[0].payload) && !("valores" in broadcasts[0].payload));
    });

    test("edição simultânea: duas sessões com a v1 — uma grava (v2), a outra recebe 409 com o valor atual; nada é perdido em silêncio", async () => {
      const [a, b] = await Promise.all([
        api(P.admin, "PUT", "/checklist-operacional/metas", { ctx: P.ctx_admin, corpo: { versao: 1, metas: METAS(14) } }),
        api(P.gestor, "PUT", "/checklist-operacional/metas", { ctx: P.ctx_gestor, corpo: { versao: 1, metas: METAS(13) } }),
      ]);
      const status = [a.status, b.status].sort();
      assert.deepEqual(status, [200, 409], `${a.texto} | ${b.texto}`);
      const perdedor = a.status === 409 ? a : b;
      const vencedor = a.status === 200 ? a : b;
      assert.equal(perdedor.json.codigo, "METAS_CONFLITO");
      assert.equal(perdedor.json.details.metas.versao, 2);
      assert.equal(perdedor.json.details.metas.valores.preparo.meta, vencedor.json.data.metas.valores.preparo.meta);
      assert.equal(sql(banco.url, `select string_agg(versao::text, ',' order by versao) from checklist_metas_historico where unidade_id = '${UNI_A1}'`), "1,2");
      // A sessão que perdeu revisa e salva O SEU valor com a versão atual (agora vira a v3).
      const meu = perdedor === a ? 14 : 13;
      const de_novo = await api(perdedor === a ? P.admin : P.gestor, "PUT", "/checklist-operacional/metas", { ctx: perdedor === a ? P.ctx_admin : P.ctx_gestor, corpo: { versao: 2, metas: METAS(meu) } });
      assert.equal(de_novo.status, 200, de_novo.texto);
      assert.deepEqual([de_novo.json.data.resultado, de_novo.json.data.metas.versao], ["salvo", 3]);
      // Mesmos valores outra vez: nenhuma versão nova (sem_alteracao), sem aviso de Realtime à toa.
      const igual = await api(P.admin, "PUT", "/checklist-operacional/metas", { ctx: P.ctx_admin, corpo: { versao: 3, metas: METAS(meu) } });
      assert.deepEqual([igual.status, igual.json.data.resultado, igual.json.data.metas.versao], [200, "sem_alteracao", 3]);
    });

    test("histórico de alterações: quem, quando, antes e depois (sem ids de pessoa na resposta)", async () => {
      const h = await api(P.admin, "GET", "/checklist-operacional/metas/historico", { ctx: P.ctx_admin });
      assert.equal(h.status, 200, h.texto);
      assert.deepEqual(h.json.data.map((x) => x.versao), [3, 2, 1]);
      assert.equal(h.json.data[2].anterior, null);
      assert.equal(h.json.data[2].alteradoPor, "Gestora A");
      assert.equal(h.json.data[1].anterior.preparo.meta, 15, "a v2 guardou o valor anterior (v1)");
      assert.doesNotMatch(h.texto, new RegExp(`${P.gestor.id}|${P.admin.id}`));
    });
  });

  // ===================================================================================================================
  describe("2. permissões por papel (a TV só lê pelo resumo)", () => {
    test("salvar metas e ver o histórico: admin e gestor sim; operação, consulta e exibição não (403)", async () => {
      const versao = Number(sql(banco.url, `select versao from checklist_metas where unidade_id = '${UNI_A1}'`));
      for (const [k, esperado] of [["operacao", 403], ["consulta", 403], ["tv", 403]]) {
        const r = await api(P[k], "PUT", "/checklist-operacional/metas", { ctx: P[`ctx_${k}`], corpo: { versao, metas: METAS(5) } });
        assert.equal(r.status, esperado, `${k}: ${r.texto}`);
        const h = await api(P[k], "GET", "/checklist-operacional/metas/historico", { ctx: P[`ctx_${k}`] });
        assert.equal(h.status, 403, `${k} histórico`);
      }
      assert.equal(sql(banco.url, `select versao from checklist_metas where unidade_id = '${UNI_A1}'`), String(versao), "nenhuma gravação negada mudou nada");
    });

    test("Dashboard e Excel: todos os papéis de leitura; o perfil de exibição NÃO (lista exata de rotas)", async () => {
      for (const k of ["admin", "gestor", "operacao", "consulta"]) {
        assert.equal((await api(P[k], "GET", "/checklist-operacional/dashboard?periodo=hoje", { ctx: P[`ctx_${k}`] })).status, 200, k);
      }
      assert.equal((await api(P.tv, "GET", "/checklist-operacional/dashboard?periodo=hoje", { ctx: P.ctx_tv })).status, 403);
      assert.equal((await api(P.tv, "GET", "/checklist-operacional/dashboard/exportar.xlsx", { ctx: P.ctx_tv })).status, 403);
      assert.equal((await api(P.tv, "GET", "/checklist-operacional/metas", { ctx: P.ctx_tv })).status, 403);
      assert.equal((await api(P.tv, "GET", "/checklist-operacional/resumo", { ctx: P.ctx_tv })).status, 200);
    });
  });

  // ===================================================================================================================
  describe("3. isolamento entre unidades e empresas", () => {
    test("a Empresa B não vê as metas da A; o id de outra unidade no corpo é ignorado", async () => {
      const r = await api(P.adminB, "GET", "/checklist-operacional/metas", { ctx: P.ctx_adminB });
      assert.equal(r.json.data.origem, "padrao");
      const s = await api(P.adminB, "PUT", "/checklist-operacional/metas", { ctx: P.ctx_adminB, corpo: { versao: 0, metas: METAS(50), unidadeId: UNI_A1, organizacaoId: ORG_A } });
      assert.equal(s.status, 200, s.texto);
      assert.equal(sql(banco.url, `select preparo_meta_min::text from checklist_metas where unidade_id = '${UNI_B1}'`), "50.0");
      assert.notEqual(sql(banco.url, `select preparo_meta_min::text from checklist_metas where unidade_id = '${UNI_A1}'`), "50.0");
    });

    test("outra unidade da MESMA empresa (A2) tem metas próprias e o Dashboard da A1 não conta pedido de A2 nem de B1", async () => {
      const ctxA2 = await entrar(P.gestor, ORG_A, UNI_A2);
      assert.equal((await api(P.gestor, "GET", "/checklist-operacional/metas", { ctx: ctxA2 })).json.data.origem, "padrao");
      const d = await api(P.gestor, "GET", `/checklist-operacional/dashboard?periodo=personalizado&inicio=${dia(-3)}&fim=${dia(-2)}`, { ctx: P.ctx_gestor });
      assert.equal(d.status, 200, d.texto);
      assert.equal(d.json.data.resumo.pedidos, 6, "5 entregas + 1 retirada da A1");
      assert.doesNotMatch(JSON.stringify(d.json.data), /a2-d|b1-d|99,|"99"/);
    });
  });

  // ===================================================================================================================
  describe("4. indicadores e comparativos (números conferidos à mão)", () => {
    test("A1, D-3..D-2: média, mediana, P90 e retirada fora dos tempos (régua Etapa 2)", async () => {
      const d = (await api(P.admin, "GET", `/checklist-operacional/dashboard?periodo=personalizado&inicio=${dia(-3)}&fim=${dia(-2)}&etapa=preparo`, { ctx: P.ctx_admin })).json.data;
      const pr = d.resumo.porEtapa.preparo;
      // Preparos: 8, 10, 14, 9, 30 → média 14,2; mediana 10; P90 = 14 + 0,6×(30−14) = 23,6.
      assert.deepEqual([pr.amostras, pr.media, pr.mediana, pr.p90, pr.minimo, pr.maximo], [5, 14.2, 10, 23.6, 8, 30]);
      // As metas da A1 foram salvas HOJE: nenhum pedido desses dias tinha meta vigente (fora do % e contados à parte).
      assert.deepEqual([pr.avaliadas, pr.pctDentro, pr.semMetaVigente], [0, null, 5]);
      assert.deepEqual(d.evolucaoDiaria.map((x) => [x.data, x.pedidos]), [[dia(-3), 3], [dia(-2), 3]]);
      assert.equal(d.demandaPorHora[12].pedidos, 2);
    });

    test("A2: cada pedido avaliado pela meta vigente NO RECEBIMENTO (v1=12 antes de D-5; v2=8 depois); comparativo com o período anterior", async () => {
      const ctxA2 = await entrar(P.admin, ORG_A, UNI_A2);
      const d = (await api(P.admin, "GET", `/checklist-operacional/dashboard?periodo=personalizado&inicio=${dia(-8)}&fim=${dia(-2)}&etapa=preparo`, { ctx: ctxA2 })).json.data;
      const pr = d.resumo.porEtapa.preparo;
      assert.deepEqual([pr.amostras, pr.avaliadas, pr.dentro, pr.atrasos, pr.pctDentro], [2, 2, 1, 1, 50], "10 min: dentro da v1 (12), fora da v2 (8)");
      assert.equal(pr.maiorAtraso.metaMin, 8);
      assert.deepEqual(d.metasAplicaveis.versoes.map((v) => v.versao), [1, 2]);
      // Período anterior equivalente (7 dias antes): só o pedido de D-12 com preparo 20.
      assert.deepEqual([d.periodo.anterior.inicio, d.periodo.anterior.fim], [dia(-15), dia(-9)]);
      assert.deepEqual([d.comparacao.porEtapa.preparo.mediana.atual, d.comparacao.porEtapa.preparo.mediana.anterior, d.comparacao.porEtapa.preparo.mediana.diferenca], [10, 20, -10]);
    });
  });

  // ===================================================================================================================
  describe("5. status verde / amarelo / vermelho com dados reais e metas do servidor (lógica da tela)", () => {
    test("o pedido em andamento há 6 min muda de nível conforme a meta salva: 30 → verde, 7 → amarelo, 4 → vermelho", async () => {
      const { adaptarResumo } = await import("../../frontend/src/checklistOperacionalDados.js");
      const { derivarStatusOperacao, METAS_EXEMPLO } = await import("../../frontend/src/checklistOperacionalModelo.js");
      const niveis = [];
      for (const preparo of [30, 7, 4]) {
        const versao = Number(sql(banco.url, `select versao from checklist_metas where unidade_id = '${UNI_A1}'`));
        const s = await api(P.admin, "PUT", "/checklist-operacional/metas", { ctx: P.ctx_admin, corpo: { versao, metas: METAS(preparo, 35, 60) } });
        assert.equal(s.status, 200, s.texto);
        const r = await api(P.tv, "GET", "/checklist-operacional/resumo", { ctx: P.ctx_tv });
        const resumo = adaptarResumo(r.json.data, { unidade: { id: UNI_A1, nome: "A1" }, metas: METAS_EXEMPLO, recebidoEmMs: Date.now() });
        assert.equal(resumo.metas.preparo.meta, preparo, "a tela usa a meta do SERVIDOR");
        const st = derivarStatusOperacao(resumo, Date.now() + resumo.relogioOffsetMs);
        niveis.push(st.nivelAtivos);
      }
      assert.deepEqual(niveis, ["ok", "atencao", "critico"]);
    });
  });

  // ===================================================================================================================
  describe("6. Dashboard × Excel × PDF: os mesmos números do mesmo filtro", () => {
    test("Excel do backend e PDF do frontend correspondem ao payload exibido", async () => {
      const XLSX = await import("xlsx");
      const { htmlRelatorio } = await import("../../frontend/src/checklistOperacionalRelatorio.js");
      const q = `periodo=personalizado&inicio=${dia(-3)}&fim=${dia(-2)}`;
      const d = (await api(P.admin, "GET", `/checklist-operacional/dashboard?${q}`, { ctx: P.ctx_admin })).json.data;
      const x = await api(P.admin, "GET", `/checklist-operacional/dashboard/exportar.xlsx?${q}&secoes=resumo,etapas,evolucao`, { ctx: P.ctx_admin });
      assert.equal(x.status, 200);
      assert.match(x.tipo, /spreadsheetml/);
      const wb = XLSX.read(x.buf, { type: "buffer" });
      assert.deepEqual(wb.SheetNames, ["Resumo", "Etapas", "Evolução diária"]);
      const etapas = XLSX.utils.sheet_to_json(wb.Sheets.Etapas, { header: 1 });
      assert.equal(etapas[1][1], "Unidade A1", "unidade identificada");
      for (const e of ["preparo", "entrega", "vida"]) {
        const nome = { preparo: "Preparo", entrega: "Entrega", vida: "Vida do pedido" }[e];
        const l = etapas.find((r) => r[0] === nome);
        const p = d.resumo.porEtapa[e];
        assert.deepEqual([l[1], l[2], l[3], l[4]], [p.amostras, p.media ?? "", p.mediana ?? "", p.p90 ?? ""], nome);
      }
      const resumo = XLSX.utils.sheet_to_json(wb.Sheets.Resumo, { header: 1 });
      assert.equal(resumo.find((r) => r[0] === "Pedidos acompanhados")[1], d.resumo.pedidos);
      const pdf = htmlRelatorio(d, ["resumo", "etapas"], { unidadeNome: "Unidade A1", geradoEm: d.servidorEm });
      assert.match(pdf, /Relatório operacional — Unidade A1/);
      assert.ok(pdf.includes(`${d.resumo.pedidos} pedidos acompanhados`));
      assert.ok(pdf.includes(`mediana de ${String(d.resumo.porEtapa.preparo.mediana).replace(".", ",")} min`));
    });
  });

  // ===================================================================================================================
  describe("7. queda e retomada (reconexão)", () => {
    test("o resumo é sem estado: depois de qualquer queda, a próxima consulta traz a versão ATUAL das metas", async () => {
      const antes = await api(P.tv, "GET", "/checklist-operacional/resumo", { ctx: P.ctx_tv });
      // "Durante a queda" outra sessão altera as metas (o aviso do Realtime se perde para a TV).
      const versao = antes.json.data.metas.versao;
      assert.equal((await api(P.gestor, "PUT", "/checklist-operacional/metas", { ctx: P.ctx_gestor, corpo: { versao, metas: METAS(21) } })).status, 200);
      const depois = await api(P.tv, "GET", "/checklist-operacional/resumo", { ctx: P.ctx_tv });
      assert.deepEqual([depois.json.data.metas.versao, depois.json.data.metas.valores.preparo.meta], [versao + 1, 21]);
    });

    test("sessão antiga com versão velha não sobrescreve: 409 e a tela recebe o valor atual para reconciliar", async () => {
      const r = await api(P.admin, "PUT", "/checklist-operacional/metas", { ctx: P.ctx_admin, corpo: { versao: 1, metas: METAS(99) } });
      assert.equal(r.status, 409);
      assert.equal(r.json.details.metas.valores.preparo.meta, 21);
    });
  });
});
