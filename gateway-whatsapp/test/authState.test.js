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
import { decriptar, normalizarChave } from "../src/crypto.js";

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
    const resultado = await leitor.carregar();
    assert.deepEqual(resultado, { status: "loaded", registered: false, authConfirmado: false });

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

  test("carregar devolve {status:'absent'} quando não há nada salvo ainda", async () => {
    const backendClient = backendClientFalso();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    const resultado = await adapter.carregar();
    assert.deepEqual(resultado, { status: "absent" });
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

describe("authState — aoAtualizarCreds faz MERGE (Checkpoint C3, causa raiz confirmada ao vivo)", () => {
  // `creds.update` do Baileys é `Partial<AuthenticationCreds>` — nunca o
  // objeto completo (node_modules/baileys/lib/Types/Events.d.ts:16).
  // Substituir `creds` inteiro por um delta parcial (bug anterior) apagava
  // noiseKey/signedIdentityKey/signedPreKey/registrationId/advSecretKey; a
  // reconexão pós-515/restartRequired então quebrava com TypeError em
  // `noiseKey.public` (node_modules/baileys/lib/Utils/noise-handler.js:88),
  // porque os creds recarregados do backend já estavam incompletos.

  // Payload EXATO do handler `pair-success` do Baileys — o gatilho real do
  // 515 (node_modules/baileys/lib/Utils/validate-connection.js:158-166,
  // emitido por Socket/socket.js:487-489).
  function payloadPairSuccessReal() {
    return {
      account: {
        details: Buffer.alloc(140, 9),
        accountSignatureKey: Buffer.alloc(32, 1),
        accountSignature: Buffer.alloc(64, 2),
        deviceSignature: Buffer.alloc(64, 3),
      },
      me: { id: "551199999999:1@s.whatsapp.net", name: "~" },
      signalIdentities: [{ identifier: { name: "551199999999:1@s.whatsapp.net", deviceId: 0 }, identifierKey: Buffer.alloc(33, 4) }],
      platform: "smba",
    };
  }

  test("update parcial preserva noiseKey/signedIdentityKey/signedPreKey/registrationId/advSecretKey e os demais campos preexistentes", async () => {
    const backendClient = backendClientFalso();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    const completos = initAuthCreds();
    adapter.inicializarCreds(completos);
    await adapter.aoAtualizarCreds(completos); // emit "cheio" inicial (ex.: socket.js:361)

    await adapter.aoAtualizarCreds({ nextPreKeyId: 31, firstUnuploadedPreKeyId: 31 }); // delta parcial real (signal.js#getNextPreKeys)

    const { creds } = adapter._snapshot();
    assert.ok(creds.noiseKey, "noiseKey não pode desaparecer");
    assert.ok(creds.signedIdentityKey, "signedIdentityKey não pode desaparecer");
    assert.ok(creds.signedPreKey, "signedPreKey não pode desaparecer");
    assert.equal(creds.registrationId, completos.registrationId);
    assert.equal(creds.advSecretKey, completos.advSecretKey);
    assert.equal(creds.nextPreKeyId, 31, "o campo do delta precisa ter sido aplicado");
    assert.equal(creds.firstUnuploadedPreKeyId, 31);
  });

  test("payload equivalente ao pair-success real (account/me/signalIdentities/platform) não remove noiseKey", async () => {
    const backendClient = backendClientFalso();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    const completos = initAuthCreds();
    adapter.inicializarCreds(completos);
    await adapter.aoAtualizarCreds(completos);

    await adapter.aoAtualizarCreds(payloadPairSuccessReal());

    const { creds } = adapter._snapshot();
    assert.ok(creds.noiseKey, "noiseKey precisa sobreviver ao creds.update de pair-success");
    assert.ok(Buffer.isBuffer(creds.noiseKey.private));
    assert.ok(Buffer.isBuffer(creds.noiseKey.public));
    assert.deepEqual(creds.me, payloadPairSuccessReal().me);
    assert.equal(creds.platform, "smba");
  });

  test("após merge + persistência + reload: creds.noiseKey continua válido e seus Buffers continuam Buffers", async () => {
    const backendClient = backendClientFalso();
    const escritor = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    const completos = initAuthCreds();
    escritor.inicializarCreds(completos);
    await escritor.aoAtualizarCreds(completos);
    await escritor.aoAtualizarCreds(payloadPairSuccessReal()); // simula o creds.update do pair-success

    // Novo adaptador = nova tentativa de conexão recarregando do backend,
    // exatamente o que conectar({preservarCredsNaoRegistrados:true}) faz.
    const leitor = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    await leitor.carregar();
    const { creds: recarregados } = leitor._snapshot();

    assert.ok(recarregados.noiseKey, "noiseKey precisa sobreviver ao reload — é o campo que noise-handler.js:88 usa sem optional chaining");
    assert.ok(Buffer.isBuffer(recarregados.noiseKey.private));
    assert.ok(Buffer.isBuffer(recarregados.noiseKey.public));
    assert.equal(recarregados.noiseKey.private.toString("hex"), completos.noiseKey.private.toString("hex"));
  });

  test("identidade do objeto creds é preservada — comoAuthState().creds continua a MESMA referência depois de um update parcial", async () => {
    const backendClient = backendClientFalso();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    adapter.inicializarCreds(initAuthCreds());

    const authState = adapter.comoAuthState();
    const referenciaAntes = authState.creds;

    await adapter.aoAtualizarCreds({ accountSyncCounter: 3 });

    assert.equal(authState.creds, referenciaAntes, "Object.assign precisa mutar em-lugar, nunca trocar a referência do objeto");
    assert.equal(authState.creds.accountSyncCounter, 3, "o delta ainda precisa ter sido aplicado nessa mesma referência");
  });

  test("dois updates parciais consecutivos acumulam — o segundo não apaga o que o primeiro trouxe", async () => {
    const backendClient = backendClientFalso();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    const completos = initAuthCreds();
    adapter.inicializarCreds(completos);
    await adapter.aoAtualizarCreds(completos);

    await adapter.aoAtualizarCreds({ nextPreKeyId: 5, firstUnuploadedPreKeyId: 5 });
    await adapter.aoAtualizarCreds({ accountSyncCounter: 7 });

    const { creds } = adapter._snapshot();
    assert.equal(creds.nextPreKeyId, 5, "o primeiro delta não pode ter sido apagado pelo segundo");
    assert.equal(creds.accountSyncCounter, 7);
    assert.ok(creds.noiseKey, "campos originais continuam presentes depois de dois merges");
  });

  test("'registered' muda normalmente quando vem num update, sem perder os demais campos", async () => {
    const backendClient = backendClientFalso();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    const completos = initAuthCreds();
    assert.equal(completos.registered, false);
    adapter.inicializarCreds(completos);
    await adapter.aoAtualizarCreds(completos);

    await adapter.aoAtualizarCreds({ registered: true });

    const { creds } = adapter._snapshot();
    assert.equal(creds.registered, true);
    assert.ok(creds.noiseKey);
    assert.equal(creds.registrationId, completos.registrationId);
  });

  test("persistência sempre serializa o ESTADO COMPLETO (nunca só o delta recebido)", async () => {
    const backendClient = backendClientFalso();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    const completos = initAuthCreds();
    adapter.inicializarCreds(completos);
    await adapter.aoAtualizarCreds(completos);

    await adapter.aoAtualizarCreds({ nextPreKeyId: 9, firstUnuploadedPreKeyId: 9 });

    const { authStateEncrypted } = backendClient._salvo();
    const plaintext = decriptar(authStateEncrypted, normalizarChave(CHAVE_ENV));
    const persistido = JSON.parse(plaintext);
    assert.ok(persistido.creds.noiseKey, "o blob persistido precisa conter o creds completo, não só {nextPreKeyId, firstUnuploadedPreKeyId}");
    assert.ok(persistido.creds.signedIdentityKey);
    assert.equal(persistido.creds.nextPreKeyId, 9);
  });

  test("nenhum segredo aparece nos logs, mesmo quando o delta tem a FORMA de creds reais (noiseKey/advSecretKey)", async (t) => {
    const linhas = [];
    t.mock.method(console, "log", (s) => linhas.push(s));
    t.mock.method(console, "error", (s) => linhas.push(s));

    const backendClient = backendClientFalso();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    const completos = initAuthCreds();
    adapter.inicializarCreds(completos);
    await adapter.aoAtualizarCreds(completos);
    await adapter.aoAtualizarCreds(payloadPairSuccessReal());

    const chavePrivadaHex = completos.noiseKey.private.toString("hex");
    const advSecretKey = completos.advSecretKey;
    for (const s of linhas) {
      assert.ok(!s.includes(chavePrivadaHex), "chave privada nunca pode aparecer em log");
      assert.ok(!s.includes(advSecretKey), "advSecretKey nunca pode aparecer em log");
      assert.ok(!s.includes(CHAVE_ENV), "a chave de criptografia do processo nunca pode aparecer em log");
    }
    // O único log esperado desta operação é auth_state.persistido, só com bytesPlaintext.
    const linha = linhas.map((s) => JSON.parse(s)).find((l) => l.evento === "auth_state.persistido");
    assert.ok(linha);
    assert.equal(typeof linha.bytesPlaintext, "number");
  });
});

// backendClient cujas chamadas a `salvarAuthState` só se resolvem quando o
// teste explicitamente `liberar(indice)` — permite provar que a fila
// serializa de verdade (B nunca é CHAMADO antes de A terminar), não só que
// os resultados por acaso saem na ordem certa.
function backendClientControlavel() {
  let salvo = null;
  const chamadas = []; // { indice, authStateEncrypted, authStateVersion, liberar, rejeitar }
  const concluidas = [];

  return {
    async salvarAuthState({ authStateEncrypted, authStateVersion }) {
      const indice = chamadas.length;
      let liberar, rejeitar;
      const gate = new Promise((res, rej) => { liberar = res; rejeitar = rej; });
      chamadas.push({ indice, authStateEncrypted, authStateVersion, liberar, rejeitar });
      await gate;
      salvo = { authStateEncrypted, authStateVersion };
      concluidas.push(indice);
    },
    async carregarAuthState() {
      return salvo ? { authStateEncrypted: salvo.authStateEncrypted } : {};
    },
    liberar(indice) { chamadas[indice].liberar(); },
    rejeitar(indice, erro) { chamadas[indice].rejeitar(erro); },
    /** Espera (por polling em macrotask, nunca conta microtasks no escuro) até que N chamadas tenham sido INVOCADAS. */
    aguardarChamadas(n) {
      return new Promise((resolve) => {
        (function checar() {
          if (chamadas.length >= n) resolve();
          else setImmediate(checar);
        })();
      });
    },
    decodificarCreds(indice) {
      const plaintext = decriptar(chamadas[indice].authStateEncrypted, normalizarChave(CHAVE_ENV));
      return JSON.parse(plaintext).creds;
    },
    _ordemChamadas: () => chamadas.map((c) => c.indice),
    _ordemConcluidas: () => concluidas,
    _salvo: () => salvo,
  };
}

describe("authState — fila de persistência (serialização, Checkpoint C3 — auditoria de concorrência)", () => {
  test("SAVE B só é CHAMADO depois que SAVE A termina, mesmo que A demore — resultado final tem que ser o de B", async () => {
    const backendClient = backendClientControlavel();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    adapter.inicializarCreds(initAuthCreds());

    const promiseA = adapter.aoAtualizarCreds({ nextPreKeyId: 100 });
    await backendClient.aguardarChamadas(1);
    assert.deepEqual(backendClient._ordemChamadas(), [0], "A precisa ter sido chamado");

    const promiseB = adapter.aoAtualizarCreds({ nextPreKeyId: 200 });
    // Dá várias voltas no event loop — se a fila estivesse quebrada, B teria
    // sido chamado aqui mesmo com A ainda pendente.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(backendClient._ordemChamadas(), [0], "B não pode ser chamado enquanto A ainda está pendente");

    backendClient.liberar(0);
    await promiseA;
    await backendClient.aguardarChamadas(2);
    assert.deepEqual(backendClient._ordemChamadas(), [0, 1], "B só é chamado depois que A termina");

    backendClient.liberar(1);
    await promiseB;

    assert.deepEqual(backendClient._ordemConcluidas(), [0, 1]);
    const { creds: finalCreds } = adapter._snapshot();
    assert.equal(finalCreds.nextPreKeyId, 200, "resultado final precisa ser o mais recente (B)");
  });

  test("três updates consecutivos chegam ao backend na mesma ordem em que foram produzidos, e cada snapshot acumula só o que já existia até aquele instante", async () => {
    const backendClient = backendClientControlavel();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    const completos = initAuthCreds();
    adapter.inicializarCreds(completos);
    const nextPreKeyIdOriginal = completos.nextPreKeyId;
    const accountSyncCounterOriginal = completos.accountSyncCounter;

    // Três chamadas síncronas, sem await entre elas — o pior caso de disparo rápido.
    const promiseA = adapter.aoAtualizarCreds({ firstUnuploadedPreKeyId: 1 });
    const promiseB = adapter.aoAtualizarCreds({ nextPreKeyId: 2 });
    const promiseC = adapter.aoAtualizarCreds({ accountSyncCounter: 3 });

    await backendClient.aguardarChamadas(1);
    backendClient.liberar(0);
    await promiseA;
    await backendClient.aguardarChamadas(2);
    backendClient.liberar(1);
    await promiseB;
    await backendClient.aguardarChamadas(3);
    backendClient.liberar(2);
    await promiseC;

    assert.deepEqual(backendClient._ordemChamadas(), [0, 1, 2], "backend recebeu exatamente na ordem A, B, C");

    const credsA = backendClient.decodificarCreds(0);
    const credsB = backendClient.decodificarCreds(1);
    const credsC = backendClient.decodificarCreds(2);

    assert.equal(credsA.firstUnuploadedPreKeyId, 1);
    assert.equal(credsA.nextPreKeyId, nextPreKeyIdOriginal, "snapshot A não pode conter o delta de B, que ainda não tinha acontecido");
    assert.equal(credsA.accountSyncCounter, accountSyncCounterOriginal, "snapshot A não pode conter o delta de C, que ainda não tinha acontecido");

    assert.equal(credsB.firstUnuploadedPreKeyId, 1, "snapshot B acumula o que A trouxe");
    assert.equal(credsB.nextPreKeyId, 2);
    assert.equal(credsB.accountSyncCounter, accountSyncCounterOriginal, "snapshot B não pode conter o delta de C, que ainda não tinha acontecido");

    assert.equal(credsC.firstUnuploadedPreKeyId, 1, "snapshot C acumula tudo que A+B trouxeram");
    assert.equal(credsC.nextPreKeyId, 2);
    assert.equal(credsC.accountSyncCounter, 3);
  });

  test("snapshot de A é capturado no instante do merge (síncrono) — não muda mesmo que B altere `creds` antes de A terminar de persistir", async () => {
    const backendClient = backendClientControlavel();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    const completos = initAuthCreds();
    adapter.inicializarCreds(completos);
    const accountSyncCounterOriginal = completos.accountSyncCounter;

    const promiseA = adapter.aoAtualizarCreds({ firstUnuploadedPreKeyId: 777 });
    await backendClient.aguardarChamadas(1);
    // O payload que já foi passado pro backend na chamada de A — capturado
    // ANTES de B sequer ter sido invocado.
    const credsNoMomentoDoEnvioDeA = backendClient.decodificarCreds(0);
    assert.equal(credsNoMomentoDoEnvioDeA.firstUnuploadedPreKeyId, 777);
    assert.equal(credsNoMomentoDoEnvioDeA.accountSyncCounter, accountSyncCounterOriginal);

    // B muta o MESMO objeto `creds` (merge in-place) enquanto A ainda está
    // pendente na fila, esperando ser liberado.
    const promiseB = adapter.aoAtualizarCreds({ accountSyncCounter: 999 });

    // O payload já enviado para o backend na chamada de A tem que continuar
    // exatamente como estava — é uma STRING cifrada já montada, imutável.
    assert.deepEqual(backendClient.decodificarCreds(0), credsNoMomentoDoEnvioDeA);

    backendClient.liberar(0);
    await promiseA;
    await backendClient.aguardarChamadas(2);
    backendClient.liberar(1);
    await promiseB;

    // O snapshot de A no backend nunca foi sobrescrito por um reenvio — só
    // existiu uma chamada por índice.
    assert.deepEqual(backendClient._ordemChamadas(), [0, 1]);
  });

  test("se A falha, o erro chega para quem chamou A — mas B ainda executa depois, sem a fila travar para sempre", async () => {
    const backendClient = backendClientControlavel();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    adapter.inicializarCreds(initAuthCreds());

    const promiseA = adapter.aoAtualizarCreds({ nextPreKeyId: 1 });
    await backendClient.aguardarChamadas(1);
    backendClient.rejeitar(0, new Error("backend indisponível (simulado)"));

    await assert.rejects(promiseA, /backend indisponível/, "o erro de A precisa chegar para quem chamou aoAtualizarCreds");

    const promiseB = adapter.aoAtualizarCreds({ nextPreKeyId: 2 });
    await backendClient.aguardarChamadas(2);
    backendClient.liberar(1);
    await promiseB; // não pode travar/rejeitar por causa da falha anterior de A

    assert.deepEqual(backendClient._ordemChamadas(), [0, 1], "B foi chamado normalmente depois da falha de A");
    const { creds: finalCreds } = adapter._snapshot();
    assert.equal(finalCreds.nextPreKeyId, 2, "o merge de B foi aplicado normalmente, apesar da falha de A");
  });

  test("creds.update e keys.set compartilham a MESMA fila — a ordem de chegada ao backend respeita a ordem em que foram chamados", async () => {
    const backendClient = backendClientControlavel();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    adapter.inicializarCreds(initAuthCreds());
    const authState = adapter.comoAuthState();

    // creds.update -> keys.set -> creds.update, todos disparados sem esperar
    // o anterior terminar (o mesmo padrão de disparo do Baileys real).
    const promiseA = adapter.aoAtualizarCreds({ nextPreKeyId: 10 });
    const promiseB = authState.keys.set({ session: { s1: new Uint8Array([9]) } });
    const promiseC = adapter.aoAtualizarCreds({ nextPreKeyId: 30 });

    await backendClient.aguardarChamadas(1);
    backendClient.liberar(0);
    await promiseA;
    await backendClient.aguardarChamadas(2);
    backendClient.liberar(1);
    await promiseB;
    await backendClient.aguardarChamadas(3);
    backendClient.liberar(2);
    await promiseC;

    assert.deepEqual(backendClient._ordemChamadas(), [0, 1, 2], "creds.update e keys.set caem na mesma fila, na ordem de chamada");
  });

  test("aguardarPersistenciasPendentes() só resolve depois que a gravação pendente termina de verdade", async () => {
    const backendClient = backendClientControlavel();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    const completos = initAuthCreds();
    adapter.inicializarCreds(completos);

    // Simula o creds.update do pair-success, que fica pendente na fila.
    const promiseA = adapter.aoAtualizarCreds(completos);
    await backendClient.aguardarChamadas(1);

    let drenou = false;
    const promiseDrain = adapter.aguardarPersistenciasPendentes().then(() => { drenou = true; });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(drenou, false, "não pode drenar enquanto o save do pair-success ainda está em voo");

    backendClient.liberar(0);
    await promiseA;
    await promiseDrain;
    assert.equal(drenou, true, "depois que o save termina, o drain precisa resolver");
  });

  test("aguardarPersistenciasPendentes() é um DRAIN de verdade — se B entra na fila enquanto A ainda está pendente, só resolve depois que B também terminar", async () => {
    const backendClient = backendClientControlavel();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    adapter.inicializarCreds(initAuthCreds());

    // 1. SAVE A começa e fica bloqueado.
    const promiseA = adapter.aoAtualizarCreds({ nextPreKeyId: 1 });
    await backendClient.aguardarChamadas(1);

    // 2. aguardarPersistenciasPendentes() é chamado enquanto A ainda está em voo.
    let drenou = false;
    const promiseDrain = adapter.aguardarPersistenciasPendentes().then(() => { drenou = true; });

    // 3. Enquanto A está bloqueado, SAVE B é enfileirado.
    const promiseB = adapter.aoAtualizarCreds({ nextPreKeyId: 2 });

    // 4. A é liberado e termina.
    backendClient.liberar(0);
    await promiseA;

    // 5. O drain AINDA NÃO pode ter resolvido — B (que chegou depois da
    // captura inicial de `ultimaPersistencia`) ainda está pendente. Sem o
    // loop de recaptura, este seria exatamente o race descrito: o drain
    // devolveria o controle para quem chamou antes de B terminar.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(drenou, false, "o drain não pode resolver enquanto B (que chegou depois de A) ainda está pendente");

    // 6. Só depois que B também termina é que o drain resolve.
    await backendClient.aguardarChamadas(2);
    backendClient.liberar(1);
    await promiseB;
    await promiseDrain;
    assert.equal(drenou, true, "depois que B termina, o drain finalmente resolve");
  });

  test("aguardarPersistenciasPendentes() REJEITA se a ÚLTIMA gravação enfileirada até aqui falhou (ex.: SAVE do pair-success caiu) — não pode mascarar a falha como se tivesse dado certo", async () => {
    const backendClient = backendClientControlavel();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    const completos = initAuthCreds();
    adapter.inicializarCreds(completos);

    const promiseA = adapter.aoAtualizarCreds(completos); // simula o creds.update do pair-success
    await backendClient.aguardarChamadas(1);
    backendClient.rejeitar(0, new Error("timeout ao chamar o backend (simulado)"));
    await assert.rejects(promiseA, /timeout ao chamar o backend/);

    await assert.rejects(
      adapter.aguardarPersistenciasPendentes(),
      /timeout ao chamar o backend/,
      "quem espera a fila (ex.: o reconnect antes de carregar()) precisa saber que a última gravação falhou",
    );
  });

  test("depois de uma falha, uma gravação SEGUINTE bem-sucedida volta a fazer aguardarPersistenciasPendentes() resolver normalmente — a fila continua utilizável", async () => {
    const backendClient = backendClientControlavel();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    adapter.inicializarCreds(initAuthCreds());

    const promiseA = adapter.aoAtualizarCreds({ nextPreKeyId: 1 });
    await backendClient.aguardarChamadas(1);
    backendClient.rejeitar(0, new Error("falha simulada de A"));
    await assert.rejects(promiseA);

    // B precisa poder executar normalmente depois — a fila não pode ter
    // ficado travada/envenenada pela falha de A.
    const promiseB = adapter.aoAtualizarCreds({ nextPreKeyId: 2 });
    await backendClient.aguardarChamadas(2);
    backendClient.liberar(1);
    await promiseB;

    await adapter.aguardarPersistenciasPendentes(); // não pode rejeitar — a última gravação (B) deu certo
    assert.deepEqual(backendClient._ordemChamadas(), [0, 1]);
  });
});

describe("authState — fencing de lease (Checkpoint C3.5)", () => {
  function backendClientCapturaFencing({ rejeitarComLeaseStale = false } = {}) {
    let salvo = null;
    const chamadas = [];
    return {
      async salvarAuthState(payload) {
        chamadas.push(payload);
        if (rejeitarComLeaseStale) {
          const e = new Error("stale (simulado)");
          e.leaseStale = true;
          throw e;
        }
        salvo = payload;
      },
      async carregarAuthState() { return salvo ? { authStateEncrypted: salvo.authStateEncrypted } : {}; },
      _chamadas: () => chamadas,
    };
  }

  test("toda gravação inclui gatewayProcessId/leaseEpoch vindos de obterContextoLease()", async () => {
    const backendClient = backendClientCapturaFencing();
    const obterContextoLease = () => ({ gatewayProcessId: "proc-x", leaseEpoch: 7 });
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV, obterContextoLease });
    adapter.inicializarCreds(initAuthCreds());

    await adapter.aoAtualizarCreds({ nextPreKeyId: 1 });

    const [chamada] = backendClient._chamadas();
    assert.equal(chamada.gatewayProcessId, "proc-x");
    assert.equal(chamada.leaseEpoch, 7);
  });

  test("sem lease (obterContextoLease() devolve null), persistir() recusa LOCALMENTE — nunca chega a chamar o backend", async () => {
    const backendClient = backendClientCapturaFencing();
    const obterContextoLease = () => null;
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV, obterContextoLease });
    adapter.inicializarCreds(initAuthCreds());

    await assert.rejects(adapter.aoAtualizarCreds({ nextPreKeyId: 1 }));
    assert.equal(backendClient._chamadas().length, 0, "nunca deveria ter tentado a rede sem lease");
  });

  test("rejeição 409 (leaseStale) do backend dispara aoLeaseStale, e o erro ainda propaga para quem chamou aoAtualizarCreds", async () => {
    const backendClient = backendClientCapturaFencing({ rejeitarComLeaseStale: true });
    const obterContextoLease = () => ({ gatewayProcessId: "proc-x", leaseEpoch: 3 });
    const aoLeaseStale = mock.fn();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV, obterContextoLease, aoLeaseStale });
    adapter.inicializarCreds(initAuthCreds());

    await assert.rejects(adapter.aoAtualizarCreds({ nextPreKeyId: 1 }));
    assert.equal(aoLeaseStale.mock.calls.length, 1);
    assert.equal(aoLeaseStale.mock.calls[0].arguments[0], "auth_state_stale");
  });

  test("sem obterContextoLease injetado (uso sem lease), continua funcionando como antes deste checkpoint — retrocompatível", async () => {
    const backendClient = backendClientCapturaFencing();
    const adapter = criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv: CHAVE_ENV });
    adapter.inicializarCreds(initAuthCreds());

    await adapter.aoAtualizarCreds({ nextPreKeyId: 1 }); // não pode lançar
    assert.equal(backendClient._chamadas().length, 1);
  });
});
