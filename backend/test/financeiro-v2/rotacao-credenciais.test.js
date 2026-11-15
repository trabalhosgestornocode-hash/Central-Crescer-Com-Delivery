// Rotação das credenciais do Financeiro v2 (doc 31): estratégia azul/verde, nenhuma senha em saída, comandos válidos no
// PostgreSQL (executados numa transação DESFEITA no banco local isolado). Nada aqui toca o Supabase ou o Render reais.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PARES, comandosDeRevogacao, comandosDoPapel, dispararDeploy, gravarNoRender, situacaoDosPares, urlDoPapel, verificadorScram } from "../../scripts/fv2/rotacaoCredenciais.mjs";
import { abrirPool, criarBancoDeTeste, motivoParaPular } from "./helpers/postgres.js";

const papel = (rolname, rolcanlogin, conexoes = 0) => ({ rolname, rolcanlogin, conexoes, existe: true });

test("pares azul/verde: em uso, próximo e rotação em andamento", () => {
  const soA = situacaoDosPares([papel("fv2_app_login", true, 3), papel("fv2_autoridade_login", true, 1)]);
  assert.deepEqual([soA.ativo, soA.proximo, soA.emAndamento, soA.B.existe], ["A", "B", false, false]);
  const andamento = situacaoDosPares([papel("fv2_app_login", true, 0), papel("fv2_autoridade_login", true, 0), papel("fv2_app_login_b", true, 2), papel("fv2_autoridade_login_b", true, 1)]);
  assert.equal(andamento.emAndamento, true);
  const soB = situacaoDosPares([papel("fv2_app_login", false), papel("fv2_autoridade_login", false), papel("fv2_app_login_b", true, 2), papel("fv2_autoridade_login_b", true)]);
  assert.deepEqual([soB.ativo, soB.proximo], ["B", "A"], "a rotação seguinte reativa o par A com senha nova");
  assert.deepEqual(PARES.A.map((p) => p.limite), PARES.B.map((p) => p.limite), "mesmos limites de conexão");
});

test("comandos: só papéis da lista, verificador SCRAM (nunca a senha), revogação sem exclusão", () => {
  const senha = "senha-sintetica-de-teste-nao-usar";
  const v = verificadorScram(senha);
  assert.match(v, /^SCRAM-SHA-256\$4096:/);
  const cmds = comandosDoPapel(PARES.B[0], false, v);
  assert.ok(cmds.every((c) => !c.includes(senha)), "a senha nunca entra no SQL");
  assert.match(cmds[0], /^create role fv2_app_login_b login noinherit connection limit 4 password 'SCRAM-SHA-256/);
  assert.match(comandosDoPapel(PARES.A[1], true, v)[0], /^alter role fv2_autoridade_login login noinherit connection limit 2/);
  assert.throws(() => comandosDoPapel({ login: "postgres", grupo: "fv2_app", limite: 1 }, false, v));
  assert.throws(() => comandosDoPapel(PARES.A[0], false, "texto'; drop role x; --"));
  const rev = comandosDeRevogacao(PARES.A[0]);
  assert.equal(rev[0], "alter role fv2_app_login nologin password null");
  assert.ok(rev.every((c) => !/\bdrop\b|\bdelete\b|\btruncate\b/i.test(c)), "revogar não exclui nada");
});

test("Render: PUT da variável e deploy pela API; a resposta e os erros nunca carregam a senha", async () => {
  const pedidos = [];
  const fetchFn = async (url, o) => { pedidos.push({ url, o }); return { ok: true, status: 200, json: async () => ({ id: "dep-sintetico" }) }; };
  const senha = "Zz9-senha-sintetica";
  const valor = urlDoPapel("fv2_app_login_b", senha);
  assert.equal(await gravarNoRender({ fetchFn, chave: "chave-sintetica", servico: "srv-sintetico1", variavel: "FV2_APP_DATABASE_URL", valor }), 200);
  assert.equal(pedidos[0].url, "https://api.render.com/v1/services/srv-sintetico1/env-vars/FV2_APP_DATABASE_URL");
  assert.equal(pedidos[0].o.method, "PUT");
  assert.equal(JSON.parse(pedidos[0].o.body).value, valor);
  assert.equal(await dispararDeploy({ fetchFn, chave: "chave-sintetica", servico: "srv-sintetico1" }), "dep-sintetico");
  const recusa = async () => ({ ok: false, status: 401 });
  await assert.rejects(gravarNoRender({ fetchFn: recusa, chave: "x", servico: "srv-sintetico1", variavel: "FV2_APP_DATABASE_URL", valor }), (e) => !e.message.includes(senha) && /HTTP 401/.test(e.message));
  await assert.rejects(gravarNoRender({ fetchFn, chave: "x", servico: "srv-sintetico1", variavel: "DATABASE_URL", valor }), /fora da lista/);
  assert.match(valor, /^postgresql:\/\/fv2_app_login_b\.uqybgauuxcrqzquultfu:.+@aws-1-us-west-2\.pooler\.supabase\.com:5432\/postgres$/);
});

test("comandos válidos no PostgreSQL (transação desfeita no banco local isolado)", { skip: motivoParaPular() }, async () => {
  const { urlAdmin } = await criarBancoDeTeste([]);
  const dono = await abrirPool(urlAdmin, { max: 1 });
  const grupos = (await dono.query("select string_agg(rolname, ',' order by rolname) g from pg_roles where rolname in ('fv2_app','fv2_autoridade')")).rows[0].g;
  assert.equal(grupos, "fv2_app,fv2_autoridade", "o banco local tem os papéis de grupo do v2");
  await dono.query("begin");
  try {
    for (const p of PARES.B) for (const c of comandosDoPapel(p, false, verificadorScram("sintetica"))) await dono.query(c);
    const r = (await dono.query("select rolname, rolcanlogin, rolconnlimit, rolinherit from pg_roles where rolname like 'fv2\\_%\\_login\\_b' order by rolname")).rows;
    assert.deepEqual(r.map((x) => [x.rolname, x.rolcanlogin, x.rolconnlimit, x.rolinherit]), [["fv2_app_login_b", true, 4, false], ["fv2_autoridade_login_b", true, 2, false]]);
    for (const p of PARES.B) await dono.query(comandosDeRevogacao(p)[0]);
    assert.equal((await dono.query("select count(*)::int n from pg_roles where rolname like 'fv2\\_%\\_login\\_b' and rolcanlogin")).rows[0].n, 0);
  } finally {
    await dono.query("rollback");
  }
});
