// Execução 07 — CENÁRIO ECONÔMICO INTEGRADO (Fase B), dados SINTÉTICOS.
//
// Um mês inteiro com: Balcão, iFood, Anota AI, pagamento misto, desconto da loja, subsídio de terceiro comprovado,
// desconto sem financiador, taxa Stone, comissão/anúncios/mensalidade iFood, venda cancelada, estorno parcial,
// fornecedor (pago em parte), entregador (pago no mês seguinte), saída bancária sem classificação e empréstimo com
// principal e juros.
//
// Os valores esperados são CONSTANTES calculadas à mão (abaixo, com a conta escrita) — nunca saem da fórmula do motor.
// As conferências usam caminhos independentes: soma das folhas da árvore de composição, totais das telas de tesouraria,
// saldo das contas a partir do saldo informado e das entradas/saídas registradas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { montarComCadastros, sha } from "./helpers/cenario.js";

// ------------------------------------------------------------------------------------------- conta feita à mão
// Vendas ATIVAS (bruto): 10000 + 20000 + 5000 + 8000 + 6000 + 4000 + 3000 + 5000 = 61000 (cancelada de 2000 fica fora)
//   Balcão = 10000 + 8000 + 6000 + 3000 + 5000 = 32000 · iFood = 20000 + 4000 = 24000 · Anota AI = 5000
// Deduções: desconto da loja 600 + desconto sem financiador 300 + devolução 1000 = 1900 (subsídio comprovado NÃO é dedução)
// Receita líquida comercial: 61000 − 1900 = 59100
// Custos operacionais: insumos 7000
// Despesas operacionais: comissão 2400 + mensalidade 1000 + anúncios 500 + taxa Stone 150 + entregador 1200 = 5250
// Resultado financeiro: juros −800 (principal do empréstimo é patrimonial: fora do resultado)
// Resultado gerencial: 59100 − 7000 − 5250 − 800 = 46050
const ESPERADO = Object.freeze({
  bruto: 61000, balcao: 32000, ifood: 24000, anotaAi: 5000, deducoes: 1900, receitaLiquida: 59100, custos: 7000, despesas: 5250,
  financeiro: -800, resultado: 46050, patrimonial: 50000,
  // Recebíveis em aberto: iFood 20000−2400−1000−500 = 16100; iFood (venda com subsídio) 3000; subsídio comprovado do terceiro
  // 1000; Anota AI 5000; Stone do pagamento misto 5000−150 = 4850 → 29950 (o da venda cancelada não conta)
  recebiveis: 29950,
  // Obrigações em aberto em 15/10: insumos 7000−4000 = 3000; entregador pago em 05/10 = 0; principal 50000−5000 = 45000; juros 0
  obrigacoes: 48000,
  // Caixa físico (saldo informado 0 em 01/09): 10000 + 3000 + 5400 + 2700 + 5000 − 1000 (devolução) = 25100
  caixa: 25100,
  // Banco (saldo informado 100000 em 01/09): +50000 empréstimo − 4000 insumos − 250 sem classificação − 5800 parcela+juros = 139950
  // em 30/09; em 15/10, − 1200 do entregador = 138750
  bancoFimSetembro: 139950, bancoHoje: 138750,
});

async function cenario() {
  const m = await montarComCadastros();
  const { nucleo: n, c, banco, caixa, fornecedor } = m;
  await n.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-09-01", valorCentavos: 100000 });
  await n.registrarSaldoDeConta(c, { contaId: caixa.id, data: "2026-09-01", valorCentavos: 0 });
  let k = 0;
  const venda = (canal, bruto, pagamentos, extra = {}) => n.registrarVenda(c, { canal, dataVenda: "2026-09-10", brutoCentavos: bruto, fonte: { sistema: "MANUAL", idExterno: `INT-${(k += 1)}` }, pagamentos, ...extra });
  const dinheiro = (v) => ({ forma: "DINHEIRO", valorCentavos: v, contaId: caixa.id });
  await venda("BALCAO", 10000, [dinheiro(10000)]);
  const ifood = await venda("IFOOD", 20000, [{ forma: "OUTRA", processador: "IFOOD", valorCentavos: 20000 }]);
  for (const [cat, v] of [["COMISSOES_IFOOD", 2400], ["MENSALIDADE_IFOOD", 1000], ["ANUNCIOS_IFOOD", 500]]) {
    await n.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: ifood.recebiveis[0].id, valorCentavos: -v, motivo: cat, categoria: cat });
  }
  await venda("ANOTA_AI", 5000, [{ forma: "OUTRA", processador: "ANOTA_AI", valorCentavos: 5000 }]);
  const misto = await venda("BALCAO", 8000, [dinheiro(3000), { forma: "CREDITO", processador: "STONE", valorCentavos: 5000 }]);
  await n.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: misto.recebiveis[0].id, valorCentavos: -150, motivo: "Taxa Stone", categoria: "TAXAS_STONE" });
  await venda("BALCAO", 6000, [dinheiro(5400)], { composicao: { itensCentavos: 6000, descontos: [{ valorCentavos: 600, financiador: "LOJA" }] } });
  const prova = (await n.registrarDocumento(c, { origem: "IFOOD", arquivoId: "cofre:" + sha("c"), hashSha256: sha("c"), tipo: "DEMONSTRATIVO_REPASSE", recebidoEm: "2026-09-11" })).documento;
  await venda("IFOOD", 4000, [{ forma: "OUTRA", processador: "IFOOD", valorCentavos: 3000 }], { composicao: { itensCentavos: 4000, descontos: [{ valorCentavos: 1000, financiador: "TERCEIRO", terceiro: "IFOOD", documentoId: prova.id }] } });
  await venda("BALCAO", 3000, [dinheiro(2700)], { composicao: { itensCentavos: 3000, descontos: [{ valorCentavos: 300, financiador: "PENDENTE" }] } });
  const cancelada = await venda("BALCAO", 2000, [{ forma: "CREDITO", processador: "STONE", valorCentavos: 2000 }]);
  await n.cancelarVenda(c, { vendaId: cancelada.venda.id, justificativa: "Pedido desistido (sintético)." });
  const devolvida = await venda("BALCAO", 5000, [dinheiro(5000)]);
  await n.estornarPagamentoDeVenda(c, { pagamentoId: devolvida.pagamentos[0].id, valorCentavos: 1000, motivo: "DEVOLUCAO_AO_CLIENTE", justificativa: "Item devolvido (sintético).", dataEfetiva: "2026-09-20" });
  // Fornecedor (pagamento parcial no mês), entregador (pago no mês seguinte).
  const insumos = (await n.registrarObrigacao(c, { contraparteId: fornecedor.id, valorOriginalCentavos: 7000, categoria: "INSUMOS", descricao: "Insumos", competencia: "2026-09", dataEmissao: "2026-09-05", vencimento: "2026-09-20" })).obrigacoes[0];
  const pagar = async (data, valor, alocacoes) => {
    const mov = (await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: data, sentido: "SAIDA", valorCentavos: valor, natureza: "PAGAMENTO" })).movimentacao;
    await n.registrarLiquidacao(c, { movimentacaoId: mov.id, alocacoes });
  };
  await pagar("2026-09-20", 4000, [{ alvoTipo: "OBRIGACAO", alvoId: insumos.id, valorCentavos: 4000 }]);
  const entregador = await n.registrarContraparte(c, { tipo: "PRESTADOR", nome: "Entregador sintético" });
  const entrega = (await n.registrarObrigacao(c, { contraparteId: entregador.id, valorOriginalCentavos: 1200, categoria: "ENTREGADORES_PROPRIOS", descricao: "Entregas de setembro", competencia: "2026-09", dataEmissao: "2026-09-30", vencimento: "2026-10-05" })).obrigacoes[0];
  await pagar("2026-10-05", 1200, [{ alvoTipo: "OBRIGACAO", alvoId: entrega.id, valorCentavos: 1200 }]);
  // Saída bancária sem classificação (não vira despesa).
  await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-09-22", sentido: "SAIDA", valorCentavos: 250, natureza: "OUTRA", descricao: "DEB SINTETICO" });
  // Empréstimo: entrada do principal (sem receita), principal em 10 parcelas (patrimonial) e juros (resultado financeiro).
  await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-09-02", sentido: "ENTRADA", valorCentavos: 50000, natureza: "OUTRA", descricao: "CRED EMPRESTIMO SINT" });
  const banco2 = await n.registrarContraparte(c, { tipo: "OUTRO", nome: "Banco credor sintético" });
  const principal = (await n.registrarObrigacao(c, { contraparteId: banco2.id, valorOriginalCentavos: 50000, parcelas: 10, categoria: "EMPRESTIMOS_E_FINANCIAMENTOS", descricao: "Principal do empréstimo", competencia: "2026-09", dataEmissao: "2026-09-02", vencimento: "2026-09-25" })).obrigacoes;
  const juros = (await n.registrarObrigacao(c, { contraparteId: banco2.id, valorOriginalCentavos: 800, categoria: "JUROS_E_TARIFAS_BANCARIAS", descricao: "Juros da parcela 1", competencia: "2026-09", dataEmissao: "2026-09-02", vencimento: "2026-09-25" })).obrigacoes[0];
  await pagar("2026-09-25", 5800, [{ alvoTipo: "OBRIGACAO", alvoId: principal[0].id, valorCentavos: 5000 }, { alvoTipo: "OBRIGACAO", alvoId: juros.id, valorCentavos: 800 }]);
  return m;
}

const folhas = (nos) => nos.flatMap((x) => (x.filhos?.length ? folhas(x.filhos) : [x]));
const somaDasFolhas = (linha) => folhas(linha.componentes).reduce((s, x) => s + x.valorCentavos, 0);

test("B — DRE do cenário integrado bate com a conta feita à mão e com a soma das folhas", async () => {
  const { nucleo: n, c } = await cenario();
  const ap = await n.apurarCompetencia(c, { competencia: "2026-09" });
  const L = Object.fromEntries(ap.dre.linhas.map((l) => [l.codigo, l]));
  assert.equal(L.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, ESPERADO.bruto);
  assert.equal(L.DEDUCOES_COMERCIAIS.valorCentavos, -ESPERADO.deducoes);
  assert.equal(L.RECEITA_LIQUIDA_COMERCIAL.valorCentavos, ESPERADO.receitaLiquida);
  assert.equal(L.CUSTOS_OPERACIONAIS.valorCentavos, -ESPERADO.custos);
  assert.equal(L.DESPESAS_OPERACIONAIS.valorCentavos, -ESPERADO.despesas);
  assert.equal(L.RESULTADO_FINANCEIRO.valorCentavos, ESPERADO.financeiro);
  assert.equal(L.RESULTADO_GERENCIAL.valorCentavos, ESPERADO.resultado);
  // Independente da fórmula: cada linha de componentes = soma das suas folhas (sinal da linha aplicado).
  assert.equal(somaDasFolhas(L.FATURAMENTO_BRUTO_PROPRIO), ESPERADO.bruto);
  assert.equal(Math.abs(somaDasFolhas(L.DEDUCOES_COMERCIAIS)), ESPERADO.deducoes);
  assert.equal(Math.abs(somaDasFolhas(L.CUSTOS_OPERACIONAIS)), ESPERADO.custos);
  assert.equal(Math.abs(somaDasFolhas(L.DESPESAS_OPERACIONAIS)), ESPERADO.despesas);
  // Subtotais fecham com as linhas filhas.
  assert.equal(L.RECEITA_LIQUIDA_COMERCIAL.valorCentavos, L.FATURAMENTO_BRUTO_PROPRIO.valorCentavos + L.DEDUCOES_COMERCIAIS.valorCentavos);
  assert.equal(L.RESULTADO_GERENCIAL.valorCentavos, L.RECEITA_LIQUIDA_COMERCIAL.valorCentavos + L.CUSTOS_OPERACIONAIS.valorCentavos + L.DESPESAS_OPERACIONAIS.valorCentavos + L.RESULTADO_FINANCEIRO.valorCentavos + (L.DEMAIS_EFEITOS_GERENCIAIS.valorCentavos ?? 0));
  // Cada lançamento aparece uma única vez na DRE.
  const ids = ap.dre.linhas.filter((l) => l.componentes?.length && !["RECEITA_LIQUIDA_COMERCIAL", "RESULTADO_APOS_CUSTOS", "RESULTADO_GERENCIAL"].includes(l.codigo)).flatMap((l) => folhas(l.componentes).map((f) => f.id ?? f.lancamentoId ?? f.referencias?.lancamentoId)).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, "nenhum lançamento em duas linhas");
  // Principal do empréstimo fora do resultado; desconto sem financiador marcado como provisório.
  assert.equal(ap.dre.foraDoResultado.patrimoniais.reduce((s, x) => s + x.valorCentavos, 0), ESPERADO.patrimonial);
  assert.ok(ap.pendencias.some((p) => /DESCONTO|CLASSIFIC/.test(p.tipo)), "desconto sem financiador não aparece como definitivo");
  // Bruto por canal: sem atribuição por suposição.
  const canais = Object.fromEntries(ap.indicadores.FATURAMENTO_BRUTO_PROPRIO.porCanal.map((x) => [x.canal, x.valorCentavos]));
  assert.deepEqual([canais.BALCAO, canais.IFOOD, canais.ANOTA_AI], [ESPERADO.balcao, ESPERADO.ifood, ESPERADO.anotaAi]);
  // Visão Geral = mesma apuração.
  const vg = await n.apurarVisaoGeral(c, { competencia: "2026-09" });
  assert.deepEqual([vg.faturamentoBruto.valorCentavos, vg.resultadoGerencial.valorCentavos, vg.impressao], [ESPERADO.bruto, ESPERADO.resultado, ap.impressao]);
  // Cada R$ 100: percentuais somam exatamente 100,00% sobre a mesma base (o bruto).
  assert.equal(ap.cadaCem.grupos.reduce((s, g) => s + g.centesimosDePonto, 0), 10000);
  assert.equal(ap.cadaCem.grupos.reduce((s, g) => s + g.valorCentavos, 0), ESPERADO.bruto);
});

test("B — tesouraria do cenário integrado: recebíveis, obrigações, caixa e banco sem dupla contagem", async () => {
  const { nucleo: n, c } = await cenario();
  assert.equal((await n.consultarContasAReceber(c, {})).totais.saldoCentavos, ESPERADO.recebiveis);
  assert.equal((await n.consultarContasAPagar(c, {})).totais.saldoCentavos, ESPERADO.obrigacoes);
  const set = await n.consultarCaixaEBancos(c, { inicio: "2026-09-01", fim: "2026-09-30" });
  const conta = (cb, tipo) => cb.contas.find((x) => x.tipo === tipo);
  assert.equal(conta(set, "CAIXA_FISICO").saldoFinalCentavos, ESPERADO.caixa);
  assert.equal(conta(set, "BANCARIA").saldoFinalCentavos, ESPERADO.bancoFimSetembro);
  const hoje = await n.consultarCaixaEBancos(c, { inicio: "2026-10-15", fim: "2026-10-15" });
  assert.equal(conta(hoje, "BANCARIA").saldoFinalCentavos, ESPERADO.bancoHoje);
  // Movimentações desconhecidas ficam pendentes; nenhuma vira despesa nem receita.
  assert.ok(set.movimentos.some((m) => m.pendencias.includes("SEM_VINCULO") && m.valorCentavos === 250));
  assert.ok(set.movimentos.some((m) => m.pendencias.includes("SEM_VINCULO") && m.valorCentavos === 50000));
  // Projeção usa só o que está pendente: a parte já paga do fornecedor e do empréstimo não volta a ser saída prevista.
  const fl = await n.consultarFluxoDeCaixa(c, { inicio: "2026-10-15", fim: "2026-12-31", granularidade: "MES" });
  const saidasObrig = fl.previsto.itens.filter((i) => i.registroTipo === "OBRIGACAO").reduce((s, i) => s + i.valorCentavos, 0);
  assert.ok(saidasObrig <= ESPERADO.obrigacoes, "previsto nunca soma de novo o que já foi pago");
  assert.equal(fl.saldoAtualCentavos, ESPERADO.caixa + ESPERADO.bancoHoje);
  assert.deepEqual(await n.verificarConservacao(c), []);
});
