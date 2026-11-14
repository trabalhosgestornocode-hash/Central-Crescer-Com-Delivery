// Execução 03 — formação de operações financeiras a partir de registros importados (dados 100% SINTÉTICOS).
// Roda em memória e, com FV2_REPOSITORIO=postgres, no PostgreSQL local isolado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ORG_B, UNI_A2, UNI_B, ctx, montar, rejeita } from "./helpers/cenario.js";
import { PERIODO_SETEMBRO, foodyEntregas, saiposFormas, saiposVendas, texto, unicredExtrato } from "./helpers/arquivos.js";
import { faturamentoSaiposPdf } from "./helpers/formatos.js";

const ACEITE = { aceitarPendencias: true, justificativa: "Pendências sintéticas aceitas no teste." };
const c = ctx();
const total = async (n, indicador, x = c) => (await n.consultarComposicao(x, { competencia: "2026-09", indicador })).totalCentavos;

async function importar(nucleo, fonte, tipoRelatorio, conteudo, extra = {}) {
  const r = await nucleo.receberArquivoParaImportacao(c, { fonte, tipoRelatorio, tipoMime: "application/octet-stream", conteudo, ...PERIODO_SETEMBRO, ...extra });
  assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR", JSON.stringify(r.previa.erros));
  const conf = await nucleo.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? ACEITE : {}) });
  return conf.importacao;
}
const propostas = (n, filtro = {}) => n.listarPropostas(c, filtro);
const aprovarEAplicar = async (n, p, j = "Revisado no teste.") => { await n.aprovarProposta(c, { propostaId: p.id, justificativa: j }); return n.aplicarProposta(c, { propostaId: p.id }); };

/** Stone no layout real (texto, 6 casas, desconto do cartão no "unificado"), em CSV sintético. */
const stoneCsv = (linhas) => texto(["STONE ID;DATA DA VENDA;PRODUTO;BANDEIRA;VALOR BRUTO;VALOR LIQUIDO;DESCONTO DE MDR;DESCONTO DE ANTECIPACAO;DESCONTO UNIFICADO;ULTIMO STATUS;CÓDIGO DE AUTORIZAÇÃO",
  ...linhas.map((l) => [l.id, l.quando, l.produto ?? "Credito", "Bandeira X", l.bruto, l.liquido, l.mdr ?? "0,000000", l.antecipacao ?? "0,000000", l.unificado ?? "0,000000", "Aprovada", l.aut ?? ""].join(";"))].join("\n"));

async function cenarioVendas(opcoes = {}) {
  const m = montar(opcoes);
  const n = m.nucleo;
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  const banco = await n.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco Sintético" });
  const imp = await importar(n, "SAIPOS", "SAIPOS_VENDAS", saiposVendas([
    { pedido: "P-1", data: "02/09/2026 12:00", canal: "Balcão", itens: 3000, forma: "Dinheiro" },
    { pedido: "P-2", data: "02/09/2026 12:05", canal: "Balcão", itens: 2500, forma: "Crédito", autorizacao: "AUT-1" },
    { pedido: "P-3", data: "02/09/2026 12:10", canal: "Balcão", itens: 5000, forma: "Múltiplas" },
    { pedido: "P-4", data: "02/09/2026 12:20", canal: "Balcão", itens: 900, forma: "Pix", situacao: "Cancelado" },
  ]));
  const g = await n.gerarPropostas(c, { importacaoId: imp.id, contaCaixaId: caixa.id });
  return { ...m, n, caixa, banco, imp, g };
}

test("1, 26 — venda formada só após aprovação, com rastro até o documento; cancelado não vira venda", async () => {
  const { n, g, imp } = await cenarioVendas();
  assert.equal(g.criadas, 3); // P-4 cancelado fica só na origem
  assert.equal(await total(n, "RECEITA_BRUTA"), 0); // proposta não tem efeito
  const [p1] = (await propostas(n, { operacao: "VENDA" })).filter((p) => p.comando.fonte.idExterno === "P-1");
  assert.equal(p1.confianca, "ALTA");
  assert.equal(p1.categoriaSugerida, "VENDA_BALCAO");
  await rejeita(n.aplicarProposta(c, { propostaId: p1.id }), CODIGO.TRANSICAO_INVALIDA); // sem aprovação não aplica
  const r = await aprovarEAplicar(n, p1);
  assert.equal(await total(n, "RECEITA_BRUTA"), 3000);
  const vendaId = r.efeitos.find((e) => e.tipo === "VENDA").id;
  assert.ok(r.efeitos.some((e) => e.tipo === "MOVIMENTACAO")); // dinheiro entra no caixa físico
  // Rastreabilidade: efeito → proposta → registro importado → importação → documento original.
  const regs = await n.listarRegistrosImportados(c, { importacaoId: imp.id });
  const origem = regs.find((x) => x.id === r.proposta.registroIds[0]);
  assert.equal(origem.idExterno, "P-1");
  assert.equal(r.proposta.documentoIds[0], imp.documentoId);
  assert.ok((await n.lerArquivoDoDocumento(c, { documentoId: imp.documentoId })).conteudo.byteLength > 0);
  assert.ok(vendaId);
});

test("2, 6, 7, 8 — pagamentos mistos; Stone vincula à venda, gera recebível e taxa como despesa de recebimento (fração de centavo explícita)", async () => {
  const { n, banco } = await cenarioVendas();
  for (const p of await propostas(n, { operacao: "VENDA" })) await aprovarEAplicar(n, p);
  const imp = await importar(n, "STONE", "STONE_VENDAS", stoneCsv([
    { id: "S-1", quando: "02/09/2026 12:06", bruto: "25,000000", liquido: "24,695000", unificado: "-0,305000", aut: "AUT-1" },
    { id: "S-2", quando: "02/09/2026 12:11", bruto: "30,000000", liquido: "29,400000", unificado: "-0,600000" },
  ]));
  await n.gerarPropostas(c, { importacaoId: imp.id });
  const ps = await propostas(n, { operacao: "PAGAMENTO_STONE" });
  const s1 = ps.find((p) => p.comando.fonte.idExterno === "S-1");
  assert.equal(s1.confianca, "ALTA"); // autorização em comum
  assert.ok(s1.divergencias.some((d) => d.codigo === "ARREDONDAMENTO_DE_TAXA"));
  assert.equal(s1.comando.taxas[0].micros, 305000);
  assert.equal(s1.comando.taxas[0].valorCentavos, 31);
  const despesasAntes = await total(n, "DESPESAS");
  const r = await aprovarEAplicar(n, s1);
  assert.ok(r.efeitos.some((e) => e.tipo === "RECEBIVEL"));
  assert.equal(await total(n, "DESPESAS") - despesasAntes, 31);
  assert.equal(await total(n, "RECEITA_BRUTA"), 10500); // a Stone NÃO cria venda nem receita
  // P-3 ("Múltiplas", 50,00): parte em dinheiro + parte pela Stone (S-2 casa pelo valor pendente após o dinheiro).
  const p3 = (await propostas(n, { operacao: "VENDA" })).find((p) => p.comando.fonte.idExterno === "P-3");
  const venda3 = p3.efeitos.find((e) => e.tipo === "VENDA").id;
  void banco;
  assert.equal(ps.find((p) => p.comando.fonte.idExterno === "S-2").estado, "AGUARDANDO_EVIDENCIA"); // 30,00 ≠ pendente 50,00
  await n.registrarPagamentoDeVenda(c, { vendaId: venda3, forma: "DINHEIRO", valorCentavos: 2000 });
  const reav = await n.gerarPropostas(c, { importacaoId: imp.id }); // evidência nova: reavalia, sem duplicar
  assert.equal(reav.criadas, 0);
  assert.equal(reav.reavaliadas, 1);
  const s2 = (await propostas(n, { operacao: "PAGAMENTO_STONE" })).find((p) => p.comando.fonte.idExterno === "S-2" && p.comando.vendaId === venda3);
  assert.ok(s2, "S-2 deve casar com a venda mista pelo valor pendente");
  await aprovarEAplicar(n, s2);
});

test("3, 4 — relatório agregado vira receita AGREGADA (sem canal) e nunca convive com vendas por pedido do mesmo dia", async () => {
  const { n } = await cenarioVendas();
  const imp = await importar(n, "SAIPOS", "SAIPOS_FATURAMENTO_POR_DIA", faturamentoSaiposPdf([{ data: "01/09/2026", valor: 50000, desconto: 3000 }, { data: "02/09/2026", valor: 10500, desconto: 0 }]));
  await n.gerarPropostas(c, { importacaoId: imp.id });
  const [dia1, dia2] = (await propostas(n, { operacao: "VENDA_AGREGADA" })).sort((a, b) => (a.dataOperacao < b.dataOperacao ? -1 : 1));
  assert.equal(dia1.categoriaSugerida, "VENDAS_AGREGADAS_SEM_CANAL");
  assert.equal(dia1.comando.receitaBrutaCentavos, 53000);
  await aprovarEAplicar(n, dia1);
  assert.equal(await total(n, "RECEITA_BRUTA"), 53000);
  assert.equal(await total(n, "DEDUCOES"), 3000); // desconto com efeito próprio
  assert.equal((await n.consultarComposicao(c, { competencia: "2026-09", indicador: "RECEITA_BRUTA" })).itens[0].canal ?? null, null); // canal NÃO inventado
  // Dia 2: o agregado conflita com as vendas por pedido do mesmo dia.
  const p1 = (await propostas(n, { operacao: "VENDA" })).find((p) => p.comando.fonte.idExterno === "P-1");
  await aprovarEAplicar(n, dia2);
  await n.aprovarProposta(c, { propostaId: p1.id });
  await rejeita(n.aplicarProposta(c, { propostaId: p1.id }), CODIGO.CONFLITO_IDEMPOTENCIA);
  // Política: reverter o agregado do dia (cancelado, não apagado) e então aplicar os pedidos.
  await n.reverterPropostaAgregada(c, { propostaId: dia2.id, justificativa: "Chegou o relatório por pedido do dia." });
  await n.aplicarProposta(c, { propostaId: p1.id });
  assert.equal(await total(n, "RECEITA_BRUTA"), 53000 + 3000);
});

test("5 — transação Stone sem pedido correspondente: preservada, aguardando evidência, nenhuma venda criada", async () => {
  const { n } = await cenarioVendas();
  const imp = await importar(n, "STONE", "STONE_VENDAS", stoneCsv([{ id: "S-9", quando: "05/09/2026 09:00", bruto: "77,000000", liquido: "76,000000", unificado: "-1,000000" }]));
  await n.gerarPropostas(c, { importacaoId: imp.id });
  const [p] = await propostas(n, { operacao: "PAGAMENTO_STONE" });
  assert.equal(p.estado, "AGUARDANDO_EVIDENCIA");
  assert.ok(p.divergencias.some((d) => d.codigo === "SEM_PEDIDO_CORRESPONDENTE"));
  await rejeita(n.aprovarProposta(c, { propostaId: p.id }), CODIGO.TRANSICAO_INVALIDA);
  assert.equal(await total(n, "RECEITA_BRUTA"), 0);
});

test("9, 10 — recebível parcial e repasse agrupado: um crédito liquida vários recebíveis; saldo nunca negativo; data prevista pendente", async () => {
  const { n, banco } = await cenarioVendas();
  for (const p of await propostas(n, { operacao: "VENDA" })) if (p.comando.fonte.idExterno === "P-2") await aprovarEAplicar(n, p);
  const v = await n.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-09-02", brutoCentavos: 4000, pagamentos: [{ forma: "DEBITO", processador: "STONE", valorCentavos: 4000 }], fonte: { sistema: "MANUAL", idExterno: "V-SINT" } });
  const imp = await importar(n, "STONE", "STONE_VENDAS", stoneCsv([{ id: "S-1", quando: "02/09/2026 12:06", bruto: "25,000000", liquido: "24,700000", unificado: "-0,300000", aut: "AUT-1" }]));
  await n.gerarPropostas(c, { importacaoId: imp.id });
  const r = await aprovarEAplicar(n, (await propostas(n, { operacao: "PAGAMENTO_STONE" }))[0]);
  const rec1 = r.efeitos.find((e) => e.tipo === "RECEBIVEL").id;
  const rec2 = v.recebiveis[0].id;
  assert.equal(v.recebiveis[0].dataPrevista, null); // sem previsão confiável: pendente, nunca inventada
  const credito = await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-09-03", sentido: "ENTRADA", valorCentavos: 4470, natureza: "RECEBIMENTO" });
  const liq = await n.registrarLiquidacao(c, { movimentacaoId: credito.movimentacao.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: rec1, valorCentavos: 2470 }, { alvoTipo: "RECEBIVEL", alvoId: rec2, valorCentavos: 2000 }] });
  assert.ok(liq);
  const parcial = await n.consultarHistorico(c, { registroTipo: "RECEBIVEL", registroId: rec2 });
  assert.equal(parcial.at(-1).depois.situacao, "PARCIAL");
  assert.equal(parcial.at(-1).depois.saldoCentavos, 2000);
  await rejeita(n.registrarLiquidacao(c, { movimentacaoId: (await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-09-04", sentido: "ENTRADA", valorCentavos: 9999, natureza: "RECEBIMENTO" })).movimentacao.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: rec2, valorCentavos: 2001 }] }), CODIGO.LIQUIDACAO_EXCEDE_SALDO);
});

test("11, 12 — obrigação parcelada: uma despesa só; pagamento é liquidação (parcial) e não duplica custo", async () => {
  const m = montar();
  const n = m.nucleo;
  const banco = await n.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco" });
  const forn = await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Fornecedor Sintético" });
  const o = await n.registrarObrigacao(c, { contraparteId: forn.id, valorOriginalCentavos: 30000, categoria: "INSUMOS", descricao: "Compra parcelada sintética", competencia: "2026-09", dataEmissao: "2026-09-05", vencimento: "2026-09-20", parcelas: 3 });
  assert.equal(o.obrigacoes.length, 3);
  assert.equal(await total(n, "DESPESAS"), 30000);
  const saida = await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-09-20", sentido: "SAIDA", valorCentavos: 6000, natureza: "PAGAMENTO" });
  await n.registrarLiquidacao(c, { movimentacaoId: saida.movimentacao.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: o.obrigacoes[0].id, valorCentavos: 6000 }] });
  assert.equal(await total(n, "DESPESAS"), 30000);
  const h = await n.consultarHistorico(c, { registroTipo: "OBRIGACAO", registroId: o.obrigacoes[0].id });
  assert.equal(h.at(-1).depois.situacao, "PARCIAL");
});

test("13, 14 — extrato vira movimentação sem receita/despesa; pagamento sem obrigação e empréstimo sem detalhamento ficam pendentes", async () => {
  const m = montar();
  const n = m.nucleo;
  const banco = await n.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco Sintético" });
  const imp = await importar(n, "UNICRED", "UNICRED_EXTRATO", unicredExtrato({ saldoInicial: 100000, lancamentos: [
    { data: "02/09/2026", historico: "CREDITO RECEBIMENTO DE PIX", valor: 5000 },
    { data: "03/09/2026", historico: "DEBITO TRANSFERENCIA PIX FORNECEDOR", valor: -2000 },
    { data: "04/09/2026", historico: "LIQUIDACAO DE PARCELA DE EMPRESTIMO", valor: -15000 },
  ] }));
  const g = await n.gerarPropostas(c, { importacaoId: imp.id, contaBancariaId: banco.id });
  assert.equal(g.criadas, 3);
  for (const p of await propostas(n, { operacao: "MOVIMENTACAO_BANCARIA" })) await aprovarEAplicar(n, p);
  for (const ind of ["RECEITA_BRUTA", "DESPESAS", "DEDUCOES"]) assert.equal(await total(n, ind), 0, ind);
  const pend = await n.listarPendenciasDeClassificacao(c, PERIODO_SETEMBRO);
  assert.deepEqual(pend.movimentacoes.map((x) => x.motivo).sort(), ["CREDITO_SEM_ORIGEM", "PAGAMENTO_SEM_OBRIGACAO", "PAGAMENTO_SEM_OBRIGACAO"]);
  assert.equal(pend.emprestimosSemDetalhamento.length, 1);
});

test("15, 16 — entregador com várias entregas vira UMA obrigação devida; pagamento em outubro não muda a competência de setembro", async () => {
  const m = montar();
  const n = m.nucleo;
  const banco = await n.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco" });
  const imp = await importar(n, "FOODY", "FOODY_ENTREGAS", foodyEntregas([
    { pedido: "F-1", data: "02/09/2026", entregador: "Entregador Alfa", taxa: 700, custo: 600 },
    { pedido: "F-2", data: "05/09/2026", entregador: "Entregador Alfa", taxa: 900, custo: 800 },
    { pedido: "F-3", data: "06/09/2026", entregador: "Entregador Alfa", taxa: 700, custo: 600, situacao: "Taxa rejeitada" },
    { pedido: "F-4", data: "06/09/2026", entregador: "Entregador Beta", taxa: 700, custo: 650 },
  ], { subtotais: { "Entregador Alfa": 1400, "Entregador Beta": 650 }, total: 2050 }));
  await n.gerarPropostas(c, { importacaoId: imp.id });
  const ps = await propostas(n, { operacao: "OBRIGACAO_ENTREGADOR" });
  assert.equal(ps.length, 2);
  const alfa = ps.find((p) => p.entregador === "Entregador Alfa");
  assert.equal(alfa.valorCentavos, 1400);
  assert.deepEqual([...alfa.pedidos].sort(), ["F-1", "F-2"]);
  assert.deepEqual(alfa.taxasRejeitadas, ["F-3"]);
  const r = await aprovarEAplicar(n, alfa);
  const obrigacaoId = r.efeitos.find((e) => e.tipo === "OBRIGACAO").id;
  assert.equal(await total(n, "DESPESAS"), 1400);
  const pix = await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-10-05", sentido: "SAIDA", valorCentavos: 1400, natureza: "PAGAMENTO" });
  await n.registrarLiquidacao(c, { movimentacaoId: pix.movimentacao.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: obrigacaoId, valorCentavos: 1400 }] });
  assert.equal(await total(n, "DESPESAS"), 1400); // continua só em setembro
  assert.equal((await n.consultarComposicao(c, { competencia: "2026-10", indicador: "DESPESAS" })).totalCentavos, 0);
});

test("17 — divergência SAIPOS: totais e diferença por dia registrados, formas atípicas preservadas, nada resolvido por hipótese", async () => {
  const { n } = await cenarioVendas();
  await importar(n, "SAIPOS", "SAIPOS_FATURAMENTO_POR_DIA", faturamentoSaiposPdf([{ data: "01/09/2026", valor: 50000, desconto: 0 }, { data: "02/09/2026", valor: 20000, desconto: 0 }]), { periodoInicio: "2026-09-01", periodoFim: "2026-09-02" });
  await importar(n, "SAIPOS", "SAIPOS_FORMAS_PAGAMENTO", (() => {
    const b = saiposFormas([["Dinheiro", 1, 40000], ["Pagamento não cadastrado", 1, 1000]]);
    return b;
  })(), { periodoInicio: "2026-09-01", periodoFim: "2026-09-02" });
  const d = await n.registrarDivergenciaEntreFontes(c, { periodoInicio: "2026-09-01", periodoFim: "2026-09-02" });
  assert.equal(d.diferencaCentavos, 70000 - 41000);
  assert.equal(d.estado, "ABERTA");
  assert.ok(d.atipicos.some((a) => a.forma === "Pagamento não cadastrado"));
  assert.equal((await n.registrarDivergenciaEntreFontes(c, { periodoInicio: "2026-09-01", periodoFim: "2026-09-02" })).id, d.id); // idempotente
  await rejeita(n.explicarDivergencia(c, { divergenciaId: d.id, valorCentavos: 29000, explicacao: "Hipótese sem documento", confirmada: true }), CODIGO.ENTRADA_INVALIDA);
  const h = await n.explicarDivergencia(c, { divergenciaId: d.id, valorCentavos: 29000, explicacao: "Hipótese: pedidos sem pagamento registrado (a confirmar com o relatório por pedido)." });
  assert.equal(h.estado, "EXPLICADA_PARCIALMENTE"); // hipótese não resolve
  assert.equal(await total(n, "RECEITA_BRUTA"), 0); // nenhum ajuste
});

test("18, 19 — candidata conta a pagar × saída: ambígua é recusada; confirmação autorizada com evidência", async () => {
  const m = montar();
  const n = m.nucleo;
  const banco = await n.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco Sintético" });
  const forn = await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Fornecedor Sintético" });
  for (const desc of ["Compra A", "Compra B"]) await n.registrarObrigacao(c, { contraparteId: forn.id, valorOriginalCentavos: 5000, categoria: "INSUMOS", descricao: desc, competencia: "2026-09", dataEmissao: "2026-09-01", vencimento: "2026-09-10" });
  const imp = await importar(n, "UNICRED", "UNICRED_EXTRATO", unicredExtrato({ saldoInicial: 10000, lancamentos: [{ data: "10/09/2026", historico: "LIQUIDACAO DE TITULO", valor: -5000 }] }));
  await n.gerarPropostas(c, { importacaoId: imp.id, contaBancariaId: banco.id });
  await aprovarEAplicar(n, (await propostas(n, { operacao: "MOVIMENTACAO_BANCARIA" }))[0]);
  assert.equal((await n.gerarCandidatasObrigacaoMovimentacao(c, PERIODO_SETEMBRO)).criadas, 2);
  const cands = await m.repositorio.leitura((tx) => tx.listar(c, "CORRESPONDENCIA", { onde: { relacao: "OBRIGACAO_X_MOVIMENTACAO" } }), { escopo: c });
  await rejeita(n.confirmarConciliacao(c, { correspondenciaId: cands[0].id }), CODIGO.CONCILIACAO_INVALIDA);
  await rejeita(n.confirmarConciliacao(ctx(undefined, undefined, [ACAO.VER]), { correspondenciaId: cands[1].id }), CODIGO.PERMISSAO_INSUFICIENTE);
  await n.rejeitarCorrespondencia(c, { correspondenciaId: cands[0].id, justificativa: "Boleto é da Compra B (código de barras)." });
  assert.equal((await n.confirmarConciliacao(c, { correspondenciaId: cands[1].id, justificativa: "Comprovante do boleto anexado.", evidenciaDocumentoIds: [(await n.registrarDocumento(c, { origem: "MANUAL", arquivoId: "cofre:prova-vinculo-d", hashSha256: "d".repeat(64).slice(0, 64), tipo: "COMPROVANTE", recebidoEm: "2026-09-20", descricao: "Comprovante que liga os dois lados (sintético)" })).documento.id] })).situacao, "CONFIRMADA");
  assert.ok(cands[1].evidenciaDocumentoIds.length >= 1);
});

test("20, 21 — reimportar e regerar não duplica; aplicações concorrentes geram UM efeito", async () => {
  const { n, imp } = await cenarioVendas();
  assert.equal((await n.gerarPropostas(c, { importacaoId: imp.id })).criadas, 0);
  const p1 = (await propostas(n, { operacao: "VENDA" })).find((p) => p.comando.fonte.idExterno === "P-1");
  await n.aprovarProposta(c, { propostaId: p1.id });
  const r = await Promise.allSettled([1, 2, 3].map(() => n.aplicarProposta(c, { propostaId: p1.id })));
  const ok = r.filter((x) => x.status === "fulfilled").map((x) => x.value);
  assert.equal(ok.filter((x) => !x.repetido).length, 1);
  for (const f of r.filter((x) => x.status === "rejected")) assert.equal(f.reason.codigo, CODIGO.CONFLITO_VERSAO);
  assert.equal(await total(n, "RECEITA_BRUTA"), 3000);
  const g2 = await Promise.all([n.gerarPropostas(c, { importacaoId: imp.id }), n.gerarPropostas(c, { importacaoId: imp.id })]);
  assert.equal(g2.reduce((s, x) => s + x.criadas, 0), 0);
});

test("22 — falha no meio da aplicação desfaz tudo (pagamento, recebível, taxa e a marca de aplicada)", async () => {
  let falhar = false;
  const base = montar();
  const real = base.repositorio;
  const comFalha = {
    leitura: (fn, o) => real.leitura(fn, o),
    transacao: (fn, o) => real.transacao((tx) => fn(new Proxy(tx, { get: (a, k) => (k === "inserir" ? async (tipo, r) => { if (falhar && tipo === "AJUSTE") throw new Error("queda simulada"); return a.inserir(tipo, r); } : a[k]) })), o),
  };
  const { n } = await cenarioVendas({ repositorio: comFalha });
  for (const p of await propostas(n, { operacao: "VENDA" })) if (p.comando.fonte.idExterno === "P-2") await aprovarEAplicar(n, p);
  const imp = await importar(n, "STONE", "STONE_VENDAS", stoneCsv([{ id: "S-1", quando: "02/09/2026 12:06", bruto: "25,000000", liquido: "24,700000", unificado: "-0,300000", aut: "AUT-1" }]));
  await n.gerarPropostas(c, { importacaoId: imp.id });
  const [s1] = await propostas(n, { operacao: "PAGAMENTO_STONE" });
  await n.aprovarProposta(c, { propostaId: s1.id });
  falhar = true;
  await assert.rejects(n.aplicarProposta(c, { propostaId: s1.id }), /queda simulada/);
  falhar = false;
  assert.equal((await propostas(n, { operacao: "PAGAMENTO_STONE" }))[0].estado, "APROVADA");
  assert.equal(await total(n, "DESPESAS"), 0);
  const r = await n.aplicarProposta(c, { propostaId: s1.id }); // depois da falha, aplica uma vez
  assert.equal(r.repetido, false);
  assert.equal(await total(n, "DESPESAS"), 30);
});

test("23, 24, 25 — isolamento, permissões de confirmação e competência homologada", async () => {
  const { n } = await cenarioVendas();
  const p1 = (await propostas(n, { operacao: "VENDA" })).find((p) => p.comando.fonte.idExterno === "P-1");
  await rejeita(n.aprovarProposta(ctx(undefined, UNI_A2), { propostaId: p1.id }), CODIGO.NAO_ENCONTRADO);
  await rejeita(n.aprovarProposta(ctx(ORG_B, UNI_B), { propostaId: p1.id }), CODIGO.NAO_ENCONTRADO);
  const semAprovar = ctx(undefined, undefined, Object.values(ACAO).filter((a) => a !== ACAO.APROVAR));
  await rejeita(n.aprovarProposta(semAprovar, { propostaId: p1.id }), CODIGO.PERMISSAO_INSUFICIENTE);
  // 08B: aprovar e aplicar são ações SEPARADAS — quem aprova não aplica; quem aplica não aprova.
  const soAprova = ctx(undefined, undefined, [ACAO.VER, ACAO.APROVAR, ACAO.REGISTRAR]);
  const soAplica = ctx(undefined, undefined, [ACAO.VER, ACAO.APLICAR, ACAO.REGISTRAR]);
  await rejeita(n.aplicarProposta(soAplica, { propostaId: p1.id }), CODIGO.TRANSICAO_INVALIDA); // aplicar SEM aprovação válida
  await rejeita(n.aprovarProposta(soAplica, { propostaId: p1.id }), CODIGO.PERMISSAO_INSUFICIENTE);
  await n.aprovarProposta(soAprova, { propostaId: p1.id });
  await rejeita(n.aplicarProposta(soAprova, { propostaId: p1.id }), CODIGO.PERMISSAO_INSUFICIENTE);
  const semAplicar = ctx(undefined, undefined, Object.values(ACAO).filter((a) => a !== ACAO.APLICAR));
  await rejeita(n.aplicarProposta(semAplicar, { propostaId: p1.id }), CODIGO.PERMISSAO_INSUFICIENTE);
  const semRegistrar = ctx(undefined, undefined, [ACAO.VER, ACAO.APLICAR]);
  await rejeita(n.aplicarProposta(semRegistrar, { propostaId: p1.id }), CODIGO.PERMISSAO_INSUFICIENTE); // a operação exige a própria permissão
  await n.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_PRELIMINAR" });
  // 06D: proposta aprovada e ainda não aplicada (resultado incompleto) impede a homologação.
  await rejeita(n.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Homologação sintética.", confirmar: true }), CODIGO.HOMOLOGACAO_BLOQUEADA);
  assert.equal((await propostas(n, { operacao: "VENDA" })).find((p) => p.id === p1.id).estado, "APROVADA");
});

test("fonte retificada: proposta não aplicada é substituída; efeito já aplicado exige revisão, sem sobrescrever", async () => {
  const { n, imp } = await cenarioVendas();
  const p1 = (await propostas(n, { operacao: "VENDA" })).find((p) => p.comando.fonte.idExterno === "P-1");
  await aprovarEAplicar(n, p1);
  const v2 = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", ...PERIODO_SETEMBRO, substituiImportacaoId: imp.id, conteudo: saiposVendas([
    { pedido: "P-1", data: "02/09/2026 12:00", canal: "Balcão", itens: 3100, forma: "Dinheiro" },
    { pedido: "P-2", data: "02/09/2026 12:05", canal: "Balcão", itens: 2600, forma: "Crédito", autorizacao: "AUT-1" },
  ]) });
  const conf = await n.confirmarImportacao(c, { importacaoId: v2.importacao.id, impressaoPrevia: v2.importacao.impressaoPrevia });
  await n.gerarPropostas(c, { importacaoId: conf.importacao.id });
  const todas = await propostas(n, { operacao: "VENDA" });
  const novaP1 = todas.find((p) => p.comando.fonte.idExterno === "P-1" && p.id !== p1.id);
  assert.equal(novaP1.estado, "AGUARDANDO_REVISAO");
  assert.ok(novaP1.duplicidades.some((d) => d.tipo === "EFEITO_ANTERIOR_APLICADO"));
  await rejeita(n.aprovarProposta(c, { propostaId: novaP1.id, justificativa: "x" }), CODIGO.TRANSICAO_INVALIDA);
  assert.ok(todas.some((p) => p.comando.fonte.idExterno === "P-2" && p.estado === "SUBSTITUIDA"));
  assert.equal(await total(n, "RECEITA_BRUTA"), 3000); // o efeito anterior não foi sobrescrito
});
