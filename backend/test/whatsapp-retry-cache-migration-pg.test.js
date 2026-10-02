// MIGRATION 105 (cache de retry do WhatsApp) contra um Postgres REAL e DESCARTÁVEL — constraints, RLS/grants, fencing,
// isolamento entre organizações, idempotência, consumo atômico com teto, TTL, limpeza, rollback, e a garantia de que
// whatsapp_conexoes (auth state/credenciais) NÃO é alterada.
// PULA sozinho sem RETRY_CACHE_PG_URL (nunca roda contra Supabase/produção). Aponte para um banco VAZIO e descartável:
//   initdb -D <dir> -U postgres -A trust && pg_ctl -D <dir> -o "-p 55498" start
//   RETRY_CACHE_PG_URL=postgresql://postgres@127.0.0.1:55498/postgres node --test test/whatsapp-retry-cache-migration-pg.test.js
// O teste cria os papéis do Supabase (anon/authenticated/service_role), uma `organizacoes` mínima e um set_updated_at()
// stub SE não existirem, aplica as migrations REAIS 083 e 084 (whatsapp_conexoes + lease) e depois a 105.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const aqui = dirname(fileURLToPath(import.meta.url));
const URL_PG = (process.env.RETRY_CACHE_PG_URL || "").trim();
const PSQL = process.env.RETRY_CACHE_PSQL || "psql";
const motivoPular = URL_PG ? false : "RETRY_CACHE_PG_URL ausente — precisa de um Postgres descartável (veja o cabeçalho). PULADO — não é falha.";
const MIG = join(aqui, "..", "..", "database", "migrations");
const O1 = "11111111-1111-1111-1111-111111111111";
const O2 = "22222222-2222-2222-2222-222222222222";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID = "3EB0ABCDEF0123456789AB";
const H = "a".repeat(64);
const PAYLOAD = "r1:AQEBAQEBAQEBAQEB:AgICAgICAgICAgICAgICAg==:Y2lwaGVydGV4dA==";

function psql(sql, { arquivo } = {}) {
  const args = [URL_PG, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", "|", ...(arquivo ? ["-f", arquivo] : ["-c", sql])];
  const r = spawnSync(PSQL, args, { encoding: "utf8", timeout: 60_000, env: { ...process.env, PGOPTIONS: "-c lc_messages=C", PGCLIENTENCODING: "UTF8" } });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const ok = (sql) => { const r = psql(sql); assert.equal(r.ok, true, `${sql}\n${r.err}`); return r.out; };
const falha = (sql, trecho) => { const r = psql(sql); assert.equal(r.ok, false, `deveria falhar: ${sql}`); if (trecho) assert.ok(r.err.includes(trecho), `esperava ${trecho}; veio: ${r.err}`); return r.err; };
const aplicar = (arquivo) => { const r = psql("", { arquivo: join(MIG, arquivo) }); assert.equal(r.ok, true, `${arquivo}: ${r.err}`); };

const gravar = (org, proc, epoch, { id = ID, payload = PAYLOAD, hash = H, lid = "null", ttl = 604800, max = 3 } = {}) =>
  `select resultado from whatsapp_retry_cache_gravar('${org}', 'default', '${proc}', ${epoch}, '${id}', '${payload}', 'r1', '${hash}', ${lid}, ${ttl}, ${max})`;
const consumir = (org, proc, epoch, id = ID) =>
  `select resultado || '|' || coalesce(payload_cifrado, '-') || '|' || coalesce(reenvios::text, '-') from whatsapp_retry_cache_consumir('${org}', 'default', '${proc}', ${epoch}, '${id}')`;
const colunasConexoes = () => ok(`select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by column_name) from information_schema.columns where table_name = 'whatsapp_conexoes'`);

describe("MIGRATION 105 em Postgres real e descartável", { skip: motivoPular }, () => {
  let e1; let e2; let colunasAntes; let authAntes;

  before(() => {
    ok(`do $$ begin
          if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
          if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
          if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
        end $$;`);
    ok(`alter role service_role bypassrls`);
    ok(`grant usage on schema public to service_role; alter default privileges in schema public grant all on tables to service_role; alter default privileges in schema public grant all on functions to service_role`);
    ok(`create table if not exists organizacoes (id uuid primary key default gen_random_uuid())`);
    ok(`create or replace function set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$`);
    ok(`insert into organizacoes (id) values ('${O1}'), ('${O2}') on conflict do nothing`);
    psql("", { arquivo: join(MIG, "105_rollback.sql") });
    ok(`drop table if exists whatsapp_conexoes cascade`);
    aplicar("083_whatsapp_conexoes.sql");
    aplicar("084_whatsapp_conexoes_lease.sql");
    e1 = Number(ok(`select lease_epoch from whatsapp_lease_acquire('${O1}', 'default', '${P1}', 300000)`));
    e2 = Number(ok(`select lease_epoch from whatsapp_lease_acquire('${O2}', 'default', '${P2}', 300000)`));
    ok(`update whatsapp_conexoes set auth_state_encrypted = 'v1:SESSAO-INTOCAVEL', auth_state_version = 'v1' where organizacao_id = '${O1}'`);
    colunasAntes = colunasConexoes();
    authAntes = ok(`select md5(auth_state_encrypted) from whatsapp_conexoes where organizacao_id = '${O1}'`);
    aplicar("105_whatsapp_retry_cache.sql");
    aplicar("105_whatsapp_retry_cache.sql"); // reaplicar é idempotente
  });
  after(() => { psql("", { arquivo: join(MIG, "105_rollback.sql") }); });

  test("20. whatsapp_conexoes NÃO muda: mesmas colunas e o auth state cifrado intacto", () => {
    assert.equal(colunasConexoes(), colunasAntes);
    assert.equal(ok(`select md5(auth_state_encrypted) from whatsapp_conexoes where organizacao_id = '${O1}'`), authAntes);
  });

  test("RLS ligado; anon/authenticated/PUBLIC sem privilégio na tabela nem nas funções; service_role executa", () => {
    assert.equal(ok(`select relrowsecurity from pg_class where relname = 'whatsapp_retry_cache'`), "t");
    assert.equal(ok(`select count(*) from information_schema.role_table_grants where table_name = 'whatsapp_retry_cache' and grantee in ('anon','authenticated','PUBLIC')`), "0");
    for (const fn of ["whatsapp_retry_cache_gravar(uuid, text, text, bigint, text, text, text, text, text, integer, integer)", "whatsapp_retry_cache_consumir(uuid, text, text, bigint, text)", "whatsapp_retry_cache_limpar(integer)"]) {
      for (const papel of ["anon", "authenticated"]) assert.equal(ok(`select has_function_privilege('${papel}', '${fn}', 'execute')`), "f", `${papel} × ${fn}`);
      assert.equal(ok(`select has_function_privilege('service_role', '${fn}', 'execute')`), "t");
    }
    falha(`set role anon; ${consumir(O1, P1, e1)}`, "permission denied");
    assert.equal(ok(`set role service_role; ${gravar(O1, P1, e1, { id: "3EB0PAPELSERVICE0000001" })}`), "GRAVADO");
  });

  test("fencing: dono errado/epoch velho ⇒ LEASE_STALE, nada gravado; dono certo ⇒ GRAVADO", () => {
    assert.equal(ok(gravar(O1, P2, e1)), "LEASE_STALE");
    assert.equal(ok(gravar(O1, P1, e1 - 1)), "LEASE_STALE");
    assert.equal(ok(`select count(*) from whatsapp_retry_cache where provider_message_id = '${ID}'`), "0");
    assert.equal(ok(gravar(O1, P1, e1)), "GRAVADO");
    assert.equal(ok(consumir(O1, P2, e1)).split("|")[0], "LEASE_STALE");
  });

  test("7. isolamento: a organização 2 (com a lease DELA) não enxerga o id da organização 1", () => {
    ok(gravar(O1, P1, e1, { id: "3EB0ISOLAMENTO000000001" }));
    assert.equal(ok(consumir(O2, P2, e2, "3EB0ISOLAMENTO000000001")).split("|")[0], "NAO_ENCONTRADA");
    assert.equal(ok(gravar(O2, P2, e2, { id: "3EB0ISOLAMENTO000000001", payload: PAYLOAD.replace("Y2lw", "T1VU") })), "GRAVADO");
    assert.equal(ok(consumir(O1, P1, e1, "3EB0ISOLAMENTO000000001")).split("|")[1], PAYLOAD);
  });

  test("idempotência: regravar NÃO sobrescreve; consumo conta até o teto e então ESGOTADA sem payload", () => {
    const id = "3EB0IDEMPOTENTE00000001";
    assert.equal(ok(gravar(O1, P1, e1, { id, max: 2 })), "GRAVADO");
    assert.equal(ok(gravar(O1, P1, e1, { id, payload: PAYLOAD.replace("Y2lw", "T1VU") })), "JA_EXISTIA");
    assert.deepEqual(ok(consumir(O1, P1, e1, id)).split("|"), ["OK", PAYLOAD, "1"]);
    assert.deepEqual(ok(consumir(O1, P1, e1, id)).split("|"), ["OK", PAYLOAD, "2"]);
    assert.deepEqual(ok(consumir(O1, P1, e1, id)).split("|"), ["ESGOTADA", "-", "2"]);
  });

  test("TTL: expirada ⇒ EXPIRADA (e apagada) ⇒ NAO_ENCONTRADA; faixa de TTL imposta (1 h..30 dias)", () => {
    const id = "3EB0EXPIRADA00000000001";
    ok(gravar(O1, P1, e1, { id }));
    ok(`update whatsapp_retry_cache set created_at = now() - interval '9 days', expires_at = now() - interval '1 second' where provider_message_id = '${id}'`);
    assert.equal(ok(consumir(O1, P1, e1, id)).split("|")[0], "EXPIRADA");
    assert.equal(ok(consumir(O1, P1, e1, id)).split("|")[0], "NAO_ENCONTRADA");
    falha(gravar(O1, P1, e1, { id: "3EB0TTLCURTO0000000001", ttl: 60 }), "fora da faixa");
    falha(gravar(O1, P1, e1, { id: "3EB0TTLLONGO0000000001", ttl: 2592001 }), "fora da faixa");
  });

  test("CHECKs: texto em claro, hash não-hex, id malformado e teto fora da faixa são recusados pelo BANCO", () => {
    falha(gravar(O1, P1, e1, { id: "3EB0CLARO0000000000001", payload: "alerta em texto claro" }), "whatsapp_retry_cache_payload_formato");
    falha(gravar(O1, P1, e1, { id: "3EB0HASH00000000000001", hash: "5511987654321" }), "whatsapp_retry_cache_destino_formato");
    falha(gravar(O1, P1, e1, { id: "id com espaco" }), "whatsapp_retry_cache_id_formato");
    falha(gravar(O1, P1, e1, { id: "3EB0MAX000000000000001", max: 0 }), "whatsapp_retry_cache_reenvios");
  });

  test("12. limpeza: gravar apaga expiradas (oportunista) e whatsapp_retry_cache_limpar() só apaga expiradas", () => {
    ok(gravar(O1, P1, e1, { id: "3EB0LIMPA0000000000001" }));
    ok(gravar(O1, P1, e1, { id: "3EB0LIMPA0000000000002" }));
    ok(`update whatsapp_retry_cache set created_at = now() - interval '9 days', expires_at = now() - interval '1 second' where provider_message_id = '3EB0LIMPA0000000000001'`);
    ok(gravar(O1, P1, e1, { id: "3EB0LIMPA0000000000003" }));
    assert.equal(ok(`select count(*) from whatsapp_retry_cache where provider_message_id = '3EB0LIMPA0000000000001'`), "0", "oportunista");
    ok(`update whatsapp_retry_cache set created_at = now() - interval '9 days', expires_at = now() - interval '1 second' where provider_message_id = '3EB0LIMPA0000000000002'`);
    assert.equal(ok(`select whatsapp_retry_cache_limpar(1000)`), "1");
    assert.equal(ok(`select count(*) from whatsapp_retry_cache where provider_message_id = '3EB0LIMPA0000000000003'`), "1", "a válida fica");
  });

  test("rollback remove SÓ o cache: tabela/funções somem, whatsapp_conexoes e o auth state ficam", () => {
    aplicar("105_rollback.sql");
    assert.equal(ok(`select count(*) from pg_class where relname = 'whatsapp_retry_cache'`), "0");
    assert.equal(ok(`select count(*) from pg_proc where proname like 'whatsapp_retry_cache%'`), "0");
    assert.equal(colunasConexoes(), colunasAntes);
    assert.equal(ok(`select md5(auth_state_encrypted) from whatsapp_conexoes where organizacao_id = '${O1}'`), authAntes);
    aplicar("105_whatsapp_retry_cache.sql"); // e pode ser reaplicada
  });
});
