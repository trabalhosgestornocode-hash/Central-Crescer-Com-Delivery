// Execução 16C — SQL de IMPLANTAÇÃO do leitor do MOVA (concessão só-ver, login SCRAM, conferência e desligamento de
// emergência), exercitado num PostgreSQL REAL isolado exatamente como seria executado em produção (como dono do banco).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ACAO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { IDENTIDADE_DO_MOVA, sqlConcessaoDoMova, sqlDesativarLeitorDoMova, sqlLoginDoLeitorDoMova, sqlVerificacaoDoLeitorDoMova, verificadorScram } from "../../scripts/fv2/pacoteProducao.mjs";
import { IDENTIDADE_MOVA, criarLeitorFinanceiroMova } from "../../src/modules/fv2-integracao/leitorMova.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, ORG_B, TODAS, UNI_A, UNI_B, ctx, montar, obrigacao, provisionarAdministrador } from "./helpers/cenario.js";
import { abrirPool, motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const pular = { skip: motivoParaPular(), timeout: 300000 };

async function cenario() {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG_A, unidadeId: UNI_A });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG_B, unidadeId: UNI_B });
  const m = montar({ repositorio, concessoesDeTeste: false });
  const admA = ctx(ORG_A, UNI_A, TODAS);
  const f = await m.nucleo.registrarContraparte(admA, { tipo: "FORNECEDOR", nome: "Fornecedor Sintético" });
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, exigirConcessaoPersistida: true, cofre: m.cofre });
  await n.registrarObrigacao(admA, obrigacao(f.id, { valorOriginalCentavos: 35000 }));
  const interno = await repositorio.interno();
  const dono = await interno.dono();
  return { interno, dono, n, admA };
}
const executar = async (dono, sql) => { const cl = await dono.connect(); try { await cl.query("begin"); const r = await cl.query(sql); await cl.query("commit"); return r; } catch (e) { await cl.query("rollback").catch(() => {}); throw e; } finally { cl.release(); } };
const ultimo = (r) => (Array.isArray(r) ? r.at(-1) : r);

test("16C implantação: concessão só-ver, login SCRAM que conecta de verdade, conferência e leitura real pelo núcleo", pular, async () => {
  const { interno, dono } = await cenario();
  const papel = `fv2_teste_mova_leitor_${randomBytes(3).toString("hex")}`;
  const senha = randomBytes(24).toString("hex");

  // 1) concessão (idempotente) — formato do núcleo: concessão + histórico, só 'ver'
  await executar(dono, sqlConcessaoDoMova(ORG_A, UNI_A));
  await executar(dono, sqlConcessaoDoMova(ORG_A, UNI_A));
  const { rows: cs } = await dono.query("select acoes, situacao, versao from fv2_concessao where usuario_id = $1", [IDENTIDADE_DO_MOVA]);
  assert.deepEqual(cs.map((c) => [c.acoes, c.situacao, c.versao]), [[[ACAO.VER], "ATIVA", 1]], "uma concessão, só 'ver', mesmo repetindo o SQL");
  const { rows: [h] } = await dono.query("select count(*)::int n from fv2_historico where registro_tipo = 'CONCESSAO' and usuario_id = $1", ["00000000-0000-4000-8000-0000000b0075"]);
  assert.ok(h.n >= 1, "histórico da concessão gravado");
  assert.equal(IDENTIDADE_DO_MOVA, IDENTIDADE_MOVA, "a identidade do gerador é a do leitor");

  // 2) login com verificador SCRAM: a senha em claro não aparece no SQL, e a conexão funciona com ela
  const sqlLogin = sqlLoginDoLeitorDoMova(papel, senha);
  assert.ok(!sqlLogin.includes(senha), "senha em claro nunca vai ao SQL");
  assert.match(sqlLogin, /password 'SCRAM-SHA-256\$4096:/);
  await executar(dono, sqlLogin);
  await assert.rejects(executar(dono, sqlLogin), /já existe/);
  const u = new URL(interno.urlApp); u.username = papel; u.password = senha;
  const pool = await abrirPool(u.toString(), { max: 2 });
  const leitor = criarLeitorFinanceiroMova({ pool });
  assert.deepEqual(await leitor.verificar(), { ok: true }, "o login criado pelo SQL passa na conferência do próprio MOVA");

  // 3) conferência do SQL de verificação: todos os valores esperados
  const { rows: [v] } = await dono.query(sqlVerificacaoDoLeitorDoMova(papel));
  assert.deepEqual({ ...v }, {
    login_restrito_esperado_1: 1, papeis_membro_esperado_1: 1, membro_de_esperado_fv2_leitor_mova: "fv2_leitor_mova", tabelas_com_escrita_esperado_0: 0,
    emite_sessao_alheia_esperado_false: false, grava_concessao_esperado_false: false, abre_sessao_mova_esperado_true: true, fora_do_modulo_esperado_so_pg_stat_statements: v.fora_do_modulo_esperado_so_pg_stat_statements,
  });
  assert.ok(!v.fora_do_modulo_esperado_so_pg_stat_statements || /^extensions\.pg_stat_statements/.test(v.fora_do_modulo_esperado_so_pg_stat_statements.split(",")[0]), `fora do módulo: ${v.fora_do_modulo_esperado_so_pg_stat_statements}`);

  // 4) leitura real com a credencial criada: a unidade do piloto, e só ela
  const nucleo = criarNucleoFinanceiro({ repositorio: leitor.repositorio, escoposAutorizados: [{ organizacaoId: ORG_A, unidadeId: UNI_A }], relogio: () => AGORA, exigirConcessaoPersistida: true });
  const r = await nucleo.consultarContasAPagar({ organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: IDENTIDADE_MOVA, permissoes: [ACAO.VER] }, { pagina: 1, tamanho: 100 });
  assert.deepEqual(r.itens.map((i) => i.valorOriginalCentavos), [35000]);
  await assert.rejects(pool.query("select financeiro_v2.fv2_abrir_sessao_mova($1, $2)", [ORG_B, UNI_B]), (e) => e.code === "FV020", "outra empresa: sem concessão, sem sessão");

  // 5) desligamento de emergência: nenhuma conexão nova; a aberta é derrubada
  const aberta = await pool.connect();
  aberta.on("error", () => {}); // a derrubada proposital emite erro na conexão em uso
  await aberta.query("select 1");
  const resultados = await dono.query(sqlDesativarLeitorDoMova(papel));
  assert.ok(resultados.at(-1).rows[0].conexoes_encerradas >= 1, "a conexão aberta foi encerrada");
  aberta.release(true);
  await pool.end().catch(() => {});
  const fresco = await abrirPool(u.toString(), { max: 1 }).catch((e) => e);
  await assert.rejects(Promise.resolve(fresco).then((p) => p.query("select 1")), (e) => /password authentication failed|not permitted to log in|nologin|rejected/i.test(String(e.message)) || e.code === "28000" || e.code === "28P01");
});

test("16C implantação: recusas — outra unidade, papel reservado/inválido, senha curta, 0028 ausente", pular, async () => {
  const { dono } = await cenario();
  await executar(dono, sqlConcessaoDoMova(ORG_A, UNI_A));
  // identidade já ativa em UMA unidade: não vira concessão em outra (o piloto é de uma unidade só)
  await assert.rejects(executar(dono, sqlConcessaoDoMova(ORG_B, UNI_B)), /outra unidade/);
  // unidade fora do Financeiro v2
  await assert.rejects(executar(dono, sqlConcessaoDoMova(ORG_A, "aaaaaaaa-0000-4000-8000-0000000000ff")), /não está no Financeiro v2/);
  assert.throws(() => sqlConcessaoDoMova("x", UNI_A), /inválidos/);
  for (const ruim of ["postgres", "fv2_app", "fv2_leitor_mova", "fv2_app_login_b", "fv2_autoridade_login", "FV2_MAIUSCULO", "fv2_a b", "fv2_x'; drop table x;--"]) {
    assert.throws(() => sqlLoginDoLeitorDoMova(ruim, "x".repeat(40)), /inválido/, ruim);
    assert.throws(() => sqlVerificacaoDoLeitorDoMova(ruim), /inválido/, ruim);
    assert.throws(() => sqlDesativarLeitorDoMova(ruim), /inválido/, ruim);
  }
  assert.throws(() => sqlLoginDoLeitorDoMova("fv2_mova_leitor_piloto", "curta"), /32 caracteres/);
  // verificador SCRAM com sal fixo é determinístico (formato aceito pelo PostgreSQL)
  const sal = Buffer.from("0123456789abcdef");
  assert.equal(verificadorScram("senha-de-teste", 4096, sal), verificadorScram("senha-de-teste", 4096, sal));
  assert.match(verificadorScram("senha-de-teste"), /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
});
