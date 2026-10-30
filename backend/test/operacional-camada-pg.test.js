// Dashboard Operacional 2.0 — migrations 129 (privilégios mínimos iFood) e 130 (camada operacional, fechamento, simulações)
// contra um Postgres REAL e DESCARTÁVEL. PULA sem OPERACIONAL_PG_URL; recusa banco que não seja local e vazio.
//   initdb -D <dir> -U postgres -A trust && pg_ctl -D <dir> -o "-p 55431" start
//   psql postgresql://postgres@127.0.0.1:55431/postgres -c "create database t_operacional"
//   OPERACIONAL_PG_URL=postgresql://postgres@127.0.0.1:55431/t_operacional node --test test/operacional-camada-pg.test.js
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const URL_PG = (process.env.OPERACIONAL_PG_URL || "").trim();
const PSQL = process.env.OPERACIONAL_PSQL || "psql";
const LOCAL = /^postgres(ql)?:\/\/[^@]*@?(127\.0\.0\.1|localhost)[:/]/.test(URL_PG);
const PULAR = !URL_PG ? "OPERACIONAL_PG_URL ausente — precisa de um Postgres descartável. PULADO — não é falha."
  : !LOCAL ? "OPERACIONAL_PG_URL não é local — RECUSADO por segurança." : false;

const MIG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "database", "migrations");
const ORG_A = "a0000000-0000-4000-8000-00000000000a";
const ORG_B = "b0000000-0000-4000-8000-00000000000b";
const UN_A1 = "a1000000-0000-4000-8000-0000000000a1";
const UN_B1 = "b1000000-0000-4000-8000-0000000000b1";

function psql(sql, { arquivo, papel } = {}) {
  const corpo = papel ? `set role ${papel}; ${sql}` : sql;
  const args = [URL_PG, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-t", "-A", ...(arquivo ? ["-f", arquivo] : ["-c", corpo])];
  const r = spawnSync(PSQL, args, { encoding: "utf8", timeout: 60_000, env: { ...process.env, PGOPTIONS: "-c lc_messages=C", PGCLIENTENCODING: "UTF8" } });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const ok = (sql, o) => { const r = psql(sql, o); assert.equal(r.ok, true, `${sql}\n${r.err}`); return r.out; };
const falha = (sql, re, o) => { const r = psql(sql, o); assert.equal(r.ok, false, `deveria falhar: ${sql}`); if (re) assert.match(r.err, re); return r.err; };
const aplicar = (f) => { const r = psql("", { arquivo: path.join(MIG, f) }); assert.equal(r.ok, true, `${f}: ${r.err}`); };

const registrar = ({ exec, status = "PRELIMINAR", hash = "h1", motivo = null, un = UN_A1, org = ORG_A, comp = "2026-10-27" }) =>
  `select resultado || '|' || versao_registrada || '|' || status_registrado from operacional_fechamento_registrar('${org}','${un}','${comp}','${status}','${exec}',1,'America/Sao_Paulo','padrao_plataforma','manual',null,${motivo ? `'${motivo}'` : "null"},'{}','{}','{}','{}','[]','${hash}')`;

describe("migrations 129/130 em Postgres real", { skip: PULAR }, () => {
  before(() => {
    assert.equal(ok("select count(*) from pg_tables where schemaname = 'public'"), "0", "o banco precisa estar VAZIO");
    ok(`do $$ begin
          if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
          if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
          if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
        end $$;
        create table organizacoes (id uuid primary key);
        create table unidades (id uuid primary key, organizacao_id uuid not null references organizacoes(id), updated_at timestamptz);
        create table ifood_conexoes (id uuid primary key default gen_random_uuid(), organizacao_id uuid, unidade_id uuid, merchant_id text, status text);
        create table ifood_credenciais (id uuid primary key default gen_random_uuid(), app_type text, constraint ifood_credenciais_app_type_check check (app_type in ('analytics','financial')));
        create table ifood_oauth_sessoes (id uuid primary key default gen_random_uuid(), app_type text, constraint ifood_oauth_sessoes_app_type_check check (app_type in ('analytics','financial')));
        create or replace function ifood_touch_atualizado_em() returns trigger language plpgsql as $f$ begin new.atualizado_em = now(); return new; end $f$;`);
    for (const f of ["101_ifood_eventos.sql", "102_ifood_pedidos_detalhes_confirm.sql", "103_ifood_order_actions.sql"]) aplicar(f);
    // Como no Supabase: os papéis da API recebem privilégios por padrão (é exatamente o que a 129 corrige).
    ok("grant all on all tables in schema public to anon, authenticated, service_role; grant usage on schema public to anon, authenticated, service_role");
    ok(`insert into organizacoes values ('${ORG_A}'), ('${ORG_B}'); insert into unidades (id, organizacao_id) values ('${UN_A1}','${ORG_A}'), ('${UN_B1}','${ORG_B}')`);
    aplicar("129_ifood_privilegios_minimos.sql");
    aplicar("130_operacional_camada_fechamento.sql");
  });

  test("129: anon/authenticated sem NENHUM privilégio nas tabelas iFood; service_role com S/I/U/D e sem TRUNCATE", () => {
    const tabelas = "'ifood_eventos','ifood_pedidos','ifood_disputas','ifood_pedido_acoes','ifood_poller_lease','ifood_credenciais','ifood_oauth_sessoes','ifood_conexoes'";
    assert.equal(ok(`select count(*) from information_schema.role_table_grants where table_schema='public' and table_name in (${tabelas}) and grantee in ('anon','authenticated','PUBLIC')`), "0");
    assert.equal(ok(`select string_agg(distinct privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_schema='public' and table_name in (${tabelas}) and grantee = 'service_role'`), "DELETE,INSERT,SELECT,UPDATE");
    falha("truncate ifood_eventos", /permission denied/, { papel: "anon" });
    falha("truncate ifood_pedidos", /permission denied/, { papel: "service_role" });
    falha("select 1 from ifood_pedidos", /permission denied/, { papel: "authenticated" });
    assert.equal(ok("select bool_and(relrowsecurity) from pg_class where relname in ('ifood_eventos','ifood_pedidos','ifood_disputas')"), "t", "RLS continua ligado");
  });

  test("129 e 130: rollback e reaplicação idempotentes", () => {
    aplicar("129_rollback.sql"); aplicar("129_ifood_privilegios_minimos.sql"); aplicar("129_ifood_privilegios_minimos.sql");
    assert.equal(ok("select count(*) from information_schema.role_table_grants where table_schema='public' and table_name like 'ifood_%' and grantee in ('anon','authenticated')"), "0");
    aplicar("130_operacional_camada_fechamento.sql");
  });

  test("130: RLS ligado, nenhum privilégio para anon/authenticated, service_role sem escrita direta em fechamentos", () => {
    assert.equal(ok("select bool_and(relrowsecurity) from pg_class where relname like 'operacional_%' and relkind='r'"), "t");
    assert.equal(ok("select count(*) from information_schema.role_table_grants where table_schema='public' and table_name like 'operacional_%' and grantee in ('anon','authenticated','PUBLIC')"), "0");
    falha("select 1 from operacional_pedidos", /permission denied/, { papel: "anon" });
    falha(`insert into operacional_fechamentos (organizacao_id, unidade_id, competencia, versao, status, execucao_id, regra_versao, fuso, fuso_origem, origem, fonte, cobertura, indicadores, diagnostico, hash_conteudo)
      values ('${ORG_A}','${UN_A1}','2026-10-01',1,'PRELIMINAR',gen_random_uuid(),1,'x','x','manual','{}','{}','{}','{}','h')`, /permission denied/, { papel: "service_role" });
    falha(`select * from operacional_fechamento_registrar('${ORG_A}','${UN_A1}','2026-10-01','PRELIMINAR',gen_random_uuid(),1,'x','x','manual',null,null,'{}','{}','{}','{}','[]','h')`, /permission denied/, { papel: "authenticated" });
  });

  test("RPC: versões, idempotência por execução e por conteúdo, regras de status", () => {
    const e = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    assert.equal(ok(registrar({ exec: e(1) }), { papel: "service_role" }), "REGISTRADO|1|PRELIMINAR");
    assert.equal(ok(registrar({ exec: e(1) }), { papel: "service_role" }), "JA_REGISTRADO|1|PRELIMINAR");
    assert.equal(ok(registrar({ exec: e(2) }), { papel: "service_role" }), "SEM_MUDANCA|1|PRELIMINAR");
    assert.equal(ok(registrar({ exec: e(3), status: "CONSOLIDADO", hash: "h2" }), { papel: "service_role" }), "REGISTRADO|2|CONSOLIDADO");
    falha(registrar({ exec: e(4), status: "PRELIMINAR", hash: "h3" }), /não volta a PRELIMINAR/, { papel: "service_role" });
    falha(registrar({ exec: e(5), status: "REVISADO", hash: "h3" }), /exige motivo/, { papel: "service_role" });
    assert.equal(ok(registrar({ exec: e(6), status: "REVISADO", hash: "h3", motivo: "correcao manual" }), { papel: "service_role" }), "REGISTRADO|3|REVISADO");   // ASCII: o -c do psql no Windows não vai em UTF-8
    assert.equal(ok("select substitui_id = (select id from operacional_fechamentos where versao = 2 and competencia='2026-10-27') from operacional_fechamentos where versao = 3 and competencia='2026-10-27'"), "t");
    falha(registrar({ exec: e(7), status: "REVISADO", hash: "x", motivo: "m", comp: "2026-10-20" }), /exige uma versão CONSOLIDADO/, { papel: "service_role" });
    falha(registrar({ exec: e(8), un: UN_B1 }), /fora da organização/, { papel: "service_role" });
    assert.equal(ok(registrar({ exec: e(9), status: "INCOMPLETO", hash: "h4" }), { papel: "service_role" }), "REGISTRADO|4|INCOMPLETO", "INCOMPLETO sempre pode ser registrado");
  });

  test("imutável: conteúdo não muda e nada é apagado; organizacao_id muda só com a unidade transferida", () => {
    falha("update operacional_fechamentos set indicadores = '{\"x\":1}' where versao = 1", /somente inclusão/);
    falha("delete from operacional_fechamentos where versao = 1", /somente inclusão/);
    falha(`update operacional_fechamentos set organizacao_id = '${ORG_B}' where competencia = '2026-10-27'`, /não pertence à organização/, { papel: "service_role" });
  });

  test("concorrência REAL: duas sessões ao mesmo tempo, mesmo conteúdo → uma versão; conteúdos diferentes → versões sequenciais sem colisão", async () => {
    const corre = (sql) => new Promise((resolve) => {
      const p = spawn(PSQL, [URL_PG, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", `set role service_role; ${sql}`], { env: { ...process.env, PGOPTIONS: "-c lc_messages=C" } });
      let out = ""; let err = "";
      p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
      p.on("close", (code) => resolve({ code, out: out.trim(), err }));
    });
    const lento = (exec, hash) => `select pg_sleep(0.3); ${registrar({ exec, hash, comp: "2026-10-26" })}`;
    const [a, b] = await Promise.all([corre(lento("10000000-0000-4000-8000-000000000001", "hc")), corre(lento("10000000-0000-4000-8000-000000000002", "hc"))]);
    assert.equal(a.code, 0, a.err); assert.equal(b.code, 0, b.err);
    assert.deepEqual([a.out.split("|")[0], b.out.split("|")[0]].sort(), ["REGISTRADO", "SEM_MUDANCA"]);
    const [c, d] = await Promise.all([corre(lento("10000000-0000-4000-8000-000000000003", "hd")), corre(lento("10000000-0000-4000-8000-000000000004", "he"))]);
    assert.equal(c.code, 0, c.err); assert.equal(d.code, 0, d.err);
    assert.equal(ok("select string_agg(versao::text, ',' order by versao) from operacional_fechamentos where competencia = '2026-10-26'"), "1,2,3");
  });

  test("simulações: transporte só 'noop' (CHECK), chave única, imutáveis", () => {
    const f = ok("select id from operacional_fechamentos where competencia = '2026-10-27' and versao = 1");
    const ins = (chave, transporte = "noop") => `insert into operacional_mensagens_simuladas (organizacao_id, unidade_id, fechamento_id, fechamento_versao, transporte, status, chave_idempotencia, mensagem) values ('${ORG_A}','${UN_A1}','${f}',1,'${transporte}','SIMULATED','${chave}','m')`;
    ok(ins("k1"), { papel: "service_role" });
    falha(ins("k1"), /uq_operacional_mensagens_simuladas_chave/, { papel: "service_role" });
    falha(ins("k2", "baileys"), /check/i, { papel: "service_role" });
    falha("update operacional_mensagens_simuladas set status = 'ERROR'", /somente inclusão|permission denied/, { papel: "service_role" });
    falha(`insert into operacional_mensagens_simuladas (organizacao_id, unidade_id, fechamento_id, fechamento_versao, status, chave_idempotencia) values ('${ORG_B}','${UN_A1}','${f}',1,'SIMULATED','k3')`, /não pertence/, { papel: "service_role" });
  });

  test("transferência de unidade: a função de remapeamento (054) roda como service_role sobre as tabelas novas", () => {
    ok(`create or replace function remapear_organizacao_em_tabelas_de_unidade(p_unidade_id uuid, p_org_antiga_id uuid, p_org_nova_id uuid) returns jsonb language plpgsql as $f$
      declare v_tabela text; v_qtd int; v_resultado jsonb := '{}'::jsonb;
      begin
        for v_tabela in select c1.table_name from information_schema.columns c1
          join information_schema.columns c2 on c2.table_schema = c1.table_schema and c2.table_name = c1.table_name and c2.column_name = 'unidade_id'
          join information_schema.tables t on t.table_schema = c1.table_schema and t.table_name = c1.table_name and t.table_type = 'BASE TABLE'
          where c1.table_schema = 'public' and c1.column_name = 'organizacao_id' and c1.table_name like 'operacional_%' order by c1.table_name
        loop
          execute format('update public.%I set organizacao_id = $1 where unidade_id = $2 and organizacao_id = $3', v_tabela) using p_org_nova_id, p_unidade_id, p_org_antiga_id;
          get diagnostics v_qtd = row_count;
          if v_qtd > 0 then v_resultado := v_resultado || jsonb_build_object(v_tabela, v_qtd); end if;
        end loop;
        return v_resultado;
      end $f$; grant execute on function remapear_organizacao_em_tabelas_de_unidade(uuid, uuid, uuid) to service_role; grant select, update on unidades to service_role;`);
    const r = ok(`update unidades set organizacao_id = '${ORG_B}' where id = '${UN_A1}'; select remapear_organizacao_em_tabelas_de_unidade('${UN_A1}', '${ORG_A}', '${ORG_B}')`, { papel: "service_role" });
    assert.match(r, /operacional_fechamentos/);
    assert.equal(ok(`select count(*) from operacional_fechamentos where unidade_id = '${UN_A1}' and organizacao_id = '${ORG_A}'`), "0");
  });

  test("130: rollback e reaplicação idempotentes", () => {
    aplicar("130_rollback.sql"); aplicar("130_rollback.sql");
    assert.equal(ok("select count(*) from pg_tables where tablename like 'operacional_%'"), "0");
    aplicar("130_operacional_camada_fechamento.sql");
    assert.equal(ok("select count(*) from pg_tables where tablename like 'operacional_%'"), "4");
  });
});
