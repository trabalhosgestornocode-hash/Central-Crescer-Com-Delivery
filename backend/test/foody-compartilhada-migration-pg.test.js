// Migration 145 (conexão Foody COMPARTILHADA entre organizações) num Postgres LOCAL e DESCARTÁVEL, schema real (base + 068..145).
// Só roda com CHECKLIST_PERFIL_PG_URL apontando para host local; caso contrário é PULADO (não é falha). Dados 100% fictícios.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55431/postgres node --test test/foody-compartilhada-migration-pg.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { motivoPular, criarBancoDescartavel, psqlSync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal, comoUsuario, MIGRATIONS_DIR } from "./helpers/schema-real-pg.js";

// Titular (estilo "Grupo" da Subway) e destino (estilo Açaí, OUTRA organização). Ids fictícios.
const ORG_T = "11111111-1111-4111-8111-111111111111", UNI_T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_D = "22222222-2222-4222-8222-222222222222", UNI_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ORG_X = "33333333-3333-4333-8333-333333333333", UNI_X = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";   // terceira, sem vínculo
const CON = "c0000000-0000-4000-8000-00000000000a", EXEC = "e0000000-0000-4000-8000-00000000000a";
const ADM_T = "a1000000-0000-4000-8000-000000000001", ADM_D = "a2000000-0000-4000-8000-000000000002";
const OPS_T = "a3000000-0000-4000-8000-000000000003", ADM_X = "a4000000-0000-4000-8000-000000000004";
const ADM_TD = "a5000000-0000-4000-8000-000000000005";   // organization_admin LEGÍTIMO das duas organizações
const H = "a".repeat(64);

describe("migration 145 — conexão compartilhada, Postgres real", { skip: motivoPular, timeout: 600_000 }, () => {
  let b;
  const ok = (texto) => { const r = psqlSync(b.url, texto); assert.equal(r.ok, true, r.err); return r.out.trim(); };
  const falha = (texto, padrao) => { const r = psqlSync(b.url, texto); assert.equal(r.ok, false, `deveria falhar: ${texto}`); if (padrao) assert.match(r.err, padrao); return r.err; };
  const um = (texto) => ok(texto).split(/\r?\n/).filter(Boolean).pop();

  const pedido = (o = {}) => {
    const p = { org: ORG_T, uni: UNI_T, uid: "u1", op: "subway", destino: "null", ativo: "true", motivo: "null", detalhes: "'1x Sub'",
      valor: "30", triagem: "null", ...o };
    return `insert into foody_pedidos (organizacao_id, unidade_id, foody_uid, numero_pedido, competencia, data_hora, status_foody, situacao, operacao,
      detalhes_pedido, valor_total, entregador_presente, entregador_hash, entregador_tipo, taxa_entregador, fonte_hash, primeira_execucao_id,
      ultima_execucao_id, destino_id, roteamento_ativo, roteamento_motivo, triagem_motivo)
      values ('${p.org}', '${p.uni}', '${p.uid}', '1', '2026-10-25', '2026-10-25T12:00:00', 'closed', 'Finalizado', '${p.op}',
      ${p.detalhes}, ${p.valor}, true, '0123456789abcdef', 'proprio', 10, '${H}', '${EXEC}', '${EXEC}', ${p.destino}, ${p.ativo}, ${p.motivo}, ${p.triagem});`;
  };
  const destinoId = () => um(`select id from foody_conexao_destinos where conexao_id = '${CON}' and estado <> 'REVOGADO';`);

  before(() => {
    b = criarBancoDescartavel("foody145");
    assert.deepEqual(construirSchemaReal(b.url), []);
    for (const [org, uni] of [[ORG_T, UNI_T], [ORG_D, UNI_D], [ORG_X, UNI_X]]) {
      ok(`insert into organizacoes (id, nome) values ('${org}', 'org ${org.slice(0, 4)}');`);
      ok(`insert into unidades (id, organizacao_id, nome) values ('${uni}', '${org}', 'unidade ${uni.slice(0, 4)}');`);
    }
    for (const [id, org, papel] of [[ADM_T, ORG_T, "organization_admin"], [ADM_D, ORG_D, "organization_admin"], [OPS_T, ORG_T, "operations"], [ADM_X, ORG_X, "organization_admin"], [ADM_TD, ORG_T, "organization_admin"]]) {
      ok(`insert into auth.users (id, email) values ('${id}', 'u${id.slice(0, 4)}@teste.invalid');
        insert into perfis (id, nome, email) values ('${id}', 'perfil ${id.slice(0, 4)}', 'u${id.slice(0, 4)}@teste.invalid');
        insert into perfis_operacionais (id, conta_id, nome) values ('${id}', '${id}', 'perfil ${id.slice(0, 4)}');
        insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('${id}', '${id}', '${org}', '${papel}');`);
    }
    ok(`insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('${ADM_TD}', '${ADM_TD}', '${ORG_D}', 'organization_admin');`);
    // O admin do destino também é membro (não admin) da titular — caso real: as mesmas pessoas nas duas empresas.
    ok(`insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('${ADM_D}', '${ADM_D}', '${ORG_T}', 'operations');`);
    ok(`insert into foody_conexoes (id, organizacao_id, unidade_id, status, token_cifrado, token_impressao) values
      ('${CON}', '${ORG_T}', '${UNI_T}', 'ATIVA', 'k1:x:y:z', '0123456789ab');`);
    ok(`insert into foody_sync_execucoes (id, organizacao_id, unidade_id, conexao_id, competencia, janela_inicio, janela_fim, origem, regra_versao)
      values ('${EXEC}', '${ORG_T}', '${UNI_T}', '${CON}', '2026-10-25', '2026-10-25T03:00Z', '2026-10-26T03:00Z', 'manual', 1);`);
  });
  after(() => b?.derrubar?.());

  const propor = (o = {}) => {
    const p = { uni: UNI_D, org: ORG_D, por: ADM_T, estado: "PENDENTE", ...o };
    return `insert into foody_conexao_destinos (conexao_id, organizacao_id, unidade_id, operacao, estado, organizacao_titular_id, aprovado_titular_por, aprovado_titular_em)
      values ('${CON}', '${p.org}', '${p.uni}', 'acai_no_grau', '${p.estado}', '${ORG_T}', ${p.por ? `'${p.por}'` : "null"}, ${p.por ? "now()" : "null"});`;
  };

  test("proposta: nasce PENDENTE, aprovada pelo organization_admin da TITULAR; titular não é destino de si mesma", () => {
    falha(propor({ estado: "ATIVO" }), /nasce PENDENTE/);
    falha(propor({ por: OPS_T }), /organization_admin da organização titular/);           // membro, mas não admin
    falha(propor({ por: ADM_D }), /organization_admin da organização titular/);           // admin da OUTRA organização
    falha(propor({ uni: UNI_T, org: ORG_T }), /titular não é destino/);
    ok(propor());
    falha(propor(), /uq_foody_destino_conexao_operacao/);                                   // um destino vivo por operação
  });

  test("ativação: exige a aprovação do organization_admin do DESTINO; sem ela, ATIVO é recusado", () => {
    const id = destinoId();
    falha(`update foody_conexao_destinos set estado = 'ATIVO' where id = '${id}';`, /ck_foody_destino_ativo/);
    falha(`update foody_conexao_destinos set aprovado_destino_por = '${ADM_T}', aprovado_destino_em = now() where id = '${id}';`,
      /organization_admin da organização de destino/);
    falha(`update foody_conexao_destinos set aprovado_destino_por = '${ADM_X}', aprovado_destino_em = now() where id = '${id}';`,
      /organization_admin da organização de destino/);
    // Pedido com dado comercial no destino ANTES da ativação: recusado.
    falha(pedido({ org: ORG_D, uni: UNI_D, uid: "a1", op: "acai_no_grau", destino: `'${id}'` }), /não está ATIVO/);
    ok(`update foody_conexao_destinos set aprovado_destino_por = '${ADM_D}', aprovado_destino_em = now(), estado = 'ATIVO' where id = '${id}';`);
    // Aprovação registrada não muda.
    falha(`update foody_conexao_destinos set aprovado_titular_por = '${ADM_X}' where id = '${id}';`, /não muda/);
    falha(`update foody_conexao_destinos set unidade_id = '${UNI_X}' where id = '${id}';`, /não mudam/);
  });

  test("auditoria: eventos gerados pelo banco, cada um no tenant de quem agiu; ativação nos dois; service_role não forja nem apaga", () => {
    const id = destinoId();
    // evento:ator:tenant(unidade):organização em nome da qual agiu
    assert.equal(ok(`select string_agg(evento || ':' || coalesce(left(ator_perfil_id::text, 4), '-') || ':' || left(unidade_id::text, 4) || ':'
      || coalesce(left(ator_organizacao_id::text, 4), '-'), ',' order by criado_em, evento, unidade_id) from foody_destinos_eventos where destino_id = '${id}';`),
      "APROVADO_TITULAR:a100:aaaa:1111,PROPOSTO:a100:aaaa:1111,APROVADO_DESTINO:a200:dddd:2222,ATIVADO:a200:aaaa:2222,ATIVADO:a200:dddd:2222");
    // Isolamento: nenhum evento fora do tenant da própria unidade.
    assert.equal(um(`select count(*) from foody_destinos_eventos e join unidades u on u.id = e.unidade_id where u.organizacao_id <> e.organizacao_id;`), "0");
    const forjar = comoUsuario(b.url, null, `insert into foody_destinos_eventos (destino_id, organizacao_id, unidade_id, evento) values ('${id}', '${ORG_D}', '${UNI_D}', 'ATIVADO');`, { papel: "service_role" });
    assert.equal(forjar.ok, false); assert.match(forjar.err, /permission denied|permissão negada/);
    // Privilégios efetivos (RLS sem policy faria um DELETE "passar" com 0 linhas — por isso a checagem é do privilégio).
    const priv = (t, p) => um(`select has_table_privilege('service_role', '${t}', '${p}');`);
    for (const t of ["foody_conexao_destinos", "foody_destinos_eventos", "foody_triagem_decisoes"]) assert.equal(priv(t, "DELETE"), "f", `${t} sem DELETE`);
    assert.equal(priv("foody_destinos_eventos", "INSERT"), "f");
    assert.equal(priv("foody_conexao_destinos", "INSERT"), "t");
    assert.equal(um(`select has_column_privilege('service_role', 'foody_conexao_destinos', 'unidade_id', 'UPDATE');`), "f");
    for (const papel of ["anon", "authenticated"]) for (const t of ["foody_conexao_destinos", "foody_destinos_eventos", "foody_triagem_decisoes"])
      assert.equal(um(`select has_table_privilege('${papel}', '${t}', 'SELECT');`), "f", `${papel} não lê ${t}`);
    for (const papel of ["anon", "authenticated"]) {
      const r = comoUsuario(b.url, null, "select count(*) from foody_conexao_destinos;", { papel });
      assert.equal(r.ok, false, `${papel} não lê destinos`);
    }
  });

  test("distribuição: Açaí completo SÓ no destino ativo; nunca ativo em duas organizações; operação/unidade conferidas", () => {
    const id = destinoId();
    ok(pedido({ org: ORG_D, uni: UNI_D, uid: "a1", op: "acai_no_grau", destino: `'${id}'`, detalhes: "'1x Acai 500ml'", valor: "40" }));
    // Mesmo uid ativo na titular (minimizado ou não): recusado pelo índice global.
    falha(pedido({ uid: "a1", op: "acai_no_grau", detalhes: "null", valor: "null" }), /uq_foody_pedidos_conexao_uid_ativo/);
    // Destino com operação errada / unidade sem destino / Açaí completo sem destino na titular.
    falha(pedido({ org: ORG_D, uni: UNI_D, uid: "a2", op: "subway", destino: `'${id}'` }), /ck_foody_pedidos_outra_operacao_minima|não confere/);
    falha(pedido({ org: ORG_X, uni: UNI_X, uid: "a3", op: "acai_no_grau", detalhes: "null", valor: "null" }), /exige destino|outra unidade/);
    falha(pedido({ uid: "a4", op: "acai_no_grau" }), /ck_foody_pedidos_outra_operacao_minima/);
    // conexao_id preenchido pelo banco a partir da execução.
    assert.equal(um(`select conexao_id from foody_pedidos where foody_uid = 'a1';`), CON);
    ok(pedido({ uid: "s1" }));
  });

  test("reclassificação: desativar exige motivo e apaga o dado comercial; reativar exige destino ATIVO", () => {
    falha(`update foody_pedidos set roteamento_ativo = false where foody_uid = 'a1';`, /ck_foody_pedidos_inativo_minimo|exige motivo/);
    falha(`update foody_pedidos set roteamento_ativo = false, roteamento_motivo = 'REROTEADO' where foody_uid = 'a1';`, /ck_foody_pedidos_inativo_minimo/);
    ok(`update foody_pedidos set roteamento_ativo = false, roteamento_motivo = 'REROTEADO', detalhes_pedido = null, valor_total = null where foody_uid = 'a1';`);
    // Linha desativada não recebe dado novo sem reativação (sync fora do modo compartilhado falharia alto, não em silêncio).
    ok(`insert into foody_sync_execucoes (id, organizacao_id, unidade_id, conexao_id, competencia, janela_inicio, janela_fim, origem, regra_versao)
      values ('e0000000-0000-4000-8000-00000000000b', '${ORG_T}', '${UNI_T}', '${CON}', '2026-10-25', '2026-10-25T03:00Z', '2026-10-26T03:00Z', 'manual', 1);`);
    falha(`update foody_pedidos set ultima_execucao_id = 'e0000000-0000-4000-8000-00000000000b' where foody_uid = 'a1' and not roteamento_ativo;`,
      /só quando reativada/);
    // Agora pode ficar ativo na titular (decisão de triagem → Subway).
    ok(pedido({ uid: "a1" }));
    assert.equal(um(`select count(*) from foody_pedidos where foody_uid = 'a1' and roteamento_ativo;`), "1");
  });

  test("triagem: fica na titular, sem dado comercial, com motivo; nunca em destino", () => {
    falha(pedido({ uid: "t1", op: "triagem", triagem: "'SEM_EVIDENCIA'" }), /ck_foody_pedidos_outra_operacao_minima/);       // valor_total
    falha(pedido({ uid: "t1", op: "triagem", valor: "null" }), /ck_foody_pedidos_triagem/);                                   // sem motivo
    ok(pedido({ uid: "t1", op: "triagem", valor: "null", triagem: "'ITEM_DESCONHECIDO'", detalhes: "'1x Produto novo'" }));
    falha(pedido({ org: ORG_D, uni: UNI_D, uid: "t2", op: "triagem", valor: "null", triagem: "'CONFLITO'", destino: `'${destinoId()}'` }),
      /ck_foody_pedidos_triagem|não confere/);
  });

  test("decisão de triagem: só organization_admin do vínculo; somente inclusão", () => {
    const decidir = (por, uid = "t1") => `insert into foody_triagem_decisoes (conexao_id, organizacao_id, unidade_id, foody_uid, operacao_decidida, decidido_por, motivo)
      values ('${CON}', '${ORG_T}', '${UNI_T}', '${uid}', 'acai_no_grau', '${por}', 'paleta nova do cardápio');`;
    falha(decidir(OPS_T), /só organization_admin/);
    falha(decidir(ADM_X), /só organization_admin/);
    falha(decidir(ADM_T, "nao-existe"), /não existe nesta conexão/);
    ok(decidir(ADM_D));            // admin do DESTINO (organização com destino ativo) também decide
    ok(decidir(ADM_T));
    falha(`update foody_triagem_decisoes set operacao_decidida = 'subway';`, /somente inclusão/);
    falha(`delete from foody_triagem_decisoes;`, /somente inclusão/);
  });

  test("fechamento da unidade destino: aceita a execução da titular só com destino ATIVO", () => {
    const reg = (org, uni) => `select resultado from foody_fechamento_registrar('${org}', '${uni}', '2026-10-25', 'CONSOLIDADO', 'SINCRONIZADO',
      gen_random_uuid(), '${EXEC}', 1, 'manual', null, null, '{}'::jsonb, '{"operacao":"acai_no_grau"}'::jsonb, '{}'::jsonb, '[]'::jsonb, '${H}');`;
    assert.equal(um(reg(ORG_D, UNI_D)), "REGISTRADO");
    falha(reg(ORG_X, UNI_X), /destino ATIVO|outra unidade/);
  });

  test("revogação: só admin de uma das organizações, definitiva; depois dela nada novo entra no destino", () => {
    const id = destinoId();
    falha(`update foody_conexao_destinos set estado = 'REVOGADO', revogado_em = now(), revogado_motivo = 'teste', revogado_por = '${OPS_T}' where id = '${id}';`, /só organization_admin/);
    ok(`update foody_conexao_destinos set estado = 'REVOGADO', revogado_em = now(), revogado_motivo = 'encerrado pelo destino', revogado_por = '${ADM_D}' where id = '${id}';`);
    falha(`update foody_conexao_destinos set estado = 'ATIVO' where id = '${id}';`, /revogado é definitivo/);
    falha(pedido({ org: ORG_D, uni: UNI_D, uid: "a9", op: "acai_no_grau", destino: `'${id}'` }), /não está ATIVO/);
    // Histórico preservado: a linha antiga continua lá (desativada pela reclassificação) e o evento REVOGADO existe.
    assert.equal(um(`select count(*) from foody_pedidos where unidade_id = '${UNI_D}';`), "1");
    assert.match(um(`select string_agg(evento, ',' order by criado_em) from foody_destinos_eventos where destino_id = '${id}';`), /REVOGADO$/);
  });

  test("transferência: unidade de destino que muda de organização tem o vínculo revogado automaticamente", () => {
    ok(propor());
    const id = destinoId();
    ok(`update foody_conexao_destinos set aprovado_destino_por = '${ADM_D}', aprovado_destino_em = now(), estado = 'ATIVO' where id = '${id}';`);
    // Mesmo caminho do remapear_organizacao_em_tabelas_de_unidade (promoção): tabelas primeiro, unidades depois, no mesmo commit.
    ok(`begin;
      update foody_conexao_destinos set organizacao_id = '${ORG_X}' where unidade_id = '${UNI_D}';
      update foody_destinos_eventos set organizacao_id = '${ORG_X}' where unidade_id = '${UNI_D}';
      update foody_fechamentos_logisticos set organizacao_id = '${ORG_X}' where unidade_id = '${UNI_D}';
      update foody_pedidos set organizacao_id = '${ORG_X}' where unidade_id = '${UNI_D}';
      update unidades set organizacao_id = '${ORG_X}' where id = '${UNI_D}';
      commit;`);
    assert.equal(um(`select estado from foody_conexao_destinos where id = '${id}';`), "REVOGADO");
    assert.match(um(`select revogado_motivo from foody_conexao_destinos where id = '${id}';`), /mudou/);
  });

  test("conexão revogada derruba os destinos vivos", () => {
    ok(`update unidades set organizacao_id = '${ORG_D}' where id = '${UNI_D}';
        update foody_conexao_destinos set organizacao_id = '${ORG_D}' where unidade_id = '${UNI_D}';
        update foody_destinos_eventos set organizacao_id = '${ORG_D}' where unidade_id = '${UNI_D}';
        update foody_fechamentos_logisticos set organizacao_id = '${ORG_D}' where unidade_id = '${UNI_D}';
        update foody_pedidos set organizacao_id = '${ORG_D}' where unidade_id = '${UNI_D}';`);
    ok(propor());
    ok(`update foody_conexoes set status = 'REVOGADA' where id = '${CON}';`);
    assert.equal(um(`select count(*) from foody_conexao_destinos where conexao_id = '${CON}' and estado <> 'REVOGADO';`), "0");
    ok(`update foody_conexoes set status = 'ATIVA' where id = '${CON}';`);
  });

  test("mesma pessoa pelas duas organizações: só com o papel LEGÍTIMO nas duas e em atos (transações) separados", () => {
    const ins = (por, quando = "now()") => `insert into foody_conexao_destinos (conexao_id, organizacao_id, unidade_id, operacao, estado, organizacao_titular_id,
      aprovado_titular_por, aprovado_titular_em) values ('${CON}', '${ORG_D}', '${UNI_D}', 'acai_no_grau', 'PENDENTE', '${ORG_T}', '${por}', ${quando});`;
    const aprovar = (por, quando = "now()") => `update foody_conexao_destinos set aprovado_destino_por = '${por}', aprovado_destino_em = ${quando}, estado = 'ATIVO'
      where conexao_id = '${CON}' and estado = 'PENDENTE';`;
    // Proposta + aprovação do destino na MESMA transação: recusada (não é um segundo ato).
    falha(`begin; ${ins(ADM_TD)} ${aprovar(ADM_TD)} commit;`, /ato separado/);
    assert.equal(um(`select count(*) from foody_conexao_destinos where conexao_id = '${CON}' and estado <> 'REVOGADO';`), "0");
    // Carimbo do cliente é ignorado: o banco grava a hora real de cada ato.
    ok(ins(ADM_TD, "'2020-01-01T00:00:00Z'"));
    assert.equal(um(`select extract(year from aprovado_titular_em) from foody_conexao_destinos where conexao_id = '${CON}' and estado = 'PENDENTE';`), "2026");
    // Admin de UMA só das organizações não completa a outra parte.
    falha(aprovar(ADM_T), /organization_admin da organização de destino/);
    ok(aprovar(ADM_TD, "'2020-01-01T00:00:00Z'"));
    const id = destinoId();
    assert.equal(um(`select (aprovado_destino_em > aprovado_titular_em)::text || ':' || extract(year from aprovado_destino_em) from foody_conexao_destinos where id = '${id}';`), "true:2026");
    assert.equal(ok(`select string_agg(evento || ':' || left(unidade_id::text, 4) || ':' || left(ator_organizacao_id::text, 4), ',' order by criado_em, evento, unidade_id)
      from foody_destinos_eventos where destino_id = '${id}' and ator_perfil_id = '${ADM_TD}';`),
      "APROVADO_TITULAR:aaaa:1111,PROPOSTO:aaaa:1111,APROVADO_DESTINO:dddd:2222,ATIVADO:aaaa:2222,ATIVADO:dddd:2222");
    assert.equal(um(`select count(*) from foody_destinos_eventos where destino_id = '${id}' and evento = 'ATIVADO' and motivo like 'Mesma pessoa%';`), "2");
    ok(`update foody_conexao_destinos set estado = 'REVOGADO', revogado_em = now(), revogado_motivo = 'fim do teste', revogado_por = '${ADM_TD}' where id = '${id}';`);
    // Papel perdido depois: a mesma pessoa não aprova mais por aquela organização.
    ok(`update usuarios_organizacoes set papel = 'operations' where perfil_id = '${ADM_TD}' and organizacao_id = '${ORG_D}';`);
    ok(ins(ADM_T));
    falha(aprovar(ADM_TD), /organization_admin da organização de destino/);
    ok(`update foody_conexao_destinos set estado = 'REVOGADO', revogado_em = now(), revogado_motivo = 'fim do teste', revogado_por = '${ADM_T}' where conexao_id = '${CON}' and estado = 'PENDENTE';`);
  });

  test("rollback 145: recusa com dado compartilhado; limpo, volta à 144 (regras originais) e reaplica", () => {
    const rb = () => psqlSync(b.url, "", { arquivo: join(MIGRATIONS_DIR, "145_rollback.sql") });
    const r = rb();
    assert.equal(r.ok, false); assert.match(r.err, /rollback 145 recusado/);
    // Banco limpo da 145: só dados no formato da 144.
    ok(`set session_replication_role = replica;
        delete from foody_triagem_decisoes; delete from foody_destinos_eventos; delete from foody_fechamentos_logisticos;
        delete from foody_pedidos; delete from foody_conexao_destinos;
        set session_replication_role = origin;`);
    ok(pedido({ uid: "s144" }));
    const r2 = rb(); assert.equal(r2.ok, true, r2.err);
    assert.equal(um(`select count(*) from pg_tables where tablename in ('foody_conexao_destinos', 'foody_destinos_eventos', 'foody_triagem_decisoes');`), "0");
    assert.equal(um(`select count(*) from information_schema.columns where table_name = 'foody_pedidos' and column_name in ('destino_id', 'conexao_id', 'roteamento_ativo');`), "0");
    assert.equal(um(`select count(*) from foody_pedidos where foody_uid = 's144';`), "1");   // dado da 144 preservado
    assert.equal(um(`select count(*) from information_schema.columns where table_name = 'foody_sync_execucoes'
      and column_name in ('catalogo_versao', 'fechamentos', 'fechamentos_pendentes');`), "0");
    // Regras da 144 de volta: 'triagem' não existe e Açaí completo continua proibido.
    falha(`insert into foody_pedidos (organizacao_id, unidade_id, foody_uid, numero_pedido, competencia, data_hora, status_foody, situacao, operacao,
      entregador_presente, entregador_tipo, fonte_hash, primeira_execucao_id, ultima_execucao_id)
      values ('${ORG_T}', '${UNI_T}', 'tz', '1', '2026-10-25', '2026-10-25T12:00:00', 'closed', 'Finalizado', 'triagem', false, 'sem_entregador', '${H}', '${EXEC}', '${EXEC}');`, /operacao_check/);
    const r4 = rb(); assert.equal(r4.ok, true, `rollback idempotente: ${r4.err}`);
    const r3 = psqlSync(b.url, "", { arquivo: join(MIGRATIONS_DIR, "145_foody_conexao_compartilhada.sql") });
    assert.equal(r3.ok, true, r3.err);
    assert.equal(um(`select count(*) from pg_tables where tablename like 'foody_%';`), "7");
    assert.equal(um(`select count(*) from information_schema.columns where table_name = 'foody_sync_execucoes'
      and column_name in ('catalogo_versao', 'fechamentos', 'fechamentos_pendentes');`), "3");
    // Pedido gravado no formato da 144 ganha a conexão da própria execução ao reaplicar (entra na unicidade global).
    assert.equal(um(`select conexao_id from foody_pedidos where foody_uid = 's144';`), CON);
  });
});
