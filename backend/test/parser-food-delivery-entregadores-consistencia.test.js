// Regressão do bug relatado: o ranking de entregadores (aba "Entregadores" /
// "Ranking resumido de entregadores", via agruparPorEntregador) e o painel
// detalhado do entregador (Dashboard Operacional, via
// calcularDashboardOperacional().entregadoresPorEntregas) precisam SEMPRE
// concordar na contagem de "entregas concluídas" para o mesmo entregador e
// período — são duas superfícies da MESMA regra de negócio (pedido com
// entregador que não está cancelado), nunca cálculos paralelos que podem
// divergir silenciosamente.
//
// Também cobre o bug real encontrado na auditoria: agruparPorEntregador()
// nunca devolvia o campo `chave` nos objetos agrupados (só o service.js
// compensava isso por fora, em entregadoresParaApi) — quem chamasse
// agruparPorEntregador() diretamente (como mesclarEntregadores) dependia de
// um contrato que a função não cumpria.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agruparPorEntregador, chaveEntregador } from "../src/modules/parser-food-delivery/parserFoodDelivery.calc.js";
import { calcularDashboardOperacional } from "../src/modules/parser-food-delivery/parserFoodDelivery.dashboard.js";
import { mesclarEntregadores } from "../src/modules/parser-food-delivery/parserFoodDelivery.lancamentos.calc.js";

function pedido(overrides = {}) {
  return {
    numeroPedido: "P" + Math.random().toString(36).slice(2),
    entregador: "Vitor",
    situacao: "Finalizado",
    taxaEntregador: 10,
    statusConciliacao: "incluido",
    dataHora: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

/** Confere que ranking (agruparPorEntregador) e detalhe (entregadoresPorEntregas) concordam, para TODOS os entregadores presentes. */
function assertRankingIgualDetalhe(pedidos) {
  const ranking = agruparPorEntregador(pedidos);
  const detalhe = calcularDashboardOperacional(pedidos).entregadoresPorEntregas;
  assert.equal(ranking.length, detalhe.length, "ranking e detalhe devem listar o mesmo conjunto de entregadores");
  for (const r of ranking) {
    const d = detalhe.find((e) => e.chave === r.chave);
    assert.ok(d, `entregador "${r.entregador}" (chave "${r.chave}") do ranking não aparece no detalhe`);
    assert.equal(d.quantidade, r.entregues, `divergência para "${r.entregador}": ranking=${r.entregues} detalhe=${d.quantidade}`);
  }
  return { ranking, detalhe };
}

// ---------- regressão do bug: chave sempre presente ----------
test("agruparPorEntregador: cada entregador agrupado carrega o campo `chave` (contrato usado por mesclarEntregadores e pelo painel detalhado)", () => {
  const g = agruparPorEntregador([pedido({ entregador: "Vitor Hugo" })]);
  assert.equal(g.length, 1);
  assert.equal(g[0].chave, chaveEntregador("Vitor Hugo"));
});

// ---------- 1) ranking e detalhe retornando a mesma quantidade de entregas ----------
test("ranking e detalhe: mesma quantidade de entregas para qualquer entregador, não só Vitor", () => {
  const pedidos = [
    ...Array.from({ length: 231 }, () => pedido({ entregador: "Vitor" })),
    ...Array.from({ length: 40 }, () => pedido({ entregador: "Ana Silva" })),
    ...Array.from({ length: 5 }, () => pedido({ entregador: "Bruno" })),
  ];
  const { ranking, detalhe } = assertRankingIgualDetalhe(pedidos);
  assert.equal(ranking.find((e) => e.entregador === "Vitor").entregues, 231);
  assert.equal(detalhe.find((e) => e.entregador === "Vitor").quantidade, 231);
});

// ---------- 2) entregador com pedidos concluídos ----------
test("entregador só com pedidos concluídos: ranking e detalhe contam todos", () => {
  const pedidos = Array.from({ length: 12 }, () => pedido({ entregador: "Vitor" }));
  assertRankingIgualDetalhe(pedidos);
});

// ---------- 3) pedidos cancelados não contam como entrega em NENHUM dos dois ----------
test("pedidos cancelados (com taxa ou sem taxa) não contam como 'entrega concluída' no ranking nem no detalhe", () => {
  const pedidos = [
    ...Array.from({ length: 231 }, () => pedido({ entregador: "Vitor" })),
    // Estes 6 são a diferença clássica relatada (231 vs 237): cancelados que
    // ainda geram taxa. Devem ficar de fora da contagem de entregas em AMBAS
    // as telas — nunca aparecer como "6 a mais" em uma delas.
    ...Array.from({ length: 6 }, () => pedido({ entregador: "Vitor", situacao: "Cancelado", statusConciliacao: "cancelado_com_taxa" })),
  ];
  const { ranking, detalhe } = assertRankingIgualDetalhe(pedidos);
  const vitorRanking = ranking.find((e) => e.entregador === "Vitor");
  const vitorDetalhe = detalhe.find((e) => e.entregador === "Vitor");
  assert.equal(vitorRanking.totalPedidos, 237); // pedidos totais (inclui cancelados)
  assert.equal(vitorRanking.entregues, 231);     // só os concluídos
  assert.equal(vitorDetalhe.quantidade, 231);    // painel detalhado bate com o ranking, não com o total
});

// ---------- 4) lançamentos avulsos/taxa adicional (incl. "pedido reatribuído") não alteram a contagem de entregas ----------
test("lançamentos avulsos e taxa adicional (ex.: motivo 'pedido reatribuído') não mudam a contagem de entregas do ranking", () => {
  const pedidos = Array.from({ length: 231 }, () => pedido({ entregador: "Vitor" }));
  const rankingBase = agruparPorEntregador(pedidos);
  const mesclado = mesclarEntregadores(rankingBase, [
    { origem: "taxa_adicional", motivo: "pedido_reatribuido", valor: 12, entregadorNome: "Vitor", entregadorChave: "vitor", excluido: false },
    { origem: "avulso", motivo: "buscar_paes", valor: 20, entregadorNome: "Vitor", entregadorChave: "vitor", excluido: false },
  ]);
  const vitor = mesclado.find((e) => e.chave === "vitor");
  assert.equal(vitor.entregues, 231, "lançamentos avulsos/taxa adicional só mexem em custo, nunca na contagem de entregas");
  assert.equal(vitor.totalPedidos, 231);
  assert.equal(vitor.somenteLancamentos, false);
  assert.ok(vitor.taxasAdicionais > 0 || vitor.avulsos > 0);

  // O painel detalhado (dashboardOperacional) nem inclui lançamentos — deve
  // continuar batendo com o "entregues" do ranking mesclado.
  const detalhe = calcularDashboardOperacional(pedidos).entregadoresPorEntregas.find((e) => e.chave === "vitor");
  assert.equal(detalhe.quantidade, vitor.entregues);
});

// ---------- 5) entregador que só existe em lançamentos (sem pedido no iFood) ----------
test("entregador que só tem lançamento avulso (sem pedido iFood) não aparece no painel detalhado do Dashboard, mas fica marcado no ranking", () => {
  const pedidos = Array.from({ length: 10 }, () => pedido({ entregador: "Vitor" }));
  const rankingBase = agruparPorEntregador(pedidos);
  const mesclado = mesclarEntregadores(rankingBase, [
    { origem: "avulso", motivo: "buscar_insumos", valor: 15, entregadorNome: "Ronaldo", entregadorChave: "ronaldo", excluido: false },
  ]);
  const ronaldo = mesclado.find((e) => e.chave === "ronaldo");
  assert.equal(ronaldo.somenteLancamentos, true);
  assert.equal(ronaldo.entregues, 0);

  const detalhe = calcularDashboardOperacional(pedidos).entregadoresPorEntregas;
  assert.equal(detalhe.some((e) => e.chave === "ronaldo"), false, "sem pedido no relatório, não há indicador logístico a mostrar pra ele");
});

// ---------- 6) relatórios consolidados (múltiplas fontes/importações somadas) ----------
test("período consolidado (pedidos de mais de uma importação): ranking e detalhe continuam concordando", () => {
  const importacao1 = Array.from({ length: 100 }, () => pedido({ entregador: "Vitor", dataHora: "2026-09-01T10:00:00.000Z" }));
  const importacao2 = Array.from({ length: 131 }, () => pedido({ entregador: "Vitor", dataHora: "2026-09-15T10:00:00.000Z" }));
  const canceladosImportacao2 = Array.from({ length: 6 }, () => pedido({ entregador: "Vitor", situacao: "Cancelado", statusConciliacao: "cancelado_com_taxa", dataHora: "2026-09-15T10:00:00.000Z" }));
  const consolidado = [...importacao1, ...importacao2, ...canceladosImportacao2];
  const { ranking, detalhe } = assertRankingIgualDetalhe(consolidado);
  assert.equal(ranking.find((e) => e.entregador === "Vitor").entregues, 231);
  assert.equal(detalhe.find((e) => e.entregador === "Vitor").quantidade, 231);
});

// ---------- 7) filtro por período (só os pedidos dentro do intervalo entram na conta) ----------
test("filtro por período: só os pedidos dentro do intervalo selecionado contam em ranking e detalhe", () => {
  const dentroDoPeriodo = Array.from({ length: 50 }, () => pedido({ entregador: "Vitor", dataHora: "2026-09-10T12:00:00.000Z" }));
  const foraDoPeriodo = Array.from({ length: 999 }, () => pedido({ entregador: "Vitor", dataHora: "2026-08-01T12:00:00.000Z" }));

  const inicio = "2026-09-01", fimExclusivo = "2026-10-01";
  const noPeriodo = [...dentroDoPeriodo, ...foraDoPeriodo].filter((p) => p.dataHora >= inicio && p.dataHora < fimExclusivo);

  const { ranking, detalhe } = assertRankingIgualDetalhe(noPeriodo);
  assert.equal(ranking.find((e) => e.entregador === "Vitor").entregues, 50);
  assert.equal(detalhe.find((e) => e.entregador === "Vitor").quantidade, 50);
});

// ---------- 8) grafias diferentes do mesmo entregador fundem igual nos dois lados ----------
test("variações de grafia (caixa/espaço) do mesmo entregador fundem para a MESMA chave em ranking e detalhe", () => {
  const pedidos = [
    ...Array.from({ length: 100 }, () => pedido({ entregador: "Vitor" })),
    ...Array.from({ length: 100 }, () => pedido({ entregador: "vitor " })),
    ...Array.from({ length: 31 }, () => pedido({ entregador: "VITOR" })),
  ];
  const { ranking, detalhe } = assertRankingIgualDetalhe(pedidos);
  assert.equal(ranking.length, 1);
  assert.equal(ranking[0].entregues, 231);
  assert.equal(detalhe[0].quantidade, 231);
});
