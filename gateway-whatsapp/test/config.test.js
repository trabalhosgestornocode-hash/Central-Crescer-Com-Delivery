// Testes de validarConfig() — Checkpoint C3.5-A: o Gateway precisa falhar
// no BOOT (antes de qualquer tentativa de acquire) se WHATSAPP_LEASE_TTL_MS
// não deixar margem real para WHATSAPP_LEASE_RENEW_MS + o self-fencing
// preventivo (WHATSAPP_LEASE_MARGEM_MS). Cada teste importa config.js com
// um query-string diferente (`?t=...`) para forçar um módulo NOVO por
// teste — `config` é montado uma vez no import, lendo `process.env` nesse
// instante, então reimportar o mesmo caminho reaproveitaria o primeiro
// snapshot em cache.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const ENV_OBRIGATORIAS = {
  WHATSAPP_GATEWAY_SECRET: "s".repeat(32),
  WHATSAPP_AUTH_ENCRYPTION_KEY: "k".repeat(32),
  WHATSAPP_BACKEND_URL: "http://backend.invalido",
};

async function carregarConfigCom(envExtra) {
  const antes = {};
  const chaves = [...Object.keys(ENV_OBRIGATORIAS), ...Object.keys(envExtra)];
  for (const k of chaves) antes[k] = process.env[k];
  try {
    Object.assign(process.env, ENV_OBRIGATORIAS, envExtra);
    const mod = await import(`../src/config.js?t=${Date.now()}-${Math.random()}`);
    let erro = null;
    try { mod.validarConfig(); } catch (e) { erro = e; }
    return { config: mod.config, erro };
  } finally {
    for (const k of chaves) {
      if (antes[k] === undefined) delete process.env[k];
      else process.env[k] = antes[k];
    }
  }
}

describe("config — validarConfig() (Checkpoint C3.5-A: TTL/renew/margem do lease)", () => {
  test("configuração padrão (TTL=45000, renew=15000, margem=2000) passa sem erro", async () => {
    const { erro } = await carregarConfigCom({});
    assert.equal(erro, null);
  });

  test("TTL <= renew + margem falha no boot com mensagem clara", async () => {
    // 15000 + 2000 = 17000 — TTL igual a isso já não deixa margem nenhuma.
    const { erro } = await carregarConfigCom({
      WHATSAPP_LEASE_TTL_MS: "17000", WHATSAPP_LEASE_RENEW_MS: "15000", WHATSAPP_LEASE_MARGEM_MS: "2000",
    });
    assert.ok(erro, "esperava que validarConfig() lançasse");
    assert.match(erro.message, /WHATSAPP_LEASE_TTL_MS.*maior que.*WHATSAPP_LEASE_RENEW_MS/i);
  });

  test("TTL menor que renew (configuração claramente invertida) falha", async () => {
    const { erro } = await carregarConfigCom({ WHATSAPP_LEASE_TTL_MS: "5000", WHATSAPP_LEASE_RENEW_MS: "15000", WHATSAPP_LEASE_MARGEM_MS: "2000" });
    assert.ok(erro);
  });

  test("TTL positivo mas MUITO acima do teto (300000ms) falha — mesmo teto validado pelo Postgres", async () => {
    const { erro } = await carregarConfigCom({ WHATSAPP_LEASE_TTL_MS: "600000" });
    assert.ok(erro);
    assert.match(erro.message, /300000/);
  });

  test("TTL exatamente no teto (300000ms), com renew/margem coerentes, passa", async () => {
    const { erro } = await carregarConfigCom({ WHATSAPP_LEASE_TTL_MS: "300000", WHATSAPP_LEASE_RENEW_MS: "100000", WHATSAPP_LEASE_MARGEM_MS: "2000" });
    assert.equal(erro, null);
  });

  test("TTL <= 0 falha", async () => {
    const { erro } = await carregarConfigCom({ WHATSAPP_LEASE_TTL_MS: "0" });
    assert.ok(erro);
  });

  test("renewMs <= 0 falha", async () => {
    const { erro } = await carregarConfigCom({ WHATSAPP_LEASE_RENEW_MS: "0" });
    assert.ok(erro);
  });

  test("margemSegurancaMs negativa falha", async () => {
    const { erro } = await carregarConfigCom({ WHATSAPP_LEASE_MARGEM_MS: "-1" });
    assert.ok(erro);
  });

  test("margemSegurancaMs = 0 é aceitável (não-negativa) se TTL ainda sobra folga sobre o renew", async () => {
    const { erro } = await carregarConfigCom({ WHATSAPP_LEASE_TTL_MS: "45000", WHATSAPP_LEASE_RENEW_MS: "15000", WHATSAPP_LEASE_MARGEM_MS: "0" });
    assert.equal(erro, null);
  });

  test("erro de TTL/renew acontece ANTES de qualquer tentativa de acquire — validarConfig() nunca importa leaseManager/backendClient", async () => {
    const conteudo = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/config.js", import.meta.url), "utf8"));
    assert.ok(!/leaseManager|backendClient|adquirirLease/.test(conteudo), "config.js precisa ser puro — só lê env e valida, nunca chama rede");
  });
});
