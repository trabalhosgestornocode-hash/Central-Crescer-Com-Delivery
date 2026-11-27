// 27/11 — leitura documental: UMA nova tentativa com saída de até 2400 tokens, só quando a 1ª resposta foi cortada por
// max_tokens; as duas chamadas somadas cabem no custo máximo da leitura; resposta cortada nunca é lida. Cliente simulado.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITE_DA_LEITURA_MICROUSD, SAIDA_MAXIMA_PADRAO, SAIDA_MAXIMA_RETENTATIVA, criarExtratorAnthropic } from "../../src/modules/mova-financeiro/ia/provedorAnthropic.js";
import { clienteComOrcamento } from "../../src/modules/mova-financeiro/infra/operacao.js";

const JSON_OK = JSON.stringify({ legivel: true, tipoDocumento: "COMPROVANTE_PAGAMENTO" });
const resposta = (stop, { entrada = 7000, saida = 1200, texto = JSON_OK } = {}) => ({
  model: "claude-haiku-5-5", stop_reason: stop, usage: { input_tokens: entrada, output_tokens: saida },
  content: [{ type: "text", text: stop === "max_tokens" ? texto.slice(0, 20) : texto }],
});
function cliente(roteiro) {
  const pedidos = [];
  return { pedidos, beta: { messages: { async create(req) { pedidos.push(req); return roteiro[pedidos.length - 1] ?? roteiro.at(-1); } } } };
}
const extrair = (c) => criarExtratorAnthropic({ cliente: c, obterEvidencia: async () => null }).extrair({ texto: "comprovante", tipo: "TEXTO", midia: null });

test("resposta normal: UMA chamada, com o limite normal (1200) — o consumo padrão não aumenta", async () => {
  const c = cliente([resposta("end_turn", { saida: 500 })]);
  assert.equal((await extrair(c)).legivel, true);
  assert.deepEqual(c.pedidos.map((p) => p.max_tokens), [SAIDA_MAXIMA_PADRAO]);
  assert.deepEqual([SAIDA_MAXIMA_PADRAO, SAIDA_MAXIMA_RETENTATIVA], [1200, 2400]);
});

test("cortada por max_tokens: UMA nova tentativa com 2400 e a resposta completa é usada", async () => {
  const c = cliente([resposta("max_tokens"), resposta("end_turn", { saida: 1500 })]);
  assert.equal((await extrair(c)).tipoDocumento, "COMPROVANTE_PAGAMENTO");
  assert.deepEqual(c.pedidos.map((p) => p.max_tokens), [1200, 2400]);
  assert.equal(c.pedidos[1].model, "claude-haiku-5-5", "mesmo modelo (Haiku), sem troca");
});

test("cortada DE NOVO: falha com o motivo exato e nunca lê o JSON incompleto; no máximo 2 chamadas", async () => {
  const c = cliente([resposta("max_tokens"), resposta("max_tokens", { saida: 2400 })]);
  await assert.rejects(extrair(c), (e) => e.codigo === "IA_RESPOSTA_TRUNCADA" && e.detalhe === "APOS_NOVA_TENTATIVA");
  assert.equal(c.pedidos.length, 2);
});

test("custo das DUAS chamadas acima do máximo da leitura: sem nova tentativa (motivo registrado)", async () => {
  const c = cliente([resposta("max_tokens", { entrada: 60_000 })]);
  await assert.rejects(extrair(c), (e) => e.codigo === "IA_RESPOSTA_TRUNCADA" && e.detalhe === "SEM_NOVA_TENTATIVA_CUSTO");
  assert.equal(c.pedidos.length, 1);
  assert.equal(LIMITE_DA_LEITURA_MICROUSD, 100_000);
});

test("recusa ou modelo inesperado na nova tentativa: falha, nada é lido", async () => {
  await assert.rejects(extrair(cliente([resposta("max_tokens"), resposta("refusal")])), (e) => e.codigo === "IA_RECUSOU");
  const outro = cliente([resposta("max_tokens"), { ...resposta("end_turn"), model: "claude-sonnet-5-5" }]);
  await assert.rejects(extrair(outro), (e) => e.codigo === "IA_MODELO_INESPERADO");
});

test("com o orçamento e o teto estrito: cada chamada é reservada; o teto de saída limita a 2ª (2400 com o teto em 2400)", async () => {
  const reservas = [];
  const orcamento = { async reservar(x) { reservas.push(x); return reservas.length; }, async acertar() {}, async falhar() {} };
  const base = cliente([resposta("max_tokens"), resposta("end_turn")]);
  base.beta.messages.countTokens = async () => ({ input_tokens: 7000 });
  const c = clienteComOrcamento(base, { orcamento, teto: { maxSaida: 2400, maxEntrada: 20000 } });
  assert.equal((await criarExtratorAnthropic({ cliente: c, obterEvidencia: async () => null }).extrair({ texto: "x", tipo: "TEXTO", midia: null })).legivel, true);
  assert.deepEqual(base.pedidos.map((p) => p.max_tokens), [1200, 2400]);
  assert.equal(reservas.length, 2, "as duas chamadas passam pelo orçamento");
});
