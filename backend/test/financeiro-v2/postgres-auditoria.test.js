// Execução 07 — proteções da auditoria NO BANCO (PostgreSQL local isolado). Dados sintéticos.
//   - ajuste "solto" em título de competência homologada (sem o registro de ajuste) é recusado; o legítimo passa;
//   - homologação × liquidação concorrentes, segurando a trava de verdade (determinístico).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ESCOPOS_PADRAO, ORG_A, UNI_A, montarComCadastros, obrigacao, saida } from "./helpers/cenario.js";
import { motivoParaPular, repositorioPostgresDeTeste, tokenDeTeste } from "./helpers/postgres.js";

const pular = { skip: motivoParaPular() };
const A = { organizacaoId: ORG_A, unidadeId: UNI_A };
async function comoAplicacao(pool, fn) {
  const cl = await pool.connect();
  try {
    await cl.query("begin");
    await cl.query("select fv2_assumir_sessao($1)", [await tokenDeTeste(pool, A)]);
    const r = await fn(cl);
    await cl.query("commit");
    return r;
  } catch (e) {
    await cl.query("rollback").catch(() => {});
    throw e;
  } finally {
    cl.release();
  }
}
const homologar = async (n, c) => {
  await n.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_PRELIMINAR" });
  return n.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Sintética.", confirmar: true });
};

test("banco: ajuste de título homologado só com o registro de ajuste correspondente", pular, async () => {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO);
  const { nucleo: n, c } = await montarComCadastros({ repositorio });
  const { pool } = await repositorio.interno();
  const r = (await n.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-09-10", brutoCentavos: 9000, fonte: { sistema: "MANUAL", idExterno: "V-1" }, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 9000 }] })).recebiveis[0];
  await homologar(n, c);
  // "À mão": muda o valor devido sem registro de ajuste → recusado.
  await assert.rejects(comoAplicacao(pool, (cl) => cl.query("update fv2_recebivel set ajustes_centavos = -500, saldo_centavos = saldo_centavos - 500, versao = versao + 1 where id = $1", [r.id])), (e) => e.code === "FV001");
  // Pelo núcleo (taxa reconhecida em outubro): registro de ajuste em outubro + título atualizado → aceito.
  const a = await n.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: r.id, valorCentavos: -500, motivo: "Taxa descoberta em outubro", categoria: "TAXAS_STONE", competencia: "2026-10" });
  assert.equal(a.alvo.ajustesCentavos, -500);
  // Mesmo com o registro existindo, valor diferente da soma é recusado.
  await assert.rejects(comoAplicacao(pool, (cl) => cl.query("update fv2_recebivel set ajustes_centavos = -900, saldo_centavos = saldo_centavos - 400, versao = versao + 1 where id = $1", [r.id])), (e) => e.code === "FV001");
});

test("banco (determinístico): liquidação iniciada durante a homologação espera e depois não grava em setembro", pular, async () => {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO);
  const { nucleo: n, c, banco, fornecedor } = await montarComCadastros({ repositorio });
  const { pool } = await repositorio.interno();
  const o = (await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 3000 }))).obrigacoes[0];
  const pg = (await n.registrarMovimentacao(c, saida(banco.id, 3000, { dataEfetiva: "2026-09-25" }))).movimentacao;
  await n.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_PRELIMINAR" });
  // Segura a trava exclusiva de setembro (homologação em andamento).
  const cl = await pool.connect();
  await cl.query("begin");
  await cl.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`fv2|${c.organizacaoId}|${c.unidadeId}|competencia:2026-09`]);
  const liq = n.registrarLiquidacao(c, { movimentacaoId: pg.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: o.id, valorCentavos: 3000 }] });
  liq.catch(() => {});
  const esperando = await Promise.race([liq.then(() => false, () => false), new Promise((ok) => { setTimeout(() => ok(true), 400); })]);
  // Solta a trava sem homologar: a liquidação (que estava esperando) segue normalmente.
  await cl.query("rollback");
  cl.release();
  assert.equal(esperando, true, "a liquidação espera a trava de setembro");
  await liq; // sem homologação de fato, ela segue
  // Agora o caminho real: homologa e só então tenta liquidar outra saída de setembro → recusada (núcleo e banco).
  const o2 = (await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 900, descricao: "Outra" }))).obrigacoes[0];
  const pg2 = (await n.registrarMovimentacao(c, saida(banco.id, 900, { dataEfetiva: "2026-09-26" }))).movimentacao;
  await n.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Sintética.", confirmar: true });
  await assert.rejects(n.registrarLiquidacao(c, { movimentacaoId: pg2.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: o2.id, valorCentavos: 900 }] }), (e) => e.codigo === "FV2_COMPETENCIA_HOMOLOGADA");
});
