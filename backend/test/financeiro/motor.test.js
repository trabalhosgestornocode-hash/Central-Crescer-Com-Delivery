import { test } from "node:test";
import assert from "node:assert/strict";
import { paraCentavos, dividirArredondando, razaoEmBps, formatarCentavos, formatarBps, ValorInvalidoError } from "../../src/financeiro-calculos/dinheiro.js";
import { PAPEL, papelDeTipoNatureza, validarCategoria } from "../../src/financeiro-calculos/planoContas.js";
import { apurar, saldosPorConta, validarParesTransferencia, INDICADORES } from "../../src/financeiro-calculos/motor.js";

// Dados 100% sintéticos (nada da operação real).
let seq = 0;
const e = (valor, papel, extra = {}) => ({ id: `l${++seq}`, contaId: "A", sentido: "entrada", valorCentavos: valor, papel, status: "realizado", ...extra });
const s = (valor, papel, extra = {}) => ({ ...e(valor, papel, extra), sentido: "saida" });

function cenario() {
  return [
    e(1000000, PAPEL.RECEITA_OPERACIONAL),
    s(400000, PAPEL.CUSTO_VARIAVEL),
    s(30000, PAPEL.DESPESA_VARIAVEL),
    s(40000, PAPEL.TRIBUTO),
    s(90000, PAPEL.DESPESA_FIXA),
    s(110000, PAPEL.DESPESA_PESSOAL),
    s(7777, PAPEL.DESPESA_FINANCEIRA),
    e(100000, PAPEL.FINANCIAMENTO),
    s(150000, PAPEL.FINANCIAMENTO),
    e(500000, PAPEL.TRANSFERENCIA, { contaId: "B" }),
    s(560000, PAPEL.TRANSFERENCIA),
    e(20000, PAPEL.SALDO_ANTERIOR),
  ];
}

test("dinheiro: parse exato, ruído de float e casas inválidas", () => {
  assert.equal(paraCentavos(150084.05999999994), 15008406);
  assert.equal(paraCentavos("1.234,56"), 123456);
  assert.equal(paraCentavos("R$ 0,5"), 50);
  assert.equal(paraCentavos("(10,00)"), -1000);
  assert.equal(paraCentavos(null), null);
  assert.equal(paraCentavos(""), null);
  assert.throws(() => paraCentavos(1.005), ValorInvalidoError);
  assert.throws(() => paraCentavos("abc"), ValorInvalidoError);
});

test("dinheiro: arredondamento half-away-from-zero e divisão por zero", () => {
  assert.equal(dividirArredondando(5, 2), 3);
  assert.equal(dividirArredondando(-5, 2), -3);
  assert.equal(dividirArredondando(4, 3), 1);
  assert.equal(dividirArredondando(1, 0), null);
  assert.equal(razaoEmBps(1, 3), 3333);
  assert.equal(formatarCentavos(-123456789), "-1.234.567,89");
  assert.equal(formatarBps(1888), "18,88%");
});

test("0,1 + 0,2 em centavos é exato", () => {
  assert.equal(apurar([e(10, PAPEL.RECEITA_OPERACIONAL), e(20, PAPEL.RECEITA_OPERACIONAL)]).receitaOperacional, 30);
});

test("apuração: margens, resultado e variação seguem as fórmulas", () => {
  const r = apurar(cenario());
  assert.equal(r.receitaOperacional, 1000000);
  assert.equal(r.margemContribuicao, 1000000 - 400000 - 30000 - 40000);
  assert.equal(r.resultadoGerencial, r.margemContribuicao - 90000 - 110000 - 7777);
  assert.equal(r.variacaoCaixa, r.entradasTotais - 20000 - r.saidasTotais);
  assert.equal(r.saldoFinal, r.variacaoCaixa + 20000);
  assert.equal(r.margemLiquidaBps, razaoEmBps(r.resultadoGerencial, r.receitaOperacional));
});

test("ponte resultado→caixa fecha ao centavo e saldo anterior fica fora da variação", () => {
  const r = apurar(cenario());
  assert.equal(r.transferencias.liquidasExternas, 60000);
  assert.equal(r.ponteResultadoCaixa.fecha, true);
  assert.equal(r.ponteResultadoCaixa.diferenca, 0);
  assert.equal(r.saldoFinal, r.variacaoCaixa + r.saldoAnterior);
});

test("ponto de equilíbrio usa precisão integral (sem arredondar a % antes)", () => {
  const r = apurar([e(300000, PAPEL.RECEITA_OPERACIONAL), s(123457, PAPEL.CUSTO_VARIAVEL), s(100000, PAPEL.DESPESA_FIXA)]);
  assert.equal(r.margemContribuicao, 176543); // 58,8477…%
  const exato = Number((100000n * 300000n * 2n + 176543n) / (2n * 176543n));
  assert.equal(r.pontoEquilibrio, exato);
  // arredondar a % para 2 casas antes (58,85%) daria outro valor: prova que não é feito
  assert.notEqual(r.pontoEquilibrio, Math.round(100000 / 0.5885));
});

test("dados ausentes: sem receita → indicadores indisponíveis, nunca zero", () => {
  const r = apurar([s(100, PAPEL.DESPESA_FIXA)]);
  assert.equal(r.margemLiquidaBps, null);
  assert.equal(r.pontoEquilibrio, null);
  assert.equal(r.apresentacao.margemLiquida, null);
});

test("sem lançamentos: tudo zero e estado coerente", () => {
  const r = apurar([]);
  assert.equal(r.resultadoGerencial, 0);
  assert.equal(r.parcial, false);
  assert.equal(r.ponteResultadoCaixa.fecha, true);
});

test("só realizado entra no caixa; previsto/cancelado são ignorados e contados", () => {
  const r = apurar([e(100, PAPEL.RECEITA_OPERACIONAL), e(900, PAPEL.RECEITA_OPERACIONAL, { status: "previsto" }), e(50, PAPEL.RECEITA_OPERACIONAL, { status: "cancelado" })]);
  assert.equal(r.receitaOperacional, 100);
  assert.equal(r.contagem.ignoradosPorStatus, 2);
});

test("lançamento sem papel é pendente: fora dos indicadores, marca parcial e a ponte denuncia", () => {
  const r = apurar([e(100, PAPEL.RECEITA_OPERACIONAL), s(40, null)]);
  assert.equal(r.parcial, true);
  assert.equal(r.contagem.semPapel, 1);
  assert.equal(r.resultadoGerencial, 100);
  assert.equal(r.ponteResultadoCaixa.fecha, false);
});

test("estorno de receita reduz receita; devolução de custo reduz custo", () => {
  const r = apurar([e(1000, PAPEL.RECEITA_OPERACIONAL), s(100, PAPEL.RECEITA_OPERACIONAL), s(500, PAPEL.CUSTO_VARIAVEL), e(50, PAPEL.CUSTO_VARIAVEL)]);
  assert.equal(r.receitaOperacional, 900);
  assert.equal(r.custosVariaveis, 450);
});

test("entrada inválida é rejeitada (float, negativo, sentido, papel)", () => {
  assert.throws(() => apurar([{ sentido: "entrada", valorCentavos: 1.5, papel: PAPEL.RECEITA_OPERACIONAL }]), TypeError);
  assert.throws(() => apurar([{ sentido: "entrada", valorCentavos: -1, papel: PAPEL.RECEITA_OPERACIONAL }]), TypeError);
  assert.throws(() => apurar([{ sentido: "x", valorCentavos: 1, papel: PAPEL.RECEITA_OPERACIONAL }]), TypeError);
  assert.throws(() => apurar([{ sentido: "entrada", valorCentavos: 1, papel: "inventado" }]), TypeError);
});

test("saldos por conta: abertura desconhecida não vira zero e deixa o total parcial", () => {
  const contas = [{ id: "A", nome: "Conta A" }, { id: "B", nome: "Conta B" }];
  const ls = [e(1000, PAPEL.RECEITA_OPERACIONAL), s(300, PAPEL.CUSTO_VARIAVEL, { contaId: "B" }), e(999, PAPEL.SALDO_ANTERIOR)];
  const parcial = saldosPorConta(contas, { A: 500, B: null }, ls);
  assert.equal(parcial.contas[0].saldoCentavos, 1500);
  assert.equal(parcial.contas[1].saldoCentavos, null);
  assert.equal(parcial.contas[1].saldoSemAberturaCentavos, -300);
  assert.equal(parcial.parcial, true);
  assert.equal(parcial.totalCentavos, null);
  assert.equal(saldosPorConta(contas, new Map([["A", 500], ["B", 0]]), ls).totalCentavos, 1200);
});

test("transferência pareada fecha em zero; par defeituoso é denunciado", () => {
  const ok = [s(700, PAPEL.TRANSFERENCIA, { parId: "p1", contaId: "A" }), e(700, PAPEL.TRANSFERENCIA, { parId: "p1", contaId: "B" })];
  assert.deepEqual(validarParesTransferencia(ok), []);
  assert.equal(apurar(ok).transferencias.liquidasExternas, 0);
  assert.equal(apurar(ok).resultadoGerencial, 0);
  const ruim = [s(700, PAPEL.TRANSFERENCIA, { parId: "p2" }), e(699, PAPEL.TRANSFERENCIA, { parId: "p2", contaId: "B" })];
  assert.equal(validarParesTransferencia(ruim)[0].motivo, "par não fecha em zero");
  const mesma = [s(5, PAPEL.TRANSFERENCIA, { parId: "p3" }), e(5, PAPEL.TRANSFERENCIA, { parId: "p3" })];
  assert.equal(validarParesTransferencia(mesma)[0].motivo, "pernas na mesma conta");
});

test("plano de contas: papel vem do dado; combinação desconhecida fica pendente", () => {
  assert.equal(papelDeTipoNatureza("TRIBUTAÇÃO", "IMPOSTO"), PAPEL.TRIBUTO);
  assert.equal(papelDeTipoNatureza("Despesa", "pessoal"), PAPEL.DESPESA_PESSOAL);
  assert.equal(papelDeTipoNatureza("CUSTO", "FIXO"), null);
  assert.deepEqual(validarCategoria({ id: 1, nome: "x", papel: PAPEL.TRIBUTO }), []);
  assert.equal(validarCategoria({ id: 1, nome: " ", papel: "zzz" }).length, 2);
});

test("catálogo de indicadores: todo indicador tem fórmula e origem; alias aponta para existente", () => {
  const ids = new Set(INDICADORES.map((i) => i.id));
  for (const i of INDICADORES) {
    assert.ok(i.formula && i.origem, i.id);
    if (i.aliasDe) assert.ok(ids.has(i.aliasDe));
  }
});
