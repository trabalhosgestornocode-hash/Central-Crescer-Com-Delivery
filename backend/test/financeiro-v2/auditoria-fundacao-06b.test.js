// Execução 06B — Fase A: auditoria da fundação da 06A (saldo de referência, classificação provisória, recorrências).
// Dados SINTÉTICOS. Data-base dos testes: 15/10/2026. Roda em memória e, com FV2_REPOSITORIO=postgres, no banco isolado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ctx, entrada, montarComCadastros, obrigacao, rejeita, saida } from "./helpers/cenario.js";
import { PERIODO_SETEMBRO, unicredExtrato } from "./helpers/arquivos.js";

const conta = (r, id) => r.contas.find((x) => x.id === id);

test("A.1 — saldo de FIM do dia já contém os movimentos do dia: nada é somado duas vezes", async () => {
  const { nucleo, c, banco } = await montarComCadastros();
  await nucleo.registrarMovimentacao(c, entrada(banco.id, 20000, { dataEfetiva: "2026-09-10" }));
  await nucleo.registrarMovimentacao(c, entrada(banco.id, 5000, { dataEfetiva: "2026-09-11" }));
  // "Saldo final de 10/09 = R$ 1.000,00" — o extrato já inclui os R$ 200,00 do dia 10.
  await nucleo.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-09-10", referencia: "FIM_DO_DIA", valorCentavos: 100000 });
  const r = await nucleo.consultarCaixaEBancos(c, { inicio: "2026-09-11", fim: "2026-09-11" });
  const b = conta(r, banco.id);
  assert.equal(b.saldoInicialCentavos, 100000, "início de 11/09 = fim de 10/09, sem somar de novo os R$ 200,00");
  assert.equal(b.saldoFinalCentavos, 105000);
  assert.deepEqual([b.saldoInformado.data, b.saldoInformado.referencia], ["2026-09-10", "FIM_DO_DIA"]);
  // A MESMA data como INÍCIO do dia significaria outro ponto do tempo: os R$ 200,00 do dia 10 viriam depois dele.
  const outra = await montarComCadastros();
  await outra.nucleo.registrarMovimentacao(outra.c, entrada(outra.banco.id, 20000, { dataEfetiva: "2026-09-10" }));
  await outra.nucleo.registrarSaldoDeConta(outra.c, { contaId: outra.banco.id, data: "2026-09-10", valorCentavos: 100000 });
  assert.equal(conta(await outra.nucleo.consultarCaixaEBancos(outra.c, { inicio: "2026-09-11", fim: "2026-09-11" }), outra.banco.id).saldoInicialCentavos, 120000);
  // Período que começa ANTES da referência: o saldo inicial é desconhecido (não presumido), o final é conhecido.
  const antes = conta(await nucleo.consultarCaixaEBancos(c, { inicio: "2026-09-05", fim: "2026-09-11" }), banco.id);
  assert.deepEqual([antes.saldoInicialCentavos, antes.saldoFinalCentavos], [null, 105000]);
});

test("A.1 — extrato com saldo anterior e saldo final: movimentos do extrato contam uma vez; atrasado e anterior sem duplicidade", async () => {
  const { nucleo, c, banco } = await montarComCadastros();
  // Extrato de setembro: saldo anterior 01/09 (início) = 5.000,00; três movimentos; saldo final 30/09 (fim) = 5.000 + 300 − 100 + 50.
  await nucleo.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-09-01", valorCentavos: 500000 });
  await nucleo.registrarMovimentacao(c, entrada(banco.id, 30000, { dataEfetiva: "2026-09-01" }));
  await nucleo.registrarMovimentacao(c, saida(banco.id, 10000, { dataEfetiva: "2026-09-15" }));
  await nucleo.registrarMovimentacao(c, entrada(banco.id, 5000, { dataEfetiva: "2026-09-30" }));
  await nucleo.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-09-30", referencia: "FIM_DO_DIA", valorCentavos: 525000 });
  // Saldo anterior de 01/10 informado por outro extrato: mesmo ponto do tempo que o final de 30/09.
  await nucleo.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-10-01", valorCentavos: 525000 });
  let b = conta(await nucleo.consultarCaixaEBancos(c, { inicio: "2026-09-01", fim: "2026-09-30" }), banco.id);
  assert.deepEqual(b.conferenciasDeSaldo.map((x) => [x.situacao, x.diferencaCentavos, x.movimentosConsiderados]), [["CONFERE", 0, 3], ["CONFERE", 0, 0]]);
  assert.equal(b.saldoFinalCentavos, 525000, "o saldo final informado prevalece e os movimentos de 30/09 não entram de novo");
  assert.equal(b.saldosDivergentes, 0);
  // Movimento com data ANTERIOR à primeira referência: já está no saldo anterior; não muda nenhum saldo.
  await nucleo.registrarMovimentacao(c, entrada(banco.id, 7000, { dataEfetiva: "2026-08-31" }));
  // Lançamento ATRASADO (registrado agora, data 20/09) que o extrato não tinha: entra uma vez e vira divergência visível.
  await nucleo.registrarMovimentacao(c, saida(banco.id, 1234, { dataEfetiva: "2026-09-20" }));
  const r = await nucleo.consultarCaixaEBancos(c, { inicio: "2026-09-01", fim: "2026-10-10" });
  b = conta(r, banco.id);
  assert.equal(b.movimentosAnterioresAReferencia, 1);
  assert.equal(b.saldoInicialCentavos, 500000, "o movimento de 31/08 não é somado ao saldo anterior de 01/09");
  const [setembro, virada] = b.conferenciasDeSaldo;
  assert.deepEqual([setembro.situacao, setembro.calculadoCentavos, setembro.diferencaCentavos], ["DIVERGENTE", 525000 - 1234, 1234]);
  assert.equal(virada.situacao, "CONFERE");
  // Depois da referência mais recente, o saldo parte DELA: o atrasado de setembro não contamina outubro.
  assert.equal(b.saldoFinalCentavos, 525000);
  assert.equal(r.pendencias.saldosDivergentes, 1);
});

test("A.1 — regras do saldo informado: fim de hoje recusado; início e fim na mesma data convivem; nada é reescrito", async () => {
  const { nucleo, c, banco } = await montarComCadastros();
  await rejeita(nucleo.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-10-15", referencia: "FIM_DO_DIA", valorCentavos: 1 }), CODIGO.DATA_INVALIDA);
  await rejeita(nucleo.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-10-01", referencia: "MEIO_DO_DIA", valorCentavos: 1 }), CODIGO.ENTRADA_INVALIDA);
  await nucleo.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-10-01", valorCentavos: 1000 });
  await nucleo.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-10-01", referencia: "FIM_DO_DIA", valorCentavos: 1500 });
  await rejeita(nucleo.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-10-01", referencia: "FIM_DO_DIA", valorCentavos: 9999 }), CODIGO.CONFLITO_IDEMPOTENCIA);
  const b = conta(await nucleo.consultarCaixaEBancos(c, { inicio: "2026-10-01", fim: "2026-10-02" }), banco.id);
  // Sem movimentos em 01/10, início 10,00 × fim 15,00 não fecha: divergência de R$ 5,00, nunca ajuste.
  assert.deepEqual(b.conferenciasDeSaldo.map((x) => [x.referencia, x.situacao, x.diferencaCentavos]), [["FIM_DO_DIA", "DIVERGENTE", 500]]);
  assert.equal(b.saldoFinalCentavos, 1500);
});

test("A.2 — despesa a classificar fica FORA da DRE; OUTRAS_DESPESAS é classificação confirmada", async () => {
  const { nucleo, c, fornecedor } = await montarComCadastros();
  const pendente = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 40000, categoria: "DESPESAS_A_CLASSIFICAR", descricao: "Boleto sem identificação" }));
  const outra = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 3000, categoria: "OUTRAS_DESPESAS", descricao: "Multa de trânsito" }));
  const ap = await nucleo.apurarCompetencia(c, { competencia: "2026-09" });
  const linha = (cod) => ap.dre.linhas.find((l) => l.codigo === cod);
  assert.equal(linha("DEMAIS_EFEITOS_GERENCIAIS").valorCentavos, -3000, "só a despesa confirmada entra");
  assert.equal(linha("DESPESAS_OPERACIONAIS").valorCentavos, 0);
  assert.equal(linha("RESULTADO_GERENCIAL").valorCentavos, -3000);
  assert.deepEqual(ap.dre.foraDoResultado.aClassificar.map((x) => [x.lancamentoId, x.valorCentavos]), [[pendente.lancamento.id, 40000]]);
  assert.ok(ap.pendencias.some((p) => p.tipo === "DESPESA_A_CLASSIFICAR" && p.valorCentavos === 40000));
  assert.equal(linha("RESULTADO_GERENCIAL").situacao, "PENDENTE_DE_CLASSIFICACAO");
  assert.equal(ap.indicadores.FATURAMENTO_LIQUIDO_GERENCIAL.reconciliacaoComDre.reconcilia, true);
  // Contas a pagar: a dívida existe e aparece; a classificação econômica é separada e pendente.
  const r = await nucleo.consultarContasAPagar(c, {});
  const tp = r.itens.find((t) => t.id === pendente.obrigacoes[0].id);
  const to = r.itens.find((t) => t.id === outra.obrigacoes[0].id);
  assert.deepEqual([tp.situacao, tp.classificacaoEconomica, tp.efeitoNaDre, tp.registro], ["VENCIDO", "PENDENTE_DE_CLASSIFICACAO", "FORA_ATE_CLASSIFICAR", "OBRIGACAO_CONSTITUIDA"]);
  assert.ok(tp.pendencias.includes("CLASSIFICACAO_PROVISORIA"));
  assert.deepEqual([to.classificacaoEconomica, to.efeitoNaDre], ["CONFIRMADA", "NA_LINHA_DA_CATEGORIA"]);
  assert.ok(!to.pendencias.includes("CLASSIFICACAO_PROVISORIA"));
  // Classificada com justificativa: entra na DRE uma única vez e a pendência some.
  // 08C: sair de "a classificar" exige evidência (a nota) e a versão vista na prévia.
  await nucleo.reclassificarLancamento(c, { lancamentoId: pendente.lancamento.id, categoria: "EMBALAGENS", justificativa: "Nota do fornecedor identificou a compra.", versaoEsperada: pendente.lancamento.versao, documentoId: (await nucleo.registrarDocumento(c, { origem: "MANUAL", arquivoId: "cofre:evidencia-sintetica-e", hashSha256: "e".repeat(64), tipo: "NOTA_FISCAL", recebidoEm: "2026-09-10" })).documento.id });
  const depois = await nucleo.apurarCompetencia(c, { competencia: "2026-09" });
  assert.equal(depois.dre.linhas.find((l) => l.codigo === "CUSTOS_OPERACIONAIS").valorCentavos, -40000);
  assert.equal(depois.dre.foraDoResultado.aClassificar.length, 0);
  assert.ok(!depois.pendencias.some((p) => p.tipo === "DESPESA_A_CLASSIFICAR"));
});

test("A.2 — saída do extrato: categoria bancária é só sugestão; sem vínculo continua pendente e fora da DRE", async () => {
  const { nucleo, c, banco } = await montarComCadastros();
  const r = await nucleo.receberArquivoParaImportacao(c, {
    fonte: "UNICRED", tipoRelatorio: "UNICRED_EXTRATO", tipoMime: "application/octet-stream", ...PERIODO_SETEMBRO,
    conteudo: unicredExtrato({ saldoInicial: 100000, lancamentos: [{ data: "03/09/2026", historico: "TARIFA CESTA DE SERVICOS", valor: -4500 }] }),
  });
  const imp = (await nucleo.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? { aceitarPendencias: true, justificativa: "Teste." } : {}) })).importacao;
  await nucleo.gerarPropostas(c, { importacaoId: imp.id, contaBancariaId: banco.id });
  const [p] = await nucleo.listarPropostas(c, { operacao: "MOVIMENTACAO_BANCARIA" });
  await nucleo.aprovarProposta(c, { propostaId: p.id, justificativa: "Teste." });
  await nucleo.aplicarProposta(c, { propostaId: p.id });
  const cb = await nucleo.consultarCaixaEBancos(c, { inicio: "2026-09-01", fim: "2026-09-30" });
  const [m] = cb.movimentos;
  assert.deepEqual([m.categoriaBancariaSugerida, m.classificacaoEconomica, m.vinculo.tipo], ["TARIFA", "PENDENTE_DE_CLASSIFICACAO", "SEM_VINCULO"]);
  const ap = await nucleo.apurarCompetencia(c, { competencia: "2026-09" });
  assert.equal(ap.dre.linhas.find((l) => l.codigo === "RESULTADO_FINANCEIRO").valorCentavos, null, "sem lançamentos: nada é presumido");
  assert.ok(ap.pendencias.some((x) => x.tipo === "SAIDA_SEM_CLASSIFICACAO" && x.valorCentavos === 4500));
});

test("A.3 — recorrência é ESTIMATIVA; descrição diferente não duplica; mês com título constituído não recebe previsão", async () => {
  const { nucleo, c, fornecedor } = await montarComCadastros();
  const aluguel = (mes, descricao, extra = {}) => nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, {
    valorOriginalCentavos: 250000, categoria: "DESPESAS_ADMINISTRATIVAS_GERAIS", descricao, competencia: mes, dataEmissao: `${mes}-01`, vencimento: `${mes}-10`,
    recorrencia: { periodicidade: "MENSAL", diaDoMes: 10 }, ...extra,
  }));
  await aluguel("2026-09", "Aluguel");
  // Outubro registrado com descrição diferente (antes da 06B: duas séries → previsão de novembro em dobro).
  await aluguel("2026-10", "Aluguel de outubro");
  // Novembro registrado SEM marcação de recorrência e com valor reajustado: é a obrigação constituída do mês.
  await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 262500, categoria: "DESPESAS_ADMINISTRATIVAS_GERAIS", descricao: "Aluguel nov (reajuste)", competencia: "2026-11", dataEmissao: "2026-10-20", vencimento: "2026-11-10" }));
  const fl = await nucleo.consultarFluxoDeCaixa(c, { inicio: "2026-10-15", fim: "2027-01-31", granularidade: "MES" });
  const recorrentes = fl.previsto.itens.filter((i) => i.natureza === "RECORRENCIA_PREVISTA");
  assert.deepEqual(recorrentes.map((i) => [i.data, i.valorCentavos, i.estimado]), [["2026-12-10", 250000, true], ["2027-01-10", 250000, true]], "uma previsão por mês, nenhuma em novembro");
  const novembro = fl.previsto.itens.filter((i) => i.data.startsWith("2026-11"));
  assert.deepEqual(novembro.map((i) => [i.natureza, i.valorCentavos, i.estimado]), [["CONTA_A_PAGAR", 262500, false]]);
  assert.ok(fl.projecao.motivos.includes("INCLUI_RECORRENCIAS_ESTIMADAS"));
  // Contas a pagar só lista obrigações constituídas; a estimativa nunca vira título.
  const cp = await nucleo.consultarContasAPagar(c, {});
  assert.equal(cp.quantidade, 3);
  assert.ok(cp.itens.every((t) => t.registro === "OBRIGACAO_CONSTITUIDA"));
  const cal = await nucleo.consultarCalendarioFinanceiro(c, { mes: "2026-12" });
  const dia10 = cal.dias.find((d) => d.data === "2026-12-10");
  assert.deepEqual(dia10.recorrentes.map((r) => [r.registro, r.base, r.obrigacaoConstituida]), [["PREVISAO_RECORRENTE", "ULTIMO_VALOR_DA_SERIE", false]]);
  assert.equal(dia10.titulos.length, 0);
});

test("A.3 — mês cancelado não volta como previsão; alerta de mês passado sem registro continua só alerta", async () => {
  const { nucleo, c, fornecedor } = await montarComCadastros();
  const mensal = (mes, extra = {}) => nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 9900, categoria: "MENSALIDADES_DE_PLATAFORMAS", descricao: "Sistema", competencia: mes, dataEmissao: `${mes}-01`, vencimento: `${mes}-05`, recorrencia: { periodicidade: "MENSAL", diaDoMes: 5 }, ...extra }));
  await mensal("2026-07");
  const agosto = await mensal("2026-08");
  await nucleo.cancelarObrigacao(c, { obrigacaoId: agosto.obrigacoes[0].id, justificativa: "Cobrança indevida, estornada pelo fornecedor." });
  const r = await nucleo.consultarContasAPagar(c, {});
  // Agosto foi cancelado (constituído e cancelado): não é "sem registro". Setembro e outubro passaram sem conta → alerta.
  assert.deepEqual(r.recorrenciasSemRegistro.map((x) => [x.data, x.estimado, x.obrigacaoConstituida]), [["2026-09-05", true, false], ["2026-10-05", true, false]]);
  assert.equal(r.totais.saldoCentavos, 9900, "o alerta não soma em contas a pagar");
});
