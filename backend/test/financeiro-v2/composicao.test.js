// Execução 03B — composição econômica das vendas: bruto próprio, descontos com financiador, subsídios de terceiros,
// valor cobrado, taxas, recebíveis, cancelamentos e agregados. Dados 100% SINTÉTICOS. Memória e PostgreSQL isolado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO, composicaoIfood } from "../../src/modules/financeiro-v2/index.js";
import { ctx, montar, rejeita } from "./helpers/cenario.js";
import { PERIODO_SETEMBRO, saiposDiarias, saiposVendas } from "./helpers/arquivos.js";
import { faturamentoSaiposPdf } from "./helpers/formatos.js";

const c = ctx();
const ACEITE = { aceitarPendencias: true, justificativa: "Pendências sintéticas aceitas no teste." };
const ind = async (n, indicador) => (await n.consultarComposicao(c, { competencia: "2026-09", indicador })).totalCentavos;
const venda = (extra) => ({ canal: "BALCAO", dataVenda: "2026-09-02", fonte: { sistema: "MANUAL", idExterno: `V-${Math.random().toString(36).slice(2)}` }, ...extra });
async function base() {
  const m = montar();
  const caixa = await m.nucleo.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  return { ...m, n: m.nucleo, caixa };
}
async function importar(n, fonte, tipoRelatorio, conteudo, periodo = PERIODO_SETEMBRO, extra = {}) {
  const r = await n.receberArquivoParaImportacao(c, { fonte, tipoRelatorio, tipoMime: "application/octet-stream", conteudo, ...periodo, ...extra });
  const conf = await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? ACEITE : {}) });
  return conf.importacao;
}
const aprovarEAplicar = async (n, p) => { await n.aprovarProposta(c, { propostaId: p.id, justificativa: "Revisado." }); return n.aplicarProposta(c, { propostaId: p.id }); };

test("1, 2 — venda sem desconto e com desconto da LOJA: receita = bruto próprio; desconto é dedução própria", async () => {
  const { n, caixa } = await base();
  await n.registrarVenda(c, venda({ brutoCentavos: 1000, composicao: { itensCentavos: 1000 }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 1000, contaId: caixa.id }] }));
  const r = await n.registrarVenda(c, venda({ brutoCentavos: 2000, composicao: { itensCentavos: 1800, acrescimosCentavos: 200, descontos: [{ valorCentavos: 300, financiador: "LOJA" }] }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 1700, contaId: caixa.id }] }));
  assert.equal(await ind(n, "RECEITA_BRUTA"), 3000);
  assert.equal(await ind(n, "DEDUCOES"), 300);
  assert.equal(r.venda.descontosCentavos, 300);
  // Pagamento que não fecha com receita − descontos é recusado.
  await rejeita(n.registrarVenda(c, venda({ brutoCentavos: 1000, composicao: { itensCentavos: 1000, descontos: [{ valorCentavos: 100, financiador: "LOJA" }] }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 1000 }] })), CODIGO.PAGAMENTOS_NAO_FECHAM);
});

test("3, 4 — subsídio integral de TERCEIRO não reduz a receita (vira recebível dele); desconto dividido loja + terceiro", async () => {
  const { n, caixa } = await base();
  const r3 = await n.registrarVenda(c, venda({ brutoCentavos: 1000, composicao: { itensCentavos: 1000, descontos: [{ valorCentavos: 1000, financiador: "TERCEIRO", terceiro: "IFOOD" }] }, pagamentos: [], pagamentoParcial: false }));
  assert.equal(r3.recebiveis.length, 1);
  assert.equal(r3.recebiveis[0].processador, "IFOOD");
  assert.equal(r3.recebiveis[0].brutoCentavos, 1000);
  const r4 = await n.registrarVenda(c, venda({ brutoCentavos: 2000, composicao: { itensCentavos: 2000, descontos: [{ valorCentavos: 200, financiador: "LOJA" }, { valorCentavos: 300, financiador: "TERCEIRO", terceiro: "OUTRO" }] }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 1500, contaId: caixa.id }] }));
  assert.equal(await ind(n, "RECEITA_BRUTA"), 3000);
  assert.equal(await ind(n, "DEDUCOES"), 200); // só o desconto da loja; o subsídio não é dedução nem receita dobrada
  assert.equal(r4.recebiveis[0].brutoCentavos, 300);
  await rejeita(n.registrarVenda(c, venda({ brutoCentavos: 1000, composicao: { itensCentavos: 1000, descontos: [{ valorCentavos: 100, financiador: "TERCEIRO" }] }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 900 }] })), CODIGO.ENTRADA_INVALIDA);
  await rejeita(n.registrarVenda(c, venda({ brutoCentavos: 1000, composicao: { itensCentavos: 900, terceirosCentavos: 100 }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 1000 }] })), CODIGO.ENTRADA_INVALIDA);
});

test("5, 6 — pagamento misto e taxa Stone: desconto comercial e taxa de processamento nunca se confundem", async () => {
  const { n, caixa } = await base();
  const r = await n.registrarVenda(c, venda({ brutoCentavos: 5000, composicao: { itensCentavos: 5000, descontos: [{ valorCentavos: 500, financiador: "LOJA" }] }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 2000, contaId: caixa.id }, { forma: "CREDITO", processador: "STONE", valorCentavos: 2500 }] }));
  const rec = r.recebiveis[0];
  await n.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: rec.id, valorCentavos: -75, motivo: "Taxa Stone informada", categoria: "TAXAS_STONE" });
  assert.equal(await ind(n, "RECEITA_BRUTA"), 5000);
  assert.equal(await ind(n, "DEDUCOES"), 500); // desconto comercial: pertence à venda
  assert.equal(await ind(n, "DESPESAS"), 75); // taxa: despesa de recebimento
  assert.equal(r.venda.pagamentos.map((p) => p.forma).join("+"), "DINHEIRO+CREDITO");
});

test("7 — iFood com múltiplas deduções: receita própria, promoção da loja, subsídio do iFood, comissão e transação, sem dupla subtração", async () => {
  const { n } = await base();
  const r = await n.registrarVenda(c, venda({ canal: "IFOOD", brutoCentavos: 5000, composicao: { itensCentavos: 5000, descontos: [{ valorCentavos: 300, financiador: "LOJA" }, { valorCentavos: 500, financiador: "TERCEIRO", terceiro: "IFOOD" }] }, pagamentos: [{ forma: "OUTRA", processador: "IFOOD", valorCentavos: 4200 }] }));
  const pedido = r.recebiveis.find((x) => x.brutoCentavos === 4200);
  await n.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: pedido.id, valorCentavos: -600, motivo: "Comissão iFood", categoria: "COMISSOES_IFOOD" });
  await n.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: pedido.id, valorCentavos: -150, motivo: "Transação de pagamento", categoria: "TAXAS_DE_PROCESSAMENTO" });
  assert.equal(await ind(n, "RECEITA_BRUTA"), 5000);
  assert.equal(await ind(n, "DEDUCOES"), 300);
  assert.equal(await ind(n, "DESPESAS"), 750);
  assert.equal(r.recebiveis.reduce((s, x) => s + x.brutoCentavos, 0), 4700); // consumidor (4200) + subsídio do iFood (500)
  // Composição gerencial da apuração: cada componente uma vez; promoção do iFood é informativa; antecipação já incluída.
  const comp = composicaoIfood([
    { componente: "VENDAS", valorCentavos: 5000 }, { componente: "PROMOCAO_LOJA", valorCentavos: -300 }, { componente: "PROMOCAO_IFOOD", valorCentavos: -500 },
    { componente: "COMISSAO", valorCentavos: -600 }, { componente: "TRANSACAO_PAGAMENTO", valorCentavos: -150 }, { componente: "ANTECIPACAO", valorCentavos: -50 },
    { componente: "TAXA_ADICIONAL_CONSUMIDOR", valorCentavos: 99 }, { componente: "REPASSE_PREVISTO", valorCentavos: 3999 },
  ]);
  assert.equal(comp.liquidoGerencial, 5000 - 300 - 600 - 150 - 50 + 99);
  assert.equal(comp.confereComRepasse, true);
  assert.deepEqual(comp.porNatureza, { RECEITA: 5000, DEDUCAO: -300, DESPESA: -800, A_CLASSIFICAR: 99 }); // taxa ao consumidor NÃO vira receita automática
});

test("8, 18 — pedido SAIPOS com desconto: bruto recuperado dos componentes (nunca o valor cobrado); composição rastreável até o documento", async () => {
  const { n, caixa } = await base();
  const imp = await importar(n, "SAIPOS", "SAIPOS_VENDAS", saiposVendas([{ pedido: "P-1", data: "02/09/2026 12:00", canal: "Balcão", itens: 3000, desconto: 500, acrescimo: 100, forma: "Dinheiro" }]));
  await n.gerarPropostas(c, { importacaoId: imp.id, contaCaixaId: caixa.id });
  const [p] = await n.listarPropostas(c, { operacao: "VENDA" });
  assert.equal(p.comando.brutoCentavos, 3100); // itens + acréscimo, não 2600
  assert.equal(p.comando.composicao.descontos[0].financiador, "PENDENTE");
  assert.ok(p.divergencias.some((d) => d.codigo === "FINANCIADOR_DO_DESCONTO_NAO_COMPROVADO"));
  const r = await aprovarEAplicar(n, p);
  assert.equal(await ind(n, "RECEITA_BRUTA"), 3100);
  assert.equal(await ind(n, "DEDUCOES"), 500); // dedução A CLASSIFICAR, uma vez
  const deducoes = (await n.consultarComposicao(c, { competencia: "2026-09", indicador: "DEDUCOES" })).itens;
  assert.equal(deducoes[0].categoria, "DESCONTOS_A_CLASSIFICAR");
  // Rastro: venda → proposta → registro (coluna Desconto original) → documento.
  const vendaId = r.efeitos.find((e) => e.tipo === "VENDA").id;
  const registro = (await n.listarRegistrosImportados(c, { importacaoId: imp.id }))[0];
  assert.equal(registro.original.Desconto, "5,00");
  assert.equal(r.proposta.registroIds[0], registro.id);
  assert.equal(r.proposta.documentoIds[0], imp.documentoId);
  assert.ok(vendaId);
});

test("9, 10, 11 — agregado: valor líquido não sofre nova dedução; composição comprovada vira bruto; metodologia desconhecida só controla", async () => {
  const { n } = await base();
  const imp = await importar(n, "SAIPOS", "SAIPOS_FATURAMENTO_POR_DIA", faturamentoSaiposPdf([{ data: "01/09/2026", valor: 9500, desconto: 500 }, { data: "02/09/2026", valor: 4000, desconto: 0 }]));
  await n.gerarPropostas(c, { importacaoId: imp.id });
  const ps = (await n.listarPropostas(c, { operacao: "VENDA_AGREGADA" })).sort((a, b) => (a.dataOperacao < b.dataOperacao ? -1 : 1));
  assert.equal(ps[0].comando.metodologia, "VALOR_LIQUIDO_COMPOSICAO_COMPROVADA");
  assert.equal(ps[0].comando.receitaBrutaCentavos, 10000);
  await aprovarEAplicar(n, ps[0]);
  assert.equal(await ind(n, "RECEITA_BRUTA"), 10000);
  assert.equal(await ind(n, "DEDUCOES"), 500);
  assert.equal(await ind(n, "RECEITA_BRUTA") - await ind(n, "DEDUCOES"), 9500); // = valor do relatório: desconto deduzido UMA vez
  // Metodologia desconhecida: relatório só com totais (sem componentes) fica como controle, sem efeito econômico.
  const imp2 = await importar(n, "SAIPOS", "SAIPOS_VENDAS_DIARIAS", saiposDiarias([["03/09/2026", 5, 7000]]), { periodoInicio: "2026-09-03", periodoFim: "2026-09-03" });
  await n.gerarPropostas(c, { importacaoId: imp2.id });
  const desconhecida = (await n.listarPropostas(c, { operacao: "VENDA_AGREGADA" })).find((p) => p.dataOperacao === "2026-09-03");
  assert.equal(desconhecida.comando.metodologia, "DESCONHECIDA");
  assert.equal(desconhecida.estado, "AGUARDANDO_EVIDENCIA");
  await rejeita(n.aprovarProposta(c, { propostaId: desconhecida.id }), CODIGO.TRANSICAO_INVALIDA);
  assert.equal(await ind(n, "RECEITA_BRUTA"), 10000);
});

async function cenarioSubstituicao() {
  const ctxBase = await base();
  const { n, caixa } = ctxBase;
  const agr = await importar(n, "SAIPOS", "SAIPOS_FATURAMENTO_POR_DIA", faturamentoSaiposPdf([{ data: "02/09/2026", valor: 5000, desconto: 0 }]), { periodoInicio: "2026-09-02", periodoFim: "2026-09-02" });
  await n.gerarPropostas(c, { importacaoId: agr.id });
  const [pa] = await n.listarPropostas(c, { operacao: "VENDA_AGREGADA" });
  await aprovarEAplicar(n, pa);
  const ped = await importar(n, "SAIPOS", "SAIPOS_VENDAS", saiposVendas([
    { pedido: "P-1", data: "02/09/2026 12:00", itens: 3000, forma: "Dinheiro" }, { pedido: "P-2", data: "02/09/2026 13:00", itens: 2000, forma: "Dinheiro" },
  ]));
  await n.gerarPropostas(c, { importacaoId: ped.id, contaCaixaId: caixa.id });
  const pedidos = await n.listarPropostas(c, { operacao: "VENDA" });
  for (const p of pedidos) await n.aprovarProposta(c, { propostaId: p.id });
  return { ...ctxBase, pa, pedidos };
}

test("12 — substituição atômica do agregado pelos pedidos: sem coexistência, com auditoria", async () => {
  const { n, pa, pedidos } = await cenarioSubstituicao();
  assert.equal(await ind(n, "RECEITA_BRUTA"), 5000);
  const r = await n.substituirAgregadoPorPedidos(c, { propostaAgregadaId: pa.id, propostaIds: pedidos.map((p) => p.id), justificativa: "Chegou o relatório por pedido do dia." });
  assert.equal(r.agregada.estado, "SUBSTITUIDA");
  assert.equal(r.pedidos.length, 2);
  assert.equal(await ind(n, "RECEITA_BRUTA"), 5000); // agregado cancelado + pedidos aplicados, nunca os dois
  const hist = await n.consultarHistorico(c, { registroTipo: "PROPOSTA", registroId: pa.id });
  assert.equal(hist.at(-1).justificativa, "Chegou o relatório por pedido do dia.");
});

test("13 — substituições concorrentes: uma vence, a outra é recusada, receita sem duplicidade", async () => {
  const { n, pa, pedidos } = await cenarioSubstituicao();
  const r = await Promise.allSettled([1, 2].map(() => n.substituirAgregadoPorPedidos(c, { propostaAgregadaId: pa.id, propostaIds: pedidos.map((p) => p.id), justificativa: "Corrida sintética." })));
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  for (const x of r.filter((y) => y.status === "rejected")) assert.ok([CODIGO.TRANSICAO_INVALIDA, CODIGO.CONFLITO_VERSAO].includes(x.reason.codigo));
  assert.equal(await ind(n, "RECEITA_BRUTA"), 5000);
});

test("14, 15 — estorno parcial é dedução própria; venda cancelada após recebimento exige compensação e desfaz receita E descontos", async () => {
  const { n, caixa } = await base();
  const r = await n.registrarVenda(c, venda({ brutoCentavos: 3000, composicao: { itensCentavos: 3000, descontos: [{ valorCentavos: 400, financiador: "LOJA" }] }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 2600, contaId: caixa.id }] }));
  const pag = r.pagamentos[0];
  await n.estornarPagamentoDeVenda(c, { pagamentoId: pag.id, valorCentavos: 600, motivo: "DEVOLUCAO_AO_CLIENTE", justificativa: "Item devolvido", contaId: caixa.id, dataEfetiva: "2026-09-03" });
  assert.equal(await ind(n, "DEDUCOES"), 400 + 600);
  await rejeita(n.cancelarVenda(c, { vendaId: r.venda.id, justificativa: "Pedido cancelado" }), CODIGO.ESTORNO_EXIGE_COMPENSACAO);
  await n.estornarPagamentoDeVenda(c, { pagamentoId: pag.id, valorCentavos: 2000, motivo: "DEVOLUCAO_AO_CLIENTE", justificativa: "Devolução do restante", contaId: caixa.id, dataEfetiva: "2026-09-03" });
  await n.cancelarVenda(c, { vendaId: r.venda.id, justificativa: "Pedido cancelado após devolução integral" });
  assert.equal(await ind(n, "RECEITA_BRUTA"), 0);
  assert.equal(await ind(n, "DEDUCOES"), 0); // desconto e devoluções compensados junto com a receita
});

test("16, 17 — competência homologada bloqueia; fonte corrigida exige revisão sem sobrescrever a composição aplicada", async () => {
  const { n, caixa } = await base();
  const imp = await importar(n, "SAIPOS", "SAIPOS_VENDAS", saiposVendas([{ pedido: "P-1", data: "02/09/2026 12:00", itens: 3000, desconto: 300, forma: "Dinheiro" }]));
  await n.gerarPropostas(c, { importacaoId: imp.id, contaCaixaId: caixa.id });
  const [p] = await n.listarPropostas(c, { operacao: "VENDA" });
  await aprovarEAplicar(n, p);
  const v2 = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", ...PERIODO_SETEMBRO, substituiImportacaoId: imp.id, conteudo: saiposVendas([{ pedido: "P-1", data: "02/09/2026 12:00", itens: 3000, desconto: 100, forma: "Dinheiro" }]) });
  const conf = await n.confirmarImportacao(c, { importacaoId: v2.importacao.id, impressaoPrevia: v2.importacao.impressaoPrevia });
  await n.gerarPropostas(c, { importacaoId: conf.importacao.id, contaCaixaId: caixa.id });
  const nova = (await n.listarPropostas(c, { operacao: "VENDA" })).find((x) => x.id !== p.id);
  assert.equal(nova.estado, "AGUARDANDO_REVISAO");
  assert.equal(await ind(n, "DEDUCOES"), 300); // composição aplicada intacta
  await n.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_PRELIMINAR" });
  await n.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Homologação sintética." });
  await rejeita(n.registrarVenda(c, venda({ brutoCentavos: 1000, composicao: { itensCentavos: 1000, descontos: [{ valorCentavos: 100, financiador: "LOJA" }] }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 900 }] })), CODIGO.COMPETENCIA_HOMOLOGADA);
});
