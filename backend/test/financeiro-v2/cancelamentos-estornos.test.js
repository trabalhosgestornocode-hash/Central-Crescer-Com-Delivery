// Cancelamentos e estornos: nada é apagado, tudo deixa rastro, e o que já virou dinheiro exige a operação compensatória.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { entrada, montarComCadastros, obrigacao, rejeita, saida, sha } from "./helpers/cenario.js";

const venda = (extra = {}) => ({ canal: "BALCAO", dataVenda: "2026-09-10", brutoCentavos: 10000, fonte: { sistema: "SAIPOS", idExterno: "V-1" }, ...extra });
const total = async (nucleo, c, indicador) => (await nucleo.consultarComposicao(c, { indicador, competencia: "2026-09" })).totalCentavos;
const registros = (nucleo, c, tipo) => nucleo.consultarRegistros(c, { tipo });

test("cancelar venda não apaga nada: venda, receita, pagamento e recebível ficam, marcados e com motivo", async () => {
  const { nucleo, c } = await montarComCadastros();
  const r = await nucleo.registrarVenda(c, venda({ pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 10000 }] }));
  const { documento } = await nucleo.registrarDocumento(c, { origem: "SAIPOS", arquivoId: "cofre:sintetico-venda", hashSha256: sha("b2"), tipo: "RELATORIO_VENDAS", recebidoEm: "2026-09-10" });
  await nucleo.vincularDocumento(c, { documentoId: documento.id, registroTipo: "VENDA", registroId: r.venda.id });
  assert.equal(await total(nucleo, c, "RECEITA_BRUTA"), 10000);

  const x = await nucleo.cancelarVenda(c, { vendaId: r.venda.id, justificativa: "Pedido cancelado antes da entrega" });
  assert.deepEqual([x.venda.situacao, x.lancamento.situacao, x.pagamentos[0].situacao, x.recebiveis[0].situacao], ["CANCELADA", "CANCELADO", "CANCELADO", "CANCELADA"]);
  for (const [tipo, quantidade] of [["VENDA", 1], ["LANCAMENTO", 1], ["PAGAMENTO_VENDA", 1], ["RECEBIVEL", 1], ["VINCULO_DOCUMENTAL", 1]]) {
    assert.equal((await registros(nucleo, c, tipo)).length, quantidade, tipo);
  }
  assert.equal(await total(nucleo, c, "RECEITA_BRUTA"), 0);
  assert.equal(await total(nucleo, c, "SALDO_A_RECEBER"), 0);
  const h = await nucleo.consultarHistorico(c, { registroTipo: "VENDA", registroId: r.venda.id });
  assert.deepEqual(h.map((e) => [e.evento, e.justificativa, e.antes?.situacao ?? null, e.depois.situacao]), [["CRIACAO", null, null, "ATIVA"], ["CANCELAMENTO", "Pedido cancelado antes da entrega", "ATIVA", "CANCELADA"]]);

  await rejeita(nucleo.cancelarVenda(c, { vendaId: r.venda.id, justificativa: "de novo" }), CODIGO.OPERACAO_INVALIDA);
  await rejeita(nucleo.cancelarVenda(c, { vendaId: r.venda.id }), CODIGO.ENTRADA_INVALIDA); // sem justificativa
  await rejeita(nucleo.registrarPagamentoDeVenda(c, { vendaId: r.venda.id, forma: "PIX", valorCentavos: 100 }), CODIGO.OPERACAO_INVALIDA);
  await rejeita(nucleo.estornarPagamentoDeVenda(c, { pagamentoId: r.pagamentos[0].id, motivo: "DEVOLUCAO_AO_CLIENTE", justificativa: "x" }), CODIGO.OPERACAO_INVALIDA);
  // A mesma origem externa continua registrada: reimportar a venda cancelada não a recria.
  assert.equal((await nucleo.registrarVenda(c, venda({ pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 10000 }] }))).repetido, true);
  assert.equal((await registros(nucleo, c, "VENDA")).length, 1);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("cancelar venda com dinheiro já recebido exige a operação compensatória antes", async () => {
  const { nucleo, c, banco, caixa } = await montarComCadastros();
  // (a) repasse do processador já liquidado → estornar a liquidação antes.
  const a = await nucleo.registrarVenda(c, venda({ pagamentos: [{ forma: "DEBITO", processador: "STONE", valorCentavos: 10000 }] }));
  const { movimentacao } = await nucleo.registrarMovimentacao(c, entrada(banco.id, 10000));
  const { liquidacoes: [liq] } = await nucleo.registrarLiquidacao(c, { movimentacaoId: movimentacao.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: a.recebiveis[0].id, valorCentavos: 10000 }] });
  await rejeita(nucleo.cancelarVenda(c, { vendaId: a.venda.id, justificativa: "Cancelada" }), CODIGO.ESTORNO_EXIGE_COMPENSACAO);
  assert.equal((await registros(nucleo, c, "VENDA"))[0].situacao, "ATIVA"); // recusa não deixa efeito parcial
  await nucleo.estornarLiquidacao(c, { liquidacaoId: liq.id, justificativa: "Repasse devolvido ao processador" });
  assert.equal((await nucleo.cancelarVenda(c, { vendaId: a.venda.id, justificativa: "Cancelada" })).venda.situacao, "CANCELADA");

  // (b) dinheiro no caixa → devolver (estorno do pagamento) antes.
  const b = await nucleo.registrarVenda(c, venda({ fonte: { sistema: "SAIPOS", idExterno: "V-2" }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 10000, contaId: caixa.id }] }));
  await rejeita(nucleo.cancelarVenda(c, { vendaId: b.venda.id, justificativa: "Cancelada" }), CODIGO.ESTORNO_EXIGE_COMPENSACAO);
  await nucleo.estornarPagamentoDeVenda(c, { pagamentoId: b.pagamentos[0].id, motivo: "DEVOLUCAO_AO_CLIENTE", justificativa: "Dinheiro devolvido", dataEfetiva: "2026-09-10" });
  assert.equal(await total(nucleo, c, "DEDUCOES"), 10000);
  const x = await nucleo.cancelarVenda(c, { vendaId: b.venda.id, justificativa: "Cancelada após devolução" });
  assert.equal(x.venda.situacao, "CANCELADA");
  // Receita e devolução saem juntas do resultado; o caixa mostra a entrada e a saída reais.
  assert.equal(await total(nucleo, c, "RECEITA_BRUTA"), 0);
  assert.equal(await total(nucleo, c, "DEDUCOES"), 0);
  assert.equal(await total(nucleo, c, "RESULTADO_ECONOMICO"), 0);
  assert.equal(await total(nucleo, c, "VARIACAO_DE_CAIXA"), 10000); // sobrou no banco o repasse cujo vínculo foi estornado
  assert.equal((await registros(nucleo, c, "LANCAMENTO")).length, 3); // 2 receitas + 1 devolução, todas canceladas e preservadas
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("cancelar recebível ainda não liquidado preserva o registro e cancela suas retenções", async () => {
  const { nucleo, c, banco } = await montarComCadastros();
  const { recebivel } = await nucleo.registrarRecebivel(c, {
    processador: "IFOOD", canal: "IFOOD", brutoCentavos: 50000, competencia: "2026-09",
    retencoes: [{ categoria: "COMISSOES_IFOOD", valorCentavos: 6000 }], fonte: { sistema: "IFOOD", idExterno: "REP-1" },
  });
  await nucleo.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: recebivel.id, valorCentavos: -500, motivo: "Taxa descoberta depois", categoria: "TAXAS_DE_PROCESSAMENTO" });
  assert.equal(await total(nucleo, c, "DESPESAS"), 6500);

  // Com recebimento vinculado, não cancela.
  const { movimentacao } = await nucleo.registrarMovimentacao(c, entrada(banco.id, 1000));
  const { liquidacoes: [liq] } = await nucleo.registrarLiquidacao(c, { movimentacaoId: movimentacao.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: recebivel.id, valorCentavos: 1000 }] });
  await rejeita(nucleo.cancelarRecebivel(c, { recebivelId: recebivel.id, justificativa: "Duplicado" }), CODIGO.ESTORNO_EXIGE_COMPENSACAO);
  await nucleo.estornarLiquidacao(c, { liquidacaoId: liq.id, justificativa: "Vínculo indevido" });

  const x = await nucleo.cancelarRecebivel(c, { recebivelId: recebivel.id, justificativa: "Demonstrativo lançado em duplicidade" });
  assert.equal(x.recebivel.situacao, "CANCELADA");
  assert.equal(await total(nucleo, c, "DESPESAS"), 0);
  assert.equal(await total(nucleo, c, "SALDO_A_RECEBER"), 0);
  assert.deepEqual((await registros(nucleo, c, "LANCAMENTO")).map((l) => l.situacao), ["CANCELADO", "CANCELADO"]);
  await rejeita(nucleo.cancelarRecebivel(c, { recebivelId: recebivel.id, justificativa: "de novo" }), CODIGO.OPERACAO_INVALIDA);
  await rejeita(nucleo.registrarLiquidacao(c, { movimentacaoId: movimentacao.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: recebivel.id, valorCentavos: 1 }] }), CODIGO.OPERACAO_INVALIDA);

  // Recebível que nasceu de pagamento de venda não se cancela sozinho.
  const v = await nucleo.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-09-10", brutoCentavos: 3000, pagamentos: [{ forma: "DEBITO", processador: "STONE", valorCentavos: 3000 }], fonte: { sistema: "SAIPOS", idExterno: "V-9" } });
  await rejeita(nucleo.cancelarRecebivel(c, { recebivelId: v.recebiveis[0].id, justificativa: "x" }), CODIGO.OPERACAO_INVALIDA);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("estorno total e parcial de liquidação: o original fica, o saldo volta e nunca passa do que foi liquidado", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const ob = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id))).obrigacoes[0];
  const pg = (await nucleo.registrarMovimentacao(c, saida(banco.id, 60000))).movimentacao;
  const { liquidacoes: [liq] } = await nucleo.registrarLiquidacao(c, { movimentacaoId: pg.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 60000 }] });

  await rejeita(nucleo.estornarLiquidacao(c, { liquidacaoId: liq.id, valorCentavos: 60001, justificativa: "x" }), CODIGO.OPERACAO_INVALIDA);
  const parcial = await nucleo.estornarLiquidacao(c, { liquidacaoId: liq.id, valorCentavos: 20000, justificativa: "Banco devolveu parte do pagamento" });
  assert.deepEqual([parcial.liquidacao.valorCentavos, parcial.liquidacao.estornadoCentavos, parcial.liquidacao.situacao], [60000, 20000, "ESTORNADA_PARCIAL"]);
  assert.deepEqual([parcial.titulo.liquidadoCentavos, parcial.titulo.saldoCentavos, parcial.titulo.situacao], [40000, 60000, "PARCIAL"]);
  assert.deepEqual([parcial.movimentacao.alocadoCentavos, parcial.estorno.alvoTipo, parcial.estorno.alvoId, parcial.estorno.valorCentavos], [40000, "LIQUIDACAO", liq.id, 20000]);

  const resto = await nucleo.estornarLiquidacao(c, { liquidacaoId: liq.id, justificativa: "Pagamento desfeito por inteiro" }); // sem valor = o que ainda vale
  assert.deepEqual([resto.estorno.valorCentavos, resto.liquidacao.estornadoCentavos, resto.liquidacao.situacao], [40000, 60000, "ESTORNADA"]);
  assert.deepEqual([resto.titulo.liquidadoCentavos, resto.titulo.saldoCentavos, resto.titulo.situacao, resto.movimentacao.alocadoCentavos], [0, 100000, "ABERTA", 0]);
  await rejeita(nucleo.estornarLiquidacao(c, { liquidacaoId: liq.id, justificativa: "terceira vez" }), CODIGO.OPERACAO_INVALIDA);

  assert.equal((await registros(nucleo, c, "LIQUIDACAO")).length, 1); // a liquidação original continua existindo
  assert.deepEqual((await registros(nucleo, c, "ESTORNO")).map((e) => [e.alvoId, e.valorCentavos]), [[liq.id, 20000], [liq.id, 40000]]);
  const h = await nucleo.consultarHistorico(c, { registroTipo: "LIQUIDACAO", registroId: liq.id });
  assert.deepEqual(h.map((e) => e.evento), ["CRIACAO", "ESTORNO", "ESTORNO"]);
  assert.equal(await total(nucleo, c, "DESPESAS"), 100000); // estornar pagamento não mexe na despesa
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("estorno de movimentação e de transferência: só quando nada depende delas, e sempre preservando o registro", async () => {
  const { nucleo, c, banco, caixa, fornecedor } = await montarComCadastros();
  const ob = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id))).obrigacoes[0];
  const usada = (await nucleo.registrarMovimentacao(c, saida(banco.id, 1000))).movimentacao;
  await nucleo.registrarLiquidacao(c, { movimentacaoId: usada.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 1000 }] });
  await rejeita(nucleo.estornarMovimentacao(c, { movimentacaoId: usada.id, justificativa: "x" }), CODIGO.ESTORNO_EXIGE_COMPENSACAO);

  const duplicada = (await nucleo.registrarMovimentacao(c, saida(banco.id, 7000))).movimentacao;
  assert.equal(await total(nucleo, c, "SAIDAS_DE_CAIXA"), 8000);
  const e = await nucleo.estornarMovimentacao(c, { movimentacaoId: duplicada.id, justificativa: "Linha do extrato lançada duas vezes" });
  assert.deepEqual([e.movimentacao.situacao, e.movimentacao.estornoId, e.estorno.alvoTipo, e.estorno.valorCentavos], ["ESTORNADA", e.estorno.id, "MOVIMENTACAO", 7000]);
  assert.equal(await total(nucleo, c, "SAIDAS_DE_CAIXA"), 1000);
  assert.equal((await registros(nucleo, c, "MOVIMENTACAO")).length, 2);
  await rejeita(nucleo.estornarMovimentacao(c, { movimentacaoId: duplicada.id, justificativa: "de novo" }), CODIGO.OPERACAO_INVALIDA);
  await rejeita(nucleo.registrarLiquidacao(c, { movimentacaoId: duplicada.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 1 }] }), CODIGO.LIQUIDACAO_INCOMPATIVEL);

  const t = await nucleo.registrarTransferencia(c, { contaOrigemId: banco.id, contaDestinoId: caixa.id, valorCentavos: 5000, dataEfetiva: "2026-09-15" });
  await rejeita(nucleo.estornarMovimentacao(c, { movimentacaoId: t.saida.id, justificativa: "x" }), CODIGO.OPERACAO_INVALIDA); // perna não se estorna sozinha
  const et = await nucleo.estornarTransferencia(c, { transferenciaId: t.transferencia.id, justificativa: "Transferência registrada por engano" });
  assert.deepEqual([et.transferencia.situacao, et.saida.situacao, et.entrada.situacao, et.estorno.alvoTipo], ["ESTORNADA", "ESTORNADA", "ESTORNADA", "TRANSFERENCIA"]);
  await rejeita(nucleo.estornarTransferencia(c, { transferenciaId: t.transferencia.id, justificativa: "de novo" }), CODIGO.OPERACAO_INVALIDA);
  assert.equal((await registros(nucleo, c, "TRANSFERENCIA")).length, 1);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("correção de lançamento deixa trilha; valor e competência não se corrigem em silêncio", async () => {
  const { nucleo, c, fornecedor } = await montarComCadastros();
  const { lancamento } = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id));
  const novo = await nucleo.corrigirLancamento(c, { lancamentoId: lancamento.id, mudancas: { descricao: "Compra de frutas da semana" }, justificativa: "Descrição incompleta" });
  assert.deepEqual([novo.descricao, novo.valorCentavos, novo.competencia, novo.versao], ["Compra de frutas da semana", 100000, "2026-09", 2]);
  const h = await nucleo.consultarHistorico(c, { registroTipo: "LANCAMENTO", registroId: lancamento.id });
  assert.deepEqual([h[1].evento, h[1].justificativa, h[1].antes.descricao, h[1].depois.descricao], ["CORRECAO", "Descrição incompleta", "Compra sintética", "Compra de frutas da semana"]);
  await rejeita(nucleo.corrigirLancamento(c, { lancamentoId: lancamento.id, mudancas: { valorCentavos: 1 }, justificativa: "x" }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(nucleo.corrigirLancamento(c, { lancamentoId: lancamento.id, mudancas: { competencia: "2026-10" }, justificativa: "x" }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(nucleo.corrigirLancamento(c, { lancamentoId: lancamento.id, mudancas: { descricao: "y" } }), CODIGO.ENTRADA_INVALIDA); // sem justificativa
});

test("competência homologada: cancelar ou estornar ali é recusado, sem efeito", async () => {
  const { nucleo, c, caixa } = await montarComCadastros();
  const r = await nucleo.registrarVenda(c, venda({ pagamentos: [{ forma: "DINHEIRO", valorCentavos: 10000, contaId: caixa.id }] }));
  await nucleo.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_PRELIMINAR" });
  await nucleo.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Conferência sintética" });
  await rejeita(nucleo.cancelarVenda(c, { vendaId: r.venda.id, justificativa: "Tarde demais" }), CODIGO.COMPETENCIA_HOMOLOGADA);
  await rejeita(nucleo.estornarPagamentoDeVenda(c, { pagamentoId: r.pagamentos[0].id, motivo: "DEVOLUCAO_AO_CLIENTE", justificativa: "x", dataEfetiva: "2026-09-20" }), CODIGO.COMPETENCIA_HOMOLOGADA);
  await rejeita(nucleo.estornarMovimentacao(c, { movimentacaoId: r.movimentacoes[0].id, justificativa: "x" }), CODIGO.OPERACAO_INVALIDA);
  // A devolução feita em outubro entra na competência de outubro: setembro homologado permanece intacto.
  const e = await nucleo.estornarPagamentoDeVenda(c, { pagamentoId: r.pagamentos[0].id, valorCentavos: 1000, motivo: "DEVOLUCAO_AO_CLIENTE", justificativa: "Devolução em outubro", dataEfetiva: "2026-10-02" });
  assert.equal(e.lancamento.competencia, "2026-10");
  assert.equal(await total(nucleo, c, "RECEITA_BRUTA"), 10000);
  assert.equal(await total(nucleo, c, "DEDUCOES"), 0);
  assert.equal((await nucleo.consultarComposicao(c, { indicador: "DEDUCOES", competencia: "2026-10" })).totalCentavos, 1000);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});
