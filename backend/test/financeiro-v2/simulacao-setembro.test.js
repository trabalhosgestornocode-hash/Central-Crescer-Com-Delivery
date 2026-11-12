// Simulação completa de um mês com dados SINTÉTICOS (nenhum valor real): todas as fontes importadas, comparação de
// relatórios SAIPOS, extrato que fecha e propostas de conciliação. Prova o fluxo — não homologa nem concilia nada real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ctx, montar } from "./helpers/cenario.js";
import { PERIODO_SETEMBRO, foodyEntregas, ifoodApuracao, saiposDiarias, saiposFormas, saiposVendas, stoneRecebimentos, stoneVendas, unicredExtrato } from "./helpers/arquivos.js";

test("simulação sintética de setembro: importa as 5 fontes, detecta diferenças e prepara candidatas sem efeito financeiro", async (t) => {
  const { nucleo } = montar();
  const c = ctx();
  const relatorios = {};
  async function importar(fonte, tipoRelatorio, conteudo) {
    const r = await nucleo.receberArquivoParaImportacao(c, { fonte, tipoRelatorio, tipoMime: "text/csv", conteudo, ...PERIODO_SETEMBRO });
    assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR", `${tipoRelatorio}: ${JSON.stringify(r.previa.erros)}`);
    const pend = r.previa.totalDivergencias ? { aceitarPendencias: true, justificativa: "Simulação: pendências sintéticas registradas." } : {};
    const conf = await nucleo.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...pend });
    relatorios[tipoRelatorio] = { estado: conf.importacao.estado, inseridos: conf.relatorio.inseridos, divergencias: conf.relatorio.divergencias, controles: conf.relatorio.controles };
  }

  await importar("SAIPOS", "SAIPOS_VENDAS_DIARIAS", saiposDiarias([["01/09/2026", 30, 250000], ["02/09/2026", 28, 230000], ["03/09/2026", 35, 290011]], 770011));
  await importar("SAIPOS", "SAIPOS_FORMAS_PAGAMENTO", saiposFormas([["Dinheiro", 20, 150000], ["Crédito", 25, 300000], ["Débito", 18, 120000], ["Pix", 22, 190000]], 760000));
  await importar("SAIPOS", "SAIPOS_VENDAS", saiposVendas([
    { pedido: "S-1", data: "01/09/2026 12:00", itens: 4000, forma: "Crédito", autorizacao: "A-1" },
    { pedido: "S-2", data: "01/09/2026 12:30", itens: 2500, forma: "Débito", autorizacao: "A-2" },
    { pedido: "S-3", data: "01/09/2026 13:00", itens: 1800, forma: "Dinheiro" },
    { pedido: "S-4", data: "02/09/2026 19:00", canal: "iFood", itens: 5200, forma: "Pago online" },
  ]));
  await importar("STONE", "STONE_VENDAS", stoneVendas([
    { id: "ST-1", quando: "01/09/2026 12:01", produto: "Crédito", bruto: 4000, mdr: 120, autorizacao: "A-1" },
    { id: "ST-2", quando: "01/09/2026 12:31", produto: "Débito", bruto: 2500, mdr: 40, autorizacao: "A-2" },
    { id: "ST-3", quando: "02/09/2026 09:00", produto: "Pix", bruto: 1500, mdr: 0 }, // sem pedido correspondente no SAIPOS
  ]));
  await importar("STONE", "STONE_RECEBIMENTOS", stoneRecebimentos([
    { data: "02/09/2026", transacao: "ST-1", liquido: 3880 }, { data: "02/09/2026", transacao: "ST-2", liquido: 2460 }, { data: "02/09/2026", transacao: "ST-3", liquido: 1500 },
  ]));
  await importar("IFOOD", "IFOOD_APURACAO", ifoodApuracao([
    { data: "07/09/2026", tipo: "Vendas", valor: 5200 }, { data: "07/09/2026", tipo: "Comissão", valor: -624 }, { data: "07/09/2026", tipo: "Taxa de transação de pagamento", valor: -166 },
    { data: "07/09/2026", tipo: "Antecipação de recebíveis", valor: -110 }, { data: "07/09/2026", tipo: "Repasse previsto", valor: 4300 }, { data: "08/09/2026", tipo: "Repasse pago", valor: 4300 },
  ]));
  await importar("FOODY", "FOODY_ENTREGAS", foodyEntregas([
    { pedido: "FD-1", data: "02/09/2026", entregador: "Entregador Gama", taxa: 700, custo: 650 },
    { pedido: "FD-2", data: "03/09/2026", entregador: "Entregador Gama", taxa: 700, custo: 650 },
  ], { subtotais: { "Entregador Gama": 1300 }, total: 1300 }));
  await importar("UNICRED", "UNICRED_EXTRATO", unicredExtrato({ saldoInicial: 50000, lancamentos: [
    { data: "02/09/2026", historico: "CRED STONE PAGAMENTOS", valor: 7840 },
    { data: "05/09/2026", historico: "PIX ENVIADO ENTREGADOR", valor: -1300 },
    { data: "08/09/2026", historico: "CRED IFOOD REPASSE", valor: 4300 },
    { data: "10/09/2026", historico: "TARIFA PACOTE", valor: -1990 },
    { data: "15/09/2026", historico: "PAGTO TITULO FORNECEDOR", valor: -20000 },
    { data: "20/09/2026", historico: "TED RECEBIDA SEM IDENTIFICACAO", valor: 3333 },
  ] }));

  const saipos = await nucleo.compararRelatoriosSaipos(c, PERIODO_SETEMBRO);
  const candidatas = {};
  for (const relacao of ["SAIPOS_X_STONE", "STONE_X_RECEBIMENTO", "RECEBIMENTO_STONE_X_UNICRED", "IFOOD_X_UNICRED", "FOODY_X_UNICRED"]) {
    const g = await nucleo.gerarCandidatasDeConciliacao(c, { relacao, ...PERIODO_SETEMBRO });
    candidatas[relacao] = { criadas: g.criadas, ambiguas: g.ambiguas, semCandidato: g.semCandidato };
  }
  const receita = await nucleo.consultarComposicao(c, { competencia: "2026-09", indicador: "RECEITA_BRUTA" });

  // Extrato fecha (consistência aritmética) e nada virou venda/despesa.
  const ext = relatorios.UNICRED_EXTRATO.controles;
  assert.equal(ext.saldoFecha, true, JSON.stringify(ext));
  assert.equal(ext.saldoFinalCentavos, 50000 + 7840 - 1300 + 4300 - 1990 - 20000 + 3333);
  assert.equal(receita.totalCentavos, 0);
  // SAIPOS: diferença detectada entre faturamento e formas de pagamento, sem ajuste.
  assert.equal(saipos.diferencaCentavos, 10011);
  // Candidatas: 2 pedidos de cartão ↔ Stone (FORTES), 3 transações ↔ recebimentos, 1 repasse ↔ crédito, iFood ↔ crédito, Foody ↔ Pix.
  assert.deepEqual(Object.fromEntries(Object.entries(candidatas).map(([k, v]) => [k, v.criadas])), {
    SAIPOS_X_STONE: 2, STONE_X_RECEBIMENTO: 3, RECEBIMENTO_STONE_X_UNICRED: 1, IFOOD_X_UNICRED: 1, FOODY_X_UNICRED: 1,
  });
  // ST-3 (Pix na Stone sem pedido no SAIPOS) fica sem par — exposto, não forçado. Pedido em dinheiro nem entra na relação.
  assert.equal(candidatas.SAIPOS_X_STONE.semCandidato, 1, JSON.stringify(candidatas));

  t.diagnostic(`importações: ${Object.entries(relatorios).map(([k, v]) => `${k}=${v.estado}/${v.inseridos} reg/${v.divergencias} div`).join("; ")}`);
  t.diagnostic(`SAIPOS faturamento ${saipos.faturamentoCentavos} × formas ${saipos.formasDePagamentoCentavos} → diferença ${saipos.diferencaCentavos} (centavos, sintético)`);
  t.diagnostic(`extrato: inicial ${ext.saldoInicialCentavos} + entradas ${ext.entradasCentavos} − saídas ${ext.saidasCentavos} = ${ext.saldoCalculadoCentavos} (final ${ext.saldoFinalCentavos})`);
  t.diagnostic(`candidatas: ${JSON.stringify(candidatas)}`);
});
