// Execução 06B — Vendas e Recebimentos: venda → pagamento → transação → taxa → recebível → repasse → crédito → conciliação.
// Dados 100% SINTÉTICOS. Data-base: 15/10/2026. Roda em memória e, com FV2_REPOSITORIO=postgres, no banco isolado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ORG_A, ORG_B, UNI_A, UNI_A2, UNI_B, ctx, montarComCadastros, rejeita, sha } from "./helpers/cenario.js";
import { PERIODO_SETEMBRO, saiposFormas, saiposVendas, texto, unicredExtrato } from "./helpers/arquivos.js";
import { faturamentoSaiposPdf } from "./helpers/formatos.js";

const SET = { competencia: "2026-09" };
const ACEITE = { aceitarPendencias: true, justificativa: "Pendências sintéticas aceitas no teste." };
/** Stone no layout homologado (texto, 6 casas, desconto no "unificado"), em CSV sintético. */
const stoneCsv = (linhas) => texto(["STONE ID;DATA DA VENDA;PRODUTO;BANDEIRA;VALOR BRUTO;VALOR LIQUIDO;DESCONTO DE MDR;DESCONTO DE ANTECIPACAO;DESCONTO UNIFICADO;ULTIMO STATUS;CÓDIGO DE AUTORIZAÇÃO",
  ...linhas.map((l) => [l.id, l.quando, l.produto ?? "Credito", "Bandeira X", l.bruto, l.liquido, "0,000000", "0,000000", l.unificado ?? "0,000000", "Aprovada", l.aut ?? ""].join(";"))].join("\n"));

/**
 * Cenário de setembro/2026 (sintético):
 *   P-1 Balcão dinheiro (caixa) · P-2 Balcão crédito pago pela Stone S-1 (taxa com fração de centavo) · P-3 Balcão "múltiplas" sem pagamento
 *   agregado SAIPOS do dia 01/09 (sem canal) · iFood com descontos (loja, a classificar, subsídio comprovado) e componentes
 *   Anota AI × 2 num repasse agrupado · venda cancelada · S-9 Stone sem pedido · vale-refeição avulso com demonstrativo.
 */
async function cenario() {
  const m = await montarComCadastros();
  const { nucleo: n, c, banco, caixa } = m;
  const importar = async (fonte, tipoRelatorio, conteudo, extra = {}) => {
    const r = await n.receberArquivoParaImportacao(c, { fonte, tipoRelatorio, tipoMime: "application/octet-stream", conteudo, ...PERIODO_SETEMBRO, ...extra });
    return (await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? ACEITE : {}) })).importacao;
  };
  const aplicar = async (p) => { await n.aprovarProposta(c, { propostaId: p.id, justificativa: "Revisado no teste." }); return n.aplicarProposta(c, { propostaId: p.id }); };
  const doc = async (k, tipo, descricao) => (await n.registrarDocumento(c, { origem: "MANUAL", arquivoId: `arquivo-sintetico-${k}`, hashSha256: sha(k), tipo, recebidoEm: "2026-09-01", descricao })).documento.id;

  const vendasImp = await importar("SAIPOS", "SAIPOS_VENDAS", saiposVendas([
    { pedido: "P-1", data: "02/09/2026 12:00", canal: "Balcão", itens: 3000, forma: "Dinheiro" },
    { pedido: "P-2", data: "02/09/2026 12:05", canal: "Balcão", itens: 2500, forma: "Crédito", autorizacao: "AUT-1" },
    { pedido: "P-3", data: "02/09/2026 12:10", canal: "Balcão", itens: 5000, forma: "Múltiplas" },
  ]));
  await n.gerarPropostas(c, { importacaoId: vendasImp.id, contaCaixaId: caixa.id });
  for (const p of await n.listarPropostas(c, { operacao: "VENDA" })) await aplicar(p);
  const stoneImp = await importar("STONE", "STONE_VENDAS", stoneCsv([
    { id: "S-1", quando: "02/09/2026 12:06", bruto: "25,000000", liquido: "24,695000", unificado: "-0,305000", aut: "AUT-1" },
    { id: "S-9", quando: "03/09/2026 18:30", bruto: "77,000000", liquido: "75,459000", unificado: "-1,541000" },
  ]));
  await n.gerarPropostas(c, { importacaoId: stoneImp.id });
  const s1 = (await n.listarPropostas(c, { operacao: "PAGAMENTO_STONE" })).find((p) => p.comando.fonte.idExterno === "S-1");
  await aplicar(s1);
  const agr = await importar("SAIPOS", "SAIPOS_FATURAMENTO_POR_DIA", faturamentoSaiposPdf([{ data: "01/09/2026", valor: 50000, desconto: 3000 }]), { periodoInicio: "2026-09-01", periodoFim: "2026-09-01" });
  await n.gerarPropostas(c, { importacaoId: agr.id });
  for (const p of await n.listarPropostas(c, { operacao: "VENDA_AGREGADA" })) await aplicar(p);

  const subsidioDoc = await doc("sub", "DEMONSTRATIVO_REPASSE", "Promoção custeada pelo iFood (sintético)");
  const ifood = await n.registrarVenda(c, {
    canal: "IFOOD", dataVenda: "2026-09-05", brutoCentavos: 5700, fonte: { sistema: "MANUAL", idExterno: "IF-1" },
    composicao: { itensCentavos: 5000, servicosCentavos: 700, descontos: [{ valorCentavos: 300, financiador: "LOJA" }, { valorCentavos: 200, financiador: "PENDENTE" }, { valorCentavos: 500, financiador: "TERCEIRO", terceiro: "IFOOD", documentoId: subsidioDoc }] },
    pagamentos: [{ forma: "OUTRA", processador: "IFOOD", valorCentavos: 4700 }],
  });
  for (const [cat, v] of [["COMISSOES_IFOOD", 600], ["TAXAS_DE_PROCESSAMENTO", 150], ["MENSALIDADE_IFOOD", 100], ["ANUNCIOS_IFOOD", 200]]) {
    await n.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: ifood.recebiveis[0].id, valorCentavos: -v, motivo: `${cat} sintético`, categoria: cat });
  }
  // Repasse PARCIAL do iFood, registrado à mão (sem extrato): 2.000,00 de 3.650,00 esperados.
  const credIfood = await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-09-20", sentido: "ENTRADA", valorCentavos: 2000, natureza: "RECEBIMENTO", descricao: "CRED IFOOD SINT" });
  await n.registrarLiquidacao(c, { movimentacaoId: credIfood.movimentacao.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: ifood.recebiveis[0].id, valorCentavos: 2000 }] });

  // Anota AI: duas vendas e UM crédito agrupado, vindo do extrato Unicred (comprovado).
  const anota = [];
  for (const [id, v] of [["AN-1", 1800], ["AN-2", 2200]]) anota.push(await n.registrarVenda(c, { canal: "ANOTA_AI", dataVenda: "2026-09-06", brutoCentavos: v, fonte: { sistema: "MANUAL", idExterno: id }, composicao: { itensCentavos: v }, pagamentos: [{ forma: "PIX", processador: "ANOTA_AI", valorCentavos: v }] }));
  const extrato = await importar("UNICRED", "UNICRED_EXTRATO", unicredExtrato({ saldoInicial: 100000, lancamentos: [{ data: "10/09/2026", historico: "CRED ANOTA AI REPASSE", valor: 4000 }] }));
  await n.gerarPropostas(c, { importacaoId: extrato.id, contaBancariaId: banco.id });
  const [pm] = await n.listarPropostas(c, { operacao: "MOVIMENTACAO_BANCARIA" });
  const movAnota = (await aplicar(pm)).efeitos.find((e) => e.tipo === "MOVIMENTACAO").id;
  await n.registrarLiquidacao(c, { movimentacaoId: movAnota, alocacoes: anota.map((a) => ({ alvoTipo: "RECEBIVEL", alvoId: a.recebiveis[0].id, valorCentavos: a.venda.brutoCentavos })) });

  const cancelada = await n.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-09-07", brutoCentavos: 1500, fonte: { sistema: "MANUAL", idExterno: "CX-1" }, composicao: { itensCentavos: 1500 }, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 1500 }] });
  await n.cancelarVenda(c, { vendaId: cancelada.venda.id, justificativa: "Pedido lançado em duplicidade (sintético)." });

  const vrDoc = await doc("vr", "DEMONSTRATIVO_REPASSE", "Demonstrativo do vale (sintético)");
  const vr = await n.registrarRecebivel(c, { processador: "OPERADORA_BENEFICIOS", brutoCentavos: 48000, retencoes: [{ categoria: "TAXAS_DE_PROCESSAMENTO", valorCentavos: 2880 }], dataPrevista: "2026-10-28", competencia: "2026-09", descricao: "Vale de setembro", documentoIds: [vrDoc] });

  const vendaDe = async (pedido) => (await n.listarPropostas(c, { operacao: "VENDA" })).find((p) => p.comando.fonte.idExterno === pedido).efeitos.find((e) => e.tipo === "VENDA").id;
  return { ...m, n, importar, aplicar, ifood, anota, cancelada, vr, movAnota, p1: await vendaDe("P-1"), p2: await vendaDe("P-2"), p3: await vendaDe("P-3") };
}
const porId = (r, id) => r.itens.find((x) => x.id === id);

test("4, 5, 19, 20 — vendas por canal; agregado sem canal e sem pedidos; bruto listado = DRE; nada duplicado", async () => {
  const { n, c, p1, p2, ifood } = await cenario();
  const r = await n.consultarVendas(c, { ...SET, tamanho: 100 });
  const ap = await n.apurarCompetencia(c, SET);
  const fb = ap.indicadores.FATURAMENTO_BRUTO_PROPRIO;
  // Conferência com a DRE (motor central): mesmo número, sem cálculo próprio.
  assert.deepEqual(r.resumo.conferenciaComDre, { brutoListadoCentavos: fb.valorCentavos, faturamentoDaDreCentavos: fb.valorCentavos, confere: true });
  assert.equal(r.resumo.dre.faturamentoBrutoCentavos, fb.valorCentavos);
  assert.equal(r.resumo.canceladas, 1);
  // Por canal: a soma das vendas listadas no canal é a mesma do faturamento por canal da DRE.
  for (const canal of ["BALCAO", "IFOOD", "ANOTA_AI", "NAO_IDENTIFICADO"]) {
    const doCanal = await n.consultarVendas(c, { ...SET, canal });
    assert.equal(doCanal.resumo.brutoProprioCentavos, fb.porCanal.find((x) => x.canal === canal).valorCentavos, canal);
  }
  // Agregado: identificado como tal, sem canal/forma/processador, sem pedidos inventados.
  const agregados = r.itens.filter((x) => x.tipo === "AGREGADO_DIARIO");
  assert.equal(agregados.length, 1);
  const [ag] = agregados;
  assert.deepEqual([ag.canal, ag.formas, ag.processadores, ag.situacao, ag.valores.brutoProprioCentavos, ag.valores.descontosCentavos, ag.valores.cobradoDoConsumidorCentavos], [null, [], [], "AGREGADA_SEM_DETALHE", 53000, 3000, 50000]);
  assert.equal(ag.confiabilidade.nivel, "AGREGADA_SEM_DETALHE");
  assert.match(ag.titulo, /agregado do dia 01\/09\/2026/);
  const detAg = await n.detalharVenda(c, { id: ag.id });
  assert.match(detAg.operacao.explicacao, /nada disso é presumido/);
  assert.deepEqual(detAg.linhaDoTempo.map((e) => [e.etapa, e.situacao]), [["VENDA_REGISTRADA", "CONCLUIDA"], ["PAGAMENTO_INFORMADO", "PENDENTE"]]);
  // Venda individual: identificador exibível, horário da fonte, título para o gestor (não "Venda BALCAO").
  const v1 = porId(r, p1);
  assert.deepEqual([v1.identificador, v1.horario, v1.titulo, v1.canal], ["SAIPOS · P-1", "12:00:00", "Venda no Balcão — dinheiro", "BALCAO"]);
  assert.equal(porId(r, ifood.venda.id).titulo, "Venda no iFood — pago pelo iFood (forma não detalhada)");
  assert.ok(r.itens.every((x) => !/Venda (BALCAO|IFOOD|ANOTA_AI)/.test(x.titulo)));
  // Ausência de duplicidade: cada venda aparece uma vez; a Stone não criou venda; agregado e pedidos são de dias diferentes.
  const ids = r.itens.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(r.itens.filter((x) => x.tipo === "VENDA").length, 3 + 1 + 2 + 1);
  assert.ok(!ap.pendencias.some((p) => p.tipo === "SOBREPOSICAO_AGREGADO_PEDIDOS"));
  assert.equal(porId(r, p2).valores.brutoProprioCentavos, 2500, "a transação S-1 não somou receita à venda");
});

test("7, 9, 11, 10 — pagamento misto, Stone sem pedido NÃO vira venda, taxa com fração de centavo, processador sem canal", async () => {
  const { n, c, p2, p3 } = await cenario();
  // P-3 ("Múltiplas"): sem pagamento → divergência; completa com dinheiro + crédito Stone (manual) → pagamento misto.
  let r = await n.consultarVendas(c, SET);
  assert.equal(porId(r, p3)?.situacao ?? (await n.consultarVendas(c, { ...SET, situacao: "AGUARDANDO_PAGAMENTO" })).itens.find((x) => x.id === p3).situacao, "AGUARDANDO_PAGAMENTO");
  await n.registrarPagamentoDeVenda(c, { vendaId: p3, forma: "DINHEIRO", valorCentavos: 2000 });
  await n.registrarPagamentoDeVenda(c, { vendaId: p3, forma: "CREDITO", processador: "STONE", valorCentavos: 3000 });
  const det3 = await n.detalharVenda(c, { id: p3 });
  assert.equal(det3.operacao.titulo, "Venda no Balcão — pagamento misto (dinheiro + cartão de crédito)");
  assert.deepEqual(det3.operacao.pagamentos.map((x) => [x.forma, x.processador, x.destino]), [["DINHEIRO", null, "SEM_DESTINO_REGISTRADO"], ["CREDITO", "STONE", "RECEBIVEL"]]);
  assert.deepEqual([...det3.operacao.formas].sort(), ["CREDITO", "DINHEIRO"]);
  // Pagamento ≠ recebível: o recebível é só da parte do processador; dinheiro sem conta fica "a identificar".
  assert.equal(det3.operacao.recebiveis.length, 1);
  assert.equal(det3.operacao.diretoSemDestinoCentavos, 2000);
  // Transação Stone (TRANSACAO_PROCESSADA) sem relatório do processador fica PENDENTE.
  assert.ok(det3.linhaDoTempo.some((e) => e.etapa === "TRANSACAO_PROCESSADA" && e.situacao === "PENDENTE"));
  // P-2: transação S-1 aplicada → processada; taxa 0,305000 → 31 centavos (metade para cima), exato preservado.
  const det2 = await n.detalharVenda(c, { id: p2 });
  const proc = det2.linhaDoTempo.find((e) => e.etapa === "TRANSACAO_PROCESSADA");
  assert.deepEqual([proc.situacao, proc.fonte], ["CONCLUIDA", "STONE"]);
  const [taxa] = det2.operacao.recebiveis[0].componentes;
  assert.deepEqual([taxa.tipo, taxa.valorCentavos, taxa.fracao.exatoMilionesimos, taxa.fracao.exatoReais, taxa.fracao.registradoCentavos, taxa.fracao.arredondamento, taxa.fracao.temFracao],
    ["TAXA_DE_PROCESSAMENTO", 31, 305000, "0,305000", 31, "METADE_PARA_CIMA", true]);
  const taxas = await n.consultarTaxasEDescontos(c, { ...SET, tipoComponente: "TAXA_DE_PROCESSAMENTO", tamanho: 100 });
  assert.ok(taxas.totais.comFracaoDeCentavo >= 1);
  assert.match(taxas.regraDeArredondamento, /METADE PARA CIMA/);
  // S-9: preservada SEM venda. Não aparece como venda, não soma faturamento, aparece em pagamentos e divergências.
  r = await n.consultarVendas(c, { ...SET, tamanho: 100 });
  assert.ok(!r.itens.some((x) => x.identificador.includes("S-9")));
  const pags = await n.consultarPagamentosDeVendas(c, SET);
  const [s9] = pags.transacoesSemVenda;
  assert.deepEqual([s9.valorCentavos, s9.motivo, s9.taxas[0].exatoReais, s9.taxas[0].registradoCentavos], [7700, "SEM_PEDIDO_CORRESPONDENTE", "1,541000", 154]);
  const stone = pags.processadores.find((x) => x.processador === "STONE");
  assert.deepEqual([stone.transacoesSemVenda, stone.transacoesSemVendaCentavos], [1, 7700]);
  assert.equal(stone.brutoProcessadoCentavos, 2500 + 3000, "só transações VINCULADAS a vendas contam como processado");
  const div = await n.consultarDivergenciasDeVendas(c, { ...SET, codigo: "TRANSACAO_SEM_PEDIDO" });
  assert.equal(div.itens.length, 1);
  assert.match(div.itens[0].motivo, /NÃO vira venda/);
  // Processador sem canal comprovado: o vale avulso entra no processador com canal NAO_IDENTIFICADO (nunca presumido).
  const vale = pags.processadores.find((x) => x.processador === "OPERADORA_BENEFICIOS");
  assert.deepEqual(Object.keys(vale.porCanal), ["NAO_IDENTIFICADO"]);
});

test("12, 18, 6 — iFood com vários componentes: descontos ≠ despesas; subsídio não reduz receita; desconto sem financiador", async () => {
  const { n, c, ifood } = await cenario();
  const det = await n.detalharVenda(c, { id: ifood.venda.id });
  const v = det.operacao;
  assert.deepEqual([v.valores.brutoProprioCentavos, v.valores.receita.servicosCentavos, v.valores.descontosCentavos, v.valores.cobradoDoConsumidorCentavos], [5700, 700, 1000, 4700]);
  assert.deepEqual(v.descontos.map((x) => [x.tipo, x.valorCentavos, x.linhaDaDre]), [
    ["DESCONTO_DA_LOJA", 300, "DEDUCOES_COMERCIAIS"], ["DESCONTO_FINANCIADOR_NAO_COMPROVADO", 200, "DEDUCOES_COMERCIAIS"], ["SUBSIDIO_DE_TERCEIRO", 500, "NENHUMA_SUBSIDIO_A_RECEBER"],
  ]);
  assert.equal(v.confiabilidade.nivel, "COM_PENDENCIA");
  const pg = await n.consultarPagamentosDeVendas(c, { ...SET, processador: "IFOOD" });
  const i = pg.ifood;
  assert.deepEqual([i.brutoProprioCentavos, i.descontosDaLojaCentavos, i.descontosAClassificarCentavos, i.subsidiosDeTerceiroCentavos, i.comissoesCentavos, i.taxasCentavos, i.mensalidadesCentavos, i.anunciosCentavos],
    [5700, 300, 200, 500, 600, 150, 100, 200]);
  // Recebível do iFood: pagamento 4.700 + subsídio 500 viram DOIS direitos a receber; custos abatem só o do pagamento.
  assert.equal(i.liquidoEsperadoCentavos, 4700 - 1050 + 500);
  assert.equal(i.repassadoCentavos, 2000);
  assert.equal(i.aReceberCentavos, 4700 - 1050 + 500 - 2000, "apurado não é presumido depositado");
  assert.match(i.observacao, /não é lucro/);
  // Divergência "desconto sem financiador" para a venda e para o agregado do dia 01/09.
  const dv = await n.consultarDivergenciasDeVendas(c, { ...SET, codigo: "DESCONTO_SEM_FINANCIADOR" });
  assert.deepEqual(dv.itens.map((x) => x.valorCentavos).sort((a, b) => a - b), [200, 3000]);
  // Taxas e descontos: comerciais (deduções) separados dos custos do recebimento; conferência com a DRE.
  const tx = await n.consultarTaxasEDescontos(c, { ...SET, tamanho: 100 });
  const ap = await n.apurarCompetencia(c, SET);
  assert.equal(tx.totais.descontosComerciaisCentavos, -ap.dre.linhas.find((l) => l.codigo === "DEDUCOES_COMERCIAIS").valorCentavos, "deduções listadas = deduções da DRE");
  assert.equal(tx.porTipo.SUBSIDIO_DE_TERCEIRO, 500);
  assert.equal(tx.totais.custosDoRecebimentoCentavos, 600 + 150 + 100 + 200 + 31 + 2880);
});

test("8 — venda cancelada: preservada com histórico, fora dos totais, recebível cancelado, linha do tempo com cancelamento", async () => {
  const { n, c, cancelada } = await cenario();
  const r = await n.consultarVendas(c, { ...SET, situacao: "CANCELADA" });
  assert.deepEqual(r.itens.map((x) => x.id), [cancelada.venda.id]);
  assert.equal(r.resumo.brutoProprioCentavos, null, "só canceladas no filtro: nada a somar (desconhecido ≠ zero)");
  const det = await n.detalharVenda(c, { id: cancelada.venda.id });
  assert.equal(det.operacao.recebiveis[0].situacaoRecebimento, "CANCELADO");
  assert.ok(det.linhaDoTempo.some((e) => e.etapa === "CANCELAMENTO" && e.situacao === "CONCLUIDA"));
  assert.ok(det.historico.some((h) => h.evento === "CANCELAMENTO"));
  const div = await n.consultarDivergenciasDeVendas(c, { ...SET, tamanho: 100 });
  assert.ok(!div.itens.some((x) => x.referencia.id === cancelada.venda.id));
});

test("13, 14, 15, 16, 21 — recebível parcial, repasse agrupado, crédito sem extrato, linha do tempo incompleta; igual a Contas a Receber", async () => {
  const { n, c, ifood, anota, vr } = await cenario();
  const r = await n.consultarRecebiveisERepasses(c, { ...SET, tamanho: 100 });
  const rif = porId(r, ifood.recebiveis[0].id);
  assert.deepEqual([rif.esperadoCentavos, rif.liquidadoCentavos, rif.saldoCentavos, rif.situacaoRecebimento, rif.origemDaPrevisao, rif.dataPrevista], [3650, 2000, 1650, "PARCIALMENTE_RECEBIDO", "SEM_PREVISAO", null]);
  assert.equal(rif.creditos[0].comprovacao, "SEM_COMPROVACAO");
  // Repasse agrupado: UM crédito do extrato liquida duas vendas; comprovado pelo extrato.
  const agrupado = r.creditos.find((x) => x.titulos.length === 2);
  assert.deepEqual([agrupado.valorCentavos, agrupado.vendas, agrupado.comprovacao, agrupado.fonte], [4000, 2, "EXTRATO_BANCARIO", "UNICRED"]);
  for (const a of anota) assert.equal(porId(r, a.recebiveis[0].id).situacaoRecebimento, "RECEBIDO_E_COMPROVADO");
  // Vale: previsão documentada (data do demonstrativo), repasse informado, sem crédito → divergência própria.
  const rvr = porId(r, vr.recebivel.id);
  assert.deepEqual([rvr.origemDaPrevisao, rvr.repasse.informado, rvr.situacaoRecebimento], ["DOCUMENTO_DO_PROCESSADOR", true, "NAO_RECEBIDO"]);
  const divs = await n.consultarDivergenciasDeVendas(c, { ...SET, tamanho: 100 });
  const codigos = new Set(divs.itens.map((x) => x.codigo));
  for (const k of ["CREDITO_SEM_COMPROVACAO_BANCARIA", "REPASSE_INFORMADO_SEM_CREDITO", "VENDA_SEM_PAGAMENTO", "VENDA_SEM_CANAL"]) assert.ok(codigos.has(k), k);
  for (const x of divs.itens) for (const campo of ["titulo", "fonte", "periodo", "motivo", "evidencias", "situacao", "proximaAcao", "competencia"]) assert.ok(campo in x, `${x.codigo}.${campo}`);
  // Linha do tempo incompleta: o que não aconteceu fica PENDENTE (nunca concluído).
  const t = await n.detalharRecebimento(c, { id: ifood.recebiveis[0].id });
  const etapas = t.linhaDoTempo.map((e) => [e.etapa, e.situacao]);
  assert.ok(etapas.some(([e, s]) => e === "REPASSE_INFORMADO" && s === "PENDENTE"));
  assert.ok(etapas.some(([e, s]) => e === "CONCILIACAO_CONFIRMADA" && s === "PENDENTE"));
  assert.ok(etapas.some(([e, s]) => e === "CREDITO_BANCARIO_IDENTIFICADO" && s === "PENDENTE"), "saldo ainda não creditado");
  assert.ok(t.linhaDoTempo.filter((e) => e.situacao === "CONCLUIDA").every((e) => e.etapa !== "CONCILIACAO_CONFIRMADA"));
  assert.equal(t.venda.id, ifood.venda.id);
  // Mesmos valores em Contas a Receber (mesmas regras de título).
  const cr = await n.consultarContasAReceber(c, { competencia: "2026-09", tamanho: 100 });
  const vivos = r.itens.filter((x) => x.situacaoRecebimento !== "CANCELADO");
  for (const x of vivos) {
    const t2 = cr.itens.find((y) => y.id === x.id);
    assert.deepEqual([t2.esperadoCentavos, t2.recebidoCentavos, t2.saldoCentavos], [x.esperadoCentavos, x.liquidadoCentavos, x.saldoCentavos], x.id);
  }
  assert.equal(r.totais.saldoCentavos, cr.totais.saldoCentavos);
});

test("17 — divergência de valores: relatórios do mesmo período com totais diferentes e valor/taxa divergente; nada é ajustado", async () => {
  const { n, c, importar, ifood, banco } = await cenario();
  await importar("SAIPOS", "SAIPOS_FORMAS_PAGAMENTO", saiposFormas([["Dinheiro", 1, 40000]]), { periodoInicio: "2026-09-01", periodoFim: "2026-09-01" });
  await n.registrarDivergenciaEntreFontes(c, { periodoInicio: "2026-09-01", periodoFim: "2026-09-01" });
  // Crédito de 1.600,00 contra saldo de 1.650,00: correspondência marcada como DIVERGENTE (não "fecha por proximidade").
  const mov = await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-09-25", sentido: "ENTRADA", valorCentavos: 1600, natureza: "RECEBIMENTO" });
  const corr = await n.criarCorrespondenciaCandidata(c, { ladoA: [{ tipo: "RECEBIVEL", id: ifood.recebiveis[0].id, valorCentavos: 1650 }], ladoB: [{ tipo: "MOVIMENTACAO", id: mov.movimentacao.id, valorCentavos: 1600 }] });
  await n.registrarDivergencia(c, { correspondenciaId: corr.id, justificativa: "Crédito menor que o saldo esperado (sintético)." });
  const d = await n.consultarDivergenciasDeVendas(c, { ...SET, tamanho: 100 });
  const rel = d.itens.find((x) => x.codigo === "TOTAIS_DE_RELATORIOS_DIFERENTES");
  assert.deepEqual([rel.valorCentavos, rel.situacao, rel.periodo], [10000, "ABERTA", { inicio: "2026-09-01", fim: "2026-09-01" }]);
  const val = d.itens.find((x) => x.codigo === "TAXA_OU_VALOR_DIVERGENTE");
  assert.equal(val.valorCentavos, 1650);
  assert.equal((await n.detalharVenda(c, { id: ifood.venda.id })).operacao.situacao, "EM_DIVERGENCIA");
  assert.ok(d.porCodigo.TAXA_OU_VALOR_DIVERGENTE.quantidade === 1);
  // Nenhum ajuste foi criado para "fechar" a diferença.
  const ajustes = (await n.detalharRecebimento(c, { id: ifood.recebiveis[0].id })).recebivel.componentes.filter((x) => x.tipo === "OUTRO_AJUSTE");
  assert.equal(ajustes.length, 0);
});

test("22, 23, 24 — isolamento por organização e unidade; permissão explícita; escopo não autorizado; campos de escopo recusados", async () => {
  const { n, c } = await cenario();
  const outra = await n.consultarVendas(ctx(ORG_A, UNI_A2), SET);
  assert.deepEqual([outra.itens.length, outra.resumo.brutoProprioCentavos], [0, null]);
  assert.equal((await n.consultarPagamentosDeVendas(ctx(ORG_B, UNI_B), SET)).itens.length, 0);
  assert.equal((await n.consultarRecebiveisERepasses(ctx(ORG_B, UNI_B), SET)).itens.length, 0);
  const id = (await n.consultarVendas(c, SET)).itens[0].id;
  await rejeita(n.detalharVenda(ctx(ORG_A, UNI_A2), { id }), CODIGO.NAO_ENCONTRADO);
  await rejeita(n.consultarVendas(ctx(ORG_A, UNI_A, [ACAO.REGISTRAR]), SET), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(n.consultarVendas(ctx(ORG_A, "aaaaaaaa-0000-4000-8000-0000000000ff"), SET), CODIGO.ESCOPO_NAO_AUTORIZADO);
  await rejeita(n.consultarVendas(null, SET), CODIGO.CONTEXTO_INVALIDO); // sem contexto autenticado: nada é lido
  await rejeita(n.consultarVendas(c, { ...SET, organizacaoId: ORG_B }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(n.consultarDivergenciasDeVendas(c, { ...SET, unidadeId: UNI_B }), CODIGO.ENTRADA_INVALIDA);
  void UNI_A;
});

test("25 — paginação, filtros e limites de volume", async () => {
  const { n, c, p1 } = await cenario();
  const p = await n.consultarVendas(c, { ...SET, tamanho: 3, pagina: 2 });
  assert.deepEqual([p.paginacao.pagina, p.paginacao.tamanho, p.itens.length], [2, 3, 3]);
  assert.equal(p.paginacao.total, 8);
  const todas = await n.consultarVendas(c, { ...SET, tamanho: 100 });
  assert.equal(p.resumo.brutoProprioCentavos, todas.resumo.brutoProprioCentavos, "resumo cobre o conjunto filtrado, não a página");
  assert.deepEqual((await n.consultarVendas(c, { ...SET, identificador: "p-1" })).itens.map((x) => x.id), [p1]);
  assert.ok((await n.consultarVendas(c, { ...SET, forma: "DINHEIRO" })).itens.every((x) => x.formas.includes("DINHEIRO")));
  assert.ok((await n.consultarVendas(c, { ...SET, forma: "DESCONHECIDA" })).itens.every((x) => x.formaDesconhecida));
  assert.ok((await n.consultarVendas(c, { ...SET, processador: "SEM_PROCESSADOR" })).itens.every((x) => x.tipo === "VENDA" && !x.processadores.length));
  assert.deepEqual((await n.consultarVendas(c, { ...SET, valorMinimoCentavos: 50000 })).itens.map((x) => x.tipo), ["AGREGADO_DIARIO"]);
  assert.equal((await n.consultarVendas(c, { inicio: "2026-09-02", fim: "2026-09-02" })).itens.length, 3);
  assert.equal((await n.consultarVendas(c, { competencia: "2026-08" })).itens.length, 0);
  await rejeita(n.consultarVendas(c, {}), CODIGO.ENTRADA_INVALIDA);
  await rejeita(n.consultarVendas(c, { inicio: "2026-01-01", fim: "2027-03-01" }), CODIGO.DATA_INVALIDA);
  await rejeita(n.consultarVendas(c, { inicio: "2026-09-01" }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(n.consultarVendas(c, { ...SET, tamanho: 101 }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(n.consultarVendas(c, { ...SET, valorMinimoCentavos: 10, valorMaximoCentavos: 5 }), CODIGO.VALOR_INVALIDO);
  await rejeita(n.consultarVendas(c, { ...SET, canal: "TELEPATIA" }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(n.detalharVenda(c, { id: "nao-e-uuid" }), CODIGO.ENTRADA_INVALIDA);
});
