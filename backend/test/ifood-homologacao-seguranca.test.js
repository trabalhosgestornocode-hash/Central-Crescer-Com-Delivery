// Segurança do modo de homologação: o client secret do app de teste nunca
// aparece em log; o client id pode ser mascarado; nenhuma resposta ao
// frontend expõe credencial; a flag `homologacao` do status é só um booleano.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";

process.env.IFOOD_HOMOLOGATION_MODE = "true";
process.env.IFOOD_TEST_CLIENT_ID = "test-app-id-9f8e";
process.env.IFOOD_TEST_CLIENT_SECRET = "TEST-SECRET-NUNCA-PODE-VAZAR";

const { ifoodLog, sanitizar, mascararId } = await import("../src/modules/ifood/ifood.logsafe.js");
const conn = await import("../src/modules/ifood/ifoodConnection.service.js");

const TENANT = { organizacaoId: "org-1", unidadeId: "uni-1" };
const SEGREDO = "TEST-SECRET-NUNCA-PODE-VAZAR";

function capturarConsole() {
  const linhas = [];
  const originais = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => linhas.push(a.join(" "));
  console.warn = (...a) => linhas.push(a.join(" "));
  console.error = (...a) => linhas.push(a.join(" "));
  return { linhas, restaurar: () => Object.assign(console, originais) };
}

test("o client secret de teste nunca aparece em log (chave clientSecret)", () => {
  const cap = capturarConsole();
  try {
    ifoodLog("info", "oauth.token.solicitado", { appType: "financial", clientId: "test-app-id-9f8e", clientSecret: SEGREDO });
  } finally { cap.restaurar(); }
  const saida = cap.linhas.join("\n");
  assert.ok(!saida.includes(SEGREDO), "o secret vazou no log");
  assert.ok(saida.includes("[REDACTED]"));
});

test("o client secret de teste nunca aparece em log (chave client_secret)", () => {
  const cap = capturarConsole();
  try {
    ifoodLog("warn", "oauth.token.falhou", { client_secret: SEGREDO, causa: "timeout" });
  } finally { cap.restaurar(); }
  const saida = cap.linhas.join("\n");
  assert.ok(!saida.includes(SEGREDO));
});

test("um Bearer <secret> solto em texto livre também é mascarado (padrão de texto, não só por chave)", () => {
  const s = sanitizar({ mensagemDoErro: `falha ao autenticar: Bearer ${SEGREDO}` });
  assert.ok(!JSON.stringify(s).includes(SEGREDO));
});

test("mascararId() mascara um clientId de teste (só início/fim visíveis)", () => {
  const m = mascararId("test-app-id-9f8e");
  assert.notEqual(m, "test-app-id-9f8e");
  assert.ok(!m.includes("app-id-9f8"), "mascaramento insuficiente");
});

test("obterStatus(): a flag homologacao é só um booleano — nenhuma credencial no retorno", async () => {
  const repo = {
    async obterConexaoViva() { return null; },
  };
  const status = await conn.obterStatus({ ...TENANT, deps: { repo } });

  assert.equal(typeof status.homologacao, "boolean");
  assert.equal(status.homologacao, true);

  const txt = JSON.stringify(status);
  for (const vazamento of [SEGREDO, "test-app-id-9f8e", "clientId", "clientSecret", "IFOOD_TEST_CLIENT"]) {
    assert.ok(!txt.includes(vazamento), `vazou no status: ${vazamento}`);
  }
});
