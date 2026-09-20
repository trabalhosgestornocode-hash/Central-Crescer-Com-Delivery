// Checkpoint C3.5-C.9.1 — telemetria ESTRUTURAL do auth state. Dados 100% fictícios.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { criarAuthStateAdapter, serializarAuth } from "../src/authState.js";
import { medirAuthState, criarTelemetriaAuth, CATEGORIA_DESCONHECIDA } from "../src/authMetrics.js";
import { decriptar, normalizarChave } from "../src/crypto.js";
import { sanitizar } from "../src/logsafe.js";
import { config } from "../src/config.js";

const CHAVE_ENV = randomBytes(32).toString("base64");
const CHAVE = normalizarChave(CHAVE_ENV);

// Valores que NUNCA podem aparecer em nenhuma métrica.
const SEGREDOS = {
  jid: "5511999990000@s.whatsapp.net",
  jidDevice: "5511999990000:12@s.whatsapp.net",
  idSessao: "5511888880000.7",
  keyId: "K3Y-ID-SECRETO-42",
  sentinelaB64: Buffer.alloc(32, 0xab).toString("base64"),
  sentinelaTexto: "SEGREDO-DE-CREDS-XYZ",
  preKeyId: "987654",
};
const varreduraSegredos = (obj) => {
  const s = JSON.stringify(obj);
  return Object.entries(SEGREDOS).filter(([, v]) => s.includes(v)).map(([k]) => k);
};

function authFalso() {
  return {
    creds: { noiseKey: { private: Buffer.alloc(32, 0xab), public: Buffer.alloc(32, 1) }, advSecretKey: SEGREDOS.sentinelaTexto, me: { id: SEGREDOS.jid }, processedHistoryMessages: [{ key: { id: "A" } }] },
    keys: {
      "pre-key": { [SEGREDOS.preKeyId]: { private: Buffer.alloc(32, 2), public: Buffer.alloc(32, 3) }, 5: { private: Buffer.alloc(32, 4), public: Buffer.alloc(32, 5) } },
      session: {
        [SEGREDOS.jid]: { _sessions: { a: { indexInfo: { closed: -1 } }, b: { indexInfo: { closed: 1700000000000 } }, c: { indexInfo: { closed: 1700000000001 } } }, version: "v1" },
        [SEGREDOS.jidDevice]: { _sessions: { d: { indexInfo: { closed: -1 } } }, version: "v1" },
      },
      "sender-key-memory": { [SEGREDOS.jid]: { [SEGREDOS.jidDevice]: true } },
      "app-state-sync-key": { [SEGREDOS.keyId]: { keyData: Buffer.alloc(32, 0xab) } },
      "app-state-sync-version": { regular: { version: 3, hash: Buffer.alloc(128), indexValueMap: { [SEGREDOS.sentinelaB64]: { valueMac: Buffer.alloc(32, 9) }, outro: { valueMac: Buffer.alloc(32, 8) } } } },
    },
  };
}

describe("medirAuthState — função pura", () => {
  test("nomes REAIS das categorias, contagem de entradas e bytes serializados", () => {
    const a = authFalso();
    const m = medirAuthState(a, { serializar: serializarAuth });
    assert.deepEqual(Object.keys(m.categories).sort(), ["app-state-sync-key", "app-state-sync-version", "pre-key", "sender-key-memory", "session"]);
    assert.equal(m.categories["pre-key"].entries, 2);
    assert.equal(m.categories.session.entries, 2);
    assert.equal(m.categories["sender-key-memory"].entries, 1);
    assert.equal(m.categories["pre-key"].bytes, Buffer.byteLength(serializarAuth(a.keys["pre-key"])));
    assert.equal(m.categories.session.bytes, Buffer.byteLength(serializarAuth(a.keys.session)));
    assert.equal(m.credsBytes, Buffer.byteLength(serializarAuth(a.creds)));
    assert.equal(m.plaintextBytes, Buffer.byteLength(serializarAuth({ creds: a.creds, keys: a.keys })));
  });

  test("contagens estruturais que separam as hipóteses: sessões aninhadas/fechadas e mutações de app-state", () => {
    const m = medirAuthState(authFalso(), { serializar: serializarAuth });
    assert.deepEqual({ ...m.categories.session, bytes: undefined, entries: undefined }, { entries: undefined, bytes: undefined, subentradas: 4, fechadas: 2, maxPorRegistro: 3 });
    assert.equal(m.categories["app-state-sync-version"].mutacoes, 2);
  });

  test("NADA sensível aparece no resultado (ids, JIDs, valores, base64 de chave, conteúdo de creds)", () => {
    const m = medirAuthState(authFalso(), { serializar: serializarAuth });
    assert.deepEqual(varreduraSegredos(m), []);
    const s = JSON.stringify(m);
    assert.ok(!/@s\.whatsapp\.net/.test(s));
    assert.ok(!/__buffer/.test(s));
    // só números e nomes do vocabulário fechado
    for (const [nome, c] of Object.entries(m.categories)) {
      assert.match(nome, /^[a-z0-9-]+$/);
      for (const v of Object.values(c)) assert.equal(typeof v, "number");
    }
  });

  test("categoria desconhecida/insegura é agregada como 'outra', sem o nome nem o conteúdo", () => {
    const a = { creds: {}, keys: { "categoria-nova": { x: 1 }, [SEGREDOS.jid]: { y: { z: 2 } }, "Nome Com Espaço": { w: 3 } } };
    const m = medirAuthState(a, { serializar: serializarAuth });
    assert.deepEqual(Object.keys(m.categories).sort(), [CATEGORIA_DESCONHECIDA, "categoria-nova"].sort());
    assert.equal(m.categories[CATEGORIA_DESCONHECIDA].entries, 2);
    assert.deepEqual(varreduraSegredos(m), []);
  });

  test("creds nulo/keys vazio não quebra; serializar é obrigatório", () => {
    assert.deepEqual(medirAuthState({ creds: null, keys: {} }, { serializar: serializarAuth }).categories, {});
    assert.equal(medirAuthState({ creds: null, keys: {} }, { serializar: serializarAuth }).credsBytes, 0);
    assert.throws(() => medirAuthState({ creds: {}, keys: {} }), /serializar/);
  });

  test("forma inesperada nas contagens auxiliares não lança", () => {
    const m = medirAuthState({ creds: {}, keys: { session: { a: "não-é-objeto", b: null }, "app-state-sync-version": { regular: 5 } } }, { serializar: serializarAuth });
    assert.equal(m.categories.session.subentradas, 0);
    assert.equal(m.categories["app-state-sync-version"].mutacoes, 0);
  });
});

// ---- integração com o adapter real ------------------------------------------------------------
function backendFalso({ falhar = () => false } = {}) {
  const b = { chamadas: [], ultimo: null };
  b.salvarAuthState = async (payload) => {
    if (falhar(b.chamadas.length)) { const e = new Error("indisponível"); e.status = 503; throw e; }
    b.chamadas.push(payload);
    b.ultimo = payload.authStateEncrypted;
    return { authSessionId: "sess" };
  };
  b.carregarAuthState = async () => (b.ultimo ? { authStateEncrypted: b.ultimo, authSessionId: "sess", authConfirmado: true } : { status: "absent" });
  return b;
}
function montar({ habilitada = true, backend = backendFalso(), serializar = serializarAuth } = {}) {
  const emitidos = [];
  const telemetriaAuth = criarTelemetriaAuth({ habilitada, serializar, emitir: (d) => emitidos.push(d) });
  const adapter = criarAuthStateAdapter({
    backendClient: backend, chaveEncriptacaoEnv: CHAVE_ENV, telemetriaAuth,
    obterContextoLease: () => ({ gatewayProcessId: "proc-1", leaseEpoch: 7 }),
    agendar: () => 0, cancelar: () => {},
  });
  adapter.inicializarCreds({ noiseKey: { private: Buffer.alloc(32, 1) }, registered: true, processedHistoryMessages: [] });
  return { adapter, backend, emitidos, telemetriaAuth };
}

describe("telemetria no adapter", () => {
  test("DESLIGADA por padrão: nenhum trabalho extra e nenhum evento", async () => {
    let chamadas = 0;
    const { adapter, emitidos, telemetriaAuth } = montar({ habilitada: false, serializar: (v) => { chamadas++; return serializarAuth(v); } });
    assert.deepEqual(telemetriaAuth, { habilitada: false });
    await adapter.comoAuthState().keys.set({ session: { a: Buffer.from("x") } });
    await adapter.aoAtualizarCreds({ registered: true });
    assert.equal(emitidos.length, 0);
    assert.equal(chamadas, 0);
  });

  test("a flag de ambiente é OFF sem valor explícito", () => {
    assert.equal(config.metricasAuthHabilitadas, false, "WHATSAPP_AUTH_METRICS_ENABLED não está definida nos testes");
  });

  test("emite só DEPOIS da confirmação do backend; falha de gravação não emite", async () => {
    let tentativas = 0;
    const backend = backendFalso({ falhar: () => tentativas++ === 0 });
    const { adapter, emitidos } = montar({ backend });
    await assert.rejects(adapter.comoAuthState().keys.set({ session: { a: Buffer.from("x") } }));
    assert.equal(emitidos.length, 0, "gravação falhou: nada de métrica");
    await adapter.comoAuthState().keys.set({ session: { b: Buffer.from("y") } });
    assert.equal(emitidos.length, 1);
  });

  test("campos, tamanhos coerentes com o que foi realmente enviado e cifrado", async () => {
    const { adapter, backend, emitidos } = montar();
    await adapter.comoAuthState().keys.set({ session: { a: Buffer.from("x") }, "pre-key": { 1: { private: Buffer.alloc(32), public: Buffer.alloc(32) } } });
    const e = emitidos[0];
    const enviado = backend.chamadas[0];
    const plain = decriptar(enviado.authStateEncrypted, CHAVE);
    assert.equal(e.plaintextBytes, Buffer.byteLength(plain));
    assert.equal(e.cipherChars, enviado.authStateEncrypted.length);
    assert.equal(e.corpoBytes, Buffer.byteLength(JSON.stringify(enviado)), "corpo HTTP exato");
    assert.equal(e.epoch, 7);
    assert.equal(e.geracao, 1);
    const nomes = e.categorias.map((c) => c.nome);
    assert.deepEqual(nomes, ["creds", "session", "pre-key"]);
    assert.equal(e.categorias.find((c) => c.nome === "session").entradas, 1);
  });

  test("o payload emitido sobrevive ao logsafe sem mascaramento e sem nenhum segredo", async () => {
    const { adapter, emitidos } = montar();
    await adapter.comoAuthState().keys.set({
      session: { [SEGREDOS.jid]: { _sessions: { a: { indexInfo: { closed: -1 } } } } },
      "app-state-sync-key": { [SEGREDOS.keyId]: { keyData: Buffer.alloc(32, 0xab) } },
      "pre-key": { [SEGREDOS.preKeyId]: { private: Buffer.alloc(32, 1), public: Buffer.alloc(32, 2) } },
    });
    const e = emitidos[0];
    assert.deepEqual(varreduraSegredos(e), []);
    const passouPeloLog = sanitizar(e);
    assert.ok(!JSON.stringify(passouPeloLog).includes("[REDACTED]"), "nenhum campo da métrica pode ser mascarado pelo logsafe (senão o dado some do log)");
    assert.deepEqual(passouPeloLog, JSON.parse(JSON.stringify(e)));
  });

  test("dedupe de emissão: snapshot com a MESMA estrutura não reemite; mudança de tamanho/contagem/reconexão reemite", async () => {
    const { adapter, emitidos } = montar();
    const ks = adapter.comoAuthState().keys;
    await ks.set({ session: { a: Buffer.from("x") } });
    assert.equal(emitidos.length, 1);
    await adapter.aoAtualizarCreds({ registered: true });      // conteúdo igual => mesmo tamanho e mesmas contagens
    await ks.set({ session: { a: Buffer.from("x") } });        // idem
    assert.equal(emitidos.length, 1, "estrutura idêntica: sem ruído");
    await ks.set({ session: { a: Buffer.from("x".repeat(9)) } }); // tamanho mudou, contagem não
    assert.equal(emitidos.length, 2);
    assert.equal(emitidos[1].motivo, "tamanho");
    await ks.set({ session: { b: Buffer.from("y") } });        // contagem mudou
    assert.equal(emitidos.at(-1).motivo, "contagem");
    const antes = emitidos.length;
    await adapter.carregar();                                  // reconexão = nova geração de conexão
    await adapter.aoAtualizarCreds({ registered: true });
    assert.equal(emitidos.length, antes + 1);
    assert.equal(emitidos.at(-1).motivo, "nova_carga");
    assert.equal(emitidos.at(-1).cargaSeq, 1);
  });

  test("snapshots BYTE-IDÊNTICOS são contados por conteúdo (sha256 interno), não por tamanho", async () => {
    const { adapter, emitidos } = montar();
    const ks = adapter.comoAuthState().keys;
    await ks.set({ session: { a: Buffer.from("AAAA") } });            // #1 (emite)
    await ks.set({ session: { a: Buffer.from("AAAA") } });            // #2 idêntico ao #1
    await ks.set({ session: { a: Buffer.from("BBBB") } });            // #3 MESMO TAMANHO, conteúdo diferente
    await ks.set({ session: { a: Buffer.from("BBBB") } });            // #4 idêntico ao #3
    await ks.set({ session: { a: Buffer.from("BBBB") } });            // #5 idêntico ao #4
    await ks.set({ session: { a: Buffer.from("C".repeat(9)) } });     // #6 tamanho novo => emite
    assert.equal(emitidos.length, 2);
    const e = emitidos[1];
    assert.equal(e.escritasDesdeUltima, 5);            // #2..#6
    assert.equal(e.identicasDesdeUltima, 3);           // #2, #4, #5 — #3 tem o mesmo tamanho mas NÃO é idêntico
    assert.deepEqual(varreduraSegredos(emitidos), []);
    assert.ok(!JSON.stringify(emitidos).match(/[0-9a-f]{32}/), "nenhum hash vaza");
  });

  test("paridade: com e sem telemetria, as gravações (ordem, gerações, plaintext) são as mesmas", async () => {
    const roda = async (habilitada) => {
      const { adapter, backend } = montar({ habilitada });
      const ks = adapter.comoAuthState().keys;
      await ks.set({ session: { a: Buffer.from("1") } });
      await adapter.aoAtualizarCreds({ registered: true, accountSyncCounter: 2 });
      await ks.set({ "pre-key": { 1: { private: Buffer.alloc(32, 7), public: Buffer.alloc(32, 8) } }, session: { a: null } });
      await adapter.carregar();
      await ks.set({ session: { z: Buffer.from("z") } });
      return { plains: backend.chamadas.map((c) => decriptar(c.authStateEncrypted, CHAVE)), ep: backend.chamadas.map((c) => [c.leaseEpoch, c.gatewayProcessId, c.authStateVersion]), estado: adapter.estadoPersistencia() };
    };
    const off = await roda(false);
    const on = await roda(true);
    assert.deepEqual(on, off);
  });

  test("falha DENTRO da telemetria nunca afeta a persistência", async () => {
    const { adapter, backend, emitidos } = montar({ serializar: () => { throw new Error("boom"); } });
    await adapter.comoAuthState().keys.set({ session: { a: Buffer.from("x") } });
    assert.equal(backend.chamadas.length, 1);
    assert.equal(emitidos.length, 0);
    assert.equal(adapter.estadoPersistencia().sujo, false);
  });

  test("emitir que lança também não afeta a persistência", async () => {
    const telemetriaAuth = criarTelemetriaAuth({ habilitada: true, serializar: serializarAuth, emitir: () => { throw new Error("log caiu"); } });
    const backend = backendFalso();
    const adapter = criarAuthStateAdapter({ backendClient: backend, chaveEncriptacaoEnv: CHAVE_ENV, telemetriaAuth, obterContextoLease: () => ({ gatewayProcessId: "p", leaseEpoch: 1 }) });
    adapter.inicializarCreds({ registered: true });
    await adapter.comoAuthState().keys.set({ session: { a: Buffer.from("x") } });
    assert.equal(backend.chamadas.length, 1);
  });
});
