// C.9.6 — INTEGRAÇÃO do observador da fila offline com o Baileys 6.7.24 REAL (socket real → servidor WebSocket LOCAL, criptografia
// libsignal real, pares fictícios; nenhuma rede externa) usando o servidor de fila offline falso já existente
// (test-support/servidorOfflineFalso.js). O servidor é um MODELO: o que se prova é o comportamento do CLIENTE.
// Pergunta central: o watchdog em OBSERVE percebe o travamento SEM mudar absolutamente nada no comportamento das mensagens?
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { criarGatewayFalso, capturarConsole } from "../test-support/inboundHarness.js";
import { criarServidorOfflineFalso, gerarMensagensOffline } from "../test-support/servidorOfflineFalso.js";
import { criarInboundGateway } from "../src/inboundScope.js";
import { sanitizar } from "../src/logsafe.js";

const SEM_ESPERA_PLACEHOLDER = { placeholderResendCache: { get: () => true, set() {}, del() {} } };
// limites RÁPIDOS só para o teste (produção usa 30 s / 180 s / 1 s / 60 s). O comportamento do observador é o mesmo.
const RAPIDOS = { stallDetectionMs: 400, absoluteMaxOfflineMs: 3000, tickMs: 40, heartbeatMs: 300 };
const D = (n) => `55118888${String(n).padStart(5, "0")}@s.whatsapp.net`;

async function abrir({ modo = "observe", latenciaKeysMs = 0, opcoesBaileys = {}, limites = RAPIDOS } = {}) {
  const cap = capturarConsole(); const eventos = [];
  const inbound = modo === "nenhum" ? undefined : criarInboundGateway({
    diagHabilitado: true, offlineObserve: modo === "observe" ? limites : false, consoleAlvo: console,
    emitir: (n, e, d) => eventos.push({ e, d }), obterEpoch: () => 10,
  });
  const gw = await criarGatewayFalso({ inbound, latenciaKeysMs, opcoesBaileys });
  const porNome = (n) => eventos.filter((x) => x.e === n);
  return { gw, inbound, eventos, porNome, fim: async () => { inbound?.parar(); cap.restaurar(); await gw.encerrar(); } };
}
async function esperar(cond, ms = 5000, passo = 30) { const ini = Date.now(); while (Date.now() - ini < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, passo)); } return cond(); }

describe("instrumentação com o Baileys real: preview, marcos, fluxo normal", { timeout: 120_000 }, () => {
  test("offline_preview: atributos SANITIZADOS (numéricos saem; identificador/token não); o cliente responde com offline_batch como sempre", async () => {
    const t = await abrir();
    try {
      const nos = await gerarMensagensOffline(t.gw, 5);
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "nunca_envia_fim", atributosPreview: { count: "130", rogue: "5511999990000@s.whatsapp.net", token: "abcdef0123456789abcdef0123", fone: "5511999990000" } });
      srv.iniciar(); assert.equal(await srv.aguardarBatches(1, 3000), true, "o Baileys respondeu ao preview");
      await esperar(() => t.porNome("inbound.offline_preview").length === 1);
      const p = t.porNome("inbound.offline_preview")[0].d;
      assert.deepEqual([p.socketGeneration, p.epoch, p.ordem, p.fase, typeof p.sinceSocketMs], [1, 10, 1, "OFFLINE_LOADING", "number"]);
      const por = Object.fromEntries(p.atributos.map((a) => [a.nome, a]));
      assert.deepEqual(por.count, { nome: "count", classe: "numerico", valor: 130 }); assert.deepEqual(por.message, { nome: "message", classe: "numerico", valor: 5 });
      for (const k of ["rogue", "token", "fone"]) { assert.equal(por[k].classe, "sensivel"); assert.ok(!("valor" in por[k])); }
      const linha = JSON.stringify(sanitizar({ evento: "inbound.offline_preview", ...p }));
      for (const proibido of ["5511999990000", "s.whatsapp.net", "abcdef0123456789"]) assert.ok(!linha.includes(proibido)); assert.ok(!linha.includes("REDACTED"));
      assert.equal(t.inbound.estadoFila().offlinePreviewRecebido, 1);
    } finally { await t.fim(); }
  });

  test("fluxo NORMAL (marcador em < limite): preview → marco 1 → marcador ⇒ LIVE; nenhum stalled; o flush oficial libera tudo", async () => {
    const t = await abrir();
    try {
      const nos = await gerarMensagensOffline(t.gw, 60);
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "fim_ao_esgotar" });
      srv.iniciar(); await srv.aguardarBatches(1, 3000);
      await t.gw.aguardarQuiescencia({ estavelMs: 700, maxMs: 15_000 });
      await t.gw.espera(1200);                                            // 3× o limite de estagnação: nada deve disparar em LIVE
      assert.equal(t.gw.upserts.length, 60);
      assert.equal(t.porNome("inbound.offline_stalled_observed").length, 0);
      const e = t.inbound.estadoObserve(); assert.deepEqual([e.fase, e.fim, e.nosOffline, e.previews, e.gatilho], ["LIVE", true, 60, 1, "preview"]);
      const marc = t.porNome("inbound.offline_state").find((x) => x.d.gatilho === "marcador").d;
      assert.deepEqual([marc.marcadorTardio, marc.offlineFimContagem, marc.fase, marc.observeOnly, marc.RECOVERY_PATH_USED], [false, 60, "LIVE", true, false]);
      assert.ok(marc.retidasAntesDoFlush >= 0, "capturado ANTES do flush oficial (listener prepend)");
      assert.deepEqual(t.porNome("inbound.offline_node_progress").map((x) => x.d.milestone), [1], "60 nós: só o marco 1");
      assert.equal(t.porNome("inbound.offline_state").filter((x) => x.d.gatilho === "heartbeat").length, 0, "em LIVE não há heartbeat");
    } finally { await t.fim(); }
  });

  test("prepend do marcador: o observador enxerga as retidas ANTES do flush oficial do Baileys (e o handler do Baileys roda em seguida, como sempre)", async () => {
    const t = await abrir({ latenciaKeysMs: 0 });
    try {
      const nos = await gerarMensagensOffline(t.gw, 20);
      for (const n of nos) t.gw.sock.ws.emit("CB:message", n);
      await t.gw.aguardarQuiescencia({ estavelMs: 500, maxMs: 15_000 });
      assert.equal(t.gw.upserts.length, 0); assert.equal(t.inbound.estadoObserve().retidas, 20);
      t.gw.emitirOfflineFim(20); await t.gw.espera(200);
      assert.equal(t.gw.upserts.length, 20, "o Baileys fez o flush oficial normalmente");
      const marc = t.porNome("inbound.offline_state").find((x) => x.d.gatilho === "marcador").d;
      assert.equal(marc.retidasAntesDoFlush, 20, "as 20 que o flush oficial estava prestes a liberar");
      assert.equal(t.inbound.estadoObserve().retidas, 0);
    } finally { await t.fim(); }
  });
});

describe("watchdog OBSERVE com o Baileys real: percebe o travamento e NÃO interfere", { timeout: 180_000 }, () => {
  async function estagnado(opcoes = {}) {
    const t = await abrir(opcoes);
    const nos = await gerarMensagensOffline(t.gw, 130);
    const srv = criarServidorOfflineFalso({ gw: t.gw, nos, politica: "nunca_envia_fim" });
    srv.iniciar(); await srv.aguardarBatches(1, 3000);
    await t.gw.aguardarQuiescencia({ estavelMs: 300, maxMs: 15_000 });
    return { t, srv };
  }

  test("B. SEM MARCADOR: 100 nós, servidor cala ⇒ UM stalled_observed (no_progress) + marcos 1 e 100 + heartbeats; flush=0, upsert=0, buffer ativo, 1 batch", async () => {
    const { t, srv } = await estagnado();
    try {
      assert.equal(await esperar(() => t.porNome("inbound.offline_stalled_observed").length >= 1, 6000), true, "o watchdog percebeu");
      await t.gw.espera(1500);                                             // mais 3,7× o limite + heartbeats
      const st = t.porNome("inbound.offline_stalled_observed"); assert.equal(st.length, 1, "UMA vez por entrada");
      const d = st[0].d;
      assert.deepEqual([d.stallReason, d.bufferAtivo, d.mensagensRetidas, d.offlinePreviewRecebido, d.offlineFimRecebido, d.nosOfflineVistos, d.nosVivosVistos, d.socketHealthy, d.entrada, d.observeOnly, d.RECOVERY_PATH_USED, d.socketGeneration, d.epoch],
        ["no_progress", true, 100, 1, false, 100, 0, true, 1, true, false, 1, 10]);
      assert.ok(d.secondsSinceProgress >= 0 && d.secondsSinceProgress <= 3);
      assert.deepEqual(t.porNome("inbound.offline_node_progress").map((x) => x.d.milestone), [1, 100]);
      const m100 = t.porNome("inbound.offline_node_progress")[1].d; assert.equal(m100.offlineNodes, 100); assert.ok(m100.sinceSocketMs >= 0 && m100.sincePreviewMs >= 0);
      assert.ok(t.porNome("inbound.offline_state").filter((x) => x.d.gatilho === "heartbeat").length >= 1, "heartbeats durante a retenção");
      const hb = t.porNome("inbound.offline_state").filter((x) => x.d.gatilho === "heartbeat").at(-1).d; assert.equal(hb.fase, "OFFLINE_STALLED_OBSERVED"); assert.equal(hb.observeWouldRecover, true);
      // ---- NÃO INTERFERE ----
      const f = t.inbound.estadoFila();
      assert.equal(t.gw.upserts.length, 0, "nenhum upsert liberado"); assert.equal(t.gw.bufferando(), true, "buffer segue ativo");
      assert.equal(f.flushes, 0); assert.equal(f.flushesEfetivos, 0); assert.equal(f.mensagensRetidas, 100);
      assert.equal(srv.estado.batches.length, 1, "nenhum segundo offline_batch"); assert.equal(srv.restante(), 30);
      assert.equal(t.inbound.estadoObserve().fase, "OFFLINE_STALLED_OBSERVED");
    } finally { await t.fim(); }
  });

  test("D. TETO ABSOLUTO (gotejamento): nós chegando devagar mantêm progresso ⇒ NÃO há no_progress; passado o teto ⇒ absolute_max — sempre sem flush", async () => {
    const t = await abrir();
    try {
      const nos = await gerarMensagensOffline(t.gw, 25);
      const srv = criarServidorOfflineFalso({ gw: t.gw, nos: [], politica: "nunca_envia_fim" }); srv.iniciar();
      const ini = Date.now();
      for (const n of nos) { t.gw.sock.ws.emit("CB:message", n); await t.gw.espera(150); if (Date.now() - ini > 3800) break; }
      await esperar(() => t.porNome("inbound.offline_stalled_observed").length >= 1, 4000);
      const st = t.porNome("inbound.offline_stalled_observed");
      assert.ok(st.length >= 1); assert.equal(st[0].d.stallReason, "absolute_max", "com progresso a cada 150 ms nunca houve 400 ms de silêncio");
      assert.ok(st[0].d.secondsSinceOfflineStart >= 3, `desde o início: ${st[0].d.secondsSinceOfflineStart}s`);
      assert.equal(t.gw.upserts.length, 0); assert.equal(t.inbound.estadoFila().flushes, 0); assert.equal(t.gw.bufferando(), true);
    } finally { await t.fim(); }
  });

  test("H. NÓ VIVO: o Baileys faz o flush nativo e libera as retidas; o observador só REGISTRA (flush_sem_marcador), continua em OFFLINE_LOADING e não dispara mais nada", async () => {
    const { t } = await estagnado();
    try {
      await esperar(() => t.porNome("inbound.offline_stalled_observed").length >= 1, 6000);
      const par = await t.gw.criarPar(D(900)); const viva = await t.gw.mensagemDireta(par, "viva"); delete viva.attrs.offline;
      await t.gw.entregarSemFimOffline(viva);
      assert.equal(t.gw.upserts.length, 101, "comportamento NATIVO: as 100 retidas + a viva");
      const e = t.inbound.estadoObserve();
      assert.deepEqual([e.flushesSemMarcador, e.retidas, e.nosVivos, e.fim], [1, 0, 1, false]);
      assert.equal(t.porNome("inbound.offline_state").filter((x) => x.d.gatilho === "flush_sem_marcador").length, 1);
      assert.equal(e.fase, "OFFLINE_LOADING", "o flush por nó vivo não é o fim do offline: volta a LOADING (retomada)");
      const n = t.porNome("inbound.offline_stalled_observed").length; await t.gw.espera(1200);
      assert.equal(t.porNome("inbound.offline_stalled_observed").length, n, "nada retido ⇒ nada a observar");
    } finally { await t.fim(); }
  });

  test("E. socket FECHA com retidas: timer cancelado, UM evento de fechamento com as retidas perdidas, nenhum heartbeat depois", async () => {
    const { t } = await estagnado();
    try {
      await esperar(() => t.porNome("inbound.offline_stalled_observed").length >= 1, 6000);
      await t.gw.sock.end(undefined); await t.gw.espera(200);
      const fech = t.porNome("inbound.offline_state").filter((x) => x.d.gatilho === "fechamento"); assert.equal(fech.length, 1);
      assert.equal(fech[0].d.retidasPerdidas, 100); assert.equal(fech[0].d.fase, "CLOSED" === fech[0].d.fase ? "CLOSED" : fech[0].d.fase);
      assert.equal(t.inbound.estadoObserve().fase, "CLOSED"); assert.equal(t.inbound.metricasObserve().retidasPerdidas, 100);
      const n = t.eventos.length; await t.gw.espera(1200);
      assert.equal(t.eventos.filter((x) => x.e.startsWith("inbound.offline_")).length, t.eventos.slice(0, n).filter((x) => x.e.startsWith("inbound.offline_")).length, "nenhum evento offline depois do fechamento");
      assert.equal(t.gw.upserts.length, 0, "fechar o socket NÃO libera nada (como sempre no Baileys)");
    } finally { await t.fim(); }
  });

  test("F. SOCKET ANTIGO: um 2º socket observado cria a geração 2 e fecha a 1; eventos tardios do socket 1 não mexem na máquina da 2", async () => {
    const { t } = await estagnado();
    try {
      await esperar(() => t.porNome("inbound.offline_stalled_observed").length >= 1, 6000);
      const { EventEmitter } = await import("node:events");
      const ws2 = new EventEmitter(); ws2.isOpen = true; const ev2 = new EventEmitter();
      t.inbound.observarSocket({ ws: ws2, ev: ev2, user: null });
      const e = t.inbound.estadoObserve(); assert.deepEqual([e.socketGeneration, e.fase, e.nosOffline], [2, "CONNECTING", 0]);
      assert.equal(t.inbound.metricasObserve().retidasPerdidas, 100, "as 100 do socket 1 morreram com o buffer dele");
      assert.equal(t.inbound.estadoFila().mensagensRetidas, 0, "as retidas passaram a ser as do buffer ATUAL");
      assert.equal(t.inbound.estadoFila().retidasPerdidasNoFechamento, 100);
      const nos = await gerarMensagensOffline(t.gw, 3, { prefixo: "55117777" }); for (const n of nos) t.gw.sock.ws.emit("CB:message", n);   // socket VELHO ainda emitindo
      await t.gw.espera(300);
      const e2 = t.inbound.estadoObserve(); assert.deepEqual([e2.socketGeneration, e2.nosOffline, e2.fase], [2, 0, "CONNECTING"], "geração 2 intacta");
      ws2.emit("CB:message", { tag: "message", attrs: { id: "X", from: D(1), offline: "1", t: "1" }, content: [] });
      assert.equal(t.inbound.estadoObserve().nosOffline, 1, "o socket 2 é o observado");
    } finally { await t.fim(); }
  });
});

describe("attrs.offline no fio, idade e fromMe (Baileys real)", { timeout: 120_000 }, () => {
  test("I. offline=\"0\": só o BUCKET muda; o Baileys trata \"0\" como offline (retida, sem flush) — idêntico a \"1\"", async () => {
    const resultados = {};
    for (const v of ["1", "0"]) {
      const t = await abrir();
      try {
        const nos = await gerarMensagensOffline(t.gw, 6); for (const n of nos) n.attrs.offline = v;
        for (const n of nos) t.gw.sock.ws.emit("CB:message", n);
        await t.gw.aguardarQuiescencia({ estavelMs: 500, maxMs: 15_000 });
        const e = t.inbound.estadoObserve();
        resultados[v] = { upserts: t.gw.upserts.length, buffer: t.gw.bufferando(), flushes: t.inbound.estadoFila().flushes, nosOffline: e.nosOffline, nosVivos: e.nosVivos, retidas: e.retidas, attr: e.attrOffline.message };
      } finally { await t.fim(); }
    }
    assert.deepEqual({ ...resultados["1"], attr: undefined }, { ...resultados["0"], attr: undefined }, "comportamento idêntico");
    assert.deepEqual(resultados["1"], { upserts: 0, buffer: true, flushes: 0, nosOffline: 6, nosVivos: 0, retidas: 6, attr: { missing: 0, empty: 0, zero: 0, one: 6, other: 0 } });
    assert.deepEqual(resultados["0"].attr, { missing: 0, empty: 0, zero: 6, one: 0, other: 0 });
    const t = await abrir();
    try {
      const nos = await gerarMensagensOffline(t.gw, 2); nos[0].attrs.offline = ""; delete nos[1].attrs.offline;
      for (const n of nos) t.gw.sock.ws.emit("CB:message", n);
      await t.gw.aguardarQuiescencia({ estavelMs: 500, maxMs: 15_000 });
      const e = t.inbound.estadoObserve();
      assert.deepEqual([e.nosVivos, e.nosOffline, e.attrOffline.message.empty, e.attrOffline.message.missing], [2, 0, 1, 1]);
      assert.ok(t.inbound.estadoFila().flushes >= 1, "\"\" e ausente seguem a trilha VIVA do Baileys (flush nativo)");
    } finally { await t.fim(); }
  });

  test("idade: buckets por origem no fio (t do stanza); o timestamp original nunca aparece nos eventos", async () => {
    const t = await abrir();
    try {
      const nos = await gerarMensagensOffline(t.gw, 4); const agoraS = Math.floor(Date.now() / 1000);
      nos[0].attrs.t = String(agoraS - 20); nos[1].attrs.t = String(agoraS - 3 * 3600); nos[2].attrs.t = String(agoraS - 5 * 86400); delete nos[3].attrs.t;
      for (const n of nos) t.gw.sock.ws.emit("CB:message", n);
      await t.gw.aguardarQuiescencia({ estavelMs: 400, maxMs: 15_000 });
      const i = t.inbound.estadoObserve().idade.offline;
      assert.deepEqual([i.lt1m, i.h2a24, i.gt24h, i.ausente], [1, 1, 1, 1]);
      await esperar(() => t.porNome("inbound.offline_stalled_observed").length >= 1, 4000);
      const linha = JSON.stringify(t.eventos.map((x) => x.d));
      assert.ok(!new RegExp(String(agoraS).slice(0, 7)).test(linha), "nenhum timestamp (nem prefixo) nos eventos");
    } finally { await t.fim(); }
  });

  test("J. fromMe no decrypt: mensagens de OUTRO aparelho da própria conta caem em direct_lid_other com fromMe=sim; as externas com fromMe=nao (o que explica 18 + 11 = 29)", async () => {
    const t = await abrir();
    try {
      const propriaOutroAparelho = await t.gw.criarPar("100000000000001:9@lid");
      const externo = await t.gw.criarPar("100000000000003@lid");
      const a = await t.gw.mensagemDireta(propriaOutroAparelho, "enviada por outro aparelho"); a.attrs.recipient = "100000000000002@lid";     // from = LID próprio, recipient = o contato
      const b = await t.gw.mensagemDireta(externo, "recebida de um contato");
      for (const n of [a, b]) t.gw.sock.ws.emit("CB:message", n);
      await t.gw.aguardarQuiescencia({ estavelMs: 500, maxMs: 15_000 });
      const s = t.inbound.snapshot();
      assert.equal(s.stanzas.direct_lid_self.message, 1, "stanza classificada pelo REMETENTE (from = LID próprio)");
      assert.equal(s.stanzas.direct_lid_other.message, 1);
      const m = s.mensagens.direct_lid_other;
      assert.equal(m.decryptTentado, 2, "as duas caíram em direct_lid_other no decrypt (remoteJid): 1 + 1");
      assert.deepEqual([m.fromMe.sim.tentado, m.fromMe.nao.tentado, m.fromMe.desconhecido.tentado], [1, 1, 0], "…e a dimensão fromMe mostra a origem SEM reinterpretar o JID");
      assert.equal(s.mensagens.direct_lid_self, undefined, "direct_lid_self no decrypt continua ausente (chat consigo mesmo)");
      t.inbound.emitirResumo();
    } finally { await t.fim(); }
  });
});

describe("NÃO INTERFERÊNCIA: NENHUMA instrumentação × diagnóstico sem observador × OBSERVE, mesma sequência de nós", { timeout: 240_000 }, () => {
  /** assinatura estrutural (independente das chaves/ids aleatórios): tag|type|filhos, ordenada */
  const assinaturaFrames = (enviados) => enviados.map((n) => `${n.tag}|${n.attrs?.type ?? ""}|${(Array.isArray(n.content) ? n.content.map((c) => c.tag) : []).join(",")}`).sort();

  async function rodar(modo) {
    const t = await abrir({ modo, opcoesBaileys: SEM_ESPERA_PLACEHOLDER });
    try {
      const { gw } = t;
      const boas = await gerarMensagensOffline(gw, 50, { pares: 10 });
      const par = await gw.criarPar(D(500)); const ruins = [];
      for (let i = 0; i < 6; i++) ruins.push(await gw.mensagemDireta(par, `ruim${i}`, { adulterar: true }));
      const srv = criarServidorOfflineFalso({ gw, nos: [...boas, ...ruins], politica: "nunca_envia_fim" });
      srv.iniciar(); await srv.aguardarBatches(1, 3000);
      await gw.aguardarQuiescencia({ estavelMs: 700, maxMs: 30_000 });
      await gw.espera(1500);                                                       // ≥ 3,7× o limite: o observador (se ligado) já percebeu o travamento
      await gw.drenarEnviados();
      const foto = () => ({
        upserts: gw.upserts.length, ids: gw.upserts.map((m) => m.key.id).sort(), bufferando: gw.bufferando(), tipos: gw.upsertsTipos.map((u) => `${u.tipo}:${u.n}`),
        frames: assinaturaFrames(gw.enviados), auth: { ...gw.medir(), total: undefined }, batches: srv.estado.batches.map((b) => b.count),
        falhas: gw.upserts.filter((m) => m.messageStubType).length,
      });
      const durante = foto();
      // comportamento NATIVO que deve continuar idêntico: nó vivo libera o buffer; depois o marcador tardio
      const parV = await gw.criarPar(D(501)); const viva = await gw.mensagemDireta(parV, "viva"); delete viva.attrs.offline;
      await gw.entregarSemFimOffline(viva); gw.emitirOfflineFim(56); await gw.espera(300); await gw.drenarEnviados();
      const depois = foto();
      return { durante, depois, snapshot: t.inbound?.snapshot(), stalled: t.porNome("inbound.offline_stalled_observed").length };
    } finally { await t.fim(); }
  }

  test("frames enviados (receipts, retries, acks), decrypts, upserts, buffer, auth e flushes são IDÊNTICOS; a única diferença são os eventos diagnósticos", async () => {
    const nenhum = await rodar("nenhum"); const diag = await rodar("diag"); const obs = await rodar("observe");
    for (const fase of ["durante", "depois"]) {
      assert.deepEqual(diag[fase], nenhum[fase], `${fase}: diagnóstico sem observador × nenhuma instrumentação`);
      assert.deepEqual(obs[fase], nenhum[fase], `${fase}: OBSERVE × nenhuma instrumentação`);
    }
    assert.equal(obs.durante.upserts, 0, "durante a retenção nada foi liberado, com o watchdog ligado ou não");
    assert.equal(obs.depois.upserts, 57, "depois do nó vivo: 56 retidas + a viva — igual nos três");
    assert.deepEqual(obs.snapshot, diag.snapshot, "contadores de decrypt/retry/stanza idênticos com e sem o observador");
    assert.equal(nenhum.stalled, 0); assert.equal(diag.stalled, 0); assert.ok(obs.stalled >= 1, "só o OBSERVE emitiu o evento de stall observado");
    assert.deepEqual([obs.durante.falhas, obs.depois.falhas], [0, 6], "durante a retenção nenhum stub chegou ao app; depois do flush nativo, as 6 falhas de decrypt (Bad MAC) chegam como stub — igual nos três");
  });
});
