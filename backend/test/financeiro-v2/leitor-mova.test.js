// Execução 16A — LEITOR DO MOVA (migração 0028) num PostgreSQL REAL isolado: a credencial do MOVA lê só a sua unidade,
// não escreve nada, não emite sessão de outra pessoa e a identidade do MOVA nunca recebe ação além de "ver".
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ACAO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { IDENTIDADE_MOVA, criarLeitorFinanceiroMova, verificarLeitorSomenteLeitura } from "../../src/modules/fv2-integracao/leitorMova.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, ORG_B, TODAS, UNI_A, UNI_B, ctx, montar, obrigacao, provisionarAdministrador } from "./helpers/cenario.js";
import { abrirPool, motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const pular = { skip: motivoParaPular(), timeout: 300000 };
const A = { organizacaoId: ORG_A, unidadeId: UNI_A };
const B = { organizacaoId: ORG_B, unidadeId: UNI_B };
const mova = (escopo = A) => ({ ...escopo, usuarioId: IDENTIDADE_MOVA, permissoes: [ACAO.VER] });

async function cenario() {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { ...A });
  await provisionarAdministrador(repositorio, { ...B });
  const m = montar({ repositorio, concessoesDeTeste: false });
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, exigirConcessaoPersistida: true, cofre: m.cofre });
  const admA = ctx(ORG_A, UNI_A, TODAS); const admB = ctx(ORG_B, UNI_B, TODAS);
  for (const [c, valor] of [[admA, 35000], [admB, 99000]]) {
    const f = await m.nucleo.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Fornecedor Sintético" });
    await n.registrarObrigacao(c, obrigacao(f.id, { valorOriginalCentavos: valor }));
  }
  await n.concederAcesso(admA, { usuarioId: IDENTIDADE_MOVA, acoes: [ACAO.VER], justificativa: "Piloto MOVA (sintético)." });
  const interno = await repositorio.interno();
  const dono = await interno.dono();
  // Credencial de LOGIN do piloto (criada na implantação): membro só de fv2_leitor_mova.
  const papel = `fv2_teste_leitor_mova_${randomBytes(4).toString("hex")}`; const senha = randomBytes(18).toString("hex");
  await dono.query(`create role ${papel} login password '${senha}' in role fv2_leitor_mova`);
  const u = new URL(interno.urlApp); u.username = papel; u.password = senha;
  const poolLeitor = await abrirPool(u.toString(), { max: 2 });
  const leitor = criarLeitorFinanceiroMova({ pool: poolLeitor });
  const nucleoMova = criarNucleoFinanceiro({ repositorio: leitor.repositorio, escoposAutorizados: [A], relogio: () => AGORA, exigirConcessaoPersistida: true });
  return { n, admA, interno, dono, poolLeitor, leitor, nucleoMova };
}

test("16A leitor do MOVA: verificação aprova o leitor e recusa a credencial da aplicação", pular, async () => {
  const { leitor, interno } = await cenario();
  assert.deepEqual(await leitor.verificar(), { ok: true });
  await assert.rejects(verificarLeitorSomenteLeitura(interno.pool), (e) => e.codigo === "LEITOR_NAO_E_SOMENTE_LEITURA" && e.detalhes.motivos.includes("PAPEL_DA_APLICACAO_OU_AUTORIDADE") && e.detalhes.motivos.includes("TABELAS_COM_ESCRITA"));
});

test("16A leitor do MOVA: lê as contas da SUA unidade; outra unidade e outra empresa ficam fora", pular, async () => {
  const { nucleoMova, leitor } = await cenario();
  const r = await nucleoMova.consultarContasAPagar(mova(A), { pagina: 1, tamanho: 100 });
  assert.equal(r.itens.length, 1);
  assert.equal(r.itens[0].valorOriginalCentavos, 35000, "o valor da unidade B (99000) nunca aparece");
  await assert.rejects(nucleoMova.consultarContasAPagar(mova(B), { pagina: 1, tamanho: 100 }), "escopo fora da lista do núcleo");
  // Mesmo com B autorizada no núcleo, o BANCO recusa: o MOVA não tem concessão em B.
  const nucleoComB = criarNucleoFinanceiro({ repositorio: leitor.repositorio, escoposAutorizados: [A, B], relogio: () => AGORA, exigirConcessaoPersistida: true });
  await assert.rejects(nucleoComB.consultarContasAPagar(mova(B), { pagina: 1, tamanho: 100 }));
});

test("16A leitor do MOVA: banco recusa sessão sem concessão e sessão de outra identidade", pular, async () => {
  const { poolLeitor } = await cenario();
  await assert.rejects(poolLeitor.query("select financeiro_v2.fv2_abrir_sessao_mova($1, $2)", [ORG_B, UNI_B]), (e) => e.code === "FV020");
  await assert.rejects(poolLeitor.query("select financeiro_v2.fv2_abrir_sessao($1, $2, $3, 300, 'x')", ["cccccccc-0000-4000-8000-000000000001", ORG_A, UNI_A]), (e) => e.code === "42501");
  // Pelo código: o emissor do leitor recusa qualquer identidade que não seja a do MOVA, antes de ir ao banco.
  const nucleo = criarNucleoFinanceiro({ repositorio: criarLeitorFinanceiroMova({ pool: poolLeitor }).repositorio, escoposAutorizados: [A], relogio: () => AGORA });
  await assert.rejects(nucleo.consultarContasAPagar({ ...A, usuarioId: "cccccccc-0000-4000-8000-000000000001", permissoes: [ACAO.VER] }, { pagina: 1, tamanho: 100 }));
});

test("16A leitor do MOVA: nenhuma escrita passa, nem com sessão válida (INSERT/UPDATE/DELETE negados pelo banco)", pular, async () => {
  const { poolLeitor } = await cenario();
  const cl = await poolLeitor.connect();
  try {
    const { rows: [{ t }] } = await cl.query("select financeiro_v2.fv2_abrir_sessao_mova($1, $2) as t", [ORG_A, UNI_A]);
    const { rows: [s] } = await cl.query("select usuario_id::text u, pode_escrever from financeiro_v2.fv2_assumir_sessao($1)", [t]);
    assert.equal(s.u, IDENTIDADE_MOVA); assert.equal(s.pode_escrever, false);
    for (const sql of [
      "update financeiro_v2.fv2_obrigacao set descricao = 'x'",
      "delete from financeiro_v2.fv2_obrigacao",
      "insert into financeiro_v2.fv2_escopo (organizacao_id, unidade_id, rotulo) values (gen_random_uuid(), gen_random_uuid(), 'x')",
      "update financeiro_v2.fv2_concessao set acoes = '[\"financeiro_v2.ver\",\"financeiro_v2.registrar\"]'",
      "truncate financeiro_v2.fv2_lancamento",
    ]) {
      await cl.query("begin"); await cl.query("select financeiro_v2.fv2_assumir_sessao($1)", [t]);
      await assert.rejects(cl.query(sql), (e) => e.code === "42501", sql);
      await cl.query("rollback");
    }
    await assert.rejects(cl.query("select financeiro_v2.fv2_gravar_concessao('{}'::jsonb, 1)"), (e) => e.code === "42501");
  } finally { cl.release(); }
});

test("16A identidade do MOVA: concessão com qualquer ação além de 'ver' é recusada pelo banco (inclusive por administrador)", pular, async () => {
  const { n, admA, dono } = await cenario();
  await assert.rejects(n.concederAcesso(admA, { usuarioId: IDENTIDADE_MOVA, acoes: [ACAO.VER, ACAO.REGISTRAR], justificativa: "Tentativa indevida." }));
  await assert.rejects(dono.query("update fv2_concessao set acoes = '[\"financeiro_v2.ver\",\"financeiro_v2.aplicar\"]'::jsonb where usuario_id = $1", [IDENTIDADE_MOVA]), (e) => e.code === "42501");
  const { rows: [c] } = await dono.query("select acoes from fv2_concessao where usuario_id = $1", [IDENTIDADE_MOVA]);
  assert.deepEqual(c.acoes, [ACAO.VER]);
});

test("16A leitor do MOVA: concessão revogada ⇒ a próxima sessão é recusada (desligamento pelo próprio Financeiro)", pular, async () => {
  const { n, admA, poolLeitor } = await cenario();
  await n.revogarAcesso(admA, { usuarioId: IDENTIDADE_MOVA, justificativa: "Fim do piloto (sintético)." });
  await assert.rejects(poolLeitor.query("select financeiro_v2.fv2_abrir_sessao_mova($1, $2)", [ORG_A, UNI_A]), (e) => e.code === "FV020");
});

test("16A leitor do MOVA: TODAS as leituras das ferramentas do MOVA funcionam só com SELECT (nenhuma exige escrita ou trava)", pular, async () => {
  const { nucleoMova } = await cenario();
  const c = mova(A);
  const chamadas = {
    consultarContasAPagar: { pagina: 1, tamanho: 100 }, consultarCompetencia: { competencia: "2026-09" }, consultarResumoFinanceiro: { competencia: "2026-09" },
    consultarVendas: { inicio: "2026-09-01", fim: "2026-09-30" }, apurarCompetencia: { competencia: "2026-09" },
    consultarFluxoDeCaixa: { inicio: "2026-09-01", fim: "2026-09-30", granularidade: "MES" }, consultarPendencias: { competencia: "2026-09" },
    consultarPlanoDeContas: undefined, consultarDocumentos: { competencia: "2026-09", tamanho: 1 },
    consultarCalendarioDeFaturamento: { canal: "BALCAO", mes: "2026-09" }, consultarContasAReceber: { pagina: 1, tamanho: 100 },
    // Agente 2: fechamento semanal dos entregadores (ferramenta FECHAMENTO_ENTREGADORES).
    consultarEntregadoresProprios: { semana: "2026-09-07" },
  };
  const falhas = [];
  for (const [op, entrada] of Object.entries(chamadas)) {
    try { await nucleoMova[op](c, entrada); } catch (e) { falhas.push(`${op}: ${e.codigo ?? e.code ?? ""} ${e.message}`); }
  }
  assert.deepEqual(falhas, []);
});

test("Agente 2 leitor do MOVA: prévia da baixa pelo extrato e fechamento do entregador são só leitura (inexistente = não encontrado, nunca permissão/escrita)", pular, async () => {
  const { nucleoMova } = await cenario();
  const c = mova(A);
  const chamadas = {
    previaDoVinculoDoExtrato: { obrigacaoId: "99999999-0000-4000-8000-000000000001" },
    consultarEntregador: { entregador: "entregador-sintetico-inexistente" },
    detalharFechamentoDoEntregador: { inicio: "2026-09-07", entregador: "entregador-sintetico-inexistente" },
  };
  const falhas = [];
  for (const [op, entrada] of Object.entries(chamadas)) {
    try { await nucleoMova[op](c, entrada); } catch (e) { if (e.codigo !== "FV2_NAO_ENCONTRADO") falhas.push(`${op}: ${e.codigo ?? e.code ?? ""} ${e.message}`); }
  }
  assert.deepEqual(falhas, []);
});

test("16B leitor do MOVA: sem sessão não vê nada; com sessão de A vê só A (SQL direto, sem o núcleo)", pular, async () => {
  const { poolLeitor } = await cenario();
  const cl = await poolLeitor.connect();
  try {
    const { rows: [{ n: semSessao }] } = await cl.query("select count(*)::int n from financeiro_v2.fv2_obrigacao");
    assert.equal(semSessao, 0, "sem sessão a RLS não mostra nenhuma linha");
    const { rows: [{ t }] } = await cl.query("select financeiro_v2.fv2_abrir_sessao_mova($1, $2) as t", [ORG_A, UNI_A]);
    await cl.query("begin"); await cl.query("select financeiro_v2.fv2_assumir_sessao($1)", [t]);
    const { rows } = await cl.query("select organizacao_id::text o, unidade_id::text u, valor_base_centavos::int v from financeiro_v2.fv2_obrigacao");
    await cl.query("commit");
    assert.deepEqual(rows.map((r) => [r.o, r.u, r.v]), [[ORG_A, UNI_A, 35000]], "nenhuma linha de B (outra empresa)");
  } finally { cl.release(); }
});

test("16B leitor do MOVA: sem elevação de privilégio (SET ROLE para papéis do módulo é negado)", pular, async () => {
  const { poolLeitor } = await cenario();
  for (const papel of ["fv2_app", "fv2_autoridade", "fv2_guardiao", "postgres"]) {
    await assert.rejects(poolLeitor.query(`set role ${papel}`), (e) => ["42501", "22023"].includes(e.code), papel);
  }
});

test("16B leitor do MOVA: sessão expirada deixa de valer (validade fixa de 5 min, conferida no banco)", pular, async () => {
  const { poolLeitor, dono } = await cenario();
  const { rows: [{ t }] } = await poolLeitor.query("select financeiro_v2.fv2_abrir_sessao_mova($1, $2) as t", [ORG_A, UNI_A]);
  const { rows: [s] } = await dono.query("select extract(epoch from (expira_em - emitida_em))::int seg, pode_escrever, referencia from fv2_sessao_banco where usuario_id = $1 order by emitida_em desc limit 1", [IDENTIDADE_MOVA]);
  assert.ok(s.seg <= 300 && s.seg >= 299, `validade ${s.seg}s`); assert.equal(s.pode_escrever, false); assert.equal(s.referencia, "automacao:mova");
  await dono.query("update fv2_sessao_banco set emitida_em = now() - interval '6 minutes', expira_em = now() - interval '1 minute' where usuario_id = $1", [IDENTIDADE_MOVA]);
  const cl = await poolLeitor.connect();
  try {
    await cl.query("begin");
    const { rows: [v] } = await cl.query("select usuario_id from financeiro_v2.fv2_assumir_sessao($1)", [t]);
    assert.equal(v.usuario_id, null, "token expirado não é sessão");
    const { rows: [{ n }] } = await cl.query("select count(*)::int n from financeiro_v2.fv2_obrigacao");
    assert.equal(n, 0);
    await cl.query("rollback");
  } finally { cl.release(); }
});

test("16B leitor do MOVA: revogar encerra NA HORA a sessão já emitida e nenhuma nova é emitida", pular, async () => {
  const { n, admA, poolLeitor, dono } = await cenario();
  const { rows: [{ t }] } = await poolLeitor.query("select financeiro_v2.fv2_abrir_sessao_mova($1, $2) as t", [ORG_A, UNI_A]);
  await n.revogarAcesso(admA, { usuarioId: IDENTIDADE_MOVA, justificativa: "Fim do piloto (sintético)." });
  await assert.rejects(poolLeitor.query("select financeiro_v2.fv2_abrir_sessao_mova($1, $2)", [ORG_A, UNI_A]), (e) => e.code === "FV020");
  const { rows: [s] } = await dono.query("select (revogada_em is not null) revogada, expira_em <= now() + interval '300 seconds' curta from fv2_sessao_banco where token_hash = sha256(convert_to($1, 'UTF8'))", [t]);
  assert.equal(s.revogada, true, "a revogação encerra a sessão já emitida");
  assert.equal(s.curta, true);
  const cl = await poolLeitor.connect();
  try {
    await cl.query("begin"); await cl.query("select financeiro_v2.fv2_assumir_sessao($1)", [t]);
    const { rows: [{ n: linhas }] } = await cl.query("select count(*)::int n from financeiro_v2.fv2_obrigacao");
    await cl.query("rollback");
    assert.equal(linhas, 0, "token de antes da revogação não lê mais nada");
  } finally { cl.release(); }
});
