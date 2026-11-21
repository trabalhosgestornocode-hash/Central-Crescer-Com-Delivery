// MOVA — Execução 13B: teto estrito por chamada de IA (orçamento pequeno). Cliente e orçamento SIMULADOS; sem rede.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clienteComOrcamento } from "../../src/modules/mova-financeiro/infra/operacao.js";
import { lerConfiguracaoMova } from "../../src/modules/fv2-integracao/mova.js";

const TETO = Object.freeze({ maxSaida: 380, maxEntrada: 3200, esforco: "low" });
const req = (x = {}) => ({ model: "m", max_tokens: 16000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", output_config: { effort: "medium", format: { type: "json_schema", schema: {} } },
  system: "s", messages: [{ role: "user", content: [{ type: "text", text: "oi" }] }], ...x });
function montar({ tokens = 3100, contagemFalha = false } = {}) {
  const enviados = []; const contados = []; const orc = { reservas: 0, async reservar() { this.reservas += 1; return 1; }, async concluir() {}, async falhar() {} };
  const cliente = { beta: { messages: {
    async countTokens(r) { contados.push(r); if (contagemFalha) throw new Error("rede"); return { input_tokens: tokens }; },
    async create(r) { enviados.push(r); return { model: "m", usage: { input_tokens: tokens, output_tokens: 10 }, content: [] }; },
  } } };
  return { enviados, contados, orc, c: clienteComOrcamento(cliente, { orcamento: orc, teto: TETO }) };
}

test("teto: max_tokens reduzido de fato, esforço baixo, sem fallback para outro modelo", async () => {
  const s = montar();
  await s.c.beta.messages.create(req());
  const [r] = s.enviados;
  assert.equal(r.max_tokens, 380);
  assert.equal(r.output_config.effort, "low");
  assert.ok(r.output_config.format, "formato estruturado preservado");
  assert.equal(r.fallbacks, undefined); assert.equal(r.betas, undefined);
  assert.ok(s.contados[0].output_config.format, "a contagem inclui o formato (é o que é cobrado)");
});

test("teto: entrada acima do limite é recusada ANTES de reservar e de chamar", async () => {
  const s = montar({ tokens: 3201 });
  await assert.rejects(s.c.beta.messages.create(req()), (e) => e.codigo === "IA_TETO_ENTRADA_EXCEDIDA");
  assert.equal(s.enviados.length, 0); assert.equal(s.orc.reservas, 0);
});

test("teto: mídia recusada sem contagem nem chamada; contagem indisponível também recusa", async () => {
  const s = montar();
  await assert.rejects(s.c.beta.messages.create(req({ messages: [{ role: "user", content: [{ type: "image", source: {} }, { type: "text", text: "x" }] }] })), (e) => e.codigo === "IA_TETO_MIDIA_RECUSADA");
  assert.equal(s.contados.length, 0); assert.equal(s.enviados.length, 0);
  const f = montar({ contagemFalha: true });
  await assert.rejects(f.c.beta.messages.create(req()), (e) => e.codigo === "IA_TETO_CONTAGEM_INDISPONIVEL");
  assert.equal(f.enviados.length, 0); assert.equal(f.orc.reservas, 0);
});

test("teto: configuração por ambiente — completa vira teto; parcial ou inválida é contradição (MOVA não liga)", () => {
  const base = { MOVA_HABILITADO: "1", MOVA_DATABASE_URL: "x", MOVA_SERVICO_USUARIO_ID: "eeeeeeee-0000-4000-8000-0000000000aa" };
  assert.deepEqual(lerConfiguracaoMova({ ...base, MOVA_IA_TETO_SAIDA: "380", MOVA_IA_TETO_ENTRADA: "3200", MOVA_IA_TETO_ESFORCO: "low" }).teto, TETO);
  assert.equal(lerConfiguracaoMova(base).teto, null);
  assert.deepEqual(lerConfiguracaoMova({ ...base, MOVA_IA_TETO_SAIDA: "380" }).contradicoes, ["TETO_IA_INVALIDO"]);
  assert.deepEqual(lerConfiguracaoMova({ ...base, MOVA_IA_TETO_SAIDA: "380", MOVA_IA_TETO_ENTRADA: "3200", MOVA_IA_TETO_ESFORCO: "max" }).contradicoes, ["TETO_IA_INVALIDO"]);
});
