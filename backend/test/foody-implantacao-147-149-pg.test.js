// ENSAIO do procedimento de implantação da camada Foody (147 → 148 → 149) num Postgres LOCAL e DESCARTÁVEL: schema real do
// repositório até a 143 + histórico supabase_migrations com o registro do Termo v3 (144_termo_v3_aprovado_internamente), como em
// produção. Exercita o executor REAL (implantar.mjs) e os pacotes gerados: pré-voo, aplicação atômica, erros simulados (lock,
// falha no registro, estado parcial), reaplicação, deriva de privilégio, isolamento, recuperação recusada (dados, assinatura,
// sem variável) e recuperação + reaplicação. Nunca fala com Supabase: só 127.0.0.1 (helpers/pg-descartavel.js).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { criarBancoDescartavel, motivoPular, psqlSync, psqlAsync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal, comoUsuario, MIGRATIONS_DIR } from "./helpers/schema-real-pg.js";

const KIT = "../testes-seguros/foody-147-149/";
const { gerarPacote } = await import(KIT + "gerar_pacote.mjs");
const { executar, SHA_ESPERADO, travasDeAlvo, avaliarPrevoo } = await import(KIT + "implantar.mjs");
const C = await import(KIT + "sql_comum.mjs");

const HISTORICO = `
  create schema if not exists supabase_migrations;
  create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text, created_by text,
    idempotency_key text unique, rollback text[]);
  insert into supabase_migrations.schema_migrations (version, name) values
    ('20261031002338', '136_unidades_fuso_somente_backend'), ('20261101175742', '143_termo_v2_rascunho_e_categorias_relatorios'),
    ('20261101190718', '144_termo_v3_aprovado_internamente');`;
const ORG_A = "0a000000-0000-4000-8000-000000000001", UNI_A = "0a000000-0000-4000-8000-0000000000a1";

describe("implantação 147–149 — ensaio em Postgres real", { skip: motivoPular, timeout: 900_000 }, () => {
  let b, evid, kit, env, assinatura1, impressaoInicial;
  const um = (q) => { const r = psqlSync(b.url, q); assert.ok(r.ok, r.err); return r.out.split(/\r?\n/).pop(); };
  const rodar = (modo, extra = {}) => { try { return { ok: true, r: executar(modo, { ...env, ...extra }, () => {}) }; } catch (e) { return { ok: false, msg: e.message }; } };
  const direto = (arquivo, vars = []) => psqlSync(b.url, "", { arquivo: join(kit, arquivo), formato: ["-t", "-A", ...vars].join(" ") });
  const diag = () => { const r = rodar("diagnostico"); assert.ok(r.ok, r.msg); return r.r; };

  before(() => {
    b = criarBancoDescartavel("foodyimpl");
    assert.deepEqual(construirSchemaReal(b.url, { ate: 143 }), []);
    assert.equal(psqlSync(b.url, HISTORICO).ok, true);
    psqlSync(b.url, `insert into organizacoes (id, nome) values ('${ORG_A}', 'Org A'); insert into unidades (id, organizacao_id, nome) values ('${UNI_A}', '${ORG_A}', 'Unidade A');`);
    evid = mkdtempSync(join(tmpdir(), "foody-impl-evid-"));
    kit = mkdtempSync(join(tmpdir(), "foody-impl-kit-"));
    for (const [n, t] of Object.entries(gerarPacote().arquivos)) writeFileSync(join(kit, n), t);
    env = { FOODY_ALVO: "local", FOODY_ENSAIO_LOCAL: "1", FOODY_CONN: b.url, FOODY_EVIDENCIAS: evid };
  });
  after(() => b?.derrubar());

  test("kit: SHA-256 fixado confere, sem \\r, determinístico; histórico por NOME EXATO; recuperação usa o rollback da camada", () => {
    const k1 = gerarPacote(), k2 = gerarPacote();
    assert.deepEqual(k1.sha, k2.sha);
    for (const [n, s] of Object.entries(SHA_ESPERADO)) assert.equal(k1.sha[n], s, `${n}: atualize SHA_ESPERADO em implantar.mjs`);
    const ap = k1.arquivos["pacote_aplicar.sql"];
    // Fora do texto ORIGINAL guardado no histórico ($foody_registro$…$foody_registro$), uma única transação.
    const executavel = ap.replace(/\$foody_registro\$[\s\S]*?\$foody_registro\$/g, "''");
    assert.equal((executavel.match(/^begin;$/gm) ?? []).length, 1); assert.equal((executavel.match(/^commit;$/gm) ?? []).length, 1);
    assert.equal((ap.match(/\$foody_registro\$/g) ?? []).length, 6, "3 arquivos guardados no histórico");
    for (const f of C.ARQUIVOS) assert.ok(ap.includes(readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(/\r\n/g, "\n")), `registro guarda ${f} original`);
    assert.doesNotMatch(ap, /\^14\[|name ~ '\^14[4-6]/, "nada de regex por número no histórico");
    assert.match(ap, /name in \('147_foody_camada_central', '148_foody_conexao_compartilhada', '149_foody_conexao_administracao'\)/);
    assert.match(k1.arquivos["pacote_recuperar.sql"], /===== 147_rollback\.sql =====/);
    assert.match(k1.arquivos["pacote_recuperar.sql"], /:'assinatura'/);
  });

  test("travas de alvo: local exige ensaio; teste/produção conferem host, usuário, porta e o outro projeto", () => {
    assert.deepEqual(travasDeAlvo(env), []);
    assert.ok(travasDeAlvo({ ...env, FOODY_ENSAIO_LOCAL: "" }).length > 0);
    assert.ok(travasDeAlvo({ FOODY_ALVO: "producao", FOODY_CONN: "postgresql://postgres:x@db.wiqqsxnysbzhcrzrrean.supabase.co:5432/postgres" }).length > 0);
    assert.ok(travasDeAlvo({ FOODY_ALVO: "teste", FOODY_CONN: "postgresql://postgres:x@db.uqybgauuxcrqzquultfu.supabase.co:5432/postgres" }).length > 0);
    assert.ok(travasDeAlvo({ FOODY_ALVO: "producao", FOODY_CONN: "postgresql://postgres.uqybgauuxcrqzquultfu:x@aws-0.pooler.supabase.com:6543/postgres" }).length > 0, "pooler de transação");
    assert.deepEqual(travasDeAlvo({ FOODY_ALVO: "producao", FOODY_CONN: "postgresql://postgres:x@db.uqybgauuxcrqzquultfu.supabase.co:5432/postgres" }), []);
    assert.deepEqual(travasDeAlvo({ FOODY_ALVO: "teste", FOODY_CONN: "postgresql://postgres.wiqqsxnysbzhcrzrrean:x@aws-0-sa-east-1.pooler.supabase.com:5432/postgres" }), []);
  });

  test("estado inicial AUSENTE; pré-voo aprovado; o registro do Termo v3 existe e 147–149 estão livres", () => {
    assert.equal(diag().estado, "AUSENTE");
    const r = rodar("prevoo"); assert.ok(r.ok, r.msg);
    assert.deepEqual(r.r.falhas, []);
    assert.equal(r.r.prevoo.historico.termo_v3_registrado, 1);
    assert.deepEqual(r.r.prevoo.historico.numeros_147_149_ocupados, []);
    impressaoInicial = r.r.prevoo.impressao_fora_do_escopo;
    // Portões de produção: sem as unidades do piloto o pré-voo de produção reprova (aqui, ensaio).
    assert.ok(avaliarPrevoo(r.r.prevoo, "producao").some((f) => /unidades do piloto/.test(f)));
  });

  test("aplicar sem autorização: recusa antes de conectar para escrever", () => {
    const r = rodar("aplicar"); assert.equal(r.ok, false); assert.match(r.msg, /FOODY_AUTORIZO=SIM/);
    assert.equal(diag().estado, "AUSENTE");
  });

  test("erro simulado 1 — lock em unidades: o pré-voo barra; o pacote direto cai no lock_timeout e NADA entra", async () => {
    const segura = psqlAsync(b.url, "begin; lock table unidades in row exclusive mode; select pg_sleep(9); commit;");
    await new Promise((r) => setTimeout(r, 1200));
    const r = rodar("aplicar", { FOODY_AUTORIZO: "SIM" });
    assert.equal(r.ok, false); assert.match(r.msg, /locks de escrita em unidades\/organizacoes|transação aberta/);
    const d = direto("pacote_aplicar.sql");
    assert.equal(d.ok, false); assert.match(d.err, /lock|bloqueio/i);
    await segura;
    assert.equal(diag().estado, "AUSENTE");
    assert.equal(um("select count(*) from supabase_migrations.schema_migrations where name like '14_\\_foody%';"), "0");
  });

  test("erro simulado 2 — falha no REGISTRO do histórico (fim do pacote): tudo desfeito, nenhuma tabela, nenhum registro", () => {
    psqlSync(b.url, "alter table supabase_migrations.schema_migrations add constraint falha_proposital check (name <> '149_foody_conexao_administracao');");
    const r = rodar("aplicar", { FOODY_AUTORIZO: "SIM" });
    assert.equal(r.ok, false); assert.match(r.msg, /desfeita pelo banco \(estado agora: AUSENTE\)/);
    psqlSync(b.url, "alter table supabase_migrations.schema_migrations drop constraint falha_proposital;");
    const d = diag(); assert.equal(d.estado, "AUSENTE"); assert.deepEqual(d.objetos, []);
  });

  test("erro simulado 3 — estado PARCIAL (objeto foody solto): diagnóstico PARCIAL, executor e pacote recusam sem tocar nada", () => {
    psqlSync(b.url, "create table public.foody_conexoes (id int);");
    const d = diag(); assert.equal(d.estado, "PARCIAL"); assert.match(d.acao, /Não reaplicar/);
    const r = rodar("aplicar", { FOODY_AUTORIZO: "SIM" }); assert.equal(r.ok, false); assert.match(r.msg, /estado PARCIAL/);
    const x = direto("pacote_aplicar.sql"); assert.equal(x.ok, false); assert.match(x.err, /OBJETO_EXISTENTE/);
    assert.equal(um("select count(*) from pg_class where relname like 'foody\\_%';"), "1", "só o objeto solto");
    psqlSync(b.url, "drop table public.foody_conexoes;");
    assert.equal(diag().estado, "AUSENTE");
  });

  test("aplicação: COMPLETO_VAZIO, pós-verificação aprovada, nada fora do escopo mudou, histórico com os 3 nomes + Termo v3 intacto", () => {
    const r = rodar("aplicar", { FOODY_AUTORIZO: "SIM" }); assert.ok(r.ok, r.msg);
    assinatura1 = r.r.assinatura; assert.match(assinatura1, /^[0-9a-f]{32}$/);
    const v = rodar("validar"); assert.ok(v.ok, v.msg); assert.deepEqual(v.r.falhas, []); assert.equal(v.r.diag.estado, "COMPLETO_VAZIO");
    assert.deepEqual(v.r.pos.impressao_fora_do_escopo, impressaoInicial, "Parser, Dashboard, Checklist, iFood e notificações intocados");
    assert.equal(um(`select string_agg(name, ',' order by name) from supabase_migrations.schema_migrations where name ~ '^14[4-9]_';`),
      "144_termo_v3_aprovado_internamente,147_foody_camada_central,148_foody_conexao_compartilhada,149_foody_conexao_administracao");
    assert.equal(v.r.pos.historico.termo_v3_registrado, 1);
  });

  test("reaplicação: executor recusa (COMPLETO_VAZIO); pacote direto recusa JA_REGISTRADA; estrutura idêntica", () => {
    const r = rodar("aplicar", { FOODY_AUTORIZO: "SIM" }); assert.equal(r.ok, false); assert.match(r.msg, /aplicar só a partir de AUSENTE/);
    const x = direto("pacote_aplicar.sql"); assert.equal(x.ok, false); assert.match(x.err, /JA_REGISTRADA/);
    assert.equal(diag().assinatura, assinatura1);
  });

  test("isolamento: anon/authenticated não leem nem executam nada; service_role não apaga; deriva de privilégio é detectada", () => {
    for (const papel of ["anon", "authenticated"]) {
      const r = comoUsuario(b.url, "11111111-1111-4111-8111-111111111111", "select count(*) from foody_conexoes;", { papel });
      assert.equal(r.ok, false, `${papel} leu foody_conexoes`); assert.match(r.err, /permission denied|permissão negada/);
      const f = comoUsuario(b.url, "11111111-1111-4111-8111-111111111111",
        `select * from foody_conexao_administrar('PAUSAR', '${ORG_A}', '${UNI_A}', '11111111-1111-4111-8111-111111111111');`, { papel });
      assert.equal(f.ok, false); assert.match(f.err, /permission denied|permissão negada/);
    }
    const del = psqlSync(b.url, "set role service_role; delete from foody_conexoes;");
    assert.equal(del.ok, false); assert.match(del.err, /permission denied|permissão negada/);
    psqlSync(b.url, "grant select on foody_pedidos to anon;");
    const v = rodar("validar"); assert.ok(v.ok, v.msg); assert.ok(v.r.falhas.some((f) => /anon\/authenticated com acesso/.test(f)), JSON.stringify(v.r.falhas));
    psqlSync(b.url, "revoke select on foody_pedidos from anon;");
    assert.deepEqual(rodar("validar").r.falhas, []);
    assert.equal(diag().assinatura, assinatura1, "revogar restaurou a assinatura");
  });

  test("recuperação RECUSADA: sem autorização, assinatura errada, sem a variável, com dados e com deriva estrutural", () => {
    assert.match(rodar("recuperar", { FOODY_ASSINATURA: assinatura1 }).msg, /FOODY_AUTORIZO=SIM/);
    const errada = "0".repeat(32);
    assert.match(rodar("recuperar", { FOODY_AUTORIZO: "SIM", FOODY_ASSINATURA: errada }).msg, /assinatura atual .* ≠ informada/);
    const semVar = direto("pacote_recuperar.sql"); assert.equal(semVar.ok, false, "sem -v assinatura o psql falha");
    const errDireto = direto("pacote_recuperar.sql", ["-v", `assinatura=${errada}`]); assert.equal(errDireto.ok, false); assert.match(errDireto.err, /ASSINATURA_DIVERGENTE/);
    // Com dados: nenhuma recuperação automática.
    psqlSync(b.url, `insert into foody_conexoes (organizacao_id, unidade_id, token_cifrado, token_impressao) values ('${ORG_A}', '${UNI_A}', 'k1:abc', 'abcdefabcdef');`);
    const d = diag(); assert.equal(d.estado, "COMPLETO_COM_DADOS"); assert.match(d.acao, /NÃO há recuperação automática/);
    assert.match(rodar("recuperar", { FOODY_AUTORIZO: "SIM", FOODY_ASSINATURA: assinatura1 }).msg, /estado COMPLETO_COM_DADOS/);
    const comDados = direto("pacote_recuperar.sql", ["-v", `assinatura=${assinatura1}`]); assert.equal(comDados.ok, false); assert.match(comDados.err, /COM_DADOS/);
    psqlSync(b.url, "delete from foody_conexoes;");
    // Deriva estrutural depois da verificação: índice a mais.
    psqlSync(b.url, "create index foody_indice_intruso on foody_pedidos (numero_pedido);");
    assert.match(rodar("recuperar", { FOODY_AUTORIZO: "SIM", FOODY_ASSINATURA: assinatura1 }).msg, /a estrutura mudou/);
    const deriva = direto("pacote_recuperar.sql", ["-v", `assinatura=${assinatura1}`]); assert.equal(deriva.ok, false); assert.match(deriva.err, /ASSINATURA_DIVERGENTE/);
    psqlSync(b.url, "drop index foody_indice_intruso;");
    const ok = diag(); assert.equal(ok.estado, "COMPLETO_VAZIO"); assert.equal(ok.assinatura, assinatura1, "nenhuma tentativa recusada mudou nada");
  });

  test("recuperação: remove só a camada e o registro; impressão fora do escopo igual à inicial; Termo v3 intacto", () => {
    const r = rodar("recuperar", { FOODY_AUTORIZO: "SIM", FOODY_ASSINATURA: assinatura1 }); assert.ok(r.ok, r.msg);
    const d = diag(); assert.equal(d.estado, "AUSENTE"); assert.equal(d.termo_v3_registrado, 1);
    const p = rodar("prevoo"); assert.deepEqual(p.r.prevoo.impressao_fora_do_escopo, impressaoInicial);
    assert.equal(um("select count(*) from supabase_migrations.schema_migrations;"), "3");
  });

  test("reaplicação depois da recuperação: mesma assinatura, pós-verificação aprovada", () => {
    const r = rodar("aplicar", { FOODY_AUTORIZO: "SIM" }); assert.ok(r.ok, r.msg);
    assert.equal(r.r.assinatura, assinatura1);
    assert.deepEqual(rodar("validar").r.falhas, []);
  });

  test("a camada instalada pelo pacote funciona: transferência REAL de unidade remapeia foody_* e pausa a conexão", () => {
    const ORG_B = "0b000000-0000-4000-8000-000000000001";
    psqlSync(b.url, `insert into organizacoes (id, nome) values ('${ORG_B}', 'Org B');
      insert into foody_conexoes (organizacao_id, unidade_id, status, token_cifrado, token_impressao) values ('${ORG_A}', '${UNI_A}', 'ATIVA', 'k1:abc', 'abcdefabcdef');`);
    const t = psqlSync(b.url, `set role service_role; select transferir_unidade_organizacao('${UNI_A}', '${ORG_B}', '22222222-2222-4222-8222-222222222222');`);
    assert.equal(t.ok, true, t.err);
    assert.equal(um(`select organizacao_id || ':' || status from foody_conexoes;`), `${ORG_B}:PAUSADA`);
    assert.equal(um(`select count(*) from foody_conexoes_eventos where evento = 'PAUSADA_POR_TRANSFERENCIA' and organizacao_id = '${ORG_B}';`), "1");
    // Com dados agora: a recuperação automática não está mais disponível.
    assert.equal(diag().estado, "COMPLETO_COM_DADOS");
  });
});
