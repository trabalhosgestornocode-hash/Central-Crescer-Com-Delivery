// Execução 07 — auditoria de competências homologadas: toda atualização posterior ao fechamento precisa ser legítima,
// auditada, IGUAL em memória e no PostgreSQL, e nunca mudar o resultado nem a COMPOSIÇÃO da versão homologada.
// Dados SINTÉTICOS. Os valores esperados são números escritos à mão (não saem da fórmula do motor).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ORG_A, UNI_A, ctx, entrada, montarComCadastros, obrigacao, rejeita, saida } from "./helpers/cenario.js";

const SET = "2026-09";
const homologar = async (n, c, competencia = SET) => {
  await n.alterarEstadoDaCompetencia(c, { competencia, novoEstado: "FECHAMENTO_PRELIMINAR" });
  return n.alterarEstadoDaCompetencia(c, { competencia, novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Conferência sintética.", confirmar: true });
};
const vendaStone = (id, valor, extra = {}) => ({ canal: "BALCAO", dataVenda: "2026-09-10", brutoCentavos: valor, fonte: { sistema: "MANUAL", idExterno: id }, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: valor }], ...extra });
const marcasPosteriores = async (n, c, competencia = SET) => {
  const comp = await n.consultarCompetencia(c, { competencia });
  return (await n.consultarHistorico(c, { registroTipo: "COMPETENCIA", registroId: comp.id })).filter((h) => h.evento === "ATUALIZACAO_POSTERIOR_AO_FECHAMENTO").map((h) => h.depois.motivo);
};
const composicaoCongelada = (ap) => JSON.stringify(ap.versaoHomologada?.apuracao?.dre?.linhas ?? null);

test("A1 — estorno de pagamento com recebível depois do fechamento: efeito no mês do estorno, auditado, igual em memória e no banco", async () => {
  const { nucleo: n, c } = await montarComCadastros();
  const r = await n.registrarVenda(c, vendaStone("V-1", 10000));
  await homologar(n, c);
  // Correção de forma de pagamento em outubro: sem efeito no resultado; o recebível de setembro deixa de ser devido.
  const e = await n.estornarPagamentoDeVenda(c, { pagamentoId: r.pagamentos[0].id, motivo: "CORRECAO_DE_PAGAMENTO", justificativa: "Forma registrada errada (sintético).", dataEfetiva: "2026-10-05" });
  assert.deepEqual([e.recebivel.saldoCentavos, e.recebivel.ajustesCentavos, e.venda.pagoCentavos], [0, -10000, 0]);
  assert.deepEqual(await marcasPosteriores(n, c), ["estorno de pagamento de venda"]);
  const set = await n.apurarCompetencia(c, { competencia: SET });
  assert.equal(set.indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, 10000, "receita de setembro intacta");
  assert.equal(set.versaoHomologada.reproduz, true);
  assert.deepEqual(await n.verificarConservacao(c), []);
});

test("A2 — pagamento posterior via processadora: recebível nasce no mês do pagamento, sem gravar em setembro homologado", async () => {
  const { nucleo: n, c } = await montarComCadastros();
  const v = await n.registrarVenda(c, { canal: "IFOOD", dataVenda: "2026-09-12", brutoCentavos: 8000, fonte: { sistema: "MANUAL", idExterno: "V-2" }, pagamentoParcial: true, pagamentos: [] });
  await homologar(n, c);
  const p = await n.registrarPagamentoDeVenda(c, { vendaId: v.venda.id, forma: "OUTRA", processador: "IFOOD", valorCentavos: 8000, dataPagamento: "2026-10-02" });
  assert.equal(p.recebivel.competencia, "2026-10", "o recebível é um fato do mês do pagamento");
  assert.deepEqual(await marcasPosteriores(n, c), ["pagamento posterior de venda"]);
  assert.equal((await n.apurarCompetencia(c, { competencia: SET })).indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, 8000);
  // Pagamento DATADO em setembro homologado: recusado (núcleo e banco).
  const v2 = await n.registrarVenda(c, { canal: "IFOOD", dataVenda: "2026-10-01", brutoCentavos: 500, fonte: { sistema: "MANUAL", idExterno: "V-3" }, pagamentoParcial: true, pagamentos: [] });
  await rejeita(n.registrarPagamentoDeVenda(c, { vendaId: v2.venda.id, forma: "OUTRA", processador: "IFOOD", valorCentavos: 500, dataPagamento: "2026-09-30" }), CODIGO.COMPETENCIA_HOMOLOGADA);
});

test("A3 — taxa descoberta depois: reconhecida no mês informado (aberto), auditada; nunca reescreve setembro", async () => {
  const { nucleo: n, c } = await montarComCadastros();
  const r = (await n.registrarVenda(c, vendaStone("V-1", 20000))).recebiveis[0];
  await homologar(n, c);
  const antes = await n.apurarCompetencia(c, { competencia: SET });
  // Sem competência informada, o ajuste iria para setembro (homologado): recusado.
  await rejeita(n.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: r.id, valorCentavos: -300, motivo: "Taxa", categoria: "TAXAS_STONE" }), CODIGO.COMPETENCIA_HOMOLOGADA);
  // Reconhecida em outubro (competência aberta): lançamento em outubro; recebível de setembro muda só a posição.
  const a = await n.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: r.id, valorCentavos: -300, motivo: "Taxa descoberta no extrato de outubro", categoria: "TAXAS_STONE", competencia: "2026-10" });
  assert.equal(a.lancamento.competencia, "2026-10");
  assert.deepEqual(await marcasPosteriores(n, c), ["ajuste de título"]);
  const depois = await n.apurarCompetencia(c, { competencia: SET });
  assert.equal(depois.indicadores.RESULTADO_GERENCIAL.valorCentavos, antes.indicadores.RESULTADO_GERENCIAL.valorCentavos);
  assert.equal((await n.apurarCompetencia(c, { competencia: "2026-10" })).indicadores.DESPESAS_OPERACIONAIS.valorCentavos, -300);
});

test("A4 — composição da versão homologada não muda com pagamento posterior (retrato congelado, posição atual à parte)", async () => {
  const { nucleo: n, c, banco, fornecedor } = await montarComCadastros();
  const o = (await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 50000 }))).obrigacoes[0];
  await homologar(n, c);
  const antes = await n.apurarCompetencia(c, { competencia: SET });
  const linhaCustos = (ap) => ap.versaoHomologada.apuracao.dre.linhas.find((l) => l.codigo === "CUSTOS_OPERACIONAIS");
  const folha = (l) => { let x = l.componentes[0]; while (x.filhos?.length) [x] = x.filhos; return x; };
  assert.equal(folha(linhaCustos(antes)).detalhe.obrigacoes[0].pagoCentavos, 0);
  // Pagamento em outubro (legítimo).
  const pg = (await n.registrarMovimentacao(c, saida(banco.id, 50000, { dataEfetiva: "2026-10-04" }))).movimentacao;
  await n.registrarLiquidacao(c, { movimentacaoId: pg.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: o.id, valorCentavos: 50000 }] });
  const depois = await n.apurarCompetencia(c, { competencia: SET });
  assert.equal(composicaoCongelada(depois), composicaoCongelada(antes), "a composição homologada é a mesma");
  assert.equal(folha(linhaCustos(depois)).detalhe.obrigacoes[0].pagoCentavos, 0, "na versão, a posição é a da data da homologação");
  // A posição ATUAL continua disponível nas telas de tesouraria (pago depois).
  const ap = await n.detalharContaAPagar(c, { id: o.id });
  assert.deepEqual([ap.titulo.pagoCentavos, ap.titulo.situacao], [50000, "PAGO"]);
  // A DRE e a composição do indicador apresentadas para a homologada vêm da versão.
  assert.equal(depois.fonteDaApresentacao, "VERSAO_HOMOLOGADA");
  const comp = await n.composicaoDoIndicador(c, { competencia: SET, codigo: "CUSTOS_OPERACIONAIS" });
  assert.equal(comp.fonte, "VERSAO_HOMOLOGADA");
});

test("A5 — saldo informado com data em mês homologado: aceito como evidência posterior, sempre auditado", async () => {
  const { nucleo: n, c, banco } = await montarComCadastros();
  await homologar(n, c);
  await n.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-09-15", valorCentavos: 1000 });
  assert.deepEqual(await marcasPosteriores(n, c), ["saldo informado"]);
});

test("A6 — homologação concorrente com liquidação: a liquidação nunca altera a competência depois de homologada", async () => {
  const { nucleo: n, c, banco, fornecedor } = await montarComCadastros();
  const o = (await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 3000 }))).obrigacoes[0];
  const pg = (await n.registrarMovimentacao(c, saida(banco.id, 3000, { dataEfetiva: "2026-09-25" }))).movimentacao;
  await n.alterarEstadoDaCompetencia(c, { competencia: SET, novoEstado: "FECHAMENTO_PRELIMINAR" });
  const [liq, hom] = await Promise.allSettled([
    n.registrarLiquidacao(c, { movimentacaoId: pg.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: o.id, valorCentavos: 3000 }] }),
    n.alterarEstadoDaCompetencia(c, { competencia: SET, novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "x", confirmar: true }),
  ]);
  assert.equal(hom.status, "fulfilled");
  const final = (await n.consultarRegistros(c, { tipo: "OBRIGACAO" }))[0];
  if (liq.status === "fulfilled") {
    // A liquidação veio antes: a versão homologada já mostra a obrigação paga.
    const v = (await n.apurarCompetencia(c, { competencia: SET })).versaoHomologada;
    assert.equal(final.liquidadoCentavos, 3000);
    assert.ok(v.reproduz);
  } else {
    assert.equal(liq.reason.codigo, CODIGO.COMPETENCIA_HOMOLOGADA);
    assert.equal(final.liquidadoCentavos, 0);
  }
  assert.deepEqual(await n.verificarConservacao(c), []);
});

test("A7 — segunda homologação após revisão: as duas versões continuam reproduzíveis por si mesmas", async () => {
  const { nucleo: n, c, fornecedor } = await montarComCadastros();
  await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 7000 }));
  const h1 = await homologar(n, c);
  await n.alterarEstadoDaCompetencia(ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.REABRIR]), { competencia: SET, novoEstado: "ABERTA", justificativa: "Nota adicional chegou.", confirmar: true });
  await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 1500, descricao: "Nota adicional" }));
  const h2 = await homologar(n, c);
  const vs = (await n.consultarVersoesDeFechamento(c, { competencia: SET })).versoes;
  const v1 = vs.find((v) => v.numero === h1.versao.numero);
  const v2 = vs.find((v) => v.numero === h2.versao.numero);
  assert.deepEqual([v1.resultadoGerencialCentavos, v2.resultadoGerencialCentavos], [-7000, -8500]);
  assert.deepEqual([v1.vigente, v2.vigente], [false, true]);
  assert.notEqual(v1.impressao, v2.impressao);
  const ap = await n.apurarCompetencia(c, { competencia: SET });
  assert.deepEqual([ap.versaoHomologada.numero, ap.versaoHomologada.reproduz, ap.indicadores.RESULTADO_GERENCIAL.valorCentavos], [h2.versao.numero, true, -8500]);
});

test("A8 — entrada posterior não classificada não vira receita nem despesa de setembro", async () => {
  const { nucleo: n, c, banco } = await montarComCadastros();
  await homologar(n, c);
  await n.registrarMovimentacao(c, entrada(banco.id, 4321, { dataEfetiva: "2026-10-02", natureza: "OUTRA" }));
  const out = await n.apurarCompetencia(c, { competencia: "2026-10" });
  assert.equal(out.indicadores.RESULTADO_GERENCIAL.valorCentavos, null, "movimentação desconhecida não é receita");
});
