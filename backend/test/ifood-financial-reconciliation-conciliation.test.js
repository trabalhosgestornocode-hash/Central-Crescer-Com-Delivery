// ifoodFinancial.reconciliation.js — Bloco H, conciliação consolidada. 100%
// PURO — sem rede, sem banco, sem I/O. Cobre a trilha Sales -> Financial
// Events -> Settlements -> Reconciliation -> Anticipation.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const {
  conciliarFinancial, conciliarSalesComEvents, conciliarEventsComSettlements,
  conciliarSettlementsComReconciliation, adaptarRegistrosReconciliation, resumirAnticipation,
  paraCentavos, centavosParaReais, somaCentavos, classificarComparacao, numeroDeTextoMonetario,
  STATUS_CONCILIACAO,
} = await import("../src/modules/ifood/ifoodFinancial.reconciliation.js");

// --- fixtures no formato JÁ NORMALIZADO pelos mappers existentes ----------
function venda(id, shortId, saldo, eventosEmbutidos = []) {
  return { id, shortId, criadoEm: "2025-01-02T10:00:00Z", resumoFinanceiro: { saldo, lancamentos: [] }, valorBruto: { total: saldo != null ? saldo + 10 : null }, eventos: eventosEmbutidos };
}
function eventoFinanceiro({ nome = "ORDER_PAYMENT", valor, temImpactoRepasse = true, saleId = "s1" }) {
  return { nome, descricao: nome, valor, tipoValor: valor == null ? null : valor >= 0 ? "credito" : "debito", temImpactoRepasse, referencia: { tipo: "ORDER", id: saleId, data: null } };
}
function settlements(saldo, titulos = []) {
  return { saldo, titulos, merchantsConsolidados: [] };
}
function titulo(valor) { return { id: "t1", tipo: "REPASSE", valor, status: "SUCCEED" }; }
function antecipacao({ valorOriginal, taxaValor, taxaPercentual = null, valorAntecipado, tipo = "REPASSE_ANTECIPADO_SEMANAL", status = "SUCCEED" }) {
  return { tipo, valorOriginal, valorAntecipado, taxa: { valor: taxaValor, percentual: taxaPercentual }, status, dataPagamentoOriginal: "2025-01-10", dataPagamentoAntecipado: "2025-01-03" };
}

// ===========================================================================
// Dinheiro seguro
// ===========================================================================
describe("dinheiro seguro (centavos)", () => {
  test("paraCentavos: 10.99 -> 1099", () => assert.equal(paraCentavos(10.99), 1099));
  test("paraCentavos: null/NaN/undefined -> null (não vira 0)", () => {
    assert.equal(paraCentavos(null), null);
    assert.equal(paraCentavos(undefined), null);
    assert.equal(paraCentavos(NaN), null);
  });
  test("paraCentavos: 0 -> 0 (zero é valor real, não ausência)", () => assert.equal(paraCentavos(0), 0));
  test("centavosParaReais: 1099 -> 10.99", () => assert.equal(centavosParaReais(1099), 10.99));
  test("somaCentavos ignora valores não numéricos sem derrubar a soma", () => {
    assert.equal(somaCentavos([10, null, 5, undefined, NaN]), 1500);
  });
  test("somaCentavos: arredondamento de ponto flutuante não acumula erro (0.1+0.2 clássico)", () => {
    assert.equal(somaCentavos([0.1, 0.2]), 30); // 30 centavos, não 29 ou 31
  });
});

describe("classificarComparacao — status central", () => {
  test("esperado null -> INCOMPLETO, nunca DIVERGENTE", () => {
    assert.equal(classificarComparacao(null, 1000).status, STATUS_CONCILIACAO.INCOMPLETO);
  });
  test("encontrado null -> INCOMPLETO", () => {
    assert.equal(classificarComparacao(1000, null).status, STATUS_CONCILIACAO.INCOMPLETO);
  });
  test("iguais -> CONCILIADO", () => {
    const r = classificarComparacao(1000, 1000);
    assert.equal(r.status, STATUS_CONCILIACAO.CONCILIADO);
    assert.equal(r.divergenciaCentavos, 0);
  });
  test("diferença de 1 centavo -> CONCILIADO (dentro da tolerância)", () => {
    assert.equal(classificarComparacao(1000, 1001).status, STATUS_CONCILIACAO.CONCILIADO);
  });
  test("diferença de 2 centavos -> DIVERGENTE (fora da tolerância)", () => {
    assert.equal(classificarComparacao(1000, 1002).status, STATUS_CONCILIACAO.DIVERGENTE);
  });
  test("zero vs zero -> CONCILIADO (zero é valor real, comparável)", () => {
    assert.equal(classificarComparacao(0, 0).status, STATUS_CONCILIACAO.CONCILIADO);
  });
  test("valores negativos comparados normalmente", () => {
    assert.equal(classificarComparacao(-1000, -1000).status, STATUS_CONCILIACAO.CONCILIADO);
    assert.equal(classificarComparacao(-1000, -500).status, STATUS_CONCILIACAO.DIVERGENTE);
  });
});

// ===========================================================================
// 1. Sales × Events
// ===========================================================================
describe("conciliarSalesComEvents", () => {
  test("sale conciliada: soma dos eventos impactantes bate com o saldo", () => {
    const r = conciliarSalesComEvents(
      [venda("s1", "1", 91)],
      [eventoFinanceiro({ nome: "ORDER_PAYMENT", valor: 100 }), eventoFinanceiro({ nome: "ORDER_COMMISSION", valor: -9 })],
    );
    assert.equal(r.porVenda[0].status, STATUS_CONCILIACAO.CONCILIADO);
    assert.equal(r.status, STATUS_CONCILIACAO.CONCILIADO);
  });

  test("sale divergente: soma dos eventos não bate com o saldo (além da tolerância)", () => {
    const r = conciliarSalesComEvents([venda("s1", "1", 91)], [eventoFinanceiro({ valor: 100 })]);
    assert.equal(r.porVenda[0].status, STATUS_CONCILIACAO.DIVERGENTE);
    assert.equal(r.porVenda[0].divergencia, 9);
  });

  test("eventos SEM impacto são ignorados da soma, mas continuam na explicação", () => {
    const r = conciliarSalesComEvents(
      [venda("s1", "1", 100)],
      [eventoFinanceiro({ valor: 100, temImpactoRepasse: true }), eventoFinanceiro({ nome: "STORE_SUBSIDY", valor: 999, temImpactoRepasse: false })],
    );
    assert.equal(r.porVenda[0].status, STATUS_CONCILIACAO.CONCILIADO); // o 999 não entrou na soma
    assert.equal(r.porVenda[0].eventosSemImpacto, 1);
    assert.equal(r.porVenda[0].eventos.length, 2); // mas aparece na lista de eventos
  });

  test("pagamento direto na loja: evento de pagamento hasTransferImpact=false, mas comissão/cancelamento true -> só os true entram na soma", () => {
    const r = conciliarSalesComEvents(
      [venda("s1", "1", -9)],
      [
        eventoFinanceiro({ nome: "ORDER_PAYMENT", valor: 100, temImpactoRepasse: false }), // pago direto na loja
        eventoFinanceiro({ nome: "ORDER_COMMISSION", valor: -9, temImpactoRepasse: true }),
      ],
    );
    assert.equal(r.porVenda[0].somaEventosImpactantes, -9);
    assert.equal(r.porVenda[0].status, STATUS_CONCILIACAO.CONCILIADO);
  });

  test("venda sem nenhum evento correlacionado -> INCOMPLETO, nunca DIVERGENTE", () => {
    const r = conciliarSalesComEvents([venda("s1", "1", 91)], []);
    assert.equal(r.porVenda[0].status, STATUS_CONCILIACAO.INCOMPLETO);
  });

  test("eventos com referencia.tipo !== 'ORDER' não são associados a nenhuma venda", () => {
    const r = conciliarSalesComEvents([venda("s1", "1", 91)], [{ ...eventoFinanceiro({ valor: 91 }), referencia: { tipo: "TRANSACTION", id: "s1" } }]);
    assert.equal(r.porVenda[0].status, STATUS_CONCILIACAO.INCOMPLETO);
  });

  test("valores negativos (venda com saldo negativo) são comparados normalmente", () => {
    const r = conciliarSalesComEvents([venda("s1", "1", -50)], [eventoFinanceiro({ valor: -50 })]);
    assert.equal(r.porVenda[0].status, STATUS_CONCILIACAO.CONCILIADO);
  });

  test("zero: saldo 0 com eventos somando 0 -> CONCILIADO", () => {
    const r = conciliarSalesComEvents([venda("s1", "1", 0)], [eventoFinanceiro({ valor: 30 }), eventoFinanceiro({ nome: "REFUND", valor: -30 })]);
    assert.equal(r.porVenda[0].status, STATUS_CONCILIACAO.CONCILIADO);
  });

  test("centavos: arredondamento de 1 centavo entre fontes é tolerado", () => {
    const r = conciliarSalesComEvents([venda("s1", "1", 10.0)], [eventoFinanceiro({ valor: 10.01 })]);
    assert.equal(r.porVenda[0].status, STATUS_CONCILIACAO.CONCILIADO);
  });

  test("dataset vazio: nenhuma venda -> SEM_DADOS, sem lançar", () => {
    const r = conciliarSalesComEvents([], []);
    assert.equal(r.status, STATUS_CONCILIACAO.SEM_DADOS);
    assert.equal(r.quantidadeVendas, 0);
  });

  test("null nas duas listas não lança (mesmo tratamento de dataset vazio)", () => {
    const r = conciliarSalesComEvents(null, null);
    assert.equal(r.quantidadeVendas, 0);
  });
});

// ===========================================================================
// 2. Events × Settlements
// ===========================================================================
describe("conciliarEventsComSettlements", () => {
  test("conciliado: soma dos eventos impactantes bate com settlement.balance", () => {
    const r = conciliarEventsComSettlements([eventoFinanceiro({ valor: 91 }), eventoFinanceiro({ nome: "STORE_SUBSIDY", valor: 5, temImpactoRepasse: false })], settlements(91, [titulo(91)]));
    assert.equal(r.status, STATUS_CONCILIACAO.CONCILIADO);
    assert.equal(r.eventosSemImpacto, 1);
  });

  test("divergente: soma dos eventos não bate com settlement.balance", () => {
    const r = conciliarEventsComSettlements([eventoFinanceiro({ valor: 100 })], settlements(91));
    assert.equal(r.status, STATUS_CONCILIACAO.DIVERGENTE);
    // divergencia = encontrado(soma de eventos) - esperado(settlement.balance)
    assert.equal(r.divergencia, 9);
  });

  test("settlements ausente (null) -> INCOMPLETO, não DIVERGENTE", () => {
    const r = conciliarEventsComSettlements([eventoFinanceiro({ valor: 91 })], null);
    assert.equal(r.status, STATUS_CONCILIACAO.INCOMPLETO);
  });

  test("events ausente (null) -> INCOMPLETO", () => {
    const r = conciliarEventsComSettlements(null, settlements(91));
    assert.equal(r.status, STATUS_CONCILIACAO.INCOMPLETO);
  });

  test("valores negativos (settlement com débito, ex. BOLETO) comparados normalmente", () => {
    const r = conciliarEventsComSettlements([eventoFinanceiro({ valor: -10 })], settlements(-10));
    assert.equal(r.status, STATUS_CONCILIACAO.CONCILIADO);
  });

  test("zero de ambos os lados -> CONCILIADO", () => {
    const r = conciliarEventsComSettlements([], settlements(0));
    assert.equal(r.status, STATUS_CONCILIACAO.CONCILIADO);
  });
});

// ===========================================================================
// 3. Reconciliation — adapter + comparação
// ===========================================================================
describe("adaptarRegistrosReconciliation + conciliarSettlementsComReconciliation", () => {
  test("Reconciliation ausente (null) -> INCOMPLETO, não DIVERGENTE nem NAO_COMPARAVEL", () => {
    const r = conciliarSettlementsComReconciliation(settlements(100), null);
    assert.equal(r.status, STATUS_CONCILIACAO.INCOMPLETO);
  });

  test("Reconciliation sem coluna correlacionável (nomes desconhecidos) -> NAO_COMPARAVEL, nunca inventa vínculo", () => {
    const arquivo = { colunas: ["xyz_desconhecida", "abc_tambem"], linhas: [{ xyz_desconhecida: "a", abc_tambem: "b" }] };
    const adaptado = adaptarRegistrosReconciliation(arquivo);
    assert.equal(adaptado.registros[0].correlacao, "nao_determinada");
    const r = conciliarSettlementsComReconciliation(settlements(100), adaptado);
    assert.equal(r.status, STATUS_CONCILIACAO.NAO_COMPARAVEL);
  });

  test("colunas conhecidas detectadas -> correlacao 'por_coluna_detectada', preserva colunas desconhecidas em `bruto`", () => {
    const arquivo = { colunas: ["pedido", "valor", "campo_misterioso"], linhas: [{ pedido: "123", valor: "50.00", campo_misterioso: "X" }] };
    const adaptado = adaptarRegistrosReconciliation(arquivo);
    assert.equal(adaptado.colunaIdDetectada, "pedido");
    assert.equal(adaptado.colunaValorDetectada, "valor");
    assert.equal(adaptado.registros[0].correlacao, "por_coluna_detectada");
    assert.equal(adaptado.registros[0].idCorrelacao, "123");
    assert.equal(adaptado.registros[0].valor, 50);
    assert.deepEqual(adaptado.registros[0].bruto, arquivo.linhas[0]); // nada descartado
  });

  test("arquivo ausente -> disponivel false, sem lançar", () => {
    const adaptado = adaptarRegistrosReconciliation(null);
    assert.equal(adaptado.disponivel, false);
    assert.deepEqual(adaptado.registros, []);
  });

  test("conciliado quando o total identificado bate com settlement.balance", () => {
    const arquivo = { colunas: ["pedido", "valor"], linhas: [{ pedido: "1", valor: "60.00" }, { pedido: "2", valor: "40.00" }] };
    const r = conciliarSettlementsComReconciliation(settlements(100), adaptarRegistrosReconciliation(arquivo));
    assert.equal(r.status, STATUS_CONCILIACAO.CONCILIADO);
  });

  test("numeroDeTextoMonetario: formato BR (vírgula decimal) interpretado corretamente", () => {
    assert.equal(numeroDeTextoMonetario("45,00"), 45);
    assert.equal(numeroDeTextoMonetario("1.234,56"), 1234.56);
  });

  test("numeroDeTextoMonetario: formato US (ponto decimal) interpretado corretamente", () => {
    assert.equal(numeroDeTextoMonetario("45.00"), 45);
    assert.equal(numeroDeTextoMonetario("1,234.56"), 1234.56);
  });

  test("numeroDeTextoMonetario: texto não numérico -> null, sem lançar", () => {
    assert.equal(numeroDeTextoMonetario("abc"), null);
    assert.equal(numeroDeTextoMonetario(""), null);
    assert.equal(numeroDeTextoMonetario(null), null);
  });
});

// ===========================================================================
// 4. Anticipation
// ===========================================================================
describe("resumirAnticipation", () => {
  test("antecipação com taxa consistente (valorOriginal - taxa ≈ valorAntecipado)", () => {
    const r = resumirAnticipation([antecipacao({ valorOriginal: 221.16, taxaValor: 3.3, valorAntecipado: 217.86 })]);
    assert.equal(r.consistente, true);
    assert.equal(r.itensInconsistentes.length, 0);
  });

  test("antecipação com taxa inconsistente é sinalizada, não escondida", () => {
    const r = resumirAnticipation([antecipacao({ valorOriginal: 100, taxaValor: 5, valorAntecipado: 90 })]); // deveria ser 95
    assert.equal(r.consistente, false);
    assert.equal(r.itensInconsistentes.length, 1);
  });

  test("campo ausente (taxa null) -> não avaliado, não conta como inconsistente", () => {
    const r = resumirAnticipation([antecipacao({ valorOriginal: 100, taxaValor: null, valorAntecipado: 90 })]);
    assert.equal(r.itensAvaliados, 0);
    assert.equal(r.consistente, null); // nada avaliável, não é nem true nem false
  });

  test("antecipação sem relação com o período (lista vazia): quantidade 0, sem lançar", () => {
    const r = resumirAnticipation([]);
    assert.equal(r.quantidade, 0);
    assert.equal(r.consistente, null);
    assert.equal(r.valorOriginal, 0);
  });

  test("null (fonte não buscada) tratado igual a lista vazia", () => {
    const r = resumirAnticipation(null);
    assert.equal(r.quantidade, 0);
  });

  test("não altera retroativamente valor de venda — resumirAnticipation não recebe nem devolve nada de Sales", () => {
    const r = resumirAnticipation([antecipacao({ valorOriginal: 100, taxaValor: 5, valorAntecipado: 95 })]);
    assert.ok(!("saleId" in r) && !("vendaId" in r));
  });
});

// ===========================================================================
// 5+6. conciliarFinancial — resultado consolidado + resiliência
// ===========================================================================
describe("conciliarFinancial — resultado consolidado", () => {
  const periodo = { inicio: "2025-01-01", fim: "2025-01-31" };

  test("dataset vazio (todas as fontes null): não lança, tudo INCOMPLETO/vazio — nada foi buscado, não é 'confirmadamente vazio'", () => {
    const r = conciliarFinancial({ periodo, sales: null, events: null, settlements: null, reconciliation: null, anticipations: null });
    assert.equal(r.vendas, null);
    assert.equal(r.eventos, null);
    // SEM_DADOS != INCOMPLETO: SEM_DADOS é reservado pra quando uma fonte
    // FOI buscada com sucesso e genuinamente devolveu zero registros (ver
    // conciliarSalesComEvents com vendas:[]); aqui nenhuma fonte foi buscada.
    assert.equal(r.conciliacao.statusGeral, STATUS_CONCILIACAO.INCOMPLETO);
    assert.deepEqual(r.conciliacao.divergencias, []);
  });

  test("dados parciais: sales+events presentes, settlements/reconciliation/anticipation ausentes -> ainda produz análise", () => {
    const r = conciliarFinancial({
      periodo,
      sales: { vendas: [venda("s1", "1", 91)] },
      events: { eventos: [eventoFinanceiro({ valor: 91 })] },
      settlements: null, reconciliation: null, anticipations: null,
    });
    assert.equal(r.vendas.quantidade, 1);
    assert.equal(r.conciliacao.salesVsEvents.status, STATUS_CONCILIACAO.CONCILIADO);
    assert.equal(r.conciliacao.eventsVsSettlements.status, STATUS_CONCILIACAO.INCOMPLETO); // settlements ausente
    assert.equal(r.settlements, null);
  });

  test("AUSÊNCIA DE UMA API NÃO DERRUBA A ANÁLISE: reconciliation e anticipation null, resto presente e conciliado -> statusGeral não é SEM_DADOS", () => {
    const r = conciliarFinancial({
      periodo,
      sales: { vendas: [venda("s1", "1", 91)] },
      events: { eventos: [eventoFinanceiro({ valor: 91 })] },
      settlements: settlements(91, [titulo(91)]),
      reconciliation: null,
      anticipations: null,
    });
    assert.equal(r.conciliacao.salesVsEvents.status, STATUS_CONCILIACAO.CONCILIADO);
    assert.equal(r.conciliacao.eventsVsSettlements.status, STATUS_CONCILIACAO.CONCILIADO);
    assert.notEqual(r.conciliacao.statusGeral, STATUS_CONCILIACAO.SEM_DADOS);
    assert.equal(r.anticipation.quantidade, 0);
  });

  test("tudo presente e conciliado -> statusGeral CONCILIADO", () => {
    const arquivo = { colunas: ["pedido", "valor"], linhas: [{ pedido: "s1", valor: "91.00" }] };
    const r = conciliarFinancial({
      periodo,
      sales: { vendas: [venda("s1", "1", 91)] },
      events: { eventos: [eventoFinanceiro({ valor: 91 })] },
      settlements: settlements(91, [titulo(91)]),
      reconciliation: { competencia: "2025-01", arquivo },
      anticipations: { antecipacoes: [antecipacao({ valorOriginal: 91, taxaValor: 1, valorAntecipado: 90 })] },
    });
    assert.equal(r.conciliacao.statusGeral, STATUS_CONCILIACAO.CONCILIADO);
    assert.equal(r.reconciliation.disponivel, true);
    assert.equal(r.anticipation.quantidade, 1);
  });

  test("divergência real gera entrada em conciliacao.divergencias com os campos pedidos", () => {
    const r = conciliarFinancial({
      periodo,
      sales: { vendas: [venda("s1", "1", 91)] },
      events: { eventos: [eventoFinanceiro({ valor: 999 })] }, // não bate
      settlements: null, reconciliation: null, anticipations: null,
    });
    assert.equal(r.conciliacao.divergencias.length, 1);
    const d = r.conciliacao.divergencias[0];
    assert.equal(d.codigo, "SALES_EVENTS_DIVERGENCIA");
    assert.ok("origem" in d && "esperado" in d && "encontrado" in d && "diferenca" in d && "explicacao" in d);
  });

  test("divergência de antecipação (taxa inconsistente) também aparece em divergencias", () => {
    const r = conciliarFinancial({
      periodo, sales: null, events: null, settlements: null, reconciliation: null,
      anticipations: { antecipacoes: [antecipacao({ valorOriginal: 100, taxaValor: 5, valorAntecipado: 80 })] },
    });
    assert.ok(r.conciliacao.divergencias.some((d) => d.codigo === "ANTICIPATION_TAXA_INCONSISTENTE"));
  });

  test("statusGeral nunca é DIVERGENTE só por ausência de dado (dados parciais sem nenhuma divergência real)", () => {
    const r = conciliarFinancial({ periodo, sales: { vendas: [] }, events: null, settlements: null, reconciliation: null, anticipations: null });
    assert.notEqual(r.conciliacao.statusGeral, STATUS_CONCILIACAO.DIVERGENTE);
  });

  test("trilhaPorVenda exposta pra UI montar a Trilha Financeira", () => {
    const r = conciliarFinancial({
      periodo, sales: { vendas: [venda("s1", "1", 91)] }, events: { eventos: [eventoFinanceiro({ valor: 91 })] },
      settlements: null, reconciliation: null, anticipations: null,
    });
    assert.equal(r.trilhaPorVenda.length, 1);
    assert.equal(r.trilhaPorVenda[0].saleId, "s1");
  });

  test("período é sempre preservado no resultado, mesmo com tudo vazio", () => {
    const r = conciliarFinancial({ periodo, sales: null, events: null, settlements: null, reconciliation: null, anticipations: null });
    assert.deepEqual(r.periodo, periodo);
  });
});
