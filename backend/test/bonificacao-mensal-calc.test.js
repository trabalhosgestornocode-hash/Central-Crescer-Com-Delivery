// Testes D, E, G, K do item 76 — camada de cálculo pura da Bonificação
// Mensal (bonificacaoMensal.calc.js). Sem rede.
// Rodar: node --test test/bonificacao-mensal-calc.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  percentualDerivado, mixDoDia, validarPercentualCruzado, detectarInversaoRelatorios,
  faturamentoAcumulado, mixMensalPonderado, ticketMedioPonderado, mediaDiaria, somaValida, projecaoFaturamento,
  ritmoNecessario, participacaoLoja, mesmaUnidadeVisio, statusDia, STATUS_DIA_BONIFICACAO, diasDoMes,
  resumoAlimentacaoMes,
} from "../src/modules/bonificacao-mensal/bonificacaoMensal.calc.js";

const perto = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
describe("percentualDerivado — null ≠ 0 (item 22)", () => {
  test("calcula normalmente", () => assert.ok(perto(percentualDerivado(56, 132), 42.424242, 1e-4)));
  test("valor null -> null, nunca 0", () => assert.equal(percentualDerivado(null, 132), null));
  test("base 0 ou null -> null", () => {
    assert.equal(percentualDerivado(5, 0), null);
    assert.equal(percentualDerivado(5, null), null);
  });
});

// ---------------------------------------------------------------------------
describe("Teste D — detecção de PDFs invertidos", () => {
  const geral = { faturamento: 9845.09, ppd: 168, sandwichesSalads: 307, beverages: 85, additions: 51, miscellaneous: 34 };
  const loja = { faturamento: 3893.15, ppd: 73, sandwichesSalads: 132, beverages: 56, additions: 38, miscellaneous: 19 };

  test("relatórios consistentes (Geral >= Loja) não disparam alerta", () => {
    const r = detectarInversaoRelatorios(geral, loja);
    assert.equal(r.invertido, false);
    assert.deepEqual(r.violacoes, []);
  });

  test("relatórios invertidos (Loja > Geral) são detectados", () => {
    const r = detectarInversaoRelatorios(loja, geral); // passa loja como se fosse "geral"
    assert.equal(r.invertido, true);
    assert.ok(r.violacoes.some((v) => v.campo === "faturamento"));
    assert.ok(r.violacoes.some((v) => v.campo === "ppd"));
  });

  test("não exige igualdade, só Geral >= Loja (item 68)", () => {
    const r = detectarInversaoRelatorios(geral, geral); // valores iguais nos dois
    assert.equal(r.invertido, false);
  });
});

// ---------------------------------------------------------------------------
describe("Teste E — validação de unidade (item 16, CRÍTICA)", () => {
  test("nomes com token distintivo em comum batem (sistema e Visio nunca são idênticos)", () => {
    assert.equal(mesmaUnidadeVisio("Subway Saci — Matriz", "Subway Teresina Saci"), true);
  });
  test("unidades genuinamente diferentes são recusadas", () => {
    assert.equal(mesmaUnidadeVisio("Subway Saci — Matriz", "Subway North Shopping"), false);
    assert.equal(mesmaUnidadeVisio("Loja Florianópolis-SC 1", "Subway Teresina Saci"), false);
  });
  test("sem nome suficiente para comparar -> null (não bloqueia nem confirma sozinho)", () => {
    assert.equal(mesmaUnidadeVisio(null, "Subway Teresina Saci"), null);
    assert.equal(mesmaUnidadeVisio("Subway Saci — Matriz", null), null);
  });
});

// ---------------------------------------------------------------------------
describe("Teste G — dados ausentes nunca viram zero", () => {
  test("faturamentoAcumulado sem nenhum lançamento válido -> null, não 0", () => {
    assert.equal(faturamentoAcumulado([{ faturamentoGeral: null }, { faturamentoGeral: null }]), null);
  });
  test("mediaDiaria ignora nulls, não os trata como 0", () => {
    assert.ok(perto(mediaDiaria([10, null, 20, undefined]), 15));
    assert.equal(mediaDiaria([null, null]), null);
  });
  test("somaValida (Pesquisas/NPS) ignora nulls e soma só o que foi informado", () => {
    assert.equal(somaValida([5, null, 10]), 15);
    assert.equal(somaValida([null, undefined]), null);
  });
  test("statusDia: dia sem lançamento no passado é PENDENTE, não fica com valores zerados", () => {
    assert.equal(statusDia({ lancamento: null, dataIso: "2026-08-05", hojeIso: "2026-08-10" }), STATUS_DIA_BONIFICACAO.PENDENTE);
  });
  test("statusDia: dia futuro é FUTURO mesmo sem lançamento", () => {
    assert.equal(statusDia({ lancamento: null, dataIso: "2026-08-15", hojeIso: "2026-08-10" }), STATUS_DIA_BONIFICACAO.FUTURO);
  });
  test("statusDia: sem_operacao é status próprio, não vira PENDENTE nem 0", () => {
    assert.equal(statusDia({ lancamento: { semOperacao: true }, dataIso: "2026-08-05", hojeIso: "2026-08-10" }), STATUS_DIA_BONIFICACAO.SEM_OPERACAO);
  });
});

// ---------------------------------------------------------------------------
// Auditoria 15/08/2026 — o Relatório de Vendas (novo Geral) não traz mais
// PPD. Bug real corrigido: statusDia() exigia ppdGeral pra considerar o dia
// "com Geral", o que deixaria TODO dia importado depois da troca preso em
// PARCIAL/PENDENTE pra sempre.
// ---------------------------------------------------------------------------
describe("statusDia sem PPD — Relatório de Vendas não traz mais esse campo", () => {
  const lojaCompleta = { faturamentoLoja: 3893.15, qtdSanduichesLoja: 132, qtdBebidasLoja: 56, qtdAdicionaisLoja: 38, qtdDiversosLoja: 19 };

  test("Geral com faturamento mas SEM ppdGeral ainda conta como IMPORTADO (com Loja completo)", () => {
    const lancamento = { faturamentoGeral: 10655.71, ppdGeral: null, origem: "visio", manualOverride: {}, ...lojaCompleta };
    assert.equal(statusDia({ lancamento, dataIso: "2026-08-05", hojeIso: "2026-08-10" }), STATUS_DIA_BONIFICACAO.IMPORTADO);
  });

  test("Geral com ppdGeral (relatório antigo, dado legado) continua funcionando do mesmo jeito", () => {
    const lancamento = { faturamentoGeral: 9845.09, ppdGeral: 168, origem: "visio", manualOverride: {}, ...lojaCompleta };
    assert.equal(statusDia({ lancamento, dataIso: "2026-08-05", hojeIso: "2026-08-10" }), STATUS_DIA_BONIFICACAO.IMPORTADO);
  });

  test("sem faturamentoGeral nenhum -> ainda PARCIAL (só Loja), nunca IMPORTADO por engano", () => {
    const lancamento = { faturamentoGeral: null, ppdGeral: null, origem: "visio", manualOverride: {}, ...lojaCompleta };
    assert.equal(statusDia({ lancamento, dataIso: "2026-08-05", hojeIso: "2026-08-10" }), STATUS_DIA_BONIFICACAO.PARCIAL);
  });
});

// ---------------------------------------------------------------------------
// Bug relatado 15/08/2026: dia com Geral+Loja 100% vindos da Visio aparecia
// como MANUAL no calendário só porque o dia tinha um override em REV (ou um
// Ticket Médio manual de antes da automação, salvo com chave camelCase) —
// campos com aba própria, sem nenhuma relação com a importação da Visio.
// ---------------------------------------------------------------------------
describe("statusDia — override manual em indicador de OUTRA aba não deve tirar o dia de IMPORTADO", () => {
  const diaCompleto = {
    faturamentoGeral: 10655.71, ppdGeral: null,
    faturamentoLoja: 3893.15, qtdSanduichesLoja: 132, qtdBebidasLoja: 56, qtdAdicionaisLoja: 38, qtdDiversosLoja: 19,
    origem: "visio",
  };

  test("override só em REV (aba própria) -> continua IMPORTADO, não MANUAL", () => {
    const lancamento = { ...diaCompleto, manualOverride: { revNota: true } };
    assert.equal(statusDia({ lancamento, dataIso: "2026-08-05", hojeIso: "2026-08-10" }), STATUS_DIA_BONIFICACAO.IMPORTADO);
  });

  test("override em Cancelamentos/Pesquisas/Nota iFood/Chamados -> também continua IMPORTADO", () => {
    for (const chave of ["cancelamentosPct", "pesquisasQtd", "avaliacaoIfood", "pedidosChamadoPct", "cmvPct"]) {
      const lancamento = { ...diaCompleto, manualOverride: { [chave]: true } };
      assert.equal(statusDia({ lancamento, dataIso: "2026-08-05", hojeIso: "2026-08-10" }), STATUS_DIA_BONIFICACAO.IMPORTADO, `falhou para ${chave}`);
    }
  });

  test("override de Ticket Médio em chave camelCase legada (de antes da automação) ainda marca MANUAL — é campo do Geral de verdade, não de outra aba", () => {
    const lancamento = { ...diaCompleto, manualOverride: { ticketMedio: true } };
    assert.equal(statusDia({ lancamento, dataIso: "2026-08-05", hojeIso: "2026-08-10" }), STATUS_DIA_BONIFICACAO.MANUAL);
  });

  test("override de verdade em campo do Geral (faturamento_geral) continua marcando MANUAL — não é regra frouxa demais", () => {
    const lancamento = { ...diaCompleto, manualOverride: { faturamento_geral: true } };
    assert.equal(statusDia({ lancamento, dataIso: "2026-08-05", hojeIso: "2026-08-10" }), STATUS_DIA_BONIFICACAO.MANUAL);
  });

  test("mistura: override em REV E em Loja -> MANUAL (o do Loja é que decide)", () => {
    const lancamento = { ...diaCompleto, manualOverride: { revNota: true, qtd_bebidas_loja: true } };
    assert.equal(statusDia({ lancamento, dataIso: "2026-08-05", hojeIso: "2026-08-10" }), STATUS_DIA_BONIFICACAO.MANUAL);
  });
});

// ---------------------------------------------------------------------------
describe("Teste K — mix mensal PONDERADO (item 44-45), nunca média simples", () => {
  test("exemplo do item 45: 10/5 (50%) + 100/20 (20%) = 22,7% real, não 35% (média simples)", () => {
    const lancamentos = [
      { qtdSanduichesLoja: 10, qtdBebidasLoja: 5, qtdAdicionaisLoja: 0, qtdDiversosLoja: 0 },
      { qtdSanduichesLoja: 100, qtdBebidasLoja: 20, qtdAdicionaisLoja: 0, qtdDiversosLoja: 0 },
    ];
    const r = mixMensalPonderado(lancamentos);
    assert.ok(perto(r.bebidas, 22.727272727, 1e-6));
    assert.notEqual(Math.round(r.bebidas), 35); // média simples daria 35% — tem que ser diferente
  });
  test("dias sem qtdSanduichesLoja (não informado) ficam de fora da soma", () => {
    const r = mixMensalPonderado([
      { qtdSanduichesLoja: 132, qtdBebidasLoja: 56, qtdAdicionaisLoja: 38, qtdDiversosLoja: 19 },
      { qtdSanduichesLoja: null, qtdBebidasLoja: null, qtdAdicionaisLoja: null, qtdDiversosLoja: null },
    ]);
    assert.equal(r.diasComDados, 1);
    assert.ok(perto(r.bebidas, 42.424242, 1e-4));
  });
  test("mês sem nenhum dado -> null, não 0", () => {
    const r = mixMensalPonderado([]);
    assert.equal(r.bebidas, null);
  });
});

// ---------------------------------------------------------------------------
// NOTA (arquitetura v3.1): `mixMensalOficial` e `resolverMixMensal` FORAM
// REMOVIDOS. Não existe mais "escolher entre oficial e diário" nem duas versões
// dos números. Quem decide qual resultado vale é bonificacao_competencia.status
// (obterMes): mês aberto/reaberto usa os dados atuais, mês fechado serve o
// snapshot. O mix oficial do mês fechado (dataset 2533/1086/613/508 → 42,9 /
// 24,2 / 20,1) é coberto em bonificacao-mensal-fechamento.test.js.

// ---------------------------------------------------------------------------
describe("ticketMedioPonderado (auditoria 15/08/2026) — faturamento ÷ cupons acumulados, nunca média simples", () => {
  test("dois dias com volumes bem diferentes: ponderado != média simples dos tickets diários", () => {
    // dia 1: R$1.000 / 50 cupons = R$20 de ticket · dia 2: R$100 / 2 cupons = R$50 de ticket
    // média simples dos tickets: (20+50)/2 = 35 — mas o dia 1 pesa MUITO mais no volume real
    const lancamentos = [
      { faturamentoGeral: 1000, cuponsValidosGeral: 50 },
      { faturamentoGeral: 100, cuponsValidosGeral: 2 },
    ];
    const r = ticketMedioPonderado(lancamentos);
    assert.ok(perto(r, 1100 / 52, 1e-6)); // ~21,15 — bem diferente de 35
    assert.notEqual(Math.round(r), 35);
  });

  test("dia com ticket lançado manualmente mas SEM cupons não entra na ponderação", () => {
    const lancamentos = [
      { faturamentoGeral: 10655.71, cuponsValidosGeral: 224 },
      { faturamentoGeral: null, cuponsValidosGeral: null, ticketMedio: 999 }, // ticket manual solto, sem cupons — não pode corromper o mês
    ];
    const r = ticketMedioPonderado(lancamentos);
    assert.ok(perto(r, 10655.71 / 224, 1e-6));
  });

  test("mês sem nenhum dado -> null, não 0", () => {
    assert.equal(ticketMedioPonderado([]), null);
    assert.equal(ticketMedioPonderado([{ faturamentoGeral: null, cuponsValidosGeral: null }]), null);
  });
});

// ---------------------------------------------------------------------------
describe("validação cruzada (item 11)", () => {
  test("diferença pequena não é divergência", () => {
    const r = validarPercentualCruzado(42.4, 42.42424, 1.5);
    assert.equal(r.divergente, false);
  });
  test("diferença grande é sinalizada", () => {
    const r = validarPercentualCruzado(42.4, 30, 1.5);
    assert.equal(r.divergente, true);
    assert.ok(r.diferenca > 1.5);
  });
});

// ---------------------------------------------------------------------------
describe("projeção de faturamento (itens 41-43)", () => {
  test("exclui dias sem_operacao e pendentes da média-base", () => {
    // agosto/2026: 31 dias. Dias 1-3 com faturamento, dia 4 sem_operacao, dia 5 pendente (sem lançamento), hoje = dia 5.
    const lancamentos = [
      { data: "2026-08-01", faturamentoGeral: 9000 },
      { data: "2026-08-02", faturamentoGeral: 10000 },
      { data: "2026-08-03", faturamentoGeral: 11000 },
      { data: "2026-08-04", faturamentoGeral: null, semOperacao: true },
    ];
    const r = projecaoFaturamento({ lancamentos, ano: 2026, mes: 8, hojeIso: "2026-08-05" });
    assert.equal(r.diasValidos, 3);
    assert.equal(r.diasSemOperacao, 1);
    assert.equal(r.diasPendentes, 1); // dia 5 (hoje, sem lançamento ainda)
    assert.ok(perto(r.acumulado, 30000));
    assert.ok(perto(r.mediaDiariaValida, 10000));
    assert.equal(r.diasRestantes, diasDoMes(2026, 8).length - 5); // dias após hoje
    assert.ok(perto(r.projecao, 30000 + 10000 * r.diasRestantes));
  });

  test("ritmoNecessario = faltante / dias restantes", () => {
    assert.ok(perto(ritmoNecessario(130200, 12), 10850));
    assert.equal(ritmoNecessario(null, 12), null);
    assert.equal(ritmoNecessario(100, 0), null);
  });
});

describe("participação do balcão (item 54) — só dado disponível, sem regra de meta", () => {
  test("calcula o percentual sem impor nenhuma faixa", () => {
    assert.ok(perto(participacaoLoja(3893.15, 9845.09), 39.54, 0.01));
  });
});

// ---------------------------------------------------------------------------
// resumoAlimentacaoMes — "quanto do mês está OFICIALMENTE alimentado".
// Competência fechada pelo lançamento mensal direto = 100%, sem calendário
// diário — NÃO interpreta ausência de lançamentos como "31 pendentes".
// ---------------------------------------------------------------------------
describe("resumoAlimentacaoMes — competência fechada x aberta", () => {
  const calPendente = Array.from({ length: 31 }, (_, i) => ({ data: `2026-08-${String(i + 1).padStart(2, "0")}`, status: "PENDENTE" }));

  test("1) aberta sem lançamentos -> dias pendentes normalmente (0% alimentado)", () => {
    const a = resumoAlimentacaoMes({ calendario: calPendente, congelado: false, origemResultado: "ao_vivo" });
    assert.equal(a.origem, "ao_vivo");
    assert.equal(a.mostrarCalendarioDiario, true);
    assert.equal(a.diasEsperados, 31);
    assert.equal(a.diasAlimentados, 0);
    assert.equal(a.pct, 0);
    assert.equal(a.contagem.PENDENTE, 31);
  });

  test("2/3) fechada por fechamento_mensal_direto -> 100%, SEM calendário diário", () => {
    const a = resumoAlimentacaoMes({ calendario: calPendente, congelado: true, origemResultado: "fechamento_mensal_direto" });
    assert.equal(a.origem, "fechamento_mensal_direto");
    assert.equal(a.pct, 100);
    assert.equal(a.mostrarCalendarioDiario, false);
    assert.match(a.rotulo, /lançamento mensal/i);
  });

  test("7) fechada por acompanhamento_diario -> 100%, calendário histórico preservado", () => {
    const cal = calPendente.map((d, i) => ({ ...d, status: i < 31 ? "IMPORTADO" : "PENDENTE" }));
    const a = resumoAlimentacaoMes({ calendario: cal, congelado: true, origemResultado: "acompanhamento_diario" });
    assert.equal(a.pct, 100);
    assert.equal(a.mostrarCalendarioDiario, true);
    assert.match(a.rotulo, /acompanhamento diário/i);
  });

  test("legado_pre_refatoracao -> 100%, calendário preservado", () => {
    const a = resumoAlimentacaoMes({ calendario: calPendente, congelado: true, origemResultado: "legado_pre_refatoracao" });
    assert.equal(a.pct, 100);
    assert.equal(a.mostrarCalendarioDiario, true);
  });

  test("8) aberta parcial -> pct proporcional aos dias reais, ignora FUTURO", () => {
    const cal = [
      ...Array.from({ length: 3 }, (_, i) => ({ data: `2026-08-0${i + 1}`, status: "IMPORTADO" })),
      { data: "2026-08-04", status: "SEM_OPERACAO" },
      { data: "2026-08-05", status: "PENDENTE" },
      ...Array.from({ length: 5 }, (_, i) => ({ data: `2026-08-1${i}`, status: "FUTURO" })),
    ];
    const a = resumoAlimentacaoMes({ calendario: cal, congelado: false, origemResultado: "ao_vivo" });
    assert.equal(a.diasEsperados, 5);          // 5 dias passados (FUTURO fora)
    assert.equal(a.diasAlimentados, 4);        // 3 IMPORTADO + 1 SEM_OPERACAO
    assert.equal(a.pct, 80);
  });
});
