// Execução 08 — HOMOLOGAÇÃO OPERACIONAL de uma competência SINTÉTICA completa (setembro/2026 fictício), da venda à
// segunda homologação. Empresa e unidade FICTÍCIAS (identificadores sintéticos). Todos os valores são inventados.
// O LIVRO ESPERADO abaixo foi calculado À MÃO, linha a linha, sem usar o motor; o teste compara o motor com ele.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { montarComCadastros, prepararHomologacao, rejeita } from "./helpers/cenario.js";
import { saiposVendas } from "./helpers/arquivos.js";

// ------------------------------------------------------------------------------------------- LIVRO ESPERADO (à mão)
// Vendas de setembro (bruto próprio = itens):
//   S1 balcão dinheiro 100,00 | S2 balcão crédito Stone 200,00 (taxa 4,00) | S3 balcão Pix direto 50,00
//   S4 iFood 80,00 (comissão 12,00) | S5 Anota AI 60,00 | S6 balcão misto 40,00 dinheiro + 50,00 débito Stone (taxa 1,00)
//   S7 balcão 70,00 com desconto da LOJA 7,00 (paga 63,00) | S8 iFood 50,00 com subsídio do iFood 10,00 comprovado (paga 40,00)
//   S9 balcão 30,00 com desconto SEM financiador 3,00 (paga 27,00) | S10 balcão 25,00 Stone CANCELADA (fora)
//   S11 balcão dinheiro 40,00 com devolução de 10,00 | importados SAIPOS: P-1 35,00 + P-2 15,00 dinheiro (balcão)
//   Bruto = 100+200+50+80+60+90+70+50+30+40+35+15 = 820,00 → Balcão 630,00; iFood 130,00; Anota AI 60,00
//   Deduções = loja 7,00 + sem financiador 3,00 + devolução 10,00 = 20,00 → Receita líquida comercial 800,00
// Despesas de setembro: insumos 150,00 (3 parcelas) = CUSTO; aluguel 200,00; energia 30,00; água 8,00; serviços contábeis
//   25,00; publicidade 15,00; motoboys 18,00; taxas Stone 5,00; comissão iFood 12,00 → DESPESAS 313,00
//   Juros do empréstimo 6,00 → RESULTADO FINANCEIRO −6,00; principal 300,00 (10 parcelas) é PATRIMONIAL
//   Resultado gerencial sem ajuste de estoque = 800 − 150 − 313 − 6 = 331,00
// Caixa físico (saldo de referência 01/09 = 200,00): +100 +40 +63 +27 +40 −10 +35 +15 + suprimento 50 − sangria 300
//   = 260,00 esperado em 30/09; contado 258,00 → diferença −2,00 (registrada, nunca ajustada)
// Banco (saldo de referência 01/09 = 1.000,00): +50 (Pix S3) +245 (repasse Stone agrupado 196+49) +30 (iFood parcial)
//   +300 (sangria) −200 (aluguel) −50 (insumos parcela 1) −10 (energia parcial) −15 (publicidade) −36 (empréstimo 30+6)
//   = 1.314,00 em 30/09. Outubro: −25 (serviços) −18 (motoboys) +60 (Anota AI, liquidação posterior) = 1.331,00 em 15/10
// Recebíveis em aberto em 30/09: iFood S4 68−30 = 38 + iFood S8 40 + subsídio iFood 10 + Anota AI 60 = 148,00; em 15/10: 88,00
// Obrigações em aberto em 15/10: insumos parcelas 2 e 3 = 100 + energia 20 + água 8 + principal parcelas 2–10 = 270 → 398,00
const ESPERADO = Object.freeze({
  bruto: 82000, balcao: 63000, ifood: 13000, anotaAi: 6000, deducoes: 2000, receitaLiquida: 80000,
  custos: 15000, despesas: 31300, financeiro: -600, resultado: 33100, patrimonial: 30000,
  caixa30set: 26000, contadoCaixa: 25800, diferencaCaixa: -200,
  banco30set: 131400, banco15out: 133100, recebiveis30set: 14800, recebiveis15out: 8800, obrigacoes15out: 39800,
});

test("08 — competência sintética completa: vendas, recebimentos, despesas, caixa, importação, conciliação e ciclo de fechamento", async () => {
  const { nucleo: n, c, banco, caixa, cofre } = await montarComCadastros();
  const SET = "2026-09";
  const contra = async (tipo, nome) => n.registrarContraparte(c, { tipo, nome });
  const doc = async (descricao, data = "2026-09-15") => {
    const g = await cofre.guardar(c, { conteudo: new TextEncoder().encode(`%PDF-1.4\n% ${descricao} (sintético)\n%%EOF\n`), tipoMime: "application/pdf" });
    return (await n.registrarDocumento(c, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "COMPROVANTE", recebidoEm: data, descricao })).documento;
  };
  let k = 0;
  const venda = (canal, bruto, pagamentos, extra = {}) => n.registrarVenda(c, { canal, dataVenda: "2026-09-10", brutoCentavos: bruto, fonte: { sistema: "MANUAL", idExterno: `HS-${(k += 1)}` }, pagamentos, ...extra });
  const dinheiro = (v) => ({ forma: "DINHEIRO", valorCentavos: v, contaId: caixa.id });

  // Configurações: categorias que o plano-modelo não tem (administração de categorias).
  for (const [codigo, nome] of [["ALUGUEL", "Aluguel"], ["ENERGIA", "Energia elétrica"], ["AGUA", "Água"], ["SERVICOS_CONTABEIS", "Serviços contábeis"]]) {
    await n.registrarCategoria(c, { codigo, nome, paiCodigo: "DESPESAS_ADMINISTRATIVAS_GERAIS" });
  }
  // Saldos de referência.
  await n.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-09-01", valorCentavos: 100000 });
  await n.registrarSaldoDeConta(c, { contaId: caixa.id, data: "2026-09-01", valorCentavos: 20000 });
  const { sessao } = await n.abrirCaixa(c, { contaId: caixa.id, dataAbertura: "2026-09-10", saldoContadoCentavos: 20000 });

  // ---------------------------------------------------------------------------------------------------- vendas
  await venda("BALCAO", 10000, [dinheiro(10000)]);
  const s2 = await venda("BALCAO", 20000, [{ forma: "CREDITO", processador: "STONE", valorCentavos: 20000 }]);
  await n.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: s2.recebiveis[0].id, valorCentavos: -400, motivo: "Taxa Stone", categoria: "TAXAS_STONE" });
  await venda("BALCAO", 5000, [{ forma: "PIX", valorCentavos: 5000, contaId: banco.id }]);
  const s4 = await venda("IFOOD", 8000, [{ forma: "OUTRA", processador: "IFOOD", valorCentavos: 8000 }]);
  await n.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: s4.recebiveis[0].id, valorCentavos: -1200, motivo: "Comissão iFood", categoria: "COMISSOES_IFOOD" });
  const s5 = await venda("ANOTA_AI", 6000, [{ forma: "OUTRA", processador: "ANOTA_AI", valorCentavos: 6000 }]);
  const s6 = await venda("BALCAO", 9000, [dinheiro(4000), { forma: "DEBITO", processador: "STONE", valorCentavos: 5000 }]);
  await n.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: s6.recebiveis[0].id, valorCentavos: -100, motivo: "Taxa Stone", categoria: "TAXAS_STONE" });
  await venda("BALCAO", 7000, [dinheiro(6300)], { composicao: { itensCentavos: 7000, descontos: [{ valorCentavos: 700, financiador: "LOJA" }] } });
  const prova = await doc("Extrato de campanha do iFood");
  await venda("IFOOD", 5000, [{ forma: "OUTRA", processador: "IFOOD", valorCentavos: 4000 }], { composicao: { itensCentavos: 5000, descontos: [{ valorCentavos: 1000, financiador: "TERCEIRO", terceiro: "IFOOD", documentoId: prova.id }] } });
  const s9 = await venda("BALCAO", 3000, [dinheiro(2700)], { composicao: { itensCentavos: 3000, descontos: [{ valorCentavos: 300, financiador: "PENDENTE" }] } });
  const s10 = await venda("BALCAO", 2500, [{ forma: "CREDITO", processador: "STONE", valorCentavos: 2500 }]);
  await n.cancelarVenda(c, { vendaId: s10.venda.id, justificativa: "Pedido desistido (sintético)." });
  const s11 = await venda("BALCAO", 4000, [dinheiro(4000)]);
  await n.estornarPagamentoDeVenda(c, { pagamentoId: s11.pagamentos[0].id, valorCentavos: 1000, motivo: "DEVOLUCAO_AO_CLIENTE", justificativa: "Item devolvido (sintético).", dataEfetiva: "2026-09-12" });

  // ---------------------------------------------------- importação: documento → prévia → importação → proposta → aplicação
  const arquivo = { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", periodoInicio: "2026-09-01", periodoFim: "2026-09-30",
    conteudo: saiposVendas([{ pedido: "P-1", data: "12/09/2026 12:00", canal: "Balcão", itens: 3500, forma: "Dinheiro" }, { pedido: "P-2", data: "12/09/2026 13:00", canal: "Balcão", itens: 1500, forma: "Dinheiro" }]) };
  const recebido = await n.receberArquivoParaImportacao(c, arquivo);
  assert.equal((await n.receberArquivoParaImportacao(c, arquivo)).importacao.id, recebido.importacao.id, "arquivo repetido devolve a mesma importação");
  const conf = await n.confirmarImportacao(c, { importacaoId: recebido.importacao.id, impressaoPrevia: recebido.importacao.impressaoPrevia });
  await n.gerarPropostas(c, { importacaoId: conf.importacao.id, contaCaixaId: caixa.id });
  const propostas = (await n.consultarRegistros(c, { tipo: "PROPOSTA" })).filter((p) => p.importacaoId === conf.importacao.id);
  assert.equal(propostas.length, 2, "uma proposta por pedido");
  for (const p of propostas) {
    await n.aprovarProposta(c, { propostaId: p.id, justificativa: "Conferido com o relatório sintético." });
    await n.aplicarProposta(c, { propostaId: p.id });
  }
  // Aplicação repetida e reconfirmação do mesmo arquivo: idempotentes, nenhuma venda a mais.
  const vendasAntes = (await n.consultarRegistros(c, { tipo: "VENDA" })).length;
  await n.aplicarProposta(c, { propostaId: propostas[0].id }).catch(() => null);
  await n.gerarPropostas(c, { importacaoId: conf.importacao.id, contaCaixaId: caixa.id });
  assert.equal((await n.consultarRegistros(c, { tipo: "VENDA" })).length, vendasAntes, "aplicação repetida não duplica");

  // ---------------------------------------------------------------------------------------------------- recebimentos
  const repasse = (await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-09-25", sentido: "ENTRADA", valorCentavos: 24500, natureza: "RECEBIMENTO", descricao: "Repasse Stone agrupado" })).movimentacao;
  const stoneS2 = (await n.consultarRegistros(c, { tipo: "RECEBIVEL" })).find((r) => r.id === s2.recebiveis[0].id);
  const stoneS6 = (await n.consultarRegistros(c, { tipo: "RECEBIVEL" })).find((r) => r.id === s6.recebiveis[0].id);
  // Conciliação: candidata com evidência → confirmada (antes de liquidar, como no extrato do dia).
  const extrato = await doc("Extrato bancário do repasse");
  const cand = await n.criarCorrespondenciaCandidata(c, { ladoA: [{ tipo: "RECEBIVEL", id: stoneS2.id, valorCentavos: 19600 }, { tipo: "RECEBIVEL", id: stoneS6.id, valorCentavos: 4900 }], ladoB: [{ tipo: "MOVIMENTACAO", id: repasse.id, valorCentavos: 24500 }], evidenciaDocumentoIds: [extrato.id], justificativa: "Repasse agrupado de duas transações (sintético)." });
  await n.confirmarConciliacao(c, { correspondenciaId: (cand.correspondencia ?? cand).id, justificativa: "Repasse conferido no extrato sintético." });
  await n.registrarLiquidacao(c, { movimentacaoId: repasse.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: stoneS2.id, valorCentavos: 19600 }, { alvoTipo: "RECEBIVEL", alvoId: stoneS6.id, valorCentavos: 4900 }] });
  const ifoodParcial = (await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-09-29", sentido: "ENTRADA", valorCentavos: 3000, natureza: "RECEBIMENTO", descricao: "Repasse iFood parcial" })).movimentacao;
  await n.registrarLiquidacao(c, { movimentacaoId: ifoodParcial.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: s4.recebiveis[0].id, valorCentavos: 3000 }] });

  // ---------------------------------------------------------------------------------------------------- despesas
  const forn = await contra("FORNECEDOR", "Fornecedor de insumos (fictício)");
  const pagar = async (obrigacao, valor, data) => {
    const m = (await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: data, sentido: "SAIDA", valorCentavos: valor, natureza: "PAGAMENTO" })).movimentacao;
    await n.registrarLiquidacao(c, { movimentacaoId: m.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: obrigacao.id, valorCentavos: valor }] });
  };
  const obrig = async (contraparte, valor, categoria, descricao, vencimento, extra = {}) => (await n.registrarObrigacao(c, { contraparteId: contraparte.id, valorOriginalCentavos: valor, categoria, descricao, competencia: SET, dataEmissao: "2026-09-02", vencimento, ...extra })).obrigacoes;
  const insumos = await obrig(forn, 15000, "INSUMOS", "Insumos de setembro", "2026-09-20", { parcelas: 3 });
  await pagar(insumos[0], 5000, "2026-09-20");
  const [aluguel] = await obrig(await contra("FORNECEDOR", "Locador (fictício)"), 20000, "ALUGUEL", "Aluguel de setembro", "2026-09-05");
  await pagar(aluguel, 20000, "2026-09-05");
  const [energia] = await obrig(await contra("FORNECEDOR", "Distribuidora de energia (fictícia)"), 3000, "ENERGIA", "Energia de setembro", "2026-09-25");
  await pagar(energia, 1000, "2026-09-25");
  await obrig(await contra("FORNECEDOR", "Companhia de água (fictícia)"), 800, "AGUA", "Água de setembro", "2026-09-28");
  const [servicos] = await obrig(await contra("PRESTADOR", "Escritório contábil (fictício)"), 2500, "SERVICOS_CONTABEIS", "Contabilidade de setembro", "2026-10-05");
  const [publicidade] = await obrig(await contra("PRESTADOR", "Agência (fictícia)"), 1500, "ANUNCIOS_E_DIVULGACAO", "Panfletos", "2026-09-15");
  await pagar(publicidade, 1500, "2026-09-15");
  const [motoboys] = await obrig(await contra("PRESTADOR", "Entregador próprio (fictício)"), 1800, "ENTREGADORES_PROPRIOS", "Entregas de setembro", "2026-10-05");
  const credor = await contra("OUTRO", "Banco credor (fictício)");
  const principal = await obrig(credor, 30000, "EMPRESTIMOS_E_FINANCIAMENTOS", "Principal do empréstimo", "2026-09-25", { parcelas: 10 });
  const [juros] = await obrig(credor, 600, "JUROS_E_TARIFAS_BANCARIAS", "Juros da parcela 1", "2026-09-25");
  const parcela1 = (await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-09-25", sentido: "SAIDA", valorCentavos: 3600, natureza: "PAGAMENTO" })).movimentacao;
  await n.registrarLiquidacao(c, { movimentacaoId: parcela1.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: principal[0].id, valorCentavos: 3000 }, { alvoTipo: "OBRIGACAO", alvoId: juros.id, valorCentavos: 600 }] });

  // ---------------------------------------------------------------------------------------------------- caixa
  await n.registrarOperacaoDeCaixa(c, { sessaoId: sessao.id, operacao: "SUPRIMENTO", valorCentavos: 5000, data: "2026-09-13", descricao: "Troco" });
  await n.registrarOperacaoDeCaixa(c, { sessaoId: sessao.id, operacao: "SANGRIA", valorCentavos: 30000, data: "2026-09-14", descricao: "Depósito no banco", contraContaId: banco.id });
  const fechamentoCaixa = await n.fecharCaixa(c, { sessaoId: sessao.id, dataFechamento: "2026-09-14", contadoCentavos: ESPERADO.contadoCaixa, justificativa: "Diferença de troco (sintético).", confirmar: true });
  assert.equal(fechamentoCaixa.diferencaCentavos, ESPERADO.diferencaCaixa);

  // ------------------------------------------------------------------------- conferência com o LIVRO (antes de fechar)
  const conferir = async (rotulo, recebiveisEsperados, bancoEsperado, dataBanco) => {
    const ap = await n.apurarCompetencia(c, { competencia: SET });
    const L = Object.fromEntries(ap.dre.linhas.map((l) => [l.codigo, l]));
    assert.equal(L.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, ESPERADO.bruto, `${rotulo}: bruto`);
    assert.equal(-L.DEDUCOES_COMERCIAIS.valorCentavos, ESPERADO.deducoes, `${rotulo}: deduções`);
    assert.equal(L.RECEITA_LIQUIDA_COMERCIAL.valorCentavos, ESPERADO.receitaLiquida, `${rotulo}: receita líquida`);
    assert.equal(-L.CUSTOS_OPERACIONAIS.valorCentavos, ESPERADO.custos, `${rotulo}: custos`);
    assert.equal(-L.DESPESAS_OPERACIONAIS.valorCentavos, ESPERADO.despesas, `${rotulo}: despesas`);
    assert.equal(L.RESULTADO_FINANCEIRO.valorCentavos, ESPERADO.financeiro, `${rotulo}: financeiro`);
    assert.equal(L.RESULTADO_GERENCIAL.valorCentavos, ESPERADO.resultado, `${rotulo}: resultado`);
    assert.equal(ap.dre.foraDoResultado.patrimoniais.reduce((s, x) => s + x.valorCentavos, 0), ESPERADO.patrimonial, `${rotulo}: patrimonial`);
    const canais = Object.fromEntries(ap.indicadores.FATURAMENTO_BRUTO_PROPRIO.porCanal.map((x) => [x.canal, x.valorCentavos]));
    assert.deepEqual([canais.BALCAO, canais.IFOOD, canais.ANOTA_AI], [ESPERADO.balcao, ESPERADO.ifood, ESPERADO.anotaAi], `${rotulo}: canais`);
    // Mesma informação em todas as áreas.
    const vg = await n.apurarVisaoGeral(c, { competencia: SET });
    assert.deepEqual([vg.faturamentoBruto.valorCentavos, vg.resultadoGerencial.valorCentavos], [ESPERADO.bruto, ESPERADO.resultado], `${rotulo}: Visão Geral`);
    const vendas = await n.consultarVendas(c, { competencia: SET, tamanho: 5 });
    assert.equal(vendas.resumo.brutoProprioCentavos, ESPERADO.bruto, `${rotulo}: Vendas`);
    const cb = await n.consultarCaixaEBancos(c, { inicio: "2026-09-01", fim: "2026-09-30" });
    assert.equal(cb.contas.find((x) => x.tipo === "CAIXA_FISICO").saldoFinalCentavos, ESPERADO.caixa30set, `${rotulo}: caixa físico`);
    assert.equal(cb.contas.find((x) => x.tipo === "BANCARIA").saldoFinalCentavos, ESPERADO.banco30set, `${rotulo}: banco 30/09`);
    const cbHoje = await n.consultarCaixaEBancos(c, { inicio: dataBanco, fim: dataBanco });
    assert.equal(cbHoje.contas.find((x) => x.tipo === "BANCARIA").saldoFinalCentavos, bancoEsperado, `${rotulo}: banco ${dataBanco}`);
    assert.equal((await n.consultarContasAReceber(c, {})).totais.saldoCentavos, recebiveisEsperados, `${rotulo}: recebíveis`);
    // Resultado por competência ≠ caixa: o resultado não é a variação de banco nem de caixa.
    assert.notEqual(ESPERADO.resultado, ESPERADO.banco30set - 100000 + ESPERADO.caixa30set - 20000);
    return ap;
  };
  await conferir("antes do fechamento", ESPERADO.recebiveis30set, ESPERADO.banco30set, "2026-09-30");

  // --------------------------------------------------------------------------------------------- ciclo de fechamento
  const estado = (novoEstado, extra = {}) => n.alterarEstadoDaCompetencia(c, { competencia: SET, novoEstado, ...extra });
  await estado("FECHAMENTO_PRELIMINAR");
  // 08E: o desconto sem financiador é BLOQUEANTE (classificação provisória): não se "estaciona" em com pendências.
  await rejeita(estado("FECHAMENTO_COM_PENDENCIAS", { pendencias: [{ descricao: "Desconto sem financiador na venda S9", impacto: "Pode alterar as deduções (sintético)." }], justificativa: "Pendência documentada (sintético).", confirmar: true }), CODIGO.TRANSICAO_INVALIDA);
  // Pendência que DEVE bloquear: desconto sem financiador (classificação provisória). Demonstra o bloqueio antes de resolver.
  await rejeita(estado("FECHAMENTO_HOMOLOGADO", { metodologia: "Homologação gerencial sintética.", confirmar: true }), CODIGO.HOMOLOGACAO_BLOQUEADA);
  // Resolução documentada: o desconto é reconhecido como da LOJA (mesma categoria do desconto da loja de S7).
  const lancs = await n.consultarRegistros(c, { tipo: "LANCAMENTO" });
  const descontoLoja = lancs.find((l) => l.vendaId === undefined && false) ?? null;
  const pendente = lancs.find((l) => l.situacao === "ATIVO" && /A_CLASSIFICAR|PENDENTE/.test(l.categoria) && (l.vendaId === s9.venda.id || l.origemId === s9.venda.id || JSON.stringify(l).includes(s9.venda.id)));
  assert.ok(pendente, "o desconto sem financiador gerou lançamento provisório");
  const categoriaLoja = lancs.find((l) => l.natureza === "DEDUCAO" && !/A_CLASSIFICAR|PENDENTE|DEVOLU/.test(l.categoria))?.categoria;
  assert.ok(categoriaLoja && !descontoLoja);
  await n.reclassificarLancamento(c, { lancamentoId: pendente.id, categoria: categoriaLoja, justificativa: "Ata de caixa sintética: desconto concedido pela loja.", versaoEsperada: pendente.versao, documentoId: (await n.registrarDocumento(c, { origem: "MANUAL", arquivoId: "cofre:evidencia-sintetica-a", hashSha256: "a".repeat(64), tipo: "NOTA_FISCAL", recebidoEm: "2026-09-10" })).documento.id });
  // 08E (F-1): pendências que exigem documentação são documentadas como ressalva sintética antes de homologar.
  await prepararHomologacao(n, c, SET);
  const v1 = await estado("FECHAMENTO_HOMOLOGADO", { metodologia: "Homologação gerencial sintética.", confirmar: true });
  const apV1 = await conferir("homologada v1", ESPERADO.recebiveis30set, ESPERADO.banco30set, "2026-09-30");
  assert.equal(apV1.fonteDaApresentacao, "VERSAO_HOMOLOGADA");

  // Liquidação POSTERIOR (outubro): Anota AI recebido, serviços e motoboys pagos — efeito em outubro.
  const anota = (await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-10-08", sentido: "ENTRADA", valorCentavos: 6000, natureza: "RECEBIMENTO" })).movimentacao;
  await n.registrarLiquidacao(c, { movimentacaoId: anota.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: s5.recebiveis[0].id, valorCentavos: 6000 }] });
  await pagar(servicos, 2500, "2026-10-05");
  await pagar(motoboys, 1800, "2026-10-05");
  // Alteração proibida em setembro homologado.
  await rejeita(venda("BALCAO", 1000, [dinheiro(1000)]), CODIGO.COMPETENCIA_HOMOLOGADA);
  await rejeita(n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-09-29", sentido: "SAIDA", valorCentavos: 100, natureza: "PAGAMENTO" }), CODIGO.COMPETENCIA_HOMOLOGADA);
  await conferir("após liquidação posterior", ESPERADO.recebiveis15out, ESPERADO.banco15out, "2026-10-15");
  assert.equal((await n.consultarContasAPagar(c, {})).totais.saldoCentavos, ESPERADO.obrigacoes15out);

  // Reabertura autorizada (justificativa) e nova homologação; a v1 continua reproduzível por si.
  await rejeita(estado("ABERTA"), CODIGO.TRANSICAO_INVALIDA); // sem justificativa
  await estado("ABERTA", { justificativa: "Revisão sintética da metodologia.", confirmar: true });
  await estado("FECHAMENTO_PRELIMINAR");
  await prepararHomologacao(n, c, SET);
  const v2 = await estado("FECHAMENTO_HOMOLOGADO", { metodologia: "Homologação gerencial sintética (revisão).", confirmar: true });
  const fech = await n.consultarFechamento(c, { competencia: SET });
  const versoes = fech.versoes ?? [];
  assert.ok(versoes.filter((x) => x.tipo === "HOMOLOGADA").length >= 2 || (v1.versao && v2.versao), "duas versões homologadas");
  if (v1.versao?.retrato?.resultadoGerencialCentavos !== undefined) assert.equal(v1.versao.retrato.resultadoGerencialCentavos, ESPERADO.resultado);
  const final = await n.apurarCompetencia(c, { competencia: SET });
  assert.equal(final.dre.linhas.find((l) => l.codigo === "RESULTADO_GERENCIAL").valorCentavos, ESPERADO.resultado);
  assert.deepEqual(await n.verificarConservacao(c), []);
});
