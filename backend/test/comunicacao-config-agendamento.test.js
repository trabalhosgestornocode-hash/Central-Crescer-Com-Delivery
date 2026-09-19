// Config de agendamento (TTL e jitter) — sem banco: um `supabase` falso devolve o valor bruto.
// Rodar: node --test test/comunicacao-config-agendamento.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Sem .env e sem rede (mesmo padrão de bonificacao-importacao-diaria.test.js): o módulo importa o cliente
// Supabase, que só precisa de valores sintáticos — nenhuma chamada é feita (o `deps.supabase` é falso).
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "teste-sem-rede";
process.env.SUPABASE_ANON_KEY = "teste-sem-rede";
const { obterConfig, obterTtlHoras, obterJitterMaxMs } = await import("../src/modules/comunicacao/comunicacao.config.js");

const dbCom = (valor) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: valor === undefined ? null : { valor }, error: null }) }) }) }) });
const dbComErro = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "tabela ausente" } }) }) }) }) };

describe("comunicacao.config — TTL e jitter (D.3-D)", () => {
  test("padrão documentado quando a linha não existe: TTL 24h e jitter 30 min", async () => {
    assert.equal(await obterTtlHoras({ supabase: dbCom(undefined) }), 24);
    assert.equal(await obterJitterMaxMs({ supabase: dbCom(undefined) }), 30 * 60_000);
    assert.equal(await obterConfig("ttl_horas", { supabase: dbCom(undefined) }), 24);
    assert.equal(await obterConfig("jitter_max_minutos", { supabase: dbCom(undefined) }), 30);
  });

  test("erro de leitura (tabela ausente) também cai no padrão — nunca em 'sem expiração'", async () => {
    assert.equal(await obterTtlHoras({ supabase: dbComErro }), 24);
    assert.equal(await obterJitterMaxMs({ supabase: dbComErro }), 30 * 60_000);
  });

  test("valor configurado válido é respeitado", async () => {
    assert.equal(await obterTtlHoras({ supabase: dbCom(6) }), 6);
    assert.equal(await obterTtlHoras({ supabase: dbCom(0.5) }), 0.5);
    assert.equal(await obterJitterMaxMs({ supabase: dbCom(10) }), 10 * 60_000);
  });

  test("valor corrompido (0, negativo, string, null, NaN, objeto) NÃO vira 'sem TTL': cai no padrão", async () => {
    for (const ruim of [0, -5, "24", null, Number.NaN, {}, [], true]) {
      assert.equal(await obterTtlHoras({ supabase: dbCom(ruim) }), 24, `ttl_horas=${JSON.stringify(ruim)}`);
      assert.equal(await obterJitterMaxMs({ supabase: dbCom(ruim) }), 30 * 60_000, `jitter=${JSON.stringify(ruim)}`);
    }
  });
});
