// Múltiplas conexões iFood por unidade (migrations 124/125) em Postgres LOCAL e DESCARTÁVEL, sobre o schema REAL do projeto.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55430/postgres node --experimental-vm-modules --test test/ifood-multi-conexao-pg.test.js
//
// Cobre: a 124 é aditiva e não toca em nada existente; o índice antigo segue valendo até a 125; a rotulagem supervisionada (script) e a sua
// reversão; unicidade por (unidade, finalidade) e por merchant; credencial só na finalidade compatível; a finalidade não muda de uma para
// outra; loja adicional não entra na conexão financeira; revogar uma conexão não toca na outra; rollbacks que se RECUSAM a perder a distinção.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { motivoPular, criarBancoDescartavel, sql, psqlSync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal, MIGRATIONS_DIR } from "./helpers/schema-real-pg.js";

const OPS = join(MIGRATIONS_DIR, "..", "operacoes");
const M = (f) => join(MIGRATIONS_DIR, f);

const ORG = "00000000-0000-0000-0000-0000000000a0"; const ORG2 = "00000000-0000-0000-0000-0000000000b0";
const UN_SACI = "00000000-0000-0000-0000-0000000000a1"; const UN_NORTH = "00000000-0000-0000-0000-0000000000a2"; const UN_OUTRA = "00000000-0000-0000-0000-0000000000b1";
const CON_SACI = "11111111-1111-4111-8111-1111111111a1"; const CON_NORTH_TESTE = "11111111-1111-4111-8111-1111111111a2";
const CON_OUTRA = "11111111-1111-4111-8111-1111111111b1"; const CON_NORTH_REAL = "11111111-1111-4111-8111-1111111111a3";
const M_SACI = "a6e54f00-0000-4000-8000-0000000039b9"; const M_NORTH_TESTE = "7e570000-0000-4000-8000-00000000aaaa";
const M_NORTH_REAL = "ea100000-0000-4000-8000-00000000bbbb"; const M_OUTRA = "55c8f400-0000-4000-8000-000000007040";

function psqlComVars(url, arquivo, vars) {
  const args = [url, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-t", "-A", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), "-f", arquivo];
  const r = spawnSync(process.env.EXIBICAO_PSQL || "psql", args, { encoding: "utf8", env: { ...process.env, PGOPTIONS: "-c lc_messages=C", PGCLIENTENCODING: "UTF8" }, timeout: 120_000 });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

describe("múltiplas conexões iFood por unidade (124/125) — Postgres descartável, schema real", { skip: motivoPular, timeout: 900_000 }, () => {
  let b;
  const q = (t) => sql(b.url, t);
  const tenta = (t) => psqlSync(b.url, t);
  const aplica = (f) => psqlSync(b.url, "", { arquivo: M(f) });
  const rotular = (conexao, finalidade, extra = {}) => psqlComVars(b.url, join(OPS, "ifood-conexao-rotular.sql"), { conexao, finalidade, ...extra });
  const desrotular = (conexao) => psqlComVars(b.url, join(OPS, "ifood-conexao-rotular-rollback.sql"), { conexao });
  const cred = (con, app, status = "ativa") => `insert into ifood_credenciais (conexao_id, app_type, access_token_cifrado, refresh_token_cifrado, expira_em, status) values ('${con}', '${app}', 'x', 'y', now() + interval '1 hour', '${status}')`;
  const fin = (con) => q(`select finalidade || '|' || ambiente from ifood_conexoes where id = '${con}'`);
  const snapshot = () => q(`select md5(string_agg(c::text, '|' order by id)) from (select id, organizacao_id, unidade_id, merchant_id, status, merchant_nome from ifood_conexoes) c`)
    + "/" + q("select md5(string_agg(k::text, '|' order by id)) from ifood_credenciais k");

  before(() => {
    b = criarBancoDescartavel("multi_conexao");
    const falhas = construirSchemaReal(b.url, { ate: 123 });
    assert.deepEqual(falhas, [], JSON.stringify(falhas));
    q(`insert into organizacoes (id, nome) values ('${ORG}', 'Org A'), ('${ORG2}', 'Org B');
       insert into unidades (id, nome, organizacao_id) values ('${UN_SACI}', 'Saci', '${ORG}'), ('${UN_NORTH}', 'North', '${ORG}'), ('${UN_OUTRA}', 'Outra loja', '${ORG2}');
       insert into ifood_conexoes (id, organizacao_id, unidade_id, merchant_id, status) values
         ('${CON_SACI}', '${ORG}', '${UN_SACI}', '${M_SACI}', 'ativa'),
         ('${CON_NORTH_TESTE}', '${ORG}', '${UN_NORTH}', '${M_NORTH_TESTE}', 'ativa'),
         ('${CON_OUTRA}', '${ORG2}', '${UN_OUTRA}', '${M_OUTRA}', 'ativa');
       ${cred(CON_SACI, "order")}; ${cred(CON_SACI, "financial")}; ${cred(CON_SACI, "analytics")};
       ${cred(CON_NORTH_TESTE, "financial")}; ${cred(CON_NORTH_TESTE, "analytics")};
       ${cred(CON_OUTRA, "order")};`);
  });
  after(() => b?.derrubar());

  describe("124 — aditiva", () => {
    let antes;
    test("aplicar a 124 não altera NENHUMA conexão nem credencial existente; tudo vira `legado`", () => {
      antes = q("select md5(string_agg(c::text, '|' order by id)) from (select id, organizacao_id, unidade_id, merchant_id, status, merchant_nome from ifood_conexoes) c")
        + "/" + q("select md5(string_agg(k::text, '|' order by id)) from ifood_credenciais k");
      assert.equal(aplica("124_ifood_conexao_finalidade.sql").ok, true);
      assert.equal(snapshot(), antes);
      assert.equal(q("select string_agg(distinct finalidade || '|' || ambiente, ',') from ifood_conexoes"), "legado|nao_informado");
      assert.equal(q("select count(*) from ifood_credenciais"), "6");
    });
    test("idempotente", () => {
      assert.equal(aplica("124_ifood_conexao_finalidade.sql").ok, true);
      assert.equal(snapshot(), antes);
    });
    test("o índice ANTIGO continua valendo: uma 2ª conexão viva na mesma unidade ainda é recusada", () => {
      assert.equal(q("select count(*) from pg_indexes where indexname = 'uq_ifood_conexao_unidade_viva'"), "1");
      const r = tenta(`insert into ifood_conexoes (organizacao_id, unidade_id, status, finalidade, ambiente) values ('${ORG}', '${UN_NORTH}', 'pendente', 'pedidos_producao', 'producao')`);
      assert.equal(r.ok, false);
      assert.match(r.err, /uq_ifood_conexao_unidade_viva/);
    });
    test("CHECKs: finalidade e ambiente andam juntos; valores fora do vocabulário são recusados", () => {
      assert.equal(tenta(`update ifood_conexoes set finalidade = 'pedidos_producao' where id = '${CON_OUTRA}'`).ok, false, "ambiente nao_informado não combina com pedidos_producao");
      assert.equal(tenta(`update ifood_conexoes set finalidade = 'qualquer' where id = '${CON_OUTRA}'`).ok, false);
      assert.equal(tenta(`update ifood_conexoes set ambiente = 'staging' where id = '${CON_OUTRA}'`).ok, false);
      assert.equal(snapshot(), antes);
    });
  });

  describe("rotulagem supervisionada (script) e reversão", () => {
    test("financeiro_homologacao exige a confirmação explícita; sem ela aborta e não grava", () => {
      const r = rotular(CON_NORTH_TESTE, "financeiro_homologacao");
      assert.equal(r.ok, false);
      assert.equal(fin(CON_NORTH_TESTE), "legado|nao_informado");
    });
    test("recusa finalidade inválida e conexão inexistente", () => {
      assert.equal(rotular(CON_NORTH_TESTE, "qualquer", { confirmo_homologacao: "sim" }).ok, false);
      assert.equal(rotular("22222222-2222-4222-8222-222222222222", "pedidos_producao").ok, false);
    });
    test("recusa rotular conexão com credencial INCOMPATÍVEL (Saci tem order+financial: nenhuma finalidade exclusiva serve)", () => {
      assert.equal(rotular(CON_SACI, "financeiro_homologacao", { confirmo_homologacao: "sim" }).ok, false);
      assert.equal(rotular(CON_SACI, "pedidos_producao").ok, false);
      assert.equal(fin(CON_SACI), "legado|nao_informado");
    });
    test("rotula a conexão de TESTE da North como financeiro_homologacao SEM tocar merchant, status nem credenciais", () => {
      const antes = snapshot();
      // linha INTEIRA da conexão (todas as colunas, exceto finalidade, ambiente e o carimbo de atualização) e TODAS as credenciais (tokens cifrados inclusos)
      const inteira = () => q(`select md5((to_jsonb(c) - 'finalidade' - 'ambiente' - 'atualizado_em')::text) from ifood_conexoes c where id = '${CON_NORTH_TESTE}'`) + "/" + q(`select md5(string_agg(k::text, '|' order by app_type)) from ifood_credenciais k where conexao_id = '${CON_NORTH_TESTE}'`);
      const inteiraAntes = inteira();
      const r = rotular(CON_NORTH_TESTE, "financeiro_homologacao", { confirmo_homologacao: "sim" });
      assert.equal(r.ok, true, r.err);
      assert.equal(fin(CON_NORTH_TESTE), "financeiro_homologacao|homologacao");
      assert.equal(snapshot(), antes, "merchant, status e credenciais idênticos");
      assert.equal(inteira(), inteiraAntes, "conexão (todas as colunas menos finalidade/ambiente/atualizado_em) e credenciais, tokens inclusos, byte a byte");
      assert.equal(q("select count(*) from plataforma_auditoria where acao = 'ifood.conexao_rotulada'"), "1");
    });
    test("a reversão volta a `legado`; reaplicar a rotulagem funciona", () => {
      assert.equal(desrotular(CON_NORTH_TESTE).ok, true);
      assert.equal(fin(CON_NORTH_TESTE), "legado|nao_informado");
      assert.equal(desrotular(CON_NORTH_TESTE).ok, false, "já é legado");
      assert.equal(rotular(CON_NORTH_TESTE, "financeiro_homologacao", { confirmo_homologacao: "sim" }).ok, true);
      assert.equal(fin(CON_NORTH_TESTE), "financeiro_homologacao|homologacao");
    });
    test("a finalidade não muda direto de uma para outra", () => {
      const r = tenta(`update ifood_conexoes set finalidade = 'pedidos_producao', ambiente = 'producao' where id = '${CON_NORTH_TESTE}'`);
      assert.equal(r.ok, false);
    });
  });

  describe("125 — coexistência", () => {
    test("a 125 se recusa sem a 124; com ela remove SÓ o índice antigo e não altera linhas", () => {
      const antes = snapshot();
      assert.equal(aplica("125_ifood_conexao_remove_indice_unidade.sql").ok, true);
      assert.equal(q("select count(*) from pg_indexes where indexname = 'uq_ifood_conexao_unidade_viva'"), "0");
      assert.equal(q("select count(*) from pg_indexes where indexname in ('uq_ifood_conexao_merchant_vivo', 'uq_ifood_conexao_unidade_finalidade_viva')"), "2");
      assert.equal(snapshot(), antes);
      assert.equal(aplica("125_ifood_conexao_remove_indice_unidade.sql").ok, true, "idempotente");
    });
    test("a North ganha a conexão de PEDIDOS REAIS ao lado da de teste (financeiro_homologacao) — as duas vivas", () => {
      const antes = snapshot();
      q(`insert into ifood_conexoes (id, organizacao_id, unidade_id, status, finalidade, ambiente) values ('${CON_NORTH_REAL}', '${ORG}', '${UN_NORTH}', 'pendente', 'pedidos_producao', 'producao')`);
      q(`update ifood_conexoes set merchant_id = '${M_NORTH_REAL}', status = 'ativa' where id = '${CON_NORTH_REAL}'`);
      assert.equal(q(`select count(*) from ifood_conexoes where unidade_id = '${UN_NORTH}' and status <> 'revogada'`), "2");
      // a conexão de teste está EXATAMENTE como antes (a nova linha é a única diferença)
      assert.equal(q(`select merchant_id || '|' || status || '|' || finalidade from ifood_conexoes where id = '${CON_NORTH_TESTE}'`), `${M_NORTH_TESTE}|ativa|financeiro_homologacao`);
      assert.equal(q(`select count(*) from ifood_credenciais where conexao_id = '${CON_NORTH_TESTE}'`), "2");
      assert.notEqual(snapshot(), antes);
    });
    test("unicidade: uma conexão viva por (unidade, finalidade); o mesmo merchant não vive em duas conexões", () => {
      assert.match(tenta(`insert into ifood_conexoes (organizacao_id, unidade_id, status, finalidade, ambiente) values ('${ORG}', '${UN_NORTH}', 'pendente', 'pedidos_producao', 'producao')`).err, /uq_ifood_conexao_unidade_finalidade_viva/);
      assert.match(tenta(`insert into ifood_conexoes (organizacao_id, unidade_id, status, finalidade, ambiente) values ('${ORG}', '${UN_NORTH}', 'pendente', 'financeiro_homologacao', 'homologacao')`).err, /uq_ifood_conexao_unidade_finalidade_viva/);
      assert.match(tenta(`update ifood_conexoes set merchant_id = '${M_NORTH_TESTE}' where id = '${CON_NORTH_REAL}'`).err, /uq_ifood_conexao_merchant_vivo/, "o merchant de teste não pode ir para a conexão de pedidos");
      assert.match(tenta(`update ifood_conexoes set merchant_id = '${M_SACI}' where id = '${CON_NORTH_REAL}'`).err, /uq_ifood_conexao_merchant_vivo/, "nem o da Saci");
    });
    test("credencial só entra na finalidade compatível (order x financial/analytics)", () => {
      assert.match(tenta(cred(CON_NORTH_TESTE, "order")).err, /nunca recebe credencial order/);
      assert.match(tenta(cred(CON_NORTH_REAL, "financial")).err, /aceita apenas credencial order/);
      assert.match(tenta(cred(CON_NORTH_REAL, "analytics")).err, /aceita apenas credencial order/);
      assert.equal(tenta(cred(CON_NORTH_REAL, "order")).ok, true);
      assert.match(tenta(`update ifood_credenciais set conexao_id = '${CON_NORTH_TESTE}' where conexao_id = '${CON_NORTH_REAL}' and app_type = 'order'`).err, /nunca recebe credencial order/, "nem movendo");
    });
    test("loja adicional (117) não entra na conexão financeira; entra na de pedidos", () => {
      const ins = (con) => tenta(`insert into ifood_conexao_lojas (conexao_id, organizacao_id, unidade_id, merchant_id) values ('${con}', '${ORG}', '${UN_NORTH}', 'cccccccc-0000-4000-8000-00000000000c')`);
      assert.match(ins(CON_NORTH_TESTE).err, /loja adicional nao pode/);
      assert.equal(ins(CON_NORTH_REAL).ok, true);
      assert.equal(q("select count(*) from ifood_conexao_lojas"), "1");
    });
    test("a Saci (legado) segue idêntica e outra empresa/unidade não é afetada", () => {
      assert.equal(fin(CON_SACI), "legado|nao_informado");
      assert.equal(fin(CON_OUTRA), "legado|nao_informado");
      assert.equal(q(`select count(*) from ifood_credenciais where conexao_id = '${CON_SACI}'`), "3");
    });
    test("revogar UMA conexão não toca a outra (nem as credenciais dela)", () => {
      q(`delete from ifood_credenciais where conexao_id = '${CON_NORTH_REAL}'`);
      q(`update ifood_conexoes set status = 'revogada' where id = '${CON_NORTH_REAL}'`);
      assert.equal(q(`select status from ifood_conexoes where id = '${CON_NORTH_TESTE}'`), "ativa");
      assert.equal(q(`select count(*) from ifood_credenciais where conexao_id = '${CON_NORTH_TESTE}'`), "2");
      assert.equal(q(`select merchant_id from ifood_conexoes where id = '${CON_NORTH_TESTE}'`), M_NORTH_TESTE);
      // revogada libera a vaga: uma nova conexão de pedidos pode nascer (o histórico da anterior fica)
      assert.equal(tenta(`insert into ifood_conexoes (organizacao_id, unidade_id, status, finalidade, ambiente) values ('${ORG}', '${UN_NORTH}', 'pendente', 'pedidos_producao', 'producao')`).ok, true);
      assert.equal(q(`select count(*) from ifood_conexoes where unidade_id = '${UN_NORTH}'`), "3");
    });
  });

  describe("rollbacks — recusam-se a perder a distinção entre conexões", () => {
    test("125_rollback recusa com duas conexões vivas na unidade", () => {
      const r = aplica("125_rollback.sql");
      assert.equal(r.ok, false);
      assert.match(r.err, /mais de uma conexao viva/);
      assert.equal(q("select count(*) from pg_indexes where indexname = 'uq_ifood_conexao_unidade_viva'"), "0");
    });
    test("124_rollback recusa com conexão rotulada", () => {
      const r = aplica("124_rollback.sql");
      assert.equal(r.ok, false);
      assert.match(r.err, /conexao rotulada/);
      assert.equal(q("select count(*) from information_schema.columns where table_name = 'ifood_conexoes' and column_name = 'finalidade'"), "1");
    });
    test("a reversão da rotulagem recusa enquanto a unidade tem OUTRA conexão viva", () => {
      assert.equal(desrotular(CON_NORTH_TESTE).ok, false);
      assert.equal(fin(CON_NORTH_TESTE), "financeiro_homologacao|homologacao");
    });
    test("desfazendo na ordem certa (revogar a extra, 125_rollback, desrotular, 124_rollback) tudo volta ao estado anterior", () => {
      q(`update ifood_conexoes set status = 'revogada' where unidade_id = '${UN_NORTH}' and finalidade = 'pedidos_producao'`);
      assert.equal(aplica("125_rollback.sql").ok, true);
      assert.equal(q("select count(*) from pg_indexes where indexname = 'uq_ifood_conexao_unidade_viva'"), "1");
      assert.equal(desrotular(CON_NORTH_TESTE).ok, true);
      // sessão OAuth pendente com finalidade: o rollback da 124 espera/recusa (não perde a autorização em curso)
      q(`insert into ifood_oauth_sessoes (organizacao_id, unidade_id, app_type, user_code, expira_em, finalidade, status) values ('${ORG}', '${UN_NORTH}', 'order', 'ABCD-1234', now() + interval '10 minutes', 'pedidos_producao', 'pending')`);
      const bloqueado = aplica("124_rollback.sql");
      assert.equal(bloqueado.ok, false);
      assert.match(bloqueado.err, /sessao OAuth pendente/);
      q("update ifood_oauth_sessoes set status = 'failed' where finalidade is not null");
      assert.equal(aplica("124_rollback.sql").ok, true);
      assert.equal(q("select count(*) from information_schema.columns where table_name in ('ifood_conexoes', 'ifood_oauth_sessoes') and column_name in ('finalidade', 'ambiente')"), "0");
      assert.equal(q("select count(*) from pg_trigger where tgname like 'trg_ifood_%finalidade'"), "0");
      assert.equal(q(`select merchant_id from ifood_conexoes where id = '${CON_NORTH_TESTE}'`), M_NORTH_TESTE);
      assert.equal(q(`select count(*) from ifood_credenciais where conexao_id = '${CON_NORTH_TESTE}'`), "2");
      assert.equal(q(`select count(*) from ifood_credenciais where conexao_id = '${CON_SACI}'`), "3");
    });
  });
});
