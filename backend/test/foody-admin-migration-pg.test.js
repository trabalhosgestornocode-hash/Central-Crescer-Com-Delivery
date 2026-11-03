// Migration 146 (administração da conexão Foody pela tela) num Postgres LOCAL e DESCARTÁVEL, schema real (base + 068..146).
// Só roda com CHECKLIST_PERFIL_PG_URL apontando para host local; caso contrário é PULADO (não é falha). Dados 100% fictícios.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55431/postgres node --test test/foody-admin-migration-pg.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { motivoPular, criarBancoDescartavel, psqlSync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal, comoUsuario, MIGRATIONS_DIR } from "./helpers/schema-real-pg.js";

const ORG_T = "11111111-1111-4111-8111-111111111111", UNI_T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", UNI_T2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const ORG_D = "22222222-2222-4222-8222-222222222222", UNI_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ORG_X = "33333333-3333-4333-8333-333333333333", UNI_X = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ADM_T = "a1000000-0000-4000-8000-000000000001", ADM_D = "a2000000-0000-4000-8000-000000000002";
const OPS_T = "a3000000-0000-4000-8000-000000000003", ADM_X = "a4000000-0000-4000-8000-000000000004";
const IMP1 = "0123456789ab", IMP2 = "ba9876543210", IMP3 = "cccccccccccc";

describe("migration 146 — administração da conexão Foody, Postgres real", { skip: motivoPular, timeout: 600_000 }, () => {
  let b;
  const ok = (texto) => { const r = psqlSync(b.url, texto); assert.equal(r.ok, true, r.err); return r.out.trim(); };
  const um = (texto) => ok(texto).split(/\r?\n/).filter(Boolean).pop();
  const sq = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`);
  /** Chama a função como o backend chama (service_role). Retorna "resultado|status|evento" ou o erro. */
  const adm = (acao, { org = ORG_T, uni = UNI_T, ator = ADM_T, imp = null, cif = imp ? `k1:iv:${imp}:tag` : null, ponto = null, motivo = null } = {}) => {
    const r = comoUsuario(b.url, null, `select resultado || '|' || status || '|' || coalesce(evento, '-') from foody_conexao_administrar(
      ${sq(acao)}, ${sq(org)}, ${sq(uni)}, ${sq(ator)}, ${sq(cif)}, ${sq(imp)}, ${sq(ponto)}, ${sq(motivo)});`, { papel: "service_role" });
    return r.ok ? { ok: true, v: r.out.trim() } : { ok: false, err: r.err };
  };
  const recusa = (r, codigo) => { assert.equal(r.ok, false, `deveria recusar com ${codigo}`); assert.match(r.err, new RegExp(`foody_conexao_administrar: ${codigo} `)); };
  const eventos = (uni = UNI_T) => ok(`select string_agg(evento || ':' || coalesce(status_anterior, '-') || '>' || status_novo, ',' order by criado_em, id)
    from foody_conexoes_eventos where unidade_id = '${uni}';`).split(/\r?\n/).filter(Boolean).pop() ?? "";

  before(() => {
    b = criarBancoDescartavel("foody146");
    assert.deepEqual(construirSchemaReal(b.url), []);
    for (const [org, uni] of [[ORG_T, UNI_T], [ORG_T, UNI_T2], [ORG_D, UNI_D], [ORG_X, UNI_X]]) {
      ok(`insert into organizacoes (id, nome) values ('${org}', 'org ${org.slice(0, 4)}') on conflict do nothing;`);
      ok(`insert into unidades (id, organizacao_id, nome) values ('${uni}', '${org}', 'unidade ${uni.slice(-4)}');`);
    }
    for (const [id, org, papel] of [[ADM_T, ORG_T, "organization_admin"], [ADM_D, ORG_D, "organization_admin"], [OPS_T, ORG_T, "unit_manager"], [ADM_X, ORG_X, "organization_admin"]]) {
      ok(`insert into auth.users (id, email) values ('${id}', 'u${id.slice(0, 4)}@teste.invalid');
        insert into perfis (id, nome, email) values ('${id}', 'perfil ${id.slice(0, 4)}', 'u${id.slice(0, 4)}@teste.invalid');
        insert into perfis_operacionais (id, conta_id, nome) values ('${id}', '${id}', 'perfil ${id.slice(0, 4)}');
        insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('${id}', '${id}', '${org}', '${papel}');`);
    }
  });
  after(() => b?.derrubar?.());

  test("só organization_admin ATIVO da organização da unidade; unidade de outra organização recusada; ação desconhecida recusada", () => {
    recusa(adm("CADASTRAR", { ator: OPS_T, imp: IMP1 }), "SEM_PERMISSAO");
    recusa(adm("CADASTRAR", { ator: ADM_D, imp: IMP1 }), "SEM_PERMISSAO");
    recusa(adm("CADASTRAR", { uni: UNI_D, imp: IMP1 }), "UNIDADE_FORA_DA_ORGANIZACAO");
    recusa(adm("APAGAR"), "ACAO_INVALIDA");
    recusa(adm("CADASTRAR", { imp: "nao-hex" }), "TOKEN_INVALIDO");
    recusa(adm("CADASTRAR", { imp: IMP1, cif: "token-em-claro" }), "TOKEN_INVALIDO");
    assert.equal(um("select count(*) from foody_conexoes;"), "0");
    assert.equal(um("select count(*) from foody_conexoes_eventos;"), "0");
  });

  test("ciclo completo com evento imutável por ação; SEM_MUDANCA não gera evento; papel perdido no meio do caminho é recusado", () => {
    assert.equal(adm("CADASTRAR", { imp: IMP1, ponto: "  Loja Centro  " }).v, "REGISTRADO|PAUSADA|CADASTRADA");
    assert.equal(um(`select ponto_coleta_esperado from foody_conexoes where unidade_id = '${UNI_T}';`), "Loja Centro");
    recusa(adm("CADASTRAR", { imp: IMP1 }), "CONEXAO_EXISTENTE");
    assert.equal(adm("ATIVAR").v, "REGISTRADO|ATIVA|ATIVADA");
    assert.equal(adm("ATIVAR").v, "SEM_MUDANCA|ATIVA|-");
    assert.equal(adm("PAUSAR", { motivo: "conferência" }).v, "REGISTRADO|PAUSADA|PAUSADA");
    assert.equal(adm("PONTO_COLETA", { ponto: "Loja Nova" }).v, "REGISTRADO|PAUSADA|PONTO_COLETA_ALTERADO");
    assert.equal(adm("SUBSTITUIR_TOKEN", { imp: IMP2 }).v, "REGISTRADO|PAUSADA|TOKEN_SUBSTITUIDO");
    assert.equal(adm("SUBSTITUIR_TOKEN", { imp: IMP2 }).v, "SEM_MUDANCA|PAUSADA|-");
    // Papel perdido depois do login (a sessão ainda diria admin): o banco confere usuarios_organizacoes na hora.
    ok(`update usuarios_organizacoes set ativo = false where perfil_id = '${ADM_T}' and organizacao_id = '${ORG_T}';`);
    recusa(adm("ATIVAR"), "SEM_PERMISSAO");
    ok(`update usuarios_organizacoes set ativo = true where perfil_id = '${ADM_T}' and organizacao_id = '${ORG_T}';`);
    recusa(adm("REVOGAR", { motivo: "x" }), "MOTIVO_INVALIDO");
    assert.equal(adm("REVOGAR", { motivo: "token vazado" }).v, "REGISTRADO|REVOGADA|REVOGADA");
    recusa(adm("ATIVAR"), "CONEXAO_REVOGADA");
    assert.equal(adm("CADASTRAR", { imp: IMP1 }).v, "REGISTRADO|PAUSADA|RECONECTADA");
    assert.equal(um("select count(*) from foody_conexoes;"), "1", "reconexão reaproveita a linha");
    assert.equal(eventos(), "CADASTRADA:->PAUSADA,ATIVADA:PAUSADA>ATIVA,PAUSADA:ATIVA>PAUSADA,PONTO_COLETA_ALTERADO:PAUSADA>PAUSADA,"
      + "TOKEN_SUBSTITUIDO:PAUSADA>PAUSADA,REVOGADA:PAUSADA>REVOGADA,RECONECTADA:REVOGADA>PAUSADA");
    assert.equal(um(`select count(*) from foody_conexoes_eventos where ator_perfil_id = '${ADM_T}' and organizacao_id = '${ORG_T}';`), "7");
    assert.equal(um(`select string_agg(distinct coalesce(token_impressao, '-'), ',') from foody_conexoes_eventos;`), `-,${IMP1},${IMP2}`, "só a impressão, nunca o token");
  });

  test("eventos imutáveis; service_role não forja, não apaga, só muda organizacao_id; anon/authenticated sem acesso", () => {
    const id = um("select id from foody_conexoes_eventos order by criado_em limit 1;");
    const comoSR = (cmd) => comoUsuario(b.url, null, cmd, { papel: "service_role" });
    assert.equal(comoSR(`insert into foody_conexoes_eventos (conexao_id, organizacao_id, unidade_id, evento, status_novo)
      select conexao_id, organizacao_id, unidade_id, 'ATIVADA', 'ATIVA' from foody_conexoes_eventos where id = '${id}';`).ok, false);
    assert.equal(comoSR(`update foody_conexoes_eventos set motivo = 'forjado' where id = '${id}';`).ok, false);
    assert.equal(comoSR(`delete from foody_conexoes_eventos where id = '${id}';`).ok, false);
    const r = psqlSync(b.url, `delete from foody_conexoes_eventos where id = '${id}';`);
    assert.equal(r.ok, false, "nem o dono apaga"); assert.match(r.err, /somente inclusão/);
    for (const papel of ["anon", "authenticated"]) {
      assert.equal(comoUsuario(b.url, null, "select count(*) from foody_conexoes_eventos;", { papel }).ok, false, papel);
      assert.equal(comoUsuario(b.url, null, `select * from foody_conexao_administrar('ATIVAR', '${ORG_T}', '${UNI_T}', '${ADM_T}');`, { papel }).ok, false, papel);
    }
    assert.equal(um(`select has_column_privilege('service_role', 'foody_conexoes_eventos', 'organizacao_id', 'UPDATE');`), "t");
    assert.equal(um(`select has_column_privilege('service_role', 'foody_conexoes_eventos', 'motivo', 'UPDATE');`), "f");
    assert.equal(um(`select relrowsecurity from pg_class where relname = 'foody_conexoes_eventos';`), "t");
    assert.equal(um(`select count(*) from pg_policies where tablename = 'foody_conexoes_eventos';`), "0");
  });

  test("dupla contagem: a mesma conta não conecta em duas unidades; destino vivo não tem conexão própria; token não troca com vínculo vivo", () => {
    recusa(adm("CADASTRAR", { uni: UNI_T2, imp: IMP1 }), "CONTA_JA_CONECTADA");
    assert.equal(adm("ATIVAR").v, "REGISTRADO|ATIVA|ATIVADA");
    const cx = um(`select id from foody_conexoes where unidade_id = '${UNI_T}';`);
    ok(`insert into foody_conexao_destinos (conexao_id, organizacao_id, unidade_id, operacao, estado, organizacao_titular_id, aprovado_titular_por, aprovado_titular_em)
      values ('${cx}', '${ORG_D}', '${UNI_D}', 'acai_no_grau', 'PENDENTE', '${ORG_T}', '${ADM_T}', now());`);
    recusa(adm("CADASTRAR", { org: ORG_D, uni: UNI_D, ator: ADM_D, imp: IMP3 }), "DESTINO_VIVO");
    // A guarda vale para QUALQUER escrita, não só para a função.
    const direto = psqlSync(b.url, `insert into foody_conexoes (organizacao_id, unidade_id, status, token_cifrado, token_impressao)
      values ('${ORG_D}', '${UNI_D}', 'PAUSADA', 'k1:a:b:c', '${IMP3}');`);
    assert.equal(direto.ok, false); assert.match(direto.err, /DESTINO_VIVO/);
    recusa(adm("SUBSTITUIR_TOKEN", { imp: IMP3 }), "COMPARTILHAMENTO_VIVO");
    const direto2 = psqlSync(b.url, `update foody_conexoes set token_impressao = '${IMP3}' where id = '${cx}';`);
    assert.equal(direto2.ok, false); assert.match(direto2.err, /COMPARTILHAMENTO_VIVO/);
    // Revogar a conexão derruba o vínculo (145) e só então o destino pode ter conexão própria.
    assert.equal(adm("REVOGAR", { motivo: "encerrando" }).v, "REGISTRADO|REVOGADA|REVOGADA");
    assert.equal(um(`select estado from foody_conexao_destinos where conexao_id = '${cx}';`), "REVOGADO");
    assert.equal(adm("CADASTRAR", { org: ORG_D, uni: UNI_D, ator: ADM_D, imp: IMP3 }).v, "REGISTRADO|PAUSADA|CADASTRADA");
  });

  test("conexão de outra organização: o admin da outra não mexe", () => {
    recusa(adm("PAUSAR", { org: ORG_X, uni: UNI_D, ator: ADM_X }), "UNIDADE_FORA_DA_ORGANIZACAO");
    recusa(adm("PAUSAR", { org: ORG_T, uni: UNI_D, ator: ADM_T }), "UNIDADE_FORA_DA_ORGANIZACAO");
  });

  test("transferência da unidade titular (remapear real): conexão ATIVA volta a PAUSADA, evento na NOVA organização, eventos remapeados", () => {
    assert.equal(adm("CADASTRAR", { uni: UNI_T2, imp: IMP2 }).v, "REGISTRADO|PAUSADA|CADASTRADA");
    assert.equal(adm("ATIVAR", { uni: UNI_T2 }).v, "REGISTRADO|ATIVA|ATIVADA");
    ok(`begin;
      select remapear_organizacao_em_tabelas_de_unidade('${UNI_T2}', '${ORG_T}', '${ORG_X}');
      update unidades set organizacao_id = '${ORG_X}' where id = '${UNI_T2}';
      commit;`);
    assert.equal(um(`select organizacao_id || '|' || status from foody_conexoes where unidade_id = '${UNI_T2}';`), `${ORG_X}|PAUSADA`);
    assert.equal(um(`select count(*) from foody_conexoes_eventos where unidade_id = '${UNI_T2}' and organizacao_id <> '${ORG_X}';`), "0");
    assert.equal(um(`select evento || '|' || coalesce(ator_perfil_id::text, 'auto') || '|' || status_anterior || '>' || status_novo
      from foody_conexoes_eventos where unidade_id = '${UNI_T2}' order by criado_em desc, id limit 1;`), "PAUSADA_POR_TRANSFERENCIA|auto|ATIVA>PAUSADA");
    // A organização antiga perdeu o poder; a nova decide reativar.
    recusa(adm("ATIVAR", { uni: UNI_T2 }), "UNIDADE_FORA_DA_ORGANIZACAO");
    assert.equal(adm("ATIVAR", { org: ORG_X, uni: UNI_T2, ator: ADM_X }).v, "REGISTRADO|ATIVA|ATIVADA");
  });

  test("rollbacks: 146 fail-closed com eventos; limpo sai e é idempotente; 145 recusa com a 146; 146 reaplica", () => {
    const rb146 = () => psqlSync(b.url, "", { arquivo: join(MIGRATIONS_DIR, "146_rollback.sql") });
    const r = rb146();
    assert.equal(r.ok, false); assert.match(r.err, /146/);
    const r145 = psqlSync(b.url, "", { arquivo: join(MIGRATIONS_DIR, "145_rollback.sql") });
    assert.equal(r145.ok, false); assert.match(r145.err, /146_rollback/);
    ok(`set session_replication_role = replica; delete from foody_conexoes_eventos; set session_replication_role = origin;`);
    const r2 = rb146(); assert.equal(r2.ok, true, r2.err);
    assert.equal(um(`select count(*) from pg_tables where tablename = 'foody_conexoes_eventos';`), "0");
    assert.equal(um(`select count(*) from pg_proc where proname in ('foody_conexao_administrar', 'foody_conexao_guardas', 'foody_conexao_auditar_transferencia');`), "0");
    assert.equal(um(`select count(*) from pg_trigger where tgname in ('trg_foody_conexoes_guardas', 'trg_foody_conexoes_auditar_transferencia');`), "0");
    assert.ok(Number(um("select count(*) from foody_conexoes;")) >= 3, "conexões preservadas");
    const r3 = rb146(); assert.equal(r3.ok, true, `idempotente: ${r3.err}`);
    const r4 = psqlSync(b.url, "", { arquivo: join(MIGRATIONS_DIR, "146_foody_conexao_administracao.sql") });
    assert.equal(r4.ok, true, r4.err);
    assert.equal(adm("PAUSAR", { org: ORG_X, uni: UNI_T2, ator: ADM_X }).v, "REGISTRADO|PAUSADA|PAUSADA");
  });

  test("146 sem a 145 aplicada: recusa", () => {
    const vazio = criarBancoDescartavel("foody146sem145");
    try {
      const r = psqlSync(vazio.url, "", { arquivo: join(MIGRATIONS_DIR, "146_foody_conexao_administracao.sql") });
      assert.equal(r.ok, false); assert.match(r.err, /exige as migrations 144 e 145/);
    } finally { vazio.derrubar?.(); }
  });
});
