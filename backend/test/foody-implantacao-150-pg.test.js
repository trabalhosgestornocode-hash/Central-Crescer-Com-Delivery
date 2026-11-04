// ENSAIO do kit da migration 150 num Postgres LOCAL e DESCARTÁVEL: schema real até a 149 + histórico supabase_migrations com
// 147–149 registradas (como em produção). Pré-voo, recusa por duplicidade, aplicação atômica, unicidade real, reaplicação recusada,
// lock, recuperação (dados intactos) e reaplicação. Nunca fala com Supabase: só 127.0.0.1.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { criarBancoDescartavel, motivoPular, psqlSync, psqlAsync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal } from "./helpers/schema-real-pg.js";

const { executar, gerarPacote, sqlEnsaio, SHA_ESPERADO, avaliarPrevoo, NOME, INDICE } = await import("../testes-seguros/foody-150/kit150.mjs");

const ORG = "0b000000-0000-4000-8000-000000000001", UNI = "0b000000-0000-4000-8000-0000000000a1", UNI2 = "0b000000-0000-4000-8000-0000000000a2";
const HISTORICO = `
  create schema if not exists supabase_migrations;
  create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text, created_by text,
    idempotency_key text unique, rollback text[]);
  insert into supabase_migrations.schema_migrations (version, name) values
    ('20261104120000', '147_foody_camada_central'), ('20261104120001', '148_foody_conexao_compartilhada'),
    ('20261104120002', '149_foody_conexao_administracao');`;

describe("migration 150 — kit de implantação em Postgres real", { skip: motivoPular, timeout: 600_000 }, () => {
  let b, env, cx;
  const q = (s) => { const r = psqlSync(b.url, s); assert.ok(r.ok, r.err); return r.out.split(/\r?\n/).pop(); };
  const rodar = (modo, extra = {}) => { try { return { ok: true, r: executar(modo, { ...env, ...extra }, () => {}) }; } catch (e) { return { ok: false, msg: e.message }; } };
  const execucao = (uni, status = "EM_ANDAMENTO", inicio = "now()") => q(`insert into foody_sync_execucoes (organizacao_id, unidade_id, conexao_id, competencia,
      janela_inicio, janela_fim, origem, regra_versao, status, iniciado_em) values ('${ORG}', '${uni}', '${cx[uni]}', current_date, now(), now() + interval '1 day', 'manual', 1, '${status}', ${inicio}) returning id;`);

  before(() => {
    b = criarBancoDescartavel("foody150kit");
    assert.deepEqual(construirSchemaReal(b.url, { ate: 149 }), []);
    assert.equal(psqlSync(b.url, HISTORICO).ok, true);
    q(`insert into organizacoes (id, nome) values ('${ORG}', 'Org'); insert into unidades (id, organizacao_id, nome) values ('${UNI}', '${ORG}', 'U1'), ('${UNI2}', '${ORG}', 'U2');`);
    cx = {};
    for (const [u, t] of [[UNI, "a"], [UNI2, "b"]]) {
      // conexão mínima direto no banco (valores FICTÍCIOS no formato das constraints; nenhum token real)
      cx[u] = q(`insert into foody_conexoes (organizacao_id, unidade_id, token_cifrado, token_impressao, status)
        values ('${ORG}', '${u}', 'k1:ficticio-${t}', '${t.repeat(12)}', 'PAUSADA') returning id;`);
    }
    env = { FOODY_ALVO: "local", FOODY_ENSAIO_LOCAL: "1", FOODY_CONN: b.url, FOODY_EVIDENCIAS: mkdtempSync(join(tmpdir(), "foody150-evid-")) };
  });
  after(() => b?.derrubar());

  test("kit: SHA-256 fixado, determinístico, UMA transação, guarda o texto original da 150 e a recuperação só mexe no índice/registro", () => {
    const k = gerarPacote();
    for (const [n, s] of Object.entries(SHA_ESPERADO)) assert.equal(k.sha[n], s, `${n}: atualize SHA_ESPERADO em kit150.mjs`);
    assert.deepEqual(gerarPacote().sha, k.sha);
    const ap = k.arquivos["aplicar_150.sql"].replace(/\$foody150\$[\s\S]*?\$foody150\$/g, "''");
    assert.equal((ap.match(/^begin;$/gm) ?? []).length, 1); assert.equal((ap.match(/^commit;$/gm) ?? []).length, 1);
    const rec = k.arquivos["recuperar_150.sql"];
    assert.doesNotMatch(rec, /\b(update|truncate|drop table|alter table)\b/i);
    assert.match(rec, /drop index if exists public\.foody_sync_execucoes_uma_em_andamento/);
    assert.doesNotMatch(k.arquivos["leitura_150.sql"], /token_cifrado|token_impressao/, "pré-voo nunca lê segredo");
  });

  test("alvo: produção/teste exigem o host do projeto; local exige 127.0.0.1", () => {
    assert.match(rodar("prevoo", { FOODY_ALVO: "producao" }).msg, /alvo recusado/);
    assert.match(rodar("prevoo", { FOODY_ENSAIO_LOCAL: "" }).msg, /FOODY_ENSAIO_LOCAL/);
    assert.match(rodar("ensaio", { FOODY_ALVO: "producao", FOODY_CONN: "postgresql://postgres@db.uqybgauuxcrqzquultfu.supabase.co:5432/postgres" }).msg, /só para local\/teste/);
  });

  test("pré-voo limpo PASSA; validar antes de aplicar REPROVA", () => {
    const p = rodar("prevoo"); assert.ok(p.ok, p.msg); assert.deepEqual(p.r.falhas, []);
    const v = rodar("validar"); assert.ok(v.ok); assert.ok(v.r.falhas.includes("índice ausente"));
  });

  test("duas EM_ANDAMENTO na mesma unidade: pré-voo barra, o pacote direto recusa (55000) e NADA muda", () => {
    const a = execucao(UNI), c = execucao(UNI);
    assert.match(avaliarPrevoo(rodar("prevoo").r.estado).falhas.join(), /2\+ execuções EM_ANDAMENTO/);
    assert.match(rodar("aplicar", { FOODY_AUTORIZO: "SIM" }).msg, /pré-voo reprovou/);
    const direto = psqlSync(b.url, gerarPacote().arquivos["aplicar_150.sql"]);
    assert.equal(direto.ok, false); assert.match(direto.err, /mais de uma execução EM_ANDAMENTO/);
    assert.equal(q(`select to_regclass('public.${INDICE}') is null;`), "t");
    assert.equal(q(`select count(*) from supabase_migrations.schema_migrations where name = '${NOME}';`), "0");
    q(`update foody_sync_execucoes set status = 'FALHOU', erro_codigo = 'ABANDONADA', concluido_em = now() where id in ('${a}', '${c}');`);
  });

  test("lock de outra sessão: pré-voo barra; pacote direto cai no lock_timeout e nada entra", async () => {
    const segura = psqlAsync(b.url, "begin; lock table foody_sync_execucoes in row exclusive mode; select pg_sleep(8); commit;");
    await new Promise((r) => setTimeout(r, 1500));
    assert.match(rodar("aplicar", { FOODY_AUTORIZO: "SIM" }).msg, /lock/);
    const direto = psqlSync(b.url, gerarPacote().arquivos["aplicar_150.sql"]);
    assert.equal(direto.ok, false); assert.match(direto.err, /lock timeout|canceling statement due to lock/i);
    await segura;
    assert.equal(q(`select to_regclass('public.${INDICE}') is null;`), "t");
  });

  test("ensaio (aplica → prova unicidade → recupera → ROLLBACK) não deixa rastro", () => {
    execucao(UNI2, "CONCLUIDA");
    const r = rodar("ensaio"); assert.ok(r.ok, r.msg);
    assert.match(r.r.saida, /ENSAIO_APLICADO .*"unico": true/); assert.match(r.r.avisos, /ENSAIO_UNICIDADE_OK/); assert.match(r.r.saida, /ENSAIO_RECUPERADO true 0/);
    assert.equal(r.r.depois.indice.existe, false); assert.equal(r.r.depois.registros_150, 0);
  });

  test("aplicar: exige autorização; aplica, registra UMA vez, valida; unicidade real (23505); outra unidade segue livre", () => {
    assert.match(rodar("aplicar").msg, /FOODY_AUTORIZO=SIM/);
    const antes = q(`select count(*) from foody_sync_execucoes;`);
    const r = rodar("aplicar", { FOODY_AUTORIZO: "SIM" }); assert.ok(r.ok, r.msg);
    assert.deepEqual(rodar("validar").r.falhas, []);
    assert.equal(q(`select count(*) from foody_sync_execucoes;`), antes, "nenhum dado alterado");
    assert.equal(q(`select count(*) from supabase_migrations.schema_migrations where name = '${NOME}' and created_by = 'kit-foody-150' and statements[1] like '%create unique index%';`), "1");
    execucao(UNI);
    const dup = psqlSync(b.url, `insert into foody_sync_execucoes (organizacao_id, unidade_id, conexao_id, competencia, janela_inicio, janela_fim, origem, regra_versao)
      values ('${ORG}', '${UNI}', '${cx[UNI]}', current_date, now(), now() + interval '1 day', 'agendado', 1);`);
    assert.equal(dup.ok, false); assert.match(dup.err, /foody_sync_execucoes_uma_em_andamento/);
    execucao(UNI2);
    execucao(UNI, "CONCLUIDA"); execucao(UNI, "FALHOU");
  });

  test("reaplicar é recusado sem efeito (JA_REGISTRADA); pré-voo também barra", () => {
    const direto = psqlSync(b.url, gerarPacote().arquivos["aplicar_150.sql"]);
    assert.equal(direto.ok, false); assert.match(direto.err, /JA_REGISTRADA/);
    assert.match(rodar("aplicar", { FOODY_AUTORIZO: "SIM" }).msg, /150 já registrada/);
    assert.equal(q(`select count(*) from supabase_migrations.schema_migrations where name = '${NOME}';`), "1");
  });

  test("recuperar: exige autorização; remove só índice e registro; dados intactos; reaplicar depois funciona", () => {
    assert.match(rodar("recuperar").msg, /FOODY_AUTORIZO=SIM/);
    q(`update foody_sync_execucoes set status = 'FALHOU', erro_codigo = 'ABANDONADA', concluido_em = now() where status = 'EM_ANDAMENTO';`);
    const linhas = q(`select count(*) || '/' || (select count(*) from foody_conexoes) from foody_sync_execucoes;`);
    const r = rodar("recuperar", { FOODY_AUTORIZO: "SIM" }); assert.ok(r.ok, r.msg);
    assert.equal(q(`select count(*) || '/' || (select count(*) from foody_conexoes) from foody_sync_execucoes;`), linhas);
    assert.equal(q(`select count(*) from supabase_migrations.schema_migrations where name in ('147_foody_camada_central','148_foody_conexao_compartilhada','149_foody_conexao_administracao');`), "3");
    assert.match(psqlSync(b.url, gerarPacote().arquivos["recuperar_150.sql"]).err, /NADA_A_RECUPERAR/);
    assert.ok(rodar("aplicar", { FOODY_AUTORIZO: "SIM" }).ok);
    assert.deepEqual(rodar("validar").r.falhas, []);
  });

  test("ensaio sem execuções no banco só avisa (prova de unicidade fica para o local)", () => {
    const k = gerarPacote();
    assert.match(sqlEnsaio(k), /ENSAIO_SEM_EXECUCOES/);
    assert.match(sqlEnsaio(k), /\nrollback;\n$/);
  });
});
