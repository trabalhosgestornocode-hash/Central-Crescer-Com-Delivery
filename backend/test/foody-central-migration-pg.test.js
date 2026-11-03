// Migration 144 num Postgres LOCAL e DESCARTÁVEL com o schema REAL do repositório (base + 068..144).
// Só roda com CHECKLIST_PERFIL_PG_URL apontando para host local; caso contrário é PULADO (não é falha).
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55420/postgres node --test test/foody-central-migration-pg.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { motivoPular, criarBancoDescartavel, sql, psqlSync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal, comoUsuario, MIGRATIONS_DIR } from "./helpers/schema-real-pg.js";

const ORG_A = "11111111-1111-4111-8111-111111111111", UNI_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "22222222-2222-4222-8222-222222222222", UNI_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const H = "a".repeat(64), H2 = "b".repeat(64);

describe("migration 144 — Postgres real", { skip: motivoPular, timeout: 600_000 }, () => {
  let b;
  const ok = (texto) => { const r = psqlSync(b.url, texto); assert.equal(r.ok, true, r.err); return r.out.trim(); };
  const falha = (texto, padrao) => { const r = psqlSync(b.url, texto); assert.equal(r.ok, false, `deveria falhar: ${texto}`); if (padrao) assert.match(r.err, padrao); };
  const registrar = (o = {}) => {
    const p = { org: ORG_A, uni: UNI_A, comp: "2026-10-25", status: "CONSOLIDADO", estado: "PROVISORIO", exec: o.exec ?? "gen_random_uuid()", motivo: "null", hash: H, ...o };
    return `select resultado || '|' || versao_registrada || '|' || status_registrado from foody_fechamento_registrar('${p.org}', '${p.uni}', '${p.comp}', '${p.status}', '${p.estado}', ${p.exec}, null, 1, 'manual', null, ${p.motivo}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '${p.hash}');`;
  };

  before(() => {
    b = criarBancoDescartavel("foody144");
    assert.deepEqual(construirSchemaReal(b.url), []);
    // Duas organizações/unidades mínimas (só as colunas obrigatórias do schema real).
    const insOrg = (id) => ok(`insert into organizacoes (id, nome) values ('${id}', 'org teste ${id.slice(0, 4)}');`);
    insOrg(ORG_A); insOrg(ORG_B);
    const insUni = (id, org) => ok(`insert into unidades (id, organizacao_id, nome) values ('${id}', '${org}', 'unidade teste ${id.slice(0, 4)}');`);
    insUni(UNI_A, ORG_A); insUni(UNI_B, ORG_B);
    ok(`insert into foody_conexoes (id, organizacao_id, unidade_id, status, token_cifrado, token_impressao) values
      ('c0000000-0000-4000-8000-00000000000a', '${ORG_A}', '${UNI_A}', 'ATIVA', 'k1:x:y:z', '0123456789ab'),
      ('c0000000-0000-4000-8000-00000000000b', '${ORG_B}', '${UNI_B}', 'ATIVA', 'k1:x:y:z', '0123456789ab');`);
    ok(`insert into foody_sync_execucoes (id, organizacao_id, unidade_id, conexao_id, competencia, janela_inicio, janela_fim, origem, regra_versao) values
      ('e0000000-0000-4000-8000-00000000000a', '${ORG_A}', '${UNI_A}', 'c0000000-0000-4000-8000-00000000000a', '2026-10-25', '2026-10-25T03:00Z', '2026-10-26T03:00Z', 'manual', 1),
      ('e0000000-0000-4000-8000-00000000000b', '${ORG_B}', '${UNI_B}', 'c0000000-0000-4000-8000-00000000000b', '2026-10-25', '2026-10-25T03:00Z', '2026-10-26T03:00Z', 'manual', 1);`);
  });
  after(() => b?.derrubar?.());

  const pedido = (o = {}) => {
    const p = { org: ORG_A, uni: UNI_A, uid: "u1", exec: "e0000000-0000-4000-8000-00000000000a", presente: "true", hash: "'0123456789abcdef'", tipo: "proprio", ...o };
    return `insert into foody_pedidos (organizacao_id, unidade_id, foody_uid, numero_pedido, competencia, data_hora, status_foody, situacao, operacao,
      entregador_presente, entregador_hash, entregador_tipo, fonte_hash, primeira_execucao_id, ultima_execucao_id)
      values ('${p.org}', '${p.uni}', '${p.uid}', '1', '2026-10-25', '2026-10-25T12:00:00', 'closed', 'Finalizado', 'subway',
      ${p.presente}, ${p.hash}, '${p.tipo}', '${H}', '${p.exec}', '${p.exec}');`;
  };

  test("tenant: unidade de outra organização é recusada; unidade não muda", () => {
    falha(pedido({ org: ORG_B }), /não pertence/);
    ok(pedido());
    falha(`update foody_pedidos set unidade_id = '${UNI_B}', organizacao_id = '${ORG_B}' where foody_uid = 'u1';`, /não muda|outra unidade/);
  });
  test("pedido não pode apontar para execução de outra unidade; execução não pode usar conexão de outra unidade", () => {
    falha(pedido({ uid: "u2", exec: "e0000000-0000-4000-8000-00000000000b" }), /outra unidade/);
    falha(`insert into foody_sync_execucoes (organizacao_id, unidade_id, conexao_id, competencia, janela_inicio, janela_fim, origem, regra_versao)
      values ('${ORG_A}', '${UNI_A}', 'c0000000-0000-4000-8000-00000000000b', '2026-10-25', '2026-10-25T03:00Z', '2026-10-26T03:00Z', 'manual', 1);`, /outra unidade/);
  });
  test("unicidade (unidade, uid) e coerência entregador/tipo", () => {
    falha(pedido(), /uq_foody_pedidos_uid/);
    falha(pedido({ uid: "u3", presente: "false" }), /ck_foody_pedidos_entregador/);
    falha(pedido({ uid: "u4", hash: "null" }), /ck_foody_pedidos_entregador/);
    ok(pedido({ uid: "u5", presente: "false", hash: "null", tipo: "sem_entregador" }));
    // O mesmo uid em OUTRA unidade é outro pedido (contas diferentes).
    ok(pedido({ org: ORG_B, uni: UNI_B, uid: "u1", exec: "e0000000-0000-4000-8000-00000000000b" }));
  });
  test("conexão: token precisa estar cifrado (prefixo k<versão>:) e uma conexão por unidade", () => {
    falha(`insert into foody_conexoes (organizacao_id, unidade_id, token_cifrado, token_impressao) values ('${ORG_A}', '${UNI_A}', 'tok_em_claro', '0123456789ab');`, /token_cifrado/);
    falha(`insert into foody_conexoes (organizacao_id, unidade_id, token_cifrado, token_impressao) values ('${ORG_A}', '${UNI_A}', 'k1:a:b:c', '0123456789ab');`, /uq_foody_conexoes_unidade/);
  });
  test("registrar: REGISTRADO → SEM_MUDANCA → JA_REGISTRADO → CORRIGIDO exige motivo; não volta a PRELIMINAR", () => {
    assert.equal(ok(registrar({ exec: "'f0000000-0000-4000-8000-000000000001'" })).split("\n").pop(), "REGISTRADO|1|CONSOLIDADO");
    assert.equal(ok(registrar()).split("\n").pop(), "SEM_MUDANCA|1|CONSOLIDADO");
    assert.equal(ok(registrar({ exec: "'f0000000-0000-4000-8000-000000000001'", hash: H2 })).split("\n").pop(), "JA_REGISTRADO|1|CONSOLIDADO");
    falha(registrar({ status: "CORRIGIDO", hash: H2 }), /exige motivo/);
    assert.equal(ok(registrar({ status: "CORRIGIDO", hash: H2, motivo: "'api mudou'" })).split("\n").pop(), "REGISTRADO|2|CORRIGIDO");
    falha(registrar({ status: "PRELIMINAR", hash: H }), /não volta a PRELIMINAR/);
    falha(registrar({ uni: UNI_B }), /fora da organização/);
    falha(registrar({ status: "REVISADO" }), /status inválido/);
    assert.equal(ok(`select substitui_id is not null from foody_fechamentos_logisticos where versao = 2;`), "t");
  });
  test("fechamento imutável: DELETE e UPDATE de conteúdo recusados", () => {
    falha(`delete from foody_fechamentos_logisticos;`, /somente inclusão/);
    falha(`update foody_fechamentos_logisticos set motivo = 'x';`, /somente inclusão/);
  });
  test("privilégios: anon/authenticated não leem nada; service_role não grava fechamento direto nem apaga pedido", () => {
    for (const papel of ["anon", "authenticated"]) {
      for (const t of ["foody_conexoes", "foody_sync_execucoes", "foody_pedidos", "foody_fechamentos_logisticos"]) {
        assert.equal(comoUsuario(b.url, null, `select count(*) from ${t};`, { papel }).ok, false, `${papel} leu ${t}`);
      }
      assert.equal(comoUsuario(b.url, null, registrar({ hash: "c".repeat(64) }), { papel }).ok, false, `${papel} executou a função`);
    }
    assert.equal(comoUsuario(b.url, null, `select count(*) from foody_pedidos;`, { papel: "service_role" }).ok, true);
    assert.equal(comoUsuario(b.url, null, `insert into foody_fechamentos_logisticos (organizacao_id) values ('${ORG_A}');`, { papel: "service_role" }).ok, false);
    assert.equal(comoUsuario(b.url, null, `delete from foody_pedidos;`, { papel: "service_role" }).ok, false);
    assert.equal(comoUsuario(b.url, null, `delete from foody_conexoes;`, { papel: "service_role" }).ok, false);
    assert.equal(comoUsuario(b.url, null, registrar({ hash: "d".repeat(64) }), { papel: "service_role" }).ok, true);
    assert.equal(ok(`select count(*) from pg_policies where tablename like 'foody_%';`), "0");
  });
  test("transferência de unidade (remapear_organizacao_em_tabelas_de_unidade) continua funcionando com as tabelas foody_*", () => {
    const existe = ok(`select count(*) from pg_proc where proname = 'remapear_organizacao_em_tabelas_de_unidade';`);
    if (existe === "0") return; // função não existe neste schema: nada a provar
    const assinatura = ok(`select pg_get_function_identity_arguments(oid) from pg_proc where proname = 'remapear_organizacao_em_tabelas_de_unidade' limit 1;`);
    assert.match(assinatura, /uuid/);
    ok(`update unidades set organizacao_id = '${ORG_B}' where id = '${UNI_A}';
        select remapear_organizacao_em_tabelas_de_unidade('${UNI_A}', '${ORG_A}', '${ORG_B}');`);
    assert.equal(ok(`select count(*) from foody_fechamentos_logisticos where unidade_id = '${UNI_A}' and organizacao_id <> '${ORG_B}';`), "0");
    assert.equal(ok(`select count(*) from foody_pedidos where unidade_id = '${UNI_A}' and organizacao_id <> '${ORG_B}';`), "0");
  });
  test("rollback remove tudo, não toca o resto e a 144 reaplica limpa", () => {
    const antes = ok(`select count(*) from pg_tables where schemaname = 'public' and tablename not like 'foody_%';`);
    const r = psqlSync(b.url, "", { arquivo: join(MIGRATIONS_DIR, "144_rollback.sql") });
    assert.equal(r.ok, true, r.err);
    assert.equal(ok(`select count(*) from pg_tables where tablename like 'foody_%';`), "0");
    assert.equal(ok(`select count(*) from pg_proc where proname like 'foody_%';`), "0");
    assert.equal(ok(`select count(*) from pg_tables where schemaname = 'public' and tablename not like 'foody_%';`), antes);
    const r2 = psqlSync(b.url, "", { arquivo: join(MIGRATIONS_DIR, "144_foody_camada_central.sql") });
    assert.equal(r2.ok, true, r2.err);
    assert.equal(ok(`select count(*) from pg_tables where tablename like 'foody_%';`), "4");
    // rollback idempotente
    assert.equal(psqlSync(b.url, "", { arquivo: join(MIGRATIONS_DIR, "144_rollback.sql") }).ok, true);
    assert.equal(psqlSync(b.url, "", { arquivo: join(MIGRATIONS_DIR, "144_rollback.sql") }).ok, true);
    void sql;
  });
});
