// Bootstrap administrativo único (decisão do proprietário, 15/11): primeira administração financeira de UMA unidade sem
// segundo atestador, executada pela autoridade de infraestrutura. Banco isolado com tabelas-espelho mínimas da plataforma
// (auth.users, auth.mfa_factors, public.*) e dados 100% sintéticos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { abrirPool, criarBancoDeTeste, motivoParaPular } from "./helpers/postgres.js";
import { sqlBootstrapAdministrador, EXECUTOR_BOOTSTRAP } from "../../scripts/fv2/pacoteProducao.mjs";
import { ACAO } from "../../src/modules/financeiro-v2/dominio/contexto.js";

const pular = motivoParaPular();
const ORG = "b0000000-0000-4000-8000-000000000001";
const UNI = "b0000000-0000-4000-8000-0000000000a1";
const UNI2 = "b0000000-0000-4000-8000-0000000000a2";
const PESSOA = "b0000000-0000-4000-8000-0000000000c1"; // conta pessoal, TOTP verificado, vinculada
const SEM_TOTP = "b0000000-0000-4000-8000-0000000000c2";
const COMPARTILHADA = "b0000000-0000-4000-8000-0000000000c3";
const SEM_VINCULO = "b0000000-0000-4000-8000-0000000000c4";
const OUTRA = "b0000000-0000-4000-8000-0000000000c5";
const ACOES = Object.values(ACAO);

const ESPELHO = `
create schema if not exists auth;
create table auth.users (id uuid primary key, deleted_at timestamptz, banned_until timestamptz);
create table auth.mfa_factors (user_id uuid, factor_type text, status text);
create table public.unidades (id uuid primary key, organizacao_id uuid);
create table public.perfis_operacionais (id uuid primary key, conta_id uuid, ativo boolean);
create table public.usuarios_unidades (perfil_id uuid, unidade_id uuid, ativo boolean);
create table public.usuarios_organizacoes (usuario_id uuid, organizacao_id uuid, ativo boolean);
insert into public.unidades values ('${UNI}', '${ORG}'), ('${UNI2}', '${ORG}');
insert into auth.users (id) values ('${PESSOA}'), ('${SEM_TOTP}'), ('${COMPARTILHADA}'), ('${SEM_VINCULO}'), ('${OUTRA}');
insert into auth.mfa_factors values ('${PESSOA}', 'totp', 'verified'), ('${SEM_TOTP}', 'totp', 'unverified'), ('${COMPARTILHADA}', 'totp', 'verified'), ('${SEM_VINCULO}', 'totp', 'verified'), ('${OUTRA}', 'totp', 'verified');
insert into public.perfis_operacionais values ('${PESSOA}', '${PESSOA}', true), ('${SEM_TOTP}', '${SEM_TOTP}', true), ('${COMPARTILHADA}', '${COMPARTILHADA}', true),
  ('b0000000-0000-4000-8000-0000000000d3', '${COMPARTILHADA}', true), ('${SEM_VINCULO}', '${SEM_VINCULO}', true), ('${OUTRA}', '${OUTRA}', true);
insert into public.usuarios_unidades values ('${PESSOA}', '${UNI}', true), ('${SEM_TOTP}', '${UNI}', true), ('${COMPARTILHADA}', '${UNI}', true), ('${OUTRA}', '${UNI2}', true), ('${OUTRA}', '${UNI}', true);
insert into public.usuarios_organizacoes values ('${PESSOA}', '${ORG}', true), ('${SEM_TOTP}', '${ORG}', true), ('${COMPARTILHADA}', '${ORG}', true), ('${SEM_VINCULO}', '${ORG}', true), ('${OUTRA}', '${ORG}', true);
`;

const SEM_ESPELHO = "drop schema auth cascade; drop table public.unidades, public.perfis_operacionais, public.usuarios_unidades, public.usuarios_organizacoes;";

let ctx;
async function montar() {
  if (ctx) return ctx;
  const b = await criarBancoDeTeste([]);
  const dono = await abrirPool(b.urlAdmin, { max: 1 });
  // A trava do ambiente de teste recusa conexões novas a um banco com cara de plataforma (schema auth): o espelho só
  // existe DURANTE o bootstrap e some antes de a autoridade conectar.
  let autoridadePool;
  const autoridade = { query: async (...a) => (autoridadePool ??= await abrirPool(b.urlAutoridade, { max: 1 })).query(...a) };
  const executor = (await dono.query("select session_user as u")).rows[0].u;
  const sql = (usuarioId, unidadeId = UNI, extra = {}) => sqlBootstrapAdministrador({ organizacaoId: ORG, unidadeId, usuarioId, autorizacao: "FV2-BOOT-TESTE-01", acoes: ACOES, executor, ...extra });
  const rodar = async (texto) => {
    const c = await dono.connect();
    try {
      await c.query(ESPELHO);
      await c.query("begin");
      try {
        const r = await c.query(texto);
        await c.query("commit");
        return r;
      } catch (e) {
        await c.query("rollback");
        throw e;
      }
    } finally {
      await c.query(SEM_ESPELHO);
      c.release();
    }
  };
  ctx = { dono, autoridade, sql, rodar, executor };
  return ctx;
}

const contar = async (dono, q) => Number((await dono.query(q)).rows[0].n);

test("bootstrap — recusa sem TOTP verificado, conta compartilhada, sem vínculo e papel executor diferente (nada é gravado)", { skip: pular }, async () => {
  const { dono, sql, rodar } = await montar();
  await assert.rejects(rodar(sql(SEM_TOTP)), /TOTP verificado/);
  await assert.rejects(rodar(sql(COMPARTILHADA)), /não é pessoal/);
  await assert.rejects(rodar(sql(SEM_VINCULO)), /não está vinculada à unidade/);
  await assert.rejects(rodar(sql(PESSOA, UNI, { executor: "outro_papel" })), /só o papel outro_papel/);
  assert.equal(await contar(dono, "select count(*) n from financeiro_v2.fv2_concessao"), 0);
  assert.equal(await contar(dono, "select count(*) n from financeiro_v2.fv2_escopo"), 0);
});

test("bootstrap — concede a primeira administração SÓ à pessoa e SÓ na unidade, com auditoria completa; não libera nada", { skip: pular }, async () => {
  const { dono, sql, rodar, executor } = await montar();
  const r = await rodar(sql(PESSOA));
  const linha = r.at(-1).rows[0];
  assert.equal(linha.executor, executor);
  assert.equal(linha.beneficiario, PESSOA);
  assert.equal(linha.unidade_id, UNI);
  assert.equal(linha.finalidade, "BOOTSTRAP_INFRAESTRUTURA");
  assert.match(linha.justificativa, /Autorização: FV2-BOOT-TESTE-01/);
  assert.equal(Number(linha.liberacoes_ativas), 0);
  const c = (await dono.query("select * from financeiro_v2.fv2_concessao")).rows;
  assert.equal(c.length, 1);
  assert.equal(c[0].usuario_id, PESSOA);
  assert.equal(c[0].unidade_id, UNI);
  assert.equal(c[0].concedido_por, EXECUTOR_BOOTSTRAP);
  assert.deepEqual([...c[0].acoes].sort(), [...ACOES].sort());
  assert.equal(await contar(dono, "select count(*) n from financeiro_v2.fv2_escopo"), 1);
  assert.equal(await contar(dono, "select count(*) n from financeiro_v2.fv2_liberacao"), 0);
  assert.equal(await contar(dono, "select count(*) n from financeiro_v2.fv2_provisionamento_inicial"), 0);
  // a sessão de trilha nunca é utilizável
  assert.equal(await contar(dono, "select count(*) n from financeiro_v2.fv2_sessao_banco where revogada_em is null"), 0);
});

test("bootstrap — a concessão funciona pelo fluxo NORMAL (sessão emitida pela autoridade) e só na unidade dela", { skip: pular }, async () => {
  const { autoridade } = await montar();
  const t = (await autoridade.query("select fv2_abrir_sessao($1::uuid, $2::uuid, $3::uuid, 60, 'teste') as t", [PESSOA, ORG, UNI])).rows[0].t;
  assert.ok(t);
  await assert.rejects(autoridade.query("select fv2_abrir_sessao($1::uuid, $2::uuid, $3::uuid, 60, 'teste')", [PESSOA, ORG, UNI2]), /escopo não configurado|sem concessão/);
});

test("bootstrap — uso ÚNICO: repetir é inócuo; outra pessoa/unidade é recusada; o provisionamento normal vê o administrador", { skip: pular }, async () => {
  const { dono, sql, rodar, autoridade } = await montar();
  await rodar(sql(PESSOA)); // idempotente
  assert.equal(await contar(dono, "select count(*) n from financeiro_v2.fv2_concessao"), 1);
  assert.equal(await contar(dono, "select count(*) n from financeiro_v2.fv2_auditoria_concessao"), 1);
  await assert.rejects(rodar(sql(OUTRA)), /já foi usado/);
  await assert.rejects(rodar(sql(OUTRA, UNI2)), /já foi usado/);
  await assert.rejects(
    autoridade.query("select fv2_abrir_sessao_de_provisionamento($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, 'aal2', 'x', 'y')", [OUTRA, SEM_TOTP, ORG, UNI, JSON.stringify([ACAO.VER])]),
    /já tem administrador/,
  );
  assert.equal(await contar(dono, "select count(*) n from financeiro_v2.fv2_concessao"), 1);
});

test("bootstrap — gerador só aceita UUIDs, autorização e ações bem formadas (sem injeção)", () => {
  const base = { organizacaoId: ORG, unidadeId: UNI, usuarioId: PESSOA, autorizacao: "FV2-BOOT-1", acoes: [ACAO.VER] };
  assert.throws(() => sqlBootstrapAdministrador({ ...base, usuarioId: "'; drop table x; --" }));
  assert.throws(() => sqlBootstrapAdministrador({ ...base, autorizacao: "x'; drop" }));
  assert.throws(() => sqlBootstrapAdministrador({ ...base, acoes: ["financeiro_v2.ver'"] }));
  assert.throws(() => sqlBootstrapAdministrador({ ...base, executor: "postgres; drop" }));
  const sql = sqlBootstrapAdministrador(base).replace(/--[^\n]*/g, "");
  assert.doesNotMatch(sql, /\b(delete|drop|truncate|alter|grant|revoke)\b/i);
  assert.doesNotMatch(sql, /fv2_liberacao_alterar|insert into financeiro_v2\.fv2_liberacao/);
});
