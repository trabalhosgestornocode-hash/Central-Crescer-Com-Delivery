// Execução 04 — motor de indicadores, DRE Gerencial, composição auditável e "cada R$ 100". Dados 100% SINTÉTICOS.
// Memória e PostgreSQL isolado (FV2_REPOSITORIO=postgres).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ORG_B, UNI_A2, UNI_B, ctx, montar } from "./helpers/cenario.js";
import { PERIODO_SETEMBRO, saiposDiarias, saiposVendas } from "./helpers/arquivos.js";
import { faturamentoSaiposPdf } from "./helpers/formatos.js";

const c = ctx();
const SET = { competencia: "2026-09" };
const ACEITE = { aceitarPendencias: true, justificativa: "Pendências sintéticas aceitas." };
let seq = 0;
const venda = (extra) => ({ canal: "BALCAO", dataVenda: "2026-09-05", fonte: { sistema: "MANUAL", idExterno: `V-${(seq += 1)}` }, ...extra });

async function base() {
  const m = montar();
  const n = m.nucleo;
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  const banco = await n.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco Sintético" });
  const forn = await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Fornecedor Sintético" });
  const { documento } = await n.registrarDocumento(c, { origem: "IFOOD", arquivoId: "cofre:sintetico", hashSha256: "b".repeat(64), tipo: "DEMONSTRATIVO_REPASSE", recebidoEm: "2026-10-01" });
  return { ...m, n, caixa, banco, forn, doc: documento.id };
}
/** A soma dos filhos é exatamente o valor do nó, em toda a árvore. */
function confereArvore(no) {
  if (no.filhos?.length) {
    assert.equal(no.filhos.reduce((s, f) => s + f.valorCentavos, 0), no.valorCentavos, `soma dos filhos de ${no.id}`);
    no.filhos.forEach(confereArvore);
  }
}
function confereLinhas(ap) {
  for (const l of ap.dre.linhas) {
    if (l.componentes.length && !l.codigo.startsWith("RECEITA_LIQUIDA") && !l.codigo.startsWith("RESULTADO_APOS") && l.codigo !== "RESULTADO_GERENCIAL") {
      assert.equal(l.componentes.reduce((s, f) => s + f.valorCentavos, 0), l.valorCentavos, l.codigo);
      l.componentes.forEach(confereArvore);
    }
  }
}
const linha = (ap, codigo) => ap.dre.linhas.find((l) => l.codigo === codigo);

test("1–5, 23, 24, 30 — bruto próprio, descontos por financiador, composição exata e percentuais por maior resto", async () => {
  const { n, caixa, doc } = await base();
  await n.registrarVenda(c, venda({ brutoCentavos: 1001, composicao: { itensCentavos: 1001 }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 1001, contaId: caixa.id }] }));
  await n.registrarVenda(c, venda({ brutoCentavos: 2003, composicao: { itensCentavos: 1903, acrescimosCentavos: 100, descontos: [{ valorCentavos: 101, financiador: "LOJA" }] }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 1902, contaId: caixa.id }] }));
  const sub = await n.registrarVenda(c, venda({ brutoCentavos: 1000, composicao: { itensCentavos: 1000, descontos: [{ valorCentavos: 200, financiador: "TERCEIRO", terceiro: "IFOOD", documentoId: doc }] }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 800, contaId: caixa.id }] }));
  const semDireito = await n.registrarVenda(c, venda({ brutoCentavos: 1000, composicao: { itensCentavos: 1000, descontos: [{ valorCentavos: 150, financiador: "TERCEIRO", terceiro: "IFOOD" }] }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 850, contaId: caixa.id }] }));
  await n.registrarVenda(c, venda({ brutoCentavos: 500, composicao: { itensCentavos: 400, servicosCentavos: 100, descontos: [{ valorCentavos: 50, financiador: "PENDENTE" }] }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 450, contaId: caixa.id }] }));
  assert.equal(sub.recebiveis.length, 1); // direito comprovado por documento → recebível do terceiro
  assert.equal(semDireito.recebiveis.length, 0); // sem documento: nada de recebível fictício
  const ap = await n.apurarCompetencia(c, SET);
  const bruto = ap.indicadores.FATURAMENTO_BRUTO_PROPRIO;
  assert.equal(bruto.valorCentavos, 5504);
  assert.deepEqual(bruto.componentesDaReceita, { produtos: 5304, acrescimos: 100, servicos: 100, agregadoSemDetalhe: 0, semComposicao: 0 });
  assert.equal(linha(ap, "DEDUCOES_COMERCIAIS").valorCentavos, -(101 + 150 + 50)); // subsídio comprovado NÃO é dedução
  assert.equal(linha(ap, "DEDUCOES_COMERCIAIS").situacao, "PENDENTE_DE_CLASSIFICACAO");
  assert.equal(ap.pendencias.filter((x) => x.tipo === "DESCONTO_A_CLASSIFICAR").length, 2);
  assert.ok(ap.pendencias.some((x) => x.financiador === "TERCEIRO_NAO_COMPROVADO"));
  assert.equal(bruto.situacao, "PRELIMINAR");
  confereLinhas(ap);
  // Percentuais: cada R$ 100 soma exatamente 100,00% com arredondamento por maior resto.
  assert.equal(ap.cadaCem.grupos.reduce((s, g) => s + g.centesimosDePonto, 0), 10000);
  assert.equal(ap.cadaCem.grupos.find((g) => g.codigo === "DEDUCOES_COMERCIAIS").percentual, "5,47%"); // 301 / 5504 = 5,4687… → 5,47 (maior resto)
});

test("6, 7, 8, 26 — taxas uma única vez: DRE, líquido por canal e Visão Geral coerentes", async () => {
  const { n } = await base();
  const balcao = await n.registrarVenda(c, venda({ brutoCentavos: 4000, composicao: { itensCentavos: 4000 }, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 4000 }] }));
  await n.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: balcao.recebiveis[0].id, valorCentavos: -120, motivo: "Taxa Stone", categoria: "TAXAS_STONE" });
  const ifood = await n.registrarVenda(c, venda({ canal: "IFOOD", brutoCentavos: 6000, composicao: { itensCentavos: 6000, descontos: [{ valorCentavos: 300, financiador: "LOJA" }] }, pagamentos: [{ forma: "OUTRA", processador: "IFOOD", valorCentavos: 5700 }] }));
  for (const [cat, v] of [["COMISSOES_IFOOD", 700], ["TAXAS_DE_PROCESSAMENTO", 150], ["ANUNCIOS_IFOOD", 200], ["MENSALIDADE_IFOOD", 100]]) {
    await n.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: ifood.recebiveis[0].id, valorCentavos: -v, motivo: cat, categoria: cat });
  }
  const forn = await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Fornecedor" });
  await n.registrarObrigacao(c, { contraparteId: forn.id, valorOriginalCentavos: 2000, categoria: "INSUMOS", descricao: "Insumos", competencia: "2026-09", dataEmissao: "2026-09-02", vencimento: "2026-09-20" });
  const ap = await n.apurarCompetencia(c, SET);
  assert.equal(linha(ap, "DESPESAS_OPERACIONAIS").valorCentavos, -(120 + 700 + 150 + 200 + 100));
  assert.equal(ap.indicadores.RESULTADO_GERENCIAL.valorCentavos, 10000 - 300 - 2000 - 1270);
  const liq = Object.fromEntries(ap.indicadores.FATURAMENTO_LIQUIDO_GERENCIAL.porCanal.map((x) => [x.canal, x]));
  assert.equal(liq.IFOOD.liquidoGerencialCentavos, 6000 - 300 - 1150);
  assert.equal(liq.BALCAO.liquidoGerencialCentavos, 4000 - 120);
  // Sem dupla contagem: resultado = Σ líquidos dos canais − despesas sem canal (os insumos).
  assert.equal(ap.indicadores.RESULTADO_GERENCIAL.valorCentavos, Object.values(liq).reduce((s, x) => s + x.liquidoGerencialCentavos, 0) - 2000);
  assert.equal(ap.indicadores.FATURAMENTO_LIQUIDO_GERENCIAL.reconciliacaoComRepasses.porProcessador.IFOOD.ajustesCentavos, -1150);
  const vg = await n.apurarVisaoGeral(c, SET);
  assert.equal(vg.faturamentoBruto.valorCentavos, linha(ap, "FATURAMENTO_BRUTO_PROPRIO").valorCentavos);
  assert.equal(vg.resultadoGerencial.valorCentavos, ap.indicadores.RESULTADO_GERENCIAL.valorCentavos);
  assert.equal(vg.impressao, ap.impressao);
  confereLinhas(ap);
});

test("9, 10, 15, 17, 18 — recebimento não é receita, pagamento não é despesa, recebível não é saldo; motoboys devido × pago entre competências", async () => {
  const { n, banco } = await base();
  const v = await n.registrarVenda(c, venda({ brutoCentavos: 3000, composicao: { itensCentavos: 3000 }, pagamentos: [{ forma: "DEBITO", processador: "STONE", valorCentavos: 3000 }] }));
  const forn = await n.registrarContraparte(c, { tipo: "PRESTADOR", nome: "Entregador Sintético" });
  const ob = await n.registrarObrigacao(c, { contraparteId: forn.id, valorOriginalCentavos: 1400, categoria: "ENTREGADORES_PROPRIOS", descricao: "Entregas de setembro", competencia: "2026-09", dataEmissao: "2026-09-30", vencimento: "2026-09-30" });
  await n.registrarObrigacao(c, { contraparteId: forn.id, valorOriginalCentavos: 900, categoria: "INSUMOS", descricao: "Compra sem pagamento", competencia: "2026-09", dataEmissao: "2026-09-10", vencimento: "2026-10-10" });
  const antes = await n.apurarCompetencia(c, SET);
  const credito = await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-09-06", sentido: "ENTRADA", valorCentavos: 3000, natureza: "RECEBIMENTO" });
  await n.registrarLiquidacao(c, { movimentacaoId: credito.movimentacao.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: v.recebiveis[0].id, valorCentavos: 3000 }] });
  const pix = await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-10-05", sentido: "SAIDA", valorCentavos: 1000, natureza: "PAGAMENTO" });
  await n.registrarLiquidacao(c, { movimentacaoId: pix.movimentacao.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: ob.obrigacoes[0].id, valorCentavos: 1000 }] });
  const depois = await n.apurarCompetencia(c, SET);
  assert.equal(depois.indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, antes.indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos);
  assert.equal(depois.indicadores.RESULTADO_GERENCIAL.valorCentavos, 3000 - 1400 - 900); // despesa sem pagamento conta; pagamento não duplica
  assert.equal((await n.apurarCompetencia(c, { competencia: "2026-10" })).indicadores.RESULTADO_GERENCIAL.valorCentavos, null); // outubro sem lançamentos: desconhecido, não zero
  const motoboys = JSON.stringify(linha(depois, "DESPESAS_OPERACIONAIS").componentes);
  assert.ok(motoboys.includes("Entregadores Próprios (Motoboys)"));
  const folha = linha(depois, "DESPESAS_OPERACIONAIS").componentes.flatMap((x) => x.filhos).flatMap((x) => (x.filhos.length ? x.filhos : [x])).find((x) => x.detalhe?.obrigacoes);
  assert.deepEqual(folha.detalhe.obrigacoes.map((o) => [o.valorReconhecidoCentavos, o.pagoCentavos, o.saldoCentavos]), [[1400, 1000, 400]]);
});

async function agregados() {
  const ctxBase = await base();
  const { n, caixa } = ctxBase;
  const importar = async (fonte, tipoRelatorio, conteudo, periodo) => {
    const r = await n.receberArquivoParaImportacao(c, { fonte, tipoRelatorio, tipoMime: "application/octet-stream", conteudo, ...periodo });
    return (await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? ACEITE : {}) })).importacao;
  };
  const agr = await importar("SAIPOS", "SAIPOS_FATURAMENTO_POR_DIA", faturamentoSaiposPdf([{ data: "01/09/2026", valor: 9500, desconto: 500 }, { data: "02/09/2026", valor: 5000, desconto: 0 }]), { periodoInicio: "2026-09-01", periodoFim: "2026-09-02" });
  await n.gerarPropostas(c, { importacaoId: agr.id });
  for (const p of await n.listarPropostas(c, { operacao: "VENDA_AGREGADA" })) { await n.aprovarProposta(c, { propostaId: p.id }); await n.aplicarProposta(c, { propostaId: p.id }); }
  return { ...ctxBase, importar, caixa };
}

test("11, 12, 13, 14 — agregado comprovado sem canal; agregado desconhecido deixa o bruto PARCIAL; substituição remove o sem-canal", async () => {
  const { n, importar, caixa } = await agregados();
  await n.registrarVenda(c, venda({ canal: "IFOOD", dataVenda: "2026-09-03", brutoCentavos: 2000, composicao: { itensCentavos: 2000 }, pagamentos: [{ forma: "OUTRA", processador: "IFOOD", valorCentavos: 2000 }] }));
  let ap = await n.apurarCompetencia(c, SET);
  const canais = Object.fromEntries(ap.indicadores.FATURAMENTO_BRUTO_PROPRIO.porCanal.map((x) => [x.canal, x]));
  assert.equal(canais.NAO_IDENTIFICADO.valorCentavos, 10000 + 5000);
  assert.equal(canais.NAO_IDENTIFICADO.comprovado, false);
  assert.equal(canais.BALCAO.valorCentavos, 0); // o sem-canal NÃO vira Balcão por exclusão
  assert.equal(canais.IFOOD.valorCentavos, 2000);
  assert.equal(linha(ap, "DEDUCOES_COMERCIAIS").valorCentavos, -500); // desconto do agregado deduzido uma única vez
  assert.equal(ap.indicadores.FATURAMENTO_BRUTO_PROPRIO.componentesDaReceita.agregadoSemDetalhe, 15000);
  // Agregado com metodologia desconhecida: só controle → o bruto fica PARCIAL (não zero, não confirmado).
  const desconhecido = await importar("SAIPOS", "SAIPOS_VENDAS_DIARIAS", saiposDiarias([["04/09/2026", 3, 7000]]), { periodoInicio: "2026-09-04", periodoFim: "2026-09-04" });
  await n.gerarPropostas(c, { importacaoId: desconhecido.id });
  ap = await n.apurarCompetencia(c, SET);
  assert.equal(ap.indicadores.FATURAMENTO_BRUTO_PROPRIO.situacao, "PARCIAL");
  assert.ok(ap.pendencias.some((x) => x.tipo === "VENDA_NAO_APLICADA" && x.valorCentavos === 7000));
  // Substituição do dia 02 pelos pedidos: o sem-canal daquele dia sai, os pedidos entram com canal.
  const ped = await importar("SAIPOS", "SAIPOS_VENDAS", saiposVendas([{ pedido: "P-1", data: "02/09/2026 12:00", canal: "Balcão", itens: 5000, forma: "Dinheiro" }]), PERIODO_SETEMBRO);
  await n.gerarPropostas(c, { importacaoId: ped.id, contaCaixaId: caixa.id });
  const [pp] = await n.listarPropostas(c, { operacao: "VENDA" });
  await n.aprovarProposta(c, { propostaId: pp.id });
  const dia2 = (await n.listarPropostas(c, { operacao: "VENDA_AGREGADA", estado: "APLICADA" })).find((x) => x.dataOperacao === "2026-09-02");
  await n.substituirAgregadoPorPedidos(c, { propostaAgregadaId: dia2.id, propostaIds: [pp.id], justificativa: "Pedidos do dia disponíveis." });
  ap = await n.apurarCompetencia(c, SET);
  const c2 = Object.fromEntries(ap.indicadores.FATURAMENTO_BRUTO_PROPRIO.porCanal.map((x) => [x.canal, x]));
  assert.equal(c2.NAO_IDENTIFICADO.valorCentavos, 10000);
  assert.equal(c2.BALCAO.valorCentavos, 5000);
  assert.ok(!ap.pendencias.some((x) => x.tipo === "SOBREPOSICAO_AGREGADO_PEDIDOS"));
});

test("16 — parcela de empréstimo: principal fora do resultado, juros no resultado financeiro", async () => {
  const { n } = await base();
  await n.registrarVenda(c, venda({ brutoCentavos: 5000, composicao: { itensCentavos: 5000 }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 5000 }] }));
  const banco = await n.registrarContraparte(c, { tipo: "OUTRO", nome: "Instituição Sintética" });
  await n.registrarObrigacao(c, { contraparteId: banco.id, valorOriginalCentavos: 10000, categoria: "EMPRESTIMOS_E_FINANCIAMENTOS", descricao: "Principal da parcela", competencia: "2026-09", dataEmissao: "2026-09-05", vencimento: "2026-09-05" });
  await n.registrarObrigacao(c, { contraparteId: banco.id, valorOriginalCentavos: 500, categoria: "JUROS_E_TARIFAS_BANCARIAS", descricao: "Juros da parcela", competencia: "2026-09", dataEmissao: "2026-09-05", vencimento: "2026-09-05" });
  const ap = await n.apurarCompetencia(c, SET);
  assert.equal(linha(ap, "RESULTADO_FINANCEIRO").valorCentavos, -500);
  assert.equal(ap.indicadores.RESULTADO_GERENCIAL.valorCentavos, 4500);
  assert.equal(ap.dre.foraDoResultado.patrimoniais[0].valorCentavos, 10000);
});

test("19, 20 — cancelamento e estorno compensam; saída sem classificação deixa o resultado PENDENTE", async () => {
  const { n, caixa, banco } = await base();
  const r = await n.registrarVenda(c, venda({ brutoCentavos: 3000, composicao: { itensCentavos: 3000, descontos: [{ valorCentavos: 300, financiador: "LOJA" }] }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 2700, contaId: caixa.id }] }));
  await n.estornarPagamentoDeVenda(c, { pagamentoId: r.pagamentos[0].id, valorCentavos: 700, motivo: "DEVOLUCAO_AO_CLIENTE", justificativa: "Item devolvido", contaId: caixa.id, dataEfetiva: "2026-09-06" });
  const v2 = await n.registrarVenda(c, venda({ brutoCentavos: 1000, composicao: { itensCentavos: 1000 }, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 1000 }] }));
  await n.cancelarVenda(c, { vendaId: v2.venda.id, justificativa: "Cancelado" });
  let ap = await n.apurarCompetencia(c, SET);
  assert.equal(ap.indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, 3000);
  assert.equal(linha(ap, "DEDUCOES_COMERCIAIS").valorCentavos, -(300 + 700));
  assert.equal(ap.indicadores.RESULTADO_GERENCIAL.situacao, "PRELIMINAR");
  await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-09-08", sentido: "SAIDA", valorCentavos: 450, natureza: "PAGAMENTO" });
  ap = await n.apurarCompetencia(c, SET);
  assert.equal(ap.indicadores.RESULTADO_GERENCIAL.situacao, "PENDENTE_DE_CLASSIFICACAO");
  assert.equal(ap.indicadores.RESULTADO_GERENCIAL.valorCentavos, 3000 - 1000); // a saída NÃO vira despesa por suposição
  assert.equal(ap.indicadores.FATURAMENTO_BRUTO_PROPRIO.situacao, "PRELIMINAR"); // só o que é afetado fica pendente
});

test("21, 22, 25 — sem registros é desconhecido (não zero); faturamento zero sem percentuais; prejuízo como parte negativa", async () => {
  const { n, forn } = await base();
  let ap = await n.apurarCompetencia(c, SET);
  assert.equal(ap.indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, null);
  assert.equal(ap.indicadores.FATURAMENTO_BRUTO_PROPRIO.situacao, "BLOQUEADO_POR_EVIDENCIA_INSUFICIENTE");
  assert.ok(ap.cadaCem.limitacao);
  await n.registrarObrigacao(c, { contraparteId: forn.id, valorOriginalCentavos: 1500, categoria: "INSUMOS", descricao: "Compra", competencia: "2026-09", dataEmissao: "2026-09-02", vencimento: "2026-09-20" });
  ap = await n.apurarCompetencia(c, SET);
  assert.equal(ap.indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, 0); // há registros: zero calculado
  assert.equal(ap.cadaCem.grupos[0].percentual, null);
  assert.match(ap.cadaCem.limitacao, /zero/);
  await n.registrarVenda(c, venda({ brutoCentavos: 1000, composicao: { itensCentavos: 1000 }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 1000 }] }));
  ap = await n.apurarCompetencia(c, SET);
  assert.equal(ap.indicadores.RESULTADO_GERENCIAL.valorCentavos, -500);
  assert.equal(ap.cadaCem.prejuizo, true);
  const g = Object.fromEntries(ap.cadaCem.grupos.map((x) => [x.codigo, x.percentual]));
  assert.equal(g.CUSTOS_OPERACIONAIS, "150,00%");
  assert.equal(g.RESULTADO_GERENCIAL, "-50,00%");
  assert.equal(ap.cadaCem.grupos.reduce((s, x) => s + x.centesimosDePonto, 0), 10000);
  // Indicador PARCIAL: venda proposta e não aplicada.
  const imp = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", ...PERIODO_SETEMBRO, conteudo: saiposVendas([{ pedido: "P-9", data: "02/09/2026 12:00", itens: 800, forma: "Dinheiro" }]) });
  const conf = await n.confirmarImportacao(c, { importacaoId: imp.importacao.id, impressaoPrevia: imp.importacao.impressaoPrevia });
  await n.gerarPropostas(c, { importacaoId: conf.importacao.id });
  assert.equal((await n.apurarCompetencia(c, SET)).indicadores.FATURAMENTO_BRUTO_PROPRIO.situacao, "PARCIAL");
});

test("27, 28, 29 — reprodutível, CONFIRMADO só na competência homologada sem pendências, isolado por escopo", async () => {
  const { n } = await base();
  await n.registrarVenda(c, venda({ brutoCentavos: 2500, composicao: { itensCentavos: 2500 }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 2500 }] }));
  const a1 = await n.apurarCompetencia(c, SET);
  const a2 = await n.apurarCompetencia(c, SET);
  assert.equal(a1.impressao, a2.impressao);
  assert.deepEqual(a1.dre.linhas.map((l) => l.valorCentavos), a2.dre.linhas.map((l) => l.valorCentavos));
  assert.equal((await n.composicaoDoIndicador(c, { ...SET, codigo: "FATURAMENTO_BRUTO_PROPRIO" })).valorCentavos, 2500);
  await n.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_PRELIMINAR" });
  await n.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Homologação sintética." });
  const h = await n.apurarCompetencia(c, SET);
  assert.equal(h.indicadores.RESULTADO_GERENCIAL.situacao, "CONFIRMADO");
  assert.notEqual(h.impressao, undefined);
  assert.equal((await n.apurarCompetencia(ctx(undefined, UNI_A2), SET)).indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, null);
  assert.equal((await n.apurarCompetencia(ctx(ORG_B, UNI_B), SET)).indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, null);
});

test("sobreposição agregado × pedidos (dados inconsistentes injetados no motor puro) bloqueia o faturamento", async () => {
  const { apurar } = await import("../../src/modules/financeiro-v2/index.js");
  const l = (id, extra) => ({ id, versao: 1, situacao: "ATIVO", competencia: "2026-09", natureza: "RECEITA", classificacao: "RECEITA_OPERACIONAL", categoria: "VENDA_BALCAO", valorCentavos: 1000, dataOperacao: "2026-09-02", ...extra });
  const dados = {
    lancamentos: [l("a", { canal: null, categoria: "VENDAS_AGREGADAS_SEM_CANAL", origem: { tipo: "PROPOSTA", id: "p" } }), l("b", { canal: "BALCAO", origem: { tipo: "VENDA", id: "v" } })],
    categorias: [], vendas: [], propostas: [], obrigacoes: [], movimentacoes: [], recebiveis: [], ajustes: [], competencias: [],
  };
  const ap = apurar(dados, { competencia: "2026-09", escopo: { organizacaoId: "o", unidadeId: "u" }, apuradoEm: "2026-10-01T00:00:00.000Z" });
  assert.equal(ap.indicadores.FATURAMENTO_BRUTO_PROPRIO.situacao, "BLOQUEADO_POR_EVIDENCIA_INSUFICIENTE");
  assert.ok(ap.pendencias.some((x) => x.tipo === "SOBREPOSICAO_AGREGADO_PEDIDOS"));
});
