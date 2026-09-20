// C.9.4 — SEGURANÇA da telemetria de inbound: o que sai pelo log (já passando pelo logsafe REAL) são só NOMES de categorias,
// contadores, booleanos, segundos e códigos fechados. Nenhum remoteJid, participant, author, LID, telefone, ID de mensagem,
// conteúdo, hash ou chave — nem no evento `inbound.contadores`, nem em `inbound.fila_offline`, nem em snapshot()/estadoFila().
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { criarGatewayFalso, capturarConsole } from "../test-support/inboundHarness.js";
import { criarInboundGateway, TIPOS_JID } from "../src/inboundScope.js";
import { sanitizar } from "../src/logsafe.js";

const G1 = "120363000000000001@g.us";
const D = (n) => `55118888${String(n).padStart(5, "0")}@s.whatsapp.net`;
const P = (n) => `55117777${String(n).padStart(5, "0")}@s.whatsapp.net`;
const SEM_ESPERA_PLACEHOLDER = { placeholderResendCache: { get: () => true, set() {}, del() {} } };

// Tudo o que identifica alguém/algo nos dados fictícios do cenário. Se QUALQUER destes aparecer no que é emitido, é vazamento.
const PROIBIDOS = [
  "5511888", "5511777", "5511999", "55118888", "55117777", "5511999990000",   // telefones (PN)
  "100000000000001", "100000000000002", "100000000000003", "1000000000",         // LIDs (inclui o da própria identidade)
  "120363000000000001", "@g.us", "@lid", "@s.whatsapp.net", "@broadcast", "status@",
  "TESTMSG", "participant", "remoteJid", "author", "pushName",
];
const SO_NUMEROS_LONGOS = /\d{8,}/;

const CHAVES_TOP = ["badMacLinhas", "escopo", "filtroAtivo", "tipos"];
const CHAVES_TIPO = ["decryptFalha", "decryptOk", "decryptTentado", "emitidasDireto", "encaminhadas", "enfileiradas", "entregues", "ignoradas", "motivos", "retryComPreChave", "retrySemPreChave", "retryTotal", "stanzasMensagem", "stanzasNotificacao", "stanzasReceipt", "tipo"];
const CHAVES_FILA = ["bufferAtivo", "bufferChamadasExternas", "conexoesAbertas", "flushes", "flushesEfetivos", "mensagensRetidas", "myAppStateKeyIdPresente", "nosOfflineVistos", "nosVivosVistos", "offlineFimContagem", "offlineFimRecebido", "offlinePreviewRecebido", "receivedPendingNotifications", "segundosDesdeOfflineFim", "segundosDesdeUltimaEnfileirada", "segundosDesdeUltimoFlush"];
const MOTIVOS_FECHADOS = ["bad_mac", "sem_sessao_compativel", "sem_sessao", "sem_conteudo", "chave_ja_usada", "prekey_invalida", "sender_key", "outro"];

/** percorre o objeto devolvendo [caminho, chave/valor] para auditar TODAS as chaves e valores. */
function* percorrer(v, caminho = "") {
  if (Array.isArray(v)) { for (const [i, x] of v.entries()) yield* percorrer(x, `${caminho}[${i}]`); return; }
  if (v && typeof v === "object") { for (const [k, x] of Object.entries(v)) { yield { caminho: `${caminho}.${k}`, chave: k, valor: x }; yield* percorrer(x, `${caminho}.${k}`); } return; }
}

async function cenarioCompleto() {
  const cap = capturarConsole();
  const emitidos = [];
  const inbound = criarInboundGateway({ diagHabilitado: true, emitir: (n, e, d) => emitidos.push({ e, d }), agendar: () => ({ unref() {} }), consoleAlvo: console });
  const gw = await criarGatewayFalso({ inbound, opcoesBaileys: SEM_ESPERA_PLACEHOLDER, latenciaKeysMs: 3 });
  try {
    inbound.observarSocket; // (já observado pelo harness)
    const d1 = await gw.criarPar(D(1));
    const lote = [await gw.mensagemDireta(d1, "segredo-de-conteudo"), await gw.mensagemDireta(await gw.criarPar(D(2)), "x", { adulterar: true }),
      await gw.mensagemDireta(await gw.criarPar("100000000000002@lid"), "lid"), await gw.mensagemDireta(await gw.criarPar("100000000000001:9@lid"), "self"),
      await gw.mensagemGrupo(await gw.criarPar(P(1)), G1, "grupo"), await gw.mensagemGrupo(await gw.criarPar(P(2)), "status@broadcast", "st")];
    for (const n of lote) gw.sock.ws.emit("CB:message", n);
    gw.emitirOfflinePreview(); gw.emitirOfflineFim(lote.length);
    await gw.aguardarQuiescencia({ estavelMs: 500, maxMs: 10_000 });
    inbound.emitirResumo();
    // depois, um nó vivo libera as retidas e o Gateway encaminha (simulado)
    const viva = await gw.mensagemDireta(d1, "viva"); delete viva.attrs.offline;
    await gw.entregarSemFimOffline(viva);
    for (const m of gw.upserts) if (!m.key?.fromMe) inbound.aoEncaminhada(m);
    inbound.emitirResumo();
    return { emitidos, inbound, gw, consoleLinhas: cap.linhas };
  } catch (e) { inbound.parar(); cap.restaurar(); await gw.encerrar(); throw e; }
  finally { cap.restaurar(); }
}

describe("telemetria de inbound — nada que identifique alguém/algo (pipeline real, logsafe real)", { timeout: 120_000 }, () => {
  let r; let linhasLog;
  test("executa o cenário completo (todos os tipos, retry, fila offline, nó vivo, encaminhamento)", async () => {
    r = await cenarioCompleto();
    assert.ok(r.emitidos.some((x) => x.e === "inbound.contadores"));
    assert.ok(r.emitidos.some((x) => x.e === "inbound.fila_offline"));
    linhasLog = r.emitidos.map((x) => JSON.stringify(sanitizar({ evento: x.e, ...x.d })));   // exatamente o que iria ao stdout
  });

  test("nenhum identificador nas linhas de log (telefone, LID, remoteJid, participant, author, id de mensagem, conteúdo)", () => {
    for (const l of linhasLog) {
      for (const p of PROIBIDOS) assert.ok(!l.includes(p), `vazou ${p}: ${l}`);
      assert.ok(!SO_NUMEROS_LONGOS.test(l), `número longo (possível telefone/LID/ID): ${l}`);
      assert.ok(!/segredo-de-conteudo/.test(l));
    }
    const snap = JSON.stringify([r.inbound.snapshot(), r.inbound.estadoFila()]);
    for (const p of PROIBIDOS) assert.ok(!snap.includes(p), `vazou no snapshot: ${p}`);
  });

  test("NENHUM campo é mascarado pelo logsafe (\"[REDACTED]\" esconderia o dado que queremos ler) — inclusive as pré-chaves de retry", () => {
    for (const l of linhasLog) assert.ok(!l.includes("REDACTED"), l);
    // controle: o nome antigo/óbvio SERIA mascarado (é por isso que o campo se chama ...PreChave)
    assert.equal(sanitizar({ retryComPreKey: 1 }).retryComPreKey, "[REDACTED]");
    assert.equal(sanitizar({ retryComPreChave: 1 }).retryComPreChave, 1);
  });

  test("esquema FECHADO: só estas chaves existem; qualquer campo novo precisa ser adicionado aqui de propósito", () => {
    for (const { e, d } of r.emitidos) {
      if (e === "inbound.contadores") {
        assert.deepEqual(Object.keys(d).sort(), CHAVES_TOP);
        for (const t of d.tipos) { assert.deepEqual(Object.keys(t).sort(), CHAVES_TIPO); for (const m of t.motivos) assert.deepEqual(Object.keys(m).sort(), ["motivo", "n"]); }
      } else if (e === "inbound.fila_offline") {
        assert.deepEqual(Object.keys(d).sort(), CHAVES_FILA);
      } else assert.fail(`evento inesperado: ${e}`);
    }
  });

  test("valores: só números, booleanos, null e nomes de vocabulário FECHADO (tipo, motivo, escopo)", () => {
    for (const { e, d } of r.emitidos) {
      for (const { caminho, chave, valor } of percorrer(d)) {
        if (typeof valor === "number") { assert.ok(Number.isFinite(valor) && valor >= 0, caminho); continue; }
        if (typeof valor === "boolean" || valor === null) continue;
        if (valor && typeof valor === "object") continue;                       // contêiner (já auditado recursivamente)
        assert.equal(typeof valor, "string", caminho);
        if (chave === "tipo") assert.ok(TIPOS_JID.includes(valor), `${caminho}=${valor}`);
        else if (chave === "motivo") assert.ok(MOTIVOS_FECHADOS.includes(valor), `${caminho}=${valor}`);
        else if (chave === "escopo") assert.ok(["ALL_SUPPORTED", "DIRECT_ONLY"].includes(valor));
        else assert.fail(`string inesperada em ${e} ${caminho}: ${valor}`);
      }
    }
  });

  test("a atribuição é coerente e não perde nada: por tipo, decryptTentado = ok + falha e enfileiradas + emitidasDireto = decryptTentado", () => {
    const ultimo = [...r.emitidos].reverse().find((x) => x.e === "inbound.contadores").d;
    let tentadas = 0;
    for (const t of ultimo.tipos) {
      assert.equal(t.decryptTentado, t.decryptOk + t.decryptFalha, t.tipo);
      assert.equal(t.enfileiradas + t.emitidasDireto, t.decryptTentado, t.tipo);
      assert.ok(t.entregues <= t.decryptTentado + 0, `${t.tipo}: entregues (${t.entregues}) ≤ decifradas (${t.decryptTentado})`);
      assert.ok(t.encaminhadas <= t.entregues, `${t.tipo}: encaminhadas ≤ entregues`);
      assert.equal(t.retryTotal, t.retryComPreChave + t.retrySemPreChave, t.tipo);
      tentadas += t.decryptTentado;
    }
    assert.ok(tentadas >= 7, `tentadas=${tentadas}`);
    assert.ok(ultimo.tipos.some((t) => t.tipo === "direct_lid_self") && ultimo.tipos.some((t) => t.tipo === "direct_lid_other"));
  });

  test("a fila mostra a fase certa: com o nó vivo o buffer foi liberado; no 1º resumo (offline 'finalizado') havia retidas", () => {
    const filas = r.emitidos.filter((x) => x.e === "inbound.fila_offline").map((x) => x.d);
    assert.ok(filas.length >= 2, `filas=${filas.length}`);
    assert.equal(filas[0].offlineFimRecebido, 1); assert.equal(filas[0].offlinePreviewRecebido, 1);
    assert.equal(filas[0].bufferAtivo, true); assert.ok(filas[0].mensagensRetidas >= 1, "retidas com a fila offline finalizada");
    const fim = filas.at(-1); assert.equal(fim.bufferAtivo, false); assert.equal(fim.mensagensRetidas, 0);
  });

  test("encerra", async () => { r.inbound.parar(); await r.gw.encerrar(); });
});
