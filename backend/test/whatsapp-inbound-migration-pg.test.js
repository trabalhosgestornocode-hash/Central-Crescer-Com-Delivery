// Checkpoint F — a MIGRATION 090 contra um Postgres REAL e DESCARTÁVEL (constraints, RLS/grants, função idempotente, rollback).
// PULA sozinho sem INBOUND_PG_URL (nunca roda contra Supabase/produção). Aponte para um banco VAZIO e descartável, por exemplo:
//   initdb -D <dir> -U postgres -A trust && pg_ctl -D <dir> -o "-p 55497" start
//   INBOUND_PG_URL=postgresql://postgres@127.0.0.1:55497/postgres node --test test/whatsapp-inbound-migration-pg.test.js
// O teste cria os papéis anon/authenticated/service_role e uma `organizacoes` mínima SE não existirem, aplica a 090, exercita e aplica o rollback.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const aqui = dirname(fileURLToPath(import.meta.url));
const URL_PG = (process.env.INBOUND_PG_URL || "").trim();
const PSQL = process.env.INBOUND_PSQL || "psql";
const motivoPular = URL_PG ? false : "INBOUND_PG_URL ausente — precisa de um Postgres descartável (veja o cabeçalho). PULADO — não é falha.";
const MIG = join(aqui, "..", "..", "database", "migrations");
const O1 = "11111111-1111-1111-1111-111111111111";
const O2 = "22222222-2222-2222-2222-222222222222";

function psql(sql, { arquivo } = {}) {
  const args = [URL_PG, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-t", "-A", ...(arquivo ? ["-f", arquivo] : ["-c", sql])];
  const r = spawnSync(PSQL, args, { encoding: "utf8", timeout: 60_000 });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const ok = (sql) => { const r = psql(sql); assert.equal(r.ok, true, `${sql}\n${r.err}`); return r.out; };
const falha = (sql, constraint) => { const r = psql(sql); assert.equal(r.ok, false, `deveria falhar: ${sql}`); if (constraint) assert.ok(r.err.includes(constraint), `esperava ${constraint}; veio: ${r.err}`); return r.err; };

/** INSERT direto (ignora a função) com valores padrão coerentes; `s` sobrescreve colunas. */
function ins(org, id, s = {}) {
  const v = { origem_tipo: "LIVE", origem_jid_tipo: "direct_pn", telefone_e164: "'+5511999990000'", telefone_origem: "'JID_PN'", from_me: "false", falha_decrypt: "false", motivo_falha_decrypt: "null", stub_sistema: "false", estado: "RECEIVED", ...s };
  const q = (x) => (typeof x === "string" && !/^('|null$|true$|false$)/.test(x) ? `'${x}'` : x);
  return `insert into whatsapp_inbound_mensagens (organizacao_id, provider_message_id, origem_tipo, origem_jid_tipo, telefone_e164, telefone_origem, from_me, falha_decrypt, motivo_falha_decrypt, stub_sistema, estado, recebido_em)
    values ('${org}', '${id}', ${q(v.origem_tipo)}, ${q(v.origem_jid_tipo)}, ${v.telefone_e164}, ${v.telefone_origem}, ${v.from_me}, ${v.falha_decrypt}, ${v.motivo_falha_decrypt}, ${v.stub_sistema}, ${q(v.estado)}, now())`;
}
const SEM_TEL = { telefone_e164: "null", telefone_origem: "null" };

describe("MIGRATION 090 em Postgres real e descartável", { skip: motivoPular }, () => {
  before(() => {
    ok(`do $$ begin
          if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
          if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
          if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
        end $$;`);
    // imita o Supabase: o service_role tem BYPASSRLS e recebe privilégios por DEFAULT PRIVILEGES no schema public (a migration não concede nada a ele explicitamente)
    ok(`alter role service_role bypassrls`);
    ok(`grant usage on schema public to service_role; alter default privileges in schema public grant all on tables to service_role; alter default privileges in schema public grant all on functions to service_role`);
    ok(`create table if not exists organizacoes (id uuid primary key default gen_random_uuid())`);
    ok(`insert into organizacoes (id) values ('${O1}'), ('${O2}') on conflict do nothing`);
    ok(`drop function if exists whatsapp_inbound_registrar(uuid, text, text, text, text, text, boolean, boolean, text, boolean, text, timestamptz); drop table if exists whatsapp_inbound_mensagens`);
    const r = psql("", { arquivo: join(MIG, "090_whatsapp_inbound_mensagens.sql") }); assert.equal(r.ok, true, r.err);
    // reaplicar é idempotente (if not exists / create or replace)
    const r2 = psql("", { arquivo: join(MIG, "090_whatsapp_inbound_mensagens.sql") }); assert.equal(r2.ok, true, r2.err);
  });
  after(() => { psql("", { arquivo: join(MIG, "090_rollback.sql") }); });

  test("RLS ligado, anon/authenticated/PUBLIC sem NENHUM privilégio na tabela; só service_role executa a função", () => {
    assert.equal(ok(`select relrowsecurity from pg_class where relname = 'whatsapp_inbound_mensagens'`), "t");
    assert.equal(ok(`select count(*) from information_schema.role_table_grants where table_name = 'whatsapp_inbound_mensagens' and grantee in ('anon','authenticated','PUBLIC')`), "0");
    const fn = "whatsapp_inbound_registrar(uuid, text, text, text, text, text, boolean, boolean, text, boolean, text, timestamptz)";
    assert.equal(ok(`select has_function_privilege('service_role', '${fn}', 'execute')`), "t");
    for (const papel of ["anon", "authenticated"]) assert.equal(ok(`select has_function_privilege('${papel}', '${fn}', 'execute')`), "f", papel);
    assert.equal(ok(`select count(*) from information_schema.columns where table_name = 'whatsapp_inbound_mensagens'`), "14");
  });

  test("função: insert idempotente e atômico — a duplicata devolve (false, estado JÁ gravado) e não altera nada; cross-org é outra linha", () => {
    const chamar = (org, id, estado = "RECEIVED", origem = "LIVE") => ok(`select inserido || ',' || estado_atual from whatsapp_inbound_registrar('${org}', '${id}', '${origem}', 'direct_pn', '+5511999990000', 'JID_PN', false, false, null, false, '${estado}', now())`);
    assert.equal(chamar(O1, "IDEMP-1"), "true,RECEIVED");
    assert.equal(chamar(O1, "IDEMP-1", "RECEIVED"), "false,RECEIVED");
    assert.equal(chamar(O1, "IDEMP-1", "IGNORED", "LIVE"), "false,RECEIVED", "a repetição não sobrescreve o estado");
    assert.equal(chamar(O2, "IDEMP-1"), "true,RECEIVED", "outra organização");
    assert.equal(ok(`select count(*) from whatsapp_inbound_mensagens where provider_message_id = 'IDEMP-1'`), "2");
  });

  test("a função também respeita os CHECKs: a função não é um atalho para gravar dado incoerente", () => {
    const chamar = (args) => `select * from whatsapp_inbound_registrar(${args})`;
    falha(chamar(`'${O1}', 'F-1', 'LIVE', 'direct_lid_other', '+100000000000001', 'JID_PN', false, false, null, false, 'RECEIVED', now()`), "whatsapp_inbound_telefone_coerente");
    falha(chamar(`'${O1}', 'F-2', 'OFFLINE_RECOVERY', 'direct_pn', '+5511999990000', 'JID_PN', false, false, null, false, 'RECEIVED', now()`), "whatsapp_inbound_estado_elegivel");
  });

  test("CHECK: LID de 15 dígitos NÃO vira telefone (23514 telefone_coerente), nem sem origem, nem com origem trocada; grupo/status/newsletter/broadcast com telefone falham", () => {
    falha(ins(O1, "L-1", { origem_jid_tipo: "direct_lid_other", telefone_e164: "'+100000000000001'", telefone_origem: "'JID_PN'" }), "whatsapp_inbound_telefone_coerente");
    falha(ins(O1, "L-2", { origem_jid_tipo: "direct_lid_other", telefone_e164: "'+100000000000001'", telefone_origem: "null" }), "whatsapp_inbound_telefone_par");
    falha(ins(O1, "L-3", { origem_jid_tipo: "direct_pn", telefone_origem: "'SENDER_PN'" }), "whatsapp_inbound_telefone_coerente");
    for (const t of ["group", "status", "newsletter", "broadcast", "meta_ai", "technical", "unknown", "direct_lid_self"]) falha(ins(O1, `G-${t}`, { origem_jid_tipo: t, estado: "IGNORED" }), "whatsapp_inbound_telefone_coerente");
    ok(ins(O1, "L-ok", { origem_jid_tipo: "direct_lid_other", telefone_origem: "'SENDER_PN'" }));
    ok(ins(O1, "L-ok2", { origem_jid_tipo: "direct_lid_other", ...SEM_TEL }));
  });

  test("CHECK: formato do telefone e do id, enums fechados, telefone com fromMe", () => {
    falha(ins(O1, "T-1", { telefone_e164: "'5511999990000'" }), "whatsapp_inbound_telefone_formato");
    falha(ins(O1, "T-2", { telefone_e164: "'+55 11 99999'" }), "whatsapp_inbound_telefone_formato");
    falha(ins(O1, "T-3", { from_me: "true", estado: "IGNORED" }), "whatsapp_inbound_telefone_coerente");
    falha(ins(O1, "id com espaco"), "whatsapp_inbound_id_formato"); falha(ins(O1, "x'; drop"), "");
    falha(ins(O1, "E-1", { origem_tipo: "recovery", estado: "IGNORED" }), "whatsapp_inbound_origem_tipo"); falha(ins(O1, "E-2", { origem_jid_tipo: "direct_lid", ...SEM_TEL, estado: "IGNORED" }), "whatsapp_inbound_jid_tipo");
    falha(ins(O1, "E-3", { estado: "OK" }), "whatsapp_inbound_estado");
    falha(ins(O1, "E-4", { falha_decrypt: "true", motivo_falha_decrypt: "'Bad MAC Error'", estado: "QUARANTINED" }), "whatsapp_inbound_motivo");
  });

  test("CHECK: falha ↔ motivo, falha e stub exclusivos, e a POLÍTICA DE ESTADO (recovery/fromMe/falha/offline nunca RECEIVED; HISTORICO só OFFLINE_NORMAL)", () => {
    falha(ins(O1, "P-1", { falha_decrypt: "true", estado: "QUARANTINED" }), "whatsapp_inbound_falha_motivo");
    falha(ins(O1, "P-2", { motivo_falha_decrypt: "'bad_mac'" }), "whatsapp_inbound_falha_motivo");
    falha(ins(O1, "P-3", { falha_decrypt: "true", motivo_falha_decrypt: "'bad_mac'", stub_sistema: "true", estado: "IGNORED" }), "whatsapp_inbound_falha_ou_stub");
    falha(ins(O1, "P-4", { origem_tipo: "OFFLINE_RECOVERY", estado: "RECEIVED" }), "whatsapp_inbound_estado_elegivel");
    falha(ins(O1, "P-5", { origem_tipo: "OFFLINE_NORMAL", estado: "RECEIVED" }), "whatsapp_inbound_estado_elegivel");
    falha(ins(O1, "P-6", { falha_decrypt: "true", motivo_falha_decrypt: "'bad_mac'", estado: "RECEIVED" }), "whatsapp_inbound_estado_elegivel");
    falha(ins(O1, "P-7", { origem_jid_tipo: "group", ...SEM_TEL, estado: "RECEIVED" }), "whatsapp_inbound_estado_elegivel");
    falha(ins(O1, "P-8", { stub_sistema: "true", estado: "RECEIVED" }), "whatsapp_inbound_estado_elegivel");
    falha(ins(O1, "P-9", { from_me: "true", ...SEM_TEL, estado: "QUARANTINED" }), "whatsapp_inbound_from_me_ignorado");
    falha(ins(O1, "P-10", { falha_decrypt: "true", motivo_falha_decrypt: "'bad_mac'", estado: "HISTORICO", origem_tipo: "OFFLINE_NORMAL" }), "");
    falha(ins(O1, "P-11", { origem_tipo: "LIVE", estado: "HISTORICO" }), "whatsapp_inbound_estado_historico");
    falha(ins(O1, "P-12", { origem_tipo: "OFFLINE_RECOVERY", estado: "PROCESSED" }), "");
    falha(ins(O1, "P-13", { estado: "PROCESSED", origem_tipo: "OFFLINE_NORMAL" }), "whatsapp_inbound_estado_elegivel");
    ok(ins(O1, "V-1", { origem_tipo: "LIVE", estado: "RECEIVED" }));
    ok(ins(O1, "V-2", { origem_tipo: "OFFLINE_NORMAL", estado: "HISTORICO" }));
    ok(ins(O1, "V-3", { origem_tipo: "OFFLINE_RECOVERY", estado: "QUARANTINED" }));
    ok(ins(O1, "V-4", { falha_decrypt: "true", motivo_falha_decrypt: "'sem_sessao'", estado: "QUARANTINED" }));
    ok(ins(O1, "V-5", { from_me: "true", ...SEM_TEL, estado: "IGNORED" }));
    ok(ins(O1, "V-6", { origem_jid_tipo: "group", ...SEM_TEL, estado: "IGNORED" }));
  });

  test("UNIQUE (organizacao_id, provider_message_id): inserir 2x na mesma org falha; organização inexistente falha (FK)", () => {
    ok(ins(O1, "U-1")); falha(ins(O1, "U-1"), "whatsapp_inbound_unico"); ok(ins(O2, "U-1"));
    falha(ins("99999999-9999-9999-9999-999999999999", "U-2"), "violates foreign key");
  });

  test("papéis: anon e authenticated NÃO leem, NÃO escrevem e NÃO executam a função; service_role executa", () => {
    for (const papel of ["anon", "authenticated"]) {
      falha(`set role ${papel}; select count(*) from whatsapp_inbound_mensagens`, "permission denied");
      falha(`set role ${papel}; ${ins(O1, `R-${papel}`)}`, "permission denied");
      falha(`set role ${papel}; select * from whatsapp_inbound_registrar('${O1}', 'R-fn', 'LIVE', 'direct_pn', null, null, false, false, null, false, 'RECEIVED', now())`, "permission denied");
    }
    assert.equal(ok(`set role service_role; select inserido from whatsapp_inbound_registrar('${O1}', 'R-svc', 'LIVE', 'direct_lid_other', null, null, false, false, null, false, 'RECEIVED', now())`).split("\n").pop(), "t");
  });

  test("a outbox não é tocada: nenhuma referência a comunicacao_* no banco por causa desta migration; rollback remove função e tabela", () => {
    assert.equal(ok(`select count(*) from pg_depend d join pg_class c on c.oid = d.refobjid where c.relname like 'comunicacao_%' and d.objid = 'whatsapp_inbound_mensagens'::regclass`), "0");
    const r = psql("", { arquivo: join(MIG, "090_rollback.sql") }); assert.equal(r.ok, true, r.err);
    assert.equal(ok(`select to_regclass('whatsapp_inbound_mensagens') is null`), "t");
    assert.equal(ok(`select count(*) from pg_proc where proname = 'whatsapp_inbound_registrar'`), "0");
    const r2 = psql("", { arquivo: join(MIG, "090_rollback.sql") }); assert.equal(r2.ok, true, "rollback idempotente");
  });
});
