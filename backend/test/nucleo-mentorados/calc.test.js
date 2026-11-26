// Núcleo Mentorados — motor de cálculo. Rodar: node --test test/nucleo-mentorados/calc.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as C from "../../src/modules/nucleo-mentorados/calc.js";
import { serieReferencia } from "./fixtures.js";

const r$ = (c) => c / 100;

describe("períodos", () => {
  test("entrada out/25 -> antes out/24–set/25, 1º ano out/25–set/26 completo", () => {
    const p = C.periodosDaMentoria({ dataEntrada: "2025-10-01", ultimoMesFechado: "2026-09" });
    assert.deepEqual([p.antes.inicio, p.antes.fim], ["2024-10", "2025-09"]);
    assert.equal(p.ciclos.length, 1);
    assert.deepEqual([p.ciclos[0].inicio, p.ciclos[0].fim, p.ciclos[0].parcial], ["2025-10", "2026-09", false]);
    assert.deepEqual([p.ciclos[0].referencia.inicio, p.ciclos[0].referencia.fim], ["2024-10", "2025-09"]);
  });
  test("ano incompleto: 2º ano com 2 meses vira ciclo PARCIAL comparado aos MESMOS 2 meses do ano anterior", () => {
    const p = C.periodosDaMentoria({ dataEntrada: "2025-10-15", ultimoMesFechado: "2026-11" });
    const c2 = p.ciclos[1];
    assert.equal(c2.parcial, true);
    assert.equal(c2.meses, 2);
    assert.deepEqual([c2.inicio, c2.fim], ["2026-10", "2026-11"]);
    assert.deepEqual([c2.referencia.inicio, c2.referencia.fim, c2.referencia.meses], ["2025-10", "2025-11", 2]);
    assert.equal(p.mesesDeMentoria, 14);
  });
  test("menos de 12 meses de mentoria: 1º ano parcial comparado aos meses equivalentes antes da entrada", () => {
    const p = C.periodosDaMentoria({ dataEntrada: "2026-07-01", ultimoMesFechado: "2026-10" });
    assert.equal(p.ciclos[0].meses, 4);
    assert.deepEqual([p.ciclos[0].referencia.inicio, p.ciclos[0].referencia.fim], ["2025-07", "2025-10"]);
  });
  test("entrada no futuro / sem mês fechado: nenhum ciclo", () => {
    assert.equal(C.periodosDaMentoria({ dataEntrada: "2026-12-01", ultimoMesFechado: "2026-10" }).ciclos.length, 0);
  });
  test("virada de ano em somarMeses", () => {
    assert.equal(C.somarMeses("2025-01", -1), "2024-12");
    assert.equal(C.somarMeses("2024-12", 13), "2026-01");
    assert.equal(C.distanciaMeses("2024-10", "2025-09"), 12);
  });
});

describe("série sintética de 24 meses (mesmo formato da planilha do mentor)", () => {
  const serie = serieReferencia();
  const antes = C.agregar(serie, "2024-10", "2025-09");
  const dur = C.agregar(serie, "2025-10", "2026-09");
  test("totais antes e durante", () => {
    assert.equal(r$(antes.totais.valorVendas.total), 786000);
    assert.equal(r$(antes.totais.taxasComissoes.total), 117900);
    assert.equal(r$(antes.totais.servicosPromocoes.total), 78600);
    assert.equal(r$(dur.totais.valorVendas.total), 1179000);
    assert.equal(r$(dur.totais.taxasComissoes.total), 147375);
    assert.equal(r$(dur.totais.servicosPromocoes.total), 70740);
  });
  test("crescimento 50% e participação 25% -> 18,5% (−6,5 p.p.)", () => {
    const ind = C.comparar(dur, antes);
    const v = ind.find((i) => i.chave === "valorVendas");
    assert.equal(v.variacaoPercentual, 50);
    assert.equal(v.leitura, "melhora");
    const p = ind.find((i) => i.chave === "pctTaxasMaisServicos");
    assert.equal(p.referencia, 25);
    assert.equal(p.atual, 18.5);
    assert.equal(p.pontosPercentuais, -6.5);
    assert.equal(p.variacaoPercentual, null, "indicador percentual não ganha variação relativa");
    assert.equal(p.leitura, "melhora");
  });
  test("dados incompletos não viram conclusão: pedidos/ticket/novos e entregadores sem variação", () => {
    const ind = C.comparar(dur, antes);
    for (const chave of ["qtdPedidos", "ticketMedio", "novosClientes", "taxasEntregadores", "pctTaxasEntregadores", "pctCustosIfoodTotal"]) {
      const i = ind.find((x) => x.chave === chave);
      assert.equal(i.comparavel, false, chave);
      assert.equal(i.variacaoPercentual, null, chave);
      assert.equal(i.pontosPercentuais, null, chave);
      assert.match(i.motivo, /incompletos/);
    }
    assert.equal(dur.totais.taxasEntregadores.mesesComDado, 10);
  });
});

describe("regras de agregação", () => {
  test("percentual ponderado ≠ média simples dos percentuais mensais", () => {
    const serie = [
      { mes: "2026-01", valorVendas: 100000, taxasComissoes: 30000, servicosPromocoes: 0 },   // 30%
      { mes: "2026-02", valorVendas: 900000, taxasComissoes: 90000, servicosPromocoes: 0 },   // 10%
    ];
    const a = C.agregar(serie, "2026-01", "2026-02");
    assert.equal(a.percentuais.taxasComissoes.pct, 12); // 120.000 / 1.000.000, não (30+10)/2 = 20
  });
  test("ausência não é zero: mês sem componente sai do numerador E do denominador", () => {
    const serie = [
      { mes: "2026-01", valorVendas: 100000, taxasEntregadores: 10000 },
      { mes: "2026-02", valorVendas: 100000, taxasEntregadores: null },
    ];
    const a = C.agregar(serie, "2026-01", "2026-02");
    assert.equal(a.percentuais.taxasEntregadores.pct, 10);
    assert.equal(a.percentuais.taxasEntregadores.meses, 1);
    assert.equal(a.totais.taxasEntregadores.completo, false);
    assert.equal(C.centavos(""), null);
    assert.equal(C.centavos(null), null);
    assert.equal(C.centavos(0), 0);
  });
  test("mês inexistente na série conta como faltante", () => {
    const a = C.agregar([{ mes: "2026-01", valorVendas: 100 }], "2026-01", "2026-03");
    assert.equal(a.totais.valorVendas.mesesComDado, 1);
    assert.equal(a.mesesEsperados, 3);
  });
  test("crescimento positivo, negativo e base zero", () => {
    assert.deepEqual(C.variacao(150, 100), { absoluta: 50, percentual: 50 });
    assert.deepEqual(C.variacao(80, 100), { absoluta: -20, percentual: -20 });
    assert.deepEqual(C.variacao(10, 0), { absoluta: 10, percentual: null });
    assert.deepEqual(C.variacao(null, 100), { absoluta: null, percentual: null });
    assert.equal(C.pontosPercentuais(19.6, 25.78), -6.18);
  });
  test("queda de vendas é 'piora'; alta de custo percentual é 'piora'", () => {
    const ref = C.agregar([{ mes: "2025-01", valorVendas: 100000, taxasComissoes: 10000, servicosPromocoes: 0 }], "2025-01", "2025-01");
    const at = C.agregar([{ mes: "2026-01", valorVendas: 80000, taxasComissoes: 12000, servicosPromocoes: 0 }], "2026-01", "2026-01");
    const ind = C.comparar(at, ref);
    assert.equal(ind.find((i) => i.chave === "valorVendas").leitura, "piora");
    assert.equal(ind.find((i) => i.chave === "valorVendas").variacaoPercentual, -20);
    assert.equal(ind.find((i) => i.chave === "pctTaxasComissoes").leitura, "piora");
  });
  test("comparar recusa períodos de tamanhos diferentes", () => {
    const a = C.agregar([], "2026-01", "2026-03"), b = C.agregar([], "2025-01", "2025-12");
    assert.throws(() => C.comparar(a, b), RangeError);
  });
  test("ticket médio = Σ vendas ÷ Σ pedidos, só meses com os dois", () => {
    const a = C.agregar([
      { mes: "2026-01", qtdPedidos: 100, valorVendasDesempenho: 500000 },
      { mes: "2026-02", qtdPedidos: 300, valorVendasDesempenho: 1200000 },
      { mes: "2026-03", qtdPedidos: 50, valorVendasDesempenho: null },
    ], "2026-01", "2026-03");
    assert.equal(a.ticketMedio.valor, 4250); // 17.000 / 400 = R$ 42,50
    assert.equal(a.ticketMedio.meses, 2);
  });
});

describe("consolidação de fontes (duplicidade e divergência)", () => {
  const imp = [{ mes: "2026-05", valorVendas: 10050000, taxasComissoes: 1256250, servicosPromocoes: 603000, taxasEntregadores: 1306500 }];
  const dash = [
    { mes: "2026-05", valorVendas: 9848000, taxasComissoes: 1256250, servicosPromocoes: 603000, taxasEntregadores: 1306500 },
    { mes: "2026-10", valorVendas: 9000000, taxasComissoes: 1500000, servicosPromocoes: 1600000, taxasEntregadores: null },
  ];
  test("um mês = uma fonte; nada é somado", () => {
    const { meses, divergencias } = C.consolidarSerie({ importacao: imp, dashboard: dash, preferencia: "importacao" });
    assert.equal(meses.length, 2);
    assert.equal(meses[0].valorVendas, 10050000);
    assert.equal(meses[0].fonte, "importacao");
    assert.equal(meses[1].fonte, "dashboard_ifood");
    assert.equal(divergencias.length, 1);
    assert.equal(divergencias[0].campo, "valorVendas");
    assert.equal(divergencias[0].diferenca, 202000); // R$ 2.020,00
  });
  test("preferência pelo Dashboard inverte a escolha, mesma divergência", () => {
    const { meses, divergencias } = C.consolidarSerie({ importacao: imp, dashboard: dash, preferencia: "dashboard_ifood" });
    assert.equal(meses[0].valorVendas, 9848000);
    assert.equal(divergencias[0].diferenca, -202000);
  });
  test("diferença abaixo de R$ 1,00 é arredondamento", () => {
    const { divergencias } = C.consolidarSerie({ importacao: [{ mes: "2026-01", valorVendas: 1000 }], dashboard: [{ mes: "2026-01", valorVendas: 1099 }] });
    assert.equal(divergencias.length, 0);
  });
  test("desempenho ausente na planilha vem do Dashboard, com origem registrada e sem divergência", () => {
    const { meses, divergencias } = C.consolidarSerie({
      importacao: [{ mes: "2026-05", valorVendas: 100, taxasComissoes: 10, servicosPromocoes: 5, taxasEntregadores: 3, qtdPedidos: null }],
      dashboard: [{ mes: "2026-05", valorVendas: 100, taxasComissoes: 10, servicosPromocoes: 5, taxasEntregadores: 3, qtdPedidos: 2322, valorVendasDesempenho: 11541620, novosClientes: 576 }],
      preferencia: "importacao",
    });
    assert.equal(meses[0].qtdPedidos, 2322);
    assert.deepEqual(meses[0].fontes, { financeiro: "importacao", desempenho: "dashboard_ifood" });
    assert.equal(divergencias.length, 0);
  });
  test("desempenho nas duas fontes: usa a preferida e aponta a diferença", () => {
    const { meses, divergencias } = C.consolidarSerie({
      importacao: [{ mes: "2026-09", valorVendas: 100, qtdPedidos: 2575, novosClientes: 831 }],
      dashboard: [{ mes: "2026-09", valorVendas: 100, qtdPedidos: 2500, novosClientes: 831 }],
      preferencia: "importacao",
    });
    assert.equal(meses[0].qtdPedidos, 2575);
    assert.deepEqual(divergencias.map((d) => [d.campo, d.diferenca]), [["qtdPedidos", 75]]);
  });
  test("série de importação repetida não duplica meses", () => {
    const { meses } = C.consolidarSerie({ importacao: [...imp, ...imp], dashboard: [] });
    assert.equal(meses.length, 1);
  });
});

describe("metas, saldo de precificação e alertas", () => {
  const serie = serieReferencia();
  test("metas × realizado em p.p.", () => {
    const dur = C.agregar(serie, "2025-10", "2026-09");
    const m = C.metasVersusRealizado(dur, { taxasComissoes: 13, taxasMaisServicos: 18 });
    const tc = m.find((x) => x.chave === "taxasComissoes");
    assert.equal(tc.dentro, true);
    const ts = m.find((x) => x.chave === "taxasMaisServicos");
    assert.equal(ts.dentro, false);
    assert.equal(ts.diferencaPp, 0.5);
  });
  test("saldo de precificação é folga em p.p., marcado sem entregadores quando ausentes", () => {
    const s = C.saldoPrecificacao(serie[23]);
    assert.equal(s.entregadoresInformados, false);
    assert.equal(typeof s.saldoPp, "number");
  });
  test("analisar: alertas de renovação, ciclo parcial e cobertura", () => {
    const a = C.analisar({ participante: { data_entrada: "2025-10-01", data_renovacao: "2026-12-20" }, serie, hojeIso: "2026-11-26" });
    const codigos = a.alertas.map((x) => x.codigo);
    assert.ok(codigos.includes("RENOVACAO_PROXIMA"));
    assert.ok(codigos.includes("INCOMPLETO_QTDPEDIDOS"));
    assert.equal(a.ultimoMesComDado, "2026-09");
    assert.equal(a.comparativos.length, 1);
  });
});

describe("escolha auditável de fonte, entrada pendente e mudança de modelo", () => {
  const imp = [{ mes: "2026-05", valorVendas: 10050000, taxasComissoes: 1000 }, { mes: "2026-06", valorVendas: 20000, taxasComissoes: 10 }];
  const dash = [{ mes: "2026-05", valorVendas: 9848000, taxasComissoes: 1000 }, { mes: "2026-06", valorVendas: 21000, taxasComissoes: 10 }];
  test("padrão é o Dashboard iFood", () => {
    const { meses } = C.consolidarSerie({ importacao: imp, dashboard: dash });
    assert.equal(meses[0].valorVendas, 9848000);
    assert.equal(meses[0].fonte, "dashboard_ifood");
  });
  test("escolha por período e grupo vence o padrão e marca a divergência como resolvida", () => {
    const escolhas = [{ id: "e1", inicio: "2026-05", fim: "2026-05", grupo: "financeiro", fonte: "importacao", criadaEm: "2026-11-01" }];
    const { meses, divergencias } = C.consolidarSerie({ importacao: imp, dashboard: dash, escolhas });
    assert.equal(meses[0].valorVendas, 10050000);
    assert.deepEqual(meses[0].escolhas.financeiro, { id: "e1", aplicada: true });
    assert.equal(meses[1].fonte, "dashboard_ifood", "fora do período da escolha vale o padrão");
    assert.equal(divergencias.find((d) => d.mes === "2026-05").resolvidaPor, "e1");
    assert.equal(divergencias.find((d) => d.mes === "2026-06").resolvidaPor, null);
  });
  test("escolha revogada é ignorada; a mais recente vence", () => {
    const escolhas = [
      { id: "a", inicio: "2026-01", fim: "2026-12", grupo: "financeiro", fonte: "importacao", criadaEm: "2026-11-01" },
      { id: "b", inicio: "2026-05", fim: "2026-05", grupo: "financeiro", fonte: "dashboard_ifood", criadaEm: "2026-11-02" },
      { id: "c", inicio: "2026-05", fim: "2026-06", grupo: "financeiro", fonte: "importacao", criadaEm: "2026-11-03", revogada: true },
    ];
    const { meses } = C.consolidarSerie({ importacao: imp, dashboard: dash, escolhas });
    assert.equal(meses[0].valorVendas, 9848000);
    assert.equal(meses[1].valorVendas, 20000);
  });
  test("entrada pendente: sem períodos presumidos, alerta explícito", () => {
    const a = C.analisar({ participante: { data_entrada: null }, serie: serieReferencia(), hojeIso: "2026-11-26" });
    assert.equal(a.comparativos.length, 0);
    assert.equal(a.periodos.antes, null);
    assert.equal(a.alertas[0].codigo, "ENTRADA_PENDENTE");
  });
  test("mudança para Full Service dentro da janela: entregadores não comparáveis, demais indicadores intactos", () => {
    const serie = serieReferencia().map((m) => ({ ...m, taxasEntregadores: m.taxasEntregadores ?? 0 }));
    const sem = C.analisar({ participante: { data_entrada: "2025-10-01" }, serie, hojeIso: "2026-11-26" });
    assert.equal(sem.comparativos[0].indicadores.find((i) => i.chave === "pctCustosIfoodTotal").comparavel, true);
    const com = C.analisar({ participante: { data_entrada: "2025-10-01" }, serie, hojeIso: "2026-11-26", mudancas: [{ mes: "2026-08-01", de: "marketplace", para: "full_service" }] });
    const ind = com.comparativos[0].indicadores;
    for (const k of ["taxasEntregadores", "pctTaxasEntregadores", "pctCustosIfoodTotal"]) {
      const i = ind.find((x) => x.chave === k);
      assert.equal(i.comparavel, false, k);
      assert.equal(i.leitura, null, k);
      assert.match(i.motivo, /Marketplace → Full Service em ago\/26/);
    }
    assert.equal(ind.find((i) => i.chave === "pctTaxasMaisServicos").comparavel, true);
    assert.ok(com.alertas.some((x) => x.codigo === "MUDANCA_OPERACIONAL"));
  });
  test("mudança fora da janela não afeta a comparação", () => {
    const serie = serieReferencia().map((m) => ({ ...m, taxasEntregadores: m.taxasEntregadores ?? 0 }));
    const a = C.analisar({ participante: { data_entrada: "2025-10-01" }, serie, hojeIso: "2026-11-26", mudancas: [{ mes: "2024-05-01", para: "marketplace" }] });
    assert.equal(a.comparativos[0].indicadores.find((i) => i.chave === "pctCustosIfoodTotal").comparavel, true);
  });
});
