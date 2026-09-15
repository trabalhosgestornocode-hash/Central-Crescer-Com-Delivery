import { test } from "node:test";
import assert from "node:assert/strict";
import { calcularDashboardOperacional } from "../src/modules/parser-food-delivery/parserFoodDelivery.dashboard.js";

// Fábrica mínima de pedido no formato da API (mesmo shape de paraApiPedido()).
// Cada teste só preenche os campos que importam pra aquela asserção.
function pedido(overrides = {}) {
  return {
    numeroPedido: "1", situacao: "Finalizado", entregador: "Ana", taxaEntregador: 10,
    statusConciliacao: "incluido",
    dataHora: null, dataPronto: null, dataDespachado: null, dataAceito: null,
    dataColetado: null, dataChegadaEntrega: null, dataEntregue: null,
    dataFinalizado: null, dataCancelado: null,
    distanciaRaioKm: null, distanciaRotaKm: null, prazoEntrega: null,
    ...overrides,
  };
}

test("relatório vazio: estrutura segura, sem NaN, sem quebrar", () => {
  const d = calcularDashboardOperacional([]);
  assert.equal(d.resumo.totalEntregas, 0);
  assert.equal(d.resumo.taxasTotal, 0);
  assert.equal(d.resumo.tempoMedioEntregaMin, null);
  assert.equal(d.resumo.entregadoresAtivos, 0);
  assert.deepEqual(d.entregadoresPorEntregas, []);
  assert.deepEqual(d.entregadoresPorTaxas, []);
  assert.deepEqual(d.tempoPorSituacao, []);
  assert.deepEqual(d.tempoPorEntregador, []);
  assert.deepEqual(d.tempoPorDia, []);
});

test("pontualidade: pedido sem dataEntregue nem prazoEntrega cai em sem_data_entrega, nunca em no_prazo/fora_do_prazo", () => {
  const d = calcularDashboardOperacional([pedido()]);
  assert.equal(d.pontualidade.semDataEntrega, 1);
  assert.equal(d.pontualidade.noPrazo, 0);
  assert.equal(d.pontualidade.foraDoPrazo, 0);
  assert.equal(d.pontualidade.classificaveis, 0);
  assert.equal(d.pontualidade.percentualNoPrazo, null);
});

test("entregador vazio não entra em nenhum indicador", () => {
  const d = calcularDashboardOperacional([pedido({ entregador: "" }), pedido({ entregador: null })]);
  assert.equal(d.resumo.totalEntregas, 0);
  assert.equal(d.resumo.entregadoresAtivos, 0);
});

test("cancelamento não conta como entrega concluída, mas mantém taxa quando não excluída", () => {
  const pedidos = [
    pedido({ numeroPedido: "1", situacao: "Finalizado", entregador: "Ana", taxaEntregador: 10 }),
    pedido({ numeroPedido: "2", situacao: "Cancelado", entregador: "Ana", taxaEntregador: 8, statusConciliacao: "cancelado_com_taxa" }),
    pedido({ numeroPedido: "3", situacao: "Cancelado", entregador: "Ana", taxaEntregador: 5, statusConciliacao: "excluido" }),
  ];
  const d = calcularDashboardOperacional(pedidos);
  assert.equal(d.resumo.totalEntregas, 1); // só o Finalizado
  assert.equal(d.resumo.taxasTotal, 18); // 10 + 8 (o excluído não entra)
  assert.equal(d.entregadoresPorEntregas[0].quantidade, 1);
  assert.equal(d.entregadoresPorTaxas[0].taxas, 18);
});

test("contagem de entregas por entregador — agrupa por chave normalizada e ordena desc", () => {
  const pedidos = [
    pedido({ numeroPedido: "1", entregador: "Ana Silva" }),
    pedido({ numeroPedido: "2", entregador: "ana silva" }), // mesma pessoa, grafia diferente
    pedido({ numeroPedido: "3", entregador: "Bruno" }),
  ];
  const d = calcularDashboardOperacional(pedidos);
  assert.equal(d.entregadoresPorEntregas.length, 2);
  assert.equal(d.entregadoresPorEntregas[0].entregador, "Ana Silva");
  assert.equal(d.entregadoresPorEntregas[0].quantidade, 2);
  assert.equal(d.entregadoresPorEntregas[1].quantidade, 1);
});

test("soma das taxas por entregador — nunca confunde com faturamento/comissão, só taxaEntregador", () => {
  const pedidos = [
    pedido({ numeroPedido: "1", entregador: "Ana", taxaEntregador: 10 }),
    pedido({ numeroPedido: "2", entregador: "Ana", taxaEntregador: 6.5 }),
    pedido({ numeroPedido: "3", entregador: "Bruno", taxaEntregador: 12 }),
  ];
  const d = calcularDashboardOperacional(pedidos);
  const ana = d.entregadoresPorTaxas.find((e) => e.entregador === "Ana");
  assert.equal(ana.taxas, 16.5);
  assert.equal(d.resumo.taxasTotal, 28.5);
});

test("tempo coleta -> entrega: média, mediana, min, máx por entregador", () => {
  const pedidos = [
    pedido({ numeroPedido: "1", entregador: "Ana", dataColetado: "2026-09-01T10:00:00", dataEntregue: "2026-09-01T10:10:00" }), // 10min
    pedido({ numeroPedido: "2", entregador: "Ana", dataColetado: "2026-09-01T11:00:00", dataEntregue: "2026-09-01T11:20:00" }), // 20min
    pedido({ numeroPedido: "3", entregador: "Ana", dataColetado: "2026-09-01T12:00:00", dataEntregue: "2026-09-01T12:30:00" }), // 30min
  ];
  const d = calcularDashboardOperacional(pedidos);
  const ana = d.tempoPorEntregador.find((e) => e.entregador === "Ana");
  assert.equal(ana.quantidade, 3);
  assert.equal(ana.mediaMin, 20);
  assert.equal(ana.medianaMin, 20);
  assert.equal(ana.minMin, 10);
  assert.equal(ana.maxMin, 30);
  assert.equal(d.resumo.tempoMedioEntregaMin, 20);
});

test("timestamp ausente: par sem os dois timestamps é desconsiderado, não vira zero", () => {
  const pedidos = [
    pedido({ numeroPedido: "1", entregador: "Ana", dataColetado: "2026-09-01T10:00:00", dataEntregue: null }),
    pedido({ numeroPedido: "2", entregador: "Ana", dataColetado: null, dataEntregue: "2026-09-01T10:10:00" }),
  ];
  const d = calcularDashboardOperacional(pedidos);
  assert.equal(d.tempoPorEntregador.length, 0);
  assert.equal(d.resumo.tempoMedioEntregaMin, null);
});

test("timestamps invertidos: nunca gera duração negativa, par é descartado", () => {
  const pedidos = [
    pedido({ numeroPedido: "1", entregador: "Ana", dataColetado: "2026-09-01T10:30:00", dataEntregue: "2026-09-01T10:00:00" }),
  ];
  const d = calcularDashboardOperacional(pedidos);
  assert.equal(d.tempoPorEntregador.length, 0);
});

test("agrupamento por dia: um único dia no período", () => {
  const pedidos = [
    pedido({ numeroPedido: "1", entregador: "Ana", dataHora: "2026-09-01T09:00:00", dataColetado: "2026-09-01T10:00:00", dataEntregue: "2026-09-01T10:10:00" }),
    pedido({ numeroPedido: "2", entregador: "Ana", dataHora: "2026-09-01T14:00:00", dataColetado: "2026-09-01T15:00:00", dataEntregue: "2026-09-01T15:20:00" }),
  ];
  const d = calcularDashboardOperacional(pedidos);
  assert.equal(d.tempoPorDia.length, 1);
  assert.equal(d.tempoPorDia[0].data, "2026-09-01");
  assert.equal(d.tempoPorDia[0].mediaMin, 15);
});

test("agrupamento por dia: vários dias, ordenado cronologicamente, usa data do PEDIDO (não de importação)", () => {
  const pedidos = [
    pedido({ numeroPedido: "1", entregador: "Ana", dataHora: "2026-09-03T09:00:00", dataColetado: "2026-09-03T10:00:00", dataEntregue: "2026-09-03T10:08:00" }),
    pedido({ numeroPedido: "2", entregador: "Ana", dataHora: "2026-09-01T09:00:00", dataColetado: "2026-09-01T10:00:00", dataEntregue: "2026-09-01T10:11:00" }),
    pedido({ numeroPedido: "3", entregador: "Ana", dataHora: "2026-09-02T09:00:00", dataColetado: "2026-09-02T10:00:00", dataEntregue: "2026-09-02T10:08:00" }),
  ];
  const d = calcularDashboardOperacional(pedidos);
  assert.deepEqual(d.tempoPorDia.map((x) => x.data), ["2026-09-01", "2026-09-02", "2026-09-03"]);
});

test("tempo por situação: só considera marcos com timestamps reais, nunca força 0", () => {
  const pedidos = [
    pedido({ numeroPedido: "1", dataHora: "2026-09-01T09:00:00", dataPronto: "2026-09-01T09:05:00" }), // 5min "Aberto"
    pedido({ numeroPedido: "2", dataHora: "2026-09-01T09:00:00", dataPronto: "2026-09-01T09:09:00" }), // 9min "Aberto"
    // Sem dataDespachado/dataAceito/dataColetado/dataChegadaEntrega/dataEntregue em NENHUM pedido:
    // as demais etapas não devem aparecer no resultado.
  ];
  const d = calcularDashboardOperacional(pedidos);
  assert.equal(d.tempoPorSituacao.length, 1);
  assert.equal(d.tempoPorSituacao[0].etapa, "aberto");
  assert.equal(d.tempoPorSituacao[0].mediaMin, 7);
  assert.equal(d.tempoPorSituacao[0].amostras, 2);
});

test("vida do pedido por dia: concluídos e cancelados em séries separadas", () => {
  const pedidos = [
    pedido({ numeroPedido: "1", situacao: "Finalizado", dataHora: "2026-09-01T09:00:00", dataFinalizado: "2026-09-01T09:30:00" }),
    pedido({ numeroPedido: "2", situacao: "Cancelado", dataHora: "2026-09-01T10:00:00", dataCancelado: "2026-09-01T10:05:00" }),
  ];
  const d = calcularDashboardOperacional(pedidos);
  assert.equal(d.vidaPedidoPorDia.concluidos.length, 1);
  assert.equal(d.vidaPedidoPorDia.concluidos[0].mediaMin, 30);
  assert.equal(d.vidaPedidoPorDia.cancelados.length, 1);
  assert.equal(d.vidaPedidoPorDia.cancelados[0].mediaMin, 5);
});

test("distância estimada: soma por entregador só com valores válidos, nunca chamada de percurso real", () => {
  const pedidos = [
    pedido({ numeroPedido: "1", entregador: "Ana", distanciaRaioKm: 3.5 }),
    pedido({ numeroPedido: "2", entregador: "Ana", distanciaRaioKm: 2.5 }),
    pedido({ numeroPedido: "3", entregador: "Ana", distanciaRaioKm: null }), // sem distância — não entra na soma
    pedido({ numeroPedido: "4", entregador: "Bruno", distanciaRaioKm: 10 }),
  ];
  const d = calcularDashboardOperacional(pedidos);
  assert.equal(d.distanciaEstimada.disponivel, true);
  assert.equal(d.distanciaEstimada.fonte, "raio");
  const ana = d.distanciaEstimada.porEntregador.find((e) => e.entregador === "Ana");
  assert.equal(ana.distanciaKm, 6);
  assert.equal(ana.entregasComDistancia, 2);
  assert.equal(ana.pedidosElegiveis, 3); // inclui o pedido sem distância
  assert.equal(d.distanciaEstimada.totalKm, 16);
});

test("distância em rota nunca alimenta o dashboard, mesmo quando presente", () => {
  const pedidos = [pedido({ entregador: "Ana", distanciaRaioKm: 5, distanciaRotaKm: 4.2 })];
  const d = calcularDashboardOperacional(pedidos);
  assert.equal(d.distanciaEstimada.porEntregador[0].distanciaKm, 5); // usa raio (5), nunca rota (4.2)
});

test("taxa por km estimado: só entra pedido com taxa válida E distância válida simultaneamente", () => {
  const pedidos = [
    pedido({ numeroPedido: "1", entregador: "Ana", taxaEntregador: 10, distanciaRaioKm: 2 }), // conta: 10/2
    pedido({ numeroPedido: "2", entregador: "Ana", taxaEntregador: 8, distanciaRaioKm: null }), // taxa sem distância -> fora
    pedido({ numeroPedido: "3", entregador: "Ana", taxaEntregador: null, distanciaRaioKm: 6 }), // distância sem taxa -> fora
  ];
  const d = calcularDashboardOperacional(pedidos);
  const ana = d.distanciaEstimada.porEntregador.find((e) => e.entregador === "Ana");
  assert.equal(ana.taxaPorKmEstimado, 5); // 10 / 2, nunca 18/8
  assert.equal(ana.pedidosConsiderados, 1);
  assert.equal(ana.pedidosElegiveis, 3);
});

test("taxa por km estimado: divisão por zero nunca vira Infinity/NaN — vem null", () => {
  const pedidos = [pedido({ entregador: "Ana", taxaEntregador: 10, distanciaRaioKm: null })];
  const d = calcularDashboardOperacional(pedidos);
  const ana = d.distanciaEstimada.porEntregador.find((e) => e.entregador === "Ana");
  assert.equal(ana.taxaPorKmEstimado, null);
  assert.equal(d.distanciaEstimada.taxaPorKmEstimadoGeral, null);
});

test("sem nenhum pedido com distância: distanciaEstimada vem zerada, nunca NaN", () => {
  const d = calcularDashboardOperacional([pedido({ entregador: "Ana", distanciaRaioKm: null })]);
  assert.equal(d.distanciaEstimada.totalKm, 0);
  assert.equal(d.distanciaEstimada.entregasComDistancia, 0);
  assert.equal(d.distanciaEstimada.taxaPorKmEstimadoGeral, null);
});

test("análise operacional inclui o entregador com maior distância estimada", () => {
  const pedidos = [
    pedido({ numeroPedido: "1", entregador: "Ana", distanciaRaioKm: 3 }),
    pedido({ numeroPedido: "2", entregador: "Bruno", distanciaRaioKm: 12 }),
  ];
  const d = calcularDashboardOperacional(pedidos);
  assert.equal(d.analiseOperacional.entregadorMaiorDistanciaEstimada.entregador, "Bruno");
  assert.equal(d.analiseOperacional.entregadorMaiorDistanciaEstimada.distanciaKm, 12);
});

test("análise operacional: maior volume, maior taxas, dia com maior/menor tempo médio — regras determinísticas", () => {
  const pedidos = [
    pedido({ numeroPedido: "1", entregador: "Ana", taxaEntregador: 20, dataHora: "2026-09-01T09:00:00", dataColetado: "2026-09-01T10:00:00", dataEntregue: "2026-09-01T10:05:00" }),
    pedido({ numeroPedido: "2", entregador: "Ana", taxaEntregador: 20, dataHora: "2026-09-02T09:00:00", dataColetado: "2026-09-02T10:00:00", dataEntregue: "2026-09-02T10:25:00" }),
    pedido({ numeroPedido: "3", entregador: "Bruno", taxaEntregador: 10, dataHora: "2026-09-01T09:00:00", dataColetado: "2026-09-01T09:30:00", dataEntregue: "2026-09-01T09:35:00" }),
  ];
  const d = calcularDashboardOperacional(pedidos);
  assert.equal(d.analiseOperacional.entregadorMaiorVolume.entregador, "Ana");
  assert.equal(d.analiseOperacional.entregadorMaiorTaxas.entregador, "Ana");
  assert.equal(d.analiseOperacional.diaMaiorTempoMedio.data, "2026-09-02");
  assert.equal(d.analiseOperacional.diaMenorTempoMedio.data, "2026-09-01");
  assert.equal(d.analiseOperacional.totalConcluidos, 3);
});

// ---------------------------------------------------------------------------
// ETAPA 7 — pontualidade (dataEntregue x prazoEntrega, nunca dataFinalizado)
// ---------------------------------------------------------------------------
test("pontualidade: entregue exatamente no prazo conta como no_prazo (comparação inclusiva)", () => {
  const d = calcularDashboardOperacional([pedido({ dataEntregue: "2026-09-01T10:00:00", prazoEntrega: "2026-09-01T10:00:00" })]);
  assert.equal(d.pontualidade.noPrazo, 1);
  assert.equal(d.pontualidade.foraDoPrazo, 0);
});

test("pontualidade: entregue 1 segundo antes do prazo -> no_prazo", () => {
  const d = calcularDashboardOperacional([pedido({ dataEntregue: "2026-09-01T09:59:59", prazoEntrega: "2026-09-01T10:00:00" })]);
  assert.equal(d.pontualidade.noPrazo, 1);
  assert.equal(d.pontualidade.foraDoPrazo, 0);
});

test("pontualidade: entregue 1 segundo depois do prazo -> fora_do_prazo", () => {
  const d = calcularDashboardOperacional([pedido({ dataEntregue: "2026-09-01T10:00:01", prazoEntrega: "2026-09-01T10:00:00" })]);
  assert.equal(d.pontualidade.noPrazo, 0);
  assert.equal(d.pontualidade.foraDoPrazo, 1);
});

test("pontualidade: dataFinalizado posterior NUNCA transforma uma entrega no prazo em atraso", () => {
  const d = calcularDashboardOperacional([pedido({
    dataEntregue: "2026-09-01T09:59:00", prazoEntrega: "2026-09-01T10:00:00", dataFinalizado: "2026-09-01T10:30:00",
  })]);
  assert.equal(d.pontualidade.noPrazo, 1);
  assert.equal(d.pontualidade.foraDoPrazo, 0);
});

test("pontualidade: dataEntregue ausente + dataFinalizado presente -> não classifica (nunca usa dataFinalizado como fallback)", () => {
  const d = calcularDashboardOperacional([pedido({ dataEntregue: null, dataFinalizado: "2026-09-01T10:30:00", prazoEntrega: "2026-09-01T10:00:00" })]);
  assert.equal(d.pontualidade.semDataEntrega, 1);
  assert.equal(d.pontualidade.noPrazo, 0);
  assert.equal(d.pontualidade.foraDoPrazo, 0);
});

test("pontualidade: prazo ausente com dataEntregue presente -> sem_prazo, nunca no_prazo/fora_do_prazo", () => {
  const d = calcularDashboardOperacional([pedido({ dataEntregue: "2026-09-01T10:00:00", prazoEntrega: null })]);
  assert.equal(d.pontualidade.semPrazo, 1);
  assert.equal(d.pontualidade.noPrazo, 0);
  assert.equal(d.pontualidade.foraDoPrazo, 0);
});

test("pontualidade: cancelado não participa da classificação", () => {
  const d = calcularDashboardOperacional([pedido({
    situacao: "Cancelado", statusConciliacao: "cancelado_com_taxa",
    dataEntregue: "2026-09-01T10:00:01", prazoEntrega: "2026-09-01T10:00:00",
  })]);
  assert.equal(d.pontualidade.noPrazo, 0);
  assert.equal(d.pontualidade.foraDoPrazo, 0);
  assert.equal(d.pontualidade.semDataEntrega, 0);
  assert.equal(d.pontualidade.semPrazo, 0);
});

test("pontualidade: cálculo percentual — denominador é só noPrazo + foraDoPrazo, nunca inclui sem_prazo/sem_data_entrega", () => {
  const pedidos = [
    pedido({ numeroPedido: "1", dataEntregue: "2026-09-01T09:50:00", prazoEntrega: "2026-09-01T10:00:00" }), // no prazo
    pedido({ numeroPedido: "2", dataEntregue: "2026-09-01T09:50:00", prazoEntrega: "2026-09-01T10:00:00" }), // no prazo
    pedido({ numeroPedido: "3", dataEntregue: "2026-09-01T10:10:00", prazoEntrega: "2026-09-01T10:00:00" }), // fora
    pedido({ numeroPedido: "4", dataEntregue: "2026-09-01T10:10:00", prazoEntrega: null }), // sem prazo — NUNCA reduz o %
    pedido({ numeroPedido: "5", dataEntregue: null, prazoEntrega: "2026-09-01T10:00:00" }), // sem data entregue — NUNCA reduz o %
  ];
  const d = calcularDashboardOperacional(pedidos);
  assert.equal(d.pontualidade.classificaveis, 3);
  assert.equal(d.pontualidade.percentualNoPrazo, arredondar(2 / 3 * 100));
  assert.equal(d.pontualidade.semPrazo, 1);
  assert.equal(d.pontualidade.semDataEntrega, 1);
  assert.equal(d.pontualidade.totalConcluidos, 5);
});

test("pontualidade: atraso médio, mediana e maior atraso — só sobre pedidos fora do prazo, nunca negativo", () => {
  const pedidos = [
    pedido({ numeroPedido: "1", dataEntregue: "2026-09-01T10:05:00", prazoEntrega: "2026-09-01T10:00:00" }), // 5min atraso
    pedido({ numeroPedido: "2", dataEntregue: "2026-09-01T10:15:00", prazoEntrega: "2026-09-01T10:00:00" }), // 15min atraso
    pedido({ numeroPedido: "3", dataEntregue: "2026-09-01T10:25:00", prazoEntrega: "2026-09-01T10:00:00" }), // 25min atraso
    pedido({ numeroPedido: "4", dataEntregue: "2026-09-01T09:55:00", prazoEntrega: "2026-09-01T10:00:00" }), // no prazo — não entra no atraso
  ];
  const d = calcularDashboardOperacional(pedidos);
  assert.equal(d.pontualidade.atraso.quantidade, 3);
  assert.equal(d.pontualidade.atraso.medioMin, 15);
  assert.equal(d.pontualidade.atraso.medianaMin, 15);
  assert.equal(d.pontualidade.atraso.maiorMin, 25);
});

test("pontualidade: período só com dados antigos (prazoEntrega sempre null) -> classificaveis 0, percentual null, nunca 0%", () => {
  const pedidos = [
    pedido({ numeroPedido: "1", dataEntregue: "2026-09-01T10:00:00", prazoEntrega: null }),
    pedido({ numeroPedido: "2", dataEntregue: "2026-09-01T11:00:00", prazoEntrega: null }),
  ];
  const d = calcularDashboardOperacional(pedidos);
  assert.equal(d.pontualidade.classificaveis, 0);
  assert.equal(d.pontualidade.percentualNoPrazo, null); // NUNCA 0% — 0% seria uma mentira (parece "todo mundo atrasado")
  assert.equal(d.pontualidade.semPrazo, 2);
});

test("pontualidade: período misto (com e sem prazo) calcula só sobre os classificáveis e expõe a cobertura", () => {
  const pedidos = [
    pedido({ numeroPedido: "1", dataEntregue: "2026-09-01T09:50:00", prazoEntrega: "2026-09-01T10:00:00" }), // no prazo — antigo tinha prazo
    pedido({ numeroPedido: "2", dataEntregue: "2026-09-02T09:50:00", prazoEntrega: null }), // importação antiga, sem prazo
    pedido({ numeroPedido: "3", dataEntregue: "2026-09-02T10:10:00", prazoEntrega: null }),
  ];
  const d = calcularDashboardOperacional(pedidos);
  assert.equal(d.pontualidade.classificaveis, 1);
  assert.equal(d.pontualidade.totalConcluidos, 3);
  assert.equal(d.pontualidade.percentualNoPrazo, 100);
});

test("pontualidade: detalhe por entregador — classificáveis, no/fora do prazo e atraso isolados por entregador", () => {
  const pedidos = [
    pedido({ numeroPedido: "1", entregador: "Ana", dataEntregue: "2026-09-01T09:50:00", prazoEntrega: "2026-09-01T10:00:00" }),
    pedido({ numeroPedido: "2", entregador: "Ana", dataEntregue: "2026-09-01T10:10:00", prazoEntrega: "2026-09-01T10:00:00" }),
    pedido({ numeroPedido: "3", entregador: "Bruno", dataEntregue: "2026-09-01T09:50:00", prazoEntrega: "2026-09-01T10:00:00" }),
  ];
  const d = calcularDashboardOperacional(pedidos);
  const ana = d.pontualidade.porEntregador.find((e) => e.entregador === "Ana");
  const bruno = d.pontualidade.porEntregador.find((e) => e.entregador === "Bruno");
  assert.equal(ana.classificaveis, 2);
  assert.equal(ana.noPrazo, 1);
  assert.equal(ana.foraDoPrazo, 1);
  assert.equal(ana.percentualNoPrazo, 50);
  assert.equal(ana.atraso.quantidade, 1);
  assert.equal(bruno.classificaveis, 1);
  assert.equal(bruno.percentualNoPrazo, 100);
});

test("análise operacional: ranking de melhor/pior pontualidade ignora entregador com amostra pequena", () => {
  const pedidos = [
    // Carlos: 1 única entrega, fora do prazo -> 0% de pontualidade, mas amostra pequena demais pra ranquear.
    pedido({ numeroPedido: "0", entregador: "Carlos", dataEntregue: "2026-09-01T10:30:00", prazoEntrega: "2026-09-01T10:00:00" }),
  ];
  // Ana: 5 entregas (amostra mínima), todas no prazo.
  for (let i = 1; i <= 5; i++) {
    pedidos.push(pedido({ numeroPedido: String(i), entregador: "Ana", dataEntregue: `2026-09-01T09:5${i}:00`, prazoEntrega: "2026-09-01T10:00:00" }));
  }
  const d = calcularDashboardOperacional(pedidos);
  assert.equal(d.analiseOperacional.entregadorMaiorPontualidade.entregador, "Ana");
  assert.equal(d.analiseOperacional.entregadorMenorPontualidade.entregador, "Ana"); // Carlos nunca aparece — amostra de 1 é ruído
});

test("análise operacional: pontualidade geral e atraso médio só aparecem quando há pedidos classificáveis", () => {
  const semPrazo = calcularDashboardOperacional([pedido({ dataEntregue: "2026-09-01T10:00:00", prazoEntrega: null })]);
  assert.equal(semPrazo.analiseOperacional.pontualidadeGeral, null);
  assert.equal(semPrazo.analiseOperacional.atrasoMedio, null);
  assert.equal(semPrazo.analiseOperacional.maiorAtraso, null);

  const comPrazo = calcularDashboardOperacional([
    pedido({ numeroPedido: "1", dataEntregue: "2026-09-01T10:10:00", prazoEntrega: "2026-09-01T10:00:00" }),
  ]);
  assert.equal(comPrazo.analiseOperacional.pontualidadeGeral.classificaveis, 1);
  assert.equal(comPrazo.analiseOperacional.atrasoMedio.medioMin, 10);
  assert.equal(comPrazo.analiseOperacional.maiorAtraso.maiorMin, 10);
});

function arredondar(n) { return Math.round(n * 10) / 10; }
