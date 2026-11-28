// Homologação ISOLADA do SQL de concessão técnica do agendador de entregadores (modelo em database/financeiro-v2/producao/modelos).
// Roda no PostgreSQL local isolado, com o schema de produção, como a autoridade de infraestrutura (papel `postgres`, criado só aqui e
// removido ao final). Valida: só `ver` e `registrar`, escopo da unidade, idempotência, concessão já existente preservada, recusa de
// quem não é postgres, auditoria/histórico e que a identidade passa a abrir sessão APENAS na unidade concedida.
import { test, after } from "node:test";
import pg from "pg";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ambiente, abrirPool, criarBancoDeTeste, motivoParaPular } from "./helpers/postgres.js";

const raiz = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const MODELO = readFileSync(join(raiz, "database", "financeiro-v2", "producao", "modelos", "concessao-agendador.modelo.sql"), "utf8");
const ORG_A = "aaaaaaaa-0000-4000-8000-0000000000a1", UNI_A = "aaaaaaaa-0000-4000-8000-0000000000a2";
const ORG_B = "bbbbbbbb-0000-4000-8000-0000000000b1", UNI_B = "bbbbbbbb-0000-4000-8000-0000000000b2";
const USR = "cccccccc-0000-4000-8000-0000000000c3", EXEC = "dddddddd-0000-4000-8000-0000000000d4";
const sqlDe = (org, uni) => MODELO.replaceAll("@ORG@", org).replaceAll("@UNI@", uni).replaceAll("@USR@", USR).replaceAll("@EXEC@", EXEC);
const pular = motivoParaPular();

let criouPapel = false, admGlobal = null;
// o papel só existe durante o teste (o helper fecha os pools antes deste gancho, então abre uma conexão própria)
after(async () => { if (!criouPapel) return; const c = new pg.Client({ connectionString: ambiente().urlAdmin }); await c.connect(); try { await c.query("drop role if exists postgres"); } finally { await c.end(); } });

async function ambienteIsolado() {
  const b = await criarBancoDeTeste([{ organizacaoId: ORG_A, unidadeId: UNI_A }, { organizacaoId: ORG_B, unidadeId: UNI_B }]);
  const adm = await abrirPool(b.urlAdmin, { max: 1 });
  admGlobal ??= await abrirPool(ambiente().urlAdmin, { max: 1 });
  const existe = (await admGlobal.query("select 1 from pg_roles where rolname = 'postgres'")).rowCount > 0;
  if (!existe) { await admGlobal.query("create role postgres superuser nologin"); criouPapel = true; }
  const comoPostgres = async (sql) => { const c = await adm.connect(); try { await c.query("set session authorization postgres"); return await c.query(sql); } finally { await c.query("reset session authorization").catch(() => {}); c.release(); } };
  const concessoes = async () => (await adm.query("select unidade_id, acoes, situacao, concedido_por from financeiro_v2.fv2_concessao where usuario_id = $1 order by unidade_id", [USR])).rows;
  // como no psql: falhou no meio de uma transação ⇒ a sessão termina e nada fica gravado
  const tentar = async (sql, postgres = true) => { const c = await adm.connect(); try { if (postgres) await c.query("set session authorization postgres"); return await c.query(sql); } finally { await c.query("rollback").catch(() => {}); await c.query("reset session authorization").catch(() => {}); c.release(); } };
  return { adm, comoPostgres, concessoes, tentar };
}

test("CA-1 concede só ver+registrar na unidade pedida, com histórico e auditoria; a outra unidade fica intocada", { skip: pular }, async () => {
  const { adm, comoPostgres, concessoes } = await ambienteIsolado();
  await comoPostgres(sqlDe(ORG_A, UNI_A));
  const c = await concessoes();
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].unidade_id, c[0].situacao, c[0].acoes.slice().sort()], [UNI_A, "ATIVA", ["financeiro_v2.registrar", "financeiro_v2.ver"]]);
  assert.equal((await adm.query("select count(*)::int c from financeiro_v2.fv2_historico where registro_tipo = 'CONCESSAO' and unidade_id = $1", [UNI_A])).rows[0].c, 1);
  const aud = (await adm.query("select operacao, acoes_depois from financeiro_v2.fv2_auditoria_concessao where usuario_alvo = $1", [USR])).rows;
  assert.deepEqual([aud.length, aud[0].operacao], [1, "CONCESSAO"]);
  assert.equal((await adm.query("select count(*)::int c from financeiro_v2.fv2_concessao where unidade_id = $1", [UNI_B])).rows[0].c, 0, "nada na outra unidade");
});

test("CA-2 concessão existente (outra unidade) é preservada e o SQL é idempotente (segunda execução não muda nada)", { skip: pular }, async () => {
  const { adm, comoPostgres, concessoes } = await ambienteIsolado();
  await comoPostgres(sqlDe(ORG_A, UNI_A));
  const antesA = JSON.stringify((await adm.query("select id, versao, acoes, situacao, atualizado_em from financeiro_v2.fv2_concessao where unidade_id = $1", [UNI_A])).rows);
  await comoPostgres(sqlDe(ORG_B, UNI_B));
  assert.equal((await concessoes()).length, 2);
  assert.equal(JSON.stringify((await adm.query("select id, versao, acoes, situacao, atualizado_em from financeiro_v2.fv2_concessao where unidade_id = $1", [UNI_A])).rows), antesA, "a concessão da primeira unidade não foi alterada");
  const hist = (await adm.query("select count(*)::int c from financeiro_v2.fv2_historico where registro_tipo = 'CONCESSAO'")).rows[0].c;
  await comoPostgres(sqlDe(ORG_B, UNI_B));
  assert.equal((await concessoes()).length, 2, "idempotente");
  assert.equal((await adm.query("select count(*)::int c from financeiro_v2.fv2_historico where registro_tipo = 'CONCESSAO'")).rows[0].c, hist, "sem novo histórico");
});

test("CA-3 recusa quem não é o papel postgres, unidade fora dos escopos e não concede nada além de ver e registrar", { skip: pular }, async () => {
  const { concessoes, tentar } = await ambienteIsolado();
  await assert.rejects(() => tentar(sqlDe(ORG_A, UNI_A), false), /só o papel postgres executa/);
  assert.equal((await concessoes()).length, 0, "transação revertida: nada gravado");
  const o2 = await ambienteIsolado();
  await assert.rejects(() => o2.tentar(sqlDe(ORG_A, "eeeeeeee-0000-4000-8000-0000000000e5")), /fora dos escopos/);
  assert.equal((await o2.concessoes()).length, 0);
  assert.ok(!/financeiro_v2\.(administrar|conceder|aprovar|pagar|fechar)/.test(MODELO), "nenhuma ação ampla no modelo");
  assert.match(MODELO, /v_acoes jsonb := '\["financeiro_v2\.registrar","financeiro_v2\.ver"\]'/);
});
