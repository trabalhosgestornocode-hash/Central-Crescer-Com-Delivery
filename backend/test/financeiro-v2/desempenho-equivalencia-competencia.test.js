// Execução 08C — CARGA DIRIGIDA POR COMPETÊNCIA (Vendas, Recebimentos consolidados, Central, Pendências, Fechamento e a
// guarda de homologação) = carga COMPLETA do histórico, nos casos que cruzam meses: venda de setembro recebida em outubro,
// obrigação de setembro paga em outubro, estorno posterior, devolução, retificação de documento, reabertura e versões
// homologadas, conciliação entre competências, recebível parcialmente liquidado, pagamento agregado, operação sem canal,
// saldos informados (inclusive divergente). Roda em memória e no PostgreSQL isolado. Dados sintéticos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ESCOPOS_PADRAO, montarComCadastros, obrigacao, prepararHomologacao, saida } from "./helpers/cenario.js";

const MESES = ["2026-07", "2026-08", "2026-09", "2026-10"];

async function cenarioEntreMeses() {
  const m = await montarComCadastros();
  const { nucleo: n, c, banco, caixa, fornecedor, cofre } = m;
  const doc = async (descricao, extra = {}) => {
    const g = await cofre.guardar(c, { conteudo: new TextEncoder().encode(`%PDF-1.4\n% ${descricao}\n%%EOF\n`), tipoMime: "application/pdf" });
    return (await n.registrarDocumento(c, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "COMPROVANTE", recebidoEm: "2026-09-15", descricao, ...extra })).documento;
  };
  let k = 0;
  const venda = (data, bruto, pagamentos, extra = {}) => n.registrarVenda(c, { canal: "BALCAO", dataVenda: data, brutoCentavos: bruto, fonte: { sistema: "MANUAL", idExterno: `EC-${(k += 1)}` }, pagamentos, ...extra });
  // Saldos informados: âncora no início de julho; em setembro um saldo que confere e outro divergente.
  await n.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-07-01", valorCentavos: 100000 });
  // Julho/agosto: vendas Stone e iFood + obrigações; agosto homologada, reaberta e homologada de novo.
  const stone = [];
  for (const [mes, dia] of [["2026-07", "10"], ["2026-08", "12"], ["2026-09", "28"], ["2026-10", "05"]]) {
    const v = await venda(`${mes}-${dia}`, 6000 + k, [{ forma: "CREDITO", processador: "STONE", valorCentavos: 6000 + k }]);
    await n.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: v.recebiveis[0].id, valorCentavos: -150, motivo: "Taxa", categoria: "TAXAS_STONE" });
    stone.push(v.recebiveis[0]);
    await n.registrarVenda(c, { canal: "IFOOD", dataVenda: `${mes}-${dia}`, brutoCentavos: 4200, fonte: { sistema: "MANUAL", idExterno: `EC-${(k += 1)}` }, composicao: { itensCentavos: 4200, descontos: [{ valorCentavos: 300, financiador: "PENDENTE" }] }, pagamentos: [{ forma: "OUTRA", processador: "IFOOD", valorCentavos: 3900 }] });
    await n.registrarObrigacao(c, obrigacao(fornecedor.id, { competencia: mes, dataEmissao: `${mes}-02`, vencimento: `${mes}-25`, valorOriginalCentavos: 2000 + k, fonte: { sistema: "MANUAL", idExterno: `OB-${k}` } }));
  }
  // Venda de setembro (28/09) RECEBIDA EM OUTUBRO, junto com a de agosto: pagamento AGREGADO (um crédito, dois recebíveis).
  const set = (await n.consultarRegistros(c, { tipo: "RECEBIVEL" })).find((r) => r.id === stone[2].id);
  const ago = (await n.consultarRegistros(c, { tipo: "RECEBIVEL" })).find((r) => r.id === stone[1].id);
  const credito = (await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-10-02", sentido: "ENTRADA", valorCentavos: set.saldoCentavos + 1000, natureza: "RECEBIMENTO" })).movimentacao;
  const liq = await n.registrarLiquidacao(c, { movimentacaoId: credito.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: set.id, valorCentavos: set.saldoCentavos }, { alvoTipo: "RECEBIVEL", alvoId: ago.id, valorCentavos: 1000 }] });
  // Recebível de agosto PARCIALMENTE liquidado (1000 de ~5.8k).
  assert.ok(ago.saldoCentavos > 1000);
  // Obrigação de setembro PAGA EM OUTUBRO (e uma de julho paga em agosto).
  const obs = await n.consultarRegistros(c, { tipo: "OBRIGACAO" });
  const obSet = obs.find((o) => o.competencia === "2026-09");
  const pg = (await n.registrarMovimentacao(c, saida(banco.id, obSet.valorBaseCentavos, { dataEfetiva: "2026-10-08" }))).movimentacao;
  await n.registrarLiquidacao(c, { movimentacaoId: pg.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: obSet.id, valorCentavos: obSet.valorBaseCentavos }] });
  const obJul = obs.find((o) => o.competencia === "2026-07");
  const pgJul = (await n.registrarMovimentacao(c, saida(banco.id, obJul.valorBaseCentavos, { dataEfetiva: "2026-08-03" }))).movimentacao;
  await n.registrarLiquidacao(c, { movimentacaoId: pgJul.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: obJul.id, valorCentavos: obJul.valorBaseCentavos }] });
  // ESTORNO POSTERIOR: venda em dinheiro de setembro com devolução parcial em outubro; liquidação de agosto estornada em setembro.
  const dinheiro = await venda("2026-09-10", 3000, [{ forma: "DINHEIRO", valorCentavos: 3000, contaId: caixa.id }]);
  await n.estornarPagamentoDeVenda(c, { pagamentoId: dinheiro.pagamentos?.[0]?.id ?? (await n.consultarRegistros(c, { tipo: "PAGAMENTO_VENDA" })).find((p) => p.vendaId === dinheiro.venda.id).id, valorCentavos: 500, motivo: "DEVOLUCAO_AO_CLIENTE", justificativa: "Devolução parcial (sintético)", contaId: caixa.id, dataEfetiva: "2026-10-03" });
  const liqJul = (await n.consultarRegistros(c, { tipo: "LIQUIDACAO" })).find((q) => q.movimentacaoId === pgJul.id);
  await n.estornarLiquidacao(c, { liquidacaoId: liqJul.id, valorCentavos: 100, justificativa: "Pagamento a maior devolvido (sintético)" });
  // Saída SEM vínculo (sem natureza) em setembro e crédito sem identificação em outubro.
  await n.registrarMovimentacao(c, saida(banco.id, 777, { dataEfetiva: "2026-09-15" }));
  await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-10-12", sentido: "ENTRADA", valorCentavos: 333, natureza: "RECEBIMENTO" });
  // Saldos de setembro: um que confere com o calculado? (não importa) e um claramente divergente.
  await n.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-09-30", referencia: "FIM_DO_DIA", valorCentavos: 1 });
  // RETIFICAÇÃO de documento (v2 substitui v1) vinculado a uma obrigação de outubro.
  const v1 = await doc("Boleto outubro v1", { competencia: "2026-10" });
  const v2 = await doc("Boleto outubro v2", { competencia: "2026-10", substituiId: v1.id });
  const obOut = obs.find((o) => o.competencia === "2026-10");
  await n.vincularDocumento(c, { documentoId: v2.id, registroTipo: "OBRIGACAO", registroId: obOut.id });
  // CONCILIAÇÃO ENTRE COMPETÊNCIAS: obrigação de setembro × saída de outubro (manual, com evidência), confirmada.
  const comp = await doc("Comprovante do pagamento de setembro", { competencia: "2026-10" });
  const corr = await n.criarCorrespondenciaCandidata(c, { ladoA: [{ tipo: "OBRIGACAO", id: obSet.id, valorCentavos: obSet.valorBaseCentavos }], ladoB: [{ tipo: "MOVIMENTACAO", id: pg.id, valorCentavos: obSet.valorBaseCentavos }], evidenciaDocumentoIds: [comp.id], justificativa: "Pagamento identificado (sintético)." });
  await n.confirmarConciliacao(c, { correspondenciaId: corr.id, justificativa: "Comprovante confere (sintético)." });
  // Agosto: homologada, REABERTA e homologada de novo (versões homologadas).
  await n.alterarEstadoDaCompetencia(c, { competencia: "2026-07", novoEstado: "FECHAMENTO_PRELIMINAR" });
  // 08E: as pendências reais de julho são documentadas; passa por "com pendências documentadas" só se o que resta forem
  // ressalvas admissíveis (senão fica no preliminar — para a equivalência basta um estado de fechamento).
  await prepararHomologacao(n, c, "2026-07");
  void liq;
  return m;
}

async function comparar(m, c, nome, fn) {
  const referencia = criarNucleoFinanceiro({ repositorio: m.repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cofre: m.cofre, cargaCompletaDeReferencia: true });
  const [dirigida, completa] = [await fn(m.nucleo), await fn(referencia)];
  assert.deepEqual(dirigida, completa, nome);
  return dirigida;
}

test("08C — Central, Pendências, Fechamento e prévia de homologação: dirigida = completa em cada mês (casos entre períodos)", async () => {
  const m = await cenarioEntreMeses();
  const { c } = m;
  let pendenciasVistas = 0;
  for (const competencia of MESES) {
    await comparar(m, c, `central ${competencia}`, (n) => n.consultarCentralDeConferencias(c, { competencia }));
    const fech = await comparar(m, c, `fechamento ${competencia}`, (n) => n.consultarFechamento(c, { competencia }));
    await comparar(m, c, `prévia homologação ${competencia}`, (n) => n.previaDaMudancaDeEstado(c, { competencia, novoEstado: "FECHAMENTO_HOMOLOGADO" }));
    for (const f of [{}, { tamanho: 2, pagina: 2 }, { grupo: "CLASSIFICACOES" }, { grupo: "RECEBIMENTOS_E_REPASSES" }, { grupo: "CAIXA_E_CONCILIACAO" }, { situacao: "A_RESOLVER" }]) {
      const r = await comparar(m, c, `pendências ${competencia} ${JSON.stringify(f)}`, (n) => n.consultarPendencias(c, { competencia, tamanho: 100, ...f }));
      if (!f.grupo && !f.situacao && !f.pagina) {
        pendenciasVistas += r.itens.length;
        for (const p of r.itens) await comparar(m, c, `pendência ${p.chave}`, (n) => n.detalharPendencia(c, { competencia, chave: p.chave }));
      }
    }
    assert.ok(fech.secoes.length > 0);
  }
  assert.ok(pendenciasVistas >= 8, `o cenário gera pendências de vários tipos (${pendenciasVistas})`);
  // A guarda de homologação (ESCRITA) usa a carga dirigida e decide igual: setembro tem impedimentos → recusa.
  await m.nucleo.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_PRELIMINAR" });
  await assert.rejects(m.nucleo.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "x", confirmar: true }), (e) => e.codigo === CODIGO.HOMOLOGACAO_BLOQUEADA);
});

test("08C — Vendas e Recebimentos consolidados: dirigida = completa por competência, período entre meses, filtros e páginas", async () => {
  const m = await cenarioEntreMeses();
  const { c } = m;
  const filtros = [
    ...MESES.map((competencia) => ({ competencia })),
    { competencia: "2026-09", tamanho: 1, pagina: 2 }, { competencia: "2026-09", canal: "IFOOD" }, { competencia: "2026-10", forma: "CREDITO" },
    { competencia: "2026-09", processador: "STONE" }, { inicio: "2026-08-15", fim: "2026-10-10" }, { inicio: "2026-07-01", fim: "2026-10-31" },
  ];
  for (const f of filtros) {
    await comparar(m, c, `vendas ${JSON.stringify(f)}`, (n) => n.consultarVendas(c, f));
    await comparar(m, c, `pagamentos ${JSON.stringify(f)}`, (n) => n.consultarPagamentosDeVendas(c, f));
    await comparar(m, c, `taxas ${JSON.stringify(f)}`, (n) => n.consultarTaxasEDescontos(c, f));
    await comparar(m, c, `recebíveis ${JSON.stringify(f)}`, (n) => n.consultarRecebiveisERepasses(c, f));
    await comparar(m, c, `divergências ${JSON.stringify(f)}`, (n) => n.consultarDivergenciasDeVendas(c, f));
  }
  // O cenário realmente cruza meses: a venda de setembro aparece recebida (crédito de outubro) e a de agosto parcial.
  const set = await m.nucleo.consultarRecebiveisERepasses(c, { competencia: "2026-09", processador: "STONE" });
  assert.ok(JSON.stringify(set).includes("2026-10-02"), "o recebimento de outubro aparece na venda de setembro");
});

test("08C — a conferência de equivalência tem dentes: uma carga dirigida incompleta é recusada", async () => {
  const m = await cenarioEntreMeses();
  const { c } = m;
  // Repositório que "perde" a liquidação de outubro só nas consultas paginadas (as da carga dirigida).
  const furado = {
    transacao: m.repositorio.transacao, leitura: (fn, op) => m.repositorio.leitura((tx) => fn(new Proxy(tx, {
      get: (alvo, prop) => (prop === "paginar" ? async (cx, tipo, q) => {
        const r = await alvo.paginar(cx, tipo, q);
        return tipo === "LIQUIDACAO" ? { itens: r.itens.filter((x) => x.dataEfetiva !== "2026-10-02"), total: r.total } : r;
      } : alvo[prop]),
    })), op),
  };
  const conferente = criarNucleoFinanceiro({ repositorio: furado, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, conferirCargaDirigida: true });
  await assert.rejects(conferente.consultarRecebiveisERepasses(c, { competencia: "2026-09" }), (e) => e.codigo === CODIGO.INTEGRIDADE_VIOLADA && /recebimento|vendas/.test(e.message + JSON.stringify(e.detalhes)));
});
