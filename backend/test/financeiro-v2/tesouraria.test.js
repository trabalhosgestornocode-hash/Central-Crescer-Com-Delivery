// Execução 06A — Contas a pagar/receber, caixa e bancos, calendário e fluxo de caixa. Dados SINTÉTICOS.
// Data-base dos testes: 15/10/2026 (relógio fixo do cenário). Roda em memória e, com FV2_REPOSITORIO=postgres, no banco isolado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ORG_A, ORG_B, UNI_A, UNI_A2, UNI_B, ctx, entrada, montarComCadastros, obrigacao, rejeita, saida, sha } from "./helpers/cenario.js";

const doc = (nucleo, c, n, tipo = "BOLETO") => nucleo.registrarDocumento(c, { origem: "MANUAL", arquivoId: `arquivo-sintetico-${n}`, hashSha256: sha(n), tipo, recebidoEm: "2026-09-01", descricao: `Documento sintético ${n}` });
const pagar = async (nucleo, c, contaId, obrigacaoId, valor, data = "2026-09-20") => {
  const m = await nucleo.registrarMovimentacao(c, saida(contaId, valor, { dataEfetiva: data }));
  await nucleo.registrarLiquidacao(c, { movimentacaoId: m.movimentacao.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: obrigacaoId, valorCentavos: valor }] });
  return m.movimentacao;
};
const titulo = (r, id) => r.itens.find((t) => t.id === id);

test("1–4, 21 — contas a pagar: aberta, parcial, paga, vencida e sem documento; vencer não marca como paga", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const d = await doc(nucleo, c, "a1");
  const aberta = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { vencimento: "2026-10-30", descricao: "Aberta", documentoIds: [d.documento.id] }))).obrigacoes[0];
  const parcial = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { vencimento: "2026-10-25", descricao: "Parcial", documentoIds: [d.documento.id] }))).obrigacoes[0];
  const paga = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { vencimento: "2026-09-20", descricao: "Paga" }))).obrigacoes[0];
  const vencida = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { vencimento: "2026-10-01", descricao: "Vencida" }))).obrigacoes[0];
  await pagar(nucleo, c, banco.id, parcial.id, 40000);
  await pagar(nucleo, c, banco.id, paga.id, 100000);

  const r = await nucleo.consultarContasAPagar(c, {});
  assert.equal(r.dataBase, "2026-10-15");
  assert.equal(titulo(r, aberta.id).situacao, "EM_ABERTO");
  assert.deepEqual([titulo(r, parcial.id).situacao, titulo(r, parcial.id).pagoCentavos, titulo(r, parcial.id).saldoCentavos], ["PARCIALMENTE_PAGO", 40000, 60000]);
  assert.deepEqual([titulo(r, paga.id).situacao, titulo(r, paga.id).saldoCentavos], ["PAGO", 0]);
  // Vencida continua devendo o valor inteiro: o vencimento passou, mas nada foi pago.
  assert.deepEqual([titulo(r, vencida.id).situacao, titulo(r, vencida.id).saldoCentavos, titulo(r, vencida.id).pagoCentavos], ["VENCIDO", 100000, 0]);
  assert.equal(r.totais.saldoCentavos, 100000 + 60000 + 100000);
  assert.equal(r.totais.vencidoCentavos, 100000);
  assert.equal(r.totais.pagoCentavos, 140000);
  // Sem documento: só a vencida (a paga já não está em aberto) → pendência explícita, nenhum documento inventado.
  assert.deepEqual(titulo(r, vencida.id).pendencias, ["SEM_DOCUMENTO"]);
  assert.deepEqual(titulo(r, vencida.id).documentos, []);
  assert.equal(r.totais.semDocumento, 1);
  assert.equal(titulo(r, aberta.id).documentos.length, 1);
  assert.equal(titulo(r, aberta.id).documentos[0].tipo, "BOLETO");
  assert.ok(!("arquivoId" in titulo(r, aberta.id).documentos[0]), "nunca expõe o arquivo/caminho do documento");

  // Filtros: situação, período de vencimento, fornecedor e categoria.
  assert.deepEqual((await nucleo.consultarContasAPagar(c, { situacao: "VENCIDO" })).itens.map((t) => t.id), [vencida.id]);
  assert.deepEqual((await nucleo.consultarContasAPagar(c, { vencimentoDe: "2026-10-20", vencimentoAte: "2026-10-31" })).itens.map((t) => t.id), [parcial.id, aberta.id]);
  assert.equal((await nucleo.consultarContasAPagar(c, { contraparteId: fornecedor.id, categoria: "INSUMOS" })).quantidade, 4);
  await rejeita(nucleo.consultarContasAPagar(c, { vencimentoDe: "2026-10-31", vencimentoAte: "2026-10-01" }), CODIGO.DATA_INVALIDA);
  await rejeita(nucleo.consultarContasAPagar(c, { organizacaoId: ORG_B }), CODIGO.ENTRADA_INVALIDA);

  // Detalhe: obrigação → pagamento → movimentação → documento → histórico, sem segundo lançamento.
  const det = await nucleo.detalharContaAPagar(c, { id: parcial.id });
  assert.equal(det.titulo.pagamentos.length, 1);
  assert.equal(det.titulo.pagamentos[0].conta, "Banco Sintético");
  assert.equal(det.lancamento.valorCentavos, 100000);
  assert.ok(det.historico.some((h) => h.evento === "LIQUIDACAO" && h.saldoAntesCentavos === 100000 && h.saldoDepoisCentavos === 60000));
});

test("5, 29 — obrigação parcelada: um lançamento na DRE; pagar parcelas e antecipar não cria despesa", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const r = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 90001, parcelas: 3, vencimento: "2026-09-25", descricao: "Equipamento em 3x" }));
  assert.deepEqual(r.obrigacoes.map((o) => o.vencimento), ["2026-09-25", "2026-10-25", "2026-11-25"]);
  const antes = await nucleo.apurarCompetencia(c, { competencia: "2026-09" });
  await pagar(nucleo, c, banco.id, r.obrigacoes[0].id, r.obrigacoes[0].valorBaseCentavos, "2026-09-25");
  await pagar(nucleo, c, banco.id, r.obrigacoes[2].id, r.obrigacoes[2].valorBaseCentavos, "2026-10-10"); // antecipada
  const depois = await nucleo.apurarCompetencia(c, { competencia: "2026-09" });
  assert.equal(depois.indicadores.CUSTOS_OPERACIONAIS.valorCentavos, antes.indicadores.CUSTOS_OPERACIONAIS.valorCentavos);
  assert.equal(depois.indicadores.CUSTOS_OPERACIONAIS.valorCentavos, -90001);
  assert.equal((await nucleo.apurarCompetencia(c, { competencia: "2026-10" })).indicadores.CUSTOS_OPERACIONAIS.valorCentavos, null, "pagar em outubro não cria custo em outubro");
  const det = await nucleo.detalharContaAPagar(c, { id: r.obrigacoes[1].id });
  assert.deepEqual(det.parcelas.map((p) => p.situacao), ["PAGO", "EM_ABERTO", "PAGO"]);
  assert.deepEqual(det.parcelas.map((p) => p.parcela.numero), [1, 2, 3]);
  assert.equal(det.parcelas.reduce((s, p) => s + p.valorOriginalCentavos, 0), 90001);
  const lista = await nucleo.consultarContasAPagar(c, {});
  assert.equal(lista.totais.saldoCentavos, r.obrigacoes[1].valorBaseCentavos);
});

test("6, 19 — recorrência sem duplicidade e calendário navegável do mês", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const aluguel = (vencimento, competencia, id) => obrigacao(fornecedor.id, { valorOriginalCentavos: 250000, categoria: "DESPESAS_ADMINISTRATIVAS_GERAIS", descricao: "Aluguel", competencia, dataEmissao: `${competencia}-01`, vencimento, recorrencia: { periodicidade: "MENSAL", diaDoMes: 10 }, fonte: { sistema: "MANUAL", idExterno: id } });
  const set = (await nucleo.registrarObrigacao(c, aluguel("2026-09-10", "2026-09", "AL-09"))).obrigacoes[0];
  await pagar(nucleo, c, banco.id, set.id, 250000, "2026-09-10");
  // Outubro já tem a obrigação real: a recorrência NÃO projeta outro aluguel em outubro.
  const out = (await nucleo.registrarObrigacao(c, aluguel("2026-10-10", "2026-10", "AL-10"))).obrigacoes[0];

  const cal = await nucleo.consultarCalendarioFinanceiro(c, { mes: "2026-10" });
  assert.equal(cal.dias.length, 31);
  const dia10 = cal.dias.find((x) => x.data === "2026-10-10");
  assert.deepEqual([dia10.vencidas.quantidade, dia10.vencidas.saldoCentavos, dia10.recorrentesPrevistas.quantidade], [1, 250000, 0]);
  assert.equal(dia10.titulos[0].id, out.id);
  assert.equal(dia10.titulos[0].recorrente, true);
  assert.equal(cal.dias.find((x) => x.data === "2026-10-15").hoje, true);
  const nov = await nucleo.consultarCalendarioFinanceiro(c, { mes: "2026-11" });
  const n10 = nov.dias.find((x) => x.data === "2026-11-10");
  assert.deepEqual([n10.recorrentesPrevistas.quantidade, n10.recorrentesPrevistas.valorCentavos, n10.aVencer.quantidade], [1, 250000, 0]);
  assert.equal(nov.totais.recorrentePrevistoCentavos, 250000);
  const setembro = await nucleo.consultarCalendarioFinanceiro(c, { mes: "2026-09" });
  assert.deepEqual([setembro.dias[9].pagas.quantidade, setembro.dias[9].pagas.valorCentavos, setembro.totais.recorrentePrevistoCentavos], [1, 250000, 0]);
  // Repetir o registro da mesma origem não duplica nada; a DRE de outubro tem UM aluguel.
  await nucleo.registrarObrigacao(c, aluguel("2026-10-10", "2026-10", "AL-10"));
  assert.equal((await nucleo.consultarContasAPagar(c, { competencia: "2026-10" })).quantidade, 1);
  assert.equal((await nucleo.apurarCompetencia(c, { competencia: "2026-10" })).indicadores.DESPESAS_OPERACIONAIS.valorCentavos, -250000);
  // O fluxo previsto de novembro inclui a recorrência como ESTIMADA (projeção parcial).
  const fluxo = await nucleo.consultarFluxoDeCaixa(c, { inicio: "2026-11-01", fim: "2026-11-30", granularidade: "MES" });
  assert.equal(fluxo.previsto.porNatureza.RECORRENCIA_PREVISTA, -250000);
  assert.ok(fluxo.projecao.motivos.includes("INCLUI_RECORRENCIAS_ESTIMADAS"));
});

test("7–10, 20 — contas a receber: pendente, parcial, sem previsão, repasse agrupado e divergência", async () => {
  const { nucleo, c, banco } = await montarComCadastros();
  const dr = await doc(nucleo, c, "r1", "DEMONSTRATIVO_REPASSE");
  const venda = (id, canal, valor, processador) => nucleo.registrarVenda(c, { canal, dataVenda: "2026-09-10", brutoCentavos: valor, fonte: { sistema: "MANUAL", idExterno: id }, pagamentos: [{ forma: "CREDITO", processador, valorCentavos: valor }] });
  const semPrevisao = (await venda("V1", "BALCAO", 30000, "STONE")).recebiveis[0];
  const r1 = (await venda("V2", "IFOOD", 50000, "IFOOD")).recebiveis[0];
  const r2 = (await venda("V3", "IFOOD", 20000, "IFOOD")).recebiveis[0];
  // Repasse avulso com previsão DOCUMENTADA (demonstrativo) e retenção.
  const repasse = (await nucleo.registrarRecebivel(c, { processador: "IFOOD", canal: "IFOOD", brutoCentavos: 80000, retencoes: [{ categoria: "COMISSOES_IFOOD", valorCentavos: 9600 }], dataPrevista: "2026-10-20", competencia: "2026-09", documentoIds: [dr.documento.id] })).recebivel;
  const atrasado = (await nucleo.registrarRecebivel(c, { processador: "ANOTA_AI", brutoCentavos: 5000, dataPrevista: "2026-10-01", competencia: "2026-09", documentoIds: [dr.documento.id] })).recebivel;

  // Repasse agrupado: UMA entrada liquida dois recebíveis.
  const e = await nucleo.registrarMovimentacao(c, entrada(banco.id, 70000, { dataEfetiva: "2026-10-05" }));
  await nucleo.registrarLiquidacao(c, { movimentacaoId: e.movimentacao.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: r1.id, valorCentavos: 50000 }, { alvoTipo: "RECEBIVEL", alvoId: r2.id, valorCentavos: 20000 }] });
  // Parcial: metade do repasse avulso.
  const e2 = await nucleo.registrarMovimentacao(c, entrada(banco.id, 30000, { dataEfetiva: "2026-10-08" }));
  await nucleo.registrarLiquidacao(c, { movimentacaoId: e2.movimentacao.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: repasse.id, valorCentavos: 30000 }] });
  // Divergência: o processador pagou menos que o esperado e a diferença foi registrada (não resolvida).
  const div = (await venda("V4", "BALCAO", 10000, "STONE")).recebiveis[0];
  const e3 = await nucleo.registrarMovimentacao(c, entrada(banco.id, 9500, { dataEfetiva: "2026-10-09" }));
  const corr = await nucleo.criarCorrespondenciaCandidata(c, { ladoA: [{ tipo: "RECEBIVEL", id: div.id, valorCentavos: 10000 }], ladoB: [{ tipo: "MOVIMENTACAO", id: e3.movimentacao.id, valorCentavos: 9500 }] });
  await nucleo.registrarDivergencia(c, { correspondenciaId: corr.id, justificativa: "Valor recebido menor que o esperado (sintético)." });

  const r = await nucleo.consultarContasAReceber(c, {});
  assert.equal(titulo(r, semPrevisao.id).situacao, "SEM_PREVISAO_CONFIAVEL");
  assert.equal(titulo(r, semPrevisao.id).vencimentoPrevisto, null, "data de repasse Stone não é presumida");
  assert.equal(titulo(r, semPrevisao.id).tipo, "RECEBIVEL_DE_OPERADORA");
  assert.equal(titulo(r, semPrevisao.id).devedor.nome, "STONE");
  assert.deepEqual([titulo(r, r1.id).situacao, titulo(r, r1.id).dataDeLiquidacao, titulo(r, r2.id).situacao], ["RECEBIDO", "2026-10-05", "RECEBIDO"]);
  assert.equal(titulo(r, r1.id).recebimentos[0].titulosNaMesmaMovimentacao, 2);
  const rp = titulo(r, repasse.id);
  assert.deepEqual([rp.tipo, rp.situacao, rp.valorOriginalCentavos, rp.deducoesCentavos, rp.esperadoCentavos, rp.recebidoCentavos, rp.saldoCentavos], ["REPASSE", "PARCIALMENTE_RECEBIDO", 80000, 9600, 70400, 30000, 40400]);
  assert.equal(rp.composicao.retencoes[0].nome, "Comissões iFood");
  assert.equal(titulo(r, atrasado.id).situacao, "ATRASADO");
  assert.equal(titulo(r, div.id).situacao, "EM_DIVERGENCIA");
  assert.equal(r.totais.semPrevisaoCentavos, 30000);
  assert.equal(r.totais.comPrevisaoCentavos, 40400);
  assert.equal(r.totais.emDivergenciaCentavos, 10000);
  assert.equal(r.totais.porTipo.REPASSE.saldoCentavos, 40400 + 5000);
  // Filtros por processador e tipo.
  assert.equal((await nucleo.consultarContasAReceber(c, { processador: "STONE" })).quantidade, 2);
  assert.deepEqual((await nucleo.consultarContasAReceber(c, { tipo: "REPASSE", situacao: "ATRASADO" })).itens.map((t) => t.id), [atrasado.id]);

  // O movimento bancário do repasse agrupado aparece com o vínculo aos dois títulos.
  const cb = await nucleo.consultarCaixaEBancos(c, { inicio: "2026-10-01", fim: "2026-10-15" });
  const mov = cb.movimentos.find((m) => m.id === e.movimentacao.id);
  assert.equal(mov.vinculo.tipo, "RECEBIMENTO_DE_TITULO");
  assert.equal(mov.vinculo.agrupado, true);
  assert.equal(mov.titulo, "Repasse agrupado — 2 títulos");
});

test("11, 15, 22 — saldo bancário: âncora informada, transferência interna e movimento sem vínculo não viram receita/despesa", async () => {
  const { nucleo, c, banco, caixa, fornecedor } = await montarComCadastros();
  // Sem saldo informado o saldo é DESCONHECIDO (não zero), mesmo com movimentações.
  await nucleo.registrarMovimentacao(c, entrada(banco.id, 12345, { dataEfetiva: "2026-10-02", natureza: "OUTRA", descricao: "CRED TED 000123 SINTETICO" }));
  let cb = await nucleo.consultarCaixaEBancos(c, { inicio: "2026-10-01", fim: "2026-10-15" });
  assert.equal(cb.contas.find((x) => x.id === banco.id).saldoFinalCentavos, null);
  assert.equal(cb.contas.find((x) => x.id === banco.id).situacaoDoSaldo, "DESCONHECIDO");
  assert.equal(cb.consolidado.saldoBancarioCentavos, null);

  const extrato = await doc(nucleo, c, "e1", "EXTRATO_BANCARIO");
  await nucleo.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-10-01", valorCentavos: 100000, documentoId: extrato.documento.id });
  await nucleo.registrarSaldoDeConta(c, { contaId: caixa.id, data: "2026-10-01", valorCentavos: 20000 });
  await rejeita(nucleo.registrarSaldoDeConta(c, { contaId: caixa.id, data: "2026-10-02", valorCentavos: -1 }), CODIGO.VALOR_INVALIDO);
  const o = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { vencimento: "2026-10-03" }))).obrigacoes[0];
  await pagar(nucleo, c, banco.id, o.id, 30000, "2026-10-03");
  await nucleo.registrarTransferencia(c, { contaOrigemId: caixa.id, contaDestinoId: banco.id, valorCentavos: 15000, dataEfetiva: "2026-10-04", descricao: "Depósito do caixa" });
  await nucleo.registrarMovimentacao(c, saida(banco.id, 990, { dataEfetiva: "2026-10-05", natureza: "OUTRA", descricao: "DEB TAR PACOTE SINT" }));

  cb = await nucleo.consultarCaixaEBancos(c, { inicio: "2026-10-01", fim: "2026-10-15" });
  const b = cb.contas.find((x) => x.id === banco.id);
  const cx = cb.contas.find((x) => x.id === caixa.id);
  assert.deepEqual([b.saldoInicialCentavos, b.entradasCentavos, b.saidasCentavos, b.saldoFinalCentavos], [100000, 12345 + 15000, 30000 + 990, 100000 + 12345 + 15000 - 30000 - 990]);
  assert.deepEqual([cx.saldoInicialCentavos, cx.saldoFinalCentavos, cx.transferenciasEnviadasCentavos], [20000, 5000, 15000]);
  assert.equal(b.saldoInformado.documentos[0].tipo, "EXTRATO_BANCARIO");
  // Consolidado: as duas pernas da transferência se anulam.
  assert.equal(cb.consolidado.entradasCentavos, 12345);
  assert.equal(cb.consolidado.saidasCentavos, 30990);
  assert.equal(cb.consolidado.transferenciasInternasCentavos, 15000);
  assert.equal(cb.consolidado.saldoFinalCentavos, b.saldoFinalCentavos + cx.saldoFinalCentavos);
  assert.equal(cb.consolidado.saldoInicialCentavos + cb.consolidado.entradasCentavos - cb.consolidado.saidasCentavos, cb.consolidado.saldoFinalCentavos);
  // Movimento sem vínculo fica pendente — nunca vira receita ou despesa pelo sinal.
  const semVinculo = cb.movimentos.filter((m) => m.pendencias.includes("SEM_VINCULO"));
  assert.equal(semVinculo.length, 2);
  assert.equal(semVinculo.find((m) => m.sentido === "SAIDA").titulo, "Saída sem vínculo identificado");
  assert.equal(semVinculo.find((m) => m.sentido === "SAIDA").descricaoOriginal, "DEB TAR PACOTE SINT");
  assert.equal(cb.movimentos.find((m) => m.vinculo.tipo === "TRANSFERENCIA_INTERNA" && m.sentido === "ENTRADA").titulo, "Transferência de Caixa da loja");
  assert.equal(cb.movimentos.find((m) => m.vinculo.tipo === "PAGAMENTO_DE_OBRIGACAO").titulo, "Pagamento — Fornecedor Sintético · Compra sintética");
  // Só a obrigação (competência de setembro) gera resultado; entradas, tarifa sem vínculo e transferência de outubro não.
  assert.equal((await nucleo.apurarCompetencia(c, { competencia: "2026-09" })).indicadores.RESULTADO_GERENCIAL.valorCentavos, -100000);
  assert.equal((await nucleo.apurarCompetencia(c, { competencia: "2026-10" })).indicadores.RESULTADO_GERENCIAL.valorCentavos, null);
  // Conciliação de saldos: um segundo saldo informado é comparado com o calculado; a diferença só é mostrada.
  await nucleo.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-10-10", valorCentavos: 96000 });
  const b2 = (await nucleo.consultarCaixaEBancos(c, { inicio: "2026-10-01", fim: "2026-10-15" })).contas.find((x) => x.id === banco.id);
  assert.deepEqual(b2.conferenciasDeSaldo.map((x) => [x.calculadoCentavos, x.diferencaCentavos]), [[96355, -355]]);
  assert.equal(b2.saldoFinalCentavos, 96000);
  // Saldo informado é idempotente por conta e dia; valor diferente no mesmo dia é conflito.
  await rejeita(nucleo.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-10-10", valorCentavos: 1 }), CODIGO.CONFLITO_IDEMPOTENCIA);
});

test("12–14 — caixa físico: abertura, entradas, sangria para o banco, fechamento com diferença sem ajuste automático", async () => {
  const { nucleo, c, banco, caixa } = await montarComCadastros();
  await rejeita(nucleo.abrirCaixa(c, { contaId: banco.id, dataAbertura: "2026-10-14", saldoContadoCentavos: 0 }), CODIGO.OPERACAO_INVALIDA);
  const { sessao } = await nucleo.abrirCaixa(c, { contaId: caixa.id, dataAbertura: "2026-10-14", saldoContadoCentavos: 20000 });
  await rejeita(nucleo.abrirCaixa(c, { contaId: caixa.id, dataAbertura: "2026-10-15", saldoContadoCentavos: 0 }), CODIGO.OPERACAO_INVALIDA);
  // Venda em dinheiro entra no caixa como movimentação; NÃO substitui a contagem.
  await nucleo.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-10-14", brutoCentavos: 8000, fonte: { sistema: "MANUAL", idExterno: "VD-1" }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 8000, contaId: caixa.id }] });
  await nucleo.registrarOperacaoDeCaixa(c, { sessaoId: sessao.id, operacao: "SUPRIMENTO", valorCentavos: 5000, data: "2026-10-14", descricao: "Troco" });
  await nucleo.registrarOperacaoDeCaixa(c, { sessaoId: sessao.id, operacao: "SAIDA", valorCentavos: 1500, data: "2026-10-14", descricao: "Gás" });
  const sangria = await nucleo.registrarOperacaoDeCaixa(c, { sessaoId: sessao.id, operacao: "SANGRIA", valorCentavos: 20000, data: "2026-10-15", descricao: "Depósito no banco", contraContaId: banco.id });
  assert.ok(sangria.operacao.transferenciaId && !sangria.operacao.movimentacaoId, "sangria para o banco é transferência interna");
  await rejeita(nucleo.registrarOperacaoDeCaixa(c, { sessaoId: sessao.id, operacao: "ENTRADA", valorCentavos: 1, data: "2026-10-15", descricao: "x", contraContaId: banco.id }), CODIGO.ENTRADA_INVALIDA);
  // Teórico = 200,00 + 80,00 + 50,00 − 15,00 − 200,00 = 115,00. Contado 110,00 → diferença −5,00 exige justificativa.
  await rejeita(nucleo.fecharCaixa(c, { sessaoId: sessao.id, dataFechamento: "2026-10-15", contadoCentavos: 11000, confirmar: true }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(nucleo.fecharCaixa(c, { sessaoId: sessao.id, dataFechamento: "2026-10-15", contadoCentavos: 11000, justificativa: "x" }), CODIGO.ENTRADA_INVALIDA);
  const f = await nucleo.fecharCaixa(c, { sessaoId: sessao.id, dataFechamento: "2026-10-15", contadoCentavos: 11000, justificativa: "Diferença de troco (sintético).", confirmar: true });
  assert.deepEqual([f.teoricoCentavos, f.contadoCentavos, f.diferencaCentavos], [11500, 11000, -500]);
  await rejeita(nucleo.registrarOperacaoDeCaixa(c, { sessaoId: sessao.id, operacao: "ENTRADA", valorCentavos: 100, data: "2026-10-15", descricao: "Depois" }), CODIGO.OPERACAO_INVALIDA);
  await rejeita(nucleo.fecharCaixa(c, { sessaoId: sessao.id, dataFechamento: "2026-10-15", contadoCentavos: 11500, confirmar: true }), CODIGO.OPERACAO_INVALIDA);

  const cb = await nucleo.consultarCaixaEBancos(c, { inicio: "2026-10-14", fim: "2026-10-15", contaId: caixa.id });
  const s = cb.contas[0].sessoesDeCaixa[0];
  assert.deepEqual([s.situacao, s.teoricoCentavos, s.contadoCentavos, s.diferencaCentavos, s.alteradaAposFechamento, s.operacoes.length], ["FECHADA", 11500, 11000, -500, false, 3]);
  // Sem saldo informado do caixa, o saldo da CONTA continua desconhecido: a contagem da sessão não vira ajuste.
  assert.equal(cb.contas[0].saldoFinalCentavos, null);
  assert.equal(cb.movimentos.filter((m) => m.vinculo.tipo === "SEM_VINCULO").length, 2, "suprimento e gás sem destino ficam pendentes de classificação");
  // Nenhum lançamento econômico novo além da venda.
  const dre = await nucleo.apurarCompetencia(c, { competencia: "2026-10" });
  assert.equal(dre.indicadores.RESULTADO_GERENCIAL.valorCentavos, 8000);
  // Nova sessão só depois do fechamento.
  await rejeita(nucleo.abrirCaixa(c, { contaId: caixa.id, dataAbertura: "2026-10-15", saldoContadoCentavos: 11000 }), CODIGO.DATA_INVALIDA);
});

test("16–18 — fluxo realizado, previsto e saldo projetado sem duplicação; transferência se anula", async () => {
  const { nucleo, c, banco, caixa, fornecedor } = await montarComCadastros();
  const dr = await doc(nucleo, c, "f1", "DEMONSTRATIVO_REPASSE");
  await nucleo.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-10-01", valorCentavos: 50000 });
  await nucleo.registrarSaldoDeConta(c, { contaId: caixa.id, data: "2026-10-01", valorCentavos: 10000 });
  const o = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 40000, vencimento: "2026-10-20", competencia: "2026-10", dataEmissao: "2026-10-01" }))).obrigacoes[0];
  await pagar(nucleo, c, banco.id, o.id, 15000, "2026-10-10"); // parcial: realizado 150,00; previsto só o saldo 250,00
  const vencida = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 7000, vencimento: "2026-10-05", competencia: "2026-10", dataEmissao: "2026-10-01" }))).obrigacoes[0];
  await nucleo.registrarRecebivel(c, { processador: "IFOOD", canal: "IFOOD", brutoCentavos: 30000, dataPrevista: "2026-10-22", competencia: "2026-10", documentoIds: [dr.documento.id] });
  await nucleo.registrarRecebivel(c, { processador: "STONE", brutoCentavos: 9000, competencia: "2026-10" }); // sem previsão
  await nucleo.registrarMovimentacao(c, entrada(banco.id, 2000, { dataEfetiva: "2026-10-12" }));
  await nucleo.registrarTransferencia(c, { contaOrigemId: caixa.id, contaDestinoId: banco.id, valorCentavos: 6000, dataEfetiva: "2026-10-13" });

  const f = await nucleo.consultarFluxoDeCaixa(c, { inicio: "2026-10-01", fim: "2026-10-31", granularidade: "SEMANA" });
  assert.deepEqual([f.saldoInicialCentavos, f.saldoAtualCentavos], [60000, 60000 - 15000 + 2000]);
  assert.deepEqual([f.realizado.entradasCentavos, f.realizado.saidasCentavos, f.realizado.transferenciasInternasAnuladasCentavos], [2000, 15000, 6000]);
  assert.equal(f.realizado.saldoFinalCentavos, f.saldoAtualCentavos);
  assert.deepEqual([f.previsto.entradasCentavos, f.previsto.saidasCentavos], [30000, 25000 + 7000]);
  const venc = f.previsto.itens.find((i) => i.registroId === vencida.id);
  assert.deepEqual([venc.data, venc.natureza, venc.vencimentoOriginal], ["2026-10-15", "CONTA_VENCIDA_EM_ABERTO", "2026-10-05"]);
  assert.equal(f.previsto.itens.find((i) => i.registroId === o.id).valorCentavos, 25000, "previsto usa só o saldo: o parcial pago não conta de novo");
  assert.equal(f.projecao.saldoProjetadoCentavos, 47000 + 30000 - 32000);
  assert.equal(f.projecao.parcial, true);
  assert.deepEqual(f.projecao.motivos, ["RECEBIVEIS_SEM_PREVISAO_CONFIAVEL"]);
  assert.equal(f.semPrevisao.saldoCentavos, 9000);
  // Série semanal: semanas passadas só realizado; semana atual tem os dois; projetado separado do disponível.
  const atual = f.serie.find((s) => s.tipo === "ATUAL");
  assert.ok(atual.inicio <= "2026-10-15" && atual.fim >= "2026-10-15");
  assert.equal(f.serie[0].saldoProjetadoCentavos, null);
  assert.equal(atual.saldoRealizadoCentavos, f.saldoAtualCentavos, "no período atual o saldo disponível é o de hoje");
  assert.equal(f.serie[f.serie.length - 1].saldoProjetadoCentavos, f.projecao.saldoProjetadoCentavos);
  assert.equal(f.serie[f.serie.length - 1].saldoRealizadoCentavos, null, "o futuro não tem saldo disponível, só projetado");
  // Por dia e período personalizado.
  const dia = await nucleo.consultarFluxoDeCaixa(c, { inicio: "2026-10-10", fim: "2026-10-12", granularidade: "DIA" });
  assert.deepEqual(dia.serie.map((s) => s.realizado.saidasCentavos - s.realizado.entradasCentavos), [15000, 0, -2000]);
  assert.equal(dia.projecao.aplicavel, false);
  assert.deepEqual([dia.projecao.parcial, dia.projecao.motivos], [false, []], "período passado não tem projeção, logo não é parcial");
  await rejeita(nucleo.consultarFluxoDeCaixa(c, { inicio: "2026-01-01", fim: "2027-12-31" }), CODIGO.DATA_INVALIDA);
  // Sem saldo informado em alguma conta → saldo desconhecido, projeção parcial (nunca zero).
  const { nucleo: n2, c: c2 } = await montarComCadastros();
  const vazio = await n2.consultarFluxoDeCaixa(c2, { inicio: "2026-10-01", fim: "2026-10-31", granularidade: "MES" });
  assert.equal(vazio.saldoAtualCentavos, null);
  assert.equal(vazio.projecao.saldoProjetadoCentavos, null);
  assert.ok(vazio.projecao.motivos.includes("SALDO_DISPONIVEL_DESCONHECIDO"));
});

test("23–25 — isolamento por organização/unidade, permissões de leitura e escrita, competência homologada", async () => {
  const { nucleo, c, caixa, fornecedor } = await montarComCadastros();
  await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id));
  // Outra unidade e outra organização não veem os títulos da unidade A.
  assert.equal((await nucleo.consultarContasAPagar(ctx(ORG_A, UNI_A2), {})).quantidade, 0);
  assert.equal((await nucleo.consultarContasAPagar(ctx(ORG_B, UNI_B), {})).quantidade, 0);
  await rejeita(nucleo.detalharContaAPagar(ctx(ORG_A, UNI_A2), { id: (await nucleo.consultarContasAPagar(c, {})).itens[0].id }), CODIGO.NAO_ENCONTRADO);
  await rejeita(nucleo.consultarContasAPagar(ctx("dddddddd-0000-4000-8000-000000000009", UNI_A), {}), CODIGO.ESCOPO_NAO_AUTORIZADO);
  // Só leitura: consulta sim, escrita não.
  const leitor = ctx(ORG_A, UNI_A, ["financeiro_v2.ver"]);
  assert.equal((await nucleo.consultarContasAPagar(leitor, {})).quantidade, 1);
  await rejeita(nucleo.abrirCaixa(leitor, { contaId: caixa.id, dataAbertura: "2026-10-14", saldoContadoCentavos: 0 }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(nucleo.registrarSaldoDeConta(leitor, { contaId: caixa.id, data: "2026-10-01", valorCentavos: 0 }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(nucleo.consultarFluxoDeCaixa(ctx(ORG_A, UNI_A, ["financeiro_v2.registrar"]), { inicio: "2026-10-01", fim: "2026-10-31" }), CODIGO.PERMISSAO_INSUFICIENTE);
  // Competência homologada: consulta mostra a marca; abrir caixa naquele mês é recusado.
  await nucleo.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_PRELIMINAR" });
  await nucleo.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Sintética." });
  assert.equal((await nucleo.consultarContasAPagar(c, {})).itens[0].competenciaHomologada, true);
  await rejeita(nucleo.abrirCaixa(c, { contaId: caixa.id, dataAbertura: "2026-09-30", saldoContadoCentavos: 0 }), CODIGO.COMPETENCIA_HOMOLOGADA);
});

test("28, 30 — resumo da Visão Geral usa as mesmas consultas; desconhecido nunca vira zero", async () => {
  const { nucleo, c, banco, caixa, fornecedor } = await montarComCadastros();
  let r = await nucleo.consultarResumoFinanceiro(c, { competencia: "2026-10" });
  assert.deepEqual([r.saldoBancario.valorCentavos, r.saldoBancario.situacao, r.saldoCaixaFisico.situacao], [null, "DESCONHECIDO", "DESCONHECIDO"]);
  assert.deepEqual([r.contasAPagar.situacao, r.contasAPagar.saldoCentavos, r.contasAReceber.saldoCentavos], ["SEM_REGISTROS", null, null]);
  assert.equal(r.fluxoDeCaixa.saldoProjetado30DiasCentavos, null);

  await nucleo.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-10-01", valorCentavos: 70000 });
  await nucleo.registrarSaldoDeConta(c, { contaId: caixa.id, data: "2026-10-01", valorCentavos: 0 });
  const o = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { vencimento: "2026-10-01" }))).obrigacoes[0];
  await pagar(nucleo, c, banco.id, o.id, 10000, "2026-10-02");
  r = await nucleo.consultarResumoFinanceiro(c, { competencia: "2026-10" });
  const cb = await nucleo.consultarCaixaEBancos(c, { inicio: "2026-10-15", fim: "2026-10-15" });
  const ap = await nucleo.consultarContasAPagar(c, {});
  const fl = await nucleo.consultarFluxoDeCaixa(c, { inicio: "2026-10-01", fim: "2026-10-31", granularidade: "MES" });
  assert.equal(r.saldoBancario.valorCentavos, cb.consolidado.saldoBancarioCentavos);
  assert.equal(r.saldoBancario.valorCentavos, 60000);
  assert.deepEqual([r.saldoCaixaFisico.valorCentavos, r.saldoCaixaFisico.situacao], [0, "CALCULADO"], "zero só quando calculado a partir de saldo informado");
  assert.deepEqual([r.contasAPagar.saldoCentavos, r.contasAPagar.vencidoCentavos], [ap.totais.saldoCentavos, ap.totais.vencidoCentavos]);
  assert.equal(r.fluxoDeCaixa.realizadoNaCompetencia.saidasCentavos, fl.realizado.saidasCentavos);
  assert.equal(r.contasAReceber.situacao, "SEM_REGISTROS");
  // A Visão Geral econômica (Execução 05) não muda com a tesouraria.
  const vg = await nucleo.apurarVisaoGeral(c, { competencia: "2026-09" });
  assert.equal(vg.resultadoGerencial.valorCentavos, -100000);
});

test("26 — paginação controlada e listas grandes", async () => {
  const { nucleo, c, fornecedor } = await montarComCadastros();
  for (let i = 0; i < 7; i += 1) await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 1000 + i, vencimento: `2026-10-${String(20 + i).padStart(2, "0")}`, descricao: `Título ${i}` }));
  const p2 = await nucleo.consultarContasAPagar(c, { pagina: 2, tamanho: 3 });
  assert.deepEqual([p2.paginacao.total, p2.paginacao.paginas, p2.itens.length, p2.itens[0].descricao], [7, 3, 3, "Título 3"]);
  assert.equal(p2.totais.saldoCentavos, 7021, "totais cobrem o conjunto filtrado, não só a página");
  await rejeita(nucleo.consultarContasAPagar(c, { tamanho: 1000 }), CODIGO.ENTRADA_INVALIDA);
});
