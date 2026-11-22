// MOVA — Agente 2, Frente C: política de AUTONOMIA (pura, sem banco, sem rede). Nada aqui escreve no Financeiro.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NIVEL, OPERACAO, conferirComExtrato, decidirAutonomia, validarPolitica, validarPoliticas } from "../../src/modules/mova-financeiro/dominio/autonomia.js";

const ORG = "dddddddd-0000-4000-8000-0000000000a2";
const ORG_X = "dddddddd-0000-4000-8000-0000000000b2";
const ALFA = "eeeeeeee-0000-4000-8000-0000000000a1";
const BETA = "eeeeeeee-0000-4000-8000-0000000000b1";
const pol = (x = {}) => ({ id: "p1", operacao: OPERACAO.BAIXA_POR_EXTRATO, organizacaoId: ORG, unidadeId: null, nivel: NIVEL.APLICAR_AUTOMATICO, limiteCentavos: 50000,
  responsavel: "Administrador Sintético", motivo: "Piloto de baixa automática por extrato", vigenteDe: "2026-10-01", ...x });
const HOJE = "2026-10-15";
const CONF = { situacao: "CONFERIDA", candidatas: 1 };
const dec = (politicas, x = {}) => decidirAutonomia({ politicas: validarPoliticas(politicas), operacao: OPERACAO.BAIXA_POR_EXTRATO, organizacaoId: ORG, unidadeId: ALFA, valorCentavos: 30000, hoje: HOJE, conciliacao: CONF, ...x });

test("A2-C1 sem política ⇒ SOMENTE_PROPOR; pagamento bancário/exclusão/estorno ⇒ PROIBIDO sempre", () => {
  assert.equal(dec([]).nivel, NIVEL.SOMENTE_PROPOR);
  for (const op of ["PAGAMENTO_BANCARIO", "EXCLUSAO", "ESTORNO", "TRANSFERENCIA", "QUALQUER"]) assert.equal(dec([pol()], { operacao: op }).nivel, NIVEL.PROIBIDO);
  assert.throws(() => validarPolitica(pol({ operacao: "PAGAMENTO_BANCARIO" })), /operacao/);
});

test("A2-C2 limite de valor: acima do limite cai um nível; valor inválido não aplica", () => {
  assert.equal(dec([pol()]).nivel, NIVEL.APLICAR_AUTOMATICO);
  assert.deepEqual(dec([pol()], { valorCentavos: 60000 }), { nivel: NIVEL.APLICAR_COM_CONFIRMACAO, motivos: ["ACIMA_DO_LIMITE"], politicaId: "p1" });
  assert.equal(dec([pol({ nivel: NIVEL.APLICAR_COM_CONFIRMACAO })], { valorCentavos: 60000 }).nivel, NIVEL.SOMENTE_PROPOR);
  assert.equal(dec([pol()], { valorCentavos: 0 }).nivel, NIVEL.SOMENTE_PROPOR);
});

test("A2-C3 imagem isolada não liquida: sem extrato conferido (ou ambíguo) ⇒ SOMENTE_PROPOR", () => {
  assert.deepEqual(dec([pol()], { conciliacao: null }).motivos, ["SEM_EXTRATO_CONFERIDO"]);
  assert.deepEqual(dec([pol()], { conciliacao: { situacao: "AMBIGUA" } }).motivos, ["EXTRATO_AMBIGUO"]);
  // Anexar documento não liquida: não exige extrato.
  assert.equal(dec([pol({ operacao: OPERACAO.ANEXAR_DOCUMENTO })], { operacao: OPERACAO.ANEXAR_DOCUMENTO, conciliacao: null }).nivel, NIVEL.APLICAR_AUTOMATICO);
});

test("A2-C4 escopo: unidade prevalece sobre empresa; nunca vale para outra empresa; vigência e revogação imediatas", () => {
  const empresa = pol({ id: "emp", nivel: NIVEL.APLICAR_COM_CONFIRMACAO });
  const soBeta = pol({ id: "beta", unidadeId: BETA, nivel: NIVEL.APLICAR_AUTOMATICO });
  assert.equal(dec([empresa, soBeta]).politicaId, "emp");
  assert.equal(dec([empresa, soBeta], { unidadeId: BETA }).politicaId, "beta");
  assert.equal(dec([empresa], { organizacaoId: ORG_X }).nivel, NIVEL.SOMENTE_PROPOR);
  assert.equal(dec([pol({ vigenteDe: "2026-11-01" })]).nivel, NIVEL.SOMENTE_PROPOR);
  assert.equal(dec([pol({ vigenteAte: "2026-10-10" })]).nivel, NIVEL.SOMENTE_PROPOR);
  assert.equal(dec([pol({ revogadaEm: "2026-10-14T10:00:00Z" })]).nivel, NIVEL.SOMENTE_PROPOR);
});

test("A2-C5 política exige responsável, motivo, limite e chaves conhecidas; conta a pagar nova nunca é automática; sem sobreposição", () => {
  assert.throws(() => validarPolitica(pol({ responsavel: "" })), /responsavel/);
  assert.throws(() => validarPolitica(pol({ motivo: "curto" })), /motivo/);
  assert.throws(() => validarPolitica(pol({ limiteCentavos: 0 })), /limiteCentavos/);
  assert.throws(() => validarPolitica(pol({ sql: "drop" })), /sql/);
  assert.throws(() => validarPolitica(pol({ operacao: OPERACAO.CONTA_A_PAGAR })), /automática/);
  assert.throws(() => validarPoliticas([pol({ id: "a" }), pol({ id: "b" })]), /vigentes/);
  assert.equal(validarPoliticas([pol({ id: "a", vigenteAte: "2026-10-31" }), pol({ id: "b", vigenteDe: "2026-11-01" })]).length, 2);
});

test("A2-C6 conferência com o extrato: valor exato e data próxima; ID desempata; duas iguais sem ID = AMBIGUA", () => {
  const c = { valorCentavos: 30000, dataPagamento: "2026-10-14", idTransacao: "E0000SINT01" };
  const s = (id, x = {}) => ({ id, data: "2026-10-14", disponivelCentavos: 30000, idExterno: null, ...x });
  assert.deepEqual(conferirComExtrato(c, [s("m1")]), { situacao: "CONFERIDA", candidatas: 1, movimentacaoId: "m1" });
  assert.equal(conferirComExtrato(c, [s("m1", { disponivelCentavos: 29999 })]).situacao, "AGUARDANDO_EXTRATO");
  assert.equal(conferirComExtrato(c, [s("m1", { data: "2026-10-20" })]).situacao, "AGUARDANDO_EXTRATO");
  assert.equal(conferirComExtrato(c, [s("m1"), s("m2")]).situacao, "AMBIGUA");
  assert.equal(conferirComExtrato(c, [s("m1"), s("m2", { idExterno: "E0000SINT01" })]).movimentacaoId, "m2");
  assert.equal(conferirComExtrato(c, [s("m1", { idExterno: "OUTRO0001" })]).situacao, "AGUARDANDO_EXTRATO");
  assert.equal(conferirComExtrato({ ...c, dataPagamento: null }, [s("m1")]).situacao, "AGUARDANDO_EXTRATO");
});
