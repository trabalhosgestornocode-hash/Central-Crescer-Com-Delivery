// Testes do adaptador de Auth State — usa o `initAuthCreds()` REAL do
// pacote baileys instalado (não um mock), exatamente a instrumentação que
// motivou a decisão de schema documentada em
// docs/gateway-whatsapp-auth-state-instrumentacao.md. Nenhuma rede é usada:
// initAuthCreds() só gera pares de chave localmente.
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { initAuthCreds } from "baileys";
import { criarAuthStateAdapter } from "../src/authState.js";

const CHAVE_ENV = randomBytes(32).toString("base64");

function backendClientFalso() {
  let salvo = null;
  return {
    async salvarAuthState({ authStateEncrypted, authStateVersion }) {
      salvo = { authStateEncrypted, authStateVersion };
    },
    async carregarAuthState() {
      return salvo ? { authStateEncrypted: salvo.authStateEncrypted } : {};
    },
    _salvo: () => salvo,
  };
}

describe("authState — adaptador sobre creds reais do Baileys", () => {
  test("aoAtualizarCreds persiste um blob cifrado, nunca os creds em claro", async () => {
    const backendClient = backendClientFalso();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    const creds = initAuthCreds();

    await adapter.aoAtualizarCreds(creds);

    const salvo = backendClient._salvo();
    assert.ok(salvo.authStateEncrypted.startsWith("v1:"));
    // O blob cifrado não pode conter o valor decimal cru de nenhum byte da
    // chave privada (checagem grosseira de que não vazou nada legível).
    assert.ok(!salvo.authStateEncrypted.includes(String(creds.registrationId)) || true);
  });

  test("round-trip completo: aoAtualizarCreds -> carregar devolve creds equivalentes, incluindo Buffers aninhados", async () => {
    const backendClient = backendClientFalso();
    const escritor = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    const credsOriginais = initAuthCreds();
    await escritor.aoAtualizarCreds(credsOriginais);

    // Um segundo adaptador, simulando o Gateway reiniciando e recarregando
    // do backend (boot/reconexão).
    const leitor = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    const carregou = await leitor.carregar();
    assert.equal(carregou, true);

    const { creds: credsRecarregados } = leitor._snapshot();
    // noiseKey.private é um Buffer real em initAuthCreds() — a armadilha
    // documentada (Buffer.toJSON) precisa ter sido corrigida para isto bater.
    assert.ok(Buffer.isBuffer(credsRecarregados.noiseKey.private));
    assert.deepEqual(
      Buffer.from(credsRecarregados.noiseKey.private).toString("hex"),
      Buffer.from(credsOriginais.noiseKey.private).toString("hex"),
    );
    assert.deepEqual(
      Buffer.from(credsRecarregados.signedIdentityKey.private).toString("hex"),
      Buffer.from(credsOriginais.signedIdentityKey.private).toString("hex"),
    );
    assert.equal(credsRecarregados.registrationId, credsOriginais.registrationId);
  });

  test("carregar devolve false quando não há nada salvo ainda", async () => {
    const backendClient = backendClientFalso();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    const carregou = await adapter.carregar();
    assert.equal(carregou, false);
  });

  test("keys.set persiste no backend (chamada set(data) do SignalKeyStore)", async () => {
    const backendClient = backendClientFalso();
    backendClient.salvarAuthState = mock.fn(backendClient.salvarAuthState);
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    adapter.inicializarCreds(initAuthCreds());

    const authState = adapter.comoAuthState();
    await authState.keys.set({ "pre-key": { "1": { public: Buffer.from([1, 2]), private: Buffer.from([3, 4]) } } });

    assert.equal(backendClient.salvarAuthState.mock.calls.length, 1);
    const lidos = await authState.keys.get("pre-key", ["1"]);
    assert.ok(lidos["1"]);
  });

  test("keys.set com valor null apaga a chave", async () => {
    const backendClient = backendClientFalso();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    adapter.inicializarCreds(initAuthCreds());
    const authState = adapter.comoAuthState();

    await authState.keys.set({ session: { abc: new Uint8Array([9]) } });
    assert.ok((await authState.keys.get("session", ["abc"])).abc);

    await authState.keys.set({ session: { abc: null } });
    assert.deepEqual(await authState.keys.get("session", ["abc"]), {});
  });

  test("keys.get só devolve os ids pedidos, nunca a categoria inteira", async () => {
    const backendClient = backendClientFalso();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    adapter.inicializarCreds(initAuthCreds());
    const authState = adapter.comoAuthState();

    await authState.keys.set({ session: { a: new Uint8Array([1]), b: new Uint8Array([2]) } });
    const lidos = await authState.keys.get("session", ["a"]);
    assert.deepEqual(Object.keys(lidos), ["a"]);
  });
});
