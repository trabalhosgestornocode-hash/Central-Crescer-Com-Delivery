// Fase E — 9 (transferência interna sem receita/despesa), 13 e 14 (datas, competências e operações inválidas).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { entrada, montarComCadastros, obrigacao, rejeita, saida } from "./helpers/cenario.js";

const total = async (nucleo, c, indicador, competencia = "2026-09") => (await nucleo.consultarComposicao(c, { indicador, competencia })).totalCentavos;

test("transferência interna: saída e entrada vinculadas, sem receita, despesa ou variação de caixa", async () => {
  const { nucleo, c, banco, caixa } = await montarComCadastros();
  const r = await nucleo.registrarTransferencia(c, { contaOrigemId: caixa.id, contaDestinoId: banco.id, valorCentavos: 150000, dataEfetiva: "2026-09-15", descricao: "Depósito do caixa" });
  assert.deepEqual([r.saida.contaId, r.saida.sentido, r.saida.valorCentavos, r.saida.natureza], [caixa.id, "SAIDA", 150000, "TRANSFERENCIA_INTERNA"]);
  assert.deepEqual([r.entrada.contaId, r.entrada.sentido, r.entrada.valorCentavos, r.entrada.natureza], [banco.id, "ENTRADA", 150000, "TRANSFERENCIA_INTERNA"]);
  assert.ok(r.saida.transferenciaId === r.transferencia.id && r.entrada.transferenciaId === r.transferencia.id);
  assert.deepEqual([r.transferencia.saidaId, r.transferencia.entradaId], [r.saida.id, r.entrada.id]);

  assert.equal((await nucleo.consultarRegistros(c, { tipo: "LANCAMENTO" })).length, 0);
  for (const indicador of ["RECEITA_BRUTA", "DESPESAS", "DEDUCOES", "RESULTADO_ECONOMICO", "ENTRADAS_DE_CAIXA", "SAIDAS_DE_CAIXA", "VARIACAO_DE_CAIXA"]) {
    assert.equal(await total(nucleo, c, indicador), 0, indicador);
  }
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("transferência não pode ser usada para pagar ou receber títulos, nem registrada pela metade", async () => {
  const { nucleo, c, banco, caixa, fornecedor } = await montarComCadastros();
  const ob = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id))).obrigacoes[0];
  const { recebivel } = await nucleo.registrarRecebivel(c, { processador: "STONE", brutoCentavos: 100000, competencia: "2026-09" });
  const t = await nucleo.registrarTransferencia(c, { contaOrigemId: banco.id, contaDestinoId: caixa.id, valorCentavos: 100000, dataEfetiva: "2026-09-15" });
  await rejeita(nucleo.registrarLiquidacao(c, { movimentacaoId: t.saida.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 100000 }] }), CODIGO.LIQUIDACAO_INCOMPATIVEL);
  await rejeita(nucleo.registrarLiquidacao(c, { movimentacaoId: t.entrada.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: recebivel.id, valorCentavos: 100000 }] }), CODIGO.LIQUIDACAO_INCOMPATIVEL);
  // Uma "perna" solta de transferência não existe como movimentação comum.
  await rejeita(nucleo.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-09-15", sentido: "SAIDA", valorCentavos: 100, natureza: "TRANSFERENCIA_INTERNA" }), CODIGO.TRANSFERENCIA_INVALIDA);
  await rejeita(nucleo.registrarTransferencia(c, { contaOrigemId: banco.id, contaDestinoId: banco.id, valorCentavos: 100, dataEfetiva: "2026-09-15" }), CODIGO.TRANSFERENCIA_INVALIDA);
  await rejeita(nucleo.registrarTransferencia(c, { contaOrigemId: banco.id, contaDestinoId: "dddddddd-0000-4000-8000-000000000001", valorCentavos: 100, dataEfetiva: "2026-09-15" }), CODIGO.NAO_ENCONTRADO);
  await rejeita(nucleo.registrarTransferencia(c, { contaOrigemId: banco.id, contaDestinoId: caixa.id, valorCentavos: 0, dataEfetiva: "2026-09-15" }), CODIGO.VALOR_INVALIDO);
  // A falha no destino não pode ter deixado a saída gravada.
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).length, 2);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "TRANSFERENCIA" })).length, 1);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("reimportar a mesma transferência não duplica as movimentações", async () => {
  const { nucleo, c, banco, caixa } = await montarComCadastros();
  const cmd = { contaOrigemId: banco.id, contaDestinoId: caixa.id, valorCentavos: 5000, dataEfetiva: "2026-09-15", fonte: { sistema: "UNICRED", idExterno: "TRF-1" } };
  const a = await nucleo.registrarTransferencia(c, cmd);
  const b = await nucleo.registrarTransferencia(c, cmd);
  assert.ok(!a.repetido && b.repetido);
  assert.deepEqual([b.saida.id, b.entrada.id], [a.saida.id, a.entrada.id]);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).length, 2);
});

test("datas e competências inválidas são recusadas nas operações", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const ob = (extra) => nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, extra));
  await rejeita(ob({ dataEmissao: "2026-02-30" }), CODIGO.DATA_INVALIDA);
  await rejeita(ob({ vencimento: "20/09/2026" }), CODIGO.DATA_INVALIDA);
  await rejeita(ob({ competencia: "2026-13" }), CODIGO.DATA_INVALIDA);
  await rejeita(ob({ competencia: "setembro" }), CODIGO.DATA_INVALIDA);
  await rejeita(ob({ competencia: undefined }), CODIGO.DATA_INVALIDA); // competência de despesa é sempre explícita
  await rejeita(ob({ dataEmissao: "2026-09-21", vencimento: "2026-09-20" }), CODIGO.DATA_INVALIDA); // vence antes de existir
  // Movimentação é fato ocorrido: não pode estar no futuro (relógio do teste: 15/10/2026).
  await rejeita(nucleo.registrarMovimentacao(c, saida(banco.id, 100, { dataEfetiva: "2026-10-16" })), CODIGO.DATA_INVALIDA);
  await rejeita(nucleo.registrarTransferencia(c, { contaOrigemId: banco.id, contaDestinoId: fornecedor.id, valorCentavos: 1, dataEfetiva: "2027-01-01" }), CODIGO.DATA_INVALIDA);
  await nucleo.registrarMovimentacao(c, saida(banco.id, 100, { dataEfetiva: "2026-10-15" })); // hoje é aceito
  await rejeita(nucleo.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-09-31", brutoCentavos: 100, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 100 }], fonte: { sistema: "SAIPOS", idExterno: "X" } }), CODIGO.DATA_INVALIDA);
  await rejeita(nucleo.consultarCompetencia(c, { competencia: "2026-9" }), CODIGO.DATA_INVALIDA);
  await rejeita(nucleo.consultarComposicao(c, { indicador: "DESPESAS", competencia: null }), CODIGO.DATA_INVALIDA);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "OBRIGACAO" })).length, 0);
});

test("competência da venda nasce da data; a da obrigação é independente do vencimento", async () => {
  const { nucleo, c, fornecedor } = await montarComCadastros();
  const v = await nucleo.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-09-30", brutoCentavos: 100, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 100 }], fonte: { sistema: "SAIPOS", idExterno: "ULT" } });
  assert.equal(v.venda.competencia, "2026-09");
  const { obrigacoes: [ob] } = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { competencia: "2026-09", dataEmissao: "2026-09-28", vencimento: "2026-10-10" }));
  assert.deepEqual([ob.competencia, ob.vencimento], ["2026-09", "2026-10-10"]);
  assert.equal(await total(nucleo, c, "DESPESAS", "2026-09"), 100000);
  assert.equal(await total(nucleo, c, "DESPESAS", "2026-10"), 0);
});

test("valores e entradas inválidas são recusados sem efeito", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const mov = (extra) => nucleo.registrarMovimentacao(c, saida(banco.id, 100, extra));
  for (const valorCentavos of [0, -100, 10.5, "100", NaN, null, 2 ** 60]) await rejeita(mov({ valorCentavos }), CODIGO.VALOR_INVALIDO);
  await rejeita(mov({ sentido: "LADO" }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(mov({ sentido: "ENTRADA" }), CODIGO.ENTRADA_INVALIDA); // PAGAMENTO não é entrada
  await rejeita(mov({ natureza: "RECEBIMENTO" }), CODIGO.ENTRADA_INVALIDA); // RECEBIMENTO não é saída
  await rejeita(mov({ moeda: "USD" }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(mov({ contaId: "1" }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(mov({ campoInventado: true }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(mov({ contaId: fornecedor.id }), CODIGO.NAO_ENCONTRADO); // id existe, mas não é conta
  await rejeita(nucleo.registrarMovimentacao(c, null), CODIGO.ENTRADA_INVALIDA);
  await rejeita(nucleo.registrarMovimentacao(c, [entrada(banco.id, 1)]), CODIGO.ENTRADA_INVALIDA);

  await rejeita(nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: -1 })), CODIGO.VALOR_INVALIDO);
  await rejeita(nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 2, parcelas: 3 })), CODIGO.VALOR_INVALIDO);
  await rejeita(nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { parcelas: 0 })), CODIGO.ENTRADA_INVALIDA);
  await rejeita(nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { descricao: "   " })), CODIGO.ENTRADA_INVALIDA);
  await rejeita(nucleo.registrarObrigacao(c, obrigacao(banco.id)), CODIGO.NAO_ENCONTRADO); // conta não é contraparte

  await rejeita(nucleo.registrarRecebivel(c, { brutoCentavos: 100, competencia: "2026-09" }), CODIGO.ENTRADA_INVALIDA); // sem devedor
  await rejeita(nucleo.registrarRecebivel(c, { processador: "STONE", contraparteId: fornecedor.id, brutoCentavos: 100, competencia: "2026-09" }), CODIGO.ENTRADA_INVALIDA); // dois devedores
  await rejeita(nucleo.registrarRecebivel(c, { processador: "STONE", brutoCentavos: 100, competencia: "2026-09", deducoes: [{ tipo: "TAXA", valorCentavos: 101 }] }), CODIGO.VALOR_INVALIDO);
  await rejeita(nucleo.registrarRecebivel(c, { processador: "BANCO", brutoCentavos: 100, competencia: "2026-09" }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(nucleo.configurarContaFinanceira(c, { tipo: "STONE", nome: "Stone" }), CODIGO.ENTRADA_INVALIDA); // processador não é tipo de conta
  await rejeita(nucleo.configurarContaFinanceira(c, { tipo: "PROCESSADOR", nome: "iFood" }), CODIGO.ENTRADA_INVALIDA);

  assert.equal((await nucleo.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).length, 0);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "OBRIGACAO" })).length, 0);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "RECEBIVEL" })).length, 0);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "LANCAMENTO" })).length, 0);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "CONTA" })).length, 2);
});
