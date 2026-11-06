import { test } from "node:test";
import assert from "node:assert/strict";
import { diferenca, situacao, diasAtraso, painelJuros, sugerirVinculos, dentroDaTolerancia, TOLERANCIA, diasEntre } from "../../src/financeiro-calculos/contasPagar.js";
import { formatarBps } from "../../src/financeiro-calculos/dinheiro.js";

// Dados 100% sintéticos.
const obr = (valor, extra = {}) => ({ id: "o1", valor_original_centavos: valor, status: "aberta", vencimento: "2026-09-12", classificacao_diferenca: null, ...extra });
const pag = (valor, data = "2026-09-18", extra = {}) => ({ id: `p${valor}${data}`, valor_centavos: valor, data_pagamento: data, status: "ativo", conta_id: "A", ...extra });

test("CP-1 exemplo homologado: 810,00 → 832,41 = R$ 22,41 e 2,77%", () => {
  const d = diferenca(obr(81000, { status: "quitada", data_quitacao: "2026-09-18" }), [pag(83241)]);
  assert.equal(d.diferencaCentavos, 2241);
  assert.equal(d.percentualBps, 277);
  assert.equal(formatarBps(d.percentualBps), "2,77%");
  assert.equal(d.natureza, "presumido");
});

test("CP-2 acréscimo classificado depois: juros, multa, tarifa ou outro", () => {
  for (const c of ["juros", "multa", "tarifa", "outro"]) assert.equal(diferenca(obr(81000, { status: "quitada", classificacao_diferenca: c }), [pag(83241)]).natureza, c);
});

test("CP-3 obrigação ABERTA não tem diferença (pagamento isolado nunca gera juros)", () => {
  const d = diferenca(obr(200000), [pag(120000, "2026-09-10")]);
  assert.equal(d.diferencaCentavos, null);
  assert.equal(d.natureza, null);
  assert.equal(d.saldoAbertoCentavos, 80000);
});

test("CP-4 múltiplos pagamentos: 1.200 + 800 = 2.000 quitada → diferença zero", () => {
  const d = diferenca(obr(200000, { status: "quitada" }), [pag(120000, "2026-09-10"), pag(80000, "2026-09-25")]);
  assert.equal(d.diferencaCentavos, 0);
  assert.equal(d.natureza, null);
});

test("CP-5 pagamento parcial (900 de 1.500) NUNCA vira desconto", () => {
  const o = obr(150000, { vencimento: "2026-09-05" });
  const d = diferenca(o, [pag(90000, "2026-09-05")]);
  assert.equal(d.natureza, null);
  assert.equal(situacao(o, [pag(90000, "2026-09-05")], "2026-09-30"), "parcial_vencida");
});

test("CP-6 pago a menor e quitado: 'a verificar' até alguém classificar como desconto", () => {
  assert.equal(diferenca(obr(64000, { status: "quitada" }), [pag(61000)]).natureza, "a_verificar");
  assert.equal(diferenca(obr(64000, { status: "quitada", classificacao_diferenca: "desconto" }), [pag(61000)]).natureza, "desconto");
  assert.equal(diferenca(obr(64000, { status: "quitada" }), [pag(61000)]).percentualBps, -469);
});

test("CP-7 pagamento cancelado não conta no total", () => {
  const d = diferenca(obr(81000, { status: "quitada" }), [pag(83241), pag(5000, "2026-09-19", { status: "cancelado" })]);
  assert.equal(d.diferencaCentavos, 2241);
});

test("CP-8 situações na data-base", () => {
  assert.equal(situacao(obr(1000, { vencimento: "2026-10-10" }), [], "2026-09-30"), "a_vencer");
  assert.equal(situacao(obr(1000, { vencimento: "2026-09-10" }), [], "2026-09-30"), "vencida");
  assert.equal(situacao(obr(1000), [pag(1000)], "2026-09-30"), "quitacao_pendente");
  assert.equal(situacao(obr(1000, { status: "quitada" }), [pag(1000)], "2026-09-30"), "paga");
  assert.equal(situacao(obr(1000, { status: "quitada" }), [pag(1100)], "2026-09-30"), "paga_com_acrescimo");
  assert.equal(situacao(obr(1000, { status: "quitada" }), [pag(900)], "2026-09-30"), "paga_a_menor");
  assert.equal(situacao(obr(1000, { status: "cancelada" }), [], "2026-09-30"), "cancelada");
});

test("CP-9 dias de atraso", () => {
  assert.equal(diasAtraso(obr(81000, { status: "quitada", data_quitacao: "2026-09-18" }), [pag(83241)]), 6);
  assert.equal(diasAtraso(obr(1000, { vencimento: "2026-09-25" }), [], "2026-09-30"), 5);
  assert.equal(diasAtraso(obr(1000, { vencimento: "2026-10-25" }), [], "2026-09-30"), 0);
  assert.equal(diasEntre("2026-02-28", "2026-03-01"), 1);
});

test("CP-10 painel de juros: separa presumido de confirmado; agrupa por fornecedor, categoria e mês", () => {
  const itens = [
    { obrigacao: obr(81000, { id: "a", status: "quitada", data_quitacao: "2026-09-18" }), pagamentos: [pag(83241)], fornecedor: "Embalagens", categoria: "Embalagens" },
    { obrigacao: obr(125000, { id: "b", status: "quitada", data_quitacao: "2026-09-28", vencimento: "2026-09-20", classificacao_diferenca: "multa" }), pagamentos: [pag(129375, "2026-09-28")], fornecedor: "Energia", categoria: "Energia" },
    { obrigacao: obr(9000, { id: "c", status: "quitada", data_quitacao: "2026-08-22", vencimento: "2026-08-22", classificacao_diferenca: "tarifa" }), pagamentos: [pag(9850, "2026-08-22")], fornecedor: "Banco", categoria: "Serviços" },
    { obrigacao: obr(200000, { id: "d", status: "quitada" }), pagamentos: [pag(200000)], fornecedor: "Laticínios", categoria: "Laticínios" },
    { obrigacao: obr(150000, { id: "e" }), pagamentos: [pag(90000)], fornecedor: "Folha", categoria: "Pessoal" },
  ];
  const p = painelJuros(itens);
  assert.deepEqual(p.totais, { presumidoCentavos: 2241, jurosCentavos: 0, multaCentavos: 4375, tarifaCentavos: 850, outroCentavos: 0, confirmadoCentavos: 5225, totalCentavos: 7466 });
  assert.equal(p.linhas.length, 3, "sem diferença e aberta não entram");
  assert.equal(p.contasPagasComAtraso, 2);
  assert.deepEqual(p.porMes, [{ chave: "2026-08", centavos: 850 }, { chave: "2026-09", centavos: 6616 }]);
  assert.equal(p.porFornecedor[0].chave, "Energia");
});

const s = (id, valor, data, conta = "A") => ({ id, valor_centavos: valor, data_movimento: data, conta_id: conta });
const pg = (id, valor, data, conta = "A") => ({ id, valor_centavos: valor, data_pagamento: data, conta_id: conta });

test("CS-1 sugestão 1:1 exata e com 1 dia de diferença; fora da tolerância não sugere", () => {
  const r = sugerirVinculos({ pagamentos: [pg("p1", 83241, "2026-09-18"), pg("p2", 5000, "2026-09-10"), pg("p3", 7000, "2026-09-10")], saidas: [s("s1", 83241, "2026-09-18"), s("s2", 5001, "2026-09-11"), s("s3", 7002, "2026-09-10")] });
  assert.deepEqual(r.sugestoes.map((x) => [x.lancamentoId, x.pagamentoIds.join(), x.regra]), [["s1", "p1", "exato"], ["s2", "p2", "data_proxima"]]);
  assert.ok(!r.sugestoes.some((x) => x.lancamentoId === "s3"), "R$ 0,02 de diferença está fora da tolerância de R$ 0,01");
});

test("CS-2 dois dias de diferença não sugere; conta diferente não sugere", () => {
  const r = sugerirVinculos({ pagamentos: [pg("p1", 1000, "2026-09-10"), pg("p2", 2000, "2026-09-10", "B")], saidas: [s("s1", 1000, "2026-09-12"), s("s2", 2000, "2026-09-10", "A")] });
  assert.equal(r.sugestoes.length, 0);
});

test("CS-3 ambiguidade (dois pagamentos iguais) NÃO vira sugestão", () => {
  const r = sugerirVinculos({ pagamentos: [pg("p1", 1000, "2026-09-10"), pg("p2", 1000, "2026-09-10")], saidas: [s("s1", 1000, "2026-09-10")] });
  assert.equal(r.sugestoes.length, 0);
  assert.equal(r.ambiguos[0].motivo, "mais_de_um_pagamento_compativel");
});

test("CS-4 agrupado: uma saída de 2.000 ⇄ 1.200 + 800 do mesmo dia", () => {
  const r = sugerirVinculos({ pagamentos: [pg("p1", 120000, "2026-09-25"), pg("p2", 80000, "2026-09-25"), pg("p3", 50000, "2026-09-25")], saidas: [s("s1", 200000, "2026-09-26")] });
  assert.equal(r.sugestoes.length, 1);
  assert.equal(r.sugestoes[0].regra, "agrupado");
  assert.deepEqual(r.sugestoes[0].pagamentoIds.sort(), ["p1", "p2"]);
  assert.equal(r.sugestoes[0].diasDiferenca, 1);
});

test("CS-5 agrupado ambíguo (duas combinações) NÃO vira sugestão", () => {
  const r = sugerirVinculos({ pagamentos: [pg("p1", 1000, "2026-09-25"), pg("p2", 1000, "2026-09-25"), pg("p3", 1000, "2026-09-25")], saidas: [s("s1", 2000, "2026-09-25")] });
  assert.equal(r.sugestoes.length, 0);
  assert.equal(r.ambiguos[0].motivo, "mais_de_um_grupo_compativel");
});

test("CS-6 tolerância aprovada: R$ 0,01 e 1 dia", () => {
  assert.deepEqual(TOLERANCIA, { centavos: 1, dias: 1 });
  assert.equal(dentroDaTolerancia(1, 1), true);
  assert.equal(dentroDaTolerancia(-1, 0), true);
  assert.equal(dentroDaTolerancia(2, 0), false);
  assert.equal(dentroDaTolerancia(0, 2), false);
});
