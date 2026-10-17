// Checklist Operacional — isolamento, migration do módulo e RLS contra um Postgres REAL e DESCARTÁVEL (nunca Supabase/produção).
//
// PULA sozinho sem CHECKLIST_PG_URL. Exige um banco LOCAL (127.0.0.1/localhost) e VAZIO — recusa qualquer outro (nada é apagado).
//   initdb -D <dir> -U postgres -A trust && pg_ctl -D <dir> -o "-p 55411" start && psql postgresql://postgres@127.0.0.1:55411/postgres -c "create database t_checklist"
//   CHECKLIST_PG_URL=postgresql://postgres@127.0.0.1:55411/t_checklist node --experimental-vm-modules --test test/checklist-operacional-pg.test.js
// Cria os papéis do Supabase e versões MÍNIMAS de organizacoes/unidades/modulos/organizacao_modulos/unidade_modulos (DDL igual à da base),
// aplica as migrations REAIS 101/102/103 (ifood_pedidos/ifood_eventos) e a do módulo, e roda o REPOSITÓRIO e o SERVICE REAIS do Checklist
// sobre linhas fictícias, por um adaptador mínimo `db` que executa SQL de verdade (o PostgREST não existe aqui).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.SUPABASE_URL ??= "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "teste";
process.env.SUPABASE_ANON_KEY ??= "teste";

const URL_PG = (process.env.CHECKLIST_PG_URL || "").trim();
const PSQL = process.env.CHECKLIST_PSQL || "psql";
const LOCAL = /^postgres(ql)?:\/\/[^@]*@?(127\.0\.0\.1|localhost)[:/]/.test(URL_PG);
const PULAR = !URL_PG ? "CHECKLIST_PG_URL ausente — precisa de um Postgres descartável (veja o cabeçalho). PULADO — não é falha."
  : !LOCAL ? "CHECKLIST_PG_URL não é local (127.0.0.1/localhost) — RECUSADO por segurança."
    : false;

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const MIG = path.join(AQUI, "..", "..", "database", "migrations");

const ORG_A = "a0000000-0000-4000-8000-00000000000a";   // tem iFood; duas unidades
const ORG_B = "b0000000-0000-4000-8000-00000000000b";   // outra empresa
const ORG_C = "c0000000-0000-4000-8000-00000000000c";   // sem iFood
const UN_A1 = "a1000000-0000-4000-8000-0000000000a1";   // integrada
const UN_A2 = "a2000000-0000-4000-8000-0000000000a2";   // mesma empresa, sem integração
const UN_B1 = "b1000000-0000-4000-8000-0000000000b1";
const UN_C1 = "c1000000-0000-4000-8000-0000000000c1";
const UN_ORFA = "d1000000-0000-4000-8000-0000000000d1"; // unidade com `ifood` cuja EMPRESA não tem (órfã)
const ORG_D = "d0000000-0000-4000-8000-00000000000d";

function psql(sql, { arquivo } = {}) {
  const args = [URL_PG, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-t", "-A", ...(arquivo ? ["-f", arquivo] : ["-c", sql])];
  const r = spawnSync(PSQL, args, { encoding: "utf8", timeout: 60_000, env: { ...process.env, PGOPTIONS: "-c lc_messages=C", PGCLIENTENCODING: "UTF8" } });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const ok = (sql, o) => { const r = psql(sql, o); assert.equal(r.ok, true, `${sql}\n${r.err}`); return r.out; };
const aplicar = (arquivo) => psql("", { arquivo: path.join(MIG, arquivo) });
const lit = (v) => (v == null ? "null" : typeof v === "boolean" || typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const ident = (c) => `"${String(c).replace(/"/g, "")}"`;
const linhasDe = (sql) => JSON.parse(ok(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t`));

/** Adaptador mínimo do cliente do Supabase que executa SQL real (só o que o repositório do Checklist usa). */
function dbPg() {
  return {
    from(tabela) {
      const f = { cols: "*", where: [], ordem: null, limite: null, head: false };
      const partes = (expr) => expr.split(/,(?![^(]*\))/);
      const cond = (c) => {
        const m = c.match(/^(\w+)\.(not\.in|is|eq)\.(.+)$/);
        const [, col, op, val] = m;
        if (op === "is") return `${ident(col)} is ${val}`;
        if (op === "eq") return `${ident(col)} = ${lit(val)}`;
        return `${ident(col)} not in (${val.replace(/[()]/g, "").split(",").map(lit).join(",")})`;
      };
      const q = {
        select(cols, opc) { f.cols = cols; f.head = opc?.head === true; return q; },
        eq: (c, v) => { f.where.push(`${ident(c)} = ${lit(v)}`); return q; },
        gte: (c, v) => { f.where.push(`${ident(c)} >= ${lit(v)}`); return q; },
        lt: (c, v) => { f.where.push(`${ident(c)} < ${lit(v)}`); return q; },
        or: (expr) => { f.where.push(`(${partes(expr).map(cond).join(" or ")})`); return q; },
        not: (c, op, v) => { assert.equal(op, "is"); f.where.push(`${ident(c)} is not ${v === true ? "true" : lit(v)}`); return q; },
        order: (c, { ascending = true } = {}) => { f.ordem = `${ident(c)} ${ascending ? "asc" : "desc"}`; return q; },
        limit: (n) => { f.limite = n; return q; },
        then(res, rej) {
          try {
            const w = f.where.length ? ` where ${f.where.join(" and ")}` : "";
            if (f.head) { res({ count: Number(ok(`select count(*) from ${tabela}${w}`)), error: null }); return; }
            const sql = `select ${f.cols} from ${tabela}${w}${f.ordem ? ` order by ${f.ordem}` : ""}${f.limite ? ` limit ${f.limite}` : ""}`;
            res({ data: linhasDe(sql), error: null });
          } catch (e) { rej ? rej(e) : res({ data: null, error: { message: e.message } }); }
        },
      };
      return q;
    },
  };
}

const minutos = (min) => new Date(Date.parse("2026-10-09T15:00:00.000Z") - min * 60_000).toISOString();
function inserirPedido({ org, un, id, display, status = "CONCLUDED", tipo = "DELIVERY", teste = false, criado = 60, extra = {} }) {
  const c = {
    organizacao_id: org, unidade_id: un, order_id: id, merchant_id: `m-${un.slice(0, 2)}`, display_id: display, status_oficial: status,
    status_oficial_em: status === "CONCLUDED" ? minutos(20) : null, order_type: tipo, delivery_by: "IFOOD", order_timing: "IMMEDIATE", is_test: teste,
    order_created_at: minutos(criado), placed_event_created_at: minutos(criado), confirmed_event_at: minutos(criado - 1), ready_event_at: minutos(criado - 11),
    dispatch_event_at: tipo === "DELIVERY" ? minutos(criado - 15) : null, primeiro_evento_em: minutos(criado), criado_em: minutos(criado), ...extra,
  };
  const cols = Object.keys(c);
  ok(`insert into ifood_pedidos (${cols.map(ident).join(",")}) values (${cols.map((k) => lit(c[k])).join(",")})`);
}

describe("Checklist Operacional — Postgres real e descartável", { skip: PULAR }, () => {
  let repo; let service; let repoChecklist;
  const db = dbPg();

  before(async () => {
    const vazio = ok("select count(*) from pg_tables where schemaname = 'public'");
    assert.equal(vazio, "0", "o banco precisa estar VAZIO (nada é apagado por este teste)");
    ok(`do $$ begin
          if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
          if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
          if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
        end $$;
        create table organizacoes (id uuid primary key);
        create table unidades (id uuid primary key, organizacao_id uuid not null references organizacoes(id));
        create table modulos (id text primary key, nome text not null, categoria text not null, ordem integer not null default 0, ativo boolean not null default true,
          created_at timestamptz not null default now(), constraint modulos_categoria_check check (categoria = any (array['operacao','integracao'])));
        create table organizacao_modulos (organizacao_id uuid not null references organizacoes(id) on delete cascade, modulo_id text not null references modulos(id) on delete cascade,
          habilitado_em timestamptz not null default now(), habilitado_por uuid, primary key (organizacao_id, modulo_id));
        create table unidade_modulos (unidade_id uuid not null references unidades(id) on delete cascade, modulo_id text not null references modulos(id) on delete cascade,
          habilitado_em timestamptz not null default now(), habilitado_por uuid, primary key (unidade_id, modulo_id));
        create table ifood_conexoes (id uuid primary key default gen_random_uuid(), organizacao_id uuid, unidade_id uuid, merchant_id text, status text);
        create table ifood_credenciais (id uuid primary key default gen_random_uuid(), app_type text, constraint ifood_credenciais_app_type_check check (app_type in ('analytics','financial')));
        create table ifood_oauth_sessoes (id uuid primary key default gen_random_uuid(), app_type text, constraint ifood_oauth_sessoes_app_type_check check (app_type in ('analytics','financial')));
        create or replace function ifood_touch_atualizado_em() returns trigger language plpgsql as $f$ begin new.atualizado_em = now(); return new; end $f$;`);
    for (const f of ["101_ifood_eventos.sql", "102_ifood_pedidos_detalhes_confirm.sql", "103_ifood_order_actions.sql"]) {
      const r = aplicar(f); assert.equal(r.ok, true, `${f}: ${r.err}`);
    }
    // Como no Supabase: os papéis da API recebem privilégios por padrão — o que protege é a RLS.
    ok("grant all on all tables in schema public to anon, authenticated, service_role; grant usage on schema public to anon, authenticated, service_role");
    ok(`insert into modulos (id, nome, categoria, ordem) values ('ifood','iFood','integracao',11), ('dashboard','Dashboard','operacao',1), ('sales','Vendas','operacao',5)`);
    ok(`insert into organizacoes values ('${ORG_A}'), ('${ORG_B}'), ('${ORG_C}'), ('${ORG_D}')`);
    ok(`insert into unidades values ('${UN_A1}','${ORG_A}'), ('${UN_A2}','${ORG_A}'), ('${UN_B1}','${ORG_B}'), ('${UN_C1}','${ORG_C}'), ('${UN_ORFA}','${ORG_D}')`);
    ok(`insert into organizacao_modulos (organizacao_id, modulo_id) values ('${ORG_A}','ifood'), ('${ORG_A}','dashboard'), ('${ORG_B}','ifood'), ('${ORG_C}','dashboard'), ('${ORG_C}','sales'), ('${ORG_D}','dashboard')`);
    ok(`insert into unidade_modulos (unidade_id, modulo_id) values ('${UN_A1}','ifood'), ('${UN_A1}','dashboard'), ('${UN_A2}','dashboard'), ('${UN_B1}','ifood'), ('${UN_C1}','dashboard'), ('${UN_ORFA}','ifood')`);

    inserirPedido({ org: ORG_A, un: UN_A1, id: "a1-1", display: "A101" });
    inserirPedido({ org: ORG_A, un: UN_A1, id: "a1-2", display: "A102" });
    inserirPedido({ org: ORG_A, un: UN_A1, id: "a1-3", display: "A103", tipo: "TAKEOUT" });
    inserirPedido({ org: ORG_A, un: UN_A1, id: "a1-t", display: "A1T", teste: true });
    inserirPedido({ org: ORG_A, un: UN_A1, id: "a1-aberto", display: "A1X", status: "DISPATCHED", criado: 30 });
    inserirPedido({ org: ORG_B, un: UN_B1, id: "b1-1", display: "B101" });
    inserirPedido({ org: ORG_B, un: UN_B1, id: "b1-2", display: "B102" });
    inserirPedido({ org: ORG_B, un: UN_B1, id: "b1-3", display: "B103" });

    repoChecklist = await import("../src/modules/checklist-operacional/checklistOperacional.repository.js");
    service = await import("../src/modules/checklist-operacional/checklistOperacional.service.js");
    repo = {
      ...repoChecklist,
      listarPedidosDaJanela: (a) => repoChecklist.listarPedidosDaJanela({ ...a, db }),
      contarAbertosAntesDe: (a) => repoChecklist.contarAbertosAntesDe({ ...a, db }),
    };
  });
  after(() => { /* o banco é descartável; nada a limpar */ });

  const AGORA = new Date("2026-10-09T15:00:00.000Z");
  const ifoodIntegrado = { obterConexaoViva: async () => ({ id: "c1", status: "ativa", merchant_id: "m-a1" }), listarCredenciaisDaConexao: async () => [{ app_type: "order", status: "ativa" }],
    obterObservabilidadeOrder: async () => ({ disponivel: true, ultimoEvento: minutos(1), eventosComFalha: 0, lease: { leaseAte: minutos(-60), atualizadoEm: minutos(0.2) } }) };
  const ifoodSem = { obterConexaoViva: async () => null, listarCredenciaisDaConexao: async () => [], obterObservabilidadeOrder: async () => null };
  const resumo = (org, un, ifood) => service.obterResumo({ organizacaoId: org, unidadeId: un, agora: () => AGORA, deps: { repo, ifoodRepo: ifood, pilotoOrder: () => false, env: {} } });

  describe("isolamento do repositório e do service (linhas reais)", () => {
    test("unidade integrada vê só os próprios pedidos e os tempos novos fecham (preparo 15 + entrega 25 = vida 40)", async () => {
      const r = await resumo(ORG_A, UN_A1, ifoodIntegrado);
      assert.equal(r.modo, "integrado");
      assert.equal(r.contagemDia.recebidos, 4, "A101, A102, A103 (retirada) e A1X; o de teste fica fora");
      assert.equal(r.contagemDia.teste, 1);
      const ids = r.ultimosPedidos.map((p) => p.displayId).sort();
      assert.deepEqual(ids, ["A101", "A102", "A103", "A1X"]);
      assert.ok(!JSON.stringify(r).match(/B10|b1-|m-b1/), "nenhum dado da outra empresa");
      assert.equal(r.indicadores.preparo.amostras, 3);   // A101, A102 e o já despachado A1X
      assert.equal(r.indicadores.entrega.amostras, 2);
      assert.equal(r.indicadores.vida.amostras, 2);
      assert.equal(r.indicadores.vida.decomposta.amostras, 2);
      assert.equal(r.indicadores.vida.decomposta.preparoMediaDia + r.indicadores.vida.decomposta.entregaMediaDia, r.indicadores.vida.decomposta.mediaDia);
      assert.equal(r.indicadores.vida.mediaDia, 40);
      const retirada = r.ultimosPedidos.find((p) => p.displayId === "A103");
      assert.deepEqual([retirada.tipo, retirada.preparoMin, retirada.entregaMin, retirada.vidaMin], ["TAKEOUT", null, null, null]);
    });

    test("MESMA empresa, outra unidade (sem integração): não enxerga nenhum pedido da integrada", async () => {
      const r = await resumo(ORG_A, UN_A2, ifoodSem);
      assert.equal(r.modo, "sem_integracao");
      assert.equal(r.contagemDia.recebidos, 0);
      assert.equal(r.ultimosPedidos.length, 0);
      assert.equal(r.pedidosAtivos.length, 0);
      assert.equal(r.semPedidosNoDia, true);
    });

    test("OUTRA empresa vê só os próprios pedidos", async () => {
      const r = await resumo(ORG_B, UN_B1, ifoodIntegrado);
      assert.equal(r.contagemDia.recebidos, 3);
      assert.deepEqual(r.ultimosPedidos.map((p) => p.displayId).sort(), ["B101", "B102", "B103"]);
      assert.ok(!JSON.stringify(r).match(/A10|a1-/));
    });

    test("ACESSO CRUZADO: unidade de uma empresa com o id de OUTRA empresa não devolve nada (par org+unidade sempre junto)", async () => {
      for (const [org, un] of [[ORG_B, UN_A1], [ORG_A, UN_B1], [ORG_C, UN_A1], [ORG_A, UN_C1]]) {
        const r = await resumo(org, un, ifoodSem);
        assert.equal(r.contagemDia.recebidos, 0, `${org.slice(0, 2)}/${un.slice(0, 2)}`);
        assert.equal(r.ultimosPedidos.length, 0);
      }
    });

    test("escopo ausente é recusado antes de qualquer consulta", async () => {
      await assert.rejects(() => repo.listarPedidosDaJanela({ organizacaoId: ORG_A, unidadeId: null, desdeIso: minutos(100) }));
      await assert.rejects(() => repo.contarAbertosAntesDe({ organizacaoId: null, unidadeId: UN_A1, antesIso: minutos(10) }));
    });

    test("pedidos abertos antigos só contam na unidade dona", async () => {
      inserirPedido({ org: ORG_B, un: UN_B1, id: "b1-velho", display: "B1V", status: "CONFIRMED", criado: 24 * 60 });
      const a = await repoChecklist.contarAbertosAntesDe({ organizacaoId: ORG_A, unidadeId: UN_A1, antesIso: minutos(10), db });
      const b = await repoChecklist.contarAbertosAntesDe({ organizacaoId: ORG_B, unidadeId: UN_B1, antesIso: minutos(10), db });
      assert.deepEqual([a, b], [1, 1]);   // A1X (DISPATCHED) e B1V (CONFIRMED); cada um na sua
      const cruzado = await repoChecklist.contarAbertosAntesDe({ organizacaoId: ORG_A, unidadeId: UN_B1, antesIso: minutos(10), db });
      assert.equal(cruzado, 0);
    });
  });

  describe("RLS: as chaves públicas do Supabase não leem os pedidos (só o backend/service_role)", () => {
    test("anon e authenticated não leem nem escrevem em ifood_pedidos; service_role lê", () => {
      for (const papel of ["anon", "authenticated"]) {
        assert.equal(ok(`set role ${papel}; select count(*) from ifood_pedidos`), "0", `${papel} não vê nenhuma linha (RLS sem política)`);
        const w = psql(`set role ${papel}; insert into ifood_pedidos (order_id, merchant_id, organizacao_id, unidade_id) values ('x','m','${ORG_A}','${UN_A1}')`);
        assert.equal(w.ok, false, `${papel} não pode inserir`);
      }
      assert.equal(Number(ok("set role service_role; select count(*) from ifood_pedidos")) >= 8, true);
    });
  });

  describe("migration do módulo checklist_operacional (dados existentes)", () => {
    const NOME = readdirSync(MIG).find((f) => /^\d+_checklist_operacional_modulo\.sql$/.test(f));
    const ROLL = NOME?.replace(/_checklist_operacional_modulo\.sql$/, "_rollback.sql");
    const orgsCom = (m) => ok(`select string_agg(organizacao_id::text, ',' order by organizacao_id) from organizacao_modulos where modulo_id = '${m}'`);
    const unisCom = (m) => ok(`select string_agg(unidade_id::text, ',' order by unidade_id) from unidade_modulos where modulo_id = '${m}'`);
    const total = (t) => Number(ok(`select count(*) from ${t}`));

    test("antes: o módulo não existe", () => {
      assert.ok(NOME, "migration do módulo presente");
      assert.equal(ok("select count(*) from modulos where id = 'checklist_operacional'"), "0");
    });

    test("aplica: catálogo + vínculos SÓ de quem já tem ifood (empresa e unidade); nada além", () => {
      const antesOrg = total("organizacao_modulos"); const antesUn = total("unidade_modulos");
      const r = aplicar(NOME); assert.equal(r.ok, true, r.err);
      assert.equal(ok("select nome || '|' || categoria || '|' || ordem from modulos where id = 'checklist_operacional'"), "Checklist Operacional|operacao|17");
      assert.equal(orgsCom("checklist_operacional"), orgsCom("ifood"), "empresas: exatamente as que têm ifood (A e B)");
      assert.equal(unisCom("checklist_operacional"), unisCom("ifood"), "unidades: exatamente as que têm ifood");
      assert.equal(total("organizacao_modulos") - antesOrg, 2);
      assert.equal(total("unidade_modulos") - antesUn, 3);
      // Ninguém mais ganhou o módulo: empresa C (dashboard/vendas), unidade A2 (só dashboard) e C1.
      assert.equal(ok(`select count(*) from organizacao_modulos where modulo_id = 'checklist_operacional' and organizacao_id in ('${ORG_C}','${ORG_D}')`), "0");
      assert.equal(ok(`select count(*) from unidade_modulos where modulo_id = 'checklist_operacional' and unidade_id in ('${UN_A2}','${UN_C1}')`), "0");
      // Os módulos existentes não mudaram.
      assert.equal(orgsCom("dashboard").split(",").length, 3);
    });

    test("acesso EFETIVO (empresa ∩ unidade): A1 e B1 ganham; A2, C1 não; a unidade órfã (empresa sem ifood) NÃO ganha", () => {
      const efetivos = ok(`select string_agg(um.unidade_id::text, ',' order by um.unidade_id) from unidade_modulos um
        join unidades u on u.id = um.unidade_id join organizacao_modulos om on om.organizacao_id = u.organizacao_id and om.modulo_id = um.modulo_id
        where um.modulo_id = 'checklist_operacional'`);
      assert.equal(efetivos, [UN_A1, UN_B1].sort().join(","));
    });

    test("idempotente: reaplicar não muda nada", () => {
      const o = total("organizacao_modulos"); const u = total("unidade_modulos"); const m = total("modulos");
      const r = aplicar(NOME); assert.equal(r.ok, true, r.err);
      assert.deepEqual([total("organizacao_modulos"), total("unidade_modulos"), total("modulos")], [o, u, m]);
    });

    test("rollback: remove só o módulo novo (vínculos e catálogo); ifood e demais módulos intactos; reaplicar funciona", () => {
      const ifoodOrg = orgsCom("ifood"); const ifoodUn = unisCom("ifood"); const dash = orgsCom("dashboard");
      const r = aplicar(ROLL); assert.equal(r.ok, true, r.err);
      assert.equal(ok("select count(*) from modulos where id = 'checklist_operacional'"), "0");
      assert.equal(ok("select count(*) from organizacao_modulos where modulo_id = 'checklist_operacional'"), "0");
      assert.equal(ok("select count(*) from unidade_modulos where modulo_id = 'checklist_operacional'"), "0");
      assert.deepEqual([orgsCom("ifood"), unisCom("ifood"), orgsCom("dashboard")], [ifoodOrg, ifoodUn, dash]);
      assert.equal(aplicar(ROLL).ok, true, "rollback idempotente");
      assert.equal(aplicar(NOME).ok, true, "reaplica depois do rollback");
      assert.equal(orgsCom("checklist_operacional"), ifoodOrg);
    });

    test("não toca em pedidos nem nas tabelas do iFood", () => {
      const n = total("ifood_pedidos");
      assert.equal(aplicar(NOME).ok, true);
      assert.equal(total("ifood_pedidos"), n);
    });
  });
});
