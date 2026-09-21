// C.9.7 — INTEGRAÇÃO da identidade efêmera e do histograma de attrs.offline com o Baileys 6.7.24 REAL (socket real → servidor WebSocket
// LOCAL, criptografia libsignal real, pares fictícios; nenhuma rede externa), usando o servidor de fila offline falso já existente.
// Perguntas: (1) o overlap entre sockets sai certo e sem vazar identificador? (2) a identidade NÃO muda absolutamente nada no fluxo do Baileys?
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import { criarGatewayFalso, capturarConsole } from "../test-support/inboundHarness.js";
import { criarServidorOfflineFalso, gerarMensagensOffline } from "../test-support/servidorOfflineFalso.js";
import { criarInboundGateway } from "../src/inboundScope.js";
import { sanitizar } from "../src/logsafe.js";

const SEM_ESPERA_PLACEHOLDER = { placeholderResendCache: { get: () => true, set() {}, del() {} } };
const RAPIDOS = { stallDetectionMs: 400, absoluteMaxOfflineMs: 3000, tickMs: 40, heartbeatMs: 300 };
const SEGREDO = Buffer.alloc(32, 0x77);
const D = (n) => `55118888${String(n).padStart(5, "0")}@s.whatsapp.net`;

async function abrir({ modo = "observe", opcoesBaileys = {} } = {}) {
  const cap = capturarConsole(); const eventos = [];
  const observe = modo === "observe" ? { ...RAPIDOS, identidadeOpcoes: { segredo: SEGREDO } } : modo === "observe-sem-id" ? { ...RAPIDOS, identidade: false } : false;
  const inbound = modo === "nenhum" ? undefined : criarInboundGateway({ diagHabilitado: true, offlineObserve: observe, consoleAlvo: console, emitir: (n, e, d) => eventos.push({ e, d }), obterEpoch: () => 10 });
  const gw = await criarGatewayFalso({ inbound, opcoesBaileys });
  return { gw, inbound, eventos, porNome: (n) => eventos.filter((x) => x.e === n), fim: async () => { inbound?.parar(); cap.restaurar(); await gw.encerrar(); } };
}
async function esperar(cond, ms = 5000, passo = 30) { const ini = Date.now(); while (Date.now() - ini < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, passo)); } return cond(); }
/** um 2º/3º socket "observado" (ws/ev falsos, como o Baileys faria numa reconexão) */
function novoSocket(t) { const ws = new EventEmitter(); ws.isOpen = true; const ev = new EventEmitter(); t.inbound.observarSocket({ ws, ev, user: null }); return { ws, ev, fechar: () => ev.emit("connection.update", { connection: "close" }) }; }
const noSintetico = (i, from = D(700 + (i % 5))) => ({ tag: "message", attrs: { id: `SINT-ID-${i}`, from, type: "text", offline: "0", t: String(Math.floor(Date.now() / 1000) - 7200) }, content: [] });

describe("overlap entre sockets com o Baileys real (sem logar identificador)", { timeout: 180_000 }, () => {
  test("socket 1 REAL (60 nós, sem marcador) ⇒ stall + 'sem_geracao_anterior'; sockets 2 e 3 reentregam os MESMOS 60 e depois metade nova ⇒ 100% e 50%", async () => {
    const t = await abrir();
    try {
      const nos = await gerarMensagensOffline(t.gw, 60, { pares: 6 });
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "nunca_envia_fim" }); srv.iniciar(); await srv.aguardarBatches(1, 3000);
      await t.gw.aguardarQuiescencia({ estavelMs: 300, maxMs: 15_000 });
      assert.equal(await esperar(() => t.porNome("inbound.offline_overlap").length >= 1, 6000), true);
      const g1 = t.porNome("inbound.offline_overlap")[0].d;
      assert.deepEqual([g1.gatilho, g1.socketGeneration, g1.comparavel, g1.motivo, g1.currentCount, g1.observeOnly, g1.RECOVERY_PATH_USED], ["stall", 1, false, "sem_geracao_anterior", 60, true, false]);
      assert.deepEqual(t.inbound.estadoIdentidade(), { geracaoAtual: 1, atualCount: 60, historico: [], maxPorGeracao: 500, geracoesRetidas: 3 });
      // socket 2: o servidor devolve os MESMOS 60 itens
      const s2 = novoSocket(t); for (const n of nos) s2.ws.emit("CB:message", n); s2.fechar();
      const g2 = t.porNome("inbound.offline_overlap").at(-1).d;
      assert.deepEqual([g2.gatilho, g2.socketGeneration, g2.previousGeneration, g2.comparavel, g2.previousCount, g2.currentCount, g2.overlapCount, g2.newCount, g2.overlapPct, g2.newPct], ["fechamento", 2, 1, true, 60, 60, 60, 0, 100, 0]);
      // socket 3: 30 iguais + 30 novos
      const s3 = novoSocket(t); for (const n of nos.slice(0, 30)) s3.ws.emit("CB:message", n); for (let i = 0; i < 30; i++) s3.ws.emit("CB:message", noSintetico(i)); s3.fechar();
      const g3 = t.porNome("inbound.offline_overlap").at(-1).d;
      assert.deepEqual([g3.socketGeneration, g3.previousGeneration, g3.previousCount, g3.currentCount, g3.overlapCount, g3.newCount, g3.missingCount, g3.overlapPct, g3.newPct, g3.seenInRetainedCount], [3, 2, 60, 60, 30, 30, 30, 50, 50, 30]);
      // socket 4: nada em comum com nenhuma geração
      const s4 = novoSocket(t); for (let i = 100; i < 160; i++) s4.ws.emit("CB:message", noSintetico(i)); s4.fechar();
      const g4 = t.porNome("inbound.offline_overlap").at(-1).d;
      assert.deepEqual([g4.overlapCount, g4.newCount, g4.overlapPct, g4.seenInRetainedCount, g4.unseenInRetainedCount], [0, 60, 0, 0, 60]);
      assert.equal(t.porNome("inbound.offline_overlap").length, 4, "1 evento por geração (o fechamento da 1 não reemitiu: a contagem não mudou)");
    } finally { await t.fim(); }
  });

  test("SEGURANÇA no fio: nenhum id, from, impressão HMAC ou segredo em NENHUM evento (logsafe real); só contagens e vocabulário fechado", async () => {
    const t = await abrir();
    try {
      const nos = await gerarMensagensOffline(t.gw, 20, { pares: 4 });
      for (const n of nos) t.gw.sock.ws.emit("CB:message", n);
      await t.gw.aguardarQuiescencia({ estavelMs: 300, maxMs: 15_000 });
      const s2 = novoSocket(t); for (const n of nos) s2.ws.emit("CB:message", n); s2.fechar();
      await esperar(() => t.porNome("inbound.offline_overlap").length >= 2, 3000);
      const h = (dominio, itens) => createHmac("sha256", SEGREDO).update(JSON.stringify([dominio, ...itens])).digest();
      const formas = (b) => [b.toString("base64"), b.subarray(0, 16).toString("base64"), b.toString("hex"), b.subarray(0, 16).toString("hex"), b.toString("base64url"), b.subarray(0, 16).toString("base64url")];
      const n0 = nos[0]; const proibidos = [SEGREDO.toString("hex"), SEGREDO.toString("base64"), n0.attrs.id, n0.attrs.from, "55118888", "s.whatsapp.net", ...formas(h("estrita", ["message", n0.attrs.type, n0.attrs.id, n0.attrs.from, ""])), ...formas(h("frouxa", ["message", n0.attrs.id]))];
      for (const x of t.eventos) {
        const linha = JSON.stringify(sanitizar({ evento: x.e, ...x.d }));
        for (const p of proibidos) assert.ok(!linha.includes(p), `${x.e} vazou ${p}`);
        assert.ok(!linha.includes("REDACTED"), `${x.e}: campo mascarado`); assert.ok(!/\d{9,}/.test(linha), `${x.e}: número longo`);
      }
      assert.ok(t.porNome("inbound.offline_overlap").length >= 2);
    } finally { await t.fim(); }
  });

  test("só nós OFFLINE entram na identidade: um nó VIVO (attrs.offline ausente) no Baileys real não altera a contagem de identidade", async () => {
    const t = await abrir();
    try {
      const nos = await gerarMensagensOffline(t.gw, 10, { pares: 2 });
      for (const n of nos) t.gw.sock.ws.emit("CB:message", n);
      await t.gw.aguardarQuiescencia({ estavelMs: 300, maxMs: 15_000 });
      assert.equal(t.inbound.estadoIdentidade().atualCount, 10);
      const par = await t.gw.criarPar(D(900)); const viva = await t.gw.mensagemDireta(par, "viva"); delete viva.attrs.offline;
      await t.gw.entregarSemFimOffline(viva);
      assert.equal(t.inbound.estadoIdentidade().atualCount, 10, "o nó vivo (que faz o flush nativo) não é 'fila offline'");
      assert.equal(t.inbound.estadoObserve().nosVivos, 1);
    } finally { await t.fim(); }
  });

  test("histograma com o Baileys real: offline=\"0\"/\"2\"/\"57\" são TODOS offline (retidos, sem flush) e o histograma mostra os valores exatos; valor perigoso vira só classe", async () => {
    const t = await abrir();
    try {
      const nos = await gerarMensagensOffline(t.gw, 8, { pares: 2 });
      const valores = ["0", "0", "0", "2", "2", "57", "5511999990000", "PALAVRA-SECRETA-LONGA"];
      nos.forEach((n, i) => { n.attrs.offline = valores[i]; });
      for (const n of nos) t.gw.sock.ws.emit("CB:message", n);
      await t.gw.aguardarQuiescencia({ estavelMs: 500, maxMs: 15_000 });
      assert.equal(t.gw.upserts.length, 0); assert.equal(t.gw.bufferando(), true); assert.equal(t.inbound.estadoFila().flushes, 0, "todos tratados como offline pelo Baileys");
      const msg = t.inbound.estadoObserve().attrOfflineValores.find((x) => x.especie === "message");
      assert.deepEqual(msg.bins.map((b) => (b.tipo === "int" ? `i:${b.valor}` : `c:${b.nome}`)).sort(), ["c:int_10mais_dig", "c:texto_longo", "i:0", "i:2", "i:57"]);
      assert.equal(msg.bins.find((b) => b.valor === 0).n, 3);
      await esperar(() => t.porNome("inbound.offline_stalled_observed").length >= 1, 4000);
      const linha = JSON.stringify(t.eventos.map((x) => sanitizar({ evento: x.e, ...x.d })));
      for (const p of ["5511999990000", "PALAVRA", "SECRETA"]) assert.ok(!linha.includes(p), `vazou ${p}`);
      assert.ok(t.porNome("inbound.offline_stalled_observed")[0].d.attrOfflineValores, "o histograma vai no evento de stall");
    } finally { await t.fim(); }
  });

  test("RESTART simulado: um segundo criarInboundGateway (segredo novo, histórico vazio) começa 'sem_geracao_anterior' e não enxerga a identidade do primeiro", async () => {
    const eventosA = []; const eventosB = [];
    const A = criarInboundGateway({ diagHabilitado: true, offlineObserve: RAPIDOS, emitir: (n, e, d) => eventosA.push({ e, d }) });
    const B = criarInboundGateway({ diagHabilitado: true, offlineObserve: RAPIDOS, emitir: (n, e, d) => eventosB.push({ e, d }) });
    const fake = (inb) => { const ws = new EventEmitter(); ws.isOpen = true; const ev = new EventEmitter(); inb.observarSocket({ ws, ev, user: null }); return { ws, ev }; };
    try {
      const a1 = fake(A); for (let i = 0; i < 5; i++) a1.ws.emit("CB:message", noSintetico(i)); const a2 = fake(A);
      const b1 = fake(B); for (let i = 0; i < 5; i++) b1.ws.emit("CB:message", noSintetico(i)); b1.ev.emit("connection.update", { connection: "close" });
      const d = eventosB.find((x) => x.e === "inbound.offline_overlap").d;
      assert.deepEqual([d.comparavel, d.motivo, d.currentCount], [false, "sem_geracao_anterior", 5]);
      assert.deepEqual(A.estadoIdentidade().historico.map((h) => h.count), [5], "o gateway A guardou a geração 1; o B não sabe de nada");
      assert.ok(a2);
    } finally { A.parar(); B.parar(); }
  });

  test("a identidade só existe com o observador ligado e pode ser desligada; sem o diagnóstico não existe nada", () => {
    const mk = (o) => criarInboundGateway({ diagHabilitado: o.diag, offlineObserve: o.obs, emitir() {} });
    const casos = [[{ diag: true, obs: true }, true], [{ diag: true, obs: RAPIDOS }, true], [{ diag: true, obs: { ...RAPIDOS, identidade: false } }, false], [{ diag: true, obs: false }, false], [{ diag: false, obs: true }, false]];
    for (const [o, tem] of casos) { const g = mk(o); assert.equal(g.estadoIdentidade() !== undefined, tem, JSON.stringify(o)); g.parar(); }
  });
});

describe("NÃO INTERFERÊNCIA (C.9.7): NENHUMA × DIAG × OBSERVE sem identidade (≡ C.9.6) × OBSERVE com identidade + histograma, mesma sequência de nós", { timeout: 300_000 }, () => {
  const assinaturaFrames = (enviados) => enviados.map((n) => `${n.tag}|${n.attrs?.type ?? ""}|${(Array.isArray(n.content) ? n.content.map((c) => c.tag) : []).join(",")}`).sort();

  async function rodar(modo) {
    const t = await abrir({ modo, opcoesBaileys: SEM_ESPERA_PLACEHOLDER });
    try {
      const { gw } = t;
      const boas = await gerarMensagensOffline(gw, 50, { pares: 10 });
      boas.forEach((n, i) => { n.attrs.offline = ["0", "1", "2", "57", "0"][i % 5]; });                       // valores variados: o histograma trabalha, o Baileys trata todos como offline
      const par = await gw.criarPar(D(500)); const ruins = [];
      for (let i = 0; i < 6; i++) ruins.push(await gw.mensagemDireta(par, `ruim${i}`, { adulterar: true }));
      const srv = criarServidorOfflineFalso({ gw, nos: [...boas, ...ruins], politica: "nunca_envia_fim" });
      srv.iniciar(); await srv.aguardarBatches(1, 3000);
      await gw.aguardarQuiescencia({ estavelMs: 700, maxMs: 30_000 });
      await gw.espera(1500);
      await gw.drenarEnviados();
      const foto = () => ({
        upserts: gw.upserts.length, ids: gw.upserts.map((m) => m.key.id).sort(), bufferando: gw.bufferando(), tipos: gw.upsertsTipos.map((u) => `${u.tipo}:${u.n}`),
        frames: assinaturaFrames(gw.enviados), auth: { ...gw.medir(), total: undefined }, batches: srv.estado.batches.map((b) => b.count),
        falhas: gw.upserts.filter((m) => m.messageStubType).length,
      });
      const durante = foto();
      const parV = await gw.criarPar(D(501)); const viva = await gw.mensagemDireta(parV, "viva"); delete viva.attrs.offline;
      await gw.entregarSemFimOffline(viva); gw.emitirOfflineFim(56); await gw.espera(300); await gw.drenarEnviados();
      const depois = foto();
      return { durante, depois, snapshot: t.inbound?.snapshot(), stalled: t.porNome("inbound.offline_stalled_observed").length, overlap: t.porNome("inbound.offline_overlap").length, identidade: t.inbound?.estadoIdentidade(), estadoFila: t.inbound?.estadoFila() };
    } finally { await t.fim(); }
  }

  test("frames (receipts, retries, acks), decrypts, upserts, buffer, auth, batches e flushes IDÊNTICOS nas 4 configurações; só a telemetria muda", async () => {
    const nenhum = await rodar("nenhum"); const diag = await rodar("diag"); const antigo = await rodar("observe-sem-id"); const novo = await rodar("observe");
    for (const fase of ["durante", "depois"]) {
      for (const [nome, r] of [["diag", diag], ["observe sem identidade (C.9.6)", antigo], ["observe com identidade (C.9.7)", novo]]) assert.deepEqual(r[fase], nenhum[fase], `${fase}: ${nome} × nenhuma instrumentação`);
      assert.deepEqual(novo[fase], antigo[fase], `${fase}: C.9.7 × C.9.6`);
    }
    assert.equal(novo.durante.upserts, 0, "durante a retenção nada foi liberado"); assert.equal(novo.depois.upserts, 57);
    assert.deepEqual(novo.snapshot, antigo.snapshot, "contadores de decrypt/retry/stanza iguais com e sem a identidade");
    assert.deepEqual(novo.snapshot, diag.snapshot);
    assert.deepEqual(novo.estadoFila.mensagensRetidas, antigo.estadoFila.mensagensRetidas); assert.equal(novo.estadoFila.flushes, antigo.estadoFila.flushes); assert.equal(novo.estadoFila.flushesEfetivos, antigo.estadoFila.flushesEfetivos);
    assert.ok(novo.overlap >= 1, "só a C.9.7 emite a sobreposição"); assert.equal(antigo.overlap, 0); assert.equal(nenhum.overlap, 0);
    assert.equal(novo.identidade.atualCount, 56, "identidade registrou os 56 nós offline (50 boas + 6 ruins); a viva não"); assert.equal(antigo.identidade, undefined);
    assert.deepEqual([antigo.stalled >= 1, novo.stalled >= 1, novo.stalled === antigo.stalled], [true, true, true], "o watchdog se comporta igual com e sem identidade");
    assert.deepEqual([novo.durante.falhas, novo.depois.falhas], [0, 6]);
  });
});
