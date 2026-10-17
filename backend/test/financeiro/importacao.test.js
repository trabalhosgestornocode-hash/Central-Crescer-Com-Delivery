import { test } from "node:test";
import assert from "node:assert/strict";
import { paraDataISO, normalizarLinhas, atribuirChaves, montarPrevia, sugerirPares, aplicarDecisoesPares, MOTIVO } from "../../src/financeiro-calculos/importacao.js";

// Tudo sintético.
let n = 1;
const L = (o) => ({ linha: ++n, data: "2026-09-01", descricao: "ITEM", entrada: 0, saida: 0, tipo: "DESPESA", natureza: "FIXA", categoria: "X", conta: "CONTA1", ...o });
const arquivo = () => [
  L({ descricao: "VENDA A", entrada: 100.5, tipo: "RECEITA", natureza: "RECEBIMENTO DE CLIENTE", categoria: "RECEBIMENTO DE CLIENTE" }),
  L({ descricao: "ALUGUEL", saida: 50 }),
  L({ descricao: "TARIFA", saida: 1.63, tipo: "DESPESA", natureza: "FINANCEIRAS", categoria: "TARIFAS" }),
  L({ descricao: "TARIFA", saida: 1.63, tipo: "DESPESA", natureza: "FINANCEIRAS", categoria: "TARIFAS" }),
  L({ descricao: "SALDO MÊS ANTERIOR - CONTA1", entrada: 10, tipo: "SALDO ANTERIOR", natureza: "SALDO ANTERIOR", categoria: "SALDO ANTERIOR" }),
];

test("data: serial Excel, Date UTC, ISO, dd/mm/aaaa e inválidas", () => {
  assert.equal(paraDataISO(46266), "2026-09-01");
  assert.equal(paraDataISO(new Date(Date.UTC(2026, 8, 1))), "2026-09-01");
  assert.equal(paraDataISO("01/09/2026"), "2026-09-01");
  assert.equal(paraDataISO("2026-02-30"), null);
  assert.equal(paraDataISO("31/02/2026"), null);
  assert.equal(paraDataISO("abc"), null);
  assert.equal(paraDataISO(5), null);
});

test("normalização: erros por linha, saldo anterior separado dos lançamentos", () => {
  const r = normalizarLinhas([
    ...arquivo(),
    L({ entrada: 5, saida: 5 }), L({}), L({ data: "x", saida: 1 }), L({ conta: "", saida: 1 }), L({ saida: 1.005 }),
  ]);
  assert.equal(r.lancamentos.length, 4);
  assert.equal(r.saldos.length, 1);
  assert.equal(r.erros.length, 5);
  assert.ok(r.erros.some((e) => /simultaneamente|mesma linha/.test(e.motivo) || /entrada e saída/.test(e.motivo)));
});

test("chaves: reimportar e reordenar produzem o mesmo conjunto; duplicata legítima ganha #1 e #2", () => {
  const a = atribuirChaves(normalizarLinhas(arquivo()).lancamentos);
  const b = atribuirChaves(normalizarLinhas([...arquivo()].reverse()).lancamentos);
  assert.deepEqual(new Set(a.map((x) => x.chave)), new Set(b.map((x) => x.chave)));
  const tarifas = a.filter((x) => x.descricao === "TARIFA").map((x) => x.chave);
  assert.equal(new Set(tarifas).size, 2);
  assert.ok(tarifas[0].endsWith("#1") && tarifas[1].endsWith("#2"));
});

test("chave ignora comentário e fórmula (adicionar nota não gera registro novo)", () => {
  const sem = atribuirChaves(normalizarLinhas([L({ saida: 7 })]).lancamentos)[0];
  const com = atribuirChaves(normalizarLinhas([L({ saida: 7, comentario: "conferir", formulaSaida: "=10-3" })]).lancamentos)[0];
  assert.equal(sem.chave, com.chave);
});

test("prévia: primeira importação tudo novo; mesma coisa depois = tudo existente, nada a gravar", () => {
  const p1 = montarPrevia({ brutas: arquivo() });
  assert.equal(p1.resumo.novos, 4);
  assert.equal(p1.resumo.saldos, 1);
  assert.equal(p1.resumo.identicas, 2);
  const existentes = p1.lancamentos.map((l) => ({ chave: l.chave, dataISO: l.data, conta: l.conta, sentido: l.sentido, valorCentavos: l.valor_centavos, descricao: l.descricao }));
  const p2 = montarPrevia({ brutas: [...arquivo()].reverse(), existentes });
  assert.equal(p2.resumo.novos, 0);
  assert.equal(p2.resumo.existentes, 4);
  assert.equal(p2.lancamentos.filter((l) => l.importar).length, 0);
  assert.equal(p2.hashConteudo, p1.hashConteudo);
});

test("linha editada vira possível alteração, não é importada sem aceite e o antigo NÃO é excluído", () => {
  const p1 = montarPrevia({ brutas: arquivo() });
  const existentes = p1.lancamentos.map((l) => ({ chave: l.chave, dataISO: l.data, conta: l.conta, sentido: l.sentido, valorCentavos: l.valor_centavos, descricao: l.descricao }));
  const editado = arquivo().map((b) => (b.descricao === "ALUGUEL" ? { ...b, descricao: "ALUGUEL SALA 2" } : b));
  const p2 = montarPrevia({ brutas: editado, existentes });
  const alt = p2.lancamentos.find((l) => l.status === "possivel_alteracao");
  assert.ok(alt && alt.importar === false && alt.motivos.includes(MOTIVO.POSSIVEL_ALTERACAO));
  assert.equal(p2.resumo.ausentesNoArquivo, 1);
  assert.equal(p2.ausentes[0].descricao, "ALUGUEL");
  const p3 = montarPrevia({ brutas: editado, existentes, aceitarAlteracoes: new Set([alt.chave]) });
  assert.equal(p3.lancamentos.find((l) => l.chave === alt.chave).importar, true);
});

test("pendências: sem papel, 'a identificar', comentário, fórmula e idênticas ficam sinalizadas e preservadas", () => {
  const p = montarPrevia({ brutas: [
    L({ saida: 10, tipo: "OUTRO", natureza: "INEXISTENTE", categoria: "Z" }),
    L({ saida: 20, descricao: "PIX ENVIADO", categoria: "PIX A IDENTIFICAR", natureza: "VARIAVEL" }),
    L({ saida: 30, comentario: "Confirmar categoria", descricao: "FAVORECIDO NOVO" }),
    L({ entrada: 140, formulaEntrada: "=245-106", tipo: "RECEITA", natureza: "RECEBIMENTO DE CLIENTE", categoria: "RECEBIMENTO DE CLIENTE", descricao: "DINHEIRO" }),
  ] });
  const por = (d) => p.lancamentos.find((l) => l.descricao === d);
  assert.equal(por("ITEM").categoria, null);
  assert.equal(por("ITEM").pendente, true);
  assert.equal(por("PIX ENVIADO").pendente, true);
  assert.ok(por("PIX ENVIADO").motivos.includes(MOTIVO.A_IDENTIFICAR));
  assert.match(por("FAVORECIDO NOVO").nota, /Confirmar categoria/);
  assert.match(por("DINHEIRO").nota, /=245-106/);
  assert.equal(p.resumo.semPapel, 1);
  assert.equal(p.resumo.comFormula, 1);
  assert.equal(p.resumo.comComentario, 1);
  assert.equal(p.categorias.some((c) => c.nome === "Z"), false); // categoria sem papel não vira plano de contas por chute
});

const T = (o) => L({ tipo: "TRANSFERENCIA", natureza: "TRANSFERENCIA ENTRE CONTAS", categoria: "ENTRE CONTAS", ...o });

test("pares: contraparte única e mútua = alta confiança; nada é confirmado automaticamente", () => {
  const ls = atribuirChaves(normalizarLinhas([
    T({ descricao: "TRANSFERENCIA STONE → UNICRED", saida: 300, conta: "STONE" }),
    T({ descricao: "TRANSFERENCIA STONE → UNICRED", entrada: 300, conta: "UNICRED" }),
  ]).lancamentos);
  const pares = sugerirPares(ls);
  assert.equal(pares.length, 1);
  assert.equal(pares[0].confianca, "alta");
  assert.equal(pares[0].confirmado, false);
});

test("pares: dois pares idênticos de mesmo valor/data são ambíguos sem evidência; com evidência de contas desempata", () => {
  const amb = atribuirChaves(normalizarLinhas([
    T({ descricao: "T1", saida: 100, conta: "A" }), T({ descricao: "T2", saida: 100, conta: "B" }),
    T({ descricao: "T3", entrada: 100, conta: "C" }), T({ descricao: "T4", entrada: 100, conta: "D" }),
  ]).lancamentos);
  assert.ok(sugerirPares(amb).every((p) => p.confianca === "ambigua"));
  const claro = atribuirChaves(normalizarLinhas([
    T({ descricao: "TRANSFERENCIA A → C", saida: 100, conta: "A" }), T({ descricao: "TRANSFERENCIA B → D", saida: 100, conta: "B" }),
    T({ descricao: "TRANSFERENCIA A → C", entrada: 100, conta: "C" }), T({ descricao: "TRANSFERENCIA B → D", entrada: 100, conta: "D" }),
  ]).lancamentos);
  const ps = sugerirPares(claro);
  assert.equal(ps.length, 2);
  assert.ok(ps.every((p) => p.confianca === "alta"));
  assert.notEqual(ps[0].entrada, ps[1].entrada);
});

test("pares: perna sem contraparte (movimento externo) não gera par e fica pendente; decisão humana limpa só as confirmadas", () => {
  const p = montarPrevia({ brutas: [
    T({ descricao: "PAGAMENTO TERCEIRO", saida: 500, conta: "A" }),
    T({ descricao: "TRANSFERENCIA A → B", saida: 40, conta: "A" }), T({ descricao: "TRANSFERENCIA A → B", entrada: 40, conta: "B" }),
  ] });
  assert.equal(p.pares.length, 1);
  assert.equal(p.resumo.pendentes, 3); // nada confirmado ainda
  const d = aplicarDecisoesPares(p, { confirmarAltaConfianca: true });
  assert.equal(d.resumo.paresConfirmados, 1);
  assert.equal(d.resumo.pendentes, 1);
  assert.equal(d.lancamentos.find((l) => l.descricao === "PAGAMENTO TERCEIRO").pendente, true);
  const r = aplicarDecisoesPares(p, { confirmarAltaConfianca: true, rejeitar: [p.pares[0].id] });
  assert.equal(r.resumo.paresConfirmados, 0);
});

test("pares ambíguos nunca são confirmados pelo atalho de alta confiança", () => {
  const p = montarPrevia({ brutas: [
    T({ descricao: "T1", saida: 100, conta: "A" }), T({ descricao: "T2", saida: 100, conta: "B" }),
    T({ descricao: "T3", entrada: 100, conta: "C" }), T({ descricao: "T4", entrada: 100, conta: "D" }),
  ] });
  assert.equal(aplicarDecisoesPares(p, { confirmarAltaConfianca: true }).resumo.paresConfirmados, 0);
  assert.equal(aplicarDecisoesPares(p, { confirmar: [p.pares[0].id] }).resumo.paresConfirmados, 1);
});

test("conferência de totais declarados no arquivo, ao centavo", () => {
  const brutas = arquivo();
  const ok = montarPrevia({ brutas, totalDeclarado: { entradaCentavos: 10050 + 1000, saidaCentavos: 5000 + 163 + 163 } });
  assert.equal(ok.resumo.conferencia.confere, true);
  const nao = montarPrevia({ brutas, totalDeclarado: { entradaCentavos: 1, saidaCentavos: 1 } });
  assert.equal(nao.resumo.conferencia.confere, false);
  assert.equal(montarPrevia({ brutas }).resumo.conferencia.confere, null);
});

test("contas sem abertura informada são listadas (nunca assumidas como zero)", () => {
  const p = montarPrevia({ brutas: [L({ saida: 1, conta: "SEM" }), L({ entrada: 9, conta: "COM", tipo: "SALDO ANTERIOR", natureza: "SALDO ANTERIOR", categoria: "SALDO ANTERIOR" })] });
  assert.deepEqual(p.resumo.contasSemAbertura, ["SEM"]);
});
