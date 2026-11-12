// Fase E — 4, 5, 6, 7, 8 (obrigações, recebíveis e liquidações) + conservação dos valores e atomicidade.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { entrada, montarComCadastros, obrigacao, rejeita, saida } from "./helpers/cenario.js";

const liquidar = (nucleo, c, movimentacaoId, ...alocacoes) => nucleo.registrarLiquidacao(c, { movimentacaoId, alocacoes: alocacoes.map(([alvoTipo, alvoId, valorCentavos]) => ({ alvoTipo, alvoId, valorCentavos })) });
const obter = async (nucleo, c, tipo, id) => (await nucleo.consultarRegistros(c, { tipo })).find((r) => r.id === id);
const fecha = (t) => assert.equal(t.saldoCentavos, t.valorBaseCentavos - t.liquidadoCentavos + t.ajustesCentavos);

test("obrigação com pagamento integral fica quitada, com saldo zero", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const { obrigacoes: [ob], lancamento } = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id));
  assert.equal(ob.situacao, "ABERTA");
  assert.equal(ob.saldoCentavos, 100000);
  assert.equal(lancamento.natureza, "DESPESA");
  const { movimentacao } = await nucleo.registrarMovimentacao(c, saida(banco.id, 100000));
  const r = await liquidar(nucleo, c, movimentacao.id, ["OBRIGACAO", ob.id, 100000]);
  assert.equal(r.titulos[0].situacao, "QUITADA");
  assert.equal(r.titulos[0].saldoCentavos, 0);
  assert.equal(r.titulos[0].liquidadoCentavos, 100000);
  assert.equal(r.movimentacao.alocadoCentavos, 100000);
  fecha(r.titulos[0]);
  // Quitada não aceita mais pagamento.
  const outra = await nucleo.registrarMovimentacao(c, saida(banco.id, 1));
  await rejeita(liquidar(nucleo, c, outra.movimentacao.id, ["OBRIGACAO", ob.id, 1]), CODIGO.LIQUIDACAO_EXCEDE_SALDO);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("obrigação com pagamentos parciais: saldo cai a cada pagamento e nunca fica negativo", async () => {
  const { nucleo, c, banco, caixa, fornecedor } = await montarComCadastros();
  const { obrigacoes: [ob] } = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id));
  const p1 = await nucleo.registrarMovimentacao(c, saida(banco.id, 30000));
  const p2 = await nucleo.registrarMovimentacao(c, saida(caixa.id, 25050, { natureza: "OUTRA" }));
  const p3 = await nucleo.registrarMovimentacao(c, saida(banco.id, 50000));

  let t = (await liquidar(nucleo, c, p1.movimentacao.id, ["OBRIGACAO", ob.id, 30000])).titulos[0];
  assert.deepEqual([t.situacao, t.saldoCentavos], ["PARCIAL", 70000]);
  t = (await liquidar(nucleo, c, p2.movimentacao.id, ["OBRIGACAO", ob.id, 25050])).titulos[0];
  assert.deepEqual([t.situacao, t.saldoCentavos], ["PARCIAL", 44950]);
  fecha(t);
  // Pagamento maior que o saldo é recusado por inteiro.
  await rejeita(liquidar(nucleo, c, p3.movimentacao.id, ["OBRIGACAO", ob.id, 50000]), CODIGO.LIQUIDACAO_EXCEDE_SALDO);
  t = (await liquidar(nucleo, c, p3.movimentacao.id, ["OBRIGACAO", ob.id, 44950])).titulos[0];
  assert.deepEqual([t.situacao, t.saldoCentavos, t.liquidadoCentavos], ["QUITADA", 0, 100000]);
  const mov3 = await obter(nucleo, c, "MOVIMENTACAO", p3.movimentacao.id);
  assert.equal(mov3.alocadoCentavos, 44950); // sobra de 50,50 na movimentação continua explicável
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "LIQUIDACAO" })).length, 3);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("obrigação parcelada: uma despesa, N parcelas que somam exatamente o total", async () => {
  const { nucleo, c, fornecedor } = await montarComCadastros();
  const { obrigacoes, lancamento } = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 100000, parcelas: 3, vencimento: "2026-09-30" }));
  assert.deepEqual(obrigacoes.map((o) => o.valorBaseCentavos), [33334, 33333, 33333]);
  assert.equal(obrigacoes.reduce((a, o) => a + o.valorBaseCentavos, 0), 100000);
  assert.deepEqual(obrigacoes.map((o) => o.vencimento), ["2026-09-30", "2026-10-30", "2026-11-30"]);
  assert.deepEqual(obrigacoes.map((o) => o.parcela), [{ numero: 1, total: 3 }, { numero: 2, total: 3 }, { numero: 3, total: 3 }]);
  assert.ok(obrigacoes.every((o) => o.lancamentoId === lancamento.id && o.grupoId === obrigacoes[0].grupoId));
  assert.equal((await nucleo.consultarComposicao(c, { indicador: "DESPESAS", competencia: "2026-09" })).totalCentavos, 100000);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "LANCAMENTO" })).length, 1);
});

test("recebível com liquidação parcial mantém saldo remanescente", async () => {
  const { nucleo, c, banco } = await montarComCadastros();
  const { recebivel, lancamentosDeRetencao } = await nucleo.registrarRecebivel(c, {
    processador: "IFOOD", canal: "IFOOD", brutoCentavos: 50000, competencia: "2026-09", dataPrevista: "2026-09-25",
    retencoes: [{ categoria: "COMISSOES_IFOOD", valorCentavos: 6000 }, { categoria: "TAXAS_DE_PROCESSAMENTO", valorCentavos: 1600 }],
  });
  assert.equal(recebivel.valorBaseCentavos, 42400); // líquido esperado = bruto − retenções
  assert.equal(recebivel.saldoCentavos, 42400);
  // Regra corrigida (Execução 01B): retenção é classificada pela natureza econômica — comissão e taxa são DESPESA, não dedução da receita.
  assert.deepEqual(lancamentosDeRetencao.map((l) => [l.natureza, l.valorCentavos, l.categoria, l.classificacao, l.retidoNoRepasse]), [["DESPESA", 6000, "COMISSOES_IFOOD", "DESPESAS_COMERCIAIS", true], ["DESPESA", 1600, "TAXAS_DE_PROCESSAMENTO", "DESPESAS_RECEBIMENTO_PROCESSAMENTO", true]]);
  assert.equal((await nucleo.consultarComposicao(c, { indicador: "RECEITA_BRUTA", competencia: "2026-09" })).totalCentavos, 0); // recebível avulso não cria receita

  const { movimentacao } = await nucleo.registrarMovimentacao(c, entrada(banco.id, 20000));
  const r = await liquidar(nucleo, c, movimentacao.id, ["RECEBIVEL", recebivel.id, 20000]);
  assert.deepEqual([r.titulos[0].situacao, r.titulos[0].saldoCentavos, r.titulos[0].liquidadoCentavos], ["PARCIAL", 22400, 20000]);
  fecha(r.titulos[0]);
  assert.equal((await nucleo.consultarComposicao(c, { indicador: "SALDO_A_RECEBER", competencia: "2026-09" })).totalCentavos, 22400);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("um pagamento vinculado a múltiplas obrigações", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const a = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 40000 }))).obrigacoes[0];
  const b = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 35000 }))).obrigacoes[0];
  const d = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 50000 }))).obrigacoes[0];
  const { movimentacao } = await nucleo.registrarMovimentacao(c, saida(banco.id, 100000));
  const r = await liquidar(nucleo, c, movimentacao.id, ["OBRIGACAO", a.id, 40000], ["OBRIGACAO", b.id, 35000], ["OBRIGACAO", d.id, 25000]);
  assert.deepEqual(r.titulos.map((t) => [t.situacao, t.saldoCentavos]), [["QUITADA", 0], ["QUITADA", 0], ["PARCIAL", 25000]]);
  assert.equal(r.liquidacoes.length, 3);
  assert.ok(r.liquidacoes.every((l) => l.movimentacaoId === movimentacao.id));
  assert.equal(r.movimentacao.alocadoCentavos, 100000);
  assert.equal((await nucleo.consultarComposicao(c, { indicador: "SAIDAS_DE_CAIXA", competencia: "2026-09" })).totalCentavos, 100000); // uma saída, não três
  assert.equal((await nucleo.consultarComposicao(c, { indicador: "DESPESAS", competencia: "2026-09" })).totalCentavos, 125000);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("um repasse vinculado a múltiplos recebíveis", async () => {
  const { nucleo, c, banco } = await montarComCadastros();
  const recebiveis = [];
  for (const [i, valor] of [12000, 8050, 4975].entries()) {
    const v = await nucleo.registrarVenda(c, { canal: "BALCAO", dataVenda: `2026-09-0${i + 1}`, brutoCentavos: valor, pagamentos: [{ forma: "DEBITO", processador: "STONE", valorCentavos: valor }], fonte: { sistema: "SAIPOS", idExterno: `PED-${i}` } });
    recebiveis.push(v.recebiveis[0]);
  }
  // O processador reteve 250 de taxa no terceiro: ajuste documentado, uma única despesa de recebimento.
  const aj = await nucleo.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: recebiveis[2].id, valorCentavos: -250, motivo: "Taxa retida pelo processador", categoria: "TAXAS_STONE" });
  assert.deepEqual([aj.lancamento.natureza, aj.lancamento.classificacao, aj.lancamento.valorCentavos, aj.alvo.saldoCentavos], ["DESPESA", "DESPESAS_RECEBIMENTO_PROCESSAMENTO", 250, 4725]);

  const { movimentacao } = await nucleo.registrarMovimentacao(c, entrada(banco.id, 24775)); // 12000 + 8050 + 4725
  const r = await liquidar(nucleo, c, movimentacao.id, ["RECEBIVEL", recebiveis[0].id, 12000], ["RECEBIVEL", recebiveis[1].id, 8050], ["RECEBIVEL", recebiveis[2].id, 4725]);
  assert.ok(r.titulos.every((t) => t.situacao === "QUITADA" && t.saldoCentavos === 0));
  r.titulos.forEach(fecha);
  const total = async (indicador) => (await nucleo.consultarComposicao(c, { indicador, competencia: "2026-09" })).totalCentavos;
  assert.equal(await total("RECEITA_BRUTA"), 25025);
  // A taxa retida é despesa de recebimento (não dedução da receita) e aparece UMA vez no resultado.
  assert.equal(await total("DEDUCOES"), 0);
  assert.equal(await total("RETENCOES_DE_CANAL"), 250);
  assert.equal(await total("FATURAMENTO_LIQUIDO_GERENCIAL"), 24775);
  assert.equal(await total("RESULTADO_ECONOMICO"), 24775);
  assert.equal(await total("ENTRADAS_DE_CAIXA"), 24775);
  assert.equal(await total("SALDO_A_RECEBER"), 0);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("alocação nunca supera a movimentação nem mistura sentidos", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const a = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 40000 }))).obrigacoes[0];
  const b = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 40000 }))).obrigacoes[0];
  const { recebivel } = await nucleo.registrarRecebivel(c, { processador: "STONE", brutoCentavos: 40000, competencia: "2026-09" });
  const pg = (await nucleo.registrarMovimentacao(c, saida(banco.id, 50000))).movimentacao;
  const rc = (await nucleo.registrarMovimentacao(c, entrada(banco.id, 50000))).movimentacao;

  await rejeita(liquidar(nucleo, c, pg.id, ["OBRIGACAO", a.id, 40000], ["OBRIGACAO", b.id, 40000]), CODIGO.LIQUIDACAO_EXCEDE_MOVIMENTACAO);
  await rejeita(liquidar(nucleo, c, pg.id, ["RECEBIVEL", recebivel.id, 1000]), CODIGO.LIQUIDACAO_INCOMPATIVEL); // saída não recebe
  await rejeita(liquidar(nucleo, c, rc.id, ["OBRIGACAO", a.id, 1000]), CODIGO.LIQUIDACAO_INCOMPATIVEL); // entrada não paga
  await rejeita(liquidar(nucleo, c, pg.id, ["OBRIGACAO", a.id, 1000], ["OBRIGACAO", a.id, 1000]), CODIGO.ENTRADA_INVALIDA); // mesmo título 2x
  await liquidar(nucleo, c, pg.id, ["OBRIGACAO", a.id, 40000]);
  await rejeita(liquidar(nucleo, c, pg.id, ["OBRIGACAO", b.id, 10001]), CODIGO.LIQUIDACAO_EXCEDE_MOVIMENTACAO); // só restam 100,00
  await liquidar(nucleo, c, pg.id, ["OBRIGACAO", b.id, 10000]);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("liquidação composta é atômica: se uma parte falha, nada é gravado", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const a = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 40000 }))).obrigacoes[0];
  const b = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 10000 }))).obrigacoes[0];
  const pg = (await nucleo.registrarMovimentacao(c, saida(banco.id, 90000))).movimentacao;
  // A primeira alocação é válida; a segunda supera o saldo de `b`. Nenhuma das duas pode ficar.
  await rejeita(liquidar(nucleo, c, pg.id, ["OBRIGACAO", a.id, 40000], ["OBRIGACAO", b.id, 10001]), CODIGO.LIQUIDACAO_EXCEDE_SALDO);
  // Idem quando o segundo título nem existe.
  await rejeita(liquidar(nucleo, c, pg.id, ["OBRIGACAO", a.id, 40000], ["OBRIGACAO", "dddddddd-0000-4000-8000-000000000009", 1]), CODIGO.NAO_ENCONTRADO);
  const aDepois = await obter(nucleo, c, "OBRIGACAO", a.id);
  assert.deepEqual([aDepois.situacao, aDepois.saldoCentavos, aDepois.versao], ["ABERTA", 40000, 1]);
  assert.equal((await obter(nucleo, c, "MOVIMENTACAO", pg.id)).alocadoCentavos, 0);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "LIQUIDACAO" })).length, 0);
  assert.equal((await nucleo.consultarHistorico(c, { registroTipo: "OBRIGACAO", registroId: a.id })).length, 1); // só a criação
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("ajustes documentados entram na conservação: original − liquidações ± ajustes = saldo", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const ob = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 100000 }))).obrigacoes[0];
  const juros = await nucleo.registrarAjuste(c, { alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 1234, motivo: "Juros por atraso", categoria: "JUROS_E_TARIFAS_BANCARIAS" });
  assert.deepEqual([juros.alvo.saldoCentavos, juros.lancamento.natureza, juros.lancamento.valorCentavos], [101234, "DESPESA", 1234]);
  const desconto = await nucleo.registrarAjuste(c, { alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: -234, motivo: "Desconto negociado", categoria: "INSUMOS" }); // abatimento no próprio custo
  assert.deepEqual([desconto.alvo.saldoCentavos, desconto.alvo.ajustesCentavos, desconto.lancamento.valorCentavos], [101000, 1000, -234]);
  const pg = (await nucleo.registrarMovimentacao(c, saida(banco.id, 101000))).movimentacao;
  const r = await liquidar(nucleo, c, pg.id, ["OBRIGACAO", ob.id, 101000]);
  assert.deepEqual([r.titulos[0].situacao, r.titulos[0].saldoCentavos, r.titulos[0].valorBaseCentavos], ["QUITADA", 0, 100000]);
  fecha(r.titulos[0]);
  assert.equal((await nucleo.consultarComposicao(c, { indicador: "DESPESAS", competencia: "2026-09" })).totalCentavos, 101000); // despesa total = o que saiu do caixa
  await rejeita(nucleo.registrarAjuste(c, { alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: -1, motivo: "x", categoria: "INSUMOS" }), CODIGO.AJUSTE_EXCEDE_SALDO);
  await rejeita(nucleo.registrarAjuste(c, { alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 0, motivo: "x", categoria: "INSUMOS" }), CODIGO.VALOR_INVALIDO);
  await rejeita(nucleo.registrarAjuste(c, { alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 10, categoria: "INSUMOS" }), CODIGO.ENTRADA_INVALIDA); // sem motivo
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("estorno de liquidação devolve o saldo e preserva o registro estornado", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const ob = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id))).obrigacoes[0];
  const pg = (await nucleo.registrarMovimentacao(c, saida(banco.id, 100000))).movimentacao;
  const { liquidacoes: [liq] } = await liquidar(nucleo, c, pg.id, ["OBRIGACAO", ob.id, 100000]);
  await rejeita(nucleo.estornarLiquidacao(c, { liquidacaoId: liq.id }), CODIGO.ENTRADA_INVALIDA); // sem justificativa
  const r = await nucleo.estornarLiquidacao(c, { liquidacaoId: liq.id, justificativa: "Pagamento vinculado ao título errado" });
  assert.deepEqual([r.titulo.situacao, r.titulo.saldoCentavos, r.movimentacao.alocadoCentavos, r.liquidacao.situacao], ["ABERTA", 100000, 0, "ESTORNADA"]);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "LIQUIDACAO" })).length, 1); // continua existindo
  await rejeita(nucleo.estornarLiquidacao(c, { liquidacaoId: liq.id, justificativa: "de novo" }), CODIGO.OPERACAO_INVALIDA);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});
