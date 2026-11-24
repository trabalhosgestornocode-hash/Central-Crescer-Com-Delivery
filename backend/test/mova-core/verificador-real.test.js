// MOVA CORE — regressão a partir da AVALIAÇÃO REAL (Haiku 5.5, 24/11): respostas CORRETAS do modelo que o verificador reprovava
// (falso positivo) — e as versões adulteradas delas, que continuam reprovadas. Dados sintéticos da base de avaliação.
import assert from "node:assert/strict";
import test from "node:test";
import { verificarFidelidade } from "../../src/modules/mova-core/verificador.js";

const f = (valorCentavos, significado, entidade = null, periodo = null) => ({ valorCentavos, significado, entidade, periodo });
const UNIDADES = ["Alfa Centro", "Alfa Norte"];
const ATENCAO = [f(70400, "A_PAGAR_VENCIDO"), f(54000, "A_PAGAR_VENCIDO", "Atacadão Embalagens", "2026-11"), f(54000, "VALOR_DAS_CONTAS", "Atacadão Embalagens", "2026-11"),
  f(16400, "A_PAGAR_VENCIDO", "Laticínios Serra", "2026-11"), f(26400, "VALOR_DAS_CONTAS", "Laticínios Serra", "2026-11"), f(10000, "PAGO", "Laticínios Serra", "2026-11"),
  f(46200, "A_PAGAR_EM_ABERTO", "Matheus Rocha", "2026-11"), f(89000, "A_PAGAR_EM_ABERTO", "Energia Elétrica", "2026-11"), f(18500, "A_PAGAR_EM_ABERTO", "Doce Brownie Ltda", "2026-11"),
  f(224100, "A_PAGAR_EM_ABERTO", null, "..2026-12-01")];
const LISTA = `Na unidade Alfa Centro, hoje (24/11/2026), tem duas contas vencidas e três que vencem até 01/12.

Vencidas, saldo de R$ 704,00:
• Atacadão Embalagens, copos e tampas: R$ 540,00, venceu em 18/11.
• Laticínios Serra, leite e creme: R$ 164,00 em aberto (já pagou R$ 100,00 de R$ 264,00), venceu em 22/11.

Vencem nos próximos dias:
• Matheus Rocha, entregas da semana 16/11: R$ 462,00, vence em 25/11.
• Energia Elétrica, conta de luz de novembro: R$ 890,00, vence em 28/11.
• Doce Brownie Ltda, brownies da 2ª quinzena: R$ 185,00, vence em 28/11.

No total, o que está em aberto até 01/12 soma R$ 2.241,00.`;

test("VR-01 lista real de contas (entidade ANTES do valor, pagamento parcial 'pagou X de Y'): aprovada", () => {
  const v = verificarFidelidade(LISTA, { fatos: ATENCAO, unidades: UNIDADES });
  assert.deepEqual(v.violacoes, []);
});

test("VR-02 a mesma lista com valores TROCADOS entre fornecedores continua reprovada", () => {
  const trocada = LISTA.replace("Energia Elétrica, conta de luz de novembro: R$ 890,00", "Energia Elétrica, conta de luz de novembro: R$ 185,00").replace("brownies da 2ª quinzena: R$ 185,00", "brownies da 2ª quinzena: R$ 890,00");
  const v = verificarFidelidade(trocada, { fatos: ATENCAO, unidades: UNIDADES });
  assert.ok(v.violacoes.filter((x) => x.tipo === "ENTIDADE_TROCADA").length >= 2, JSON.stringify(v.violacoes));
});

test("VR-03 pagamento parcial dito como EM ABERTO (R$ 100 pagos chamados de 'devemos') continua reprovado", () => {
  const v = verificarFidelidade("À Laticínios Serra devemos R$ 100,00.", { fatos: ATENCAO, unidades: UNIDADES });
  assert.ok(v.violacoes.some((x) => x.tipo === "SIGNIFICADO_TROCADO"));
});

const CAIXA = [f(1866250, "SALDO_CALCULADO", "todas as contas", "2026-11-24"), f(1825000, "SALDO_CALCULADO", "Banco Inter", "2026-11-24"), f(1825000, "SALDO_INFORMADO", "Banco Inter", "2026-11-23"),
  f(41250, "SALDO_CALCULADO", "Caixa físico", "2026-11-24"), f(40000, "SALDO_INFORMADO", "Caixa físico", "2026-11-23"), f(-1250, "DIFERENCA_DE_SALDO", "Caixa físico", "2026-11-24")];

test("VR-04 total CONSOLIDADO real ('somando caixa físico e bancos. Não é só o Banco Inter'): aprovado", () => {
  const t = `O saldo final consolidado de Alfa Centro, até 24/11/2026, é de **R$ 18.662,50**.

• Banco Inter: R$ 18.250,00 (bate com o saldo informado em 23/11)
• Caixa físico: R$ 412,50 calculados, mas o saldo informado no fim do dia 23/11 foi de R$ 400,00. A diferença de R$ 12,50 ainda não foi ajustada.`;
  assert.deepEqual(verificarFidelidade(t, { fatos: CAIXA, unidades: UNIDADES }).violacoes, []);
  const t2 = "Os R$ 18.662,50 são o total consolidado da unidade Alfa Centro, somando caixa físico e bancos. Não é só o Banco Inter.";
  assert.deepEqual(verificarFidelidade(t2, { fatos: CAIXA, unidades: UNIDADES }).violacoes, []);
});

test("VR-05 o consolidado atribuído a UMA conta continua reprovado ('o Banco Inter tem R$ 18.662,50')", () => {
  const v = verificarFidelidade("O Banco Inter tem R$ 18.662,50.", { fatos: CAIXA, unidades: UNIDADES });
  assert.ok(v.violacoes.some((x) => x.tipo === "ENTIDADE_TROCADA"), JSON.stringify(v.violacoes));
});

test("VR-06 'vencida, valor de R$ 264,00, com R$ 100,00 já pagos' (total da conta) aprovado; 'valor vencido de R$ 264,00' reprovado", () => {
  const ok = "• Laticínios Serra (leite e creme): vencida em 22/11/2026, valor de R$ 264,00, com R$ 100,00 já pagos. Falta R$ 164,00.";
  assert.deepEqual(verificarFidelidade(ok, { fatos: ATENCAO, unidades: UNIDADES }).violacoes, []);
  const ruim = "• Laticínios Serra: valor vencido de R$ 264,00.";
  assert.ok(verificarFidelidade(ruim, { fatos: ATENCAO, unidades: UNIDADES }).violacoes.some((x) => x.tipo === "SIGNIFICADO_TROCADO"));
});

test("VR-07 (rodada real completa) negação, descritor colado depois do valor, 'em contas a pagar' e 'valor informado'", () => {
  const ent = [f(46200, "ENTREGADOR_A_PAGAR", "Matheus Rocha"), f(46200, "A_PAGAR_EM_ABERTO", "Matheus Rocha"), f(39900, "ENTREGADOR_PAGO", "Matheus Rocha")];
  assert.deepEqual(verificarFidelidade("• Semana de 16/11: 42 entregas, R$ 462,00, ainda não pago. Vence em 25/11.", { fatos: ent }).violacoes, []);
  const br = [f(32000, "PAGO", "Doce Brownie Ltda"), f(32000, "VALOR_DAS_CONTAS", "Doce Brownie Ltda"), f(18500, "A_PAGAR_EM_ABERTO", "Doce Brownie Ltda"), f(18500, "VALOR_DAS_CONTAS", "Doce Brownie Ltda"), f(50500, "VALOR_DAS_CONTAS", "brownie")];
  assert.deepEqual(verificarFidelidade("Total do mês: R$ 505,00, sendo R$ 320,00 pagos e R$ 185,00 a pagar.", { fatos: br }).violacoes, []);
  assert.deepEqual(verificarFidelidade("No mês, o brownie somou R$ 505,00 em contas a pagar.", { fatos: br }).violacoes, []);
  assert.deepEqual(verificarFidelidade("O valor informado no fim do dia 23/11 foi R$ 400,00.", { fatos: CAIXA }).violacoes, []);
  // e continuam barrados:
  assert.ok(verificarFidelidade("Total do mês: R$ 505,00, sendo R$ 185,00 pagos e R$ 320,00 a pagar.", { fatos: br }).violacoes.some((x) => x.tipo === "SIGNIFICADO_TROCADO"));
  assert.ok(verificarFidelidade("Semana de 09/11: R$ 399,00, ainda não pago.", { fatos: ent }).violacoes.some((x) => x.tipo === "SIGNIFICADO_TROCADO"));
});

// ---- avaliação real 2 (24/11, conjunto AJUSTE) ----
const passa = (t, fatos) => assert.deepEqual(verificarFidelidade(t, { fatos, unidades: UNIDADES }).violacoes, [], t);
const barra = (t, fatos, tipo = "SIGNIFICADO_TROCADO") => assert.ok(verificarFidelidade(t, { fatos, unidades: UNIDADES }).violacoes.some((v) => v.tipo === tipo), t);
const BROWNIE = [f(32000, "PAGO", "Doce Brownie Ltda"), f(32000, "VALOR_DAS_CONTAS", "Doce Brownie Ltda"), f(18500, "A_PAGAR_EM_ABERTO", "Doce Brownie Ltda"), f(18500, "VALOR_DAS_CONTAS", "Doce Brownie Ltda")];

test("VR-08 parêntese de OUTRO valor e termo da oração anterior não descrevem este valor", () => {
  passa("Novembro tem duas compras: a 1ª quinzena (R$ 320,00, paga) e a 2ª quinzena (R$ 185,00, ainda em aberto).", BROWNIE);
  passa("Desse valor, R$ 320,00 já foram pagos e R$ 185,00 estão em aberto.", BROWNIE);
  passa("Já foram pagos R$ 320,00 e falta pagar R$ 185,00.", BROWNIE);
  barra("Já foram pagos R$ 185,00 e falta pagar R$ 320,00.", BROWNIE);
});

test("VR-09 'colado depois' só sem vírgula; sufixo societário e plural; total entre banco e caixa", () => {
  const LAT = [f(26400, "VALOR_DAS_CONTAS", "Laticínios Serra"), f(10000, "PAGO", "Laticínios Serra"), f(16400, "A_PAGAR_VENCIDO", "Laticínios Serra")];
  passa("Laticínios Serra: valor original R$ 264,00, já pago R$ 100,00, saldo em aberto de R$ 164,00.", LAT);
  passa("Laticínios Serra: R$ 164,00 restantes.", LAT);
  barra("Laticínios Serra: R$ 264,00 restantes.", LAT);
  passa("A vencer: Doce Brownie (R$ 185,00, vence 28/11).", BROWNIE);
  passa("Também entrou 1 reforço de caixa, de R$ 200,00, que não entra na conta das sangrias.", [f(20000, "REFORCOS_DO_CAIXA", "reforços"), f(12500, "RETIRADAS_DO_CAIXA", "sangrias")]);
  passa("Hoje há R$ 18.662,50 entre banco e caixa.", [f(1866250, "SALDO_CALCULADO", "todas as contas"), f(1825000, "SALDO_CALCULADO", "bancos")]);
});

test("VR-10 termo entre aspas é citado; valor operando de divisão; 'nenhuma paga'; 'o que foi registrado' não é escrita", () => {
  const T = [f(584100, "VALOR_DAS_CONTAS"), f(574100, "A_PAGAR_EM_ABERTO")];
  passa('Eu tinha chamado R$ 5.841,00 de "em aberto", mas esse é o valor total das contas.', T);
  barra("Em aberto no total: R$ 5.841,00.", T);
  passa("O valor por entrega é a média (R$ 418,00 ÷ 38).", [f(41800, "ENTREGADOR_PAGO", "Joana Prado")]);
  passa("Vencem 3 contas, somando R$ 1.537,00, nenhuma paga ainda.", [f(153700, "A_PAGAR_EM_ABERTO")]);
  passa("O CMV foi de R$ 29.900,00; é o que foi registrado no período.", [f(2990000, "DRE:cmvCentavos")]);
  barra("Pronto, foi registrado: R$ 15,00 de grampos.", [f(1500, "INFORMADO_PELA_PESSOA")], "ESCRITA_SIMULADA");
  passa("O repasse do iFood, no valor líquido de R$ 23.100,00, está previsto.", [f(2310000, "A_RECEBER", "IFOOD")]);
  passa("Total em aberto: R$ 27.900,00 a receber.", [f(2790000, "A_RECEBER")]);
  barra("Devemos R$ 27.900,00.", [f(2790000, "A_RECEBER")]);
});
