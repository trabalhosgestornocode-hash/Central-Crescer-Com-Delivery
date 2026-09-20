// Checkpoint C3.5-C.9.1 — a guarda de log da libsignal.
// Usa a libsignal REAL instalada (SessionRecord/SessionBuilder/SessionCipher): o objetivo é provar,
// nos pontos de chamada REAIS do pacote, que o objeto de sessão (material de chave) não chega ao
// console, que o resto do console é intocado e que uma versão futura da dependência não introduz
// uma chamada nova sem que este teste falhe.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import libsignal from "libsignal";
import { instalarGuardaLibsignal, MENSAGENS_PERIGOSAS } from "../src/libsignalLogGuard.js";

const NIVEIS = ["log", "info", "warn", "error", "debug"];
const originais = {};
let capturado;   // [{nivel, args}] — o que CHEGARIA ao stdout do Render
let eventos;     // [{nivel, evento, dados}] — o que a guarda emite no lugar
let guarda;

beforeEach(() => {
  capturado = [];
  eventos = [];
  for (const n of NIVEIS) {
    originais[n] = console[n];
    console[n] = (...args) => { capturado.push({ nivel: n, args }); };
  }
});
afterEach(() => {
  guarda?.desinstalar();
  guarda = undefined;
  for (const n of NIVEIS) console[n] = originais[n];
});

const instalar = () => { guarda = instalarGuardaLibsignal({ emitir: (nivel, evento, dados) => eventos.push({ nivel, evento, dados }) }); };
const tudoQueSaiu = () => capturado.map((c) => `${c.nivel}: ${c.args.map((a) => inspect(a, { depth: 8, maxArrayLength: null, maxStringLength: null, breakLength: Infinity })).join(" ")}`).join("\n");

// Material de chave reconhecível: se aparecer no console, a util.inspect mostra "<Buffer ab ab ab …>".
const ROOT = 0xab, CHAIN = 0xcd, PRIV = 0xef;
const SENTINELAS = [ROOT, CHAIN, PRIV].map((b) => Array(8).fill(b.toString(16)).join(" "));

function entradaSessao(n) {
  const e = libsignal.SessionRecord.createEntry();
  e.indexInfo = { created: Date.now(), used: Date.now(), remoteIdentityKey: Buffer.alloc(33, 0x11), baseKey: Buffer.alloc(33, n), baseKeyType: 2, closed: -1 };
  e.currentRatchet = {
    rootKey: Buffer.alloc(32, ROOT),
    ephemeralKeyPair: { pubKey: Buffer.alloc(33, 0x22), privKey: Buffer.alloc(32, PRIV) },
    lastRemoteEphemeralKey: Buffer.alloc(33, 0x33), previousCounter: 0,
  };
  e.addChain(Buffer.alloc(33, 0x44), { chainKey: { counter: 0, key: Buffer.alloc(32, CHAIN) }, chainType: 1, messageKeys: {} });
  return e;
}

/** Percorre os 4 pontos REAIS do session_record.js que imprimem objetos de sessão. */
function exercitarSessaoReal() {
  const rec = new libsignal.SessionRecord();
  const a = entradaSessao(1);
  rec.setSession(a);
  rec.closeSession(a);          // console.info("Closing session:", session)
  rec.closeSession(a);          // console.warn("Session already closed", session)
  rec.openSession(a);           // console.info("Opening session:", session)
  for (let i = 2; i <= 45; i++) { const s = entradaSessao(i); rec.setSession(s); rec.closeSession(s); }
  rec.removeOldSessions();      // console.info("Removing old closed session:", oldestSession) (varias vezes)
  return rec;
}

describe("guarda de log da libsignal — sem a guarda o vazamento é REAL (controle negativo)", () => {
  test("sem guarda, closeSession/openSession/removeOldSessions imprimem o material de chave", () => {
    exercitarSessaoReal();
    const saida = tudoQueSaiu();
    for (const s of SENTINELAS) assert.ok(saida.includes(s), `esperava vazar ${s} sem a guarda (o teste precisa ser sensível)`);
  });
});

describe("guarda de log da libsignal — com a guarda", () => {
  test("nenhuma das 4 chamadas perigosas serializa o objeto; só eventos sanitizados sem argumentos", () => {
    instalar();
    exercitarSessaoReal();
    const saida = tudoQueSaiu();
    for (const s of SENTINELAS) assert.ok(!saida.includes(s), `material ${s} não pode chegar ao console`);
    assert.ok(!/Closing session|Opening session|Removing old closed session|Session already closed/.test(saida), "nem a mensagem original é repassada");
    const nomes = new Set(eventos.map((e) => e.evento));
    for (const ev of ["libsignal.session_fechada", "libsignal.session_reaberta", "libsignal.session_antiga_removida", "libsignal.session_ja_fechada"]) assert.ok(nomes.has(ev), ev);
    for (const e of eventos) { assert.equal(e.nivel, "info"); assert.deepEqual(e.dados, {}); }
    assert.ok(guarda.contadores["libsignal.session_antiga_removida"] >= 3, "a poda para 40 dispara o evento por sessão removida");
  });

  test("outros console.* passam INTACTOS: mesmos argumentos (mesma referência), mesmo nível", () => {
    instalar();
    const obj = { a: 1 };
    console.info("mensagem normal", obj);
    console.warn("Session already open");                 // libsignal: warn sem objeto — segue visível
    console.error("Session error:Error: Bad MAC", "stack");
    console.log('{"evento":"x"}');
    console.debug("d");
    assert.equal(capturado.length, 5);
    assert.equal(capturado[0].nivel, "info");
    assert.strictEqual(capturado[0].args[1], obj);
    assert.deepEqual(capturado.map((c) => c.args[0]), ["mensagem normal", "Session already open", "Session error:Error: Bad MAC", '{"evento":"x"}', "d"]);
    assert.equal(eventos.length, 0);
  });

  test("a correspondência é EXATA no 1º argumento (prefixo/variação não é desviado; não-string também não)", () => {
    instalar();
    console.info("Closing session: extra", { x: 1 });
    console.info("closing session:", { x: 1 });
    console.info({ msg: "Closing session:" });
    console.info(123);
    assert.equal(capturado.length, 4);
    assert.equal(eventos.length, 0);
  });

  test("erros legítimos e Bad MAC REAIS continuam visíveis, sem material de chave", async () => {
    instalar();
    const { bob, alice } = await parReal();
    const enc = await alice.cifra.encrypt(Buffer.from("segredo-da-mensagem"));
    const adulterado = Buffer.from(enc.body, "binary");
    adulterado[adulterado.length - 1] ^= 0xff;                       // quebra o MAC
    await assert.rejects(bob.cifra.decryptWhisperMessage(adulterado));
    const saida = tudoQueSaiu();
    assert.ok(/Failed to decrypt message with any known session/.test(saida), "erro legítimo visível");
    assert.ok(/Session error:Error: Bad MAC/.test(saida), "Bad MAC visível");
    for (const s of SENTINELAS) assert.ok(!saida.includes(s));
    // o "material" desta troca real: nenhuma chave real de sessão aparece como Buffer no console
    assert.ok(!/<Buffer [0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2}/.test(saida), "nenhum Buffer de chave real impresso");
  });

  test("caminho REAL de re-estabelecimento (initIncoming): fecha a sessão aberta sem imprimir o objeto", async () => {
    instalar();
    const { bob } = await parReal();
    const outro = await novoPar(bob);       // novo par de chaves do mesmo remetente => novo pkmsg
    await bob.decifra(outro);               // libsignal: warn "Closing open session in favor..." + closeSession
    const saida = tudoQueSaiu();
    assert.ok(/Closing open session in favor of incoming prekey bundle/.test(saida), "o aviso sem payload segue visível (é a marca usada no diagnóstico)");
    assert.ok(!/<Buffer /.test(saida), "nenhum Buffer impresso");
    assert.ok(eventos.some((e) => e.evento === "libsignal.session_fechada"));
  });

  test("idempotente: instalar duas vezes não empilha; desinstalar restaura os métodos", () => {
    const antes = console.info;
    instalar();
    const g1 = guarda;
    const g2 = instalarGuardaLibsignal({ emitir: () => {} });
    assert.strictEqual(g1, g2);
    assert.notStrictEqual(console.info, antes);
    guarda.desinstalar();
    guarda = undefined;
    assert.strictEqual(console.info, antes);
  });

  test("emissão que lança não derruba o fluxo criptográfico", () => {
    guarda = instalarGuardaLibsignal({ emitir: () => { throw new Error("falha de log"); } });
    assert.doesNotThrow(() => exercitarSessaoReal());
  });
});

describe("canário — nenhuma chamada de console da libsignal instalada escapa do conhecimento da guarda", () => {
  const raiz = dirname(createRequire(import.meta.url).resolve("libsignal/package.json"));
  const ARQS = readdirSync(join(raiz, "src")).filter((f) => f.endsWith(".js"));

  // Chamadas com argumentos extras auditadas manualmente (nenhuma imprime chave):
  //   "Session error:" + e, e.stack   -> mensagem de erro + stack
  //   "Migrating session to:", <n>    -> número da versão de migração
  //   "V1 session storage migration error: registrationId", <n>, ... -> números
  const SEGURAS_MULTI = new Set(["Session error:", "Migrating session to:", "V1 session storage migration error: registrationId"]);

  test("toda chamada console.* com argumentos extras é conhecida (desviada ou auditada como segura)", () => {
    const achados = [];
    for (const arq of ARQS) {
      const src = readFileSync(join(raiz, "src", arq), "utf8").replace(/^\s*\/\/.*$/gm, "");
      for (const m of src.matchAll(/console\.(?:log|info|warn|error|debug)\(([\s\S]*?)\);/g)) {
        const args = m[1];
        const primeiro = /^\s*(["'])(.*?)\1/.exec(args)?.[2] ?? null;
        const semLiterais = args.replace(/(["'])(?:\\.|(?!\1).)*\1/g, "''");
        const multi = semLiterais.includes(",");
        achados.push({ arq, primeiro, multi, naoLiteral: primeiro === null });
      }
    }
    assert.ok(achados.length >= 10, "a varredura precisa realmente encontrar as chamadas");
    const desconhecidas = achados.filter((a) => (a.multi || a.naoLiteral) && !(a.primeiro in MENSAGENS_PERIGOSAS) && !SEGURAS_MULTI.has(a.primeiro));
    assert.deepEqual(desconhecidas, [], "chamada de console com argumento extra/não-literal que a guarda não conhece — auditar e cobrir em MENSAGENS_PERIGOSAS");
  });

  test("toda mensagem perigosa cadastrada ainda existe na libsignal instalada (a guarda não está morta)", () => {
    const tudo = ARQS.map((a) => readFileSync(join(raiz, "src", a), "utf8")).join("\n");
    for (const msg of Object.keys(MENSAGENS_PERIGOSAS)) assert.ok(tudo.includes(msg), `mensagem "${msg}" não existe mais — atualizar a guarda`);
  });
});

// ---- par real de sessões libsignal (sem rede) ---------------------------------------------
function armazenamento(identidade, regId, preKeys, signed) {
  const sessoes = new Map();
  return {
    loadSession: async (id) => { const r = sessoes.get(id); return r ? libsignal.SessionRecord.deserialize(r.serialize()) : undefined; },
    storeSession: async (id, rec) => { sessoes.set(id, rec); },
    isTrustedIdentity: () => true,
    loadPreKey: async (id) => preKeys.get(Number(id)),
    removePreKey: async (id) => { preKeys.delete(Number(id)); },
    loadSignedPreKey: () => signed.keyPair,
    getOurRegistrationId: () => regId,
    getOurIdentity: () => identidade,
  };
}
const endereco = new libsignal.ProtocolAddress("5500000000", 0);
const enderecoAlice = new libsignal.ProtocolAddress("5500000001", 0);

async function parReal() {
  const idBob = libsignal.keyhelper.generateIdentityKeyPair();
  const signed = libsignal.keyhelper.generateSignedPreKey(idBob, 1);
  const preKeys = new Map();
  for (let i = 1; i <= 5; i++) preKeys.set(i, libsignal.keyhelper.generatePreKey(i).keyPair);
  const storeBob = armazenamento(idBob, 111, preKeys, signed);
  const bob = { store: storeBob, idBob, signed, preKeys, proximaPreKey: 1 };
  const alice = await abrirComoAlice(bob);
  bob.cifra = new libsignal.SessionCipher(storeBob, enderecoAlice);
  const primeira = await alice.cifra.encrypt(Buffer.from("oi"));
  await bob.cifra.decryptPreKeyWhisperMessage(Buffer.from(primeira.body, "binary"));
  // Bob responde (msg tipo 1): a partir daqui Alice envia mensagens "msg" normais (não mais pkmsg).
  const resposta = await bob.cifra.encrypt(Buffer.from("resp"));
  await alice.cifra.decryptWhisperMessage(Buffer.from(resposta.body, "binary"));
  bob.decifra = async (par) => par.cifra.encrypt(Buffer.from("x")).then((c) => bob.cifra.decryptPreKeyWhisperMessage(Buffer.from(c.body, "binary")));
  return { bob, alice };
}
async function abrirComoAlice(bob) {
  const idAlice = libsignal.keyhelper.generateIdentityKeyPair();
  const storeAlice = armazenamento(idAlice, 222, new Map(), libsignal.keyhelper.generateSignedPreKey(idAlice, 1));
  const id = bob.proximaPreKey++;
  const pk = bob.preKeys.get(id);
  if (!pk) throw new Error("acabaram as pré-chaves do teste");
  await new libsignal.SessionBuilder(storeAlice, endereco).initOutgoing({
    registrationId: 111, identityKey: bob.idBob.pubKey,
    signedPreKey: { keyId: 1, publicKey: bob.signed.keyPair.pubKey, signature: bob.signed.signature },
    preKey: { keyId: id, publicKey: pk.pubKey },
  });
  return { cifra: new libsignal.SessionCipher(storeAlice, endereco) };
}
function novoPar(bob) { return abrirComoAlice(bob); }
