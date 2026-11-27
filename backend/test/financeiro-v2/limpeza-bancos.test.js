// 27/11 (PR #236) — bancos descartáveis dos testes: apagados no fim do arquivo (também quando falha) e `limpar` que
// NUNCA apaga banco de execução ativa (mesmo sem conexão no momento), banco com conexão ou banco sem dono anotado.
// Só no PostgreSQL local isolado; nada fora dele.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { abrirPool, ambiente, criarBancoDeTeste, motivoParaPular } from "./helpers/postgres.js";
import { lerExecucoes, pastaDasExecucoes, urlDoBanco } from "../../scripts/fv2/ambiente.mjs";

const AQUI = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(AQUI, "..", "..");
const pular = { skip: motivoParaPular() };

const limpar = () => {
  const r = spawnSync(process.execPath, ["scripts/fv2-banco-teste.mjs", "limpar"], { cwd: BACKEND, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const existe = async (adm, nome) => (await adm.query("select 1 from pg_database where datname = $1", [nome])).rows.length === 1;
async function semConexao(adm, nome) {
  for (let i = 0; i < 50; i++) {
    const { rows } = await adm.query("select count(*)::int as n from pg_stat_activity a join pg_database d on d.oid = a.datid where d.datname = $1", [nome]);
    if (rows[0].n === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`banco ${nome} continua com conexão`);
}

test("LB1 o banco é anotado na lista DESTE processo antes de existir; `limpar` mantém banco de execução ATIVA mesmo sem conexão", pular, async () => {
  const adm = await abrirPool(ambiente().urlAdmin, { max: 1 });
  const { banco } = await criarBancoDeTeste([]);
  const minha = lerExecucoes().find((e) => e.pid === process.pid);
  assert.ok(minha?.vivo && minha.bancos.includes(banco), "anotado na lista do processo vivo");
  await semConexao(adm, banco);
  const saida = limpar();
  assert.ok(await existe(adm, banco), "banco de execução ativa nunca é apagado pelo limpar");
  assert.match(saida, /[1-9]\d* de execução ativa/);
});

test("LB2 processo que MORREU sem limpar: `limpar` apaga o banco dele (sem conexão) e a lista some; com conexão aberta, mantém", pular, async () => {
  const adm = await abrirPool(ambiente().urlAdmin, { max: 1 });
  const rodarOrfao = () => {
    const r = spawnSync(process.execPath, [join(AQUI, "limpeza", "filho-orfao.mjs")], { cwd: BACKEND, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return { banco: r.stdout.trim().split("\n").pop(), pid: r.pid };
  };
  // com conexão aberta (de outro processo, aqui o do teste): fica
  const comConexao = rodarOrfao();
  assert.ok(await existe(adm, comConexao.banco), "o processo morreu e o banco ficou (como antes da correção)");
  const segura = await abrirPool(urlDoBanco(ambiente().urlAdmin, comConexao.banco), { max: 1 });
  const cliente = await segura.connect();
  assert.match(limpar(), /[1-9]\d* com conexão/);
  assert.ok(await existe(adm, comConexao.banco), "banco com conexão nunca é apagado");
  cliente.release(); await segura.end();
  await semConexao(adm, comConexao.banco);
  // sem conexão: apagado, e a lista do processo morto some
  const semCon = rodarOrfao();
  await semConexao(adm, semCon.banco); // o servidor solta as conexões do processo morto
  limpar();
  assert.equal(await existe(adm, comConexao.banco), false);
  assert.equal(await existe(adm, semCon.banco), false);
  assert.equal(existsSync(join(pastaDasExecucoes(), `${comConexao.pid}.lista`)), false);
  assert.equal(existsSync(join(pastaDasExecucoes(), `${semCon.pid}.lista`)), false);
});

test("LB3 banco que NINGUÉM anotou (criado por fora, com o marcador) é mantido pelo `limpar`", pular, async () => {
  const a = ambiente();
  const adm = await abrirPool(a.urlAdmin, { max: 1 });
  const nome = `fv2_teste_sem_dono_${randomBytes(4).toString("hex")}`;
  await adm.query(`create database ${nome} template template0`);
  await adm.query(`comment on database ${nome} is 'FV2_ISOLADO_TESTE:${a.marcador}'`);
  try {
    assert.match(limpar(), /[1-9]\d* sem dono anotado/);
    assert.ok(await existe(adm, nome));
  } finally {
    await adm.query(`drop database if exists ${nome}`);
  }
});

test("LB4 arquivo de teste que FALHA: os bancos que ele criou (FV2 e MOVA) são apagados no fim mesmo assim", pular, async () => {
  const adm = await abrirPool(ambiente().urlAdmin, { max: 1 });
  // sem NODE_TEST_CONTEXT: senão o filho roda como sub-processo deste executor e sai sempre com 0
  const { NODE_TEST_CONTEXT: _ignorado, ...env } = process.env;
  const r = spawnSync(process.execPath, ["--test", join(AQUI, "limpeza", "filho-falha.mjs")], { cwd: BACKEND, encoding: "utf8", env });
  assert.notEqual(r.status, 0, "o filho falhou de propósito");
  const bancos = [...r.stdout.matchAll(/BANCO=(fv2_teste_\w+)/g)].map((m) => m[1]);
  assert.equal(bancos.length, 2, r.stdout + r.stderr);
  for (const b of bancos) assert.equal(await existe(adm, b), false, `${b} apagado no after`);
  const vivos = lerExecucoes().flatMap((e) => e.bancos);
  for (const b of bancos) assert.ok(!vivos.includes(b), `${b} fora das listas`);
});
