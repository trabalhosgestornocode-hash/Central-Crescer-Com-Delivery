// Concorrência REAL no PostgreSQL local isolado: chamadas simultâneas em conexões diferentes.
// Em memória as transações são serializadas e estes cenários não provam nada — por isso só rodam no banco.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO, ErroFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { ESCOPOS_PADRAO, ctx, entrada, montar, obrigacao, prepararHomologacao, saida } from "./helpers/cenario.js";
import { motivoParaPular, repositorioPostgresDeTeste, tokenDeTeste } from "./helpers/postgres.js";

const pular = { skip: motivoParaPular() };

async function montarNoBanco() {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO);
  const m = montar({ repositorio });
  await repositorio.interno();
  const c = ctx();
  const banco = await m.nucleo.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco" });
  const caixa = await m.nucleo.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  const fornecedor = await m.nucleo.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Fornecedor" });
  return { ...m, c, banco, caixa, fornecedor };
}

/** Dispara todas ao mesmo tempo e separa sucessos de falhas (com o código de cada falha). */
async function simultaneas(fns) {
  const r = await Promise.allSettled(fns.map((f) => f()));
  const falhas = r.filter((x) => x.status === "rejected").map((x) => x.reason);
  for (const f of falhas) assert.ok(f instanceof ErroFinanceiro, `falha inesperada: ${f?.code ?? ""} ${f?.message}`);
  return { ok: r.filter((x) => x.status === "fulfilled").map((x) => x.value), falhas: falhas.map((f) => f.codigo) };
}

const N = 8;
const qtd = async (nucleo, c, tipo) => (await nucleo.consultarRegistros(c, { tipo })).length;

test("mesma venda registrada N vezes ao mesmo tempo: uma gravação, os demais recebem a mesma venda como repetida", pular, async () => {
  const { nucleo, c, caixa } = await montarNoBanco();
  const venda = { canal: "BALCAO", dataVenda: "2026-09-10", brutoCentavos: 10000, fonte: { sistema: "SAIPOS", idExterno: "CONC-1" }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 4000, contaId: caixa.id }, { forma: "CREDITO", processador: "STONE", valorCentavos: 6000 }] };
  const { ok, falhas } = await simultaneas(Array.from({ length: N }, () => () => nucleo.registrarVenda(c, venda)));
  assert.deepEqual(falhas, []);
  assert.equal(ok.filter((r) => !r.repetido).length, 1);
  assert.equal(new Set(ok.map((r) => r.venda.id)).size, 1);
  for (const [tipo, n] of [["VENDA", 1], ["LANCAMENTO", 1], ["PAGAMENTO_VENDA", 2], ["RECEBIVEL", 1], ["MOVIMENTACAO", 1]]) assert.equal(await qtd(nucleo, c, tipo), n, tipo);
  assert.equal((await nucleo.consultarComposicao(c, { indicador: "RECEITA_BRUTA", competencia: "2026-09" })).totalCentavos, 10000);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("mesma origem com conteúdo diferente ao mesmo tempo: uma vence, a outra é conflito — nunca sobrescreve", pular, async () => {
  const { nucleo, c } = await montarNoBanco();
  const v = (valor) => () => nucleo.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-09-10", brutoCentavos: valor, fonte: { sistema: "SAIPOS", idExterno: "CONC-2" }, pagamentos: [{ forma: "PIX", valorCentavos: valor }] });
  const { ok, falhas } = await simultaneas([v(1000), v(2000)]);
  assert.equal(ok.length, 1);
  assert.deepEqual(falhas, [CODIGO.CONFLITO_IDEMPOTENCIA]);
  assert.equal(await qtd(nucleo, c, "VENDA"), 1);
});

test("liquidações concorrentes sobre o mesmo saldo: nunca liquidam além do saldo, nunca deixam saldo negativo", pular, async () => {
  const { nucleo, c, banco, fornecedor } = await montarNoBanco();
  const ob = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 10000 }))).obrigacoes[0];
  const movs = [];
  for (let i = 0; i < N; i += 1) movs.push((await nucleo.registrarMovimentacao(c, saida(banco.id, 3000))).movimentacao);
  const { ok, falhas } = await simultaneas(movs.map((m) => () => nucleo.registrarLiquidacao(c, { movimentacaoId: m.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 3000 }] })));
  assert.equal(ok.length, 3); // 3 × 3000 cabem em 10000; a quarta não
  assert.ok(falhas.every((f) => f === CODIGO.LIQUIDACAO_EXCEDE_SALDO));
  const [agora] = await nucleo.consultarRegistros(c, { tipo: "OBRIGACAO" });
  assert.deepEqual([agora.liquidadoCentavos, agora.saldoCentavos, agora.situacao], [9000, 1000, "PARCIAL"]);
  assert.equal(await qtd(nucleo, c, "LIQUIDACAO"), 3);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("uma movimentação disputada por vários títulos ao mesmo tempo nunca é alocada além do seu valor", pular, async () => {
  const { nucleo, c, banco } = await montarNoBanco();
  const recebiveis = [];
  for (let i = 0; i < N; i += 1) recebiveis.push((await nucleo.registrarRecebivel(c, { processador: "STONE", brutoCentavos: 4000, competencia: "2026-09" })).recebivel);
  const { movimentacao } = await nucleo.registrarMovimentacao(c, entrada(banco.id, 10000));
  const { ok, falhas } = await simultaneas(recebiveis.map((r) => () => nucleo.registrarLiquidacao(c, { movimentacaoId: movimentacao.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: r.id, valorCentavos: 4000 }] })));
  assert.equal(ok.length, 2);
  assert.ok(falhas.every((f) => f === CODIGO.LIQUIDACAO_EXCEDE_MOVIMENTACAO));
  const m = (await nucleo.consultarRegistros(c, { tipo: "MOVIMENTACAO" }))[0];
  assert.equal(m.alocadoCentavos, 8000);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("transferência repetida ao mesmo tempo: um único par saída+entrada", pular, async () => {
  const { nucleo, c, banco, caixa } = await montarNoBanco();
  const t = { contaOrigemId: banco.id, contaDestinoId: caixa.id, valorCentavos: 5000, dataEfetiva: "2026-09-15", fonte: { sistema: "UNICRED", idExterno: "TRF-1" } };
  const { ok, falhas } = await simultaneas(Array.from({ length: N }, () => () => nucleo.registrarTransferencia(c, t)));
  assert.deepEqual(falhas, []);
  assert.equal(ok.filter((r) => !r.repetido).length, 1);
  assert.equal(await qtd(nucleo, c, "TRANSFERENCIA"), 1);
  assert.equal(await qtd(nucleo, c, "MOVIMENTACAO"), 2);
});

test("estornos concorrentes: o mesmo valor nunca é estornado duas vezes", pular, async () => {
  const { nucleo, c, banco, caixa, fornecedor } = await montarNoBanco();
  const ob = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id))).obrigacoes[0];
  const pg = (await nucleo.registrarMovimentacao(c, saida(banco.id, 10000))).movimentacao;
  const { liquidacoes: [liq] } = await nucleo.registrarLiquidacao(c, { movimentacaoId: pg.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 10000 }] });
  const parciais = await simultaneas(Array.from({ length: N }, () => () => nucleo.estornarLiquidacao(c, { liquidacaoId: liq.id, valorCentavos: 4000, justificativa: "Concorrente" })));
  assert.equal(parciais.ok.length, 2); // 2 × 4000 ≤ 10000; a terceira não cabe
  assert.ok(parciais.falhas.every((f) => f === CODIGO.OPERACAO_INVALIDA));
  const [liqAgora] = await nucleo.consultarRegistros(c, { tipo: "LIQUIDACAO" });
  assert.deepEqual([liqAgora.estornadoCentavos, liqAgora.situacao], [8000, "ESTORNADA_PARCIAL"]);

  // Devolução total do mesmo pagamento disparada várias vezes: só uma passa.
  const v = await nucleo.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-09-10", brutoCentavos: 7000, fonte: { sistema: "SAIPOS", idExterno: "CONC-E" }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 7000, contaId: caixa.id }] });
  const devol = await simultaneas(Array.from({ length: N }, () => () => nucleo.estornarPagamentoDeVenda(c, { pagamentoId: v.pagamentos[0].id, motivo: "DEVOLUCAO_AO_CLIENTE", justificativa: "Concorrente", dataEfetiva: "2026-09-12" })));
  assert.equal(devol.ok.length, 1);
  assert.equal((await nucleo.consultarComposicao(c, { indicador: "DEDUCOES", competencia: "2026-09" })).totalCentavos, 7000);
  // Cancelar a venda e devolver ao mesmo tempo nunca deixam os dois efeitos incoerentes.
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("cancelamento e liquidação disputando o mesmo título: um dos dois, nunca os dois", pular, async () => {
  const { nucleo, c, banco, fornecedor } = await montarNoBanco();
  const ob = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id))).obrigacoes[0];
  const pg = (await nucleo.registrarMovimentacao(c, saida(banco.id, 1000))).movimentacao;
  const { ok } = await simultaneas([
    () => nucleo.cancelarObrigacao(c, { obrigacaoId: ob.id, justificativa: "Concorrente" }),
    () => nucleo.registrarLiquidacao(c, { movimentacaoId: pg.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 1000 }] }),
  ]);
  assert.equal(ok.length, 1);
  const [agora] = await nucleo.consultarRegistros(c, { tipo: "OBRIGACAO" });
  assert.ok((agora.situacao === "CANCELADA" && agora.liquidadoCentavos === 0) || (agora.situacao === "PARCIAL" && agora.liquidadoCentavos === 1000));
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("homologação concorrendo com escritas: nada entra depois da homologação, nada se perde antes", pular, async () => {
  for (let rodada = 0; rodada < 4; rodada += 1) {
    const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO);
    const { nucleo } = montar({ repositorio });
    const { pool } = await repositorio.interno();
    const c = ctx();
    const banco = await nucleo.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco" });
    const caixa = await nucleo.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
    // 08E (F-1): pendências documentadas antes; as escritas concorrentes são TRANSFERÊNCIAS entre contas próprias, que
    // não criam pendência (uma saída sem vínculo bloquearia, com razão, a homologação — e a prova ficaria fraca).
    await prepararHomologacao(nucleo, c, "2026-09");
    const escritas = Array.from({ length: 2 * N }, (_, i) => () => nucleo.registrarTransferencia(c, { contaOrigemId: banco.id, contaDestinoId: caixa.id, valorCentavos: 100 + i, dataEfetiva: "2026-09-20" }));
    const homologar = () => nucleo.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", confirmar: true, metodologia: "Sintética" });
    const { ok, falhas } = await simultaneas([...escritas.slice(0, N), homologar, ...escritas.slice(N)]);
    assert.ok(falhas.every((f) => f === CODIGO.COMPETENCIA_HOMOLOGADA), JSON.stringify(falhas));
    assert.equal(await qtd(nucleo, c, "TRANSFERENCIA"), ok.length - 1); // aceita = gravada; recusada não deixa rastro
    // Ordem REAL de gravação (sequência do banco, não relógio): toda movimentação foi criada antes da homologação.
    const cliente = await pool.connect();
    try {
      await cliente.query("begin");
      await cliente.query("select fv2_assumir_sessao($1)", [await tokenDeTeste(pool, c)]);
      const { rows } = await cliente.query(`select registro_tipo, evento, depois->>'estado' as estado from fv2_historico
        where (registro_tipo = 'MOVIMENTACAO' and evento = 'CRIACAO') or (registro_tipo = 'COMPETENCIA' and depois->>'estado' = 'FECHAMENTO_HOMOLOGADO') order by seq`);
      await cliente.query("rollback");
      const posicao = rows.findIndex((r) => r.registro_tipo === "COMPETENCIA");
      assert.ok(posicao >= 0);
      assert.deepEqual(rows.slice(posicao + 1), [], `rodada ${rodada}: movimentação gravada depois da homologação`);
    } finally {
      cliente.release();
    }
  }
});

test("trava de competência (determinística): homologação espera escritas em andamento, e escritas esperam a homologação", pular, async () => {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO);
  const { nucleo } = montar({ repositorio });
  const { pool } = await repositorio.interno();
  const c = ctx();
  const banco = await nucleo.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco" });
  await prepararHomologacao(nucleo, c, "2026-09"); // 08E (F-1)
  const chave = `fv2|${c.organizacaoId}|${c.unidadeId}|competencia:2026-09`;
  const segurar = async (funcao) => {
    const cliente = await pool.connect();
    await cliente.query("begin");
    await cliente.query(`select ${funcao}(hashtextextended($1::text, 0))`, [chave]);
    return async () => { await cliente.query("rollback"); cliente.release(); };
  };
  const aindaEsperando = async (promessa) => Promise.race([promessa.then(() => false, () => false), new Promise((r) => { setTimeout(() => r(true), 400); })]);

  // Uma escrita "em andamento" (trava compartilhada): a homologação não pode passar por cima dela.
  const soltarEscrita = await segurar("pg_advisory_xact_lock_shared");
  const homologacao = nucleo.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", confirmar: true, metodologia: "Sintética" });
  homologacao.catch(() => {});
  let esperou;
  try { esperou = await aindaEsperando(homologacao); } finally { await soltarEscrita(); } // solta mesmo se a prova falhar
  assert.equal(esperou, true);
  assert.equal((await homologacao).estado, "FECHAMENTO_HOMOLOGADO");

  // Uma decisão de fechamento "em andamento" (trava exclusiva): a escrita espera e, depois, vê o estado novo.
  await nucleo.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "ABERTA", confirmar: true, justificativa: "Teste de trava" });
  const soltarDecisao = await segurar("pg_advisory_xact_lock");
  const escrita = nucleo.registrarMovimentacao(c, saida(banco.id, 100));
  escrita.catch(() => {});
  let esperouEscrita;
  try { esperouEscrita = await aindaEsperando(escrita); } finally { await soltarDecisao(); }
  assert.equal(esperouEscrita, true);
  assert.equal((await escrita).repetido, false);
});

test("falha no meio de uma operação composta desfaz tudo no banco (rollback integral)", pular, async () => {
  const { nucleo, c, banco, fornecedor } = await montarNoBanco();
  const ob1 = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 1000 }))).obrigacoes[0];
  const ob2 = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 1000, descricao: "Outra" }))).obrigacoes[0];
  const pg = (await nucleo.registrarMovimentacao(c, saida(banco.id, 3000))).movimentacao;
  const historicoAntes = (await nucleo.consultarHistorico(c, { registroTipo: "OBRIGACAO", registroId: ob1.id })).length;
  await assert.rejects(nucleo.registrarLiquidacao(c, { movimentacaoId: pg.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: ob1.id, valorCentavos: 1000 }, { alvoTipo: "OBRIGACAO", alvoId: ob2.id, valorCentavos: 2000 }] }), (e) => e.codigo === CODIGO.LIQUIDACAO_EXCEDE_SALDO);
  const obs = await nucleo.consultarRegistros(c, { tipo: "OBRIGACAO" });
  assert.ok(obs.every((o) => o.liquidadoCentavos === 0 && o.versao === 1));
  assert.equal(await qtd(nucleo, c, "LIQUIDACAO"), 0);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "MOVIMENTACAO" }))[0].alocadoCentavos, 0);
  assert.equal((await nucleo.consultarHistorico(c, { registroTipo: "OBRIGACAO", registroId: ob1.id })).length, historicoAntes);

  // Venda com pagamento em conta inativa/errada: receita, pagamento e recebível já criados na mesma transação somem juntos.
  await assert.rejects(nucleo.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-09-10", brutoCentavos: 5000, fonte: { sistema: "SAIPOS", idExterno: "RB-1" }, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 2000 }, { forma: "DINHEIRO", valorCentavos: 3000, contaId: banco.id }] }));
  for (const tipo of ["VENDA", "PAGAMENTO_VENDA", "RECEBIVEL"]) assert.equal(await qtd(nucleo, c, tipo), 0, tipo);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "LANCAMENTO" })).filter((l) => l.natureza === "RECEITA").length, 0);
});
