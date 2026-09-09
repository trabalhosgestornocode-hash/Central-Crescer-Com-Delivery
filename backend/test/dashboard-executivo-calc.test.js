// Testes da camada de cálculo do Dashboard Executivo (dashboardExecutivo.calc.js)
// — puros, sem rede. Rodar: node --test test/dashboard-executivo-calc.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ticketMedio, percentual, totalDeducoes, receitaLiquida, saldoPercentual,
  mediaDiaria, projecaoMensal, confiabilidadeProjecao, statusDiaBase, statusMes,
  resumoPreenchimento, verificarDisponibilidade, agruparPendenciasPorMes,
  inconsistencias,
  diasDoMes, mesAnterior, diaAnterior, STATUS_DIA,
  MODELOS_LOGISTICOS, ROTULO_MODELO, INDICADORES_POR_MODELO, indicadorAplicavel,
  COMPONENTES_TOTAL_DEDUCOES, componentesTotalDeducoes, totalDeducoesIndicador,
  statusIndicador, saldoMeta, distribuirValorMensal, distribuirQuantidadeMensal,
  recalcularDistribuicaoMensal, snapshotFinanceiroMaisRecente, listaSnapshotsFinanceiros,
  listaDesempenhoDiario, ultimoDesempenhoConhecido, desempenhoParaTicketMedio,
  deltaFinanceiro,
} from "../src/modules/dashboard-executivo/dashboardExecutivo.calc.js";

const perto = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
describe("ticket médio", () => {
  test("R$ 4.668,53 / 108 vendas ≈ R$ 43,23", () => {
    assert.ok(perto(ticketMedio(4668.53, 108), 43.23, 0.01));
  });
  test("sem vendas devolve null (nunca divide por zero)", () => {
    assert.equal(ticketMedio(1000, 0), null);
    assert.equal(ticketMedio(1000, null), null);
  });
});

// ---------------------------------------------------------------------------
describe("percentual", () => {
  test("851,22 / 4668,53 ≈ 18,23%", () => {
    assert.ok(perto(percentual(851.22, 4668.53), 18.23, 0.01));
  });
  test("base zero ou inválida devolve null", () => {
    assert.equal(percentual(100, 0), null);
    assert.equal(percentual(100, null), null);
  });
});

// ---------------------------------------------------------------------------
describe("total de deduções e receita líquida", () => {
  test("soma taxas + serviços + entregadores + ajustes CONTRA a loja", () => {
    const total = totalDeducoes({ taxasComissoes: 100, servicosPromocoes: 50, taxasEntregadores: 30, ajustesContraLoja: 20 });
    assert.equal(total, 200);
  });
  test("ajuste A FAVOR da loja NÃO entra no total de deduções", () => {
    // só o ajuste contra soma; o a favor é crédito e nem é passado aqui
    const total = totalDeducoes({ taxasComissoes: 100, servicosPromocoes: 50, taxasEntregadores: 30, ajustesContraLoja: 0 });
    assert.equal(total, 180);
  });
  test("receita líquida = vendas - total de deduções + ajustes a favor", () => {
    assert.equal(receitaLiquida(1000, 300), 700);
    assert.equal(receitaLiquida(1000, 300, 0), 700);
    assert.equal(receitaLiquida(1000, 300, 80), 780);
  });
  test("exemplo obrigatório do pedido: 100 - 10 - 5 - 3 + 8 = 90 (total de deduções = 18)", () => {
    const total = totalDeducoes({ taxasComissoes: 10, servicosPromocoes: 5, taxasEntregadores: 0, ajustesContraLoja: 3 });
    assert.equal(total, 18);
    assert.equal(receitaLiquida(100, total, 8), 90);
  });
  test("receita líquida indisponível quando o total de deduções é null", () => {
    assert.equal(receitaLiquida(1000, null, 50), null);
  });
  test("saldo percentual = 100 - percentual total; null quando o percentual é null", () => {
    assert.equal(saldoPercentual(30), 70);
    assert.equal(saldoPercentual(null), null);
  });
});

// ---------------------------------------------------------------------------
describe("média diária e projeção", () => {
  test("média ignora nulls (dias sem dado)", () => {
    assert.equal(mediaDiaria([100, 200, null, 300]), 200);
  });
  test("sem nenhum dia válido devolve null", () => {
    assert.equal(mediaDiaria([]), null);
    assert.equal(mediaDiaria([null, undefined]), null);
  });
  test("projeção = média × dias previstos", () => {
    assert.equal(projecaoMensal(1000, 30), 30000);
    assert.equal(projecaoMensal(null, 30), null);
  });
});

// ---------------------------------------------------------------------------
describe("confiabilidade da projeção", () => {
  test("sem dados => indisponível", () => {
    assert.equal(confiabilidadeProjecao({ diasVencidos: 3, diasResolvidos: 0, diasComDados: 0 }).nivel, "indisponivel");
  });
  test("com pendência => baixa, mesmo com dados", () => {
    assert.equal(confiabilidadeProjecao({ diasVencidos: 5, diasResolvidos: 3, diasComDados: 3 }).nivel, "baixa");
  });
  test("sem pendência e poucos dias => média", () => {
    assert.equal(confiabilidadeProjecao({ diasVencidos: 3, diasResolvidos: 3, diasComDados: 3 }).nivel, "media");
  });
  test("sem pendência e dias suficientes => alta", () => {
    assert.equal(confiabilidadeProjecao({ diasVencidos: 6, diasResolvidos: 6, diasComDados: 6 }).nivel, "alta");
  });
});

// ---------------------------------------------------------------------------
describe("status de um dia (base, a partir do lançamento)", () => {
  test("sem lançamento => null", () => assert.equal(statusDiaBase({ lancamento: null }), null));
  test("rascunho + situação normal + financeiro já preenchido => RASCUNHO", () => {
    assert.equal(statusDiaBase({ lancamento: { status: "rascunho", situacao: "normal", valor_vendas_ifood: 500 } }), STATUS_DIA.RASCUNHO);
  });
  test("rascunho + sem_operacao/zero_vendas => RASCUNHO (financeiro não se aplica a essas situações)", () => {
    assert.equal(statusDiaBase({ lancamento: { status: "rascunho", situacao: "sem_operacao" } }), STATUS_DIA.RASCUNHO);
    assert.equal(statusDiaBase({ lancamento: { status: "rascunho", situacao: "zero_vendas" } }), STATUS_DIA.RASCUNHO);
  });
  test("rascunho + situação normal + SEM financeiro + dia ELEGÍVEL (data === ontem) => FINANCEIRO_PENDENTE", () => {
    assert.equal(statusDiaBase({ lancamento: { status: "rascunho", situacao: "normal", valor_vendas_ifood: null }, ehDataElegivel: true }), STATUS_DIA.FINANCEIRO_PENDENTE);
    assert.equal(statusDiaBase({ lancamento: { status: "rascunho", situacao: "normal" }, ehDataElegivel: true }), STATUS_DIA.FINANCEIRO_PENDENTE);
  });
  test("rascunho + situação normal + SEM financeiro + dia NÃO elegível => RASCUNHO comum (financeiro nem é oferecido nesse dia, então não é 'esperando o iFood')", () => {
    assert.equal(statusDiaBase({ lancamento: { status: "rascunho", situacao: "normal", valor_vendas_ifood: null }, ehDataElegivel: false }), STATUS_DIA.RASCUNHO);
  });
  test("finalizado + sem_operacao => SEM_OPERACAO", () => {
    assert.equal(statusDiaBase({ lancamento: { status: "finalizado", situacao: "sem_operacao" } }), STATUS_DIA.SEM_OPERACAO);
  });
  test("finalizado + zero_vendas => ZERO_VENDAS", () => {
    assert.equal(statusDiaBase({ lancamento: { status: "finalizado", situacao: "zero_vendas" } }), STATUS_DIA.ZERO_VENDAS);
  });
  test("finalizado + normal => PREENCHIDO", () => {
    assert.equal(statusDiaBase({ lancamento: { status: "finalizado", situacao: "normal" } }), STATUS_DIA.PREENCHIDO);
  });
  test("situação 'parcial' se comporta como 'normal' (mesmo fluxo de Desempenho + Financeiro)", () => {
    assert.equal(statusDiaBase({ lancamento: { status: "finalizado", situacao: "parcial" } }), STATUS_DIA.PREENCHIDO);
    assert.equal(
      statusDiaBase({ lancamento: { status: "rascunho", situacao: "parcial", valor_vendas_ifood: null }, ehDataElegivel: true }),
      STATUS_DIA.FINANCEIRO_PENDENTE,
    );
  });
});

// ---------------------------------------------------------------------------
// A trava sequencial: o núcleo do bloqueio pedido no briefing.
// ---------------------------------------------------------------------------
describe("statusMes — trava sequencial dentro do mês", () => {
  test("dia 1 vazio fica PENDENTE (nunca bloqueado por padrão)", () => {
    const dias = [{ data: "2026-08-01", lancamento: null }];
    const r = statusMes({ dias, hojeIso: "2026-08-03" });
    assert.equal(r[0].status, STATUS_DIA.PENDENTE);
  });

  test("dia 1 vazio + dia 2 vazio + hoje=dia 3 => dia 2 e 3 BLOQUEADOS", () => {
    const dias = [
      { data: "2026-08-01", lancamento: null },
      { data: "2026-08-02", lancamento: null },
      { data: "2026-08-03", lancamento: null },
    ];
    const r = statusMes({ dias, hojeIso: "2026-08-03" });
    assert.equal(r[0].status, STATUS_DIA.PENDENTE);
    assert.equal(r[1].status, STATUS_DIA.BLOQUEADO);
    assert.equal(r[2].status, STATUS_DIA.BLOQUEADO);
  });

  test("dia 1 finalizado libera o dia 2", () => {
    const dias = [
      { data: "2026-08-01", lancamento: { status: "finalizado", situacao: "normal" } },
      { data: "2026-08-02", lancamento: null },
    ];
    const r = statusMes({ dias, hojeIso: "2026-08-03" });
    assert.equal(r[0].status, STATUS_DIA.PREENCHIDO);
    assert.equal(r[1].status, STATUS_DIA.PENDENTE);
  });

  test("dia 1 em rascunho de VERDADE (financeiro já preenchido, deixado assim de propósito) NÃO libera o dia 2", () => {
    const dias = [
      { data: "2026-08-01", lancamento: { status: "rascunho", situacao: "normal", valor_vendas_ifood: 1000 } },
      { data: "2026-08-02", lancamento: null },
    ];
    const r = statusMes({ dias, hojeIso: "2026-08-03" });
    assert.equal(r[0].status, STATUS_DIA.RASCUNHO);
    assert.equal(r[1].status, STATUS_DIA.BLOQUEADO);
  });

  test("dia 1 rascunho AGUARDANDO FINANCEIRO no dia ELEGÍVEL (situação normal, data === ontem) RESOLVE e libera o dia 2 — bug real corrigido: sem isso, o mês inteiro travava toda vez que o financeiro de um dia ainda não estava disponível", () => {
    const dias = [
      { data: "2026-08-01", lancamento: { status: "rascunho", situacao: "normal", valor_vendas_ifood: null } },
      { data: "2026-08-02", lancamento: null },
    ];
    const r = statusMes({ dias, hojeIso: "2026-08-02" }); // hoje=02 -> ontem=01: dia 1 é o único elegível
    assert.equal(r[0].status, STATUS_DIA.FINANCEIRO_PENDENTE);
    assert.equal(r[1].status, STATUS_DIA.PENDENTE);
  });

  test("dia 1 rascunho sem financeiro FORA do dia elegível continua RASCUNHO comum e bloqueia o dia 2 (o financeiro acumulado do iFood é snapshot do mês, não pendência de cada dia — ver migration 036)", () => {
    const dias = [
      { data: "2026-08-01", lancamento: { status: "rascunho", situacao: "normal", valor_vendas_ifood: null } },
      { data: "2026-08-02", lancamento: null },
    ];
    const r = statusMes({ dias, hojeIso: "2026-08-03" }); // hoje=03 -> ontem=02: dia 1 já não é mais elegível
    assert.equal(r[0].status, STATUS_DIA.RASCUNHO);
    assert.equal(r[1].status, STATUS_DIA.BLOQUEADO);
  });

  test("dia sem operação e dia zero vendas TAMBÉM resolvem e liberam o próximo", () => {
    const dias = [
      { data: "2026-08-01", lancamento: { status: "finalizado", situacao: "sem_operacao" } },
      { data: "2026-08-02", lancamento: { status: "finalizado", situacao: "zero_vendas" } },
      { data: "2026-08-03", lancamento: null },
    ];
    const r = statusMes({ dias, hojeIso: "2026-08-03" });
    assert.equal(r[0].status, STATUS_DIA.SEM_OPERACAO);
    assert.equal(r[1].status, STATUS_DIA.ZERO_VENDAS);
    assert.equal(r[2].status, STATUS_DIA.PENDENTE);
  });

  test("data futura é sempre FUTURO, mesmo que o dia anterior esteja pendente", () => {
    const dias = [
      { data: "2026-08-01", lancamento: null },
      { data: "2026-08-02", lancamento: null },
    ];
    const r = statusMes({ dias, hojeIso: "2026-08-01" });
    assert.equal(r[0].status, STATUS_DIA.PENDENTE); // é hoje, não é futuro
    assert.equal(r[1].status, STATUS_DIA.FUTURO);
  });

  test("dia 1 de um mês novo NUNCA é bloqueado — a trava não atravessa a fronteira do mês", () => {
    // Isto é chamado uma vez por mês; o próprio statusMes só vê os dias do mês
    // recebido, então pendência de agosto não pode aparecer aqui.
    const diasSetembro = [{ data: "2026-09-01", lancamento: null }];
    const r = statusMes({ dias: diasSetembro, hojeIso: "2026-09-01" });
    assert.equal(r[0].status, STATUS_DIA.PENDENTE);
  });

  test("elegivelFinanceiro marca só o dia === hoje-1, exposto pro frontend decidir o badge (não recalcular no cliente)", () => {
    const dias = [
      { data: "2026-08-10", lancamento: null },
      { data: "2026-08-11", lancamento: null },
      { data: "2026-08-12", lancamento: null },
    ];
    const r = statusMes({ dias, hojeIso: "2026-08-12" }); // hoje=12 -> ontem=11
    assert.equal(r[0].elegivelFinanceiro, false); // 10/08
    assert.equal(r[1].elegivelFinanceiro, true); // 11/08
    assert.equal(r[2].elegivelFinanceiro, false); // 12/08 (é hoje, não ontem)
  });
});

describe("resumoPreenchimento", () => {
  test("conta cada status e calcula o percentual de conclusão", () => {
    const diasComStatus = [
      { data: "2026-08-01", status: STATUS_DIA.PREENCHIDO, lancamento: { x: 1 } },
      { data: "2026-08-02", status: STATUS_DIA.SEM_OPERACAO, lancamento: { x: 1 } },
      { data: "2026-08-03", status: STATUS_DIA.RASCUNHO, lancamento: { x: 1 } },
      { data: "2026-08-04", status: STATUS_DIA.PENDENTE, lancamento: null },
      { data: "2026-08-05", status: STATUS_DIA.FUTURO, lancamento: null },
    ];
    const r = resumoPreenchimento(diasComStatus);
    assert.equal(r.totalDias, 5);
    assert.equal(r.diasPreenchidos, 2); // PREENCHIDO + SEM_OPERACAO
    assert.equal(r.diasRascunho, 1);
    assert.equal(r.diasPendentes, 1);
    assert.equal(r.primeiroDiaPendente, "2026-08-04");
    assert.ok(perto(r.percentualConclusao, 40));
  });
});

describe("verificarDisponibilidade", () => {
  const dias = [
    { data: "2026-08-01", status: STATUS_DIA.PREENCHIDO },
    { data: "2026-08-02", status: STATUS_DIA.PENDENTE },
    { data: "2026-08-03", status: STATUS_DIA.BLOQUEADO },
    { data: "2026-08-04", status: STATUS_DIA.FUTURO },
  ];
  test("PENDENTE está disponível", () => assert.equal(verificarDisponibilidade(dias, "2026-08-02").disponivel, true));
  test("BLOQUEADO não está disponível", () => assert.equal(verificarDisponibilidade(dias, "2026-08-03").disponivel, false));
  test("FUTURO não está disponível", () => assert.equal(verificarDisponibilidade(dias, "2026-08-04").disponivel, false));
  test("data fora do mês consultado não está disponível", () => assert.equal(verificarDisponibilidade(dias, "2026-09-01").disponivel, false));
});

describe("agruparPendenciasPorMes", () => {
  test("agrupa datas pendentes por ano-mês", () => {
    const grupos = agruparPendenciasPorMes(["2026-07-30", "2026-07-31", "2026-06-15"]);
    assert.equal(grupos.length, 2);
    assert.deepEqual(grupos[0], { ano: 2026, mes: 6, dias: ["2026-06-15"] });
    assert.deepEqual(grupos[1], { ano: 2026, mes: 7, dias: ["2026-07-30", "2026-07-31"] });
  });
});

describe("diasDoMes / mesAnterior", () => {
  test("agosto de 2026 tem 31 dias", () => assert.equal(diasDoMes(2026, 8).length, 31));
  test("fevereiro de 2028 (bissexto) tem 29 dias", () => assert.equal(diasDoMes(2028, 2).length, 29));
  test("mês anterior a janeiro é dezembro do ano anterior", () => {
    assert.deepEqual(mesAnterior(2026, 1), { ano: 2025, mes: 12 });
    assert.deepEqual(mesAnterior(2026, 8), { ano: 2026, mes: 7 });
  });
});

// ---------------------------------------------------------------------------
// diaAnterior — regra "Financeiro só aparece quando data === ontem" (pedido
// de ajuste do Lançamento Diário). Comparação de CALENDÁRIO via Date.UTC,
// nunca diferença de milissegundos — cobre os casos exatos do pedido.
// ---------------------------------------------------------------------------
describe("diaAnterior", () => {
  test("dia normal, sem virada", () => {
    assert.equal(diaAnterior("2026-08-11"), "2026-08-10");
    assert.equal(diaAnterior("2026-08-14"), "2026-08-13");
  });

  test("hoje=11/08: 10/08 é ontem, 09/08 e 08/08 não são", () => {
    const ontem = diaAnterior("2026-08-11");
    assert.equal(ontem, "2026-08-10");
    assert.notEqual(ontem, "2026-08-09");
    assert.notEqual(ontem, "2026-08-08");
  });

  test("hoje=14/08: 13/08 é ontem, 12/08 não é", () => {
    const ontem = diaAnterior("2026-08-14");
    assert.equal(ontem, "2026-08-13");
    assert.notEqual(ontem, "2026-08-12");
  });

  test("virada de mês: dia 1 -> último dia do mês anterior", () => {
    assert.equal(diaAnterior("2026-09-01"), "2026-08-31"); // agosto tem 31 dias
    assert.equal(diaAnterior("2026-05-01"), "2026-04-30"); // abril tem 30 dias
    assert.equal(diaAnterior("2028-03-01"), "2028-02-29"); // fevereiro bissexto
    assert.equal(diaAnterior("2026-03-01"), "2026-02-28"); // fevereiro comum
  });

  test("virada de ano: 01/01 -> 31/12 do ano anterior", () => {
    assert.equal(diaAnterior("2027-01-01"), "2026-12-31");
  });
});

// ---------------------------------------------------------------------------
// snapshotFinanceiroMaisRecente — Financeiro é snapshot ACUMULADO do mês
// (dia 1 até a data), nunca soma entre dias (migration 036 / correção do
// pedido: "não implementar dia sem valor_vendas_ifood => rascunho
// obrigatório"). A Visão Geral usa sempre o snapshot mais recente.
// ---------------------------------------------------------------------------
describe("snapshotFinanceiroMaisRecente", () => {
  test("sem nenhum lançamento com financeiro => null (nunca R$0 inventado)", () => {
    const linhas = [
      { data_lancamento: "2026-08-05", situacao: "normal", valor_vendas_ifood: null },
      { data_lancamento: "2026-08-10", situacao: "sem_operacao", valor_vendas_ifood: 0 },
    ];
    assert.equal(snapshotFinanceiroMaisRecente(linhas), null);
  });

  test("pega o MAIS RECENTE por data, não soma os dois (o acumulado de 11/08 já inclui 01-11/08)", () => {
    const linhas = [
      { data_lancamento: "2026-08-05", situacao: "normal", valor_vendas_ifood: 8000 },
      { data_lancamento: "2026-08-11", situacao: "normal", valor_vendas_ifood: 15000 },
    ];
    const snap = snapshotFinanceiroMaisRecente(linhas);
    assert.equal(snap.data_lancamento, "2026-08-11");
    assert.equal(snap.valor_vendas_ifood, 15000); // NUNCA 23000 (8000+15000)
  });

  test("dia sem_operacao/zero_vendas mais recente NUNCA apaga o snapshot real (0 sintético, não extrato do iFood)", () => {
    const linhas = [
      { data_lancamento: "2026-08-11", situacao: "normal", valor_vendas_ifood: 15000 },
      { data_lancamento: "2026-08-12", situacao: "sem_operacao", valor_vendas_ifood: 0 },
    ];
    const snap = snapshotFinanceiroMaisRecente(linhas);
    assert.equal(snap.data_lancamento, "2026-08-11");
    assert.equal(snap.valor_vendas_ifood, 15000);
  });

  test("dia 'parcial' conta como snapshot financeiro real, igual 'normal'", () => {
    const linhas = [
      { data_lancamento: "2026-08-05", situacao: "normal", valor_vendas_ifood: 8000 },
      { data_lancamento: "2026-08-11", situacao: "parcial", valor_vendas_ifood: 15000 },
    ];
    const snap = snapshotFinanceiroMaisRecente(linhas);
    assert.equal(snap.data_lancamento, "2026-08-11");
    assert.equal(snap.valor_vendas_ifood, 15000);
  });

  test("corte de data (ateDataIso) ignora snapshots depois do corte", () => {
    const linhas = [
      { data_lancamento: "2026-08-05", situacao: "normal", valor_vendas_ifood: 8000 },
      { data_lancamento: "2026-08-20", situacao: "normal", valor_vendas_ifood: 30000 },
    ];
    const snap = snapshotFinanceiroMaisRecente(linhas, "2026-08-10");
    assert.equal(snap.data_lancamento, "2026-08-05");
    assert.equal(snap.valor_vendas_ifood, 8000);
  });

  test("sem entrada real, mas com dias de Lançamento Mensal (distribuição) => soma as fatias (são aditivas por design)", () => {
    const linhas = [
      { data_lancamento: "2026-08-01", situacao: "normal", valor_vendas_ifood: 1000, origem_lancamento: "distribuicao_mensal" },
      { data_lancamento: "2026-08-02", situacao: "normal", valor_vendas_ifood: 1000, origem_lancamento: "distribuicao_mensal" },
    ];
    const snap = snapshotFinanceiroMaisRecente(linhas);
    assert.equal(snap.valor_vendas_ifood, 2000);
    assert.equal(snap.data_lancamento, "2026-08-02");
  });

  test("entrada real presente sempre vence a distribuição mensal, mesmo mais antiga", () => {
    const linhas = [
      { data_lancamento: "2026-08-01", situacao: "normal", valor_vendas_ifood: 1000, origem_lancamento: "distribuicao_mensal" },
      { data_lancamento: "2026-08-02", situacao: "normal", valor_vendas_ifood: 1000, origem_lancamento: "distribuicao_mensal" },
      { data_lancamento: "2026-08-01", situacao: "normal", valor_vendas_ifood: 500 },
    ];
    const snap = snapshotFinanceiroMaisRecente(linhas);
    assert.equal(snap.valor_vendas_ifood, 500);
    assert.equal(snap.data_lancamento, "2026-08-01");
  });
});

// ---------------------------------------------------------------------------
// desempenhoParaTicketMedio — fonte única do par (valor bruto, pedidos) pro
// Ticket Médio em Lançamentos, Visão Geral (unidade e agregado) e Histórico.
// Mesma prioridade de snapshotFinanceiroMaisRecente, adaptada pro Desempenho:
// diário real acumulado primeiro; soma das fatias do Lançamento Mensal só
// como último recurso; nunca mistura as duas fontes; nunca faz média de
// tickets médios diários (item 6 do pedido: "evitar média de médias").
// ---------------------------------------------------------------------------
describe("desempenhoParaTicketMedio", () => {
  test("sem nenhum dado de Desempenho => null (nunca R$0,00 fingido)", () => {
    const linhas = [
      { data_lancamento: "2026-08-05", qtd_vendas: null, valor_vendas_bruto: null },
    ];
    assert.equal(desempenhoParaTicketMedio(linhas), null);
  });

  test("pega o par diário real MAIS RECENTE (já é o acumulado do mês até ali) — não soma entre dias", () => {
    const linhas = [
      { data_lancamento: "2026-08-05", qtd_vendas: 50, valor_vendas_bruto: 4000 },
      { data_lancamento: "2026-08-11", qtd_vendas: 108, valor_vendas_bruto: 4668.53 },
    ];
    const par = desempenhoParaTicketMedio(linhas);
    assert.equal(par.qtdVendas, 108);
    assert.ok(perto(par.valorVendasBruto, 4668.53, 0.01));
  });

  test("dia com só um dos dois lados é ignorado na busca pelo par mais recente", () => {
    const linhas = [
      { data_lancamento: "2026-08-05", qtd_vendas: 50, valor_vendas_bruto: 4000 },
      { data_lancamento: "2026-08-11", qtd_vendas: 120, valor_vendas_bruto: null }, // só um lado — não conta
    ];
    const par = desempenhoParaTicketMedio(linhas);
    assert.equal(par.qtdVendas, 50);
    assert.equal(par.valorVendasBruto, 4000);
  });

  test("sem lançamento diário real, soma as fatias do Lançamento Mensal (total ÷ total, nunca fatia isolada)", () => {
    const linhas = [
      { data_lancamento: "2026-08-01", origem_lancamento: "distribuicao_mensal", qtd_vendas: 53, valor_vendas_bruto: 2580.65 },
      { data_lancamento: "2026-08-02", origem_lancamento: "distribuicao_mensal", qtd_vendas: 53, valor_vendas_bruto: 2580.65 },
      { data_lancamento: "2026-08-03", origem_lancamento: "distribuicao_mensal", qtd_vendas: 54, valor_vendas_bruto: 2580.65 },
    ];
    const par = desempenhoParaTicketMedio(linhas);
    assert.equal(par.qtdVendas, 160); // 53+53+54 — NUNCA a fatia de um dia isolado
    assert.ok(perto(par.valorVendasBruto, 7741.95, 0.01));
  });

  test("Lançamento Mensal com só um dos dois totais informado => null (nunca mistura um lado ausente)", () => {
    const linhas = [
      { data_lancamento: "2026-08-01", origem_lancamento: "distribuicao_mensal", qtd_vendas: 53, valor_vendas_bruto: null },
      { data_lancamento: "2026-08-02", origem_lancamento: "distribuicao_mensal", qtd_vendas: 53, valor_vendas_bruto: null },
    ];
    assert.equal(desempenhoParaTicketMedio(linhas), null);
  });

  test("lançamento diário real sempre vence a distribuição mensal, mesmo mais antigo (nunca mistura as duas fontes)", () => {
    const linhas = [
      { data_lancamento: "2026-08-10", origem_lancamento: "distribuicao_mensal", qtd_vendas: 53, valor_vendas_bruto: 2580.65 },
      { data_lancamento: "2026-08-15", origem_lancamento: "distribuicao_mensal", qtd_vendas: 53, valor_vendas_bruto: 2580.65 },
      { data_lancamento: "2026-08-05", qtd_vendas: 108, valor_vendas_bruto: 4668.53 },
    ];
    const par = desempenhoParaTicketMedio(linhas);
    assert.equal(par.qtdVendas, 108);
    assert.ok(perto(par.valorVendasBruto, 4668.53, 0.01));
  });
});

// ---------------------------------------------------------------------------
// listaSnapshotsFinanceiros — série do mês pra plotar "Evolução do Financeiro
// acumulado" sem interpolar entre pontos (item 6 do pedido de UX).
// ---------------------------------------------------------------------------
describe("listaSnapshotsFinanceiros", () => {
  const dias3 = ["2026-08-01", "2026-08-02", "2026-08-03"];

  test("um ponto por dia do mês; dias sem snapshot vêm null (nunca R$0)", () => {
    const linhas = [
      { data_lancamento: "2026-08-02", situacao: "normal", valor_vendas_ifood: 5000, taxas_comissoes: 500, servicos_promocoes: 100, taxas_entregadores: 200, ajustes_contra_loja: 0, ajustes_favor_loja: 0 },
    ];
    const r = listaSnapshotsFinanceiros(dias3, linhas);
    assert.equal(r.length, 3);
    assert.deepEqual(r[0], { data: "2026-08-01", valor: null, delta: null, percentualTotalDeducoes: null });
    assert.equal(r[1].valor, 5000);
    assert.equal(r[1].delta, null); // primeiro snapshot do mês: sem "anterior" pra comparar
    assert.ok(Math.abs(r[1].percentualTotalDeducoes - 16) < 0.01); // 800/5000
    assert.deepEqual(r[2], { data: "2026-08-03", valor: null, delta: null, percentualTotalDeducoes: null });
  });

  test("delta é contra o snapshot anterior do MÊS, não o dia anterior do calendário", () => {
    const linhas = [
      { data_lancamento: "2026-08-01", situacao: "normal", valor_vendas_ifood: 50000, taxas_comissoes: null, servicos_promocoes: null, taxas_entregadores: null, ajustes_contra_loja: null },
      { data_lancamento: "2026-08-03", situacao: "normal", valor_vendas_ifood: 53000, taxas_comissoes: null, servicos_promocoes: null, taxas_entregadores: null, ajustes_contra_loja: null },
    ];
    const r = listaSnapshotsFinanceiros(dias3, linhas);
    assert.equal(r[0].delta, null);
    assert.equal(r[1].delta, null); // 02/08 não tem snapshot
    assert.equal(r[2].delta, 3000); // 53000 - 50000, pulando o dia 02 sem dado
  });

  test("ignora sem_operacao/zero_vendas (financeiro sintético, não extrato real) e distribuição mensal (fatia, não snapshot)", () => {
    const linhas = [
      { data_lancamento: "2026-08-01", situacao: "sem_operacao", valor_vendas_ifood: 0 },
      { data_lancamento: "2026-08-02", situacao: "normal", valor_vendas_ifood: 1000, origem_lancamento: "distribuicao_mensal" },
      { data_lancamento: "2026-08-03", situacao: "zero_vendas", valor_vendas_ifood: 0 },
    ];
    const r = listaSnapshotsFinanceiros(dias3, linhas);
    assert.ok(r.every((p) => p.valor === null));
  });

  test("mês sem nenhum snapshot: todos os pontos null", () => {
    const r = listaSnapshotsFinanceiros(dias3, []);
    assert.equal(r.length, 3);
    assert.ok(r.every((p) => p.valor === null && p.delta === null && p.percentualTotalDeducoes === null));
  });

  test("dia 'parcial' ENTRA na série mensal, igual 'normal' (financeiro é extrato real do iFood)", () => {
    const linhas = [
      { data_lancamento: "2026-08-01", situacao: "normal", valor_vendas_ifood: 4000, taxas_comissoes: null, servicos_promocoes: null, taxas_entregadores: null, ajustes_contra_loja: null },
      { data_lancamento: "2026-08-03", situacao: "parcial", valor_vendas_ifood: 7000, taxas_comissoes: null, servicos_promocoes: null, taxas_entregadores: null, ajustes_contra_loja: null },
    ];
    const r = listaSnapshotsFinanceiros(dias3, linhas);
    assert.equal(r[0].valor, 4000);
    assert.equal(r[2].valor, 7000);
    assert.equal(r[2].delta, 3000); // 7000 - 4000 — o dia parcial soma na série
  });
});

// ---------------------------------------------------------------------------
// listaDesempenhoDiario — Desempenho virou ACUMULADO do mês, mesma lógica
// do Financeiro (pedido: "pra tanto o desempenho e o financeiro terem a
// mesma lógica"). O delta ("quanto aquele dia fez sozinho") é sempre
// derivado, nunca a fonte.
// ---------------------------------------------------------------------------
describe("listaDesempenhoDiario", () => {
  const dias4 = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"];

  test("dia 1 do mês: delta = o próprio acumulado (não existe dia 0 pra subtrair)", () => {
    const linhas = [{ data_lancamento: "2026-08-01", qtd_vendas: 10, valor_vendas_bruto: 2000, novos_clientes: 3 }];
    const r = listaDesempenhoDiario(dias4, linhas);
    assert.equal(r[0].valorVendasBruto, 2000);
    assert.equal(r[0].deltaValorVendasBruto, 2000);
    assert.equal(r[0].deltaQtdVendas, 10);
    assert.equal(r[0].deltaNovosClientes, 3);
  });

  test("dias consecutivos acumulados: delta é a diferença (exemplo do pedido: 2000 -> 2500, delta do dia 2 = 500)", () => {
    const linhas = [
      { data_lancamento: "2026-08-01", qtd_vendas: 10, valor_vendas_bruto: 2000, novos_clientes: 3 },
      { data_lancamento: "2026-08-02", qtd_vendas: 13, valor_vendas_bruto: 2500, novos_clientes: 5 },
    ];
    const r = listaDesempenhoDiario(dias4, linhas);
    assert.equal(r[1].valorVendasBruto, 2500);
    assert.equal(r[1].deltaValorVendasBruto, 500);
    assert.equal(r[1].deltaQtdVendas, 3);
    assert.equal(r[1].deltaNovosClientes, 2);
  });

  test("buraco no meio (dia sem dado): o próximo dia com dado calcula o delta contra o ÚLTIMO acumulado conhecido, pulando o buraco", () => {
    const linhas = [
      { data_lancamento: "2026-08-01", qtd_vendas: 10, valor_vendas_bruto: 2000, novos_clientes: 3 },
      // dia 02 sem lançamento nenhum
      { data_lancamento: "2026-08-03", qtd_vendas: 15, valor_vendas_bruto: 3200, novos_clientes: 4 },
    ];
    const r = listaDesempenhoDiario(dias4, linhas);
    assert.equal(r[1].valorVendasBruto, null); // dia 02: sem dado
    assert.equal(r[1].deltaValorVendasBruto, null);
    assert.equal(r[2].deltaValorVendasBruto, 1200); // 3200 - 2000, não 3200 - null
  });

  test("primeiro dia com dado NÃO é o dia 1 do mês: delta desse primeiro ponto é null (não dá pra saber quanto foi antes)", () => {
    const linhas = [{ data_lancamento: "2026-08-03", qtd_vendas: 20, valor_vendas_bruto: 5000, novos_clientes: 6 }];
    const r = listaDesempenhoDiario(dias4, linhas);
    assert.equal(r[2].valorVendasBruto, 5000);
    assert.equal(r[2].deltaValorVendasBruto, null);
  });

  test("ignora fatia de distribuição mensal (não é acumulado real)", () => {
    const linhas = dias4.map((d) => ({ data_lancamento: d, qtd_vendas: 5, valor_vendas_bruto: 1000, novos_clientes: 1, origem_lancamento: "distribuicao_mensal" }));
    const r = listaDesempenhoDiario(dias4, linhas);
    assert.ok(r.every((p) => p.valorVendasBruto === null && p.deltaValorVendasBruto === null));
  });
});

// ---------------------------------------------------------------------------
// ultimoDesempenhoConhecido — usado por "Sem operação"/"Zero vendas" pra
// REPETIR o acumulado do dia anterior em vez de zerar a série (decisão do
// pedido: gravar 0 literal quebraria o delta do dia seguinte).
// ---------------------------------------------------------------------------
describe("ultimoDesempenhoConhecido", () => {
  test("sem nenhum dia anterior no mês: {0,0,0} — o acumulado começa do zero mesmo", () => {
    const r = ultimoDesempenhoConhecido([], "2026-08-05");
    assert.deepEqual(r, { qtdVendas: 0, valorVendasBruto: 0, novosClientes: 0 });
  });

  test("pega o mais recente conhecido de cada campo — inclusive de dias diferentes, se um campo ficou null em algum meio-tempo", () => {
    const linhas = [
      { data_lancamento: "2026-08-01", qtd_vendas: 10, valor_vendas_bruto: 2000, novos_clientes: 3 },
      { data_lancamento: "2026-08-02", qtd_vendas: null, valor_vendas_bruto: 2500, novos_clientes: null }, // só valor informado
    ];
    const r = ultimoDesempenhoConhecido(linhas, "2026-08-03");
    assert.deepEqual(r, { qtdVendas: 10, valorVendasBruto: 2500, novosClientes: 3 }); // qtd/novosClientes "herdam" do dia 01
  });

  test("nunca cruza a fronteira do mês — Desempenho reseta todo mês, igual o Financeiro", () => {
    const linhas = [{ data_lancamento: "2026-07-31", qtd_vendas: 99, valor_vendas_bruto: 88888, novos_clientes: 20 }];
    const r = ultimoDesempenhoConhecido(linhas, "2026-08-01");
    assert.deepEqual(r, { qtdVendas: 0, valorVendasBruto: 0, novosClientes: 0 });
  });

  test("ignora fatia de distribuição mensal", () => {
    const linhas = [{ data_lancamento: "2026-08-01", qtd_vendas: 5, valor_vendas_bruto: 1000, novos_clientes: 1, origem_lancamento: "distribuicao_mensal" }];
    const r = ultimoDesempenhoConhecido(linhas, "2026-08-05");
    assert.deepEqual(r, { qtdVendas: 0, valorVendasBruto: 0, novosClientes: 0 });
  });
});

// ---------------------------------------------------------------------------
describe("inconsistências (avisos, não bloqueiam sozinhas)", () => {
  test("vendas com valor mas quantidade zero gera aviso", () => {
    const avisos = inconsistencias({ qtdVendas: 0, valorVendasBruto: 100, valorVendasIfood: 100, totalDed: 20 });
    assert.ok(avisos.some((a) => /quantidade/i.test(a)));
  });
  test("deduções maiores que as vendas geram aviso", () => {
    const avisos = inconsistencias({ qtdVendas: 10, valorVendasBruto: 100, valorVendasIfood: 100, totalDed: 150 });
    assert.ok(avisos.some((a) => /ultrapassa/i.test(a)));
  });
  test("dados consistentes não geram aviso", () => {
    assert.deepEqual(inconsistencias({ qtdVendas: 10, valorVendasBruto: 500, valorVendasIfood: 500, totalDed: 100 }), []);
  });
});

// Diagnóstico executivo e recomendações viraram o motor novo em
// dashboardExecutivo.diagnostico.js (rodada 2 do Dashboard iFood) — testes
// em backend/test/dashboard-executivo-diagnostico.test.js.

// ---------------------------------------------------------------------------
// Modelo logístico do iFood (Marketplace x Full Service) — briefing novo:
// cada modelo tem seu próprio conjunto de metas, e "taxas de entregadores"
// (motoboy próprio) não existe no Full Service (quem entrega é o parceiro
// do iFood).
// ---------------------------------------------------------------------------
describe("modelo logístico — indicadores aplicáveis por modelo", () => {
  test("MODELOS_LOGISTICOS tem exatamente marketplace e full_service", () => {
    assert.deepEqual([...MODELOS_LOGISTICOS].sort(), ["full_service", "marketplace"]);
  });
  test("rótulos em pt-BR existem para os dois modelos", () => {
    assert.equal(ROTULO_MODELO.marketplace, "Marketplace");
    assert.equal(ROTULO_MODELO.full_service, "Full Service");
  });
  test("Marketplace tem os 4 indicadores, incluindo taxas de entregadores", () => {
    assert.deepEqual([...INDICADORES_POR_MODELO.marketplace].sort(), ["servicos_promocoes", "taxas_comissoes", "taxas_entregadores", "total_deducoes"]);
    assert.equal(indicadorAplicavel("marketplace", "taxas_entregadores"), true);
  });
  test("Full Service NÃO tem taxas de entregadores (quem entrega é o parceiro do iFood)", () => {
    assert.deepEqual([...INDICADORES_POR_MODELO.full_service].sort(), ["servicos_promocoes", "taxas_comissoes", "total_deducoes"]);
    assert.equal(indicadorAplicavel("full_service", "taxas_entregadores"), false);
  });
  test("os demais 3 indicadores são aplicáveis nos dois modelos", () => {
    for (const modelo of MODELOS_LOGISTICOS) {
      for (const chave of ["taxas_comissoes", "servicos_promocoes", "total_deducoes"]) {
        assert.equal(indicadorAplicavel(modelo, chave), true, `${chave} deveria ser aplicável em ${modelo}`);
      }
    }
  });
});

// (o respeito ao modelo logístico no diagnóstico agora é testado no motor
// novo — dashboard-executivo-diagnostico.test.js)

// ---------------------------------------------------------------------------
// Total de Deduções (INDICADOR) — composição por modelo, fonte única
// (calc.js#totalDeducoesIndicador). Bug corrigido: o Total vinha de uma soma
// financeira crua que incluía Taxas de Entregadores mesmo no Full Service
// (onde "não se aplica") e os ajustes contra a loja — inflando o percentual.
// ---------------------------------------------------------------------------
describe("totalDeducoesIndicador — só as parcelas aplicáveis ao modelo", () => {
  test("componentes: Marketplace tem entregadores; Full Service não", () => {
    assert.deepEqual(componentesTotalDeducoes("marketplace"), ["taxas_comissoes", "servicos_promocoes", "taxas_entregadores"]);
    assert.deepEqual(componentesTotalDeducoes("full_service"), ["taxas_comissoes", "servicos_promocoes"]);
    assert.deepEqual(COMPONENTES_TOTAL_DEDUCOES, ["taxas_comissoes", "servicos_promocoes", "taxas_entregadores"]);
  });

  test("Marketplace: taxas + serviços + entregadores", () => {
    const v = { taxas_comissoes: 100, servicos_promocoes: 40, taxas_entregadores: 30 };
    assert.equal(totalDeducoesIndicador("marketplace", v), 170);
  });

  test("Full Service: entregadores é IGNORADO mesmo se vier um valor no snapshot", () => {
    const v = { taxas_comissoes: 2023, servicos_promocoes: 868, taxas_entregadores: 313 };
    assert.equal(totalDeducoesIndicador("full_service", v), 2891);          // NÃO 3204
    assert.equal(totalDeducoesIndicador("marketplace", v), 3204);
  });

  test("caso reportado em p.p.: 20,23 + 8,68 = 28,91 (entregadores 3,13 fora)", () => {
    const emPp = { taxas_comissoes: 20.23, servicos_promocoes: 8.68, taxas_entregadores: 3.13 };
    assert.ok(perto(totalDeducoesIndicador("full_service", emPp), 28.91));
    assert.ok(perto(totalDeducoesIndicador("marketplace", emPp), 32.04));
  });

  test("nunca soma ajustes contra a loja (não é parcela de indicador)", () => {
    const v = { taxas_comissoes: 100, servicos_promocoes: 40, taxas_entregadores: 30, ajustes_contra_loja: 999 };
    assert.equal(totalDeducoesIndicador("marketplace", v), 170);
    assert.equal(totalDeducoesIndicador("full_service", v), 140);
  });

  test("uma parcela zero entra normalmente; total reflete só as demais", () => {
    assert.equal(totalDeducoesIndicador("full_service", { taxas_comissoes: 100, servicos_promocoes: 0 }), 100);
    assert.equal(totalDeducoesIndicador("marketplace", { taxas_comissoes: 100, servicos_promocoes: 40, taxas_entregadores: 0 }), 140);
  });

  test("nenhuma parcela aplicável informada -> null (nunca 0, que fingiria 'dentro da meta')", () => {
    assert.equal(totalDeducoesIndicador("full_service", { taxas_comissoes: null, servicos_promocoes: null, taxas_entregadores: 500 }), null);
    assert.equal(totalDeducoesIndicador("marketplace", {}), null);
  });

  test("parcial: soma só as conhecidas (melhor esforço, igual a totalDeducoes)", () => {
    assert.equal(totalDeducoesIndicador("full_service", { taxas_comissoes: 100, servicos_promocoes: null }), 100);
  });

  test("alterar Serviços e Promoções reflete direto no Total (recalculado, nunca cacheado)", () => {
    const base = { taxas_comissoes: 20.23, taxas_entregadores: 3.13 };
    assert.ok(perto(totalDeducoesIndicador("full_service", { ...base, servicos_promocoes: 8.68 }), 28.91));
    assert.ok(perto(totalDeducoesIndicador("full_service", { ...base, servicos_promocoes: 10.00 }), 30.23));
    assert.ok(perto(totalDeducoesIndicador("full_service", { ...base, servicos_promocoes: 0 }), 20.23));
  });
});

// ---------------------------------------------------------------------------
// Desempenho opcional / "não informado" ≠ "zero" (rodada 2 do Dashboard iFood)
// ---------------------------------------------------------------------------
describe("ticket médio — nenhum dos dois lados vira 0 por conta própria", () => {
  test("valor bruto ausente, quantidade presente -> null (não R$ 0,00)", () => {
    assert.equal(ticketMedio(null, 50), null);
    assert.equal(ticketMedio(undefined, 50), null);
  });
  test("os dois presentes calcula normalmente", () => {
    assert.ok(perto(ticketMedio(1000, 10), 100));
  });
});

describe("totalDeducoes / percentual — null quando não há dado, nunca inventa 0", () => {
  test("as 4 parcelas ausentes -> total null (não 0)", () => {
    assert.equal(totalDeducoes({ taxasComissoes: null, servicosPromocoes: null, taxasEntregadores: null, ajustesContraLoja: null }), null);
  });
  test("algumas presentes -> soma só as conhecidas (melhor esforço)", () => {
    assert.equal(totalDeducoes({ taxasComissoes: 100, servicosPromocoes: null, taxasEntregadores: null, ajustesContraLoja: null }), 100);
  });
  test("percentual(null, base) -> null, nunca 0%", () => {
    assert.equal(percentual(null, 1000), null);
  });
  test("receitaLiquida com total null -> null (não finge deduções = 0)", () => {
    assert.equal(receitaLiquida(1000, null), null);
  });
});

describe("statusIndicador — fonte única de status (Caso G, H, I do pedido)", () => {
  const meta = { metaIdeal: 20, limite: 20.5 };
  test("Caso G: 18% com meta 20%/limite 20,5% -> dentro da meta", () => {
    assert.equal(statusIndicador(18, meta).chave, "dentro_da_meta");
  });
  test("Caso H: acima do limite -> fora da meta (card deve indicar o excesso)", () => {
    assert.equal(statusIndicador(25, meta).chave, "fora_da_meta");
  });
  test("entre meta ideal e limite -> atenção", () => {
    assert.equal(statusIndicador(20.2, meta).chave, "atencao");
  });
  test("Caso I: taxas não informadas (atual null) -> dados insuficientes, NUNCA 'dentro da meta'", () => {
    const s = statusIndicador(null, meta);
    assert.equal(s.chave, "sem_dados");
    assert.notEqual(s.label, "Dentro da meta");
  });
  test("sem meta configurada -> dados insuficientes", () => {
    assert.equal(statusIndicador(18, null).chave, "sem_dados");
  });
});

describe("saldoMeta — quanto ainda resta, em p.p. e em R$", () => {
  test("18,1% usado / limite 20% -> restam 1,9 p.p.", () => {
    const s = saldoMeta({ valorUtilizado: 6132.86, percentualUtilizado: 18.1, limitePct: 20, faturamentoBase: 33883.75 });
    assert.ok(perto(s.disponivelPp, 1.9, 0.01));
    assert.equal(s.status, "disponivel");
  });
  test("limite em reais e saldo em reais são calculados a partir do faturamento base", () => {
    const s = saldoMeta({ valorUtilizado: 5950, percentualUtilizado: 11.9, limitePct: 15, faturamentoBase: 50000 });
    assert.ok(perto(s.limiteReais, 7500));
    assert.ok(perto(s.disponivelReais, 1550));
  });
  test("valor utilizado igual ao limite -> limite atingido, saldo 0", () => {
    const s = saldoMeta({ valorUtilizado: 100, percentualUtilizado: 20, limitePct: 20, faturamentoBase: 500 });
    assert.equal(s.status, "limite_atingido");
    assert.equal(s.disponivelPp, 0);
  });
  test("acima do limite -> status acima_do_limite com saldo negativo", () => {
    const s = saldoMeta({ valorUtilizado: 130, percentualUtilizado: 26, limitePct: 20, faturamentoBase: 500 });
    assert.equal(s.status, "acima_do_limite");
    assert.ok(s.disponivelPp < 0);
  });
  test("sem percentual apurado -> sem_dados, nunca finge 'dentro da meta'", () => {
    const s = saldoMeta({ valorUtilizado: null, percentualUtilizado: null, limitePct: 20, faturamentoBase: 500 });
    assert.equal(s.status, "sem_dados");
    assert.equal(s.disponivelPp, null);
  });
});

describe("distribuirValorMensal — a soma NUNCA diverge de um centavo (Caso C do pedido)", () => {
  test("R$ 31.000,00 / 31 dias = R$ 1.000,00 por dia, exatos", () => {
    const fatias = distribuirValorMensal(31000, 31);
    assert.equal(fatias.length, 31);
    assert.ok(fatias.every((f) => f === 1000));
  });
  test("R$ 10.000,00 / 31 dias — soma exata, resto nos primeiros dias", () => {
    const fatias = distribuirValorMensal(10000, 31);
    assert.equal(fatias.length, 31);
    const soma = fatias.reduce((s, f) => s + f, 0);
    assert.ok(perto(soma, 10000, 1e-9), `soma foi ${soma}`);
    // 10000 / 31 = 322,58064... -> resto de 2 centavos vai pros 2 primeiros dias
    assert.ok(perto(fatias[0], 322.59));
    assert.ok(perto(fatias[1], 322.59));
    assert.ok(perto(fatias[2], 322.58));
  });
  test("valor que não divide exatamente em nenhum caso (R$ 100,01 / 3 dias)", () => {
    const fatias = distribuirValorMensal(100.01, 3);
    const soma = fatias.reduce((s, f) => s + f, 0);
    assert.ok(perto(soma, 100.01, 1e-9));
  });
  test("dias <= 0 devolve lista vazia (sem dividir por zero)", () => {
    assert.deepEqual(distribuirValorMensal(1000, 0), []);
  });
});

describe("distribuirQuantidadeMensal — mesma exatidão, para contagens inteiras", () => {
  test("100 pedidos / 31 dias — soma exata, resto nos primeiros dias", () => {
    const fatias = distribuirQuantidadeMensal(100, 31);
    assert.equal(fatias.length, 31);
    assert.equal(fatias.reduce((s, f) => s + f, 0), 100);
    assert.ok(fatias.every((f) => Number.isInteger(f)));
    // 100 / 31 = 3 resto 7 -> 7 primeiros dias com 4, os outros 24 com 3
    assert.equal(fatias.slice(0, 7).every((f) => f === 4), true);
    assert.equal(fatias.slice(7).every((f) => f === 3), true);
  });
  test("dias <= 0 devolve lista vazia", () => {
    assert.deepEqual(distribuirQuantidadeMensal(50, 0), []);
  });
});

// ---------------------------------------------------------------------------
// recalcularDistribuicaoMensal — regra de edição do lançamento mensal
// (item 2/3 do pedido de melhoria do fluxo). Casos A, B e E do pedido.
// ---------------------------------------------------------------------------
describe("recalcularDistribuicaoMensal — edição parcial do lançamento mensal", () => {
  const EXTRAS_VAZIOS = {
    qtdVendasTotal: null, valorVendasBrutoTotal: null, novosClientesTotal: null, taxasComissoesTotal: null,
    servicosPromocoesTotal: null, taxasEntregadoresTotal: null,
    ajustesFavorLojaTotal: null, ajustesContraLojaTotal: null,
  };

  test("Caso A — só informar taxas depois: faturamento permanece, taxas são adicionadas", () => {
    const r = recalcularDistribuicaoMensal({
      valorAtual: 80000, extrasAtuais: EXTRAS_VAZIOS,
      patch: { extras: { taxasComissoesTotal: 12000 } }, // valorTotalMensal ausente do patch = não editado
      quantidadeDias: 31,
    });
    assert.equal(r.valorTotalMensal, 80000);
    assert.equal(r.extras.taxasComissoesTotal, 12000);
    // Os outros extras continuam null — não viraram 0 só porque um irmão foi preenchido.
    assert.equal(r.extras.servicosPromocoesTotal, null);
    assert.equal(r.extras.qtdVendasTotal, null);
    assert.ok(perto(r.fatiasPorCampo.valorVendasIfood.reduce((s, f) => s + f, 0), 80000, 1e-9));
    assert.ok(perto(r.fatiasPorCampo.taxasComissoesTotal.reduce((s, f) => s + f, 0), 12000, 1e-9));
    assert.equal(r.fatiasPorCampo.servicosPromocoesTotal, null);
  });

  test("Caso B — alterar faturamento de R$80.000 para R$85.000: dias recalculados somam exatamente R$85.000", () => {
    const r = recalcularDistribuicaoMensal({
      valorAtual: 80000, extrasAtuais: EXTRAS_VAZIOS,
      patch: { valorTotalMensal: 85000 },
      quantidadeDias: 31,
    });
    assert.equal(r.valorTotalMensal, 85000);
    assert.equal(r.fatiasPorCampo.valorVendasIfood.length, 31);
    const soma = r.fatiasPorCampo.valorVendasIfood.reduce((s, f) => s + f, 0);
    assert.ok(perto(soma, 85000, 1e-9), `soma foi ${soma}`);
  });

  test("Caso E — campo nunca informado (ausente do patch e já null): continua null, nunca vira zero", () => {
    const r = recalcularDistribuicaoMensal({
      valorAtual: 80000, extrasAtuais: EXTRAS_VAZIOS,
      patch: { valorTotalMensal: 82000 }, // muda só o faturamento
      quantidadeDias: 28,
    });
    assert.equal(r.extras.ajustesContraLojaTotal, null);
    assert.equal(r.fatiasPorCampo.ajustesContraLojaTotal, null);
  });

  test("edição não mexe em campos com valor previamente salvo que não vieram no patch", () => {
    const extrasAtuais = { ...EXTRAS_VAZIOS, taxasComissoesTotal: 12000, servicosPromocoesTotal: 3000 };
    const r = recalcularDistribuicaoMensal({
      valorAtual: 85000, extrasAtuais,
      patch: { extras: { servicosPromocoesTotal: 3500 } }, // só mexe num dos dois
      quantidadeDias: 31,
    });
    assert.equal(r.extras.taxasComissoesTotal, 12000); // preservado
    assert.equal(r.extras.servicosPromocoesTotal, 3500); // atualizado
    assert.ok(perto(r.fatiasPorCampo.taxasComissoesTotal.reduce((s, f) => s + f, 0), 12000, 1e-9));
    assert.ok(perto(r.fatiasPorCampo.servicosPromocoesTotal.reduce((s, f) => s + f, 0), 3500, 1e-9));
  });

  test("limpar um extra explicitamente (patch com null) zera o total, não distribui mais nada", () => {
    const extrasAtuais = { ...EXTRAS_VAZIOS, ajustesContraLojaTotal: 500 };
    const r = recalcularDistribuicaoMensal({
      valorAtual: 80000, extrasAtuais,
      patch: { extras: { ajustesContraLojaTotal: null } },
      quantidadeDias: 30,
    });
    assert.equal(r.extras.ajustesContraLojaTotal, null);
    assert.equal(r.fatiasPorCampo.ajustesContraLojaTotal, null);
  });

  test("distribuição mensal — só ajuste a favor: distribui em ajustesFavorLojaTotal, contra fica null", () => {
    const r = recalcularDistribuicaoMensal({
      valorAtual: 60000, extrasAtuais: EXTRAS_VAZIOS,
      patch: { extras: { ajustesFavorLojaTotal: 90 } },
      quantidadeDias: 30,
    });
    assert.ok(perto(r.fatiasPorCampo.ajustesFavorLojaTotal.reduce((s, f) => s + f, 0), 90, 1e-9));
    assert.equal(r.fatiasPorCampo.ajustesContraLojaTotal, null);
  });

  test("distribuição mensal — só ajuste contra: distribui em ajustesContraLojaTotal, a favor fica null", () => {
    const r = recalcularDistribuicaoMensal({
      valorAtual: 60000, extrasAtuais: EXTRAS_VAZIOS,
      patch: { extras: { ajustesContraLojaTotal: 45 } },
      quantidadeDias: 30,
    });
    assert.ok(perto(r.fatiasPorCampo.ajustesContraLojaTotal.reduce((s, f) => s + f, 0), 45, 1e-9));
    assert.equal(r.fatiasPorCampo.ajustesFavorLojaTotal, null);
  });

  test("distribuição mensal — ambos os ajustes: cada um distribuído no seu campo, soma exata", () => {
    const r = recalcularDistribuicaoMensal({
      valorAtual: 60000, extrasAtuais: EXTRAS_VAZIOS,
      patch: { extras: { ajustesFavorLojaTotal: 30, ajustesContraLojaTotal: 12 } },
      quantidadeDias: 28,
    });
    assert.ok(perto(r.fatiasPorCampo.ajustesFavorLojaTotal.reduce((s, f) => s + f, 0), 30, 1e-9));
    assert.ok(perto(r.fatiasPorCampo.ajustesContraLojaTotal.reduce((s, f) => s + f, 0), 12, 1e-9));
  });

  test("distribuição mensal — mês sem ajustes: os dois campos ficam null", () => {
    const r = recalcularDistribuicaoMensal({
      valorAtual: 60000, extrasAtuais: EXTRAS_VAZIOS,
      patch: { valorTotalMensal: 61000 },
      quantidadeDias: 30,
    });
    assert.equal(r.fatiasPorCampo.ajustesFavorLojaTotal, null);
    assert.equal(r.fatiasPorCampo.ajustesContraLojaTotal, null);
  });

  test("distribuição mensal — edição de mês histórico: só o ajuste editado muda, o outro é preservado", () => {
    const extrasAtuais = { ...EXTRAS_VAZIOS, ajustesFavorLojaTotal: 30, ajustesContraLojaTotal: 12 };
    const r = recalcularDistribuicaoMensal({
      valorAtual: 60000, extrasAtuais,
      patch: { extras: { ajustesContraLojaTotal: 20 } },
      quantidadeDias: 28,
    });
    assert.equal(r.extras.ajustesFavorLojaTotal, 30); // preservado
    assert.equal(r.extras.ajustesContraLojaTotal, 20); // atualizado
    assert.ok(perto(r.fatiasPorCampo.ajustesFavorLojaTotal.reduce((s, f) => s + f, 0), 30, 1e-9));
    assert.ok(perto(r.fatiasPorCampo.ajustesContraLojaTotal.reduce((s, f) => s + f, 0), 20, 1e-9));
  });

  test("contagens inteiras (pedidos/clientes) usam distribuirQuantidadeMensal, não centavos", () => {
    const r = recalcularDistribuicaoMensal({
      valorAtual: 80000, extrasAtuais: EXTRAS_VAZIOS,
      patch: { extras: { qtdVendasTotal: 100 } },
      quantidadeDias: 31,
    });
    assert.ok(r.fatiasPorCampo.qtdVendasTotal.every((f) => Number.isInteger(f)));
    assert.equal(r.fatiasPorCampo.qtdVendasTotal.reduce((s, f) => s + f, 0), 100);
  });

  // Item novo do pedido "Lançamento Mensal completo": valor bruto de vendas
  // (Desempenho) é um total INDEPENDENTE do Financeiro — nunca reaproveita a
  // fatia de valorVendasIfood. Usa distribuirValorMensal (centavo exato),
  // igual aos outros campos em R$, nunca a distribuição inteira.
  test("valorVendasBrutoTotal (Desempenho) distribui em centavos, independente do faturamento (Financeiro)", () => {
    const r = recalcularDistribuicaoMensal({
      valorAtual: 80000, extrasAtuais: EXTRAS_VAZIOS,
      patch: { extras: { valorVendasBrutoTotal: 45678.9 } },
      quantidadeDias: 31,
    });
    assert.equal(r.extras.valorVendasBrutoTotal, 45678.9);
    assert.ok(perto(r.fatiasPorCampo.valorVendasBrutoTotal.reduce((s, f) => s + f, 0), 45678.9, 1e-9));
    // Não é a mesma fatia do faturamento (valorVendasIfood) — são séries independentes.
    assert.notDeepEqual(r.fatiasPorCampo.valorVendasBrutoTotal, r.fatiasPorCampo.valorVendasIfood);
  });

  test("sem valorVendasBrutoTotal informado, fica null (nunca reaproveita a fatia do faturamento)", () => {
    const r = recalcularDistribuicaoMensal({
      valorAtual: 80000, extrasAtuais: EXTRAS_VAZIOS,
      patch: { extras: { qtdVendasTotal: 100 } }, // só quantidade, sem valor bruto
      quantidadeDias: 31,
    });
    assert.equal(r.extras.valorVendasBrutoTotal, null);
    assert.equal(r.fatiasPorCampo.valorVendasBrutoTotal, null);
  });
});

describe("deltaFinanceiro", () => {
  test("subtrai o snapshot anterior do atual (dias consecutivos ambos preenchidos)", () => {
    assert.equal(deltaFinanceiro(14854, 13692), 1162);
  });
  test("null quando o valor atual não foi informado", () => {
    assert.equal(deltaFinanceiro(null, 13692), null);
  });
  test("null quando o valor anterior não foi informado (dia anterior sem Financeiro)", () => {
    assert.equal(deltaFinanceiro(14854, null), null);
  });
  test("null quando os dois estão ausentes", () => {
    assert.equal(deltaFinanceiro(null, null), null);
  });
  test("aceita delta negativo (correção/estorno reduziu o acumulado)", () => {
    assert.equal(deltaFinanceiro(100, 150), -50);
  });
});
