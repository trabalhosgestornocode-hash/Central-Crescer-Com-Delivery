// Guarda de destino do banco: o Financeiro v2 só executa SQL no PostgreSQL local isolado.
// A primeira parte é pura (não conecta em nada). A segunda usa o ambiente isolado para provar a conferência do destino EFETIVO.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { CODIGO, comprovarDestinoIsolado, criarRepositorioPostgres, exigirDestinoLocal } from "../../src/modules/financeiro-v2/index.js";
import { abrirPoolSeguro, aplicarMigracoes, urlDoBanco } from "../../scripts/fv2/ambiente.mjs";
import { ORG_A, UNI_A, rejeita } from "./helpers/cenario.js";
import { abrirPool, ambiente, motivoParaPular } from "./helpers/postgres.js";

const recusado = (fn) => assert.throws(fn, (e) => e.codigo === CODIGO.DESTINO_NAO_AUTORIZADO);
const MARCADOR = "ab".repeat(32);

test("endereço ausente, desconhecido ou remoto é bloqueado antes de qualquer conexão", () => {
  assert.deepEqual(exigirDestinoLocal("postgres://fv2_teste_app:segredo@127.0.0.1:54329/fv2_teste_abc123"), { endereco: "127.0.0.1", porta: "54329", banco: "fv2_teste_abc123", usuario: "fv2_teste_app" });
  assert.equal(exigirDestinoLocal("postgresql://fv2_admin:s@[::1]:54329/fv2_teste").endereco, "::1");
  for (const ruim of [
    undefined, null, "", "   ", 42, {},
    "nao e uma url",
    "mysql://fv2_teste_app:s@127.0.0.1:54329/fv2_teste",
    "https://127.0.0.1:54329/fv2_teste",
    // Servidores remotos — inclusive com nomes "de teste" — nunca passam.
    "postgres://fv2_teste_app:s@db.exemplo-remoto.com:54329/fv2_teste",
    "postgres://fv2_teste_app:s@test-db.internal:54329/fv2_teste",
    "postgres://fv2_teste_app:s@aws-0-sa-east-1.pooler.provedor.com:6543/fv2_teste",
    "postgres://fv2_teste_app:s@10.0.0.5:54329/fv2_teste",
    "postgres://fv2_teste_app:s@192.168.0.10:54329/fv2_teste",
    "postgres://fv2_teste_app:s@0.0.0.0:54329/fv2_teste",
    // Nome de máquina não prova destino, nem "localhost".
    "postgres://fv2_teste_app:s@localhost:54329/fv2_teste",
    "postgres://fv2_teste_app:s@127.0.0.1.exemplo.com:54329/fv2_teste",
    // Porta ausente ou padrão: não é a instância exclusiva.
    "postgres://fv2_teste_app:s@127.0.0.1/fv2_teste",
    "postgres://fv2_teste_app:s@127.0.0.1:5432/fv2_teste",
    // Banco ou usuário que não são do ambiente de teste do Financeiro v2 (nome parecido não basta).
    "postgres://fv2_teste_app:s@127.0.0.1:54329/postgres",
    "postgres://fv2_teste_app:s@127.0.0.1:54329/producao",
    "postgres://fv2_teste_app:s@127.0.0.1:54329/test",
    "postgres://fv2_teste_app:s@127.0.0.1:54329/fv2_producao",
    "postgres://fv2_teste_app:s@127.0.0.1:54329/meu_fv2_teste",
    "postgres://fv2_teste_app:s@127.0.0.1:54329/",
    "postgres://postgres:s@127.0.0.1:54329/fv2_teste",
    "postgres://service_role:s@127.0.0.1:54329/fv2_teste",
    "postgres://127.0.0.1:54329/fv2_teste",
    // Parâmetros que redirecionariam a conexão para outro servidor.
    "postgres://fv2_teste_app:s@127.0.0.1:54329/fv2_teste?host=db.exemplo-remoto.com",
    "postgres://fv2_teste_app:s@127.0.0.1:54329/fv2_teste?hostaddr=10.0.0.5",
    "postgres://fv2_teste_app:s@127.0.0.1:54329/fv2_teste?options=-c%20search_path%3Dx",
  ]) {
    recusado(() => exigirDestinoLocal(ruim));
  }
});

test("a mensagem de recusa não vaza o endereço nem a senha", () => {
  try {
    exigirDestinoLocal("postgres://usuario_real:senha-super-secreta@db.exemplo-remoto.com:5432/producao");
    assert.fail("deveria recusar");
  } catch (e) {
    const texto = `${e.message} ${JSON.stringify(e.detalhes)}`;
    assert.ok(!/senha-super-secreta|usuario_real|exemplo-remoto/.test(texto), texto);
  }
});

test("destino efetivo: resposta do servidor que não comprova o ambiente isolado é recusada", async () => {
  const declarado = { porta: "54329", banco: "fv2_teste_x", usuario: "fv2_teste_app" };
  const boa = { banco: "fv2_teste_x", usuario: "fv2_teste_app", endereco: "127.0.0.1", porta: "54329", marcador: `FV2_ISOLADO_TESTE:${MARCADOR}`, esquemas_alheios: 0, papeis_alheios: 0, bancos_alheios: 0 };
  const falso = (linha) => ({ query: async () => ({ rows: linha ? [linha] : [] }) });
  assert.equal((await comprovarDestinoIsolado(falso(boa), { marcador: MARCADOR, declarado })).banco, "fv2_teste_x");
  for (const [descricao, linha] of [
    ["servidor fora do loopback", { ...boa, endereco: "10.0.0.5" }],
    ["conexão por socket, sem endereço", { ...boa, endereco: null }],
    ["outro banco", { ...boa, banco: "postgres" }],
    ["outra porta", { ...boa, porta: "5432" }],
    ["outro usuário", { ...boa, usuario: "postgres" }],
    ["sem marcador", { ...boa, marcador: null }],
    ["marcador de outro ambiente", { ...boa, marcador: `FV2_ISOLADO_TESTE:${"cd".repeat(32)}` }],
    ["esquemas de plataforma compartilhada", { ...boa, esquemas_alheios: 2 }],
    ["papéis de plataforma compartilhada", { ...boa, papeis_alheios: 1 }],
    ["servidor com bancos de outros sistemas", { ...boa, bancos_alheios: 1 }],
    ["sem resposta", null],
  ]) {
    await rejeita(comprovarDestinoIsolado(falso(linha), { marcador: MARCADOR, declarado }), CODIGO.DESTINO_NAO_AUTORIZADO).catch((e) => { throw new Error(`${descricao}: ${e.message}`); });
  }
  await rejeita(comprovarDestinoIsolado({ query: async () => { throw new Error("falha de rede"); } }, { marcador: MARCADOR, declarado }), CODIGO.DESTINO_NAO_AUTORIZADO);
  await rejeita(comprovarDestinoIsolado(falso(boa), { marcador: "curto", declarado }), CODIGO.DESTINO_NAO_AUTORIZADO);
  await rejeita(comprovarDestinoIsolado(falso(boa), { marcador: MARCADOR }), CODIGO.DESTINO_NAO_AUTORIZADO); // sem a barreira 1
});

test("o adaptador não abre transação sem escopo e não aceita pool inválido", async () => {
  assert.throws(() => criarRepositorioPostgres({ pool: null }), (e) => e.codigo === CODIGO.REPOSITORIO_INVALIDO);
  let conectou = false;
  // 07B: sem a autoridade de sessões de banco, o adaptador nem é montado (a aplicação não escolhe escopo sozinha).
  assert.throws(() => criarRepositorioPostgres({ pool: { connect: async () => 1 } }), (e) => e.codigo === CODIGO.REPOSITORIO_INVALIDO);
  const sessoes = { emitir: async () => { conectou = true; throw new Error("não deveria emitir"); } };
  const repo = criarRepositorioPostgres({ sessoes, pool: { connect: async () => { conectou = true; throw new Error("não deveria conectar"); } } });
  await rejeita(async () => repo.transacao(async () => 1), CODIGO.REPOSITORIO_INVALIDO);
  await rejeita(async () => repo.leitura(async () => 1, { escopo: { organizacaoId: ORG_A } }), CODIGO.REPOSITORIO_INVALIDO);
  await rejeita(async () => repo.leitura(async () => 1, { escopo: { organizacaoId: ORG_A, unidadeId: UNI_A } }), CODIGO.REPOSITORIO_INVALIDO); // sem usuário
  assert.equal(conectou, false);
  assert.equal(UNI_A.length, 36);
});

test("migrações só rodam por conexão conferida pela guarda", async () => {
  await assert.rejects(aplicarMigracoes({ connect: async () => { throw new Error("não deveria conectar"); } }), /conexão conferida pela guarda/);
  await assert.rejects(abrirPoolSeguro("postgres://fv2_teste_app:s@db.exemplo-remoto.com:5432/fv2_teste", MARCADOR), (e) => e.codigo === CODIGO.DESTINO_NAO_AUTORIZADO);
});

test("no ambiente real: banco local SEM o marcador do ambiente é recusado na primeira consulta", { skip: motivoParaPular() }, async () => {
  const a = ambiente();
  const adm = await abrirPool(a.urlAdmin, { max: 1 });
  // Um banco criado "por fora" no mesmo servidor local, com nome válido, mas sem o marcador: não é ambiente conferido.
  const semMarcador = `fv2_teste_${randomBytes(6).toString("hex")}`;
  await adm.query(`create database ${semMarcador} template template0`);
  const pool = await abrirPool(urlDoBanco(a.urlApp, semMarcador), { max: 1 });
  await rejeita(pool.connect(), CODIGO.DESTINO_NAO_AUTORIZADO);
  await rejeita(pool.query("select 1"), CODIGO.DESTINO_NAO_AUTORIZADO);
  // Marcador errado no cliente também é recusado, mesmo contra um banco legítimo.
  const comOutroMarcador = await abrirPoolSeguro(a.urlApp, "ef".repeat(32), { max: 1 });
  await rejeita(comOutroMarcador.query("select 1"), CODIGO.DESTINO_NAO_AUTORIZADO);
  await comOutroMarcador.end();
  // E o caminho legítimo funciona.
  assert.equal((await adm.query("select 1 as ok")).rows[0].ok, 1);
});
