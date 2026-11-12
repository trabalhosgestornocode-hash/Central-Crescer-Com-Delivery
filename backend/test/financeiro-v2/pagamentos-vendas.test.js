// Vendas com um ou vários pagamentos. Canal, forma de pagamento e processador são dimensões independentes;
// a venda gera UMA receita, não importa quantos pagamentos tenha. Dados sintéticos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { entrada, montarComCadastros, rejeita, semRepeticao, sha } from "./helpers/cenario.js";

const venda = (extra = {}) => ({ canal: "BALCAO", dataVenda: "2026-09-10", brutoCentavos: 10000, fonte: { sistema: "SAIPOS", idExterno: "V-1" }, ...extra });
const total = async (nucleo, c, indicador, extra = {}) => (await nucleo.consultarComposicao(c, { indicador, competencia: "2026-09", ...extra })).totalCentavos;

test("venda paga em dinheiro: entra no caixa físico e NÃO gera recebível de operadora", async () => {
  const { nucleo, c, banco, caixa } = await montarComCadastros();
  const r = await nucleo.registrarVenda(c, venda({ pagamentos: [{ forma: "DINHEIRO", valorCentavos: 10000, contaId: caixa.id }] }));
  assert.equal(r.recebiveis.length, 0);
  assert.equal(r.movimentacoes.length, 1);
  const [m] = r.movimentacoes;
  assert.deepEqual([m.contaId, m.sentido, m.natureza, m.valorCentavos, m.dataEfetiva, m.pagamentoId], [caixa.id, "ENTRADA", "RECEBIMENTO", 10000, "2026-09-10", r.pagamentos[0].id]);
  assert.deepEqual([r.pagamentos[0].forma, r.pagamentos[0].processador, r.pagamentos[0].recebivelId, r.pagamentos[0].movimentacaoId], ["DINHEIRO", null, null, m.id]);
  assert.equal(await total(nucleo, c, "RECEITA_BRUTA"), 10000);
  assert.equal(await total(nucleo, c, "ENTRADAS_DE_CAIXA"), 10000);
  assert.equal(await total(nucleo, c, "SALDO_A_RECEBER"), 0);

  // Dinheiro não entra em conta bancária; e a entrada da venda não serve para "receber" outro título.
  await rejeita(nucleo.registrarVenda(c, venda({ fonte: { sistema: "SAIPOS", idExterno: "V-2" }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 10000, contaId: banco.id }] })), CODIGO.OPERACAO_INVALIDA);
  const { recebivel } = await nucleo.registrarRecebivel(c, { processador: "STONE", brutoCentavos: 10000, competencia: "2026-09" });
  await rejeita(nucleo.registrarLiquidacao(c, { movimentacaoId: m.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: recebivel.id, valorCentavos: 10000 }] }), CODIGO.LIQUIDACAO_INCOMPATIVEL);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("Pix pode ser direto (sem processador) ou pela Stone: a forma não decide o processador", async () => {
  const { nucleo, c, banco, caixa } = await montarComCadastros();
  const direto = await nucleo.registrarVenda(c, venda({ pagamentos: [{ forma: "PIX", valorCentavos: 10000, contaId: banco.id }] }));
  assert.deepEqual([direto.recebiveis.length, direto.movimentacoes.length, direto.movimentacoes[0].contaId], [0, 1, banco.id]);

  const pelaStone = await nucleo.registrarVenda(c, venda({ fonte: { sistema: "SAIPOS", idExterno: "V-2" }, pagamentos: [{ forma: "PIX", processador: "STONE", valorCentavos: 10000 }] }));
  assert.deepEqual([pelaStone.recebiveis.length, pelaStone.movimentacoes.length], [1, 0]);
  assert.deepEqual([pelaStone.recebiveis[0].processador, pelaStone.recebiveis[0].forma, pelaStone.recebiveis[0].saldoCentavos], ["STONE", "PIX", 10000]);

  // Pix direto sem conta informada: nada de recebível nem de movimentação — o extrato trará a entrada depois.
  const semConta = await nucleo.registrarVenda(c, venda({ fonte: { sistema: "SAIPOS", idExterno: "V-3" }, pagamentos: [{ forma: "PIX", valorCentavos: 10000 }] }));
  assert.deepEqual([semConta.recebiveis.length, semConta.movimentacoes.length, semConta.pagamentos.length], [0, 0, 1]);

  await rejeita(nucleo.registrarVenda(c, venda({ fonte: { sistema: "SAIPOS", idExterno: "V-4" }, pagamentos: [{ forma: "PIX", valorCentavos: 10000, contaId: caixa.id }] })), CODIGO.OPERACAO_INVALIDA); // Pix não entra no caixa físico
  await rejeita(nucleo.registrarVenda(c, venda({ fonte: { sistema: "SAIPOS", idExterno: "V-5" }, pagamentos: [{ forma: "PIX", processador: "STONE", valorCentavos: 10000, contaId: banco.id }] })), CODIGO.ENTRADA_INVALIDA); // processado não entra direto em conta
  assert.equal(await total(nucleo, c, "RECEITA_BRUTA"), 30000);
  assert.equal(await total(nucleo, c, "ENTRADAS_DE_CAIXA"), 10000);
  assert.equal(await total(nucleo, c, "SALDO_A_RECEBER"), 10000);
});

test("Stone não é sinônimo de balcão: venda iFood pode ser paga na Stone e venda iFood pelo próprio iFood", async () => {
  const { nucleo, c } = await montarComCadastros();
  const a = await nucleo.registrarVenda(c, venda({ canal: "IFOOD", fonte: { sistema: "IFOOD", idExterno: "O-1" }, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 10000 }] }));
  const b = await nucleo.registrarVenda(c, venda({ canal: "IFOOD", brutoCentavos: 7000, fonte: { sistema: "IFOOD", idExterno: "O-2" }, pagamentos: [{ forma: "CREDITO", processador: "IFOOD", valorCentavos: 7000 }] }));
  const d = await nucleo.registrarVenda(c, venda({ brutoCentavos: 3000, pagamentos: [{ forma: "DEBITO", processador: "STONE", valorCentavos: 3000 }] }));
  assert.deepEqual([a.recebiveis[0].processador, a.recebiveis[0].canal], ["STONE", "IFOOD"]);
  assert.deepEqual([b.recebiveis[0].processador, b.recebiveis[0].canal], ["IFOOD", "IFOOD"]);
  assert.deepEqual([d.recebiveis[0].processador, d.recebiveis[0].canal], ["STONE", "BALCAO"]);
  assert.equal(await total(nucleo, c, "RECEITA_BRUTA", { canal: "IFOOD" }), 17000);
  assert.equal(await total(nucleo, c, "RECEITA_BRUTA", { canal: "BALCAO" }), 3000);
  assert.equal(await total(nucleo, c, "RECEITA_BRUTA"), 20000);
});

test("venda com dinheiro e cartão, e com dois processadores distintos: uma receita, um efeito por pagamento", async () => {
  const { nucleo, c, caixa } = await montarComCadastros();
  const r = await nucleo.registrarVenda(c, venda({ pagamentos: [
    { forma: "DINHEIRO", valorCentavos: 3000, contaId: caixa.id },
    { forma: "CREDITO", processador: "STONE", valorCentavos: 5000 },
    { forma: "VALE", processador: "OPERADORA_BENEFICIOS", valorCentavos: 2000 },
  ] }));
  assert.deepEqual(r.pagamentos.map((p) => [p.indice, p.forma, p.processador, p.valorCentavos]), [[0, "DINHEIRO", null, 3000], [1, "CREDITO", "STONE", 5000], [2, "VALE", "OPERADORA_BENEFICIOS", 2000]]);
  assert.deepEqual(r.recebiveis.map((x) => [x.processador, x.forma, x.saldoCentavos, x.pagamentoId]), [["STONE", "CREDITO", 5000, r.pagamentos[1].id], ["OPERADORA_BENEFICIOS", "VALE", 2000, r.pagamentos[2].id]]);
  assert.deepEqual(r.movimentacoes.map((m) => [m.contaId, m.valorCentavos]), [[caixa.id, 3000]]);
  assert.deepEqual([r.venda.brutoCentavos, r.venda.pagoCentavos, r.venda.devolvidoCentavos], [10000, 10000, 0]);
  const receita = await nucleo.consultarComposicao(c, { indicador: "RECEITA_BRUTA", competencia: "2026-09" });
  assert.deepEqual([receita.totalCentavos, receita.itens.length], [10000, 1]); // três pagamentos, UMA receita
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "LANCAMENTO" })).length, 1);

  // Reimportar a mesma venda não duplica receita, pagamento, recebível nem entrada de caixa.
  const de_novo = await nucleo.registrarVenda(c, venda({ pagamentos: [
    { forma: "DINHEIRO", valorCentavos: 3000, contaId: caixa.id },
    { forma: "CREDITO", processador: "STONE", valorCentavos: 5000 },
    { forma: "VALE", processador: "OPERADORA_BENEFICIOS", valorCentavos: 2000 },
  ] }));
  assert.equal(de_novo.repetido, true);
  assert.deepEqual([de_novo.pagamentos.length, de_novo.recebiveis.length, de_novo.movimentacoes.length], [3, 2, 1]);
  for (const [tipo, quantidade] of [["VENDA", 1], ["PAGAMENTO_VENDA", 3], ["RECEBIVEL", 2], ["MOVIMENTACAO", 1], ["LANCAMENTO", 1]]) {
    assert.equal((await nucleo.consultarRegistros(c, { tipo })).length, quantidade, tipo);
  }
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("pagamento parcial e complemento posterior: a receita não muda e o total pago nunca passa do valor da venda", async () => {
  const { nucleo, c, banco, caixa } = await montarComCadastros();
  // Sem declarar pagamento parcial, soma menor que o bruto é erro (protege contra importação incompleta).
  await rejeita(nucleo.registrarVenda(c, venda({ pagamentos: [{ forma: "DINHEIRO", valorCentavos: 4000, contaId: caixa.id }] })), CODIGO.PAGAMENTOS_NAO_FECHAM);
  const r = await nucleo.registrarVenda(c, venda({ pagamentoParcial: true, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 4000, contaId: caixa.id }] }));
  assert.deepEqual([r.venda.pagoCentavos, r.venda.pagamentoParcial], [4000, true]);
  assert.equal(await total(nucleo, c, "RECEITA_BRUTA"), 10000); // a receita é a venda inteira, desde o início

  await rejeita(nucleo.registrarPagamentoDeVenda(c, { vendaId: r.venda.id, forma: "PIX", valorCentavos: 6001, contaId: banco.id }), CODIGO.PAGAMENTOS_NAO_FECHAM);
  const complemento = { vendaId: r.venda.id, forma: "DEBITO", processador: "STONE", valorCentavos: 6000, dataPagamento: "2026-09-12", fonte: { sistema: "SAIPOS", idExterno: "V-1-COMPL" } };
  const p = await nucleo.registrarPagamentoDeVenda(c, complemento);
  assert.deepEqual([p.pagamento.indice, p.pagamento.dataPagamento, p.recebivel.saldoCentavos, p.venda.pagoCentavos, p.repetido], [1, "2026-09-12", 6000, 10000, false]);
  assert.equal((await nucleo.registrarPagamentoDeVenda(c, complemento)).repetido, true); // complemento reimportado não duplica
  await rejeita(nucleo.registrarPagamentoDeVenda(c, { vendaId: r.venda.id, forma: "PIX", valorCentavos: 1, contaId: banco.id }), CODIGO.PAGAMENTOS_NAO_FECHAM);

  assert.equal(await total(nucleo, c, "RECEITA_BRUTA"), 10000);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "LANCAMENTO" })).length, 1);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "PAGAMENTO_VENDA" })).length, 2);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("estorno parcial de pagamento em dinheiro (devolução): receita preservada, dedução comercial e saída de caixa", async () => {
  const { nucleo, c, caixa } = await montarComCadastros();
  const r = await nucleo.registrarVenda(c, venda({ pagamentos: [{ forma: "DINHEIRO", valorCentavos: 10000, contaId: caixa.id }] }));
  const [pag] = r.pagamentos;
  const { documento } = await nucleo.registrarDocumento(c, { origem: "MANUAL", arquivoId: "cofre:sintetico-1", hashSha256: sha("a1"), tipo: "COMPROVANTE", recebidoEm: "2026-09-10" });
  await nucleo.vincularDocumento(c, { documentoId: documento.id, registroTipo: "PAGAMENTO_VENDA", registroId: pag.id });

  const e = await nucleo.estornarPagamentoDeVenda(c, { pagamentoId: pag.id, valorCentavos: 2500, motivo: "DEVOLUCAO_AO_CLIENTE", justificativa: "Item devolvido pelo cliente", dataEfetiva: "2026-09-12" });
  assert.deepEqual([e.estorno.alvoTipo, e.estorno.alvoId, e.estorno.valorCentavos, e.estorno.motivo], ["PAGAMENTO_VENDA", pag.id, 2500, "DEVOLUCAO_AO_CLIENTE"]);
  assert.deepEqual([e.pagamento.valorCentavos, e.pagamento.estornadoCentavos, e.pagamento.situacao], [10000, 2500, "ESTORNADO_PARCIAL"]);
  assert.deepEqual([e.venda.pagoCentavos, e.venda.devolvidoCentavos, e.venda.situacao], [7500, 2500, "ATIVA"]);
  assert.deepEqual([e.lancamento.natureza, e.lancamento.categoria, e.lancamento.classificacao, e.lancamento.valorCentavos, e.lancamento.canal], ["DEDUCAO", "DEVOLUCOES_E_ESTORNOS", "DEDUCOES_COMERCIAIS", 2500, "BALCAO"]);
  assert.deepEqual([e.movimentacao.sentido, e.movimentacao.natureza, e.movimentacao.contaId, e.movimentacao.valorCentavos, e.movimentacao.estornoId], ["SAIDA", "DEVOLUCAO", caixa.id, 2500, e.estorno.id]);

  assert.equal(await total(nucleo, c, "RECEITA_BRUTA"), 10000); // a venda original não é reescrita
  assert.equal(await total(nucleo, c, "DEDUCOES"), 2500);
  assert.equal(await total(nucleo, c, "RESULTADO_ECONOMICO"), 7500);
  assert.equal(await total(nucleo, c, "ENTRADAS_DE_CAIXA"), 10000);
  assert.equal(await total(nucleo, c, "SAIDAS_DE_CAIXA"), 2500);

  // O pagamento original, seu histórico e seu vínculo documental continuam lá; o estorno aponta para ele.
  const h = await nucleo.consultarHistorico(c, { registroTipo: "PAGAMENTO_VENDA", registroId: pag.id });
  assert.deepEqual(h.map((x) => [x.evento, x.justificativa]), [["CRIACAO", null], ["ESTORNO", "Item devolvido pelo cliente"]]);
  const vinculos = await nucleo.consultarRegistros(c, { tipo: "VINCULO_DOCUMENTAL" });
  assert.deepEqual(vinculos.map((v) => [v.documentoId, v.registroTipo, v.registroId]), [[documento.id, "PAGAMENTO_VENDA", pag.id]]);
  assert.equal((await nucleo.vincularDocumento(c, { documentoId: documento.id, registroTipo: "ESTORNO", registroId: e.estorno.id })).repetido, false);

  await rejeita(nucleo.estornarPagamentoDeVenda(c, { pagamentoId: pag.id, valorCentavos: 7501, motivo: "DEVOLUCAO_AO_CLIENTE", justificativa: "x" }), CODIGO.OPERACAO_INVALIDA); // mais que o restante
  await rejeita(nucleo.estornarPagamentoDeVenda(c, { pagamentoId: pag.id, valorCentavos: 100, motivo: "DEVOLUCAO_AO_CLIENTE" }), CODIGO.ENTRADA_INVALIDA); // sem justificativa
  // Devolver o restante zera o pagamento; nada mais a estornar.
  const fim = await nucleo.estornarPagamentoDeVenda(c, { pagamentoId: pag.id, motivo: "DEVOLUCAO_AO_CLIENTE", justificativa: "Devolução total", dataEfetiva: "2026-09-13" });
  assert.deepEqual([fim.estorno.valorCentavos, fim.pagamento.situacao, fim.venda.pagoCentavos, fim.venda.devolvidoCentavos], [7500, "ESTORNADO", 0, 10000]);
  await rejeita(nucleo.estornarPagamentoDeVenda(c, { pagamentoId: pag.id, motivo: "DEVOLUCAO_AO_CLIENTE", justificativa: "de novo" }), CODIGO.OPERACAO_INVALIDA);
  assert.equal(await total(nucleo, c, "RESULTADO_ECONOMICO"), 0);
  assert.equal(await total(nucleo, c, "VARIACAO_DE_CAIXA"), 0);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("estorno de pagamento com processador: reduz o recebível; repasse já recebido exige estornar a liquidação antes", async () => {
  const { nucleo, c, banco } = await montarComCadastros();
  const r = await nucleo.registrarVenda(c, venda({ pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 10000 }] }));
  const [pag] = r.pagamentos;

  // Correção de pagamento: lançado no processador errado. Não mexe na receita; a venda fica com valor pendente.
  const cor = await nucleo.estornarPagamentoDeVenda(c, { pagamentoId: pag.id, valorCentavos: 4000, motivo: "CORRECAO_DE_PAGAMENTO", justificativa: "Parte foi paga em vale", dataEfetiva: "2026-09-11" });
  assert.deepEqual([cor.lancamento, cor.movimentacao, cor.recebivel.saldoCentavos, cor.recebivel.ajustesCentavos], [null, null, 6000, -4000]);
  assert.deepEqual([cor.venda.pagoCentavos, cor.venda.devolvidoCentavos], [6000, 0]);
  const novo = await nucleo.registrarPagamentoDeVenda(c, { vendaId: r.venda.id, forma: "VALE", processador: "OPERADORA_BENEFICIOS", valorCentavos: 4000 });
  assert.deepEqual([novo.venda.pagoCentavos, novo.recebivel.processador, novo.recebivel.saldoCentavos], [10000, "OPERADORA_BENEFICIOS", 4000]);
  assert.equal(await total(nucleo, c, "RECEITA_BRUTA"), 10000);
  assert.equal(await total(nucleo, c, "DEDUCOES"), 0);
  assert.equal(await total(nucleo, c, "SALDO_A_RECEBER"), 10000);

  // A Stone repassa os 6.000: depois disso, devolver exige desfazer o recebimento primeiro.
  const { movimentacao } = await nucleo.registrarMovimentacao(c, entrada(banco.id, 6000));
  const { liquidacoes: [liq] } = await nucleo.registrarLiquidacao(c, { movimentacaoId: movimentacao.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: pag.recebivelId, valorCentavos: 6000 }] });
  await rejeita(nucleo.estornarPagamentoDeVenda(c, { pagamentoId: pag.id, valorCentavos: 1000, motivo: "DEVOLUCAO_AO_CLIENTE", justificativa: "Cliente contestou" }), CODIGO.ESTORNO_EXIGE_COMPENSACAO);
  await nucleo.estornarLiquidacao(c, { liquidacaoId: liq.id, valorCentavos: 1000, justificativa: "Processador descontou a contestação" });
  const dev = await nucleo.estornarPagamentoDeVenda(c, { pagamentoId: pag.id, valorCentavos: 1000, motivo: "DEVOLUCAO_AO_CLIENTE", justificativa: "Cliente contestou", dataEfetiva: "2026-09-25" });
  assert.deepEqual([dev.recebivel.saldoCentavos, dev.recebivel.liquidadoCentavos, dev.venda.pagoCentavos, dev.venda.devolvidoCentavos], [0, 5000, 9000, 1000]);
  assert.equal(await total(nucleo, c, "DEDUCOES"), 1000);
  const resultado = await nucleo.consultarComposicao(c, { indicador: "RESULTADO_ECONOMICO", competencia: "2026-09" });
  assert.equal(resultado.totalCentavos, 9000);
  assert.ok(semRepeticao(resultado));
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});
