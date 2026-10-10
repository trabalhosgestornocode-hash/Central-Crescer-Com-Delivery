// Migrations 112 e 113 (papel "Operador de Exibição") contra um Postgres LOCAL e DESCARTÁVEL.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55420/postgres node --test test/perfil-exibicao-migration-pg.test.js
//
// Prova: ordem de aplicação, idempotência, aplicação concorrente, rollback (e a trava do rollback da 112), que a 113
// só barra o papel de exibição em vínculo de EMPRESA, e que NENHUM dado existente muda. As migrations NÃO são aplicadas
// em lugar nenhum além do banco criado e derrubado por este teste. PULA sem a variável; recusa host não local.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { motivoPular, criarBancoDescartavel, sql, psqlSync, psqlAsync } from "./helpers/pg-descartavel.js";
import { SCHEMA_BASE } from "./helpers/schema-perfil-exibicao.js";

const MIG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "database", "migrations");
const M112 = join(MIG, "112_papel_operador_exibicao.sql"); const R112 = join(MIG, "112_rollback.sql");
const M113 = join(MIG, "113_papel_exibicao_somente_unidade.sql"); const R113 = join(MIG, "113_rollback.sql");

const ORG = "a0000000-0000-4000-8000-00000000000a";
const UNI = "a1000000-0000-4000-8000-0000000000a1";
const U1 = "11111111-1111-4111-8111-111111111111"; const U2 = "22222222-2222-4222-8222-222222222222"; const U3 = "33333333-3333-4333-8333-333333333333";

describe("MIGRATIONS 112/113 em Postgres real e descartável", { skip: motivoPular, timeout: 300_000 }, () => {
  let b;
  const q = (texto) => sql(b.url, texto);
  const aplicar = (arq) => psqlSync(b.url, "", { arquivo: arq });
  const rotulos = () => q("select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'papel_acesso'");
  const fotoDosDados = () => q(`select (select count(*) from usuarios_organizacoes) || '|' || (select count(*) from usuarios_unidades) || '|' ||
    (select coalesce(string_agg(papel::text, ',' order by id), '') from usuarios_organizacoes) || '|' ||
    (select md5(string_agg(c.column_name || c.data_type, ',' order by c.ordinal_position)) from information_schema.columns c where c.table_name in ('usuarios_organizacoes', 'usuarios_unidades'))`);

  before(() => {
    b = criarBancoDescartavel("perfil_exib_mig");
    q(SCHEMA_BASE);
    q(`insert into organizacoes (id, nome) values ('${ORG}', 'Empresa'); insert into unidades (id, organizacao_id, nome) values ('${UNI}', '${ORG}', 'Unidade');
       insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('${U1}', '${U1}', '${ORG}', 'unit_manager');
       insert into usuarios_unidades (usuario_id, perfil_id, unidade_id, papel) values ('${U1}', '${U1}', '${UNI}', 'viewer');`);
  });
  after(() => b?.derrubar());

  let fotoAntes;

  test("a 113 ANTES da 112 falha com erro claro de valor inexistente (a ordem importa) e não deixa nada pela metade", () => {
    fotoAntes = fotoDosDados();
    const r = aplicar(M113);
    assert.equal(r.ok, false);
    assert.match(r.err, /display_operator|invalid input value for enum/);
    assert.equal(q("select count(*) from pg_constraint where conname = 'uo_sem_papel_exibicao'"), "0", "a transação da 113 reverteu");
    assert.equal(fotoDosDados(), fotoAntes);
  });

  test("112: acrescenta SÓ o valor ao enum, mantém os anteriores e a ordem, e não altera nenhum dado nem coluna", () => {
    const antes = rotulos();
    const r = aplicar(M112);
    assert.equal(r.ok, true, r.err);
    assert.equal(rotulos(), `${antes},display_operator`);
    assert.equal(fotoDosDados(), fotoAntes, "nenhuma linha/coluna das tabelas de vínculo mudou");
  });

  test("112 é idempotente: reaplicar não falha e não duplica o valor", () => {
    for (let i = 0; i < 3; i++) assert.equal(aplicar(M112).ok, true);
    assert.equal(q("select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'papel_acesso' and e.enumlabel = 'display_operator'"), "1");
  });

  test("o valor novo já é utilizável logo depois (em unidade) — e ainda NÃO barrado em empresa (a 113 não rodou)", () => {
    q(`insert into usuarios_unidades (usuario_id, perfil_id, unidade_id, papel) values ('${U2}', '${U2}', '${UNI}', 'display_operator')`);
    q(`insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('${U3}', '${U3}', '${ORG}', 'display_operator')`);
    q(`delete from usuarios_organizacoes where usuario_id = '${U3}'`);
  });

  test("113: barra o papel de exibição em vínculo de EMPRESA e não toca em nada além da constraint", () => {
    const antes = fotoDosDados();
    const r = aplicar(M113);
    assert.equal(r.ok, true, r.err);
    assert.equal(fotoDosDados().split("|").slice(0, 2).join("|"), antes.split("|").slice(0, 2).join("|"), "contagens iguais");
    assert.equal(q("select count(*) from pg_constraint where conname = 'uo_sem_papel_exibicao'"), "1");
    const r2 = psqlSync(b.url, `insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('${U3}', '${U3}', '${ORG}', 'display_operator')`);
    assert.equal(r2.ok, false);
    assert.match(r2.err, /uo_sem_papel_exibicao/);
    // atualizar um vínculo de empresa EXISTENTE para o papel de exibição também é barrado
    const r3 = psqlSync(b.url, `update usuarios_organizacoes set papel = 'display_operator' where usuario_id = '${U1}'`);
    assert.equal(r3.ok, false);
  });

  test("113 NÃO atrapalha nenhum outro papel de empresa nem o papel de exibição em unidade", () => {
    let i = 0;
    for (const papel of ["organization_admin", "unit_manager", "finance", "operations", "viewer"]) {
      const u = `4444444${i++}-4444-4444-8444-444444444444`;
      q(`insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('${u}', '${u}', '${ORG}', '${papel}')`);
    }
    const r = psqlSync(b.url, `insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('55555555-5555-4555-8555-555555555555', '55555555-5555-4555-8555-555555555555', '${ORG}', 'platform_superadmin')`);
    assert.equal(r.ok, false, "a regra antiga (superadmin nunca é de vínculo) continua valendo");
    assert.match(r.err, /uo_papel_valido/);
  });

  test("113 é idempotente e segura sob aplicação SIMULTÂNEA (advisory lock): ambas terminam sem erro", async () => {
    for (let i = 0; i < 2; i++) assert.equal(aplicar(M113).ok, true);
    q("alter table usuarios_organizacoes drop constraint uo_sem_papel_exibicao");
    for (let rodada = 0; rodada < 3; rodada++) {
      const conteudo = readFileSync(M113, "utf8");
      const [a, c] = await Promise.all([psqlAsync(b.url, conteudo), psqlAsync(b.url, conteudo)]);
      assert.equal(a.ok && c.ok, true, `${a.err} | ${c.err}`);
      assert.equal(q("select count(*) from pg_constraint where conname = 'uo_sem_papel_exibicao'"), "1");
      q("alter table usuarios_organizacoes drop constraint uo_sem_papel_exibicao");
    }
    assert.equal(aplicar(M113).ok, true);
  });

  test("rollback da 113: remove só a constraint; os dados ficam; reaplicar funciona", () => {
    const antes = fotoDosDados();
    assert.equal(aplicar(R113).ok, true);
    assert.equal(q("select count(*) from pg_constraint where conname = 'uo_sem_papel_exibicao'"), "0");
    assert.equal(fotoDosDados(), antes);
    assert.equal(aplicar(R113).ok, true, "rollback repetido não falha");
    assert.equal(aplicar(M113).ok, true);
  });

  test("rollback da 112 ABORTA enquanto alguém usa o papel (e diz quantos) e nada é alterado", () => {
    const antes = fotoDosDados();
    const r = aplicar(R112);
    assert.equal(r.ok, false);
    assert.match(r.err, /ROLLBACK 112 abortado: 1 vínculo\(s\) de unidade e 0 de empresa/);
    assert.equal(fotoDosDados(), antes);
  });

  test("rollback da 112 passa quando ninguém usa o papel; o valor permanece no enum (o Postgres não remove valores)", () => {
    q(`delete from usuarios_unidades where papel::text = 'display_operator'`);
    const r = aplicar(R112);
    assert.equal(r.ok, true, r.err);
    assert.match(r.err, /Nenhum vínculo usa display_operator/);
    assert.match(rotulos(), /display_operator$/);
  });

  test("rollback da 112 funciona até com o valor AUSENTE (compara por texto, sem erro de tipo)", () => {
    const b2 = criarBancoDescartavel("perfil_exib_mig2");
    try {
      sql(b2.url, SCHEMA_BASE);
      const r = psqlSync(b2.url, "", { arquivo: R112 });
      assert.equal(r.ok, true, r.err);
    } finally { b2.derrubar(); }
  });

  test("reaplicação completa depois dos rollbacks: 112 + 113 de novo e o papel volta a funcionar", () => {
    assert.equal(aplicar(R113).ok, true);
    assert.equal(aplicar(M112).ok, true);
    assert.equal(aplicar(M113).ok, true);
    q(`insert into usuarios_unidades (usuario_id, perfil_id, unidade_id, papel) values ('66666666-6666-4666-8666-666666666666', '66666666-6666-4666-8666-666666666666', '${UNI}', 'display_operator')`);
    assert.equal(psqlSync(b.url, `insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('77777777-7777-4777-8777-777777777777', '77777777-7777-4777-8777-777777777777', '${ORG}', 'display_operator')`).ok, false);
  });
});

describe("migrations 112/113 — verificações estáticas (sem banco)", () => {
  const ler = (f) => readFileSync(f, "utf8");
  const semComentarios = (s) => s.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join("\n");

  test("112: um único ALTER TYPE ... ADD VALUE IF NOT EXISTS, sem begin/commit e sem nada destrutivo", () => {
    const sqlLimpo = semComentarios(ler(M112)).trim();
    assert.equal(sqlLimpo, "alter type papel_acesso add value if not exists 'display_operator';");
    assert.match(ler(M112), /NÃO APLICAR EM PRODUÇÃO SEM APROVAÇÃO EXPLÍCITA/);
  });

  test("113: transacional, só adiciona UMA constraint de usuarios_organizacoes, com trava contra aplicação concorrente", () => {
    const s = semComentarios(ler(M113));
    assert.match(s, /^begin;$/m); assert.match(s, /^commit;$/m);
    assert.match(s, /pg_advisory_xact_lock/);
    assert.match(s, /set local lock_timeout = '5s'/);
    assert.match(s, /create unique index if not exists uq_usuarios_unidades_exibicao_unica\s+on usuarios_unidades \(usuario_id\) where papel = 'display_operator'::papel_acesso/);
    assert.equal((s.match(/alter table/gi) ?? []).length, 1);
    assert.match(s, /alter table usuarios_organizacoes\s+add constraint uo_sem_papel_exibicao check \(papel <> 'display_operator'::papel_acesso\)/);
    assert.doesNotMatch(s, /\b(drop|delete|truncate|update|insert)\b/i);
    assert.match(ler(M113), /NÃO APLICAR EM PRODUÇÃO SEM APROVAÇÃO EXPLÍCITA/);
  });

  test("rollbacks: o da 113 só derruba a constraint; o da 112 só confere (nada é apagado ou alterado)", () => {
    const r113 = semComentarios(ler(R113));
    assert.match(r113, /drop constraint if exists uo_sem_papel_exibicao/);
    assert.match(r113, /drop index if exists uq_usuarios_unidades_exibicao_unica/);
    assert.doesNotMatch(r113, /\b(delete|truncate|update|insert)\b/i);
    const r112 = semComentarios(ler(R112));
    assert.doesNotMatch(r112, /\b(drop|delete|truncate|update|insert|alter)\b/i);
    assert.match(r112, /raise exception 'ROLLBACK 112 abortado/);
  });
});
