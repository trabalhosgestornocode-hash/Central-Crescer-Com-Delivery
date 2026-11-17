// Requisitos prioritários da operação real (doc 33) — dados SINTÉTICOS, setembro/outubro de 2026:
//   1. faturamento bruto por canal (Balcão, iFood, Anota AI) somando o total, sem duplicar repasses;
//   2. dinheiro em espécie recebido (vendas em dinheiro × entrada no caixa × depósito × sangria), sem virar canal;
//   3. baixa de contas a pagar pela conciliação com o extrato (forte só inequívoca, mesma transação, parcial, agrupada,
//      sem correspondência, reimportação, despesa de setembro paga em outubro).
// Roda em memória e, com FV2_REPOSITORIO=postgres, no banco isolado (RLS, histórico, travas reais).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ORG_A, TODAS, ctx, montar, rejeita, sha } from "./helpers/cenario.js";
import { saiposVendas, texto, unicredExtrato } from "./helpers/arquivos.js";

const RELOGIO = () => new Date("2026-11-16T15:00:00.000Z");
const c = ctx();
const SET = { competencia: "2026-09" };
const ACEITE = { aceitarPendencias: true, justificativa: "Pendências sintéticas aceitas no ensaio." };

function preparar() {
  const { nucleo: n } = montar({ relogio: RELOGIO });
  const W = (caminho, corpo) => ESCRITAS[caminho].fazer(n, c, corpo);
  const importar = async (fonte, tipoRelatorio, conteudo, periodo) => {
    const r = await n.receberArquivoParaImportacao(c, { fonte, tipoRelatorio, tipoMime: "application/octet-stream", conteudo, ...periodo });
    if (r.repetido) return { ...r.importacao, repetido: true };
    assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR", JSON.stringify(r.previa.erros));
    return (await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? ACEITE : {}) })).importacao;
  };
  const aplicarTodas = async (operacao) => {
    const efeitos = [];
    for (const p of await n.listarPropostas(c, { operacao })) {
      if (p.estado === "APLICADA" || p.estado === "REJEITADA") continue;
      await n.aprovarProposta(c, { propostaId: p.id, justificativa: "Revisado no ensaio (sintético)." });
      efeitos.push(...(await n.aplicarProposta(c, { propostaId: p.id })).efeitos);
    }
    return efeitos;
  };
  return { n, W, importar, aplicarTodas };
}

test("1 — faturamento bruto por canal: Presencial + Anota AI pela SAIPOS; o iFood da SAIPOS fica só para conferência (doc 38/39); repasse posterior não soma de novo", async () => {
  const { n, W, importar, aplicarTodas } = preparar();
  const caixa = await W("/configuracoes/conta/criar", { tipo: "CAIXA_FISICO", nome: "Caixa da loja" });
  const banco = await W("/configuracoes/conta/criar", { tipo: "BANCARIA", nome: "Unicred" });
  const arquivo = saiposVendas([
    { pedido: "B-1", data: "03/09/2026 12:00", canal: "Balcão", itens: 3000, forma: "Dinheiro" },
    { pedido: "B-2", data: "04/09/2026 12:00", canal: "Balcão", itens: 2000, forma: "Dinheiro" },
    { pedido: "I-1", data: "05/09/2026 20:00", canal: "iFood", itens: 6000, forma: "Pago online" },
    { pedido: "A-1", data: "06/09/2026 20:00", canal: "Anota AI", itens: 4000, forma: "Pago online" },
  ]);
  const imp = await importar("SAIPOS", "SAIPOS_VENDAS", arquivo, { periodoInicio: "2026-09-01", periodoFim: "2026-09-30" });
  await n.gerarPropostas(c, { importacaoId: imp.id, contaCaixaId: caixa.id });
  await aplicarTodas("VENDA");

  const vg = await n.apurarVisaoGeral(c, SET);
  const canal = (k) => vg.faturamentoBruto.porCanal.find((x) => x.canal === k)?.valorCentavos ?? 0;
  assert.deepEqual([canal("BALCAO"), canal("IFOOD"), canal("ANOTA_AI")], [5000, 0, 4000]); // iFood: só pelo demonstrativo oficial
  assert.equal(vg.faturamentoBruto.valorCentavos, 9000);
  assert.equal(vg.faturamentoBruto.porCanal.reduce((s, x) => s + (x.valorCentavos ?? 0), 0), vg.faturamentoBruto.valorCentavos, "a soma dos canais é o total");
  // Cada canal aponta os registros que o compõem (conferível até a venda e o pedido de origem).
  assert.equal(vg.faturamentoBruto.porCanal.find((x) => x.canal === "ANOTA_AI").registros.length, 1);

  // Repasse do Anota AI em outubro liquida o recebível da venda: não é receita de novo (nem em setembro, nem em outubro).
  const rec = (await n.consultarContasAReceber(c, { tamanho: 50 })).itens.find((x) => x.canal === "ANOTA_AI");
  const e = await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-10-08", sentido: "ENTRADA", valorCentavos: 4000, natureza: "RECEBIMENTO", descricao: "Repasse Anota AI (sintético)" });
  await n.registrarLiquidacao(c, { movimentacaoId: e.movimentacao.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: rec.id, valorCentavos: 4000 }] });
  assert.equal((await n.apurarVisaoGeral(c, SET)).faturamentoBruto.valorCentavos, 9000);
  assert.equal((await n.apurarVisaoGeral(c, { competencia: "2026-10" })).faturamentoBruto.valorCentavos, null);

  // O mesmo relatório de novo: a mesma importação, nenhuma venda a mais.
  const de_novo = await importar("SAIPOS", "SAIPOS_VENDAS", arquivo, { periodoInicio: "2026-09-01", periodoFim: "2026-09-30" });
  assert.equal(de_novo.repetido, true);
  assert.equal((await n.apurarVisaoGeral(c, SET)).faturamentoBruto.valorCentavos, 9000);
});

test("2 — dinheiro em espécie: vendas em dinheiro × entrada no caixa × depósito × sangria; não é canal nem receita a mais", async () => {
  const { n, W, importar, aplicarTodas } = preparar();
  const caixa = await W("/configuracoes/conta/criar", { tipo: "CAIXA_FISICO", nome: "Caixa da loja" });
  const banco = await W("/configuracoes/conta/criar", { tipo: "BANCARIA", nome: "Unicred" });
  const sessao = (await W("/caixa/abrir", { conta: caixa.id, data: "2026-09-01", contado: "100,00" })).sessao;
  const imp = await importar("SAIPOS", "SAIPOS_VENDAS", saiposVendas([
    { pedido: "D-1", data: "02/09/2026 12:00", canal: "Balcão", itens: 3000, forma: "Dinheiro" },
    { pedido: "D-2", data: "03/09/2026 12:00", canal: "Balcão", itens: 2500, forma: "Dinheiro" },
    { pedido: "I-9", data: "03/09/2026 20:00", canal: "iFood", itens: 5000, forma: "Pago online" },
  ]), { periodoInicio: "2026-09-01", periodoFim: "2026-09-30" });
  await n.gerarPropostas(c, { importacaoId: imp.id, contaCaixaId: caixa.id });
  await aplicarTodas("VENDA");
  // Venda em dinheiro registrada SEM entrada no caixa (pendência de conferência, nunca presumida).
  await n.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-09-04", brutoCentavos: 1000, fonte: { sistema: "MANUAL", idExterno: "D-3" }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 1000 }] });
  // Depósito do caixa no banco (transferência interna) e sangria para retirada.
  await W("/caixa/operacao", { sessao: sessao.id, operacao: "SANGRIA", valor: "40,00", data: "2026-09-05", descricao: "Depósito no banco", contraConta: banco.id });
  await W("/caixa/operacao", { sessao: sessao.id, operacao: "SANGRIA", valor: "5,00", data: "2026-09-05", descricao: "Retirada do sócio" });

  const fin = await n.consultarResumoFinanceiro(c, SET);
  const d = fin.dinheiroEmEspecie;
  assert.deepEqual([d.situacao, d.vendasEmDinheiroCentavos, d.recebidoNoCaixaCentavos, d.depositosNoBancoCentavos, d.sangriasERetiradasCentavos],
    ["CALCULADO", 6500, 5500, 4000, 500]);
  assert.deepEqual(d.semEntradaNoCaixa, { quantidade: 1, valorCentavos: 1000 });
  assert.deepEqual(d.porDia.map((x) => [x.data, x.vendasEmDinheiro, x.recebidoNoCaixa]), [["2026-09-02", 3000, 3000], ["2026-09-03", 2500, 2500], ["2026-09-04", 1000, 0], ["2026-09-05", 0, 0]]);
  // Não é canal nem receita a mais: o bruto é a soma das vendas do Balcão (o pedido iFood da SAIPOS fica só para conferência, doc 38/39); o depósito não entra.
  const vg = await n.apurarVisaoGeral(c, SET);
  assert.equal(vg.faturamentoBruto.valorCentavos, 3000 + 2500 + 1000);
  assert.ok(!vg.faturamentoBruto.porCanal.some((x) => x.canal === "DINHEIRO"));
  // Outubro sem dinheiro: "sem registros", nunca R$ 0,00 confirmado.
  assert.equal((await n.consultarResumoFinanceiro(c, { competencia: "2026-10" })).dinheiroEmEspecie.situacao, "SEM_REGISTROS");
});

test("3 — baixa de contas a pagar pela conciliação do extrato: inequívoca forte, mesma transação, parcial, agrupada, sem par, reimportação", async () => {
  const { n, W, importar, aplicarTodas } = preparar();
  const banco = await W("/configuracoes/conta/criar", { tipo: "BANCARIA", nome: "Unicred" });
  const forn = async (nome) => n.registrarContraparte(c, { tipo: "FORNECEDOR", nome });
  const conta = async (f, valor, categoria, extra = {}) => (await n.registrarObrigacao(c, { contraparteId: f.id, valorOriginalCentavos: valor, categoria, descricao: `${categoria} (sintético)`, competencia: "2026-09", dataEmissao: "2026-09-02", vencimento: "2026-09-20", ...extra })).obrigacoes[0];
  const distrib = await conta(await forn("Distribuidora Sintética"), 50000, "ACAI_DISTRIBUIDORA", { identificador: "NF 200" });
  const energia = await conta(await forn("Equatorial Energia"), 30000, "ENERGIA");
  const aluguel = await conta(await forn("Locador Sintético"), 100000, "ALUGUEL");
  const superA = await conta(await forn("Mercado Um"), 10000, "SUPERMERCADO");
  const superB = await conta(await forn("Mercado Dois"), 15000, "SUPERMERCADO");
  const ambX = await conta(await forn("Prestador X"), 8000, "OUTRAS_DESPESAS");
  const ambY = await conta(await forn("Prestador Y"), 8000, "OUTRAS_DESPESAS");
  const outubro = await conta(await forn("Fornecedor Frutas Sintético"), 20000, "FRUTAS", { vencimento: "2026-10-05" });
  const despesasSet = 50000 + 30000 + 100000 + 10000 + 15000 + 8000 + 8000 + 20000;
  const resultado = async (comp) => (await n.apurarCompetencia(c, { competencia: comp })).indicadores.RESULTADO_GERENCIAL.valorCentavos;
  assert.equal(await resultado("2026-09"), -despesasSet);

  // Extrato de setembro: cada débito vira UMA movimentação (nenhuma despesa).
  const extratoSet = unicredExtrato({ saldoInicial: 500000, lancamentos: [
    { data: "10/09/2026", historico: "PAG BOLETO NF 200 DISTRIBUIDORA", valor: -50000 },
    { data: "12/09/2026", historico: "DEB AUTOMATICO EQUATORIAL ENERGIA", valor: -30000 },
    { data: "15/09/2026", historico: "PIX ENVIADO LOCADOR PARCIAL", valor: -40000 },
    { data: "16/09/2026", historico: "PIX ENVIADO MERCADOS", valor: -25000 },
    { data: "18/09/2026", historico: "PIX ENVIADO 8000", valor: -8000 },
    { data: "20/09/2026", historico: "TARIFA PACOTE SERVICOS", valor: -4500 },
  ] });
  const imp = await importar("UNICRED", "UNICRED_EXTRATO", extratoSet, { periodoInicio: "2026-09-01", periodoFim: "2026-09-30" });
  await n.gerarPropostas(c, { importacaoId: imp.id, contaBancariaId: banco.id });
  const movs = (await aplicarTodas("MOVIMENTACAO_BANCARIA")).filter((e) => e.tipo === "MOVIMENTACAO").map((e) => e.id);
  assert.equal(movs.length, 6);
  assert.equal(await resultado("2026-09"), -despesasSet, "importar o extrato não cria despesa");
  const saidasDoMes = async () => (await n.consultarResumoFinanceiro(c, SET)).fluxoDeCaixa.realizadoNaCompetencia.saidasCentavos;
  const saidasAntes = await saidasDoMes();
  assert.equal(saidasAntes, 50000 + 30000 + 40000 + 25000 + 8000 + 4500);

  // Sugestões: forte só quando inequívoca (identificador da conta ou beneficiário no histórico).
  await W("/conciliacoes/gerar-contas-a-pagar", SET);
  const corr = await n.consultarCorrespondencias(c, { ...SET, tamanho: 50 });
  const de = (obrigacaoId) => corr.itens.filter((x) => x.relacao === "OBRIGACAO_X_MOVIMENTACAO" && [...x.ladoA.itens, ...x.ladoB.itens].some((i) => i.id === obrigacaoId));
  assert.equal(de(distrib.id)[0].confiabilidade, "FORTE");
  assert.equal(de(energia.id)[0].confiabilidade, "FORTE");
  assert.deepEqual([de(ambX.id)[0].confiabilidade, de(ambY.id)[0].confiabilidade], ["FRACA", "FRACA"], "mesmo valor para duas contas: ambígua, nunca forte");
  assert.equal(de(aluguel.id).length, 0, "pagamento parcial não vira sugestão automática");

  // Confirmar COM baixa: conta quitada na mesma transação; nenhuma saída nem despesa nova.
  const r = await W("/conciliacoes/confirmar", { correspondencia: de(distrib.id)[0].id, justificativa: "Boleto da NF 200 no extrato (sintético).", baixar: "1" });
  assert.equal(r.situacao, "CONFIRMADA");
  assert.deepEqual([r.baixa.liquidacoes.length, r.baixa.efeito.novasSaidas, r.baixa.efeito.novasDespesas], [1, 0, 0]);
  // Sem a permissão da baixa: confirmar com baixa é recusado inteiro (nem a conciliação fica confirmada).
  const semVincular = ctx(ORG_A, undefined, TODAS.filter((a) => a !== ACAO.VINCULAR_PAGAMENTO));
  await rejeita(ESCRITAS["/conciliacoes/confirmar"].fazer(n, semVincular, { correspondencia: de(energia.id)[0].id, justificativa: "x", baixar: "1" }), CODIGO.PERMISSAO_INSUFICIENTE);
  await W("/conciliacoes/confirmar", { correspondencia: de(energia.id)[0].id, justificativa: "Débito automático da energia (sintético).", baixar: "1" });
  const pagar = async () => Object.fromEntries((await n.consultarContasAPagar(c, { tamanho: 50 })).itens.map((x) => [x.id, x]));
  let p = await pagar();
  assert.deepEqual([p[distrib.id].saldoCentavos, p[energia.id].saldoCentavos], [0, 0]);
  // Confirmar de novo: já decidida; a saída não paga a mesma conta duas vezes.
  await rejeita(W("/conciliacoes/confirmar", { correspondencia: de(distrib.id)[0].id, justificativa: "De novo.", baixar: "1" }), CODIGO.CONCILIACAO_INVALIDA);
  // Ambígua: confirmar é recusado enquanto a concorrente estiver aberta.
  await rejeita(W("/conciliacoes/confirmar", { correspondencia: de(ambX.id)[0].id, justificativa: "Tentativa (sintético).", baixar: "1" }), CODIGO.CONCILIACAO_INVALIDA);

  // Parcial e agrupado: vínculo manual com comprovante (prévia → confirmação), saldo restante pendente.
  const doc = async (k) => (await n.registrarDocumento(c, { origem: "MANUAL", arquivoId: `comprovante-${k}`, hashSha256: sha(k), tipo: "COMPROVANTE", recebidoEm: "2026-09-20", descricao: `Comprovante ${k} (sintético)` })).documento.id;
  const movDe = async (valor) => (await n.previaDoVinculoDoExtrato(c, { obrigacaoId: aluguel.id })).saidasElegiveis.find((m) => m.valorCentavos === valor);
  const parcial = await movDe(40000);
  await W("/obrigacoes/vincular-extrato", { obrigacao: aluguel.id, movimentacao: parcial.id, versao: String(parcial.versao), valor: "400,00", documento: await doc("aluguel"), justificativa: "Pix parcial do aluguel (sintético)." });
  const agrupado = await movDe(25000);
  const docMercados = await doc("mercados");
  const vinc = { movimentacaoId: agrupado.id, versaoMovimentacao: agrupado.versao, alocacoes: [{ obrigacaoId: superA.id, valorCentavos: 10000 }, { obrigacaoId: superB.id, valorCentavos: 15000 }], documentoId: docMercados, justificativa: "Um Pix pagou as duas compras (comprovante).", confirmar: true };
  await n.vincularPagamentoDoExtrato(c, vinc);
  assert.equal((await n.vincularPagamentoDoExtrato(c, vinc)).repetido, true, "repetir o vínculo não baixa de novo");
  p = await pagar();
  assert.equal(p[aluguel.id].saldoCentavos, 60000, "pagamento parcial: o saldo restante continua pendente (vencido, pois a data já passou)");
  assert.deepEqual([p[superA.id].saldoCentavos, p[superB.id].saldoCentavos], [0, 0]);

  // Reimportar o mesmo extrato e procurar de novo: nada novo (nem movimentação, nem sugestão, nem baixa).
  assert.equal((await importar("UNICRED", "UNICRED_EXTRATO", extratoSet, { periodoInicio: "2026-09-01", periodoFim: "2026-09-30" })).repetido, true);
  const antes = (await n.consultarCorrespondencias(c, { ...SET, tamanho: 50 })).paginacao?.total;
  await W("/conciliacoes/gerar-contas-a-pagar", SET);
  assert.equal((await n.consultarCorrespondencias(c, { ...SET, tamanho: 50 })).paginacao?.total, antes);

  // Despesa de setembro paga em outubro (extrato de outubro, beneficiário no histórico).
  const impOut = await importar("UNICRED", "UNICRED_EXTRATO", unicredExtrato({ saldoInicial: 342500, lancamentos: [{ data: "05/10/2026", historico: "PIX FORNECEDOR FRUTAS SINTETICO", valor: -20000 }] }), { periodoInicio: "2026-10-01", periodoFim: "2026-10-31" });
  await n.gerarPropostas(c, { importacaoId: impOut.id, contaBancariaId: banco.id });
  await aplicarTodas("MOVIMENTACAO_BANCARIA");
  await W("/conciliacoes/gerar-contas-a-pagar", { competencia: "2026-10" });
  const out = (await n.consultarCorrespondencias(c, { competencia: "2026-09", tamanho: 50 })).itens.concat((await n.consultarCorrespondencias(c, { competencia: "2026-10", tamanho: 50 })).itens)
    .find((x) => x.relacao === "OBRIGACAO_X_MOVIMENTACAO" && [...x.ladoA.itens, ...x.ladoB.itens].some((i) => i.id === outubro.id));
  assert.equal(out.confiabilidade, "FORTE");
  await W("/conciliacoes/confirmar", { correspondencia: out.id, justificativa: "Pix das frutas de setembro (sintético).", baixar: "1" });
  assert.equal((await pagar())[outubro.id].saldoCentavos, 0);

  // DRE: setembro intacto (despesa pela competência, uma vez só); outubro sem a despesa de setembro.
  assert.equal(await resultado("2026-09"), -despesasSet);
  assert.equal(await resultado("2026-10"), null);
  // Banco: as saídas de setembro continuam as do extrato (nenhuma saída nova criada pelas baixas).
  assert.equal(await saidasDoMes(), saidasAntes);
  // A tarifa sem conta correspondente segue sem vínculo (em conferência), nunca classificada por conta própria.
  assert.ok((await n.consultarResumoFinanceiro(c, SET)).pendencias.movimentacoesSemVinculo >= 1);
  assert.deepEqual(await n.verificarConservacao(c), []);
});

test("1b — total do período por canal (desempenho por atendente): Balcão e Anota AI sem pedidos inventados; iFood da SAIPOS fica fora; nunca junto com pedidos do mesmo canal", async () => {
  const { n, W, importar, aplicarTodas } = preparar();
  const caixa = await W("/configuracoes/conta/criar", { tipo: "CAIXA_FISICO", nome: "Caixa da loja" });
  const cab = "ATENDENTE;QUANTIDADE_VENDAS;VALOR_TOTAL_VENDAS;CATEGORIA;ITEM;QUANTIDADE_ITEM;VALOR_TOTAL_ITEM";
  const arquivo = texto([cab, "Loja Sintética;10;500,00;Copos;Copo A;9;450,00", "Loja Sintética;10;500,00;Copos;Copo B;1;50,00",
    "integration-api-int-sale;2;120,00;Diversos;Diversos;3;100,00", "integration-ifood;5;300,00;Diversos;Diversos;6;280,00"].join(String.fromCharCode(10)));
  const SETEMBRO = { periodoInicio: "2026-09-01", periodoFim: "2026-09-30" };
  const imp = await importar("SAIPOS", "SAIPOS_DESEMPENHO_POR_ATENDENTE", arquivo, SETEMBRO);
  await n.gerarPropostas(c, { importacaoId: imp.id });
  const props = await n.listarPropostas(c, { operacao: "VENDA_AGREGADA" });
  assert.deepEqual(props.map((p) => [p.comando.canal, p.comando.receitaBrutaCentavos, p.dataOperacao]).sort(), [["ANOTA_AI", 12000, "2026-09-30"], ["BALCAO", 50000, "2026-09-30"]]); // iFood: só pelo demonstrativo oficial
  assert.ok(props.find((p) => p.comando.canal === "BALCAO").divergencias.some((d) => d.codigo === "CANAL_DEDUZIDO_DO_ATENDENTE"));
  await aplicarTodas("VENDA_AGREGADA");
  const vg = await n.apurarVisaoGeral(c, SET);
  const canal = (k) => vg.faturamentoBruto.porCanal.find((x) => x.canal === k)?.valorCentavos ?? 0;
  assert.deepEqual([canal("BALCAO"), canal("IFOOD"), canal("ANOTA_AI"), vg.faturamentoBruto.valorCentavos], [50000, 0, 12000, 62000]);
  // Mesmo arquivo de novo: a mesma importação, nada a mais.
  assert.equal((await importar("SAIPOS", "SAIPOS_DESEMPENHO_POR_ATENDENTE", arquivo, SETEMBRO)).repetido, true);
  // Pedidos do mesmo período: o do Anota AI (canal com total) é recusado na aplicação — nunca duas receitas do mesmo fato.
  const ped = await importar("SAIPOS", "SAIPOS_VENDAS", saiposVendas([{ pedido: "P-AA", data: "10/09/2026 20:00", canal: "Anota AI", itens: 3000, forma: "Pago online" }]), SETEMBRO);
  await n.gerarPropostas(c, { importacaoId: ped.id, contaCaixaId: caixa.id });
  const [pp] = await n.listarPropostas(c, { operacao: "VENDA" });
  await n.aprovarProposta(c, { propostaId: pp.id, justificativa: "Revisado (sintético)." });
  await rejeita(n.aplicarProposta(c, { propostaId: pp.id }), CODIGO.CONFLITO_IDEMPOTENCIA);
  // Substituição explícita: reverte o total do Anota AI (lançamento cancelado, nunca apagado) e então o pedido entra.
  const totalIfood = (await n.listarPropostas(c, { operacao: "VENDA_AGREGADA" })).find((p) => p.comando.canal === "ANOTA_AI");
  await n.reverterPropostaAgregada(c, { propostaId: totalIfood.id, justificativa: "Substituído pelos pedidos detalhados (sintético)." });
  await n.aplicarProposta(c, { propostaId: pp.id });
  const vg2 = await n.apurarVisaoGeral(c, SET);
  assert.equal(vg2.faturamentoBruto.valorCentavos, 50000 + 3000);
});
