// Agente 2 — PILOTO DE LEITURA DOCUMENTAL (23/11/2026): US$ 1,00 e 20 chamadas, Haiku 5.5. PostgreSQL ISOLADO; cliente de IA
// SIMULADO (nenhuma chamada real, nenhum custo). Confere a reserva antes da chamada, o limite acumulado (inclusive tentativas
// possivelmente faturadas), a concorrência, o desligamento imediato e o modelo exato.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clienteComOrcamento, criarControle, criarOrcamentoIa, falhaComRespostaDaApi, PRECOS_IA } from "../../src/modules/mova-financeiro/infra/operacao.js";
import { criarExtratorAnthropic, MODELO_PADRAO } from "../../src/modules/mova-financeiro/ia/provedorAnthropic.js";
import { lerConfiguracaoMova } from "../../src/modules/fv2-integracao/mova.js";
import { criarBancoMova, descartarBancoMova, motivoParaPularMova } from "./helpers/banco.js";

const pular = motivoParaPularMova();
// US$ 1,00 e 20 chamadas; reserva de US$ 0,02 por chamada (≈ 8× o pior caso sob o teto): até 20 em voo cabem no limite.
const PILOTO = { chamadas: 20, microusd: 1_000_000, reserva: 20_000 };
const TETO = Object.freeze({ maxSaida: 600, maxEntrada: 20000, esforco: "low" });

async function banco() {
  const b = await criarBancoMova();
  await b.pool.query("update mova.orcamento_ia set limite_chamadas = $1, limite_custo_microusd = $2, reserva_microusd = $3", [PILOTO.chamadas, PILOTO.microusd, PILOTO.reserva]);
  await b.pool.query("update mova.controle set ia = true, processamento = true, recebimento = true, suspenso = false");
  return b;
}
const fakeCliente = ({ falha = null, atraso = 0, modelo = MODELO_PADRAO, entrada = 1800, saida = 250 } = {}) => {
  const chamadas = { n: 0 };
  return { chamadas, beta: { messages: {
    async countTokens() { return { input_tokens: entrada }; },
    async create() {
      chamadas.n++;
      if (atraso) await new Promise((r) => setTimeout(r, atraso));
      if (falha) throw falha();
      return { model: modelo, stop_reason: "end_turn", usage: { input_tokens: entrada, output_tokens: saida }, content: [{ type: "text", text: "{}" }] };
    },
  } } };
};
const pedir = (c) => c.beta.messages.create({ model: MODELO_PADRAO, max_tokens: 600,
  messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }, { type: "text", text: "x" }] }] });
const totais = async (pool) => (await pool.query("select count(*)::int n, coalesce(sum(custo_microusd),0)::bigint c from mova.consumo_ia")).rows[0];

test("piloto IA — custo pelo preço do Haiku 5.5; pior caso por chamada (teto) cabe na reserva; 20 chamadas no máximo", { skip: pular }, async () => {
  const b = await banco();
  try {
    const orc = criarOrcamentoIa({ pool: b.pool });
    const [pe, ps] = PRECOS_IA["claude-haiku-5-5"];
    assert.deepEqual([pe, ps], [0.1, 0.5], "US$/milhão de tokens (até 100 mil de entrada)");
    const reserva = Number((await b.pool.query("select reserva_microusd from mova.orcamento_ia")).rows[0].reserva_microusd);
    assert.ok(TETO.maxEntrada * pe + TETO.maxSaida * ps < reserva, "o pior caso de uma chamada sob o teto é menor que a reserva");
    const cli = fakeCliente();
    const c = clienteComOrcamento(cli, { orcamento: orc, controle: criarControle({ pool: b.pool, cacheMs: 0 }), teto: TETO });
    for (let i = 0; i < 20; i++) await pedir(c);
    await assert.rejects(pedir(c), (e) => e.codigo === "ORCAMENTO_ESGOTADO");
    assert.equal(cli.chamadas.n, 20, "a 21ª nunca chega à API");
    const t = await totais(b.pool);
    assert.equal(t.n, 20);
    assert.equal(Number(t.c), 20 * Math.ceil(1800 * pe + 250 * ps), "custo real acertado por chamada");
    assert.ok(Number(t.c) < PILOTO.microusd);
  } finally { await descartarBancoMova(b); }
});

test("piloto IA — US$ 1,00 vale para o ACUMULADO, inclusive tentativas sem resposta (possivelmente faturadas)", { skip: pular }, async () => {
  const b = await banco();
  try {
    await b.pool.query("update mova.orcamento_ia set limite_chamadas = 100, reserva_microusd = 100000"); // isola o limite de custo
    const orc = criarOrcamentoIa({ pool: b.pool });
    const tempo = clienteComOrcamento(fakeCliente({ falha: () => Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }) }), { orcamento: orc });
    for (let i = 0; i < 9; i++) await assert.rejects(pedir(tempo));
    assert.equal(Number((await totais(b.pool)).c), 900_000, "9 × reserva de US$ 0,10 contadas como custo");
    const http = clienteComOrcamento(fakeCliente({ falha: () => Object.assign(new Error("overloaded"), { status: 529 }) }), { orcamento: orc });
    await assert.rejects(pedir(http));
    assert.equal(Number((await totais(b.pool)).c), 900_000, "erro com resposta da API não é faturado (custo 0), mas conta como tentativa");
    assert.equal(falhaComRespostaDaApi({ status: 400 }), true);
    assert.equal(falhaComRespostaDaApi({ name: "APIConnectionError" }), false);
    await pedir(clienteComOrcamento(fakeCliente(), { orcamento: orc })); // 900.000 + reserva = limite: ainda cabe uma
    await assert.rejects(pedir(clienteComOrcamento(fakeCliente(), { orcamento: orc })), (e) => e.codigo === "ORCAMENTO_ESGOTADO");
    assert.ok(Number((await totais(b.pool)).c) <= PILOTO.microusd);
  } finally { await descartarBancoMova(b); }
});

test("piloto IA — concorrência: 40 chamadas simultâneas com limite 20 → exatamente 20 chegam à API", { skip: pular }, async () => {
  const b = await banco();
  try {
    const cli = fakeCliente({ atraso: 30 });
    const c = clienteComOrcamento(cli, { orcamento: criarOrcamentoIa({ pool: b.pool }) });
    const r = await Promise.allSettled(Array.from({ length: 40 }, () => pedir(c)));
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 20);
    assert.ok(r.filter((x) => x.status === "rejected").every((x) => x.reason.codigo === "ORCAMENTO_ESGOTADO"));
    assert.equal(cli.chamadas.n, 20);
    assert.equal((await totais(b.pool)).n, 20);
  } finally { await descartarBancoMova(b); }
});

test("piloto IA — desligamento imediato pelo controle e banco fora = nenhuma chamada", { skip: pular }, async () => {
  const b = await banco();
  try {
    const cli = fakeCliente();
    const controle = criarControle({ pool: b.pool, cacheMs: 0 });
    const c = clienteComOrcamento(cli, { orcamento: criarOrcamentoIa({ pool: b.pool }), controle });
    await pedir(c);
    await controle.alterar({ ia: false }, { autor: "teste", motivo: "desligar" });
    await assert.rejects(pedir(c), (e) => e.codigo === "IA_DESLIGADA_NO_CONTROLE");
    assert.equal(cli.chamadas.n, 1);
    assert.equal((await totais(b.pool)).n, 1);
    const fora = clienteComOrcamento(cli, { orcamento: criarOrcamentoIa({ pool: { connect: async () => { throw new Error("ECONNREFUSED"); } } }) });
    await assert.rejects(pedir(fora), (e) => e.codigo === "ORCAMENTO_INDISPONIVEL");
    assert.equal(cli.chamadas.n, 1);
  } finally { await descartarBancoMova(b); }
});

test("piloto IA — modelo exato: só Haiku 5.5 é montável; resposta de outro modelo é recusada", async () => {
  const base = { MOVA_HABILITADO: "1", MOVA_DATABASE_URL: "x", MOVA_SERVICO_USUARIO_ID: "eeeeeeee-0000-4000-8000-0000000000aa" };
  assert.deepEqual(lerConfiguracaoMova({ ...base, MOVA_IA_MODELO: "claude-sonnet-5-5" }).contradicoes, ["MODELO_IA_NAO_PERMITIDO"]);
  assert.throws(() => criarExtratorAnthropic({ cliente: fakeCliente(), obterEvidencia: async () => null, modelo: "claude-opus-5-5" }));
  const ex = criarExtratorAnthropic({ cliente: fakeCliente({ modelo: "claude-opus-5-5" }), obterEvidencia: async () => new Uint8Array([1, 2]) });
  await assert.rejects(ex.extrair({ texto: "comprovante", midia: { referencia: "r", mime: "image/png" } }), (e) => e.codigo === "IA_MODELO_INESPERADO");
});

test("criação de despesas — chave própria, desligada por padrão e só com o pagamento por comprovante", () => {
  const base = { MOVA_HABILITADO: "1", MOVA_DATABASE_URL: "x", MOVA_SERVICO_USUARIO_ID: "eeeeeeee-0000-4000-8000-0000000000aa" };
  assert.notEqual(lerConfiguracaoMova(base).criarDespesas, true, "desligada por padrão");
  assert.ok(lerConfiguracaoMova({ ...base, MOVA_OPERACAO_CRIAR_DESPESAS: "1" }).contradicoes.includes("CRIAR_DESPESAS_SEM_PAGAMENTO_POR_COMPROVANTE"));
});

test("piloto IA — teto TOTAL de US$ 10,00 no código: configurar mais no banco não amplia; consumo anterior conta", { skip: pular }, async () => {
  const { TETO_TOTAL_IA_MICROUSD } = await import("../../src/modules/mova-financeiro/infra/operacao.js");
  assert.equal(TETO_TOTAL_IA_MICROUSD, 10_000_000);
  const b = await banco();
  try {
    await b.pool.query("update mova.orcamento_ia set limite_chamadas = 1000, limite_custo_microusd = 50000000, reserva_microusd = 20000");
    await b.pool.query("insert into mova.consumo_ia (estado, custo_microusd) values ('CONCLUIDA', 9990000)"); // consumo histórico preservado
    const orc = criarOrcamentoIa({ pool: b.pool });
    await assert.rejects(pedir(clienteComOrcamento(fakeCliente(), { orcamento: orc })), (e) => e.codigo === "ORCAMENTO_ESGOTADO", "9,99 + 0,02 > 10,00");
    const r = await orc.resumo();
    assert.deepEqual([r.limiteUsd, r.custoUsd], [10, 9.99], "limite efetivo = teto do código; consumo histórico não zera");
  } finally { await descartarBancoMova(b); }
});
